import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { assert, describe, it } from "@effect/vitest";

import {
  computeContextBudget,
  ContextBudgetReminderTracker,
  contextReminderThreshold,
  estimateAgentMessagesTokens,
  estimateAgentMessageTokens,
  estimateCjkAwareTextTokens,
  evaluateContextPressure,
  projectContextRequest,
} from "./contextBudget.ts";
import { ContextEstimateCalibration } from "./contextCalibration.ts";

const MODEL = { contextWindow: 200_000, maxTokens: 8_000 };

function user(text: string): UserMessage {
  return { role: "user", content: text, timestamp: 1 };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
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
    timestamp: 1,
  };
}

describe("computeContextBudget", () => {
  it("reserves the largest of the three reserve rules", () => {
    const budget = computeContextBudget(MODEL);

    assert.equal(budget.reserveTokens, 16_384);
    assert.equal(budget.hardLimit, 183_616);
    assert.equal(budget.autoCompactThreshold, Math.floor(183_616 * 0.9));
    assert.equal(budget.warningThreshold, Math.floor(183_616 * 0.75));
  });

  it("keeps a small window usable and never drops below the floor", () => {
    const budget = computeContextBudget({ contextWindow: 8_000, maxTokens: 4_000 });

    assert.equal(budget.reserveTokens, 4_000);
    assert.equal(budget.hardLimit, 4_000);
    assert.equal(budget.autoCompactThreshold, 3_600);
    assert.equal(budget.warningThreshold, 3_000);

    const tiny = computeContextBudget({ contextWindow: 1_000, maxTokens: 100 });
    assert.equal(tiny.hardLimit, 1_024);
  });
});

describe("estimateCjkAwareTextTokens", () => {
  it("estimates dense CJK text at about 1.5 tokens per character", () => {
    assert.equal(estimateCjkAwareTextTokens("你好世界"), 6);
    assert.equal(estimateCjkAwareTextTokens("こんにちは"), 8);
    assert.equal(estimateCjkAwareTextTokens("안녕하세요"), 8);
  });

  it("estimates Latin text at four characters per token", () => {
    assert.equal(estimateCjkAwareTextTokens("abcd"), 1);
    assert.equal(estimateCjkAwareTextTokens("a".repeat(41)), 11);
    assert.equal(estimateCjkAwareTextTokens(""), 0);
  });

  it("mixes both scripts instead of averaging them", () => {
    assert.equal(estimateCjkAwareTextTokens("你好abcd"), 3 + 1);
  });
});

describe("estimateAgentMessageTokens", () => {
  it("counts text, thinking, tool calls, and sections", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "abcd", sections: { runtime: "efgh" }, timestamp: 1 },
      user("abcd"),
      assistant([
        { type: "text", text: "abcd" },
        { type: "thinking", thinking: "abcd" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/x" } },
      ]),
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "abcd" }],
        isError: false,
        timestamp: 1,
      },
      {
        role: "user",
        content: [{ type: "image", data: "base64", mimeType: "image/png" }],
        timestamp: 1,
      },
    ];

    // 1 for the text, 2 for the "runtime" name, 1 for the section text.
    assert.equal(estimateAgentMessageTokens(messages[0] as AgentMessage), 4);
    assert.equal(estimateAgentMessageTokens(messages[1] as AgentMessage), 1);
    // 1 text + 1 thinking + 1 tool name + 5 for the JSON arguments.
    assert.equal(estimateAgentMessageTokens(messages[2] as AgentMessage), 8);
    assert.equal(estimateAgentMessageTokens(messages[3] as AgentMessage), 1 + 1);
    assert.equal(estimateAgentMessageTokens(messages[4] as AgentMessage), 1_600);
    assert.equal(
      estimateAgentMessagesTokens(messages),
      messages.reduce((total, message) => total + estimateAgentMessageTokens(message), 0),
    );
  });
});

