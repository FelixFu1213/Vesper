import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Model,
  SystemMessage,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";

import type { ContextCalibration, ContextEstimateCalibration } from "./contextCalibration.ts";

/** Flat cost of one image block; providers bill an image as a fixed tile budget. */
const IMAGE_TOKEN_ESTIMATE = 1_600;
const CJK_TOKENS_PER_CHARACTER = 1.5;
const LATIN_CHARACTERS_PER_TOKEN = 4;

const CJK_CHARACTER =
  /[\u2e80-\u2eff\u2f00-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3130-\u318f\u31a0-\u31bf\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u{20000}-\u{3ffff}]/u;

export interface ContextBudget {
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reserveTokens: number;
  readonly hardLimit: number;
  readonly autoCompactThreshold: number;
  readonly warningThreshold: number;
}

export function computeContextBudget(
  model: Pick<Model<Api>, "contextWindow" | "maxTokens">,
): ContextBudget {
  const contextWindow = Math.max(1, model.contextWindow);
  const maxTokens = Math.max(0, model.maxTokens);
  const reserveTokens = Math.max(
    Math.min(16_384, Math.floor(contextWindow / 2)),
    Math.min(maxTokens, Math.floor(contextWindow * 0.25)),
    Math.floor(contextWindow * 0.05),
  );
  const hardLimit = Math.max(1_024, contextWindow - reserveTokens);
  return {
    contextWindow,
    maxTokens,
    reserveTokens,
    hardLimit,
    autoCompactThreshold: Math.floor(hardLimit * 0.9),
    warningThreshold: Math.floor(hardLimit * 0.75),
  };
}

/** CJK, Kana, and Hangul characters tokenize far denser than Latin text. */
export function estimateCjkAwareTextTokens(text: string): number {
  if (text === "") return 0;
  let cjkCharacters = 0;
  let otherCharacters = 0;
  for (const character of text) {
    if (CJK_CHARACTER.test(character)) {
      cjkCharacters += 1;
    } else {
      otherCharacters += 1;
    }
  }
  return (
    Math.ceil(cjkCharacters * CJK_TOKENS_PER_CHARACTER) +
    Math.ceil(otherCharacters / LATIN_CHARACTERS_PER_TOKEN)
  );
}

function estimateTextContent(
  content: string | readonly (TextContent | { type: "image" })[],
): number {
  if (typeof content === "string") return estimateCjkAwareTextTokens(content);
  let tokens = 0;
  for (const block of content) {
    tokens += block.type === "text" ? estimateCjkAwareTextTokens(block.text) : IMAGE_TOKEN_ESTIMATE;
  }
  return tokens;
}

function estimateToolCallTokens(toolCall: ToolCall): number {
  return (
    estimateCjkAwareTextTokens(toolCall.name) +
    estimateCjkAwareTextTokens(safeJson(toolCall.arguments))
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function estimateSystemMessageTokens(message: SystemMessage): number {
  let tokens = estimateTextContent(message.content);
  if (message.sections !== undefined) {
    for (const [name, text] of Object.entries(message.sections)) {
      tokens += estimateCjkAwareTextTokens(name);
      if (text !== null) tokens += estimateCjkAwareTextTokens(text);
    }
  }
  if (message.toolsAdded !== undefined) {
    for (const tool of message.toolsAdded) {
      tokens +=
        estimateCjkAwareTextTokens(tool.name) +
        estimateCjkAwareTextTokens(tool.description) +
        estimateCjkAwareTextTokens(safeJson(tool.parameters));
    }
  }
  return tokens;
}

function estimateUserMessageTokens(message: UserMessage): number {
  return estimateTextContent(message.content);
}

function estimateAssistantMessageTokens(message: AssistantMessage): number {
  let tokens = 0;
  for (const block of message.content) {
    switch (block.type) {
      case "text":
        tokens += estimateCjkAwareTextTokens(block.text);
        break;
      case "thinking":
        tokens += estimateCjkAwareTextTokens(block.thinking);
        break;
      case "toolCall":
        tokens += estimateToolCallTokens(block);
        break;
    }
  }
  return tokens;
}

function estimateToolResultMessageTokens(message: ToolResultMessage): number {
  let tokens = estimateCjkAwareTextTokens(message.toolName);
  for (const block of message.content) {
    tokens += block.type === "text" ? estimateCjkAwareTextTokens(block.text) : IMAGE_TOKEN_ESTIMATE;
  }
  return tokens;
}

export function estimateAgentMessageTokens(message: AgentMessage): number {
  switch (message.role) {
    case "system":
      return estimateSystemMessageTokens(message);
    case "user":
      return estimateUserMessageTokens(message);
    case "assistant":
      return estimateAssistantMessageTokens(message);
    case "toolResult":
      return estimateToolResultMessageTokens(message);
    default:
      return 0;
  }
}

export function estimateAgentMessagesTokens(messages: readonly AgentMessage[]): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += estimateAgentMessageTokens(message);
  }
  return tokens;
}

