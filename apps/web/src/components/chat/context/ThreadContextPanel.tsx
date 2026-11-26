import type { ThreadContextBreakdown } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useQuietThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { threadEnvironment } from "~/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { ContextCompositionCard } from "./ContextCompositionCard";
import { ContextInspectorCard } from "./ContextInspectorCard";
import { ContextTimelineCard } from "./ContextTimelineCard";

const fidelityLabel = {
  exact: msg("Exact"),
  calibrated: msg("Calibrated"),
  estimated: msg("Estimated"),
} as const;

const fidelityNote = {
  exact: msg("Read from the transcript and tool declarations this thread sends to the provider."),
  calibrated: msg("Composed from T3's prompt and the provider's reported usage."),
  estimated: msg(
    "Reconstructed from T3's prompt and history. Provider-internal definitions are not exposed.",
  ),
} as const;

function formatComputedAt(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(parsed);
}

/** The full context breakdown for one thread, read only while this panel is open. */
export function ThreadContextPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const messages = useMessages();
  const query = useEnvironmentQuery(
    threadEnvironment.contextBreakdown({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const shell = useQuietThreadShell(threadRef);
  const completionKey = String(shell?.latestRun?.completedAt ?? shell?.latestRun?.runId ?? "");
  const lastCompletionKey = useRef(completionKey);
  const [focusedCategory, setFocusedCategory] = useState<
    ThreadContextBreakdown["categories"][number]["category"] | null
  >(null);
  const breakdown = query.data;

  const refreshAfterTurn = useEffectEvent(() => query.refresh());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetches the computed breakdown after a turn finishes, since the thread stream deliberately omits it
  useEffect(() => {
    if (lastCompletionKey.current === completionKey) return;
    lastCompletionKey.current = completionKey;
    refreshAfterTurn();
  }, [completionKey]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
      <div className="flex items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate font-medium text-sm">{gt("Context breakdown")}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {breakdown?.driver ? (
              <span className="rounded-full border border-border/70 px-1.5 py-0.5">
                {breakdown.driver}
              </span>
            ) : null}
            {breakdown?.model ? (
              <span className="max-w-40 truncate rounded-full border border-border/70 px-1.5 py-0.5">
                {breakdown.model}
              </span>
            ) : null}
            {breakdown ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="rounded-full bg-muted px-1.5 py-0.5 font-medium text-foreground">
                      {messages(fidelityLabel[breakdown.fidelity])}
                    </span>
                  }
                />
                <TooltipPopup className="max-w-64 whitespace-normal">
                  {breakdown.fidelityNote ?? messages(fidelityNote[breakdown.fidelity])}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        </div>
        <Button
          aria-label={gt("Refresh context breakdown")}
          disabled={query.isPending}
          onClick={query.refresh}
          size="icon-sm"
          variant="ghost-muted"
        >
          {query.isPending ? (
            <Spinner className="size-3.5" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
        </Button>
      </div>

      {breakdown === null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground text-sm">
          {query.error !== null ? (
            <>
              <p>{query.error}</p>
              <Button onClick={query.refresh} size="sm" variant="outline">
                {gt("Try again")}
              </Button>
            </>
          ) : (
            <>
              <Spinner className="size-4" />
              <p>{gt("Measuring this thread's context…")}</p>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-3">
          <ContextCompositionCard
            breakdown={breakdown}
            focusedCategory={focusedCategory}
            onFocusCategory={setFocusedCategory}
          />
          <ContextTimelineCard breakdown={breakdown} />
          <ContextInspectorCard
            breakdown={breakdown}
            focusedCategory={focusedCategory}
            onClearCategory={() => setFocusedCategory(null)}
          />
          <p className="px-1 pb-2 text-2xs text-muted-foreground">
            {gt("Computed at {time} · {used} of {max} tokens", {
              time: formatComputedAt(breakdown.computedAt),
              used: formatContextWindowTokens(breakdown.window.usedTokens),
              max:
                breakdown.window.maxTokens === null
                  ? "-"
                  : formatContextWindowTokens(breakdown.window.maxTokens),
            })}
          </p>
        </div>
      )}
    </div>
  );
}
