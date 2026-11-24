import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "@t3tools/shared/proposedPlanText";
import type {
  EnvironmentId,
  OrchestrationV2PlanArtifact,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { memo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { findRevealRef } from "./markdownFindContext";
import { buildCollapsedProposedPlanPreviewMarkdown } from "../../proposedPlan";
import ChatMarkdown from "../ChatMarkdown";
import { EllipsisIcon, PanelRightOpenIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { planStatusBadge } from "./planPresentation";
import { usePlanExportActions } from "./SavePlanToWorkspaceDialog";

/** The plan card in the timeline; the right panel shows the same plan unclipped. */
export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  status,
  environmentId,
  threadRef,
  cwd,
  workspaceRoot,
  findActive = false,
  onOpenInPanel,
}: {
  planMarkdown: string;
  status?: OrchestrationV2PlanArtifact["status"];
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | undefined;
  cwd: string | undefined;
  workspaceRoot: string | undefined;
  findActive?: boolean;
  onOpenInPanel?: (() => void) | undefined;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [expanded, setExpanded] = useState(false);
  const exportActions = usePlanExportActions({ planMarkdown, environmentId, workspaceRoot });
  const title = proposedPlanTitle(planMarkdown) ?? gt("Proposed plan");
  const statusBadge = status === undefined ? null : planStatusBadge(status, messages);
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 }, messages)
    : null;
  const isCollapsed = canCollapse && !expanded;
  // Mount clipped plans during find to count hidden matches without revealing them.
  const showPreview = isCollapsed && !findActive;
  const revealRef = findRevealRef(() => setExpanded(true));

  // A click opens the panel unless it landed on a control, a menu, or selected text.
  const handleCardClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!onOpenInPanel || event.defaultPrevented) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(
        'button, a, input, textarea, select, [role="button"], [role="menu"], [role="menuitem"], [data-slot="dialog-popup"], [data-slot="menu-popup"]',
      ) !== null
    ) {
      return;
    }
    if ((window.getSelection()?.toString().trim() ?? "") !== "") return;
    onOpenInPanel();
  };

  const openInPanel = () => {
    onOpenInPanel?.();
  };

  return (
    <div
      className={cn(
        "rounded-2xl border border-border/80 bg-card/70 p-4 sm:p-5",
        onOpenInPanel === undefined
          ? undefined
          : "cursor-pointer transition-colors hover:border-border hover:bg-card/90",
      )}
      onClick={onOpenInPanel === undefined ? undefined : handleCardClick}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">{gt("Plan", { $context: "badge, noun" })}</Badge>
          {statusBadge === null ? null : (
            <Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>
          )}
          <h3 data-thread-find-text="true" className="truncate text-sm font-medium text-foreground">
            {title}
          </h3>
        </div>
        <div className="flex items-center gap-1">
          {onOpenInPanel === undefined ? null : (
            <Button
              aria-label={gt("Open in panel")}
              data-testid="open-plan-panel-button"
              size="icon-xs"
              variant="outline"
              onClick={(event) => {
                event.stopPropagation();
                openInPanel();
              }}
            >
              <PanelRightOpenIcon aria-hidden="true" className="size-4" />
            </Button>
          )}
          <Menu>
            <MenuTrigger
              render={<Button aria-label={gt("Plan actions")} size="icon-xs" variant="outline" />}
            >
              <EllipsisIcon aria-hidden="true" className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              {onOpenInPanel === undefined ? null : (
                <MenuItem
                  onClick={(event) => {
                    event.stopPropagation();
                    openInPanel();
                  }}
                >
                  <PanelRightOpenIcon aria-hidden="true" />
                  <T>Open in panel</T>
                </MenuItem>
              )}
              <MenuItem onClick={exportActions.copyToClipboard}>
                {exportActions.isCopied ? gt("Copied!") : gt("Copy to clipboard")}
              </MenuItem>
              <MenuItem onClick={exportActions.downloadPlan}>
                <T>Download as markdown</T>
              </MenuItem>
              <MenuItem
                onClick={exportActions.openSaveDialog}
                disabled={!exportActions.canSaveToWorkspace}
              >
                <T>Save to workspace</T>
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
      <div className="mt-4">
        <div
          ref={revealRef}
          className={cn("relative", isCollapsed && "max-h-104 overflow-hidden")}
          data-thread-find-text="true"
          data-thread-find-fold={isCollapsed ? "" : undefined}
        >
          {showPreview ? (
            <ChatMarkdown
              text={collapsedPreview ?? ""}
              cwd={cwd}
              environmentId={environmentId}
              threadRef={threadRef}
              isStreaming={false}
              headingLevelOffset={3}
            />
          ) : (
            <ChatMarkdown
              text={displayedPlanMarkdown}
              cwd={cwd}
              environmentId={environmentId}
              threadRef={threadRef}
              isStreaming={false}
              headingLevelOffset={3}
            />
          )}
          {isCollapsed ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              data-scroll-anchor-ignore
              onClick={(event) => {
                event.stopPropagation();
                setExpanded((value) => !value);
              }}
            >
              {expanded ? gt("Collapse plan") : gt("Expand plan")}
            </Button>
          </div>
        ) : null}
      </div>

      {exportActions.dialog}
    </div>
  );
});
