import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { assert, describe, it } from "@effect/vitest";

import type {
  PersistedCompactionCheckpoint,
  PersistedThreadSnapshot,
  PersistedTranscriptRecord,
} from "./sessionStore.ts";
import { restoreTranscript } from "./transcriptRecovery.ts";

const timestamp = 1_000;

const usage = () => ({
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistant = (_id: string, content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-responses",
  provider: "openai" as never,
  model: "gpt-5",
  usage: usage(),
  stopReason: "toolUse",
  timestamp,
});

const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp });

const toolResult = (
  toolCallId: string,
  toolName = "Read",
  content: ToolResultMessage["content"] = [{ type: "text", text: "ok" }],
): ToolResultMessage => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content,
  isError: false,
  timestamp,
});

const row = (id: string, message: AgentMessage, sequence: number): PersistedTranscriptRecord => ({
  id,
  providerThreadId: "thread",
  sequence,
  turnIndex: 0,
  role: message.role,
  timestampMs: message.timestamp,
  messageJson: JSON.stringify(message),
  system: null,
});

const snapshot = (
  records: readonly PersistedTranscriptRecord[],
  options?: {
    readonly checkpoint?: PersistedCompactionCheckpoint | null;
    readonly meta?: PersistedThreadSnapshot["meta"];
  },
): PersistedThreadSnapshot => ({
  providerThreadId: "thread",
  records,
  checkpoint: options?.checkpoint ?? null,
  meta: options?.meta ?? null,
});

const model = { api: "openai-responses" as const, provider: "openai" as never, model: "gpt-5" };

