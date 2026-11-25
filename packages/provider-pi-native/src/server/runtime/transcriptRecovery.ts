// @effect-diagnostics nodeBuiltinImport:off -- Restored image refs are read from the session's filesystem roots.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  contentText,
  type AssistantMessage,
  type SystemMessage,
  type TextContent,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
} from "@earendil-works/pi-ai";
import * as NodeFSP from "node:fs/promises";

import { readSystemMessage, orderSystemRows } from "./systemTranscriptJournal.ts";
import type {
  PersistedCompactionCheckpoint,
  PersistedThreadSnapshot,
  PersistedTranscriptRecord,
} from "./sessionStore.ts";
import { EMPTY_TODO_SNAPSHOT, type TodoSnapshot } from "./tools.ts";

/** Mirrors the provider-facing image admission limits used by the agent runtime. */
const MAX_RESTORED_IMAGE_BYTES = 10_000_000;
const MAX_RESTORED_IMAGE_HISTORY_BYTES = 30_000_000;
const MAX_RESTORED_IMAGE_EDGE_PX = 8000;

export interface RestoredImageSource {
  readonly sizeBytes: number;
  readonly bytes?: Uint8Array | undefined;
}

export type ReadRestoredImage = (ref: string) => Promise<RestoredImageSource | null>;

export interface RestoreTranscriptInput {
  readonly snapshot: PersistedThreadSnapshot;
  readonly model: Pick<AssistantMessage, "api" | "provider" | "model">;
  readonly now: number;
  readonly supportsVision?: boolean | undefined;
  readonly readImage?: ReadRestoredImage | undefined;
}

export interface RestoredTranscript {
  readonly messages: readonly AgentMessage[];
  readonly recordIds: ReadonlyMap<AgentMessage, string>;
  readonly todos: TodoSnapshot;
  readonly activatedToolNames: readonly string[];
  readonly checkpoint: boolean;
}

const readRestoredImageFromDisk: ReadRestoredImage = async (ref) => {
  const stat = await NodeFSP.stat(ref).catch(() => null);
  if (stat === null || !stat.isFile()) return null;
  if (stat.size > MAX_RESTORED_IMAGE_BYTES) return { sizeBytes: stat.size };
  const data = await NodeFSP.readFile(ref).catch(() => null);
  return data === null ? null : { sizeBytes: stat.size, bytes: new Uint8Array(data) };
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const base64Bytes = (data: string): number => {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
};

const u16be = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
const u16le = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
const u24le = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
const u32be = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) * 0x1000000 +
  (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0));

const ascii = (bytes: Uint8Array, offset: number, text: string): boolean => {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
};

interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 24 || !ascii(bytes, 12, "IHDR")) return undefined;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 10) return undefined;
  return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (ascii(bytes, 12, "VP8X") && bytes.length >= 30) {
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  if (ascii(bytes, 12, "VP8L") && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits =
      (bytes[21] ?? 0) |
      ((bytes[22] ?? 0) << 8) |
      ((bytes[23] ?? 0) << 16) |
      ((bytes[24] ?? 0) << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (
    ascii(bytes, 12, "VP8 ") &&
    bytes.length >= 30 &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  return undefined;
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = u16be(bytes, offset + 2);
    if (length < 2) return undefined;
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > bytes.length) return undefined;
      return { width: u16be(bytes, offset + 7), height: u16be(bytes, offset + 5) };
    }
    offset += 2 + length;
  }
  return undefined;
}

function probeImageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (ascii(bytes, 0, "\x89PNG\r\n\x1a\n")) return pngDimensions(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpegDimensions(bytes);
  if (ascii(bytes, 0, "GIF8")) return gifDimensions(bytes);
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return webpDimensions(bytes);
  return undefined;
}

function probeBase64ImageDimensions(data: string): ImageDimensions | undefined {
  const head = Buffer.from(data.slice(0, 87_384), "base64");
  const dimensions = probeImageDimensions(head);
  if (dimensions !== undefined || data.length <= 87_384) return dimensions;
  return probeImageDimensions(Buffer.from(data, "base64"));
}

const exceedsEdgeLimit = (dimensions: ImageDimensions | undefined): boolean =>
  dimensions !== undefined &&
  Math.max(dimensions.width, dimensions.height) > MAX_RESTORED_IMAGE_EDGE_PX;

interface ImageBlock {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
  /** Session-scoped path of the durable original; base64 is never stored. */
  readonly ref?: string;
}

const isImageBlock = (value: unknown): value is ImageBlock => {
  const record = asRecord(value);
  return (
    record !== null &&
    record.type === "image" &&
    typeof record.data === "string" &&
    typeof record.mimeType === "string" &&
    (record.ref === undefined || typeof record.ref === "string")
  );
};

