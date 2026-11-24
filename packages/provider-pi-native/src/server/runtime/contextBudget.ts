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

const UPWARD_SAMPLE_COUNT = 3;
const DOWNWARD_SAMPLE_COUNT = 3;
const DOWNWARD_STEP_RATIO = 0.85;
const MINIMUM_MULTIPLIER = 0.85;

/**
 * Learned correction between the cheap character estimate and the prompt tokens a
 * provider reports. Growth is fast; shrinkage is slow and floored, because an
 * underestimate that lets context overflow is far worse than a slightly early compaction.
 */
export class ContextEstimateCalibration {
  #multiplier = 1;
  #upwardRatios: number[] = [];
  #downwardStreak = 0;

  get multiplier(): number {
    return this.#multiplier;
  }

  recordSample(rawEstimatedTokens: number, actualPromptTokens: number): void {
    if (rawEstimatedTokens <= 0 || actualPromptTokens <= 0) return;
    const ratio = actualPromptTokens / rawEstimatedTokens;
    const calibratedEstimate = rawEstimatedTokens * this.#multiplier;
    if (actualPromptTokens > calibratedEstimate) {
      this.#downwardStreak = 0;
      this.#upwardRatios.push(ratio);
      if (this.#upwardRatios.length < UPWARD_SAMPLE_COUNT) return;
      const observed = average(this.#upwardRatios);
      this.#upwardRatios = [];
      this.#multiplier = Math.max(this.#multiplier, observed);
      return;
    }
    this.#upwardRatios = [];
    if (actualPromptTokens === calibratedEstimate) {
      this.#downwardStreak = 0;
      return;
    }
    this.#downwardStreak += 1;
    if (this.#downwardStreak < DOWNWARD_SAMPLE_COUNT) return;
    this.#downwardStreak = 0;
    const stepped = Math.max(this.#multiplier * DOWNWARD_STEP_RATIO, ratio);
    this.#multiplier = Math.max(MINIMUM_MULTIPLIER, stepped);
  }

  calibrate(rawTokens: number): number {
    return Math.max(0, Math.round(rawTokens * this.#multiplier));
  }
}

function average(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

export type ContextWarningLevel = "none" | "approaching" | "critical";

export interface ContextPressure {
  readonly rawTokens: number;
  readonly calibratedTokens: number;
  readonly budget: ContextBudget;
  readonly hardLimit: number;
  readonly autoCompactThreshold: number;
  readonly warningThreshold: number;
  readonly shouldCompact: boolean;
  readonly warningLevel: ContextWarningLevel;
}

export function evaluateContextPressure(
  messages: readonly AgentMessage[],
  model: Pick<Model<Api>, "contextWindow" | "maxTokens">,
  calibration?: Pick<ContextEstimateCalibration, "calibrate">,
): ContextPressure {
  const budget = computeContextBudget(model);
  const rawTokens = estimateAgentMessagesTokens(messages);
  const calibratedTokens = calibration === undefined ? rawTokens : calibration.calibrate(rawTokens);
  const warningLevel: ContextWarningLevel =
    calibratedTokens >= budget.hardLimit
      ? "critical"
      : calibratedTokens >= budget.warningThreshold
        ? "approaching"
        : "none";
  return {
    rawTokens,
    calibratedTokens,
    budget,
    hardLimit: budget.hardLimit,
    autoCompactThreshold: budget.autoCompactThreshold,
    warningThreshold: budget.warningThreshold,
    shouldCompact: calibratedTokens >= budget.autoCompactThreshold,
    warningLevel,
  };
}
