import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  Model,
  SystemMessage,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import * as Schema from "effect/Schema";

import { computeContextBudget, estimateAgentMessagesTokens } from "./contextBudget.ts";
import {
  COMPACTION_RETAINED_TAIL_SHAPE,
  pruneOrphanToolResults,
  replayRetainedTail,
  selectRecentTail,
  truncateMessageToTail,
} from "./compactionTail.ts";
import { foldForCheckpoint } from "./systemTranscript.ts";

/**
 * How a checkpoint treats the range it folds away: keep the in-flight turn,
 * summarize and keep the pinned recent turns, or start over without a summary.
 */
export type CompactionMode = "active_turn" | "completed_turn" | "fresh_window";

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
  /** Reference to the last message the checkpoint folded behind its boundary. */
  readonly throughMessageId: string | null;
  /** Marked when `retainedMessages` is the real recent window, not pinned turns. */
  readonly retainedTailShape: typeof COMPACTION_RETAINED_TAIL_SHAPE | null;
  /** Why summarization was abandoned, when it was. */
  readonly failureReason: string | null;
  readonly beforeTokens: number;
  readonly afterTokens: number;
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
/** A fresh window keeps only the active goal, so it can never fail to fit. */
const FRESH_WINDOW_TAIL_MAX_TOKENS = 8_000;
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
 * Deterministic replacement for a summary: keep the newest replayable run that
 * fits, so a failed summarizer still leaves a replayable transcript.
 */
export function buildRetainedTailFallback(input: RetainedTailFallbackInput): RetainedTailFallback {
  const folded = foldForCheckpoint(input.messages, input.timestamp);
  return {
    leadingSystem: folded.leadingSystem,
    retainedMessages: selectRecentTail(
      sanitizeRetainedMessages(folded.nonSystemMessages),
      input.budgetTokens,
    ),
  };
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
  const keepTurns =
    mode === "active_turn" ? 1 : mode === "fresh_window" ? 0 : Math.max(0, pinnedRecentTurns);
  if (keepTurns === 0) return { toSummarize: flattenTurns(turns), retainedMessages: [] };
  const retainedTurns = turns.slice(Math.max(0, turns.length - keepTurns));
  return {
    toSummarize: flattenTurns(turns.slice(0, Math.max(0, turns.length - keepTurns))),
    retainedMessages: flattenTurns(retainedTurns),
  };
}

/**
 * A fresh window starts over without a summary, so the only thing worth keeping
 * is the active goal: the newest user message, truncated rather than dropped.
 */
function freshWindowTail(
  nonSystemMessages: readonly AgentMessage[],
  hardLimit: number,
): AgentMessage[] {
  const latestUser = nonSystemMessages.filter((message) => message.role === "user").at(-1);
  if (latestUser === undefined) return [];
  return [
    truncateMessageToTail(
      latestUser,
      Math.max(1, Math.min(FRESH_WINDOW_TAIL_MAX_TOKENS, Math.floor(hardLimit * 0.1))),
    ),
  ];
}

/**
 * Reference to the last message a checkpoint folded behind its boundary. Messages
 * carry no id of their own, so the position, role, and timestamp identify it.
 */
function messageRef(messages: readonly AgentMessage[], index: number): string | null {
  const message = messages[index];
  return message === undefined ? null : `message-${index}-${message.role}-${message.timestamp}`;
}

function failureReasonOf(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  return "The compaction summarizer failed.";
}

