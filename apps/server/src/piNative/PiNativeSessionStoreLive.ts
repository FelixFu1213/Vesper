import {
  PiNativeSessionStore,
  PiNativeSessionStoreError,
  type PersistedCompactionCheckpoint,
  type PersistedThreadMeta,
  type PersistedThreadSnapshot,
  type PersistedTranscriptRecord,
  type PiNativeSessionStoreService,
} from "@t3tools/provider-pi-native/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

const RecordRow = Schema.Struct({
  id: Schema.String,
  sequence: Schema.Number,
  turnIndex: Schema.Number,
  role: Schema.String,
  timestampMs: Schema.Number,
  messageJson: Schema.String,
  systemVersion: Schema.NullOr(Schema.Number),
  systemBeforeMessageId: Schema.NullOr(Schema.String),
  systemAfterMessageId: Schema.NullOr(Schema.String),
});

const CheckpointRow = Schema.Struct({
  throughMessageId: Schema.NullOr(Schema.String),
  mode: Schema.String,
  summary: Schema.String,
  leadingSystemJson: Schema.NullOr(Schema.String),
  retainedMessagesJson: Schema.String,
  summarizedMessageCount: Schema.Number,
  chunkCount: Schema.Number,
  usedFallback: Schema.Number,
  createdAtMs: Schema.Number,
});

const MetaRow = Schema.Struct({
  todosJson: Schema.NullOr(Schema.String),
  contextText: Schema.NullOr(Schema.String),
  activatedToolNamesJson: Schema.String,
  updatedAtMs: Schema.Number,
});

