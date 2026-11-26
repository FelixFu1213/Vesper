import type { ThreadContextBreakdown } from "@t3tools/contracts";
import { CONTEXT_CATEGORY_ORDER } from "@t3tools/client-runtime/state/context-breakdown";
import { useGT } from "gt-react";
import { useState } from "react";
import { cn } from "~/lib/utils";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { CONTEXT_CATEGORY_STYLES } from "./contextColors";

type Mode = "total" | "delta";

const CHART_HEIGHT_PX = 132;

/**
 * Turn-by-turn context growth. Bars stack categories to each turn's total, or show the
 * change against the previous turn; a compaction marker explains a drop.
 */
export function ContextTimelineCard({ breakdown }: { readonly breakdown: ThreadContextBreakdown }) {
  const gt = useGT();
  const [mode, setMode] = useState<Mode>("total");
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);
  const turns = breakdown.turns;
  if (turns.length < 2 && breakdown.compactions.length === 0) return null;

  const values =
    mode === "total"
      ? turns.map((turn) => turn.usedTokens)
      : turns.map((turn) => Math.abs(turn.deltaTokens));
  const scale = Math.max(1, ...values);
  const pinned = pinnedIndex === null ? null : (turns[pinnedIndex] ?? null);
  const showBars = turns.length >= 2;

  return (
    <section className="rounded-lg border border-border/60 bg-card/40">
      <div className="flex items-center justify-between gap-2 px-3 pt-3">
        <h3 className="font-medium text-sm">{gt("Turn by turn")}</h3>
        <div className="flex items-center gap-0.5 rounded-md border border-border/60 p-0.5">
          {(["total", "delta"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={mode === option}
              onClick={() => setMode(option)}
              className={cn(
                "cursor-pointer rounded-sm px-1.5 py-0.5 text-2xs",
                mode === option
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option === "total" ? gt("Total") : gt("Delta")}
            </button>
          ))}
        </div>
      </div>

      {showBars ? (
        <div className="overflow-x-auto px-3 pt-2 pb-1">
          <div
            className="flex min-w-full items-end gap-1"
            style={{ height: `${CHART_HEIGHT_PX}px` }}
            role="list"
            aria-label={gt("Context used per turn")}
          >
            {turns.map((turn, index) => {
              const isPinned = pinnedIndex === index;
              const barHeightPx = Math.max(
                2,
                Math.round((values[index]! / scale) * CHART_HEIGHT_PX),
              );
              const categories = CONTEXT_CATEGORY_ORDER.flatMap((category) => {
                const tokens = turn.categories?.[category] ?? 0;
                return tokens <= 0
                  ? []
                  : [
                      {
                        category,
                        tokens,
                        percent: (tokens / Math.max(1, turn.usedTokens)) * 100,
                      },
                    ];
              });
              return (
                <button
                  key={`${turn.turnIndex}:${turn.timestamp}`}
                  type="button"
                  role="listitem"
                  aria-pressed={isPinned}
                  aria-label={gt("Turn {turn}: {used} tokens, {delta} since the previous turn", {
                    turn: turn.turnIndex + 1,
                    used: formatContextWindowTokens(turn.usedTokens),
                    delta:
                      turn.deltaTokens >= 0
                        ? `+${formatContextWindowTokens(turn.deltaTokens)}`
                        : `-${formatContextWindowTokens(Math.abs(turn.deltaTokens))}`,
                  })}
                  onClick={() => setPinnedIndex(isPinned ? null : index)}
                  className={cn(
                    "group relative flex min-w-4 flex-1 cursor-pointer flex-col justify-end rounded-sm",
                    isPinned && "bg-accent/50",
                  )}
                  style={{ height: `${CHART_HEIGHT_PX}px` }}
                >
                  <div
                    className="pointer-events-none flex w-full flex-col justify-end overflow-hidden rounded-sm opacity-90 group-hover:opacity-100"
                    style={{ height: `${barHeightPx}px` }}
                  >
                    {mode === "total" ? (
                      categories.length > 0 ? (
                        categories.map((segment) => (
                          <span
                            key={segment.category}
                            className={cn(
                              "block w-full shrink-0",
                              CONTEXT_CATEGORY_STYLES[segment.category].fillClassName,
                            )}
                            style={{
                              height: `${segment.percent}%`,
                              minHeight: segment.percent > 0 ? 1 : 0,
                            }}
                          />
                        ))
                      ) : (
                        <span
                          className={cn(
                            "block h-full w-full",
                            CONTEXT_CATEGORY_STYLES.user.fillClassName,
                          )}
                        />
                      )
                    ) : (
                      <span
                        className={cn(
                          "block h-full w-full rounded-sm",
                          turn.deltaTokens >= 0
                            ? CONTEXT_CATEGORY_STYLES.user.fillClassName
                            : CONTEXT_CATEGORY_STYLES.tool_results.fillClassName,
                        )}
                      />
                    )}
                  </div>
                  {turn.events.length > 0 ? (
                    <span
                      className="absolute -top-0.5 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-foreground/70"
                      aria-hidden
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="flex min-w-full justify-between gap-1 text-3xs text-muted-foreground">
            <span>{gt("Turn 1")}</span>
            <span>{gt("Turn {count}", { count: turns.length })}</span>
          </div>
        </div>
      ) : null}

      {pinned !== null ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-border/60 border-t px-3 py-2 text-2xs sm:grid-cols-4">
          <TimelineStat
            label={gt("Actual prompt")}
            value={formatContextWindowTokens(pinned.usedTokens)}
          />
          <TimelineStat
            label={gt("Cached")}
            value={formatContextWindowTokens(pinned.cachedInputTokens ?? null)}
          />
          <TimelineStat
            label={gt("Output")}
            value={formatContextWindowTokens(pinned.outputTokens ?? null)}
          />
          <TimelineStat
            label={gt("Delta")}
            value={
              pinned.deltaTokens >= 0
                ? `+${formatContextWindowTokens(pinned.deltaTokens)}`
                : `-${formatContextWindowTokens(Math.abs(pinned.deltaTokens))}`
            }
          />
        </dl>
      ) : null}

      {breakdown.compactions.length > 0 ? (
        <ul className="flex flex-col gap-1 border-border/60 border-t px-3 py-2">
          {breakdown.compactions.slice(-4).map((compaction) => (
            <li key={compaction.id} className="flex items-baseline gap-2 text-2xs">
              <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-muted-foreground">
                {gt("Compaction")}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {compaction.savedTokens === undefined
                  ? "-"
                  : gt("{tokens} saved", {
                      tokens: formatContextWindowTokens(compaction.savedTokens),
                    })}
              </span>
              <span className="truncate text-muted-foreground/80">
                {compaction.summaryPreview ?? ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {showBars ? (
        <p className="px-3 pb-2 text-3xs text-muted-foreground">
          {turns.some((turn) => turn.events.length > 0)
            ? gt("Dots mark compactions, model switches, and loaded skills.")
            : ""}
        </p>
      ) : null}
    </section>
  );
}

function TimelineStat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium tabular-nums">{value}</dd>
    </div>
  );
}
