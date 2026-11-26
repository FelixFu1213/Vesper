import type { ThreadContextBreakdown } from "@t3tools/contracts";

/** Share of the thread's used context a category represents. */
export function contextCategoryPercent(
  tokens: number,
  breakdown: Pick<ThreadContextBreakdown, "window">,
): number {
  const total = breakdown.window.usedTokens;
  return total <= 0 ? 0 : Math.round((tokens / total) * 100);
}

export function formatContextPercent(value: number | null): string {
  return value === null ? "-" : `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}
