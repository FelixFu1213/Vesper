import { describe, expect, it } from "@effect/vitest";

import {
  parsePiNativeCompactCommand,
  parsePiNativeWorkflowCommand,
  PI_NATIVE_SLASH_COMMANDS,
} from "./commands.ts";

describe("PI_NATIVE_SLASH_COMMANDS", () => {
  it("advertises every native command once, in composer order", () => {
    expect(PI_NATIVE_SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "goal",
      "compact",
      "review",
      "grill-me",
      "boost",
      "init",
    ]);
    for (const command of PI_NATIVE_SLASH_COMMANDS) {
      expect(command.description?.trim()).not.toBe("");
      expect(command.input?.hint.trim()).not.toBe("");
    }
  });
});

describe("parsePiNativeCompactCommand", () => {
  it("reads a bare /compact and optional instructions", () => {
    expect(parsePiNativeCompactCommand({ text: "/compact" })).toEqual({});
    expect(parsePiNativeCompactCommand({ text: "  /compact   focus on diffs " })).toEqual({
      instructions: "focus on diffs",
    });
  });

  it("ignores other text and messages that carry attachments", () => {
    expect(parsePiNativeCompactCommand({ text: "/compacted" })).toBeNull();
    expect(parsePiNativeCompactCommand({ text: "compact this" })).toBeNull();
    expect(
      parsePiNativeCompactCommand({ text: "/compact", attachments: [{ id: "attachment-1" }] }),
    ).toBeNull();
  });
});

describe("parsePiNativeWorkflowCommand", () => {
  it("defaults each command when the argument is empty", () => {
    const review = parsePiNativeWorkflowCommand("/review");
    expect(review?.promptText).toBe("Review the current uncommitted changes and workspace state.");
    expect(review?.boostThinking).toBe(false);
    expect(review?.systemDirective).toContain('name="review"');

    const grill = parsePiNativeWorkflowCommand("/grill-me");
    expect(grill?.promptText).toBe(
      "Let's work through requirements and design decisions for this task.",
    );
    expect(grill?.systemDirective).toContain("asktool");

    const boost = parsePiNativeWorkflowCommand("/boost");
    expect(boost?.promptText).toBe("Analyze carefully, verify thoroughly, and proceed.");
    expect(boost?.boostThinking).toBe(true);

    const init = parsePiNativeWorkflowCommand("/init");
    expect(init?.promptText).toBe(
      "Inspect this repository and create or update AGENTS.md with accurate contributor guidance.",
    );
    expect(init?.systemDirective).toContain("AGENTS.md");
  });

  it("passes the argument into the prompt with the command's own shape", () => {
    expect(parsePiNativeWorkflowCommand("/review main...HEAD")).toMatchObject({
      command: "review",
      argument: "main...HEAD",
      promptText: "Review the following target and changes:\nmain...HEAD",
    });
    expect(parsePiNativeWorkflowCommand("/grill-me onboarding flow")).toMatchObject({
      command: "grill-me",
      argument: "onboarding flow",
      promptText: "onboarding flow",
    });
    expect(parsePiNativeWorkflowCommand("/boost fix the flaky test")).toMatchObject({
      command: "boost",
      argument: "fix the flaky test",
      promptText: "fix the flaky test",
      boostThinking: true,
    });
    expect(parsePiNativeWorkflowCommand("/init keep commands short")).toMatchObject({
      command: "init",
      promptText: "Create or update AGENTS.md with emphasis on:\nkeep commands short",
    });
  });

  it("is case-insensitive and ignores other commands", () => {
    expect(parsePiNativeWorkflowCommand("  /BOOST ship it ")).toMatchObject({
      command: "boost",
      argument: "ship it",
    });
    expect(parsePiNativeWorkflowCommand("/reviewing")).toBeNull();
    expect(parsePiNativeWorkflowCommand("/compact")).toBeNull();
    expect(parsePiNativeWorkflowCommand("review")).toBeNull();
  });
});
