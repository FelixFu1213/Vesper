import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDotIcon,
  CircleIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useQuietThreadProjection } from "../../state/entities";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { hasActiveThreadRun, selectLatestThreadTodoList } from "./ThreadDetailsTodoList.logic";
import { THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS } from "./threadDetailsPanelStyles";

export function ThreadDetailsTodoList(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(true);
  const projection =
    useQuietThreadProjection(scopeThreadRef(props.environmentId, props.threadId))?.projection ??
    null;
  const todoList = selectLatestThreadTodoList(projection);
  if (todoList === null) return null;

  const isWorking = hasActiveThreadRun(projection);
  const progressPct = Math.round((todoList.completedCount / todoList.totalCount) * 100);
  const allCompleted = todoList.completedCount === todoList.totalCount;
  const seenStepIds = new Map<string, number>();
  const keyedSteps = todoList.steps.map((step) => {
    const count = seenStepIds.get(step.id) ?? 0;
    seenStepIds.set(step.id, count + 1);
    return {
      key: count === 0 ? step.id : `${step.id}#${count}`,
      step,
    };
  });

  return (
    <ThreadDetailsSection
      headingId="thread-details-todos-heading"
      title={gt("Tasks", { $context: "thread details section: agent todo list" })}
      data-thread-todos-panel
      actions={
        <>
          <span className="text-2xs font-medium tabular-nums text-muted-foreground">
            {todoList.completedCount}/{todoList.totalCount}
          </span>
          <ThreadDetailsControl
            size="icon-xs"
            variant="ghost"
            part="icon"
            aria-expanded={expanded}
            aria-label={expanded ? gt("Collapse todo list") : gt("Expand todo list")}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", !expanded && "-rotate-90")}
              aria-hidden
            />
          </ThreadDetailsControl>
        </>
      }
    >
      {expanded ? (
        <div>
          <div className="px-2.5 pb-1.5">
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted/70">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none",
                  allCompleted ? "bg-success" : "bg-info",
                )}
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
          {todoList.explanation ? (
            <p className="px-2.5 pb-1.5 text-2xs leading-snug text-muted-foreground break-words">
              {todoList.explanation}
            </p>
          ) : null}
          <ul
            aria-label={gt("Todo list")}
            className="m-0 max-h-[13.5rem] list-none space-y-0.5 overflow-y-auto p-0"
          >
            {keyedSteps.map(({ key, step }) => (
              <li
                key={key}
                className={cn(
                  "flex items-start gap-2 rounded-lg py-1",
                  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
                )}
              >
                <span className="mt-0.5 shrink-0">
                  {step.status === "completed" ? (
                    <>
                      <CheckCircle2Icon className="size-3.5 text-success" aria-hidden />
                      <span className="sr-only">{gt("Completed")}</span>
                    </>
                  ) : step.status === "running" ? (
                    <>
                      {isWorking ? (
                        <LoaderCircleIcon
                          className="size-3.5 animate-spin text-info motion-reduce:animate-none"
                          aria-hidden
                        />
                      ) : (
                        <CircleDotIcon className="size-3.5 text-info" aria-hidden />
                      )}
                      <span className="sr-only">{gt("In progress")}</span>
                    </>
                  ) : (
                    <>
                      <CircleIcon className="size-3.5 text-muted-foreground/55" aria-hidden />
                      <span className="sr-only">{gt("Pending")}</span>
                    </>
                  )}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 break-words text-xs leading-snug",
                    step.status === "completed"
                      ? "text-muted-foreground line-through decoration-muted-foreground/50"
                      : step.status === "running"
                        ? "font-medium text-foreground"
                        : "text-foreground/80",
                  )}
                >
                  {step.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </ThreadDetailsSection>
  );
}
