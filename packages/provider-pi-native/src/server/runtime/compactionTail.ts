import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  TextContent,
  ThinkingContent,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

import { estimateAgentMessageTokens, estimateCjkAwareTextTokens } from "./contextBudget.ts";

/**
 * `retainedTailShape` marker for a tail holding the real recent window rather
 * than the single newest user message older checkpoints stored.
 */
export const COMPACTION_RETAINED_TAIL_SHAPE = "recent_window";

/** Appended when one message alone exceeds the tail budget. */
export const CHECKPOINT_TRUNCATION_MARKER =
  "\n\n[checkpoint truncated: this message crossed the retained context budget]\n\n";

/**
 * Roles a retained tail may carry: a tail is replayed straight into the model
 * context, so only messages the provider can accept belong in it.
 */
const RETAINED_TAIL_ROLES: ReadonlySet<string> = new Set(["user", "assistant", "toolResult"]);

/** Assistant stop reasons the provider drops from the rebuilt context. */
const DROPPED_STOP_REASONS: ReadonlySet<string> = new Set(["error", "aborted", "deferred"]);

type ContentBlock = TextContent | ThinkingContent | { readonly type: string };

function contentOf(message: AgentMessage): unknown {
  return (message as { readonly content?: unknown }).content;
}

function blocksOf(message: AgentMessage): ReadonlyArray<ContentBlock> {
  const content = contentOf(message);
  return Array.isArray(content) ? (content as ReadonlyArray<ContentBlock>) : [];
}

function blockText(block: ContentBlock): string {
  if (block.type === "thinking") return (block as ThinkingContent).thinking;
  if (block.type === "text") return (block as TextContent).text;
  return "";
}

function messageTokens(message: AgentMessage): number {
  return Math.max(1, estimateAgentMessageTokens(message));
}

/** The longest prefix of `text` that fits `maxTokens`, cut on a code-point boundary. */
export function truncateTextToTokens(text: string, maxTokens: number, marker: string): string {
  const budget = Math.max(1, Math.floor(maxTokens));
  if (estimateCjkAwareTextTokens(text) <= budget) return text;
  const bodyBudget = Math.max(0, budget - estimateCjkAwareTextTokens(marker));
  const characters = [...text];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateCjkAwareTextTokens(characters.slice(0, middle).join("")) <= bodyBudget)
      low = middle;
    else high = middle - 1;
  }
  return `${characters.slice(0, low).join("")}${marker}`;
}

/** Shrink every text-bearing block proportionally; only the last cut carries the marker. */
function shrinkBlocks(
  blocks: ReadonlyArray<ContentBlock>,
  textBudget: number,
): ReadonlyArray<ContentBlock> {
  const shrinkable = blocks.filter(
    (block) => (block.type === "text" || block.type === "thinking") && blockText(block) !== "",
  );
  if (shrinkable.length === 0) return blocks;
  const costs = shrinkable.map((block) =>
    Math.max(1, estimateCjkAwareTextTokens(blockText(block))),
  );
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  const replacements = new Map<ContentBlock, string>();
  for (const [index, block] of shrinkable.entries()) {
    const share = Math.max(1, Math.floor((textBudget * (costs[index] as number)) / total));
    const isLast = index === shrinkable.length - 1;
    replacements.set(
      block,
      truncateTextToTokens(blockText(block), share, isLast ? CHECKPOINT_TRUNCATION_MARKER : ""),
    );
  }
  return blocks.map((block) => {
    const text = replacements.get(block);
    if (text === undefined) return block;
    return { ...block, [block.type === "thinking" ? "thinking" : "text"]: text } as ContentBlock;
  });
}

/**
 * Bound one message to a token budget by truncating its text blocks. Tool calls
 * and tool results keep their identity, so a truncated message is still valid.
 */
export function truncateMessageToTail(message: AgentMessage, maxTokens: number): AgentMessage {
  const budget = Math.max(64, Math.floor(maxTokens));
  if (messageTokens(message) <= budget) return message;
  const content = contentOf(message);
  if (typeof content === "string") {
    return {
      ...message,
      content: truncateTextToTokens(content, budget, CHECKPOINT_TRUNCATION_MARKER),
    } as AgentMessage;
  }
  const blocks = blocksOf(message);
  // Everything that cannot shrink keeps its full cost; the rest shares what is left.
  let reserved = 0;
  for (const block of blocks) {
    if (block.type === "text" || block.type === "thinking") continue;
    reserved += 1;
    if (block.type === "toolCall") {
      reserved += estimateCjkAwareTextTokens(
        JSON.stringify((block as { readonly arguments?: unknown }).arguments) ?? "",
      );
    }
  }
  const shaped = shrinkBlocks(blocks, Math.max(1, budget - reserved));
  return { ...message, content: shaped } as AgentMessage;
}

