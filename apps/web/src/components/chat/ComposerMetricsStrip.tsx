import {
  formatTokensPerSecond,
  resolveContextUsedPercentage,
  type ContextWindowSnapshot,
  type ReplySpeedSnapshot,
} from "@t3tools/client-runtime/state/context-window";
import { useGT, useLocale } from "gt-react";

import { formatContextWindowTokens } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ComposerMetricsStripProps {
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly replySpeed: ReplySpeedSnapshot | null;
  readonly className?: string;
}

/**
 * Compact strip below the chat composer showing the latest reply generation speed
 * (tokens/s) and current context-window usage percentage.
 */
export function ComposerMetricsStrip({
  contextWindow,
  replySpeed,
  className,
}: ComposerMetricsStripProps) {
  const gt = useGT();
  const locale = useLocale();
  const contextUsedPercent = resolveContextUsedPercentage(contextWindow);

  if (replySpeed === null && contextUsedPercent === null) {
    return null;
  }

  const speedLabel =
    replySpeed !== null ? `${formatTokensPerSecond(replySpeed.tokensPerSecond)} tokens/s` : null;
  const durationSeconds =
    replySpeed !== null ? (replySpeed.durationMs / 1000).toFixed(1).replace(/\.0$/, "") : null;

  const maxTokens =
    contextWindow?.maxTokens != null && contextWindow.maxTokens > 0
      ? contextWindow.maxTokens
      : null;
  const contextToneClass =
    contextUsedPercent === null
      ? undefined
      : contextUsedPercent >= 90
        ? "text-destructive"
        : contextUsedPercent >= 80
          ? "text-warning"
          : undefined;

  return (
    <div
      data-slot="composer-metrics-strip"
      className={cn(
        "surface-glass pointer-events-auto flex w-full items-center justify-end gap-3 px-3 pt-1.5 text-2xs leading-4 text-muted-foreground tabular-nums",
        className,
      )}
    >
      {replySpeed !== null && speedLabel !== null && durationSeconds !== null ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                data-slot="composer-reply-speed"
                className="inline-flex cursor-default items-center"
              />
            }
          >
            {speedLabel}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {gt("{tokens} output tokens in {seconds}s", {
              tokens: replySpeed.outputTokens.toLocaleString(locale),
              seconds: durationSeconds,
            })}
          </TooltipPopup>
        </Tooltip>
      ) : null}

      {contextUsedPercent !== null && contextWindow !== null ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                data-slot="composer-context-percent"
                className={cn("inline-flex cursor-default items-center", contextToneClass)}
              />
            }
          >
            {gt("Context {percent}%", { percent: contextUsedPercent })}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {maxTokens !== null
              ? gt("{used} / {max} tokens ({usedShort} / {maxShort})", {
                  used: contextWindow.usedTokens.toLocaleString(locale),
                  max: maxTokens.toLocaleString(locale),
                  usedShort: formatContextWindowTokens(contextWindow.usedTokens),
                  maxShort: formatContextWindowTokens(maxTokens),
                })
              : gt("{used} tokens used", {
                  used: contextWindow.usedTokens.toLocaleString(locale),
                })}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}
