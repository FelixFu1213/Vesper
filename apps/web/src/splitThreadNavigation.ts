import type { ScopedThreadRef } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";

import {
  areThreadRouteTargetsEqual,
  otherSplitPaneSide,
  type SplitPaneSide,
  useSplitThreadStore,
} from "./splitThreadStore";
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  type ThreadRouteTarget,
} from "./threadRoutes";

function navigateToThreadRouteTarget(
  router: Pick<AnyRouter, "navigate">,
  target: ThreadRouteTarget,
  options?: { replace?: boolean },
) {
  if (target.kind === "server") {
    return router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(target.threadRef),
      ...(options?.replace ? { replace: true } : {}),
    });
  }
  return router.navigate({
    to: "/draft/$draftId",
    params: buildDraftThreadRouteParams(target.draftId),
    ...(options?.replace ? { replace: true } : {}),
  });
}

export function serverThreadTarget(threadRef: ScopedThreadRef): ThreadRouteTarget {
  return { kind: "server", threadRef };
}

/**
 * Navigate to `target` in the currently focused pane when split view is active, or focus the
 * other pane if `target` is already open there.
 */
export function openTargetInFocusedPane(
  router: Pick<AnyRouter, "navigate">,
  target: ThreadRouteTarget,
) {
  const store = useSplitThreadStore.getState();
  if (store.splitOpen) {
    const otherSide = otherSplitPaneSide(store.focusedPane);
    const otherTarget = otherSide === "left" ? store.leftTarget : store.rightTarget;
    if (areThreadRouteTargetsEqual(otherTarget, target)) {
      store.focusPane(otherSide);
    } else {
      store.setPaneTarget(store.focusedPane, target);
    }
  }
  return navigateToThreadRouteTarget(router, target);
}

/**
 * Open `target` in split view alongside `currentTarget` (or in the non-focused pane if already
 * split).
 */
export function openTargetInSplit(
  router: Pick<AnyRouter, "navigate">,
  currentTarget: ThreadRouteTarget | null,
  target: ThreadRouteTarget,
  options?: { focusNew?: boolean; allowDuplicate?: boolean },
) {
  const nextFocusedTarget = useSplitThreadStore
    .getState()
    .openSplitWithTarget(currentTarget, target, options);
  return navigateToThreadRouteTarget(router, nextFocusedTarget);
}

export function focusSplitPaneAndNavigate(
  router: Pick<AnyRouter, "navigate">,
  side: SplitPaneSide,
) {
  const target = useSplitThreadStore.getState().focusPane(side);
  if (target !== null) {
    return navigateToThreadRouteTarget(router, target);
  }
  return Promise.resolve();
}

export function closeSplitPaneAndNavigate(
  router: Pick<AnyRouter, "navigate">,
  side: SplitPaneSide,
) {
  const surviving = useSplitThreadStore.getState().closePane(side);
  if (surviving !== null) {
    return navigateToThreadRouteTarget(router, surviving);
  }
  return router.navigate({ to: "/" });
}