interface ImageSlot {
  readonly messageIndex: number;
  readonly blockIndex: number;
  readonly block: ImageBlock;
  readonly bytes: number;
}

function placeholderFor(block: ImageBlock, reason: string): TextContent {
  return { type: "text", text: `[image omitted: ${block.mimeType}, ${reason}]` };
}

/** Newest images are considered first so the aggregate budget keeps the most recent context. */
async function admitImages(
  messages: AgentMessage[],
  readImage: ReadRestoredImage,
  supportsVision: boolean,
  recordIds: Map<AgentMessage, string>,
): Promise<AgentMessage[]> {
  const slots: ImageSlot[] = [];
  messages.forEach((message, messageIndex) => {
    if (
      (message.role !== "user" && message.role !== "toolResult") ||
      typeof message.content === "string"
    ) {
      return;
    }
    message.content.forEach((block, blockIndex) => {
      if (!isImageBlock(block)) return;
      slots.push({
        messageIndex,
        blockIndex,
        block,
        bytes: block.data === "" ? 0 : base64Bytes(block.data),
      });
    });
  });
  if (slots.length === 0) return messages;
  const decisions = new Map<number, { readonly data: string } | { readonly note: TextContent }>();
  let budget = MAX_RESTORED_IMAGE_HISTORY_BYTES;
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    const slot = slots[index];
    if (slot === undefined) continue;
    const block = slot.block;
    if (!supportsVision) {
      decisions.set(index, { note: placeholderFor(block, "images are not supported") });
      continue;
    }
    if (block.data !== "") {
      if (slot.bytes > MAX_RESTORED_IMAGE_BYTES) {
        decisions.set(index, { note: placeholderFor(block, "over the 10 MiB restore limit") });
        continue;
      }
      if (exceedsEdgeLimit(probeBase64ImageDimensions(block.data))) {
        decisions.set(index, { note: placeholderFor(block, "over the 8000 px limit") });
        continue;
      }
      if (slot.bytes > budget) {
        decisions.set(index, { note: placeholderFor(block, "over the 30 MiB history budget") });
        continue;
      }
      budget -= slot.bytes;
      decisions.set(index, { data: block.data });
      continue;
    }
    if (block.ref === undefined || block.ref === "") {
      decisions.set(index, { note: placeholderFor(block, "the original file is unavailable") });
      continue;
    }
    const source = await readImage(block.ref);
    if (source === null) {
      decisions.set(index, { note: placeholderFor(block, "the original file is unavailable") });
      continue;
    }
    if (source.sizeBytes > MAX_RESTORED_IMAGE_BYTES) {
      decisions.set(index, { note: placeholderFor(block, "over the 10 MiB restore limit") });
      continue;
    }
    if (source.bytes === undefined) {
      decisions.set(index, { note: placeholderFor(block, "the original file is unavailable") });
      continue;
    }
    if (exceedsEdgeLimit(probeImageDimensions(source.bytes))) {
      decisions.set(index, { note: placeholderFor(block, "over the 8000 px limit") });
      continue;
    }
    if (source.bytes.byteLength > budget) {
      decisions.set(index, { note: placeholderFor(block, "over the 30 MiB history budget") });
      continue;
    }
    budget -= source.bytes.byteLength;
    decisions.set(index, { data: Buffer.from(source.bytes).toString("base64") });
  }
  let slotIndex = -1;
  return messages.map((message) => {
    if (
      (message.role !== "user" && message.role !== "toolResult") ||
      typeof message.content === "string"
    ) {
      return message;
    }
    const content = message.content.map((block) => {
      if (!isImageBlock(block)) return block;
      slotIndex += 1;
      const decision = decisions.get(slotIndex);
      if (decision === undefined) return block;
      return "note" in decision
        ? decision.note
        : { type: "image" as const, data: decision.data, mimeType: block.mimeType };
    });
    const updated = { ...message, content } as AgentMessage;
    const id = recordIds.get(message);
    if (id !== undefined) {
      recordIds.delete(message);
      recordIds.set(updated, id);
    }
    return updated;
  });
}

const emptyUsage = (): AssistantMessage["usage"] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function parseUserMessage(json: string): UserMessage | null {
  const value = asRecord(JSON.parse(json));
  if (value === null || value.role !== "user" || typeof value.timestamp !== "number") return null;
  if (typeof value.content !== "string" && !Array.isArray(value.content)) return null;
  return value as unknown as UserMessage;
}

function parseAssistantMessage(json: string): AssistantMessage | null {
  const value = asRecord(JSON.parse(json));
  if (
    value === null ||
    value.role !== "assistant" ||
    !Array.isArray(value.content) ||
    typeof value.timestamp !== "number"
  ) {
    return null;
  }
  const message = value as unknown as AssistantMessage;
  if (message.stopReason === "error" || message.stopReason === "aborted") return null;
  return message;
}

