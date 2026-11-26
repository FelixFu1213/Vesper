import * as Schema from "effect/Schema";

import { NonNegativeInt, ProviderTurnId, RunId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Where a token in a thread's prompt comes from. Every counted token belongs to exactly
 * one category, so a breakdown never double-charges a message or a tool schema.
 */
export const ThreadContextCategory = Schema.Literals([
  "system",
  "mcp",
  "tools",
  "skills",
  "user",
  "assistant",
  "tool_results",
  "provider_overhead",
]);
export type ThreadContextCategory = typeof ThreadContextCategory.Type;

/**
 * How much to trust the numbers. `exact` reads the provider's own transcript, `calibrated`
 * reads a native session plus T3's own prompt composition, and `estimated` reconstructs
 * from T3's orchestration history when the provider keeps its prompt to itself.
 */
export const ThreadContextFidelity = Schema.Literals(["exact", "calibrated", "estimated"]);
export type ThreadContextFidelity = typeof ThreadContextFidelity.Type;

export const ThreadContextItemKind = Schema.Literals([
  "system_section",
  "mcp_schema",
  "mcp_result",
  "tool_schema",
  "tool_catalog",
  "skill_catalog",
  "skill_loaded",
  "user_message",
  "assistant_answer",
  "assistant_reasoning",
  "assistant_tool_call",
  "tool_result",
  "compaction_summary",
  "provider_overhead",
]);
export type ThreadContextItemKind = typeof ThreadContextItemKind.Type;

export const ThreadContextItemStatus = Schema.Literals(["active", "deferred", "ok", "error"]);
export type ThreadContextItemStatus = typeof ThreadContextItemStatus.Type;

export const ThreadContextItemMeta = Schema.Struct({
  mcpServer: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  skillId: Schema.optional(Schema.String),
  filePath: Schema.optional(Schema.String),
  imageCount: Schema.optional(NonNegativeInt),
  assistantSubKind: Schema.optional(
    Schema.Literals(["answer", "reasoning", "tool_call", "compaction"]),
  ),
});
export type ThreadContextItemMeta = typeof ThreadContextItemMeta.Type;

export const ThreadContextBreakdownItem = Schema.Struct({
  id: Schema.String,
  category: ThreadContextCategory,
  kind: ThreadContextItemKind,
  label: Schema.String,
  /** `mcp:t3-code`, `core`, `activated`, `deferred`, `project`, `user`, or `builtin`. */
  source: Schema.optional(Schema.String),
  status: Schema.optional(ThreadContextItemStatus),
  estimatedTokens: NonNegativeInt,
  calibratedTokens: NonNegativeInt,
  charCount: NonNegativeInt,
  byteCount: NonNegativeInt,
  turnIndex: Schema.optional(NonNegativeInt),
  orderIndex: Schema.Number,
  /** Server-truncated content, at most 4,000 characters. */
  preview: Schema.optional(Schema.String),
  previewTruncated: Schema.optional(Schema.Boolean),
  meta: Schema.optional(ThreadContextItemMeta),
});
export type ThreadContextBreakdownItem = typeof ThreadContextBreakdownItem.Type;

export const ThreadContextCategorySummary = Schema.Struct({
  category: ThreadContextCategory,
  estimatedTokens: NonNegativeInt,
  calibratedTokens: NonNegativeInt,
  itemCount: NonNegativeInt,
  /** On-demand tools this category could have declared but did not. */
  deferredCount: Schema.optional(NonNegativeInt),
  deferredTokens: Schema.optional(NonNegativeInt),
  /** Change against the previous turn, when a previous turn exists. */
  deltaTokens: Schema.optional(Schema.Int),
});
export type ThreadContextCategorySummary = typeof ThreadContextCategorySummary.Type;

export const ThreadContextTurnEvent = Schema.Literals([
  "compaction",
  "model_switch",
  "skill_loaded",
]);
export type ThreadContextTurnEvent = typeof ThreadContextTurnEvent.Type;

export const ThreadContextTurnPoint = Schema.Struct({
  turnIndex: NonNegativeInt,
  runId: Schema.optional(RunId),
  providerTurnId: Schema.optional(ProviderTurnId),
  timestamp: Schema.String,
  usedTokens: NonNegativeInt,
  deltaTokens: Schema.Int,
  inputTokens: Schema.optional(NonNegativeInt),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  reasoningOutputTokens: Schema.optional(NonNegativeInt),
  categories: Schema.optional(Schema.Record(ThreadContextCategory, NonNegativeInt)),
  events: Schema.Array(ThreadContextTurnEvent),
  compactionSavedTokens: Schema.optional(NonNegativeInt),
  summary: Schema.optional(Schema.String),
});
export type ThreadContextTurnPoint = typeof ThreadContextTurnPoint.Type;

export const ThreadContextCompactionEvent = Schema.Struct({
  id: Schema.String,
  turnIndex: Schema.optional(NonNegativeInt),
  timestamp: Schema.String,
  beforeTokens: Schema.optional(NonNegativeInt),
  afterTokens: Schema.optional(NonNegativeInt),
  savedTokens: Schema.optional(NonNegativeInt),
  summaryPreview: Schema.optional(Schema.String),
});
export type ThreadContextCompactionEvent = typeof ThreadContextCompactionEvent.Type;

export const ThreadContextWindow = Schema.Struct({
  usedTokens: NonNegativeInt,
  estimatedTotalTokens: NonNegativeInt,
  actualUsedTokens: Schema.NullOr(NonNegativeInt),
  maxTokens: Schema.NullOr(NonNegativeInt),
  usedPercentage: Schema.NullOr(Schema.Number),
  remainingTokens: Schema.NullOr(NonNegativeInt),
  autoCompactThreshold: Schema.NullOr(NonNegativeInt),
  reserveTokens: Schema.NullOr(NonNegativeInt),
});
export type ThreadContextWindow = typeof ThreadContextWindow.Type;

export const ThreadContextCost = Schema.Struct({
  amount: Schema.Number,
  currency: Schema.String,
});
export type ThreadContextCost = typeof ThreadContextCost.Type;

export const ThreadContextUsage = Schema.Struct({
  inputTokens: Schema.NullOr(NonNegativeInt),
  cachedInputTokens: Schema.NullOr(NonNegativeInt),
  cacheHitRate: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(NonNegativeInt),
  reasoningOutputTokens: Schema.NullOr(NonNegativeInt),
  toolUses: NonNegativeInt,
  turnCount: NonNegativeInt,
  compactionCount: NonNegativeInt,
  cost: Schema.NullOr(ThreadContextCost),
});
export type ThreadContextUsage = typeof ThreadContextUsage.Type;

export const ThreadContextBreakdownInput = Schema.Struct({ threadId: ThreadId });
export type ThreadContextBreakdownInput = typeof ThreadContextBreakdownInput.Type;

/** The most items one breakdown carries; the rest stay folded into category totals. */
export const THREAD_CONTEXT_MAX_ITEMS = 500;

/** Server-side cap on one item's preview, so a huge tool result cannot bloat the response. */
export const THREAD_CONTEXT_PREVIEW_MAX_CHARS = 4_000;

export const ThreadContextBreakdown = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  driver: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  fidelity: ThreadContextFidelity,
  fidelityNote: Schema.optional(Schema.String),
  computedAt: Schema.String,
  window: ThreadContextWindow,
  usage: ThreadContextUsage,
  categories: Schema.Array(ThreadContextCategorySummary),
  items: Schema.Array(ThreadContextBreakdownItem),
  turns: Schema.Array(ThreadContextTurnPoint),
  compactions: Schema.Array(ThreadContextCompactionEvent),
});
export type ThreadContextBreakdown = typeof ThreadContextBreakdown.Type;
