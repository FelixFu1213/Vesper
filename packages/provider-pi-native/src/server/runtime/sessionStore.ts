import type { AgentMessage } from "@earendil-works/pi-agent-core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A system row's placement relative to the adjacent non-system rows it was declared next to. */
export interface PersistedSystemDeclaration {
  readonly version: 1;
  readonly beforeMessageId: string | null;
  readonly afterMessageId: string | null;
}

export interface PersistedTranscriptRecord {
  readonly id: string;
  readonly providerThreadId: string;
  readonly sequence: number;
  /** User message count the row belongs to; `0` is the first turn. */
  readonly turnIndex: number;
  readonly role: AgentMessage["role"];
  readonly timestampMs: number;
  /** Provider-neutral message JSON. Folded request bodies are never stored. */
  readonly messageJson: string;
  readonly system: PersistedSystemDeclaration | null;
}

export interface PersistedCompactionCheckpoint {
  readonly providerThreadId: string;
  /** Last transcript row the checkpoint replaces, or null when it covers the whole thread. */
  readonly throughMessageId: string | null;
  readonly mode: "active_turn" | "completed_turn";
  readonly summary: string;
  readonly leadingSystemJson: string | null;
  readonly retainedMessagesJson: string;
  readonly summarizedMessageCount: number;
  readonly chunkCount: number;
  readonly usedFallback: boolean;
  readonly createdAtMs: number;
}

export interface PersistedThreadMeta {
  readonly providerThreadId: string;
  readonly todosJson: string | null;
  readonly contextText: string | null;
  readonly activatedToolNamesJson: string;
  readonly updatedAtMs: number;
}

export interface PersistedThreadSnapshot {
  readonly providerThreadId: string;
  readonly records: readonly PersistedTranscriptRecord[];
  readonly checkpoint: PersistedCompactionCheckpoint | null;
  readonly meta: PersistedThreadMeta | null;
}

export interface PiNativeSessionStoreService {
  /** Durable stores survive the app process; in-memory stores only serve tests. */
  readonly durable: boolean;
  readonly appendRecords: (input: {
    readonly providerThreadId: string;
    readonly records: readonly PersistedTranscriptRecord[];
  }) => Effect.Effect<void, PiNativeSessionStoreError>;
  readonly loadThread: (
    providerThreadId: string,
  ) => Effect.Effect<PersistedThreadSnapshot | null, PiNativeSessionStoreError>;
  readonly saveCheckpoint: (
    checkpoint: PersistedCompactionCheckpoint,
  ) => Effect.Effect<void, PiNativeSessionStoreError>;
  readonly saveMeta: (meta: PersistedThreadMeta) => Effect.Effect<void, PiNativeSessionStoreError>;
  readonly truncateAfterTurn: (input: {
    readonly providerThreadId: string;
    readonly targetTurnCount: number;
  }) => Effect.Effect<void, PiNativeSessionStoreError>;
  readonly cloneThread: (input: {
    readonly sourceProviderThreadId: string;
    readonly targetProviderThreadId: string;
    readonly targetTurnCount?: number | undefined;
  }) => Effect.Effect<void, PiNativeSessionStoreError>;
  readonly deleteThread: (
    providerThreadId: string,
  ) => Effect.Effect<void, PiNativeSessionStoreError>;
}

export class PiNativeSessionStoreError extends Schema.TaggedError<
  PiNativeSessionStoreError,
  { readonly detail: Schema.String }
>()("PiNativeSessionStoreError", { detail: Schema.String }) {
  override get message() {
    return `The Pi Native session store failed: ${this.detail}`;
  }
}

export class PiNativeSessionStore extends Context.Service<
  PiNativeSessionStore,
  PiNativeSessionStoreService
>()("@t3tools/provider-pi-native/server/runtime/sessionStore/PiNativeSessionStore") {}

const dropCheckpointOutside = (
  checkpoint: PersistedCompactionCheckpoint | null,
  retainedIds: ReadonlySet<string>,
): PersistedCompactionCheckpoint | null =>
  checkpoint === null ||
  (checkpoint.throughMessageId !== null && !retainedIds.has(checkpoint.throughMessageId))
    ? null
    : checkpoint;

export const makeInMemoryPiNativeSessionStore = (options?: {
  readonly durable?: boolean | undefined;
}): PiNativeSessionStoreService => {
  const threads = new Map<
    string,
    {
      records: PersistedTranscriptRecord[];
      checkpoint: PersistedCompactionCheckpoint | null;
      meta: PersistedThreadMeta | null;
    }
  >();
  const thread = (providerThreadId: string) => {
    const existing = threads.get(providerThreadId);
    if (existing !== undefined) return existing;
    const created = {
      records: [] as PersistedTranscriptRecord[],
      checkpoint: null as PersistedCompactionCheckpoint | null,
      meta: null as PersistedThreadMeta | null,
    };
    threads.set(providerThreadId, created);
    return created;
  };
  return {
    durable: options?.durable ?? false,
    appendRecords: ({ providerThreadId, records }) =>
      Effect.sync(() => {
        const target = thread(providerThreadId);
        const known = new Set(target.records.map((record) => record.id));
        for (const record of records) {
          if (known.has(record.id)) continue;
          target.records.push(record);
          known.add(record.id);
        }
      }),
    loadThread: (providerThreadId) =>
      Effect.sync(() => {
        const target = threads.get(providerThreadId);
        if (target === undefined) return null;
        return {
          providerThreadId,
          records: target.records.map((record) => ({ ...record })),
          checkpoint: target.checkpoint === null ? null : { ...target.checkpoint },
          meta: target.meta === null ? null : { ...target.meta },
        };
      }),
    saveCheckpoint: (checkpoint) =>
      Effect.sync(() => {
        thread(checkpoint.providerThreadId).checkpoint = { ...checkpoint };
      }),
    saveMeta: (meta) =>
      Effect.sync(() => {
        thread(meta.providerThreadId).meta = { ...meta };
      }),
    truncateAfterTurn: ({ providerThreadId, targetTurnCount }) =>
      Effect.sync(() => {
        const target = threads.get(providerThreadId);
        if (target === undefined) return;
        target.records = target.records
          .filter((record) => record.turnIndex < targetTurnCount)
          .map((record, sequence) => ({ ...record, sequence }));
        target.checkpoint = dropCheckpointOutside(
          target.checkpoint,
          new Set(target.records.map((record) => record.id)),
        );
        if (target.meta !== null) {
          target.meta = { ...target.meta, todosJson: null };
        }
      }),
    cloneThread: ({ sourceProviderThreadId, targetProviderThreadId, targetTurnCount }) =>
      Effect.sync(() => {
        const source = threads.get(sourceProviderThreadId);
        if (source === undefined) return;
        const records = source.records
          .filter((record) => targetTurnCount === undefined || record.turnIndex < targetTurnCount)
          .map((record, sequence) => ({
            ...record,
            providerThreadId: targetProviderThreadId,
            sequence,
          }));
        const checkpoint =
          source.checkpoint === null
            ? null
            : {
                ...source.checkpoint,
                providerThreadId: targetProviderThreadId,
              };
        threads.set(targetProviderThreadId, {
          records,
          checkpoint: dropCheckpointOutside(checkpoint, new Set(records.map((r) => r.id))),
          meta:
            source.meta === null
              ? null
              : { ...source.meta, providerThreadId: targetProviderThreadId },
        });
      }),
    deleteThread: (providerThreadId) =>
      Effect.sync(() => {
        threads.delete(providerThreadId);
      }),
  };
};
