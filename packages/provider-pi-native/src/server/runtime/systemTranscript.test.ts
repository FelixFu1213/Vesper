import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { assert, describe, it } from "@effect/vitest";

import {
  buildT3SystemSections,
  CANONICAL_SYSTEM_SECTIONS,
  foldForCheckpoint,
  SystemTranscriptManager,
} from "./systemTranscript.ts";

const TIMESTAMP = 1_700_000_000_000;

function user(text: string): UserMessage {
  return { role: "user", content: text, timestamp: TIMESTAMP };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
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
  };
}

describe("SystemTranscriptManager", () => {
  it("builds the leading message with sections in canonical order", () => {
    const manager = new SystemTranscriptManager({
      basePrompt: "You are T3.",
      sections: {
        context: "thread context",
        runtime: "runtime instructions",
        context_budget: "budget note",
        project_instructions: "project rules",
        custom_append: "append rules",
      },
      timestamp: TIMESTAMP,
    });

    const initial = manager.initialSystemMessage;
    assert.isDefined(initial);
    assert.equal(initial?.content, "You are T3.");
    assert.deepEqual(Object.keys(initial?.sections ?? {}), [
      "runtime",
      "custom_append",
      "project_instructions",
      "context",
      "context_budget",
    ]);
  });

  it("omits the leading message when the prompt and sections are empty", () => {
    const manager = new SystemTranscriptManager({ basePrompt: "", timestamp: TIMESTAMP });
    assert.isUndefined(manager.initialSystemMessage);
  });

  it("returns an append-only delta carrying only changed sections", () => {
    const manager = new SystemTranscriptManager({
      basePrompt: "base",
      sections: { runtime: "runtime v1", context: "context v1" },
      timestamp: TIMESTAMP,
    });

    const delta = manager.diffSections(
      { runtime: "runtime v1", context: "context v2", skills: "skills v1" },
      TIMESTAMP + 1,
    );

    assert.isNotNull(delta);
    assert.equal(delta?.content, "");
    assert.deepEqual(delta?.sections, {
      context: "context v2",
      skills: "skills v1",
    });
    assert.equal(delta?.timestamp, TIMESTAMP + 1);
    assert.equal(manager.committedSections.context, "context v2");
    assert.equal(manager.committedSections.runtime, "runtime v1");

    assert.isNull(manager.diffSections({ runtime: "runtime v1" }, TIMESTAMP + 2));
  });

  it("sends null when a section is removed", () => {
    const manager = new SystemTranscriptManager({
      basePrompt: "base",
      sections: { runtime: "runtime v1", skills: "skills v1" },
      timestamp: TIMESTAMP,
    });

    const delta = manager.diffSections({ skills: null }, TIMESTAMP + 1);

    assert.deepEqual(delta?.sections, { skills: null });
    assert.deepEqual(manager.committedSections, { runtime: "runtime v1", skills: null });
  });

  it("keeps each skill section right behind the catalog header, sorted by id", () => {
    const manager = new SystemTranscriptManager({
      basePrompt: "base",
      sections: {
        runtime: "runtime v1",
        context: "context v1",
        "skill:beta": "beta v1",
        skills: "skills v1",
        "skill:alpha": "alpha v1",
        tool_activation: "activation v1",
      },
      timestamp: TIMESTAMP,
    });

    assert.deepEqual(Object.keys(manager.initialSystemMessage?.sections ?? {}), [
      "runtime",
      "skills",
      "skill:alpha",
      "skill:beta",
      "tool_activation",
      "context",
    ]);
  });

  it("appends only the changed skill and revokes one that left the catalog", () => {
    const manager = new SystemTranscriptManager({
      basePrompt: "base",
      sections: { runtime: "runtime v1", skills: "skills v1", "skill:alpha": "alpha v1" },
      timestamp: TIMESTAMP,
    });

    const added = manager.diffSections(
      {
        runtime: "runtime v1",
        skills: "skills v1",
        "skill:alpha": "alpha v1",
        "skill:beta": "beta v1",
      },
      TIMESTAMP + 1,
    );
    assert.deepEqual(added?.sections, { "skill:beta": "beta v1" });

    const revoked = manager.diffSections(
      { runtime: "runtime v1", skills: "skills v1" },
      TIMESTAMP + 2,
    );
    assert.deepEqual(revoked?.sections, { "skill:alpha": null, "skill:beta": null });
    assert.deepEqual(manager.committedSections, {
      runtime: "runtime v1",
      skills: "skills v1",
      "skill:alpha": null,
      "skill:beta": null,
    });

    assert.isNull(
      manager.diffSections({ runtime: "runtime v1", skills: "skills v1" }, TIMESTAMP + 3),
    );
  });
});

describe("foldForCheckpoint", () => {
  it("replays system deltas into one leading message and drops later system messages", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "base prompt", sections: { runtime: "r1" }, timestamp: 10 },
      user("hello"),
      { role: "system", content: "", sections: { runtime: "r2", skills: null }, timestamp: 20 },
      assistant("hi"),
      { role: "system", content: "extra instruction", timestamp: 30 },
    ];

    const folded = foldForCheckpoint(messages, TIMESTAMP);

    assert.isDefined(folded.leadingSystem);
    assert.equal(folded.leadingSystem?.content, "base prompt\n\nextra instruction");
    assert.deepEqual(folded.leadingSystem?.sections, { runtime: "r2" });
    assert.equal(folded.leadingSystem?.timestamp, 10);
    assert.equal(folded.nonSystemMessages.length, 2);
    assert.equal(folded.nonSystemMessages[0]?.role, "user");
    assert.equal(folded.nonSystemMessages[1]?.role, "assistant");
  });

  it("returns no leading message for a transcript without system messages", () => {
    const folded = foldForCheckpoint([user("hi")], TIMESTAMP);
    assert.isUndefined(folded.leadingSystem);
    assert.equal(folded.nonSystemMessages.length, 1);
  });
});

