import type { RuntimeMode } from "@t3tools/contracts";
import { proposedPlanTitle } from "@t3tools/shared/proposedPlanText";
import { useGT } from "gt-react";
import { ChevronDownIcon, PanelRightOpenIcon, PencilRulerIcon } from "lucide-react";
import { useState } from "react";

import type { LatestProposedPlanState } from "../../session-logic";
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
import { Spinner } from "../ui/spinner";
import type { RuntimeModeOption } from "./ComposerFooterControls";

export interface ComposerPlanApprovalProps {
  readonly plan: LatestProposedPlanState;
  readonly runtimeMode: RuntimeMode;
  readonly runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  readonly disabled: boolean;
  readonly isApproving: boolean;
  readonly onOpenPlan: () => void;
  readonly onReject: () => void;
  readonly onApprove: (mode: RuntimeMode) => void;
  readonly onApproveInNewThread: (mode: RuntimeMode) => void;
}

/**
 * The settled plan's approval row above the composer: execute it here under the chosen
 * permissions, jump into the plan, or start a fresh thread that implements it. Picking a
 * permission mode in the split menu approves with it, like the right panel's footer.
 */
export function ComposerPlanApprovalBar(props: ComposerPlanApprovalProps) {
  const gt = useGT();
  const runtimeModeOptions = props.runtimeModeOptions;
  const fallbackMode = runtimeModeOptions.some((option) => option.mode === props.runtimeMode)
    ? props.runtimeMode
    : (runtimeModeOptions[0]?.mode ?? props.runtimeMode);
  // The picked mode belongs to one plan of one approval, so a new plan starts from the thread's.
  const approvalKey = `${props.plan.id}:${fallbackMode}:${runtimeModeOptions.map((option) => option.mode).join(",")}`;
  const [pickedMode, setPickedMode] = useState<{ key: string; mode: RuntimeMode }>({
    key: approvalKey,
    mode: fallbackMode,
  });
  const selectedMode = pickedMode.key === approvalKey ? pickedMode.mode : fallbackMode;
  const selectedOption =
    runtimeModeOptions.find((option) => option.mode === selectedMode) ?? runtimeModeOptions[0];
  const planTitle = proposedPlanTitle(props.plan.planMarkdown) ?? gt("Proposed plan");
  const actionDisabled = props.disabled || props.isApproving;

  return (
    <section
      role="region"
      aria-label={gt("Plan ready for execution")}
      aria-busy={props.isApproving}
      data-testid="plan-approval-bar"
      className="flex flex-wrap items-center justify-between gap-2 px-2 py-1"
    >
      <span className="sr-only" role="status" aria-live="polite">
        {gt("Plan ready for review and execution.")}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        <PencilRulerIcon aria-hidden="true" className="size-4 shrink-0 text-info-foreground" />
        <Badge variant="info" size="sm">
          {gt("Plan ready")}
        </Badge>
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{planTitle}</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid="plan-approval-open-panel"
          onClick={props.onOpenPlan}
        >
          <PanelRightOpenIcon aria-hidden="true" className="size-4" />
          {gt("Open in panel")}
        </Button>
      </div>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="plan-approval-reject"
          disabled={actionDisabled}
          onClick={props.onReject}
        >
          {gt("Reject")}
        </Button>
        <ButtonGroup>
          <Button
            type="button"
            size="sm"
            data-testid="plan-approval-approve"
            disabled={actionDisabled}
            onClick={() => props.onApprove(selectedMode)}
          >
            {props.isApproving ? (
              <>
                <Spinner size="xs" aria-hidden="true" />
                {gt("Starting...")}
              </>
            ) : (
              gt("Execute · {mode}", { mode: selectedOption?.label ?? selectedMode })
            )}
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  aria-label={gt("Choose execution mode")}
                  data-testid="plan-approval-mode-menu"
                  disabled={actionDisabled}
                />
              }
            >
              <ChevronDownIcon aria-hidden="true" className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end" side="top" className="min-w-56">
              <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                {gt("Execute with permissions")}
              </div>
              <MenuRadioGroup
                value={selectedMode}
                onValueChange={(value: RuntimeMode) => {
                  setPickedMode({ key: approvalKey, mode: value });
                  props.onApprove(value);
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
              <MenuSeparator />
              <MenuItem
                disabled={actionDisabled}
                onClick={() => props.onApproveInNewThread(selectedMode)}
              >
                {gt("Execute in a new thread")}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </ButtonGroup>
      </div>
    </section>
  );
}
