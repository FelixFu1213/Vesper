import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vite-plus/test";

import {
  CORE_TOOL_NAMES,
  DeferredToolRegistry,
  ON_DEMAND_TOOLS_SECTION,
  TOOL_SEARCH_NAME,
  type DeferredToolSearchDetails,
} from "./deferredTools.ts";

const tool = (name: string, description = `${name} does something useful`): AgentTool<any> => ({
  name,
  label: name,
  description,
  parameters: { type: "object", properties: {} },
  execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
});

const BUILTINS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "asktool",
  "SubmitPlan",
  "TodoWrite",
  "TodoRead",
  "new_context",
  "UpdateGoalStatus",
].map((name) => tool(name));

const registryWith = (
  tools: ReadonlyArray<AgentTool<any>>,
  options?: ConstructorParameters<typeof DeferredToolRegistry>[0],
): DeferredToolRegistry => {
  const registry = new DeferredToolRegistry(options);
  registry.setTools(tools);
  return registry;
};

const searchTool = (registry: DeferredToolRegistry): AgentTool<any> => {
  const search = registry.activeTools().find((candidate) => candidate.name === TOOL_SEARCH_NAME);
  if (search === undefined) throw new Error("expected ToolSearch to be declared");
  return search;
};

const search = async (registry: DeferredToolRegistry, query: string) =>
  (await searchTool(registry).execute("call-1", { query })) as {
    readonly details: DeferredToolSearchDetails;
  };

const toolResult = (
  toolName: string,
  details: unknown,
  options?: { readonly isError?: boolean },
): AgentMessage => ({
  role: "toolResult",
  toolCallId: `call-${toolName}`,
  toolName,
  content: [{ type: "text", text: "result" }],
  details: details as never,
  isError: options?.isError === true,
  timestamp: 1,
});