describe("buildT3SystemSections", () => {
  it("renders runtime instructions and orchestration in the runtime section", () => {
    const sections = buildT3SystemSections({
      harness: "Pi",
      model: "gpt-5.4",
      hasT3Mcp: true,
      skillSummary: "skill: orca-cli",
      customAppend: "append rules",
      projectInstructions: "project rules",
      planMode: true,
    });

    assert.include(sections.runtime ?? "", "runtime_info");
    assert.include(sections.runtime ?? "", "T3 Code orchestration");
    assert.equal(sections.custom_append, "append rules");
    assert.equal(sections.project_instructions, "project rules");
    assert.equal(sections.skills, "skill: orca-cli");
    assert.include(sections.tool_activation ?? "", "plan_mode");
    assert.include(sections.tool_activation ?? "", "SubmitPlan");
    assert.isUndefined(sections.context);
    assert.deepEqual(Object.keys(sections), [
      "runtime",
      "custom_append",
      "project_instructions",
      "skills",
      "tool_activation",
    ]);
  });

  it("renders the goal mode section and the workflow directive into tool activation", () => {
    const sections = buildT3SystemSections({
      harness: "Pi Native",
      goal: {
        objective: "Ship the fix",
        status: "active",
        checks: 2,
        lastCheck: "tests pass",
      },
      workflowDirective: '<workflow_command name="review">check it</workflow_command>',
    });

    assert.include(sections.tool_activation ?? "", "<goal_mode>");
    assert.include(sections.tool_activation ?? "", "Objective: Ship the fix");
    assert.include(sections.tool_activation ?? "", "Checks recorded so far: 2.");
    assert.include(sections.tool_activation ?? "", "UpdateGoalStatus");
    assert.include(sections.tool_activation ?? "", 'workflow_command name="review"');
  });

  it("renders project memory after app context and omits blank memory", () => {
    const sections = buildT3SystemSections({
      harness: "Pi Native",
      context: "app notes",
      projectMemory: "Use the staging database.",
      contextBudget: "budget note",
    });

    assert.include(sections.project_memory ?? "", "# Project memory");
    assert.include(sections.project_memory ?? "", "user-provided context");
    assert.include(sections.project_memory ?? "", "Use the staging database.");
    assert.deepEqual(Object.keys(sections), [
      "runtime",
      "context",
      "project_memory",
      "context_budget",
    ]);
    assert.isUndefined(
      buildT3SystemSections({ harness: "Pi Native", projectMemory: "  \n " }).project_memory,
    );
  });

  it("only renders an active goal, and only while the directive belongs to the turn", () => {
    const paused = buildT3SystemSections({
      harness: "Pi Native",
      goal: { objective: "Ship the fix", status: "paused" },
    });
    assert.isUndefined(paused.tool_activation);

    const cleared = buildT3SystemSections({
      harness: "Pi Native",
      workflowDirective: "   ",
    });
    assert.isUndefined(cleared.tool_activation);
  });

  it("renders the on-demand tool catalog between skills and tool activation", () => {
    const sections = buildT3SystemSections({
      harness: "Pi Native",
      skillSummary: "skill: orca-cli",
      onDemandTools: "# On-demand tools\n- TodoWrite: Replace the visible todo list.",
      planMode: true,
    });

    assert.deepEqual(
      Object.keys(sections),
      CANONICAL_SYSTEM_SECTIONS.filter((name) => sections[name] !== undefined),
    );
    assert.equal(
      CANONICAL_SYSTEM_SECTIONS.indexOf("on_demand_tools"),
      CANONICAL_SYSTEM_SECTIONS.indexOf("skills") + 1,
    );
    assert.include(sections.on_demand_tools ?? "", "- TodoWrite:");
    assert.include(sections.tool_activation ?? "", "plan_mode");
  });

  it("merges per-skill sections into the catalog order", () => {
    const sections = buildT3SystemSections({
      harness: "Pi Native",
      skillSections: {
        skills: "# Skills",
        "skill:review": "- `review` — Review",
        "skill:notes": "- `notes` — Notes",
      },
    });

    assert.equal(sections.skills, "# Skills");
    assert.equal(sections["skill:review"], "- `review` — Review");
    assert.equal(sections["skill:notes"], "- `notes` — Notes");
    assert.isUndefined(sections.tool_activation);
  });

  it("leaves optional sections out when they have no content", () => {
    const sections = buildT3SystemSections({
      harness: "Pi",
      hasT3Mcp: false,
      skillSummary: "",
      customAppend: "",
      projectInstructions: "",
      context: "",
      planMode: false,
    });

    assert.isUndefined(sections.custom_append);
    assert.isUndefined(sections.project_instructions);
    assert.isUndefined(sections.skills);
    assert.isUndefined(sections.tool_activation);
    assert.isUndefined(sections.context);
    assert.notInclude(sections.runtime ?? "", "T3 Code orchestration");
    assert.deepEqual(
      Object.keys(sections),
      CANONICAL_SYSTEM_SECTIONS.filter((name) => sections[name] !== undefined),
    );
  });
});