/** The callable shape of one tool schema, as the request advertises it. */
export interface ContextRequestTool {
  readonly name: string;
  readonly description?: string | undefined;
  readonly parameters?: unknown;
}

/**
 * What one provider request pays for, split so a caller can see which part grew.
 * `totalTokens` is the larger of the structured bucket sum and the plain
 * transcript estimate: tools advertised through `toolsAdded` must not be charged
 * twice, and tools advertised only through the request must not be missed.
 */
export interface ContextRequestCost {
  readonly systemTokens: number;
  readonly toolTokens: number;
  readonly messageTokens: number;
  readonly totalTokens: number;
}

export interface ContextProjection {
  readonly cost: ContextRequestCost;
  /** The raw projection in the shape the calibration corrects. */
  readonly calibration: ContextCalibration;
}

function estimateToolSchemaTokens(tool: ContextRequestTool): number {
  return (
    estimateCjkAwareTextTokens(tool.name) +
    (tool.description === undefined ? 0 : estimateCjkAwareTextTokens(tool.description)) +
    (tool.parameters === undefined ? 0 : estimateCjkAwareTextTokens(safeJson(tool.parameters)))
  );
}

/** Real prompt tokens the most recent usable assistant usage block reports. */
function usageTokensOf(message: AssistantMessage): number {
  const usage = message.usage;
  if (usage.totalTokens > 0) return usage.totalTokens;
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Index of the newest assistant message whose usage describes the current prefix. */
function lastUsageIndex(messages: readonly AgentMessage[]): number | null {
  let newestPrefixTimestamp = Number.NEGATIVE_INFINITY;
  let index: number | null = null;
  for (const [position, message] of messages.entries()) {
    if (message.role === "assistant") {
      const usable =
        message.timestamp >= newestPrefixTimestamp &&
        message.stopReason !== "error" &&
        message.stopReason !== "aborted" &&
        message.stopReason !== "deferred" &&
        usageTokensOf(message) > 0;
      if (usable) index = position;
    }
    newestPrefixTimestamp = Math.max(newestPrefixTimestamp, message.timestamp);
  }
  return index;
}

/**
 * The full request a provider will be charged for: system prompt, advertised tool
 * schemas, and the transcript. The calibration input is anchored on the newest
 * assistant usage block, so only the guessed tail is scaled when there is one.
 */
export function projectContextRequest(
  messages: readonly AgentMessage[],
  tools: readonly ContextRequestTool[] = [],
): ContextProjection {
  let systemTokens = 0;
  let messageTokens = 0;
  for (const message of messages) {
    if (message.role === "system") systemTokens += estimateSystemMessageTokens(message);
    else messageTokens += estimateAgentMessageTokens(message);
  }
  let toolTokens = 0;
  for (const tool of tools) toolTokens += estimateToolSchemaTokens(tool);
  const bucketTokens = systemTokens + toolTokens + messageTokens;
  const transcriptTokens = estimateAgentMessagesTokens(messages);
  const anchor = lastUsageIndex(messages);
  const trailingTokens =
    anchor === null ? 0 : estimateAgentMessagesTokens(messages.slice(anchor + 1));
  const usageTokens = anchor === null ? 0 : usageTokensOf(messages[anchor] as AssistantMessage);
  return {
    cost: {
      systemTokens,
      toolTokens,
      messageTokens,
      totalTokens: Math.max(bucketTokens, transcriptTokens),
    },
    calibration: {
      usageTokens,
      trailingTokens,
      lastUsageIndex: anchor,
      tokens: Math.max(bucketTokens, transcriptTokens, usageTokens + trailingTokens),
    },
  };
}

/**
 * Below this remaining share of the hard limit the model is told to start closing
 * out; the floor keeps a small window from warning immediately, and the ceiling
 * keeps a large one from spending a summary's worth of context on the warning.
 */
const CONTEXT_REMINDER_RATIO = 0.15;
const CONTEXT_REMINDER_MIN_TOKENS = 8_000;
const CONTEXT_REMINDER_MAX_TOKENS = 32_000;

/** Close enough to the boundary that the next turn is likely to cross it. */
const CONTEXT_FALLBACK_REMINDER_TOKENS = 2_000;

export type ContextReminderStage = "approach" | "fallback";

export interface ContextReminder {
  readonly stage: ContextReminderStage;
  readonly remainingTokens: number;
  /** Where the reminder has to ride: a system delta, or a synthetic user message. */
  readonly role: "system" | "user";
  readonly text: string;
}

/** Remaining-context warning point for a hard limit. */
export function contextReminderThreshold(hardLimit: number): number {
  return Math.max(
    CONTEXT_REMINDER_MIN_TOKENS,
    Math.min(CONTEXT_REMINDER_MAX_TOKENS, Math.floor(hardLimit * CONTEXT_REMINDER_RATIO)),
  );
}

/**
 * APIs whose adapter carries a system message that arrives mid-conversation.
 * Everywhere else the reminder rides as a synthetic user message, appended to the
 * request only, so the cached prefix stays byte-identical.
 */
const MID_CONVERSATION_SYSTEM_APIS: ReadonlySet<string> = new Set(["anthropic-messages"]);

export function supportsMidConversationSystemMessages(
  model: Pick<Model<Api>, "api"> & { readonly compat?: unknown },
): boolean {
  if (MID_CONVERSATION_SYSTEM_APIS.has(model.api)) return true;
  const compat = model.compat as { readonly supportsMidConvoSystemMessages?: unknown } | undefined;
  return compat?.supportsMidConvoSystemMessages === true;
}

function contextApproachReminder(remainingTokens: number): string {
  return [
    "<context_budget>",
    `About ${remainingTokens.toLocaleString("en-US")} tokens of working context remain before this conversation is compacted.`,
    "Start closing out: write anything durable to files, and prefer targeted reads over broad exploration.",
    "You may call new_context to start a new window yourself once the current step is at a clean stopping point.",
    "</context_budget>",
  ].join("\n");
}

function contextFallbackReminder(): string {
  return [
    "<context_budget>",
    "The working context is at its limit: the next request compacts this conversation automatically.",
    "Write down now, in this turn, whatever must survive: file paths, decisions, and the exact next step, because unsummarized detail will not be available afterwards.",
    "</context_budget>",
  ].join("\n");
}

export interface ContextReminderInput {
  readonly remainingTokens: number;
  readonly hardLimit: number;
  readonly midConversationSystem: boolean;
}

/**
 * Emits each reminder at most once per checkpoint window: repeating it every turn
 * would burn context and re-append a message just to say the same thing. A
 * compaction resets the window.
 */
export class ContextBudgetReminderTracker {
  readonly #sent = new Set<ContextReminderStage>();

  select(input: ContextReminderInput): ContextReminder | undefined {
    const remainingTokens = Math.max(0, Math.floor(input.remainingTokens));
    const stage: ContextReminderStage | undefined =
      remainingTokens <= CONTEXT_FALLBACK_REMINDER_TOKENS
        ? "fallback"
        : remainingTokens <= contextReminderThreshold(input.hardLimit)
          ? "approach"
          : undefined;
    if (stage === undefined || this.#sent.has(stage)) return undefined;
    this.#sent.add(stage);
    return {
      stage,
      remainingTokens,
      role: input.midConversationSystem ? "system" : "user",
      text:
        stage === "fallback" ? contextFallbackReminder() : contextApproachReminder(remainingTokens),
    };
  }

  /** A new checkpoint window starts the reminders over. */
  reset(): void {
    this.#sent.clear();
  }
}

export type ContextWarningLevel = "none" | "approaching" | "critical";

export interface ContextPressure {
  readonly rawTokens: number;
  readonly calibratedTokens: number;
  readonly budget: ContextBudget;
  readonly hardLimit: number;
  readonly autoCompactThreshold: number;
  readonly warningThreshold: number;
  readonly requestCost: ContextRequestCost;
  /** The raw projection the calibration corrected. */
  readonly projection: ContextProjection;
  /** Tokens left before the hard limit, floored at zero. */
  readonly remainingTokens: number;
  readonly shouldCompact: boolean;
  readonly warningLevel: ContextWarningLevel;
}

export interface EvaluateContextPressureInput {
  readonly messages: readonly AgentMessage[];
  readonly model: Pick<Model<Api>, "contextWindow" | "maxTokens" | "api"> &
    Partial<Pick<Model<Api>, "compat">>;
  /** Tools the request advertises, which the transcript alone does not carry. */
  readonly tools?: readonly ContextRequestTool[] | undefined;
  readonly calibration?: Pick<ContextEstimateCalibration, "correct"> | undefined;
}

export function evaluateContextPressure(input: EvaluateContextPressureInput): ContextPressure {
  const budget = computeContextBudget(input.model);
  const projection = projectContextRequest(input.messages, input.tools ?? []);
  const rawTokens = projection.calibration.tokens;
  const calibratedTokens =
    input.calibration === undefined ? rawTokens : input.calibration.correct(projection.calibration);
  const warningLevel: ContextWarningLevel =
    calibratedTokens >= budget.hardLimit
      ? "critical"
      : calibratedTokens >= budget.warningThreshold
        ? "approaching"
        : "none";
  const remainingTokens = Math.max(0, budget.hardLimit - calibratedTokens);
  return {
    rawTokens,
    calibratedTokens,
    budget,
    hardLimit: budget.hardLimit,
    autoCompactThreshold: budget.autoCompactThreshold,
    warningThreshold: budget.warningThreshold,
    requestCost: projection.cost,
    projection,
    remainingTokens,
    shouldCompact: calibratedTokens >= budget.autoCompactThreshold || remainingTokens === 0,
    warningLevel,
  };
}
