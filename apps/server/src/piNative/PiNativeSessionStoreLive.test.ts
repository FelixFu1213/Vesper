import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  PiNativeSessionStore,
  type PersistedTranscriptRecord,
} from "@t3tools/provider-pi-native/server";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runMigrations } from "../persistence/Migrations.ts";
import * as PiNativeSessionStoreLive from "./PiNativeSessionStoreLive.ts";

const testLayer = PiNativeSessionStoreLive.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const record = (
  id: string,
  role: PersistedTranscriptRecord["role"],
  sequence: number,
  turnIndex: number,
): PersistedTranscriptRecord => ({
  id,
  providerThreadId: "thread",
  sequence,
  turnIndex,
  role,
  timestampMs: sequence,
  messageJson:
    role === "system"
      ? JSON.stringify({ role: "system", content: "prompt", timestamp: sequence })
      : JSON.stringify({
          role,
          content: id,
          timestamp: sequence,
          ...(role === "assistant"
            ? {
                api: "openai-responses",
                provider: "openai",
                model: "gpt-5",
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
              }
            : {}),
        }),
  system: role === "system" ? { version: 1, beforeMessageId: null, afterMessageId: null } : null,
});

describe("PiNativeSessionStoreLive", () => {
  it.effect("persists, truncates, clones, and deletes native threads", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* PiNativeSessionStore;
      assert.isTrue(store.durable);

      yield* store.appendRecords({
        providerThreadId: "thread",
        records: [
          record("s1", "system", 0, -1),
          record("u1", "user", 1, 0),
          record("a1", "assistant", 2, 0),
          record("u2", "user", 3, 1),
        ],
      });
      yield* store.saveCheckpoint({
        providerThreadId: "thread",
        throughMessageId: "a1",
        mode: "completed_turn",
        summary: "summary",
        leadingSystemJson: null,
        retainedMessagesJson: "[]",
        summarizedMessageCount: 2,
        chunkCount: 1,
        usedFallback: false,
        createdAtMs: 3,
      });
      yield* store.saveMeta({
        providerThreadId: "thread",
        todosJson: null,
        contextText: "context",
        activatedToolNamesJson: JSON.stringify(["Read"]),
        updatedAtMs: 4,
      });

      const loaded = yield* store.loadThread("thread");
      assert.isNotNull(loaded);
      if (loaded === null) return;
      assert.deepStrictEqual(
        loaded.records.map((row) => row.id),
        ["s1", "u1", "a1", "u2"],
      );
      assert.equal(loaded.checkpoint?.throughMessageId, "a1");
      assert.equal(loaded.meta?.contextText, "context");

      yield* store.truncateAfterTurn({ providerThreadId: "thread", targetTurnCount: 1 });
      const truncated = yield* store.loadThread("thread");
      assert.isNotNull(truncated);
      if (truncated === null) return;
      assert.deepStrictEqual(
        truncated.records.map((row) => row.id),
        ["s1", "u1", "a1"],
      );
      assert.equal(truncated.checkpoint?.throughMessageId, "a1");

      yield* store.cloneThread({
        sourceProviderThreadId: "thread",
        targetProviderThreadId: "fork",
      });
      const forked = yield* store.loadThread("fork");
      assert.isNotNull(forked);
      if (forked === null) return;
      assert.deepStrictEqual(
        forked.records.map((row) => row.providerThreadId),
        ["fork", "fork", "fork"],
      );
      assert.equal(forked.checkpoint?.providerThreadId, "fork");

      yield* store.truncateAfterTurn({ providerThreadId: "thread", targetTurnCount: 0 });
      const emptied = yield* store.loadThread("thread");
      assert.isNotNull(emptied);
      if (emptied === null) return;
      assert.deepStrictEqual(
        emptied.records.map((row) => row.id),
        ["s1"],
      );
      assert.isNull(emptied.checkpoint);

      yield* store.deleteThread("thread");
      assert.isNull(yield* store.loadThread("thread"));
    }).pipe(Effect.provide(testLayer)),
  );
});