function parseToolResultMessage(json: string): ToolResultMessage | null {
  const value = asRecord(JSON.parse(json));
  if (
    value === null ||
    value.role !== "toolResult" ||
    typeof value.toolCallId !== "string" ||
    typeof value.toolName !== "string" ||
    !Array.isArray(value.content) ||
    typeof value.timestamp !== "number"
  ) {
    return null;
  }
  return value as unknown as ToolResultMessage;
}

const toolCallsOf = (message: AssistantMessage): readonly ToolCall[] =>
  message.content.filter((block): block is ToolCall => block.type === "toolCall");

const errorResult = (
  call: { readonly id: string; readonly name: string },
  timestamp: number,
): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: call.id,
  toolName: call.name,
  content: [
    {
      type: "text",
      text: "The tool call did not complete before the previous Pi Native session ended.",
    },
  ],
  isError: true,
  timestamp,
});

const carrierFor = (
  call: { readonly id: string; readonly name: string },
  model: RestoreTranscriptInput["model"],
  timestamp: number,
): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "toolCall", id: call.id, name: call.name, arguments: {} }],
  api: model.api,
  provider: model.provider,
  model: model.model,
  usage: emptyUsage(),
  stopReason: "toolUse",
  timestamp,
});

function reconstructRows(
  rows: readonly PersistedTranscriptRecord[],
  model: RestoreTranscriptInput["model"],
  now: number,
  retainedCalls: readonly { readonly id: string; readonly name: string }[],
  retainedCallIds: ReadonlySet<string>,
  recordIds: Map<AgentMessage, string>,
): AgentMessage[] {
  const messages: AgentMessage[] = [];
  let pending: { readonly id: string; readonly name: string }[] = [...retainedCalls];
  const flush = () => {
    for (const call of pending) messages.push(errorResult(call, now));
    pending = [];
  };
  const pushWithId = (message: AgentMessage, id: string): void => {
    recordIds.set(message, id);
    messages.push(message);
  };
  const knownCalls = new Set(retainedCallIds);
  for (const row of rows) {
    try {
      if (row.role === "system") {
        pushWithId(readSystemMessage(row.messageJson), row.id);
        continue;
      }
      if (row.role === "user") {
        flush();
        const message = parseUserMessage(row.messageJson);
        if (message !== null) pushWithId(message, row.id);
        continue;
      }
      if (row.role === "assistant") {
        flush();
        const message = parseAssistantMessage(row.messageJson);
        if (message === null) continue;
        if (message.content.length === 0) continue;
        pushWithId(message, row.id);
        for (const call of toolCallsOf(message)) {
          pending.push({ id: call.id, name: call.name });
          knownCalls.add(call.id);
        }
        continue;
      }
      const result = parseToolResultMessage(row.messageJson);
      if (result === null) continue;
      const index = pending.findIndex((call) => call.id === result.toolCallId);
      if (index >= 0) {
        pending.splice(index, 1);
        pushWithId(result, row.id);
        continue;
      }
      if (knownCalls.has(result.toolCallId)) {
        pushWithId(result, row.id);
        continue;
      }
      flush();
      messages.push(
        carrierFor({ id: result.toolCallId, name: result.toolName }, model, result.timestamp),
      );
      pushWithId(result, row.id);
      knownCalls.add(result.toolCallId);
    } catch {
      // A malformed row must not cost the rest of the transcript.
    }
  }
  flush();
  return messages;
}

const zeroUsage = (message: AgentMessage): AgentMessage =>
  message.role === "assistant" ? { ...message, usage: emptyUsage() } : message;

function checkpointPrefix(checkpoint: PersistedCompactionCheckpoint, now: number): AgentMessage[] {
  const messages: AgentMessage[] = [];
  let leadingSystem: SystemMessage | undefined;
  if (checkpoint.leadingSystemJson !== null) {
    try {
      leadingSystem = readSystemMessage(checkpoint.leadingSystemJson);
    } catch {
      // The summary still survives without the folded system prompt.
    }
  }
  const summary = checkpoint.summary.trim();
  if (leadingSystem !== undefined) {
    const base = contentText(leadingSystem.content);
    messages.push(
      summary !== "" && !base.includes(summary)
        ? {
            ...leadingSystem,
            content: base === "" ? summary : `${base}\n\n${summary}`,
          }
        : leadingSystem,
    );
  } else if (summary !== "") {
    messages.push(leadingFallback(checkpoint, now));
  }
  const retained: unknown = JSON.parse(checkpoint.retainedMessagesJson);
  if (Array.isArray(retained)) {
    for (const value of retained) {
      const record = asRecord(value);
      if (record === null || typeof record.role !== "string") continue;
      messages.push(zeroUsage(value as AgentMessage));
    }
  }
  return messages.length === 0 ? [{ ...leadingFallback(checkpoint, now) }] : messages;
}

