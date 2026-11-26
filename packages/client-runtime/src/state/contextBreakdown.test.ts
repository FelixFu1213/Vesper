import type { ThreadContextBreakdown, ThreadContextBreakdownItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CONTEXT_CATEGORY_ORDER,
  computeStackedBarGeometry,
  filterAndSortContextItems,
  formatCacheHitRate,
  nonEmptyContextCategories,
} from "./contextBreakdown.ts";

const breakdown = (
  overrides: Partial<ThreadContextBreakdown["window"]> = {},
  categories: ThreadContextBreakdown["categories"] = [],
): Pick<ThreadContextBreakdown, "window" | "categories"> => ({
  window: {
    usedTokens: 400,
    estimatedTotalTokens: 400,
    actualUsedTokens: 400,
    maxTokens: 1_000,
    usedPercentage: 40,
    remainingTokens: 600,
    autoCompactThreshold: 900,
    reserveTokens: 100,
    ...overrides,
  },
  categories,
});

const category = (
  name: ThreadContextBreakdown["categories"][number]["category"],
  tokens: number,
): ThreadContextBreakdown["categories"][number] => ({
  category: name,
  estimatedTokens: tokens,
  calibratedTokens: tokens,
  itemCount: 1,
});

describe("computeStackedBarGeometry", () => {
  it("scales segments to the full window and leaves free space", () => {
    const geometry = computeStackedBarGeometry(
      breakdown({}, [category("system", 100), category("user", 300)]),
    );
    expect(geometry.segments.map((segment) => segment.percent)).toEqual([10, 30]);
    expect(geometry.usedPercent).toBe(40);
    expect(geometry.freePercent).toBe(60);
    expect(geometry.autoCompactThresholdPercent).toBe(90);
    expect(geometry.reserveZone).toEqual({ leftPercent: 90, widthPercent: 10 });
  });

  it("falls back to what the thread used when the window is unknown", () => {
    const geometry = computeStackedBarGeometry(
      breakdown(
        { maxTokens: null, usedTokens: 200, autoCompactThreshold: null, reserveTokens: null },
        [category("system", 50), category("user", 150)],
      ),
    );
    expect(geometry.segments.map((segment) => segment.percent)).toEqual([25, 75]);
    expect(geometry.usedPercent).toBe(100);
    expect(geometry.freePercent).toBe(0);
    expect(geometry.autoCompactThresholdPercent).toBeNull();
    expect(geometry.reserveZone).toBeNull();
  });

  it("keeps the category order from the contract", () => {
    expect(
      CONTEXT_CATEGORY_ORDER.map((name, index) => name === CONTEXT_CATEGORY_ORDER[index]),
    ).toEqual(CONTEXT_CATEGORY_ORDER.map(() => true));
    expect(CONTEXT_CATEGORY_ORDER).toContain("provider_overhead");
  });
});

const items: ReadonlyArray<ThreadContextBreakdownItem> = [
  {
    id: "a",
    category: "mcp",
    kind: "mcp_schema",
    label: "t3_thread_organize",
    source: "mcp:t3-code",
    estimatedTokens: 100,
    calibratedTokens: 100,
    charCount: 400,
    byteCount: 400,
    orderIndex: 2,
    meta: { mcpServer: "t3-code", toolName: "t3_thread_organize" },
  },
  {
    id: "b",
    category: "assistant",
    kind: "assistant_reasoning",
    label: "Assistant reasoning",
    estimatedTokens: 50,
    calibratedTokens: 50,
    charCount: 200,
    byteCount: 200,
    orderIndex: 1,
  },
  {
    id: "c",
    category: "assistant",
    kind: "assistant_answer",
    label: "Assistant answer",
    estimatedTokens: 20,
    calibratedTokens: 20,
    charCount: 80,
    byteCount: 80,
    orderIndex: 3,
  },
  {
    id: "d",
    category: "skills",
    kind: "skill_loaded",
    label: "review",
    estimatedTokens: 10,
    calibratedTokens: 10,
    charCount: 40,
    byteCount: 40,
    orderIndex: 0,
    meta: { skillId: "review" },
  },
];

describe("filterAndSortContextItems", () => {
  it("sorts by size by default", () => {
    expect(filterAndSortContextItems(items).map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("sorts by prompt order or name", () => {
    expect(filterAndSortContextItems(items, { sortBy: "order" }).map((item) => item.id)).toEqual([
      "d",
      "b",
      "a",
      "c",
    ]);
    expect(filterAndSortContextItems(items, { sortBy: "name" })[0]?.label).toBe("Assistant answer");
  });

  it("filters by category, assistant sub-kind, and query", () => {
    expect(
      filterAndSortContextItems(items, { category: "assistant", assistantKind: "reasoning" }).map(
        (item) => item.id,
      ),
    ).toEqual(["b"]);
    expect(
      filterAndSortContextItems(items, { query: "mcp:t3-code" }).map((item) => item.id),
    ).toEqual(["a"]);
    expect(filterAndSortContextItems(items, { query: "review" }).map((item) => item.id)).toEqual([
      "d",
    ]);
  });
});

describe("formatCacheHitRate", () => {
  it("formats a hit share from reported counters", () => {
    expect(formatCacheHitRate(1_000, 625)).toBe("63%");
    expect(formatCacheHitRate(100, 5)).toBe("5.0%");
    expect(formatCacheHitRate(100, 900)).toBe("90%");
  });

  it("reports nothing without both counters", () => {
    expect(formatCacheHitRate(null, 10)).toBeNull();
    expect(formatCacheHitRate(0, 10)).toBeNull();
    expect(formatCacheHitRate(10, null)).toBeNull();
  });
});

describe("nonEmptyContextCategories", () => {
  it("drops zero-value categories and follows the display order", () => {
    const categories = nonEmptyContextCategories({
      categories: [category("user", 5), category("system", 0), category("skills", 2)],
    });
    expect(categories.map((entry) => entry.category)).toEqual(["skills", "user"]);
  });
});
