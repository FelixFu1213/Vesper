import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { assert, describe, it } from "@effect/vitest";

import { estimateCjkAwareTextTokens } from "./contextBudget.ts";
import {
  CHECKPOINT_TRUNCATION_MARKER,
  COMPACTION_RETAINED_TAIL_SHAPE,
  isRetainedTailMessage,
  pruneOrphanToolResults,
  replayRetainedTail,
  selectRecentTail,
  stripDanglingToolCalls,
  truncateMessageToTail,
  truncateTextToTokens,
} from "./compactionTail.ts";

const TIMESTAMP = 1_700_000_000_000;

function user(text: string): UserMessage {
  return { role: "user", content: text, timestamp: TIMESTAMP };
}

function assistant(
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: TIMESTAMP,
    ...overrides,
  };
}

function toolResult(id: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text: "result" }],
    isError: false,
    timestamp: TIMESTAMP,
  };
}

function toolCallAssistant(id: string): AssistantMessage {
  return {
    ...assistant([{ type: "toolCall", id, name: "read", arguments: { path: "/tmp/x" } }]),
    stopReason: "toolUse",
  };
}

const roles = (messages: ReadonlyArray<AgentMessage>): string[] =>
  messages.map((message) => message.role);

describe("truncateTextToTokens", () => {
  it("keeps text that fits and cuts dense CJK to the same budget", () => {
    assert.equal(truncateTextToTokens("abcd", 10, "!"), "abcd");

    const text = "你好世界".repeat(100);
    const cut = truncateTextToTokens(text, 60, CHECKPOINT_TRUNCATION_MARKER);
    assert.isTrue(cut.endsWith(CHECKPOINT_TRUNCATION_MARKER));
    assert.isAtMost(
      estimateCjkAwareTextTokens(cut),
      60 + estimateCjkAwareTextTokens(CHECKPOINT_TRUNCATION_MARKER),
    );
    assert.isAbove(estimateCjkAwareTextTokens(cut), 20);
  });

  it("never splits a surrogate pair", () => {
    const cut = truncateTextToTokens("😀".repeat(50), 5, "");
    assert.equal(cut, "😀".repeat(20));
  });
});

describe("truncateMessageToTail", () => {
  it("leaves a message that fits alone", () => {
    const message = user("abcd");
    assert.equal(truncateMessageToTail(message, 100), message);
  });

  it("bounds a long user message and keeps a tool call's identity", () => {
    const bounded = truncateMessageToTail(user("a".repeat(40_000)), 100);
    assert.isAtMost(estimateCjkAwareTextTokens(String(bounded.content)), 200);
    assert.include(String(bounded.content), CHECKPOINT_TRUNCATION_MARKER);

    const withCall = truncateMessageToTail(
      assistant([
        { type: "text", text: "b".repeat(40_000) },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/x" } },
      ]),
      100,
    );
    assert.isTrue(
      withCall.role === "assistant" &&
        withCall.content.some((block) => block.type === "toolCall" && block.id === "call-1"),
    );
  });
});

describe("pruneOrphanToolResults and stripDanglingToolCalls", () => {
  it("drops a result whose call is gone", () => {
    const pruned = pruneOrphanToolResults([
      toolCallAssistant("call-1"),
      toolResult("call-1"),
      toolResult("orphan"),
    ]);

    assert.deepEqual(
      pruned.map((message) => (message.role === "toolResult" ? message.toolCallId : message.role)),
      ["assistant", "call-1"],
    );
  });

  it("strips the calls of an assistant whose results are not retained", () => {
    const stripped = stripDanglingToolCalls(toolCallAssistant("call-1"));

    assert.deepEqual(roles([stripped]), ["assistant"]);
    assert.isFalse(
      stripped.role === "assistant" && stripped.content.some((block) => block.type === "toolCall"),
    );
  });
});

describe("selectRecentTail", () => {
  it("keeps the newest contiguous run that fits", () => {
    const messages: AgentMessage[] = [
      user("old"),
      assistant([{ type: "text", text: "old answer" }]),
      user("new"),
      assistant([{ type: "text", text: "new answer" }]),
    ];

    const tail = selectRecentTail(messages, 4);
    assert.deepEqual(roles(tail), ["user", "assistant"]);
    assert.equal(tail.at(0)?.role === "user" ? tail.at(0)?.content : "", "new");
  });

  it("always keeps the newest message even when it alone crosses the budget", () => {
    const tail = selectRecentTail([user("a".repeat(40_000))], 100);

    assert.lengthOf(tail, 1);
    assert.include(String(tail[0]?.content), CHECKPOINT_TRUNCATION_MARKER);
  });

  it("keeps the active goal ahead of the window", () => {
    const messages: AgentMessage[] = [
      user("the active goal"),
      assistant([{ type: "text", text: "a".repeat(4_000) }]),
    ];

    const withoutGoal = selectRecentTail(messages, 100);
    assert.deepEqual(roles(withoutGoal), ["assistant"]);

    const withGoal = selectRecentTail(messages, 100, { latestUserGoal: true });
    assert.deepEqual(roles(withGoal), ["user", "assistant"]);
  });

  it("skips messages a provider would drop and prunes what they orphan", () => {
    const tail = selectRecentTail(
      [
        assistant([{ type: "text", text: "failed" }], { stopReason: "error" }),
        toolResult("orphan"),
        assistant([{ type: "text", text: "kept" }]),
      ],
      100_000,
    );

    assert.deepEqual(roles(tail), ["assistant"]);
  });

  it("never installs an empty tail", () => {
    const tail = selectRecentTail([toolResult("orphan")], 100);
    assert.lengthOf(tail, 0);

    const withUser = selectRecentTail([toolResult("orphan"), user("goal")], 100);
    assert.deepEqual(roles(withUser), ["user"]);
  });
});

describe("replayRetainedTail", () => {
  it("replays a valid window and drops what the provider cannot carry", () => {
    const replayed = replayRetainedTail([
      { role: "assistant", content: [{ type: "text", text: "a" }], timestamp: 5 },
      toolResult("orphan"),
      { role: "user", content: "goal" },
      { role: "system", content: "not a tail message" },
      { role: "toolResult", content: [], timestamp: 1 },
    ]);

    assert.isDefined(replayed);
    assert.deepEqual(roles(replayed ?? []), ["assistant", "user"]);
    assert.equal((replayed ?? [])[0]?.timestamp, 5);
  });

  it("gives a replayed message without a timestamp a stable one", () => {
    const replayed = replayRetainedTail([{ role: "user", content: "goal" }]);
    assert.equal((replayed ?? [])[0]?.timestamp, 0);
  });

  it("rejects a value that is not a tail", () => {
    assert.isUndefined(replayRetainedTail("nope"));
    assert.isFalse(isRetainedTailMessage({ role: "assistant", content: 7 }));
  });
});

describe("COMPACTION_RETAINED_TAIL_SHAPE", () => {
  it("marks the real recent window", () => {
    assert.equal(COMPACTION_RETAINED_TAIL_SHAPE, "recent_window");
  });
});
