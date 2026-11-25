import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, toToolDeclaration, type SystemMessage } from "@earendil-works/pi-ai";

import type { PersistedTranscriptRecord } from "./sessionStore.ts";

const SYSTEM_DECLARATION_VERSION = 1;

export interface SystemTranscriptDeclaration {
  readonly id: string;
  readonly message: SystemMessage;
  readonly messageJson: string;
  readonly beforeMessageId: string | null;
  readonly afterMessageId: string | null;
  readonly timestampMs: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Persist declarations, never the folded request body that carries them. */
export function serializeSystemMessage(message: SystemMessage): string {
  return JSON.stringify({
    ...message,
    content: contentText(message.content),
    ...(message.toolsAdded === undefined
      ? {}
      : { toolsAdded: message.toolsAdded.map(toToolDeclaration) }),
  });
}

export function readSystemMessage(messageJson: string): SystemMessage {
  const value: unknown = JSON.parse(messageJson);
  if (
    !isRecord(value) ||
    value.role !== "system" ||
    typeof value.timestamp !== "number" ||
    !(typeof value.content === "string" || Array.isArray(value.content))
  ) {
    throw new Error("Invalid persisted Pi Native system message");
  }
  if (value.sections !== undefined && !isRecord(value.sections)) {
    throw new Error("Invalid persisted Pi Native system sections");
  }
  return value as unknown as SystemMessage;
}

/**
 * Non-system rows keep their order. A system row whose following user row arrived first
 * is moved back to the declaration point, skipping duplicate declarations.
 */
export function orderSystemRows(
  records: readonly PersistedTranscriptRecord[],
): PersistedTranscriptRecord[] {
  const rows = records.filter((record) => record.system === null);
  const seen = new Set<string>();
  for (const record of records) {
    if (record.system === null) continue;
    if (record.role !== "system" || record.system.version !== SYSTEM_DECLARATION_VERSION) {
      throw new Error("Invalid persisted Pi Native system record");
    }
    const key = serializeSystemMessage(readSystemMessage(record.messageJson));
    if (seen.has(key)) continue;
    seen.add(key);
    const before = record.system.beforeMessageId;
    let index = before === null ? -1 : rows.findIndex((candidate) => candidate.id === before);
    if (index < 0 && record.system.afterMessageId !== null) {
      const after = record.system.afterMessageId;
      const previous = rows.findIndex((candidate) => candidate.id === after);
      if (previous >= 0) {
        index = previous + 1;
        while (rows[index]?.system !== null) index += 1;
      }
    }
    rows.splice(index < 0 ? rows.length : index, 0, record);
  }
  return rows;
}

/**
 * Assigns record ids to system deltas before dispatch. The declaration carries the
 * ids of its neighbouring rows so a reload can place it without the request body.
 */
export class SystemTranscriptJournal {
  readonly #ids = new WeakMap<AgentMessage, string>();
  readonly #serializedIds = new Set<string>();
  readonly #pending = new WeakMap<AgentMessage, string>();
  readonly #checkpoints = new Set<string>();

  restore(record: PersistedTranscriptRecord): SystemMessage {
    if (record.system === null) throw new Error("Not a persisted system record.");
    const message = readSystemMessage(record.messageJson);
    this.#ids.set(message, record.id);
    this.#serializedIds.add(serializeSystemMessage(message));
    return message;
  }

  isPersisted(message: AgentMessage): boolean {
    if (message.role !== "system") return false;
    if (this.#ids.has(message)) return true;
    const key = serializeSystemMessage(message);
    return this.#serializedIds.has(key) || this.#checkpoints.has(key);
  }

  declare(
    messages: readonly AgentMessage[],
    recordIdOf: (message: AgentMessage) => string | undefined,
    newId: () => string,
  ): SystemTranscriptDeclaration[] {
    const declarations: SystemTranscriptDeclaration[] = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message === undefined || message.role !== "system" || this.isPersisted(message)) continue;
      const following = messages.slice(index + 1).find((candidate) => candidate.role !== "system");
      const preceding = messages
        .slice(0, index)
        .reverse()
        .find((candidate) => candidate.role !== "system");
      const id = this.#pending.get(message) ?? newId();
      this.#pending.set(message, id);
      declarations.push({
        id,
        message,
        messageJson: serializeSystemMessage(message),
        beforeMessageId: (following === undefined ? undefined : recordIdOf(following)) ?? null,
        afterMessageId: (preceding === undefined ? undefined : recordIdOf(preceding)) ?? null,
        timestampMs: message.timestamp,
      });
    }
    return declarations;
  }

  markPersisted(message: AgentMessage, id: string): void {
    this.#ids.set(message, id);
    this.#pending.delete(message);
    if (message.role === "system") {
      this.#serializedIds.add(serializeSystemMessage(message));
    }
  }

  rememberCheckpoint(messageJson: string): void {
    this.#checkpoints.add(serializeSystemMessage(readSystemMessage(messageJson)));
  }
}
