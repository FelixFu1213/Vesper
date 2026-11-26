import type { ThreadContextBreakdown } from "@t3tools/contracts";
import {
  CONTEXT_CATEGORY_ORDER,
  computeStackedBarGeometry,
  formatCacheHitRate,
} from "@t3tools/client-runtime/state/context-breakdown";
import { contextCategoryPercent, formatContextPercent } from "./contextFormat";
import { msg, useGT, useMessages } from "gt-react";
import { useState } from "react";
import { cn } from "~/lib/utils";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { CONTEXT_CATEGORY_STYLES } from "./contextColors";

const tokensOrDash = (value: number | null): string =>
  value === null ? "-" : formatContextWindowTokens(value);

const CATEGORY_LABELS = {
  system: msg("System Prompt"),
  mcp: msg("MCP"),
  tools: msg("Tools"),
  skills: msg("Skills"),
  user: msg("User"),
  assistant: msg("Assistant"),
  tool_results: msg("Tool Results"),
  provider_overhead: msg("Provider Overhead"),
} as const;

type Category = (typeof CONTEXT_CATEGORY_ORDER)[number];

export function ContextCompositionCard({
  breakdown,
  focusedCategory,
  onFocusCategory,
}: {
  readonly breakdown: ThreadContextBreakdown;
  readonly focusedCategory: Category | null;
  readonly onFocusCategory: (category: Category | null) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [hovered, setHovered] = useState<Category | null>(null);
  const geometry = computeStackedBarGeometry(breakdown);
  const legend = CONTEXT_CATEGORY_ORDER.flatMap((category) => {
    const summary = breakdown.categories.find((entry) => entry.category === category);
    return summary === undefined || summary.calibratedTokens <= 0 ? [] : [summary];
  });
  const highlighted = hovered ?? focusedCategory;
  const used = breakdown.window.usedTokens;
  const max = breakdown.window.maxTokens;
  const percent = breakdown.window.usedPercentage;
  const cacheHit = formatCacheHitRate(
    breakdown.usage.inputTokens,
    breakdown.usage.cachedInputTokens,
  );
  const headroom =
    breakdown.window.remainingTokens === null
      ? "-"
      : formatContextWindowTokens(breakdown.window.remainingTokens);

  return (
    <section className="rounded-lg border border-border/60 bg-card/40">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 pt-3">
        <h3 className="font-medium text-sm">{gt("Composition")}</h3>
        <p className="text-muted-foreground text-xs">
          {percent === null
            ? gt("{used} tokens used", { used: formatContextWindowTokens(used) })
            : gt("{used} / {max} · {percent} used", {
                used: formatContextWindowTokens(used),
                max: max === null ? "-" : formatContextWindowTokens(max),
                percent: formatContextPercent(percent),
              })}
        </p>
      </div>

      <div className="px-3 pt-2">
        <div
          className="relative h-4 w-full overflow-hidden rounded-sm bg-muted"
          role="img"
          aria-label={gt("Context composition: {used} tokens across {categories} categories", {
            used: formatContextWindowTokens(used),
            categories: legend.length,
          })}
        >
          {geometry.reserveZone !== null ? (
            <div
              aria-hidden
              className="absolute inset-y-0 border-border/50 border-l"
              style={{
                left: `${geometry.reserveZone.leftPercent}%`,
                width: `${geometry.reserveZone.widthPercent}%`,
                backgroundImage:
                  "repeating-linear-gradient(135deg, color-mix(in srgb, currentColor 18%, transparent) 0 2px, transparent 2px 5px)",
              }}
            />
          ) : null}
          <div className="absolute inset-0 flex">
            {geometry.segments.map((segment) => {
              const style = CONTEXT_CATEGORY_STYLES[segment.category];
              const selected = focusedCategory === segment.category;
              return (
                <button
                  key={segment.category}
                  type="button"
                  aria-label={messages(CATEGORY_LABELS[segment.category])}
                  aria-pressed={selected}
                  className={cn(
                    "h-full shrink-0 cursor-pointer transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                    style.fillClassName,
                    highlighted !== null && highlighted !== segment.category && "opacity-35",
                  )}
                  style={{ width: `${segment.percent}%` }}
                  onClick={() => onFocusCategory(selected ? null : segment.category)}
                  onMouseEnter={() => setHovered(segment.category)}
                  onMouseLeave={() => setHovered(null)}
                />
              );
            })}
          </div>
          {geometry.autoCompactThresholdPercent !== null ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-foreground/60"
              style={{ left: `${geometry.autoCompactThresholdPercent}%` }}
            />
          ) : null}
        </div>
        {highlighted !== null
          ? (() => {
              const highlightedSummary = breakdown.categories.find(
                (entry) => entry.category === highlighted,
              );
              if (highlightedSummary === undefined) return null;
              return (
                <div className="mt-1.5 flex items-center gap-2 text-2xs text-muted-foreground">
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      CONTEXT_CATEGORY_STYLES[highlighted].fillClassName,
                    )}
                  />
                  <span className="font-medium text-foreground">
                    {messages(CATEGORY_LABELS[highlighted])}
                  </span>
                  <span className="tabular-nums">
                    ≈{formatContextWindowTokens(highlightedSummary.calibratedTokens)}
                  </span>
                  <span className="tabular-nums">
                    {contextCategoryPercent(highlightedSummary.calibratedTokens, breakdown)}%
                  </span>
                </div>
              );
            })()
          : null}
      </div>

      <ul className="grid grid-cols-1 gap-px px-3 pt-2 pb-3 sm:grid-cols-2">
        {legend.map((summary) => {
          const style = CONTEXT_CATEGORY_STYLES[summary.category];
          const selected = focusedCategory === summary.category;
          const dimmed = highlighted !== null && highlighted !== summary.category;
          const hasDeferred = summary.deferredCount !== undefined && summary.deferredCount > 0;
          return (
            <li key={summary.category}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onFocusCategory(selected ? null : summary.category)}
                onMouseEnter={() => setHovered(summary.category)}
                onMouseLeave={() => setHovered(null)}
                className={cn(
                  "flex w-full cursor-pointer flex-col gap-0.5 rounded-sm px-1.5 py-1 text-left text-xs",
                  selected && style.surfaceClassName,
                  dimmed && "opacity-55",
                )}
              >
                <div className="flex w-full items-center gap-2">
                  <span className={cn("size-2 shrink-0 rounded-full", style.fillClassName)} />
                  <span className="min-w-0 flex-1 truncate">
                    {messages(CATEGORY_LABELS[summary.category])}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    ≈{formatContextWindowTokens(summary.calibratedTokens)}
                  </span>
                  <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
                    {contextCategoryPercent(summary.calibratedTokens, breakdown)}%
                  </span>
                </div>
                {hasDeferred ? (
                  <span className="pl-4 text-3xs text-muted-foreground/80">
                    {gt("{count} deferred · {saved}k saved", {
                      count: summary.deferredCount!,
                      saved: ((summary.deferredTokens ?? 0) / 1_000).toFixed(1),
                    })}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      <dl className="grid grid-cols-2 gap-px border-border/60 border-t bg-border/60 sm:grid-cols-4">
        <Kpi
          label={gt("Input")}
          value={tokensOrDash(breakdown.usage.inputTokens)}
          detail={cacheHit === null ? gt("No cache data") : gt("{rate} cached", { rate: cacheHit })}
        />
        <Kpi
          label={gt("Output")}
          value={tokensOrDash(breakdown.usage.outputTokens)}
          detail={
            breakdown.usage.reasoningOutputTokens === null
              ? gt("No reasoning data")
              : gt("{tokens} reasoning", {
                  tokens: tokensOrDash(breakdown.usage.reasoningOutputTokens),
                })
          }
        />
        <Kpi
          label={gt("Turns")}
          value={String(breakdown.usage.turnCount)}
          detail={gt("{count} tool calls", { count: breakdown.usage.toolUses })}
        />
        <Kpi
          label={gt("Cost")}
          value={
            breakdown.usage.cost === null
              ? "-"
              : `${breakdown.usage.cost.amount.toFixed(2)} ${breakdown.usage.cost.currency}`
          }
          detail={gt("{tokens} headroom", { tokens: headroom })}
        />
      </dl>
    </section>
  );
}

function Kpi({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <div className="min-w-0 bg-card/40 px-3 py-2">
      <dt className="truncate text-2xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium text-xs tabular-nums">{value}</dd>
      <dd className="truncate text-3xs text-muted-foreground">{detail}</dd>
    </div>
  );
}
