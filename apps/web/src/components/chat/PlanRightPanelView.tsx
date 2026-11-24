import type {
  EnvironmentId,
  OrchestrationV2PlanArtifact,
  PlanId,
  RuntimeMode,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "@t3tools/shared/proposedPlanText";
import { useGT, useMessages } from "gt-react";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  FolderDownIcon,
  PanelRightIcon,
} from "lucide-react";
import { useState } from "react";

import type { PlanSurface } from "../../rightPanelStore";
import { useQuietThreadProjection } from "../../state/entities";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ButtonGroup } from "../ui/group";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import type { RuntimeModeOption } from "./ComposerFooterControls";
import { planStatusBadge } from "./planPresentation";
import { usePlanExportActions } from "./SavePlanToWorkspaceDialog";

export interface PlanRightPanelApprovalProps {
  readonly canApprove: boolean;
  readonly isApproving: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  readonly onApprove: (mode: RuntimeMode) => void;
  readonly onApproveInNewThread?: (mode: RuntimeMode) => void;
  readonly onReject: () => void;
}

/** One proposed plan in full beside the timeline, with the actions the card offers clipped. */
export function PlanRightPanelView(props: {
  readonly surface: PlanSurface;
  readonly threadRef: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | undefined;
  readonly workspaceRoot: string | undefined;
  readonly approval?: PlanRightPanelApprovalProps | null;
}) {
  const gt = useGT();
  const messages = useMessages();
  const projection = useQuietThreadProjection(props.threadRef)?.projection ?? null;
  const planId: PlanId = props.surface.planId;
  const plan =
    projection?.plans.find(
      (entry): entry is Extract<OrchestrationV2PlanArtifact, { kind: "proposed_plan" }> =>
        entry.kind === "proposed_plan" && entry.id === planId,
    ) ?? null;
  const exportActions = usePlanExportActions({
    planMarkdown: plan?.markdown ?? "",
    environmentId: props.environmentId,
    workspaceRoot: props.workspaceRoot,
  });

  const title =
    (plan ? proposedPlanTitle(plan.markdown) : null) ?? props.surface.title ?? gt("Proposed plan");
  const status = plan === null ? null : planStatusBadge(plan.status, messages);
  const approval = props.approval ?? null;
  const runtimeModeOptions = approval?.runtimeModeOptions ?? [];
  const fallbackMode = approval?.runtimeMode ?? runtimeModeOptions[0]?.mode ?? "full-access";
  // The picked mode belongs to one plan of one approval, so a new plan starts from the thread's.
  const approvalKey = `${planId}:${fallbackMode}:${runtimeModeOptions.map((option) => option.mode).join(",")}`;
  const [pickedMode, setPickedMode] = useState<{ key: string; mode: RuntimeMode }>({
    key: approvalKey,
    mode: fallbackMode,
  });
  const selectedMode = pickedMode.key === approvalKey ? pickedMode.mode : fallbackMode;
  const selectedOption =
    runtimeModeOptions.find((option) => option.mode === selectedMode) ?? runtimeModeOptions[0];

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="plan-right-panel">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary" size="sm">
            {gt("Plan", { $context: "badge, noun" })}
          </Badge>
          {status === null ? null : (
            <Badge variant={status.variant} size="sm">
              {status.label}
            </Badge>
          )}
          <h2 className="min-w-0 truncate text-sm font-medium text-foreground">{title}</h2>
        </div>
        <div className="flex items-center gap-1">
          <Button
            aria-label={exportActions.isCopied ? gt("Copied!") : gt("Copy plan")}
            size="icon-sm"
            variant="outline"
            disabled={plan === null}
            onClick={exportActions.copyToClipboard}
          >
            {exportActions.isCopied ? (
              <CheckIcon aria-hidden="true" className="size-4" />
            ) : (
              <CopyIcon aria-hidden="true" className="size-4" />
            )}
          </Button>
          <Button
            aria-label={gt("Download plan as markdown")}
            size="icon-sm"
            variant="outline"
            disabled={plan === null}
            onClick={exportActions.downloadPlan}
          >
            <DownloadIcon aria-hidden="true" className="size-4" />
          </Button>
          <Button
            aria-label={gt("Save plan to workspace")}
            size="icon-sm"
            variant="outline"
            disabled={plan === null || !exportActions.canSaveToWorkspace}
            onClick={exportActions.openSaveDialog}
          >
            <FolderDownIcon aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {plan === null ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground text-sm">
            <PanelRightIcon aria-hidden="true" className="size-5" />
            <p>{gt("Plan not found in this thread.")}</p>
          </div>
        ) : (
          <ChatMarkdown
            text={stripDisplayedPlanMarkdown(plan.markdown)}
            cwd={props.cwd}
            environmentId={props.environmentId}
            threadRef={props.threadRef}
            isStreaming={false}
            headingLevelOffset={2}
          />
        )}
      </div>

      {plan?.status === "active" && approval?.canApprove ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border/70 bg-card/60 px-4 py-3">
          <Button
            size="sm"
            variant="outline"
            disabled={approval.isApproving}
            onClick={approval.onReject}
          >
            {gt("Reject")}
          </Button>
          <ButtonGroup>
            <Button
              size="sm"
              disabled={approval.isApproving}
              onClick={() => approval.onApprove(selectedMode)}
            >
              {approval.isApproving
                ? gt("Starting...")
                : gt("Execute · {mode}", { mode: selectedOption?.label ?? selectedMode })}
            </Button>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    aria-label={gt("Choose how to execute")}
                    size="icon-sm"
                    disabled={approval.isApproving}
                  />
                }
              >
                <ChevronDownIcon aria-hidden="true" className="size-4" />
              </MenuTrigger>
              <MenuPopup align="end" className="min-w-56">
                <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                  {gt("Execute with permissions")}
                </div>
                <MenuRadioGroup
                  value={selectedMode}
                  onValueChange={(value: RuntimeMode) => {
                    setPickedMode({ key: approvalKey, mode: value });
                    approval.onApprove(value);
                  }}
                >
                  {runtimeModeOptions.map((option) => (
                    <MenuRadioItem
                      key={option.mode}
                      value={option.mode}
                      disabled={option.disabledReason !== undefined}
                      closeOnClick
                    >
                      {option.label}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
                {approval.onApproveInNewThread === undefined ? null : (
                  <>
                    <MenuSeparator />
                    <MenuItem onClick={() => approval.onApproveInNewThread?.(selectedMode)}>
                      {gt("Execute in a new thread")}
                    </MenuItem>
                  </>
                )}
              </MenuPopup>
            </Menu>
          </ButtonGroup>
        </div>
      ) : null}

      {exportActions.dialog}
    </div>
  );
}
