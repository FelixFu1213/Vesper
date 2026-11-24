import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { assert, describe, it } from "@effect/vitest";

import {
  computeContextBudget,
  ContextEstimateCalibration,
  estimateAgentMessagesTokens,
  estimateAgentMessageTokens,
  estimateCjkAwareTextTokens,
  evaluateContextPressure,
} from "./contextBudget.ts";

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

describe("ContextEstimateCalibration", () => {
  it("starts at 1 and only grows after three agreeing upward samples", () => {
    const calibration = new ContextEstimateCalibration();
    assert.equal(calibration.multiplier, 1);

    calibration.recordSample(1_000, 1_200);
    calibration.recordSample(1_000, 1_300);
    assert.equal(calibration.multiplier, 1);

    calibration.recordSample(1_000, 1_100);
    assert.equal(calibration.multiplier, 1.2);
    assert.equal(calibration.calibrate(1_000), 1_200);
  });

  it("shrinks at most 15% per step and never below 85%", () => {
    const calibration = new ContextEstimateCalibration();
    calibration.recordSample(1_000, 2_000);
    calibration.recordSample(1_000, 2_000);
    calibration.recordSample(1_000, 2_000);
    assert.equal(calibration.multiplier, 2);

    for (let sample = 0; sample < 3; sample += 1) {
      calibration.recordSample(1_000, 1_000);
    }
    assert.isAtMost(Math.abs(calibration.multiplier - 1.7), 1e-9);

    for (let step = 0; step < 10; step += 1) {
      for (let sample = 0; sample < 3; sample += 1) {
        calibration.recordSample(1_000, 500);
      }
    }
    assert.equal(calibration.multiplier, 0.85);
  });

  it("needs three consecutive downward samples and ignores empty input", () => {
    const calibration = new ContextEstimateCalibration();

    calibration.recordSample(1_000, 500);
    calibration.recordSample(1_000, 3_000);
    calibration.recordSample(1_000, 500);
    calibration.recordSample(1_000, 500);
    assert.equal(calibration.multiplier, 1);

    calibration.recordSample(1_000, 500);
    assert.isBelow(calibration.multiplier, 1);
    assert.isAtLeast(calibration.multiplier, 0.85);

    const before = calibration.multiplier;
    calibration.recordSample(0, 500);
    calibration.recordSample(500, 0);
    assert.equal(calibration.multiplier, before);
  });
});

describe("evaluateContextPressure", () => {
  it("reports approaching and critical levels against the budget", () => {
    const budget = computeContextBudget({ contextWindow: 4_000, maxTokens: 1_000 });
    const messages: AgentMessage[] = [user("a".repeat(1_900 * 4))];

    const approaching = evaluateContextPressure(messages, {
      contextWindow: 4_000,
      maxTokens: 1_000,
    });

    assert.isTrue(approaching.shouldCompact);
    assert.equal(approaching.warningLevel, "approaching");
    assert.equal(approaching.rawTokens, 1_900);

    const critical = evaluateContextPressure([user("a".repeat(4_000 * 4))], {
      contextWindow: 4_000,
      maxTokens: 1_000,
    });
    assert.equal(critical.warningLevel, "critical");
    assert.isAtLeast(critical.calibratedTokens, budget.hardLimit);
  });

  it("applies the learned calibration to the calibrated estimate", () => {
    const calibration = new ContextEstimateCalibration();
    for (let sample = 0; sample < 3; sample += 1) {
      calibration.recordSample(1_000, 2_000);
    }
    const pressure = evaluateContextPressure([user("a".repeat(4_000))], MODEL, calibration);

    assert.equal(pressure.rawTokens, 1_000);
    assert.equal(pressure.calibratedTokens, 2_000);
    assert.equal(pressure.warningLevel, "none");
  });
});