describe("restoreTranscript", () => {
  it("keeps tool pairs, thinking signatures, and results", async () => {
    const call = {
      type: "toolCall" as const,
      id: "call-1",
      name: "Read",
      arguments: { path: "a.txt" },
    };
    const restored = await restoreTranscript({
      snapshot: snapshot([
        row("u1", user("read it"), 0),
        row(
          "a1",
          assistant("call-1", [
            { type: "thinking", thinking: "considering", thinkingSignature: "sig", redacted: true },
            call,
          ]),
          1,
        ),
        row("r1", toolResult("call-1"), 2),
      ]),
      model,
      now: timestamp,
    });
    assert.lengthOf(restored.messages, 3);
    const assistantMessage = restored.messages[1] as AssistantMessage;
    assert.deepStrictEqual(assistantMessage.content[0], {
      type: "thinking",
      thinking: "considering",
      thinkingSignature: "sig",
      redacted: true,
    });
    assert.deepStrictEqual(assistantMessage.content[1], call);
    assert.equal((restored.messages[2] as ToolResultMessage).toolCallId, "call-1");
  });

  it("synthesizes an error result for a call a crash left pending", async () => {
    const restored = await restoreTranscript({
      snapshot: snapshot([
        row(
          "a1",
          assistant("call-1", [
            { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
            { type: "toolCall", id: "call-2", name: "Bash", arguments: {} },
          ]),
          0,
        ),
        row("r1", toolResult("call-1"), 1),
      ]),
      model,
      now: timestamp,
    });
    const synthesized = restored.messages.at(-1) as ToolResultMessage;
    assert.equal(synthesized.toolCallId, "call-2");
    assert.isTrue(synthesized.isError);
  });

  it("gives a result with no assistant row a call-only carrier", async () => {
    const restored = await restoreTranscript({
      snapshot: snapshot([row("r1", toolResult("lost-call"), 0)]),
      model,
      now: timestamp,
    });
    assert.lengthOf(restored.messages, 2);
    const carrier = restored.messages[0] as AssistantMessage;
    assert.equal(carrier.role, "assistant");
    assert.deepStrictEqual(carrier.content[0], {
      type: "toolCall",
      id: "lost-call",
      name: "Read",
      arguments: {},
    });
  });

  it("clears pre-compaction usage and keeps rows after the checkpoint boundary", async () => {
    const retained = assistant("retained", [{ type: "text", text: "kept" }]);
    const checkpoint: PersistedCompactionCheckpoint = {
      providerThreadId: "thread",
      throughMessageId: "a1",
      mode: "completed_turn",
      summary: "<compaction_summary>done</compaction_summary>",
      leadingSystemJson: JSON.stringify({ role: "system", content: "base", timestamp }),
      retainedMessagesJson: JSON.stringify([retained]),
      summarizedMessageCount: 2,
      chunkCount: 1,
      usedFallback: false,
      createdAtMs: timestamp,
    };
    const restored = await restoreTranscript({
      snapshot: snapshot(
        [row("u1", user("old"), 0), row("a1", retained, 1), row("u2", user("new"), 2)],
        { checkpoint },
      ),
      model,
      now: timestamp,
    });
    assert.isTrue(restored.checkpoint);
    assert.lengthOf(restored.messages, 3);
    const kept = restored.messages[1] as AssistantMessage;
    assert.equal(kept.usage.input, 0);
    assert.equal(kept.usage.output, 0);
    assert.equal((restored.messages[2] as UserMessage).content, "new");
  });

  it("degrades missing and oversized image refs to placeholder notes", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const wideHeader = Buffer.alloc(33);
    png.copy(wideHeader, 0, 0, 8);
    wideHeader.writeUInt32BE(13, 8);
    wideHeader.write("IHDR", 12, "ascii");
    wideHeader.writeUInt32BE(9_000, 16);
    wideHeader.writeUInt32BE(10, 20);
    const image = (ref: string) => ({
      type: "image" as const,
      data: "",
      mimeType: "image/png",
      ref,
    });
    const restored = await restoreTranscript({
      snapshot: snapshot([
        row(
          "u1",
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              image("ok"),
              image("huge"),
              image("wide"),
              image("missing"),
            ],
            timestamp,
          },
          0,
        ),
      ]),
      model,
      now: timestamp,
      readImage: async (ref) => {
        if (ref === "ok") return { sizeBytes: png.byteLength, bytes: png };
        if (ref === "huge") return { sizeBytes: 10_000_001 };
        if (ref === "wide") return { sizeBytes: wideHeader.byteLength, bytes: wideHeader };
        return null;
      },
    });
    const content = (restored.messages[0] as UserMessage).content;
    assert.isTrue(Array.isArray(content));
    if (!Array.isArray(content)) return;
    assert.equal(content[1]?.type, "image");
    assert.equal(content[2]?.type, "text");
    assert.equal(content[3]?.type, "text");
    assert.equal(content[4]?.type, "text");
    assert.match((content[2] as { text: string }).text, /10 MiB/u);
    assert.match((content[3] as { text: string }).text, /8000 px/u);
    assert.match((content[4] as { text: string }).text, /unavailable/u);
  });

  it("restores todos and activated tool names from metadata", async () => {
    const restored = await restoreTranscript({
      snapshot: snapshot(
        [
          row("u1", user("todo"), 0),
          row(
            "r1",
            {
              ...toolResult("todo-1", "TodoWrite"),
              details: {
                revision: 3,
                steps: [{ id: "1", text: "ship", status: "completed" }],
              },
            },
            1,
          ),
        ],
        {
          meta: {
            providerThreadId: "thread",
            todosJson: JSON.stringify({
              revision: 4,
              steps: [{ id: "2", text: "verify", status: "running" }],
            }),
            contextText: "context",
            activatedToolNamesJson: JSON.stringify(["Read", "Bash"]),
            updatedAtMs: timestamp,
          },
        },
      ),
      model,
      now: timestamp,
    });
    assert.equal(restored.todos.revision, 4);
    assert.deepStrictEqual(restored.activatedToolNames, ["Read", "Bash"]);
    assert.equal(restored.todos.steps[0]?.text, "verify");
  });
});