const fail =
  (operation: string) =>
  (cause: unknown): PiNativeSessionStoreError =>
    new PiNativeSessionStoreError({
      detail: `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
    });

const toRecord = (
  providerThreadId: string,
  row: typeof RecordRow.Type,
): PersistedTranscriptRecord => ({
  id: row.id,
  providerThreadId,
  sequence: row.sequence,
  turnIndex: row.turnIndex,
  role: row.role as PersistedTranscriptRecord["role"],
  timestampMs: row.timestampMs,
  messageJson: row.messageJson,
  system:
    row.systemVersion === null
      ? null
      : {
          version: 1,
          beforeMessageId: row.systemBeforeMessageId,
          afterMessageId: row.systemAfterMessageId,
        },
});

const toCheckpoint = (
  providerThreadId: string,
  row: typeof CheckpointRow.Type,
): PersistedCompactionCheckpoint => ({
  providerThreadId,
  throughMessageId: row.throughMessageId,
  mode: row.mode === "active_turn" || row.mode === "fresh_window" ? row.mode : "completed_turn",
  summary: row.summary,
  leadingSystemJson: row.leadingSystemJson,
  retainedMessagesJson: row.retainedMessagesJson,
  summarizedMessageCount: row.summarizedMessageCount,
  chunkCount: row.chunkCount,
  usedFallback: row.usedFallback !== 0,
  createdAtMs: row.createdAtMs,
});

const toMeta = (providerThreadId: string, row: typeof MetaRow.Type): PersistedThreadMeta => ({
  providerThreadId,
  todosJson: row.todosJson,
  contextText: row.contextText,
  activatedToolNamesJson: row.activatedToolNamesJson,
  updatedAtMs: row.updatedAtMs,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRecord = SqlSchema.void({
    Request: Schema.Struct({
      providerThreadId: Schema.String,
      record: Schema.Struct({
        id: Schema.String,
        sequence: Schema.Number,
        turnIndex: Schema.Number,
        role: Schema.String,
        timestampMs: Schema.Number,
        messageJson: Schema.String,
        systemVersion: Schema.NullOr(Schema.Number),
        systemBeforeMessageId: Schema.NullOr(Schema.String),
        systemAfterMessageId: Schema.NullOr(Schema.String),
      }),
    }),
    execute: ({ providerThreadId, record }) =>
      sql`
        INSERT OR IGNORE INTO pi_native_thread_records
          (provider_thread_id, id, sequence, turn_index, role, timestamp_ms, message_json,
           system_version, system_before_message_id, system_after_message_id)
        VALUES
          (${providerThreadId}, ${record.id}, ${record.sequence}, ${record.turnIndex},
           ${record.role}, ${record.timestampMs}, ${record.messageJson}, ${record.systemVersion},
           ${record.systemBeforeMessageId}, ${record.systemAfterMessageId})
      `,
  });

  const selectRecords = SqlSchema.findAll({
    Request: Schema.Struct({ providerThreadId: Schema.String }),
    Result: RecordRow,
    execute: ({ providerThreadId }) =>
      sql`
        SELECT id, sequence, turn_index AS "turnIndex", role, timestamp_ms AS "timestampMs",
               message_json AS "messageJson", system_version AS "systemVersion",
               system_before_message_id AS "systemBeforeMessageId",
               system_after_message_id AS "systemAfterMessageId"
        FROM pi_native_thread_records
        WHERE provider_thread_id = ${providerThreadId}
        ORDER BY sequence
      `,
  });

  const selectCheckpoint = SqlSchema.findAll({
    Request: Schema.Struct({ providerThreadId: Schema.String }),
    Result: CheckpointRow,
    execute: ({ providerThreadId }) =>
      sql`
        SELECT through_message_id AS "throughMessageId", mode, summary,
               leading_system_json AS "leadingSystemJson",
               retained_messages_json AS "retainedMessagesJson",
               summarized_message_count AS "summarizedMessageCount",
               chunk_count AS "chunkCount", used_fallback AS "usedFallback",
               created_at_ms AS "createdAtMs"
        FROM pi_native_checkpoints
        WHERE provider_thread_id = ${providerThreadId}
      `,
  });

  const selectMeta = SqlSchema.findAll({
    Request: Schema.Struct({ providerThreadId: Schema.String }),
    Result: MetaRow,
    execute: ({ providerThreadId }) =>
      sql`
        SELECT todos_json AS "todosJson", context_text AS "contextText",
               activated_tool_names_json AS "activatedToolNamesJson",
               updated_at_ms AS "updatedAtMs"
        FROM pi_native_thread_meta
        WHERE provider_thread_id = ${providerThreadId}
      `,
  });

  const saveCheckpointRow = SqlSchema.void({
    Request: Schema.Struct({
      providerThreadId: Schema.String,
      throughMessageId: Schema.NullOr(Schema.String),
      mode: Schema.String,
      summary: Schema.String,
      leadingSystemJson: Schema.NullOr(Schema.String),
      retainedMessagesJson: Schema.String,
      summarizedMessageCount: Schema.Number,
      chunkCount: Schema.Number,
      usedFallback: Schema.Number,
      createdAtMs: Schema.Number,
    }),
    execute: (row) =>
      sql`
        INSERT INTO pi_native_checkpoints
          (provider_thread_id, through_message_id, mode, summary, leading_system_json,
           retained_messages_json, summarized_message_count, chunk_count, used_fallback,
           created_at_ms)
        VALUES
          (${row.providerThreadId}, ${row.throughMessageId}, ${row.mode}, ${row.summary},
           ${row.leadingSystemJson}, ${row.retainedMessagesJson}, ${row.summarizedMessageCount},
           ${row.chunkCount}, ${row.usedFallback}, ${row.createdAtMs})
        ON CONFLICT (provider_thread_id) DO UPDATE SET
          through_message_id = excluded.through_message_id,
          mode = excluded.mode,
          summary = excluded.summary,
          leading_system_json = excluded.leading_system_json,
          retained_messages_json = excluded.retained_messages_json,
          summarized_message_count = excluded.summarized_message_count,
          chunk_count = excluded.chunk_count,
          used_fallback = excluded.used_fallback,
          created_at_ms = excluded.created_at_ms
      `,
  });

  const saveMetaRow = SqlSchema.void({
    Request: Schema.Struct({
      providerThreadId: Schema.String,
      todosJson: Schema.NullOr(Schema.String),
      contextText: Schema.NullOr(Schema.String),
      activatedToolNamesJson: Schema.String,
      updatedAtMs: Schema.Number,
    }),
    execute: (row) =>
      sql`
        INSERT INTO pi_native_thread_meta
          (provider_thread_id, todos_json, context_text, activated_tool_names_json, updated_at_ms)
        VALUES
          (${row.providerThreadId}, ${row.todosJson}, ${row.contextText},
           ${row.activatedToolNamesJson}, ${row.updatedAtMs})
        ON CONFLICT (provider_thread_id) DO UPDATE SET
          todos_json = excluded.todos_json,
          context_text = excluded.context_text,
          activated_tool_names_json = excluded.activated_tool_names_json,
          updated_at_ms = excluded.updated_at_ms
      `,
  });

  const appendRecords: PiNativeSessionStoreService["appendRecords"] = (input) =>
    sql
      .withTransaction(
        Effect.forEach(
          input.records,
          (record) =>
            insertRecord({
              providerThreadId: input.providerThreadId,
              record: {
                id: record.id,
                sequence: record.sequence,
                turnIndex: record.turnIndex,
                role: record.role,
                timestampMs: record.timestampMs,
                messageJson: record.messageJson,
                systemVersion: record.system?.version ?? null,
                systemBeforeMessageId: record.system?.beforeMessageId ?? null,
                systemAfterMessageId: record.system?.afterMessageId ?? null,
              },
            }),
          { discard: true },
        ),
      )
      .pipe(Effect.mapError(fail("PiNativeSessionStore.appendRecords")));

  const loadThread: PiNativeSessionStoreService["loadThread"] = Effect.fn(
    "PiNativeSessionStore.loadThread",
  )(
    function* (providerThreadId) {
      const [records, checkpoints, metas] = yield* Effect.all([
        selectRecords({ providerThreadId }),
        selectCheckpoint({ providerThreadId }),
        selectMeta({ providerThreadId }),
      ]);
      const checkpoint = checkpoints[0];
      const meta = metas[0];
      if (records.length === 0 && checkpoint === undefined && meta === undefined) return null;
      const snapshot: PersistedThreadSnapshot = {
        providerThreadId,
        records: records.map((row) => toRecord(providerThreadId, row)),
        checkpoint: checkpoint === undefined ? null : toCheckpoint(providerThreadId, checkpoint),
        meta: meta === undefined ? null : toMeta(providerThreadId, meta),
      };
      return snapshot;
    },
    (effect) => effect.pipe(Effect.mapError(fail("PiNativeSessionStore.loadThread"))),
  );

  const saveCheckpoint: PiNativeSessionStoreService["saveCheckpoint"] = (checkpoint) =>
    saveCheckpointRow({
      providerThreadId: checkpoint.providerThreadId,
      throughMessageId: checkpoint.throughMessageId,
      mode: checkpoint.mode,
      summary: checkpoint.summary,
      leadingSystemJson: checkpoint.leadingSystemJson,
      retainedMessagesJson: checkpoint.retainedMessagesJson,
      summarizedMessageCount: checkpoint.summarizedMessageCount,
      chunkCount: checkpoint.chunkCount,
      usedFallback: checkpoint.usedFallback ? 1 : 0,
      createdAtMs: checkpoint.createdAtMs,
    }).pipe(Effect.mapError(fail("PiNativeSessionStore.saveCheckpoint")));

  const saveMeta: PiNativeSessionStoreService["saveMeta"] = (meta) =>
    saveMetaRow({
      providerThreadId: meta.providerThreadId,
      todosJson: meta.todosJson,
      contextText: meta.contextText,
      activatedToolNamesJson: meta.activatedToolNamesJson,
      updatedAtMs: meta.updatedAtMs,
    }).pipe(Effect.mapError(fail("PiNativeSessionStore.saveMeta")));

  const truncateAfterTurn: PiNativeSessionStoreService["truncateAfterTurn"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM pi_native_thread_records
            WHERE provider_thread_id = ${input.providerThreadId}
              AND turn_index >= ${input.targetTurnCount}
          `;
          yield* sql`
            DELETE FROM pi_native_checkpoints
            WHERE provider_thread_id = ${input.providerThreadId}
              AND through_message_id IS NOT NULL
              AND through_message_id NOT IN (
                SELECT id FROM pi_native_thread_records
                WHERE provider_thread_id = ${input.providerThreadId}
              )
          `;
          const remaining = yield* sql<{ readonly id: string }>`
            SELECT id FROM pi_native_thread_records
            WHERE provider_thread_id = ${input.providerThreadId}
            ORDER BY sequence
          `;
          for (const [sequence, row] of remaining.entries()) {
            yield* sql`
              UPDATE pi_native_thread_records SET sequence = ${sequence}
              WHERE provider_thread_id = ${input.providerThreadId} AND id = ${row.id}
            `;
          }
          yield* sql`
            UPDATE pi_native_thread_meta SET todos_json = NULL
            WHERE provider_thread_id = ${input.providerThreadId}
          `;
        }),
      )
      .pipe(Effect.mapError(fail("PiNativeSessionStore.truncateAfterTurn")));

  const cloneThread: PiNativeSessionStoreService["cloneThread"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM pi_native_thread_records
            WHERE provider_thread_id = ${input.targetProviderThreadId}
          `;
          yield* sql`
            DELETE FROM pi_native_checkpoints
            WHERE provider_thread_id = ${input.targetProviderThreadId}
          `;
          yield* sql`
            DELETE FROM pi_native_thread_meta
            WHERE provider_thread_id = ${input.targetProviderThreadId}
          `;
          const sourceRecords = yield* selectRecords({
            providerThreadId: input.sourceProviderThreadId,
          });
          const retained = sourceRecords.filter(
            (record) =>
              input.targetTurnCount === undefined || record.turnIndex < input.targetTurnCount,
          );
          for (const [sequence, record] of retained.entries()) {
            yield* sql`
              INSERT INTO pi_native_thread_records
                (provider_thread_id, id, sequence, turn_index, role, timestamp_ms, message_json,
                 system_version, system_before_message_id, system_after_message_id)
              VALUES
                (${input.targetProviderThreadId}, ${record.id}, ${sequence}, ${record.turnIndex},
                 ${record.role}, ${record.timestampMs}, ${record.messageJson}, ${record.systemVersion},
                 ${record.systemBeforeMessageId}, ${record.systemAfterMessageId})
            `;
          }
          const sourceCheckpoint = (yield* selectCheckpoint({
            providerThreadId: input.sourceProviderThreadId,
          }))[0];
          const retainedIds = new Set(retained.map((record) => record.id));
          if (
            sourceCheckpoint !== undefined &&
            (sourceCheckpoint.throughMessageId === null ||
              retainedIds.has(sourceCheckpoint.throughMessageId))
          ) {
            yield* sql`
              INSERT INTO pi_native_checkpoints
                (provider_thread_id, through_message_id, mode, summary, leading_system_json,
                 retained_messages_json, summarized_message_count, chunk_count, used_fallback,
                 created_at_ms)
              VALUES
                (${input.targetProviderThreadId}, ${sourceCheckpoint.throughMessageId},
                 ${sourceCheckpoint.mode}, ${sourceCheckpoint.summary},
                 ${sourceCheckpoint.leadingSystemJson}, ${sourceCheckpoint.retainedMessagesJson},
                 ${sourceCheckpoint.summarizedMessageCount}, ${sourceCheckpoint.chunkCount},
                 ${sourceCheckpoint.usedFallback}, ${sourceCheckpoint.createdAtMs})
            `;
          }
          const sourceMeta = (yield* selectMeta({
            providerThreadId: input.sourceProviderThreadId,
          }))[0];
          if (sourceMeta !== undefined) {
            yield* sql`
              INSERT INTO pi_native_thread_meta
                (provider_thread_id, todos_json, context_text, activated_tool_names_json,
                 updated_at_ms)
              VALUES
                (${input.targetProviderThreadId}, ${sourceMeta.todosJson},
                 ${sourceMeta.contextText}, ${sourceMeta.activatedToolNamesJson},
                 ${sourceMeta.updatedAtMs})
            `;
          }
        }),
      )
      .pipe(Effect.mapError(fail("PiNativeSessionStore.cloneThread")));

  const deleteThread: PiNativeSessionStoreService["deleteThread"] = (providerThreadId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM pi_native_thread_records
            WHERE provider_thread_id = ${providerThreadId}
          `;
          yield* sql`
            DELETE FROM pi_native_checkpoints
            WHERE provider_thread_id = ${providerThreadId}
          `;
          yield* sql`
            DELETE FROM pi_native_thread_meta
            WHERE provider_thread_id = ${providerThreadId}
          `;
        }),
      )
      .pipe(Effect.mapError(fail("PiNativeSessionStore.deleteThread")));

  return {
    durable: true,
    appendRecords,
    loadThread,
    saveCheckpoint,
    saveMeta,
    truncateAfterTurn,
    cloneThread,
    deleteThread,
  } satisfies PiNativeSessionStoreService;
});

export const layer = Layer.effect(PiNativeSessionStore, make);