function leadingFallback(checkpoint: PersistedCompactionCheckpoint, now: number): AgentMessage {
  return {
    role: "system",
    content: checkpoint.summary,
    timestamp: now,
  };
}

interface TodoStep {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "running" | "completed";
}

const isTodoSnapshot = (value: unknown): value is TodoSnapshot => {
  const record = asRecord(value);
  if (record === null) return false;
  if (typeof record.revision !== "number" || !Array.isArray(record.steps)) return false;
  if (
    !record.steps.every((step) => {
      const candidate = asRecord(step);
      return (
        candidate !== null &&
        typeof candidate.id === "string" &&
        typeof candidate.text === "string" &&
        (candidate.status === "pending" ||
          candidate.status === "running" ||
          candidate.status === "completed")
      );
    })
  ) {
    return false;
  }
  return record.explanation === undefined || typeof record.explanation === "string";
};

/** Restores the todo list from the last successful TodoWrite result. */
export function restoreTodosFromMessages(messages: ReadonlyArray<AgentMessage>): TodoSnapshot {
  let latest: TodoSnapshot = EMPTY_TODO_SNAPSHOT;
  for (const message of messages) {
    if (
      message.role !== "toolResult" ||
      message.toolName !== "TodoWrite" ||
      message.isError === true
    ) {
      continue;
    }
    const details = (message as { readonly details?: unknown }).details;
    if (isTodoSnapshot(details)) {
      latest = {
        revision: details.revision,
        steps: details.steps.map((step: TodoStep) => ({ ...step })),
        ...(details.explanation === undefined ? {} : { explanation: details.explanation }),
      };
    }
  }
  return latest;
}

const parseTodos = (todosJson: string | null): TodoSnapshot | null => {
  if (todosJson === null) return null;
  try {
    const value: unknown = JSON.parse(todosJson);
    return isTodoSnapshot(value)
      ? {
          revision: value.revision,
          steps: value.steps.map((step) => ({ ...step })),
          ...(value.explanation === undefined ? {} : { explanation: value.explanation }),
        }
      : null;
  } catch {
    return null;
  }
};

const parseToolNames = (json: string): readonly string[] => {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value)
      ? value.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
};

const retainedUsage = (
  checkpoint: PersistedCompactionCheckpoint,
  now: number,
): {
  readonly messages: AgentMessage[];
  readonly retainedCalls: { readonly id: string; readonly name: string }[];
  readonly callIds: Set<string>;
} => {
  const messages = checkpointPrefix(checkpoint, now).map(zeroUsage);
  const callIds = new Set<string>();
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of toolCallsOf(message)) callIds.add(call.id);
    } else if (message.role === "toolResult") {
      answered.add(message.toolCallId);
    }
  }
  const lastAssistant = [...messages]
    .reverse()
    .find((message): message is AssistantMessage => message.role === "assistant");
  const retainedCalls =
    lastAssistant === undefined
      ? []
      : toolCallsOf(lastAssistant)
          .filter((call) => !answered.has(call.id))
          .map((call) => ({ id: call.id, name: call.name }));
  return { messages, retainedCalls, callIds };
};

/** Rebuilds the live transcript from durable rows, applying the newest valid checkpoint. */
export async function restoreTranscript(
  input: RestoreTranscriptInput,
): Promise<RestoredTranscript> {
  const rows = orderSystemRows(input.snapshot.records);
  const checkpoint = input.snapshot.checkpoint;
  const recordIds = new Map<AgentMessage, string>();
  const boundary =
    checkpoint === null || checkpoint.throughMessageId === null
      ? undefined
      : rows.findIndex((row) => row.id === checkpoint.throughMessageId);
  let messages: AgentMessage[];
  let restoredCheckpoint = false;
  if (
    checkpoint !== null &&
    (checkpoint.throughMessageId === null || (boundary !== undefined && boundary >= 0))
  ) {
    const retained = retainedUsage(checkpoint, input.now);
    const afterRows = boundary === undefined ? [] : rows.slice(boundary + 1);
    const after = reconstructRows(
      afterRows,
      input.model,
      input.now,
      retained.retainedCalls,
      retained.callIds,
      recordIds,
    );
    messages = [...retained.messages, ...after];
    restoredCheckpoint = true;
  } else {
    messages = reconstructRows(rows, input.model, input.now, [], new Set(), recordIds);
  }
  messages = await admitImages(
    messages,
    input.readImage ?? readRestoredImageFromDisk,
    input.supportsVision !== false,
    recordIds,
  );
  const meta = input.snapshot.meta;
  return {
    messages,
    recordIds,
    todos: parseTodos(meta?.todosJson ?? null) ?? restoreTodosFromMessages(messages),
    activatedToolNames: parseToolNames(meta?.activatedToolNamesJson ?? "[]"),
    checkpoint: restoredCheckpoint,
  };
}