describe("projectContextRequest", () => {
  it("charges system, tools, and messages, and anchors on the newest usage block", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "abcd", timestamp: 1 },
      {
        ...assistant([{ type: "text", text: "abcd" }]),
        usage: { ...assistant([]).usage, input: 400, totalTokens: 400 },
      },
      user("abcd"),
    ];
    const projection = projectContextRequest(messages, [
      { name: "read", description: "abcd", parameters: { type: "object" } },
    ]);

    assert.equal(projection.cost.systemTokens, 1);
    assert.equal(projection.cost.messageTokens, 2);
    assert.isAbove(projection.cost.toolTokens, 0);
    assert.equal(
      projection.cost.totalTokens,
      projection.cost.systemTokens + projection.cost.toolTokens + projection.cost.messageTokens,
    );
    // The anchor's own usage stands in for the prefix; only the tail is estimated.
    assert.equal(projection.calibration.lastUsageIndex, 1);
    assert.equal(projection.calibration.usageTokens, 400);
    assert.equal(projection.calibration.trailingTokens, 1);
    assert.isAtLeast(projection.calibration.tokens, projection.calibration.usageTokens);
  });

  it("reports no anchor when the transcript carries no usable usage", () => {
    const projection = projectContextRequest([user("abcd")], []);

    assert.isNull(projection.calibration.lastUsageIndex);
    assert.equal(projection.calibration.trailingTokens, 0);
    assert.equal(projection.calibration.tokens, 1);
  });
});

describe("ContextBudgetReminderTracker", () => {
  it("clamps the approach threshold between 8k and 32k", () => {
    assert.equal(contextReminderThreshold(10_000), 8_000);
    assert.equal(contextReminderThreshold(200_000), 30_000);
    assert.equal(contextReminderThreshold(1_000_000), 32_000);
  });

  it("emits each stage at most once per checkpoint window", () => {
    const tracker = new ContextBudgetReminderTracker();
    const input = { hardLimit: 200_000, midConversationSystem: true };

    const approach = tracker.select({ ...input, remainingTokens: 25_000 });
    assert.equal(approach?.stage, "approach");
    assert.equal(approach?.role, "system");
    assert.isUndefined(tracker.select({ ...input, remainingTokens: 20_000 }));

    const fallback = tracker.select({ ...input, remainingTokens: 1_500 });
    assert.equal(fallback?.stage, "fallback");
    assert.isUndefined(tracker.select({ ...input, remainingTokens: 1_000 }));

    tracker.reset();
    assert.equal(tracker.select({ ...input, remainingTokens: 25_000 })?.stage, "approach");
  });

  it("falls back to a synthetic user reminder without mid-conversation system support", () => {
    const tracker = new ContextBudgetReminderTracker();
    const reminder = tracker.select({
      remainingTokens: 25_000,
      hardLimit: 200_000,
      midConversationSystem: false,
    });

    assert.equal(reminder?.role, "user");
    assert.include(reminder?.text ?? "", "<context_budget>");
  });
});

describe("evaluateContextPressure", () => {
  it("reports approaching and critical levels against the budget", () => {
    const budget = computeContextBudget({ contextWindow: 4_000, maxTokens: 1_000 });
    const messages: AgentMessage[] = [user("a".repeat(1_900 * 4))];

    const approaching = evaluateContextPressure({
      messages,
      model: { contextWindow: 4_000, maxTokens: 1_000, api: "openai-responses" },
    });

    assert.isTrue(approaching.shouldCompact);
    assert.equal(approaching.warningLevel, "approaching");
    assert.equal(approaching.rawTokens, 1_900);
    assert.equal(approaching.remainingTokens, budget.hardLimit - 1_900);

    const critical = evaluateContextPressure({
      messages: [user("a".repeat(4_000 * 4))],
      model: { contextWindow: 4_000, maxTokens: 1_000, api: "openai-responses" },
    });
    assert.equal(critical.warningLevel, "critical");
    assert.equal(critical.remainingTokens, 0);
    assert.isTrue(critical.shouldCompact);
  });

  it("counts advertised tool schemas in the request floor", () => {
    const model = { contextWindow: 200_000, maxTokens: 8_000, api: "openai-responses" as const };
    const withoutTools = evaluateContextPressure({ messages: [user("abcd")], model });
    const withTools = evaluateContextPressure({
      messages: [user("abcd")],
      model,
      tools: [{ name: "read", description: "Read a file.", parameters: { type: "object" } }],
    });

    assert.equal(withoutTools.requestCost.toolTokens, 0);
    assert.isAbove(withTools.requestCost.toolTokens, 0);
    assert.isAbove(withTools.rawTokens, withoutTools.rawTokens);
  });

  it("applies the learned calibration to the calibrated estimate", () => {
    const calibration = new ContextEstimateCalibration();
    for (let sample = 0; sample < 3; sample += 1) {
      calibration.recordAnchored(1_000, 500, 2_000);
    }
    const pressure = evaluateContextPressure({
      messages: [user("a".repeat(1_500 * 4))],
      model: { ...MODEL, api: "openai-responses" },
      calibration,
    });

    assert.equal(pressure.rawTokens, 1_500);
    assert.equal(pressure.calibratedTokens, 1_500);
    assert.equal(pressure.warningLevel, "none");
  });
});