export async function buildCompactionCheckpoint(
  input: BuildCompactionCheckpointInput,
): Promise<CompactionCheckpoint> {
  const budget = computeContextBudget(input.model);
  const folded = foldForCheckpoint(input.messages, input.timestamp);
  const fresh = input.mode === "fresh_window";
  const range = selectRange(folded.nonSystemMessages, input.mode, input.pinnedRecentTurns ?? 0);
  const toSummarize = fresh ? [] : range.toSummarize;
  let retained = fresh
    ? freshWindowTail(folded.nonSystemMessages, budget.hardLimit)
    : range.retainedMessages;
  const maxChunkTokens =
    input.maxChunkTokens ??
    Math.max(MIN_CHUNK_TOKENS, Math.min(MAX_CHUNK_TOKENS, Math.floor(budget.hardLimit * 0.5)));
  const chunks = fresh ? [] : chunkMessages(toSummarize, maxChunkTokens);

  let sections: CompactionSummarySections | null = null;
  let failureReason: string | null = null;
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
    } catch (cause) {
      sections = null;
      failureReason = failureReasonOf(cause);
    }
  } else if (!fresh && chunks.length > 0) {
    failureReason = "No compaction summarizer is configured.";
  }

  const usedFallback = !fresh && sections === null;
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
  if (fallback !== null) retained = fallback.retainedMessages;
  const leadingSystem = folded.leadingSystem;
  const retainedTailShape = fallback === null ? null : COMPACTION_RETAINED_TAIL_SHAPE;
  let summarizedMessageCount = toSummarize.length;
  let assembled = assembleMessages(leadingSystem, summary, retained);

  for (;;) {
    if (estimateAgentMessagesTokens(assembled) < budget.hardLimit) break;
    const trimmedRetained = dropOldestTurn(retained);
    if (trimmedRetained.length !== retained.length) {
      summarizedMessageCount += retained.length - trimmedRetained.length;
      retained = trimmedRetained;
      assembled = assembleMessages(leadingSystem, summary, retained);
      continue;
    }
    const trimmedSummary = trimSummary(summary);
    if (trimmedSummary !== summary) {
      summary = trimmedSummary;
      assembled = assembleMessages(leadingSystem, summary, retained);
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
    throughMessageId:
      toSummarize.length === 0
        ? null
        : messageRef(folded.nonSystemMessages, toSummarize.length - 1),
    retainedTailShape,
    failureReason,
    beforeTokens: estimateAgentMessagesTokens(input.messages),
    afterTokens: estimateAgentMessagesTokens(assembled),
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
  // A recent-window tail is replayed verbatim, so it crosses the same structural
  // guard a restored checkpoint does instead of being trusted by shape alone.
  const retained =
    checkpoint.retainedTailShape === COMPACTION_RETAINED_TAIL_SHAPE
      ? (replayRetainedTail(checkpoint.retainedMessages) ?? checkpoint.retainedMessages)
      : checkpoint.retainedMessages;
  return assembleMessages(
    mergeLeadingSystem(checkpoint.leadingSystem, folded.leadingSystem),
    checkpoint.summary,
    retained,
  );
}

/** The code a delegate's terminal context failure carries to its caller. */
export const SUBAGENT_CONTEXT_OVERFLOW = "SUBAGENT_CONTEXT_OVERFLOW";

/**
 * The failure a parent model can act on: not the provider's raw overflow
 * sentence, but the three changes that would actually let a retry succeed.
 */
function subagentContextOverflow(modelId: string): {
  readonly code: typeof SUBAGENT_CONTEXT_OVERFLOW;
  readonly message: string;
} {
  return {
    code: SUBAGENT_CONTEXT_OVERFLOW,
    message:
      `The delegated task does not fit in the context window of model "${modelId}", even after compaction and history reduction. ` +
      "Narrow the task, delegate to a model with a larger context window, or make the delegate read less at once.",
  };
}

/**
 * A delegate's own budget: the same formula the session uses, evaluated against
 * the model it actually resolved, so it never gets a looser boundary than its
 * parent would compute for that model.
 */
export interface CompactSubagentMessagesInput {
  readonly messages: readonly AgentMessage[];
  readonly model: Pick<Model<Api>, "contextWindow" | "maxTokens" | "id">;
  readonly taskBrief: string;
  /** Pending tool results mean the turn being continued is still active. */
  readonly mode: "active_turn" | "completed_turn";
  readonly timestamp: number;
}

export interface CompactedSubagentContext {
  readonly messages: AgentMessage[];
  readonly status: "unchanged" | "compacted" | "degraded";
  readonly beforeTokens: number;
  readonly afterTokens: number;
}

export type SubagentContextUpdate =
  | CompactedSubagentContext
  | {
      readonly status: "overflow";
      readonly code: typeof SUBAGENT_CONTEXT_OVERFLOW;
      readonly message: string;
      readonly beforeTokens: number;
    };

/** Retained-tail target for a delegate, bounded so a small window still fits a summary. */
const SUBAGENT_KEEP_RECENT_RATIO = 0.2;
const SUBAGENT_MIN_KEEP_RECENT_TOKENS = 8_000;
const SUBAGENT_MAX_KEEP_RECENT_TOKENS = 64_000;
const SUBAGENT_BRIEF_MAX_TOKENS = 20_000;

function subagentKeepRecentTokens(hardLimit: number): number {
  return Math.min(
    Math.max(
      SUBAGENT_MIN_KEEP_RECENT_TOKENS,
      Math.min(SUBAGENT_MAX_KEEP_RECENT_TOKENS, Math.floor(hardLimit * SUBAGENT_KEEP_RECENT_RATIO)),
    ),
    Math.max(1, Math.floor(hardLimit * 0.5)),
  );
}

function subagentBrief(taskBrief: string, hardLimit: number, timestamp: number): UserMessage {
  return truncateMessageToTail(
    { role: "user", content: taskBrief, timestamp },
    Math.max(1, Math.min(SUBAGENT_BRIEF_MAX_TOKENS, Math.floor(hardLimit * 0.5))),
  ) as UserMessage;
}

/**
 * Decide the context for a delegate's next request: unchanged below the auto
 * trigger, the retained recent window when it fits, then the brief plus the newest
 * messages, and only then the terminal overflow its caller turns into
 * `SUBAGENT_CONTEXT_OVERFLOW`.
 */
export function compactSubagentMessages(
  input: CompactSubagentMessagesInput,
): SubagentContextUpdate {
  const budget = computeContextBudget(input.model);
  const beforeTokens = estimateAgentMessagesTokens(input.messages);
  const unchanged: CompactedSubagentContext = {
    messages: [...input.messages],
    status: "unchanged",
    beforeTokens,
    afterTokens: beforeTokens,
  };
  if (beforeTokens < budget.autoCompactThreshold) return unchanged;

  const folded = foldForCheckpoint(input.messages, input.timestamp);
  const leading = folded.leadingSystem === undefined ? [] : [folded.leadingSystem];
  const recent = selectRecentTail(
    folded.nonSystemMessages,
    subagentKeepRecentTokens(budget.hardLimit),
    { latestUserGoal: input.mode === "active_turn" },
  );
  const brief = subagentBrief(input.taskBrief, budget.hardLimit, input.timestamp);
  const compacted = [
    ...leading,
    ...(recent.some((message) => message.role === "user") ? [] : [brief]),
    ...recent,
  ];
  const compactedTokens = estimateAgentMessagesTokens(compacted);
  if (compactedTokens < budget.hardLimit) {
    return {
      messages: compacted,
      status: "compacted",
      beforeTokens,
      afterTokens: compactedTokens,
    };
  }

  // Degradation: the brief plus the newest messages that still fit. Sizing uses
  // the per-message estimate rather than a kept usage block, which describes the
  // pre-degradation context and would condemn every rebuilt context as oversized.
  const degraded: AgentMessage[] = [...leading, brief];
  let degradedTokens = estimateAgentMessagesTokens(degraded);
  if (degradedTokens >= budget.hardLimit) {
    return { status: "overflow", beforeTokens, ...subagentContextOverflow(input.model.id) };
  }
  const kept: AgentMessage[] = [];
  for (let index = folded.nonSystemMessages.length - 1; index >= 0; index -= 1) {
    const message = folded.nonSystemMessages[index] as AgentMessage;
    const cost = estimateAgentMessagesTokens([message]);
    if (degradedTokens + cost >= budget.hardLimit) break;
    kept.unshift(message);
    degradedTokens += cost;
  }
  // A budget cut keeps a newest-first run, so it can only open on a result side;
  // dropping that prefix leaves no result whose call was too old to keep.
  while (kept[0]?.role === "toolResult") kept.shift();
  const messages = [...degraded, ...pruneOrphanToolResults(kept)];
  const afterTokens = estimateAgentMessagesTokens(messages);
  if (afterTokens >= budget.hardLimit) {
    return { status: "overflow", beforeTokens, ...subagentContextOverflow(input.model.id) };
  }
  return { messages, status: "degraded", beforeTokens, afterTokens };
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
