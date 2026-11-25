import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { assert, describe, it } from "@effect/vitest";

import { estimateAgentMessagesTokens } from "./contextBudget.ts";
import {
  buildCompactionCheckpoint,
  buildRetainedTailFallback,
  compactSubagentMessages,
  installCompactionCheckpoint,
  renderCompactionSummary,
  sanitizeRetainedMessages,
  SUBAGENT_CONTEXT_OVERFLOW,
  type CompactedSubagentContext,
  type CompactionSummarySections,
  type SubagentContextUpdate,
} from "./compaction.ts";

const TIMESTAMP = 1_700_000_000_000;
const MODEL = { contextWindow: 100_000, maxTokens: 8_000 };

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

function textAssistant(text: string): AssistantMessage {
  return assistant([{ type: "text", text }]);
}

function toolCallAssistant(id: string, name = "read"): AssistantMessage {
  return {
    ...assistant([{ type: "toolCall", id, name, arguments: { path: "/tmp/x" } }]),
    stopReason: "toolUse",
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

function systemMessage(content: string): AgentMessage {
  return { role: "system", content, timestamp: TIMESTAMP };
}

const SUMMARY: CompactionSummarySections = {
  goals: "ship compaction",
  progress: "wrote the module",
  files: "compaction.ts",
  decisions: "summaries stay in the system prompt",
  nextSteps: "write tests",
};

describe("renderCompactionSummary", () => {
  it("renders the structured block and fills empty sections", () => {
    const rendered = renderCompactionSummary({ ...SUMMARY, files: "" });

    assert.isTrue(rendered.startsWith("<compaction_summary>"));
    assert.include(rendered, "## Goals\nship compaction");
    assert.include(rendered, "## Files\n(none recorded)");
    assert.include(rendered, "## Next Steps\nwrite tests");
    assert.isTrue(rendered.endsWith("</compaction_summary>"));
  });
});

describe("buildCompactionCheckpoint", () => {
  it("summarizes older turns and keeps the pinned recent ones", async () => {
    const messages: AgentMessage[] = [
      systemMessage("base prompt"),
      user("first question"),
      textAssistant("first answer"),
      user("second question"),
      textAssistant("second answer"),
    ];

    const checkpoint = await buildCompactionCheckpoint({
      messages,
      mode: "completed_turn",
      model: MODEL,
      timestamp: TIMESTAMP,
      pinnedRecentTurns: 1,
      summarizeFn: () => SUMMARY,
    });

    assert.equal(checkpoint.usedFallback, false);
    assert.equal(checkpoint.chunkCount, 1);
    assert.equal(checkpoint.summarizedMessageCount, 2);
    assert.equal(checkpoint.leadingSystem?.content, "base prompt");
    assert.include(checkpoint.summary, "## Goals");
    assert.deepEqual(
      checkpoint.retainedMessages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.equal(
      checkpoint.retainedMessages[0]?.role === "user"
        ? checkpoint.retainedMessages[0].content
        : undefined,
      "second question",
    );
  });

  it("chunks oversized histories without splitting a tool call from its results", async () => {
    const messages: AgentMessage[] = [systemMessage("base")];
    for (let turn = 0; turn < 6; turn += 1) {
      messages.push(user(`question ${turn} ${"x".repeat(400)}`));
      messages.push(toolCallAssistant(`call-${turn}`));
      messages.push(toolResult(`call-${turn}`));
      messages.push(toolResult(`call-${turn}`));
      messages.push(textAssistant(`answer ${turn} ${"y".repeat(400)}`));
    }

    const requests: Array<{ readonly firstRole: string; readonly count: number }> = [];
    const checkpoint = await buildCompactionCheckpoint({
      messages,
      mode: "completed_turn",
      model: MODEL,
      timestamp: TIMESTAMP,
      maxChunkTokens: 400,
      summarizeFn: (request) => {
        requests.push({
          firstRole: request.messages[0]?.role ?? "none",
          count: request.messages.length,
        });
        return { ...SUMMARY, progress: `chunk ${request.chunkIndex}/${request.chunkCount}` };
      },
    });

    assert.isAbove(checkpoint.chunkCount, 1);
    assert.equal(checkpoint.chunkCount, requests.length);
    for (const request of requests) {
      assert.notEqual(request.firstRole, "toolResult");
    }
    assert.include(checkpoint.summary, "chunk 2/");
  });

  it("retains the in-flight turn in active_turn mode", async () => {
    const messages: AgentMessage[] = [
      systemMessage("base"),
      user("done question"),
      textAssistant("done answer"),
      user("running question"),
      toolCallAssistant("call-live"),
      toolResult("call-live"),
    ];

    const checkpoint = await buildCompactionCheckpoint({
      messages,
      mode: "active_turn",
      model: MODEL,
      timestamp: TIMESTAMP,
      summarizeFn: () => SUMMARY,
    });

    assert.equal(checkpoint.summarizedMessageCount, 2);
    assert.deepEqual(
      checkpoint.retainedMessages.map((message) => message.role),
      ["user", "assistant", "toolResult"],
    );
    assert.include(checkpoint.summary, "ship compaction");
  });

  it("falls back to the newest complete turns when the summarizer fails", async () => {
    const messages: AgentMessage[] = [systemMessage("base")];
    for (let turn = 0; turn < 12; turn += 1) {
      messages.push(user(`question ${turn}`));
      messages.push(textAssistant(`answer ${turn} ${"z".repeat(4_500)}`));
    }

    const checkpoint = await buildCompactionCheckpoint({
      messages,
      mode: "completed_turn",
      model: { contextWindow: 20_000, maxTokens: 4_000 },
      timestamp: TIMESTAMP,
      summarizeFn: () => {
        throw new Error("summarizer offline");
      },
    });

    assert.equal(checkpoint.usedFallback, true);
    assert.equal(checkpoint.summary, "");
    assert.isAbove(checkpoint.retainedMessages.length, 0);
    assert.isBelow(checkpoint.retainedMessages.length, messages.length - 1);
    const newestUser = checkpoint.retainedMessages
      .filter((message) => message.role === "user")
      .at(-1);
    assert.equal(newestUser?.role === "user" ? newestUser.content : undefined, "question 11");
  });

  it("drops failed, orphaned, and incomplete messages in the retained tail", () => {
    const fallback = buildRetainedTailFallback({
      messages: [
        systemMessage("base"),
        user("keep me"),
        assistant([{ type: "text", text: "failed" }], { stopReason: "error" }),
        assistant([{ type: "text", text: "aborted" }], { stopReason: "aborted" }),
        toolCallAssistant("call-complete"),
        toolResult("call-complete"),
        toolCallAssistant("call-incomplete"),
        toolResult("orphan"),
        assistant([
          { type: "thinking", thinking: "secret", thinkingSignature: "sig-1" },
          { type: "text", text: "kept" },
        ]),
      ],
      budgetTokens: 100_000,
      timestamp: TIMESTAMP,
    });

    const retained = fallback.retainedMessages;
    const roles = retained.map((message) => message.role);
    assert.deepEqual(roles, ["user", "assistant", "toolResult", "assistant"]);

    const thinking = retained[3];
    assert.equal(thinking?.role, "assistant");
    const thinkingBlock = thinking?.role === "assistant" ? thinking.content[0] : undefined;
    assert.equal(thinkingBlock?.type, "thinking");
    if (thinkingBlock?.type === "thinking") {
      assert.isUndefined(thinkingBlock.thinkingSignature);
    }

    const incomplete = retained.filter(
      (message) =>
        message.role === "assistant" &&
        message.content.some(
          (block) => block.type === "toolCall" && block.id === "call-incomplete",
        ),
    );
    assert.equal(incomplete.length, 0);
  });

  it("keeps the checkpoint under the hard limit by trimming the retained tail", async () => {
    const messages: AgentMessage[] = [
      systemMessage("base"),
      user("old question"),
      textAssistant("old answer"),
      user("new question"),
      textAssistant("n".repeat(8_000)),
    ];
    const model = { contextWindow: 4_000, maxTokens: 1_000 };

    const checkpoint = await buildCompactionCheckpoint({
      messages,
      mode: "completed_turn",
      model,
      timestamp: TIMESTAMP,
      pinnedRecentTurns: 1,
      summarizeFn: () => SUMMARY,
    });

    const installed = installCompactionCheckpoint(messages, checkpoint);
    assert.isBelow(estimateAgentMessagesTokens(installed), 2_000);
    assert.deepEqual(checkpoint.retainedMessages, []);
  });

  it("fails cleanly when nothing can bring the transcript under the limit", async () => {
    const messages: AgentMessage[] = [systemMessage("p".repeat(20_000)), user("hi")];
    const failure = await buildCompactionCheckpoint({
      messages,
      mode: "completed_turn",
      model: { contextWindow: 2_000, maxTokens: 100 },
      timestamp: TIMESTAMP,
    }).then(
      () => null,
      (cause: unknown) => cause,
    );

    assert.isNotNull(failure);
    assert.equal((failure as { _tag?: string })._tag, "CompactionBudgetError");
    assert.include((failure as Error).message, "cannot be compacted");
  });
});

describe("sanitizeRetainedMessages", () => {
  it("keeps complete tool groups and strips replay-only thinking signatures", () => {
    const messages: AgentMessage[] = [
      toolCallAssistant("call-1"),
      toolResult("call-1"),
      assistant([{ type: "thinking", thinking: "x", thinkingSignature: "sig" }]),
    ];

    const sanitized = sanitizeRetainedMessages(messages);
    assert.equal(sanitized.length, 3);
    const thinking = sanitized[2];
    assert.equal(thinking?.role, "assistant");
    const block = thinking?.role === "assistant" ? thinking.content[0] : undefined;
    assert.equal(block?.type, "thinking");
    if (block?.type === "thinking") assert.isUndefined(block.thinkingSignature);
  });
});

describe("installCompactionCheckpoint", () => {
  it("merges system deltas and places the summary in the leading prompt", async () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "base", sections: { runtime: "r1" }, timestamp: TIMESTAMP },
      user("question"),
      textAssistant("answer"),
    ];
    const checkpoint = await buildCompactionCheckpoint({
      messages,
      mode: "completed_turn",
      model: MODEL,
      timestamp: TIMESTAMP,
      summarizeFn: () => SUMMARY,
    });

    const withDelta: AgentMessage[] = [
      ...messages,
      {
        role: "system",
        content: "",
        sections: { context: "thread context" },
        timestamp: TIMESTAMP,
      },
    ];
    const installed = installCompactionCheckpoint(withDelta, checkpoint);

    const leading = installed[0];
    assert.equal(leading?.role, "system");
    const leadingText = leading?.role === "system" ? contentText(leading.content) : "";
    assert.include(leadingText, "base");
    assert.include(leadingText, "<compaction_summary>");
    assert.deepEqual(leading?.role === "system" ? leading.sections : undefined, {
      runtime: "r1",
      context: "thread context",
    });
    assert.equal(installed.length, 1);
  });
});

