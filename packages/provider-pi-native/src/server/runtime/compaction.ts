import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  Model,
  SystemMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import * as Schema from "effect/Schema";

import { computeContextBudget, estimateAgentMessagesTokens } from "./contextBudget.ts";
import { foldForCheckpoint } from "./systemTranscript.ts";

export type CompactionMode = "active_turn" | "completed_turn";

export interface CompactionSummarySections {
  readonly goals: string;
  readonly progress: string;
  readonly files: string;
  readonly decisions: string;
  readonly nextSteps: string;
}

export interface CompactionSummarizeRequest {
  readonly messages: readonly AgentMessage[];
  /** 1-based index of this chunk. */
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly timestamp: number;
}

export type CompactionSummaryResult = CompactionSummarySections | string;

export type CompactionSummarizeFn = (
  request: CompactionSummarizeRequest,
) => CompactionSummaryResult | Promise<CompactionSummaryResult>;

export interface CompactionCheckpoint {
  readonly mode: CompactionMode;
  readonly leadingSystem: SystemMessage | undefined;
  /** Rendered `<compaction_summary>` block; empty when nothing had to be summarized. */
  readonly summary: string;
  readonly retainedMessages: AgentMessage[];
  readonly summarizedMessageCount: number;
  readonly chunkCount: number;
  readonly usedFallback: boolean;
  readonly timestamp: number;
}

export interface BuildCompactionCheckpointInput {
  readonly messages: readonly AgentMessage[];
  readonly mode: CompactionMode;
  readonly model: Pick<Model<Api>, "contextWindow" | "maxTokens">;
  readonly timestamp: number;
  readonly summarizeFn?: CompactionSummarizeFn | undefined;
  /** Newest complete turns kept verbatim; ignored for `active_turn`. */
  readonly pinnedRecentTurns?: number | undefined;
  readonly maxChunkTokens?: number | undefined;
  /** Fraction of the hard limit the retained tail may use when no summary is available. */
  readonly fallbackBudgetRatio?: number | undefined;
}

export class CompactionBudgetError extends Schema.TaggedError<
  CompactionBudgetError,
  { readonly brand: unique symbol }
>()("CompactionBudgetError", { detail: Schema.String }) {
  override get message() {
    return `This conversation cannot be compacted below the model context limit: ${this.detail}`;
  }
}

const FALLBACK_BUDGET_RATIO = 0.6;
const MIN_CHUNK_TOKENS = 4_096;
const MAX_CHUNK_TOKENS = 32_768;
const MIN_SUMMARY_LENGTH = 32;

/** Turns start at each user message; tool results stay grouped with their assistant. */
function splitTurns(messages: readonly AgentMessage[]): AgentMessage[][] {
  const turns: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

function flattenTurns(turns: readonly AgentMessage[][]): AgentMessage[] {
  return turns.flatMap((turn) => turn);
}

function toolCallIds(message: AssistantMessage): readonly string[] {
  const ids: string[] = [];
  for (const block of message.content) {
    if (block.type === "toolCall") ids.push(block.id);
  }
  return ids;
}

function toolResultId(message: ToolResultMessage): string {
  return message.toolCallId;
}

/** One unit never separates an assistant tool call from the results it produced. */
function splitUnits(messages: readonly AgentMessage[]): AgentMessage[][] {
  const units: AgentMessage[][] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message === undefined) break;
    if (message.role !== "assistant") {
      units.push([message]);
      index += 1;
      continue;
    }
    const unit: AgentMessage[] = [message];
    index += 1;
    while (index < messages.length) {
      const next = messages[index];
      if (next === undefined || next.role !== "toolResult") break;
      unit.push(next);
      index += 1;
    }
    units.push(unit);
  }
  return units;
}