describe("DeferredToolRegistry", () => {
  it("declares core tools and ToolSearch while deferring the ancillary builtins", () => {
    const registry = registryWith(BUILTINS);
    expect(registry.activeTools().map((candidate) => candidate.name)).toEqual([
      ...BUILTINS.filter((candidate) => CORE_TOOL_NAMES.has(candidate.name)).map(
        (candidate) => candidate.name,
      ),
      TOOL_SEARCH_NAME,
    ]);
    expect([...registry.deferredNames].sort()).toEqual([
      "SubmitPlan",
      "TodoRead",
      "TodoWrite",
      "UpdateGoalStatus",
      "asktool",
      "new_context",
    ]);
  });

  it("declares no ToolSearch when nothing is deferred", () => {
    const registry = registryWith([tool("Read"), tool("Bash")]);
    expect(registry.activeTools().map((candidate) => candidate.name)).toEqual(["Read", "Bash"]);
    expect(registry.catalogSection()).toBe("");
  });

  it("renders a bounded catalog in deterministic name order", () => {
    const catalog = registryWith(BUILTINS).catalogSection();
    expect(catalog.startsWith("# On-demand tools")).toBe(true);
    expect(catalog).toContain(TOOL_SEARCH_NAME);
    const names = catalog
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2, line.indexOf(":")));
    expect(names).toEqual([...names].sort());
    expect(names.length).toBeGreaterThan(0);
  });

  it("bounds a large catalog and points at search for the rest", () => {
    const many = Array.from({ length: 50 }, (_unused, index) =>
      tool(`mcp__t3-code__tool_${index}`),
    );
    const catalog = registryWith(many).catalogSection();
    const entries = catalog.split("\n").filter((line) => line.startsWith("- "));
    expect(entries.length).toBeLessThanOrEqual(41);
    expect(catalog).toContain("more; search by exact name or capability");
    expect(ON_DEMAND_TOOLS_SECTION).toBe("on_demand_tools");
  });

  it("activates up to four matches and reports details.addedToolNames", async () => {
    const registry = registryWith(BUILTINS);
    const added = await search(registry, "Todo");
    expect(added.details.addedToolNames).toEqual(["TodoRead", "TodoWrite"]);
    expect(registry.isActive("TodoWrite")).toBe(true);
    expect(registry.activeTools().map((candidate) => candidate.name)).toContain("TodoWrite");

    const again = await search(registry, "TodoWrite");
    expect(again.details.addedToolNames).toEqual([]);
    expect(again.details.matches).toEqual(["TodoWrite"]);
  });

  it("caps one search at four activations even when the query matches more", async () => {
    const registry = registryWith(
      Array.from({ length: 10 }, (_unused, index) =>
        tool(`deferred_${index}`, "shared capability"),
      ),
    );
    const added = await search(registry, "shared");
    expect(added.details.addedToolNames).toHaveLength(4);
    expect(registry.activeNames).toHaveLength(4);
  });

  it("keeps activation sticky across a catalog refresh and drops names that left it", async () => {
    const registry = registryWith(BUILTINS);
    await search(registry, "TodoWrite");
    registry.setTools([...BUILTINS, tool("mcp__t3-code__list_threads")]);
    expect(registry.isActive("TodoWrite")).toBe(true);

    registry.setTools(BUILTINS.filter((candidate) => candidate.name !== "TodoWrite"));
    expect(registry.isActive("TodoWrite")).toBe(false);
    expect(registry.isDeferred("TodoWrite")).toBe(false);
  });

  it("proxies MCP search results into activation", async () => {
    const queries: string[] = [];
    const remote = tool("mcp__t3-code__list_threads", "List T3 threads");
    const registry = new DeferredToolRegistry({
      searchRemoteTools: async (query) => {
        queries.push(query);
        return [remote.name];
      },
    });
    registry.setTools([...BUILTINS, remote]);
    const added = await search(registry, "threads");
    expect(queries).toEqual(["threads"]);
    expect(added.details.addedToolNames).toEqual([remote.name]);
    expect(registry.activeTools().map((candidate) => candidate.name)).toContain(remote.name);
  });

  it("restores activation only from successful ToolSearch results after the latest system record", () => {
    const registry = registryWith(BUILTINS);
    registry.restore([
      { role: "system", content: "", sections: { tool_activation: "v1" }, timestamp: 1 },
      toolResult(TOOL_SEARCH_NAME, { addedToolNames: ["TodoWrite"] }),
      { role: "system", content: "", sections: { tool_activation: "v2" }, timestamp: 2 },
      toolResult(TOOL_SEARCH_NAME, { activated: ["TodoRead"] }),
      toolResult(TOOL_SEARCH_NAME, { addedToolNames: ["SubmitPlan"] }, { isError: true }),
      toolResult("Read", { addedToolNames: ["new_context"] }),
    ]);
    expect(registry.activeNames).toEqual(["TodoRead"]);
  });

  it("restores from the fixed-declaration activation record when one is current", () => {
    const registry = registryWith(BUILTINS);
    registry.restore(
      [
        {
          role: "system",
          content: "",
          sections: {
            tool_activation: JSON.stringify({
              version: 1,
              snapshot: "a".repeat(64),
              active: ["TodoWrite"],
            }),
          },
          timestamp: 1,
        },
      ],
      "a".repeat(64),
    );
    expect(registry.activeNames).toEqual(["TodoWrite"]);
  });

  it("fails closed when the fixed-declaration snapshot does not match", () => {
    const registry = registryWith(BUILTINS);
    registry.restore(
      [
        {
          role: "system",
          content: "",
          sections: {
            tool_activation: JSON.stringify({
              version: 1,
              snapshot: "b".repeat(64),
              active: ["TodoWrite"],
            }),
          },
          timestamp: 1,
        },
        toolResult(TOOL_SEARCH_NAME, { addedToolNames: ["TodoWrite"] }),
      ],
      "a".repeat(64),
    );
    expect(registry.activeNames).toEqual([]);
  });
});