describe("compaction checkpoint provenance", () => {
  it("records the message it folded behind and the shape of its tail", async () => {
    const messages: AgentMessage[] = [
      systemMessage("base prompt"),
      user("first question"),
      textAssistant("first answer"),
      user("second question"),
      textAssistant("second answer"),
    ];

    const checkpoint = await buildCompactionCheckpoint({
      messages,
      mode: "completed_turn",
      model: MODEL,
      timestamp: TIMESTAMP,
      pinnedRecentTurns: 1,
      summarizeFn: () => SUMMARY,
    });

    assert.equal(checkpoint.throughMessageId, `message-1-assistant-${TIMESTAMP}`);
    assert.isNull(checkpoint.retainedTailShape);
    assert.isNull(checkpoint.failureReason);
    assert.equal(checkpoint.beforeTokens, estimateAgentMessagesTokens(messages));
    assert.equal(
      checkpoint.afterTokens,
      estimateAgentMessagesTokens(installCompactionCheckpoint(messages, checkpoint)),
    );
  });

  it("records why a failed summarizer was abandoned and marks the replay shape", async () => {
    const messages: AgentMessage[] = [systemMessage("base"), user("q"), textAssistant("a")];

    const checkpoint = await buildCompactionCheckpoint({
      messages,
      mode: "completed_turn",
      model: MODEL,
      timestamp: TIMESTAMP,
      summarizeFn: () => {
        throw new Error("summarizer offline");
      },
    });

    assert.equal(checkpoint.failureReason, "summarizer offline");
    assert.isTrue(checkpoint.usedFallback);
    assert.equal(checkpoint.retainedTailShape, "recent_window");
    // A replayed recent-window tail is validated, not trusted by shape alone.
    assert.isAbove(installCompactionCheckpoint(messages, checkpoint).length, 0);
  });

  it("starts a fresh window without a summary and keeps only the active goal", async () => {
    const messages: AgentMessage[] = [
      systemMessage("base prompt"),
      user("old question"),
      textAssistant("old answer"),
      user("new question"),
    ];

    const checkpoint = await buildCompactionCheckpoint({
      messages,
      mode: "fresh_window",
      model: MODEL,
      timestamp: TIMESTAMP,
      summarizeFn: () => SUMMARY,
    });

    assert.equal(checkpoint.summary, "");
    assert.equal(checkpoint.chunkCount, 0);
    assert.isFalse(checkpoint.usedFallback);
    assert.isNull(checkpoint.throughMessageId);
    assert.deepEqual(
      checkpoint.retainedMessages.map((message) => message.role),
      ["user"],
    );
    assert.equal(
      checkpoint.retainedMessages[0]?.role === "user"
        ? checkpoint.retainedMessages[0].content
        : undefined,
      "new question",
    );
  });
});

