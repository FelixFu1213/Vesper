import { describe, expect, it } from "vite-plus/test";

import { listAdvertisedT3McpTools } from "./McpToolCatalog.ts";
import { DIRECT_DEFERRED_MCP_TOOLS } from "./McpToolExposure.ts";

describe("listAdvertisedT3McpTools", () => {
  const catalog = listAdvertisedT3McpTools();

  it("lists every advertised T3 tool once, with the schema the server sends", () => {
    expect(catalog.length).toBeGreaterThan(50);
    expect(new Set(catalog.map((tool) => tool.name)).size).toBe(catalog.length);
    for (const tool of catalog) {
      expect(tool.description).not.toBe("");
      expect(() => JSON.parse(tool.schemaJson)).not.toThrow();
      expect(tool.estimatedTokens).toBeGreaterThan(0);
      expect(tool.charCount).toBe(tool.schemaJson.length);
    }
  });

  it("includes the direct tools a deferring session lists up front", () => {
    const names = new Set(catalog.map((tool) => tool.name));
    for (const direct of DIRECT_DEFERRED_MCP_TOOLS) {
      expect(names.has(direct)).toBe(true);
    }
  });

  it("attributes each tool to the toolkit that declares it", () => {
    const byName = new Map(catalog.map((tool) => [tool.name, tool]));
    expect(byName.get("t3_thread_organize")?.toolkit).toBe("thread");
    expect(byName.get("preview_open")?.toolkit).toBe("preview");
    expect(byName.get("tool_search")?.toolkit).toBe("toolSearch");
  });

  it("returns the same cached descriptors on every read", () => {
    expect(listAdvertisedT3McpTools()).toBe(catalog);
  });
});