function chunkMessages(
  messages: readonly AgentMessage[],
  maxChunkTokens: number,
): AgentMessage[][] {
  const units = splitUnits(messages);
  const chunks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  let currentTokens = 0;
  for (const unit of units) {
    const unitTokens = estimateAgentMessagesTokens(unit);
    if (current.length > 0 && currentTokens + unitTokens > maxChunkTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(...unit);
    currentTokens += unitTokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function emptySummary(): CompactionSummarySections {
  return { goals: "", progress: "", files: "", decisions: "", nextSteps: "" };
}

function normalizeSummary(result: CompactionSummaryResult): CompactionSummarySections {
  if (typeof result === "string") return { ...emptySummary(), progress: result };
  return result;
}

function mergeSummaries(
  summaries: readonly CompactionSummarySections[],
): CompactionSummarySections {
  const merge = (pick: (summary: CompactionSummarySections) => string) =>
    summaries
      .map(pick)
      .map((value) => value.trim())
      .filter((value) => value !== "")
      .join("\n");
  return {
    goals: merge((summary) => summary.goals),
    progress: merge((summary) => summary.progress),
    files: merge((summary) => summary.files),
    decisions: merge((summary) => summary.decisions),
    nextSteps: merge((summary) => summary.nextSteps),
  };
}

export function renderCompactionSummary(sections: CompactionSummarySections): string {
  const lines = ["<compaction_summary>"];
  const append = (heading: string, body: string) => {
    const trimmed = body.trim();
    lines.push(`## ${heading}`);
    lines.push(trimmed === "" ? "(none recorded)" : trimmed);
  };
  append("Goals", sections.goals);
  append("Progress", sections.progress);
  append("Files", sections.files);
  append("Decisions", sections.decisions);
  append("Next Steps", sections.nextSteps);
  lines.push("</compaction_summary>");
  return lines.join("\n");
}

function stripThinkingSignatures(message: AssistantMessage): AssistantMessage {
  let changed = false;
  const content = message.content.map((block) => {
    if (block.type !== "thinking" || block.thinkingSignature === undefined) return block;
    changed = true;
    const { thinkingSignature: _signature, ...rest } = block;
    return rest;
  });
  return changed ? { ...message, content } : message;
}

/** Keeps only the messages a fresh provider can replay without dangling tool references. */
export function sanitizeRetainedMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  const survivingAssistant = new Set<AssistantMessage>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;
    survivingAssistant.add(message);
  }
  const resultIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "toolResult") resultIds.add(toolResultId(message));
  }
  const completeAssistant = new Set<AssistantMessage>();
  for (const message of survivingAssistant) {
    if (toolCallIds(message).every((id) => resultIds.has(id))) completeAssistant.add(message);
  }
  const retainedCallIds = new Set<string>();
  for (const message of completeAssistant) {
    for (const id of toolCallIds(message)) retainedCallIds.add(id);
  }
  const retained: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      if (completeAssistant.has(message)) retained.push(stripThinkingSignatures(message));
      continue;
    }
    if (message.role === "toolResult") {
      if (retainedCallIds.has(toolResultId(message))) retained.push(message);
      continue;
    }
    retained.push(message);
  }
  return retained;
}

export interface RetainedTailFallbackInput {
  readonly messages: readonly AgentMessage[];
  readonly budgetTokens: number;
  readonly timestamp: number;
}

export interface RetainedTailFallback {
  readonly leadingSystem: SystemMessage | undefined;
  readonly retainedMessages: AgentMessage[];
}

/**
 * Deterministic replacement for a summary: keep the newest complete turns that fit, so a
 * failed summarizer still leaves a replayable transcript.
 */
export function buildRetainedTailFallback(input: RetainedTailFallbackInput): RetainedTailFallback {
  const folded = foldForCheckpoint(input.messages, input.timestamp);
  const turns = splitTurns(folded.nonSystemMessages);
  const kept: AgentMessage[][] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn === undefined) continue;
    const sanitized = sanitizeRetainedMessages(turn);
    if (sanitized.length === 0) continue;
    const turnTokens = estimateAgentMessagesTokens(sanitized);
    if (kept.length > 0 && used + turnTokens > input.budgetTokens) break;
    kept.unshift(sanitized);
    used += turnTokens;
  }
  return { leadingSystem: folded.leadingSystem, retainedMessages: flattenTurns(kept) };
}

function systemContentText(message: SystemMessage | undefined): string {
  return message === undefined ? "" : contentText(message.content);
}

function assembleMessages(
  leadingSystem: SystemMessage | undefined,
  summary: string,
  retainedMessages: readonly AgentMessage[],
): AgentMessage[] {
  if (summary === "") {
    return [...(leadingSystem === undefined ? [] : [leadingSystem]), ...retainedMessages];
  }
  const base = systemContentText(leadingSystem);
  const content = base === "" ? summary : `${base}\n\n${summary}`;
  const system: SystemMessage = {
    role: "system",
    content,
    ...(leadingSystem?.sections === undefined ? {} : { sections: leadingSystem.sections }),
    timestamp: leadingSystem?.timestamp ?? 0,
  };
  return [system, ...retainedMessages];
}

function trimSummary(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length <= MIN_SUMMARY_LENGTH) return "";
  const cut = Math.max(MIN_SUMMARY_LENGTH, Math.floor(trimmed.length * 0.5));
  const marker = "\n\n…[compaction summary truncated]";
  const body = trimmed.slice(0, Math.max(0, cut - marker.length)).trimEnd();
  return `${body}${marker}`;
}

function dropOldestTurn(messages: readonly AgentMessage[]): AgentMessage[] {
  const turns = splitTurns(messages);
  if (turns.length <= 1) return [];
  return flattenTurns(turns.slice(1));
}

