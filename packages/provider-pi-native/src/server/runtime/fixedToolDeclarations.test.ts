import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, SystemMessage } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vite-plus/test";

import {
  restoredToolActivation,
  syncToolActivation,
  toolActivationSection,
  toolDeclarationPolicy,
  TOOL_ACTIVATION_SECTION,
} from "./fixedToolDeclarations.ts";

const SNAPSHOT = "a".repeat(64);

const tool = (name: string): AgentTool<any> => ({
  name,
  label: name,
  description: `${name} description`,
  parameters: { type: "object", properties: {} },
  execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
});

const builtin = (provider: "deepseek" | "openai", id: string): Model<Api> => {
  const model = getBuiltinModels(provider).find((candidate) => candidate.id === id);
  if (model === undefined) throw new Error(`missing builtin model ${provider}/${id}`);
  return model;
};

/** The verified route is the one binding that replays system updates without tool deltas. */
const flash = (): Model<Api> => {
  const model = builtin("deepseek", "deepseek-flash");
  return {
    ...model,
    compat: { ...model.compat, supportsMidConvoSystemMessages: true },
  } as Model<Api>;
};

const recordSection = (section: string): SystemMessage => ({
  role: "system",
  content: "",
  sections: { [TOOL_ACTIVATION_SECTION]: section },
  timestamp: 1,
});

describe("toolDeclarationPolicy", () => {
  it("fingerprints the account, route, catalog, and deferred set", () => {
    const tools = [tool("Read"), tool("TodoWrite")];
    const baseline = toolDeclarationPolicy(
      flash(),
      tools,
      new Set(["TodoWrite"]),
      "prompt",
      "acc-1",
    );
    expect(baseline.key).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      toolDeclarationPolicy(flash(), tools, new Set(["TodoWrite"]), "prompt", "acc-1").key,
    ).toBe(baseline.key);
    expect(
      toolDeclarationPolicy(flash(), tools, new Set(["TodoWrite"]), "prompt", "acc-2").key,
    ).not.toBe(baseline.key);
    expect(
      toolDeclarationPolicy(flash(), tools, new Set(["TodoWrite", "TodoRead"]), "prompt", "acc-1")
        .key,
    ).not.toBe(baseline.key);
    expect(
      toolDeclarationPolicy(
        flash(),
        [...tools].reverse(),
        new Set(["TodoWrite"]),
        "prompt",
        "acc-1",
      ).key,
    ).toBe(baseline.key);
  });

  it("keeps on-demand declarations for routes without mid-conversation system updates", () => {
    const policy = toolDeclarationPolicy(
      builtin("openai", "gpt-5.4"),
      [tool("Read"), tool("TodoWrite")],
      new Set(["TodoWrite"]),
      "prompt",
      "acc-1",
    );
    expect(policy.tools).toBeUndefined();
    expect(policy.fallback).toBeUndefined();
  });

  it("declares the whole catalog in name order for the verified route", () => {
    const policy = toolDeclarationPolicy(
      flash(),
      [tool("TodoWrite"), tool("Read"), tool("Bash")],
      new Set(["TodoWrite"]),
      "prompt",
      "acc-1",
    );
    expect(policy.tools?.map((entry) => entry.name)).toEqual(["Bash", "Read", "TodoWrite"]);
    expect(policy.fallback).toBeUndefined();
  });

  it("never truncates a catalog above the function cap", () => {
    const tools = Array.from({ length: 129 }, (_unused, index) => tool(`tool_${index}`));
    const policy = toolDeclarationPolicy(flash(), tools, new Set(), "prompt", "acc-1");
    expect(policy.tools).toBeUndefined();
    expect(policy.fallback).toBe("tool-count");
  });

  it("retains on-demand declarations when the catalog alone would crowd the tail", () => {
    const small = { ...flash(), contextWindow: 2_000, maxTokens: 200 } as Model<Api>;
    const tools = Array.from({ length: 20 }, (_unused, index) =>
      tool(`tool_${index}_${"d".repeat(200)}`),
    );
    const policy = toolDeclarationPolicy(small, tools, new Set(), "p".repeat(500), "acc-1");
    expect(policy.tools).toBeUndefined();
    expect(policy.fallback).toBe("context-budget");
  });
});

describe("toolActivationSection", () => {
  it("serializes a version-1 record with sorted active names", () => {
    expect(JSON.parse(toolActivationSection(SNAPSHOT, new Set(["TodoWrite", "TodoRead"])))).toEqual(
      {
        version: 1,
        snapshot: SNAPSHOT,
        active: ["TodoRead", "TodoWrite"],
      },
    );
  });
});

describe("restoredToolActivation", () => {
  it("restores a matching record and replays from the system record", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hi", timestamp: 1 },
      recordSection(
        [
          `<tool_activation>Task delegates work.</tool_activation>`,
          toolActivationSection(SNAPSHOT, new Set(["TodoWrite"])),
        ].join("\n\n"),
      ),
      { role: "user", content: "again", timestamp: 2 },
    ];
    const restored = restoredToolActivation(messages, SNAPSHOT);
    expect(restored?.active).toEqual(["TodoWrite"]);
    expect(restored?.replayFrom).toBe(2);
    expect(restoredToolActivation([], SNAPSHOT)).toBeUndefined();
  });

  it("fails closed on a mismatched snapshot or a malformed record", () => {
    const mismatched: AgentMessage[] = [
      recordSection(toolActivationSection("b".repeat(64), new Set(["TodoWrite"]))),
    ];
    expect(restoredToolActivation(mismatched, SNAPSHOT)?.active).toEqual([]);

    const malformed: AgentMessage[] = [recordSection('{"version":1,"snapshot":"nope"}')];
    expect(restoredToolActivation(malformed, SNAPSHOT)?.active).toEqual([]);

    const unknownVersion: AgentMessage[] = [
      recordSection(JSON.stringify({ version: 2, snapshot: SNAPSHOT, active: ["TodoWrite"] })),
    ];
    expect(restoredToolActivation(unknownVersion, SNAPSHOT)?.active).toEqual([]);

    const duplicated: AgentMessage[] = [
      recordSection(
        JSON.stringify({ version: 1, snapshot: SNAPSHOT, active: ["TodoWrite", "TodoWrite"] }),
      ),
    ];
    expect(restoredToolActivation(duplicated, SNAPSHOT)?.active).toEqual([]);
  });
});

describe("syncToolActivation", () => {
  it("appends the delta unless the section is already current", () => {
    const delta: SystemMessage = {
      role: "system",
      content: "",
      sections: { [TOOL_ACTIVATION_SECTION]: "record-v1" },
      timestamp: 5,
    };
    const appended = syncToolActivation([], delta);
    expect(appended).toEqual([delta]);
    expect(syncToolActivation(appended, delta)).toBe(appended);
    expect(
      syncToolActivation(appended, {
        ...delta,
        sections: { [TOOL_ACTIVATION_SECTION]: "record-v2" },
      }),
    ).toHaveLength(2);
  });
});
