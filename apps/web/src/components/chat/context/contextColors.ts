import type { ThreadContextCategory } from "@t3tools/contracts";

export interface ContextCategoryStyle {
  /** Solid fill for bars, dots, and rails. */
  readonly fillClassName: string;
  /** Text color that stays legible on the thread background in both themes. */
  readonly textClassName: string;
  /** A soft background for badges and selected legend rows. */
  readonly surfaceClassName: string;
}

/** One stable color per category, chosen to stay distinct in light and dark mode. */
export const CONTEXT_CATEGORY_STYLES: Readonly<
  Record<ThreadContextCategory, ContextCategoryStyle>
> = {
  system: {
    fillClassName: "bg-sky-500",
    textClassName: "text-sky-700 dark:text-sky-400",
    surfaceClassName: "bg-sky-500/10",
  },
  mcp: {
    fillClassName: "bg-violet-500",
    textClassName: "text-violet-700 dark:text-violet-400",
    surfaceClassName: "bg-violet-500/10",
  },
  tools: {
    fillClassName: "bg-amber-500",
    textClassName: "text-amber-700 dark:text-amber-400",
    surfaceClassName: "bg-amber-500/10",
  },
  skills: {
    fillClassName: "bg-emerald-500",
    textClassName: "text-emerald-700 dark:text-emerald-400",
    surfaceClassName: "bg-emerald-500/10",
  },
  user: {
    fillClassName: "bg-blue-500",
    textClassName: "text-blue-700 dark:text-blue-400",
    surfaceClassName: "bg-blue-500/10",
  },
  assistant: {
    fillClassName: "bg-indigo-500",
    textClassName: "text-indigo-700 dark:text-indigo-400",
    surfaceClassName: "bg-indigo-500/10",
  },
  tool_results: {
    fillClassName: "bg-orange-500",
    textClassName: "text-orange-700 dark:text-orange-400",
    surfaceClassName: "bg-orange-500/10",
  },
  provider_overhead: {
    fillClassName: "bg-zinc-400",
    textClassName: "text-zinc-700 dark:text-zinc-300",
    surfaceClassName: "bg-zinc-500/10",
  },
};