function selectRange(
  nonSystemMessages: readonly AgentMessage[],
  mode: CompactionMode,
  pinnedRecentTurns: number,
): { toSummarize: AgentMessage[]; retainedMessages: AgentMessage[] } {
  const turns = splitTurns(nonSystemMessages);
  const keepTurns = mode === "active_turn" ? 1 : Math.max(0, pinnedRecentTurns);
  if (keepTurns === 0) return { toSummarize: flattenTurns(turns), retainedMessages: [] };
  const retainedTurns = turns.slice(Math.max(0, turns.length - keepTurns));
  return {
    toSummarize: flattenTurns(turns.slice(0, Math.max(0, turns.length - keepTurns))),
    retainedMessages: flattenTurns(retainedTurns),
  };
}

export async function buildCompactionCheckpoint(
  input: BuildCompactionCheckpointInput,
): Promise<CompactionCheckpoint> {
  const budget = computeContextBudget(input.model);
  const folded = foldForCheckpoint(input.messages, input.timestamp);
  const { toSummarize, retainedMessages } = selectRange(
    folded.nonSystemMessages,
    input.mode,
    input.pinnedRecentTurns ?? 0,
  );
  const maxChunkTokens =
    input.maxChunkTokens ??
    Math.max(MIN_CHUNK_TOKENS, Math.min(MAX_CHUNK_TOKENS, Math.floor(budget.hardLimit * 0.5)));
  const chunks = chunkMessages(toSummarize, maxChunkTokens);

  let sections: CompactionSummarySections | null = null;
  if (input.summarizeFn !== undefined && chunks.length > 0) {
    try {
      const summaries: CompactionSummarySections[] = [];
      for (const [index, chunk] of chunks.entries()) {
        const result = await input.summarizeFn({
          messages: chunk,
          chunkIndex: index + 1,
          chunkCount: chunks.length,
          timestamp: input.timestamp,
        });
        summaries.push(normalizeSummary(result));
      }
      sections = mergeSummaries(summaries);
    } catch {
      sections = null;
    }
  }

  const usedFallback = sections === null;
  const fallback = usedFallback
    ? buildRetainedTailFallback({
        messages: folded.nonSystemMessages,
        budgetTokens: Math.floor(
          budget.hardLimit * (input.fallbackBudgetRatio ?? FALLBACK_BUDGET_RATIO),
        ),
        timestamp: input.timestamp,
      })
    : null;

  let summary = sections === null ? "" : renderCompactionSummary(sections);
  let retained = fallback === null ? retainedMessages : fallback.retainedMessages;
  const leadingSystem = folded.leadingSystem;
  let summarizedMessageCount = toSummarize.length;

  for (;;) {
    const assembled = assembleMessages(leadingSystem, summary, retained);
    if (estimateAgentMessagesTokens(assembled) < budget.hardLimit) break;
    const trimmedRetained = dropOldestTurn(retained);
    if (trimmedRetained.length !== retained.length) {
      summarizedMessageCount += retained.length - trimmedRetained.length;
      retained = trimmedRetained;
      continue;
    }
    const trimmedSummary = trimSummary(summary);
    if (trimmedSummary !== summary) {
      summary = trimmedSummary;
      continue;
    }
    throw new CompactionBudgetError({
      detail: `the retained turn alone needs ${estimateAgentMessagesTokens(
        assembleMessages(leadingSystem, "", retained),
      )} tokens, above the ${budget.hardLimit} token hard limit.`,
    });
  }

  return {
    mode: input.mode,
    leadingSystem,
    summary,
    retainedMessages: retained,
    summarizedMessageCount,
    chunkCount: chunks.length,
    usedFallback,
    timestamp: input.timestamp,
  };
}

/**
 * Rebuilds the transcript for a provider request: folded system prompt, summary, and the
 * retained tail. System deltas that arrived since the checkpoint are folded in too.
 */
export function installCompactionCheckpoint(
  messages: readonly AgentMessage[],
  checkpoint: CompactionCheckpoint,
): AgentMessage[] {
  const folded = foldForCheckpoint(messages, checkpoint.timestamp);
  return assembleMessages(
    mergeLeadingSystem(checkpoint.leadingSystem, folded.leadingSystem),
    checkpoint.summary,
    checkpoint.retainedMessages,
  );
}

/** The checkpoint owns the prompt text; system deltas that arrived since only patch sections. */
function mergeLeadingSystem(
  checkpointSystem: SystemMessage | undefined,
  foldedSystem: SystemMessage | undefined,
): SystemMessage | undefined {
  if (checkpointSystem === undefined) return foldedSystem;
  if (foldedSystem === undefined) return checkpointSystem;
  const sections = { ...checkpointSystem.sections, ...foldedSystem.sections };
  return {
    role: "system",
    content:
      contentText(checkpointSystem.content) === ""
        ? foldedSystem.content
        : checkpointSystem.content,
    ...(Object.keys(sections).length === 0 ? {} : { sections }),
    timestamp: checkpointSystem.timestamp || foldedSystem.timestamp,
  };
}
