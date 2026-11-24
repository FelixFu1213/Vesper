import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { memo, useRef } from "react";
import { EllipsisIcon } from "lucide-react";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { focusRequestedPermission, useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import { ComposerPermissionsSection, type RuntimeModeOption } from "./ComposerFooterControls";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  showPermissions: boolean;
  size?: "sm" | "xs";
  /** Close the portaled popup when its trigger hides. */
  hidden?: boolean;
  /** The overflow menu offers a way out of an active Plan mode. */
  interactionMode?: ProviderInteractionMode;
  showInteractionModeToggle?: boolean;
  onToggleInteractionMode?: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const gt = useGT();
  const interactionMode = props.interactionMode ?? "default";
  const composerFloatingLayerProps = useComposerMenuProps();
  const size = props.size ?? "sm";
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => focusRequestedPermission(isOpen, triggerRef.current)}
    >
      <MenuTrigger
        render={
          <ComposerControl
            ref={triggerRef}
            size={size}
            className="shrink-0"
            aria-label={gt("More composer controls")}
            data-composer-shortcut={props.showPermissions ? "composer.mode" : undefined}
          />
        }
      >
        <ComposerControlIcon icon={EllipsisIcon} size={size} />
      </MenuTrigger>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        {props.showInteractionModeToggle ? (
          <>
            {interactionMode === "plan" ? (
              <MenuItem onClick={() => props.onToggleInteractionMode?.()}>
                {gt("Exit Plan mode")}
              </MenuItem>
            ) : null}
            {props.showPermissions ? <MenuSeparator /> : null}
          </>
        ) : null}
        {props.showPermissions ? (
          <ComposerPermissionsSection
            runtimeMode={props.runtimeMode}
            runtimeModeOptions={props.runtimeModeOptions}
            onRuntimeModeChange={props.onRuntimeModeChange}
          />
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