const requireContext = (update: SubagentContextUpdate): CompactedSubagentContext => {
  if (update.status === "overflow") throw new Error(`unexpected overflow: ${update.message}`);
  return update;
};

describe("compactSubagentMessages", () => {
  const WIDE = { ...MODEL, id: "wide-model" };
  const NARROW = { contextWindow: 4_000, maxTokens: 1_000, id: "narrow-model" };

  it("leaves a delegate below the automatic trigger alone", () => {
    const messages: AgentMessage[] = [user("short task")];
    const update = compactSubagentMessages({
      messages,
      model: WIDE,
      taskBrief: "short task",
      mode: "completed_turn",
      timestamp: TIMESTAMP,
    });

    assert.equal(update.status, "unchanged");
    assert.deepEqual(requireContext(update).messages, messages);
  });

  it("retains the newest recent window instead of a summary it cannot build", () => {
    const messages: AgentMessage[] = [user("a".repeat(4 * 80_000)), textAssistant("acknowledged")];
    const update = compactSubagentMessages({
      messages,
      model: WIDE,
      taskBrief: "the delegated task",
      mode: "active_turn",
      timestamp: TIMESTAMP,
    });

    assert.equal(update.status, "compacted");
    const context = requireContext(update);
    assert.isBelow(context.afterTokens, context.beforeTokens);
    assert.isTrue(context.messages.some((message) => message.role === "user"));
  });

  it("falls back to the brief plus the newest messages when the window is narrow", () => {
    const messages: AgentMessage[] = [
      systemMessage("s".repeat(4 * 1_500)),
      user("g".repeat(4 * 2_000)),
      textAssistant("a".repeat(4 * 2_000)),
    ];
    const update = compactSubagentMessages({
      messages,
      model: NARROW,
      taskBrief: "the delegated task",
      mode: "completed_turn",
      timestamp: TIMESTAMP,
    });

    assert.equal(update.status, "degraded");
    assert.deepEqual(
      requireContext(update).messages.map((message) => message.role),
      ["system", "user"],
    );
  });

  it("reports the structured overflow when even the system prompt cannot fit", () => {
    const messages: AgentMessage[] = [systemMessage("s".repeat(4 * 2_500)), user("task")];
    const update = compactSubagentMessages({
      messages,
      model: NARROW,
      taskBrief: "the delegated task",
      mode: "completed_turn",
      timestamp: TIMESTAMP,
    });

    assert.equal(update.status, "overflow");
    assert.equal(update.status === "overflow" ? update.code : "", SUBAGENT_CONTEXT_OVERFLOW);
    assert.include(update.status === "overflow" ? update.message : "", "narrow-model");
  });
});
