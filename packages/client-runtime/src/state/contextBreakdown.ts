import {
  ORCHESTRATION_V2_WS_METHODS,
  type ThreadContextBreakdown,
  type ThreadContextBreakdownItem,
  type ThreadContextCategory,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Every category in the order the stacked bar and legend render them. */
export const CONTEXT_CATEGORY_ORDER: ReadonlyArray<ThreadContextCategory> = [
  "system",
  "mcp",
  "tools",
  "skills",
  "user",
  "assistant",
  "tool_results",
  "provider_overhead",
];

/** A thread's prompt composition, read only while its panel is open. */
export function createThreadContextBreakdownQuery<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:thread:context-breakdown",
    tag: ORCHESTRATION_V2_WS_METHODS.getThreadContextBreakdown,
    staleTimeMs: 10_000,
    idleTtlMs: 120_000,
  });
}

export interface StackedBarSegment {
  readonly category: ThreadContextCategory;
  readonly tokens: number;
  readonly percent: number;
}

export interface StackedBarGeometry {
  /** Fractions of the full window, so the bar never renormalizes as usage grows. */
  readonly segments: ReadonlyArray<StackedBarSegment>;
  readonly usedPercent: number;
  readonly freePercent: number;
  /** Where automatic compaction starts, as a percent of the full window. */
  readonly autoCompactThresholdPercent: number | null;
  /** The headroom the window reserves for the next reply. */
  readonly reserveZone: { readonly leftPercent: number; readonly widthPercent: number } | null;
}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/**
 * Geometry for the composition bar. The scale is the model's full window when it is
 * known, so a small thread still shows how much room is left; without a window it
 * scales to what the thread used.
 */
export function computeStackedBarGeometry(
  breakdown: Pick<ThreadContextBreakdown, "window" | "categories">,
): StackedBarGeometry {
  const { window } = breakdown;
  const usedTokens = window.usedTokens;
  const scale = window.maxTokens ?? Math.max(usedTokens, 1);
  const segments = breakdown.categories
    .filter((category) => category.calibratedTokens > 0)
    .map((category) => ({
      category: category.category,
      tokens: category.calibratedTokens,
      percent: clampPercent((category.calibratedTokens / scale) * 100),
    }));
  const usedPercent = clampPercent((usedTokens / scale) * 100);
  const reserveTokens = window.reserveTokens;
  const maxTokens = window.maxTokens;
  const reserveZone =
    reserveTokens !== null && maxTokens !== null && reserveTokens > 0 && maxTokens > 0
      ? {
          leftPercent: clampPercent(((maxTokens - reserveTokens) / maxTokens) * 100),
          widthPercent: clampPercent((reserveTokens / maxTokens) * 100),
        }
      : null;
  return {
    segments,
    usedPercent,
    freePercent: clampPercent(100 - usedPercent),
    autoCompactThresholdPercent:
      window.autoCompactThreshold === null || maxTokens === null || maxTokens <= 0
        ? null
        : clampPercent((window.autoCompactThreshold / maxTokens) * 100),
    reserveZone,
  };
}

export type ContextItemSort = "size" | "order" | "name";
export type ContextAssistantKind = "all" | "answer" | "reasoning" | "tool_call";

export interface ContextItemFilter {
  readonly query?: string | undefined;
  readonly sortBy?: ContextItemSort | undefined;
  readonly assistantKind?: ContextAssistantKind | undefined;
  readonly category?: ThreadContextCategory | null | undefined;
}

const assistantSubKindOf = (
  item: ThreadContextBreakdownItem,
): Exclude<ContextAssistantKind, "all"> | null => {
  if (item.category !== "assistant") return null;
  if (item.kind === "assistant_reasoning") return "reasoning";
  if (item.kind === "assistant_tool_call") return "tool_call";
  return "answer";
};

const matchesQuery = (item: ThreadContextBreakdownItem, query: string): boolean => {
  const haystack = `${item.label} ${item.source ?? ""} ${item.meta?.toolName ?? ""} ${
    item.meta?.mcpServer ?? ""
  } ${item.meta?.skillId ?? ""} ${item.preview ?? ""}`.toLowerCase();
  return haystack.includes(query);
};

/** Filters and sorts inspector rows the way the panel's search and toggles ask. */
export function filterAndSortContextItems(
  items: ReadonlyArray<ThreadContextBreakdownItem>,
  filter: ContextItemFilter = {},
): ReadonlyArray<ThreadContextBreakdownItem> {
  const query = filter.query?.trim().toLowerCase() ?? "";
  const assistantKind = filter.assistantKind ?? "all";
  const filtered = items.filter((item) => {
    if (filter.category != null && item.category !== filter.category) return false;
    if (assistantKind !== "all" && assistantSubKindOf(item) !== assistantKind) return false;
    return query === "" || matchesQuery(item, query);
  });
  const sortBy = filter.sortBy ?? "size";
  return [...filtered].sort((left, right) => {
    switch (sortBy) {
      case "name":
        return left.label < right.label ? -1 : left.label > right.label ? 1 : 0;
      case "order":
        return left.orderIndex - right.orderIndex;
      case "size":
      default:
        return right.calibratedTokens - left.calibratedTokens;
    }
  });
}

/** "62.5%" for a cache hit share, or null when the provider reports no cache reads. */
export function formatCacheHitRate(
  inputTokens: number | null,
  cachedInputTokens: number | null,
): string | null {
  if (inputTokens === null || cachedInputTokens === null || inputTokens <= 0) return null;
  const total = cachedInputTokens > inputTokens ? inputTokens + cachedInputTokens : inputTokens;
  const percent = Math.min(100, Math.max(0, (cachedInputTokens / total) * 100));
  return `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
}

/** Categories the legend shows, with zero-valued ones dropped. */
export function nonEmptyContextCategories(
  breakdown: Pick<ThreadContextBreakdown, "categories">,
): ThreadContextBreakdown["categories"] {
  return CONTEXT_CATEGORY_ORDER.flatMap((category) => {
    const summary = breakdown.categories.find((entry) => entry.category === category);
    return summary === undefined || summary.calibratedTokens <= 0 ? [] : [summary];
  });
}