/** Tool-call ids produced by the assistant messages of `messages`. */
function assistantToolCallIds(messages: ReadonlyArray<AgentMessage>): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of blocksOf(message)) {
      if (block.type !== "toolCall") continue;
      const id = (block as { readonly id?: unknown }).id;
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

/**
 * Drop tool results whose tool call is not in `messages`: a provider rejects a
 * result whose call is missing, so the tail cannot keep one it no longer explains.
 */
export function pruneOrphanToolResults(messages: ReadonlyArray<AgentMessage>): AgentMessage[] {
  const owned = assistantToolCallIds(messages);
  return messages.filter(
    (message) =>
      message.role !== "toolResult" ||
      (typeof (message as ToolResultMessage).toolCallId === "string" &&
        owned.has((message as ToolResultMessage).toolCallId)),
  );
}

/** Whether the provider can replay this assistant message at all. */
function isReplayableAssistant(message: AgentMessage): boolean {
  if (message.role !== "assistant") return true;
  return !DROPPED_STOP_REASONS.has((message as AssistantMessage).stopReason ?? "");
}

/** Whether a persisted value is a message a tail can replay. */
export function isRetainedTailMessage(value: unknown): value is AgentMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { readonly role?: unknown; readonly content?: unknown };
  if (typeof record.role !== "string" || !RETAINED_TAIL_ROLES.has(record.role)) return false;
  if (typeof record.content !== "string" && !Array.isArray(record.content)) return false;
  if (record.role === "toolResult") {
    return typeof (record as { readonly toolCallId?: unknown }).toolCallId === "string";
  }
  return true;
}

/**
 * Replay a persisted tail. Structural validation is not cosmetic: a record is
 * opaque JSON by the time it comes back, and a malformed entry would reach the
 * provider as a context message.
 */
export function replayRetainedTail(value: unknown): AgentMessage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const messages = value.filter(isRetainedTailMessage).map((message) => {
    const timestamp = (message as { readonly timestamp?: unknown }).timestamp;
    return typeof timestamp === "number" && Number.isFinite(timestamp)
      ? message
      : ({ ...message, timestamp: 0 } as AgentMessage);
  });
  return pruneOrphanToolResults(messages.filter(isReplayableAssistant));
}

function findLatestUserIndex(messages: ReadonlyArray<AgentMessage>): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && isRetainedTailMessage(message)) return index;
  }
  return -1;
}

/**
 * Strip the tool calls of an assistant message. Only a last-resort single message
 * needs this: an assistant whose results are not retained cannot keep the calls
 * they answer, or the provider rejects the context.
 */
export function stripDanglingToolCalls(message: AgentMessage): AgentMessage {
  const blocks = blocksOf(message);
  if (message.role !== "assistant" || !blocks.some((block) => block.type === "toolCall")) {
    return message;
  }
  const content = blocks.filter((block) => block.type !== "toolCall");
  return { ...message, content } as AgentMessage;
}

/**
 * The message a last-resort tail carries. A provider accepts neither a tool result
 * nor an unanswered tool call on its own, so this is a user message or assistant text.
 */
function soleReplayableMessage(
  messages: ReadonlyArray<AgentMessage>,
  latestUserGoal: boolean,
): AgentMessage | undefined {
  const roles: ReadonlyArray<AgentMessage["role"]> = latestUserGoal
    ? ["user", "assistant"]
    : ["assistant", "user"];
  for (const role of roles) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index] as AgentMessage;
      if (message.role !== role || !isReplayableAssistant(message)) continue;
      return role === "assistant" ? stripDanglingToolCalls(message) : message;
    }
  }
  return undefined;
}

export interface SelectRecentTailOptions {
  /** Keep the active task's user message even when the window starts past it. */
  readonly latestUserGoal?: boolean;
}

/**
 * The newest contiguous run of `messages` that fits `maxTokens`. Always retains
 * the newest replayable message — truncating it when it alone exceeds the budget
 * — so a fallback can never install an empty tail.
 */
export function selectRecentTail(
  messages: ReadonlyArray<AgentMessage>,
  maxTokens: number,
  options: SelectRecentTailOptions = {},
): AgentMessage[] {
  const budget = Math.max(1, Math.floor(maxTokens));
  let start = messages.length;
  let tokens = 0;
  while (start > 0) {
    const candidate = messages[start - 1] as AgentMessage;
    if (!isRetainedTailMessage(candidate) || !isReplayableAssistant(candidate)) {
      start -= 1;
      continue;
    }
    const cost = messageTokens(candidate);
    // The newest message is always kept; every older one has to fit.
    if (tokens + cost > budget && start < messages.length) break;
    tokens += cost;
    start -= 1;
  }

  let window = messages.slice(start).filter(isRetainedTailMessage).filter(isReplayableAssistant);
  if (options.latestUserGoal === true && !window.some((message) => message.role === "user")) {
    const latestUserIndex = findLatestUserIndex(messages);
    if (latestUserIndex >= 0) {
      window = [
        truncateMessageToTail(messages[latestUserIndex] as AgentMessage, Math.floor(budget / 2)),
        ...window,
      ];
    }
  }
  const tail = pruneOrphanToolResults(
    window.map((message) =>
      messageTokens(message) > budget ? truncateMessageToTail(message, budget) : message,
    ),
  );
  if (tail.length > 0) return tail;
  // A truncated window can prune down to nothing when its only message was a tool
  // result whose call fell outside the budget; the checkpoint still needs something.
  const solo = soleReplayableMessage(messages, options.latestUserGoal === true);
  return solo === undefined ? [] : [truncateMessageToTail(solo, budget)];
}
