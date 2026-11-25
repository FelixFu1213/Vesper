import { useRouter } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { useMediaQuery } from "../hooks/useMediaQuery";
import { cn } from "../lib/utils";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import {
  selectActiveRightPanel,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { closeSplitPaneAndNavigate, focusSplitPaneAndNavigate } from "../splitThreadNavigation";
import { DEFAULT_SPLIT_RATIO, type SplitPaneSide, useSplitThreadStore } from "../splitThreadStore";
import type { ThreadRouteTarget } from "../threadRoutes";
import { ThreadRouteView } from "./ThreadRouteView";
import { SplitPaneContext, type SplitPaneContextValue } from "./chat/splitPaneContext";
import { SidebarInset } from "./ui/sidebar";

export function SplitThreadLayout({
  shownTarget,
  modalOpen,
}: {
  shownTarget: ThreadRouteTarget;
  modalOpen: boolean;
}) {
  const gt = useGT();
  const router = useRouter();
  const isNarrowViewport = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const splitOpen = useSplitThreadStore((s) => s.splitOpen);
  const focusedPane = useSplitThreadStore((s) => s.focusedPane);
  const leftTarget = useSplitThreadStore((s) => s.leftTarget);
  const rightTarget = useSplitThreadStore((s) => s.rightTarget);
  const splitRatio = useSplitThreadStore((s) => s.splitRatio);

  const [workspaceLayoutElement, setWorkspaceLayoutElement] = useState<HTMLDivElement | null>(null);
  const [rightPanelPortalHost, setRightPanelPortalHost] = useState<HTMLDivElement | null>(null);
  const panesContainerRef = useRef<HTMLDivElement | null>(null);
  const [resizing, setResizing] = useState(false);

  const splitActive = splitOpen && !isNarrowViewport;

  // Keep the focused pane's target synchronized when the route changes externally
  // (e.g. browser back/forward, command palette, or direct URL navigation).
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- syncs store with external router navigation
  useEffect(() => {
    if (!splitActive || modalOpen) return;
    useSplitThreadStore.getState().syncRouteTarget(shownTarget);
  }, [modalOpen, shownTarget, splitActive]);

  const effectiveLeftTarget = focusedPane === "left" ? shownTarget : (leftTarget ?? shownTarget);
  const effectiveRightTarget = focusedPane === "right" ? shownTarget : (rightTarget ?? shownTarget);

  const focusedTarget = focusedPane === "left" ? effectiveLeftTarget : effectiveRightTarget;
  const focusedThreadRef = focusedTarget.kind === "server" ? focusedTarget.threadRef : null;
  const focusedRightPanelMaximized = useRightPanelStore((state) => {
    if (!splitActive || !focusedThreadRef) return false;
    const activePanel = selectActiveRightPanel(state.byThreadKey, focusedThreadRef);
    const panelState = selectThreadRightPanelState(state.byThreadKey, focusedThreadRef);
    return activePanel !== null && panelState.maximized === true;
  });

  if (!splitActive) {
    return <ThreadRouteView target={shownTarget} background={modalOpen} />;
  }

  const handleFocusPane = (side: SplitPaneSide) => {
    if (focusedPane === side) return;
    void focusSplitPaneAndNavigate(router, side);
  };

  const handleClosePane = (side: SplitPaneSide) => {
    void closeSplitPaneAndNavigate(router, side);
  };

  const handleSwapPanes = () => {
    useSplitThreadStore.getState().swapPanes();
  };

  const leftContext: SplitPaneContextValue = {
    splitOpen: true,
    side: "left",
    focused: focusedPane === "left",
    rightPanelPortalHost,
    workspaceLayoutElement,
    onFocusPane: () => handleFocusPane("left"),
    onCloseSplitPane: () => handleClosePane("left"),
    onSwapSplitPanes: handleSwapPanes,
  };

  const rightContext: SplitPaneContextValue = {
    splitOpen: true,
    side: "right",
    focused: focusedPane === "right",
    rightPanelPortalHost,
    workspaceLayoutElement,
    onFocusPane: () => handleFocusPane("right"),
    onCloseSplitPane: () => handleClosePane("right"),
    onSwapSplitPanes: handleSwapPanes,
  };

  const handleDividerPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const container = panesContainerRef.current;
    if (!container) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);

    const updateRatio = (clientX: number) => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      useSplitThreadStore.getState().setSplitRatio((clientX - rect.left) / rect.width);
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      updateRatio(moveEvent.clientX);
    };
    const onPointerUp = () => {
      setResizing(false);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  };

  return (
    <SidebarInset
      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
      inert={modalOpen}
    >
      <div
        ref={setWorkspaceLayoutElement}
        className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
      >
        <div
          ref={panesContainerRef}
          className={cn(
            "flex min-h-0 min-w-0 overflow-hidden",
            focusedRightPanelMaximized ? "w-0 flex-none" : "flex-1",
            resizing && "select-none",
          )}
          inert={focusedRightPanelMaximized}
        >
          <div
            data-split-pane="left"
            data-split-focused={focusedPane === "left" ? "true" : "false"}
            style={{ width: `${splitRatio * 100}%` }}
            className="relative flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden"
            onPointerDownCapture={() => handleFocusPane("left")}
          >
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-x-0 top-0 z-30 h-[2px] transition-colors",
                focusedPane === "left" ? "bg-primary/70" : "bg-transparent",
              )}
            />
            <SplitPaneContext value={leftContext}>
              <ThreadRouteView target={effectiveLeftTarget} background={modalOpen} />
            </SplitPaneContext>
          </div>

          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={gt("Resize split threads")}
            data-split-resizer
            onPointerDown={handleDividerPointerDown}
            onDoubleClick={() => useSplitThreadStore.getState().setSplitRatio(DEFAULT_SPLIT_RATIO)}
            className={cn(
              "relative z-20 w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/60",
              resizing && "bg-primary",
            )}
          />

          <div
            data-split-pane="right"
            data-split-focused={focusedPane === "right" ? "true" : "false"}
            className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            onPointerDownCapture={() => handleFocusPane("right")}
          >
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-x-0 top-0 z-30 h-[2px] transition-colors",
                focusedPane === "right" ? "bg-primary/70" : "bg-transparent",
              )}
            />
            <SplitPaneContext value={rightContext}>
              <ThreadRouteView target={effectiveRightTarget} background={modalOpen} />
            </SplitPaneContext>
          </div>
        </div>

        <div
          ref={setRightPanelPortalHost}
          data-split-right-panel-host
          className={cn("flex min-h-0 shrink-0", focusedRightPanelMaximized && "flex-1")}
        />
      </div>
    </SidebarInset>
  );
}
