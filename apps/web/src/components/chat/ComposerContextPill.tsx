import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { useGT } from "gt-react";
import { PieChartIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { useMessages } from "gt-react";
import { formatContextWindowCompactionMessage } from "./compaction.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

const RADIUS = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function toneOf(percent: number | null): "default" | "warning" | "error" {
  if (percent === null) return "default";
  if (percent >= 90) return "error";
  if (percent >= 80) return "warning";
  return "default";
}

/**
 * The composer's compact context gauge. It reads the usage the thread stream already
 * carries; the full breakdown stays behind the panel's own query.
 */
export function ComposerContextPill({
  usage,
  active,
  onToggle,
}: {
  readonly usage: ContextWindowSnapshot | null;
  readonly active: boolean;
  readonly onToggle: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const used = usage?.usedTokens ?? null;
  const max = usage?.maxTokens ?? null;
  const percent =
    usage?.usedPercentage === null || usage?.usedPercentage === undefined
      ? null
      : Math.min(100, Math.max(0, usage.usedPercentage));
  const tone = toneOf(percent);
  const threshold = usage?.autoCompactThreshold ?? null;
  const strokeClass =
    tone === "error"
      ? "text-destructive"
      : tone === "warning"
        ? "text-warning"
        : "text-foreground/60";
  const circumference = CIRCUMFERENCE;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-pressed={active}
            aria-label={gt("Inspect context breakdown")}
            onClick={onToggle}
            className={cn(
              "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full px-1 text-2xs text-muted-foreground tabular-nums hover:bg-accent hover:text-foreground",
              active && "bg-accent text-foreground",
            )}
          >
            <svg viewBox="0 0 14 14" className="size-3.5 shrink-0 -rotate-90" aria-hidden>
              <circle
                cx="7"
                cy="7"
                r={RADIUS}
                fill="none"
                strokeWidth="2"
                className="stroke-muted-foreground/25"
              />
              <circle
                cx="7"
                cy="7"
                r={RADIUS}
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                className={strokeClass}
                stroke="currentColor"
                strokeDasharray={`${((percent ?? 0) / 100) * circumference} ${circumference}`}
              />
            </svg>
            {percent === null ? (
              <PieChartIcon className="size-3 shrink-0" />
            ) : (
              <span>{Math.round(percent)}%</span>
            )}
          </button>
        }
      />
      <TooltipPopup className="max-w-64 whitespace-normal">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-foreground">
            {used === null
              ? gt("No context usage reported yet")
              : max === null
                ? gt("{used} tokens used", { used: formatContextWindowTokens(used) })
                : gt("{used} of {max} tokens", {
                    used: formatContextWindowTokens(used),
                    max: formatContextWindowTokens(max),
                  })}
          </span>
          {percent !== null ? (
            <span className="text-muted-foreground">
              {gt("{percent}% used", { percent: percent.toFixed(percent >= 10 ? 0 : 1) })}
            </span>
          ) : null}
          {threshold !== null && threshold > 0 ? (
            <span className="text-muted-foreground">
              {formatContextWindowCompactionMessage(threshold, m)}
            </span>
          ) : null}
          <span className="text-muted-foreground">{gt("Inspect context breakdown")}</span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
