import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import type { ThreadRouteTarget } from "./threadRoutes";

export type SplitPaneSide = "left" | "right";

export const DEFAULT_SPLIT_RATIO = 0.5;
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;

function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_SPLIT_RATIO;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

function threadRouteTargetKey(target: ThreadRouteTarget | null): string | null {
  if (target === null) return null;
  return target.kind === "server"
    ? `server:${scopedThreadKey(target.threadRef)}`
    : `draft:${target.draftId}`;
}

export function areThreadRouteTargetsEqual(
  a: ThreadRouteTarget | null,
  b: ThreadRouteTarget | null,
): boolean {
  return threadRouteTargetKey(a) === threadRouteTargetKey(b);
}

export function otherSplitPaneSide(side: SplitPaneSide): SplitPaneSide {
  return side === "left" ? "right" : "left";
}

interface SplitThreadPersistedState {
  splitOpen: boolean;
  focusedPane: SplitPaneSide;
  leftTarget: ThreadRouteTarget | null;
  rightTarget: ThreadRouteTarget | null;
  splitRatio: number;
}

interface SplitThreadStore extends SplitThreadPersistedState {
  /**
   * Open `otherTarget` in split view alongside `currentTarget` (or in the non-focused pane if
   * already split). Returns the target that should be reflected in the URL.
   */
  openSplitWithTarget: (
    currentTarget: ThreadRouteTarget | null,
    otherTarget: ThreadRouteTarget,
    options?: { focusNew?: boolean; allowDuplicate?: boolean },
  ) => ThreadRouteTarget;
  /** Focus left or right pane; returns that pane's target so the router can navigate to it. */
  focusPane: (side: SplitPaneSide) => ThreadRouteTarget | null;
  /** Update the target of a specific pane without changing focus. */
  setPaneTarget: (side: SplitPaneSide, target: ThreadRouteTarget | null) => void;
  /** Keep the focused pane's target in sync when the URL changes externally. */
  syncRouteTarget: (target: ThreadRouteTarget | null) => void;
  /** Swap left and right panes while keeping the same thread focused. */
  swapPanes: () => void;
  /** Close one pane, exit split mode, and return the surviving pane's target. */
  closePane: (side: SplitPaneSide) => ThreadRouteTarget | null;
  /** Close the unfocused pane and exit split mode. */
  closeSplit: () => ThreadRouteTarget | null;
  /** Update the left/right width ratio (clamped). */
  setSplitRatio: (ratio: number) => void;
}

const INITIAL_STATE: SplitThreadPersistedState = {
  splitOpen: false,
  focusedPane: "left",
  leftTarget: null,
  rightTarget: null,
  splitRatio: DEFAULT_SPLIT_RATIO,
};

export const useSplitThreadStore = create<SplitThreadStore>()(
  persist(
    (set, get) => ({
      ...INITIAL_STATE,
      openSplitWithTarget: (currentTarget, otherTarget, options) => {
        const state = get();
        const focusNew = options?.focusNew ?? true;
        const allowDuplicate = options?.allowDuplicate ?? false;

        if (!state.splitOpen) {
          const leftTarget = currentTarget ?? otherTarget;
          const rightTarget = otherTarget;
          const focusedPane: SplitPaneSide = focusNew ? "right" : "left";
          set({
            splitOpen: true,
            focusedPane,
            leftTarget,
            rightTarget,
          });
          return focusedPane === "right" ? rightTarget : leftTarget;
        }

        const currentFocusedTarget =
          (state.focusedPane === "left" ? state.leftTarget : state.rightTarget) ?? currentTarget;
        const otherSide = otherSplitPaneSide(state.focusedPane);
        const currentOtherTarget =
          state.focusedPane === "left" ? state.rightTarget : state.leftTarget;

        if (!allowDuplicate) {
          if (areThreadRouteTargetsEqual(currentOtherTarget, otherTarget)) {
            set({ focusedPane: otherSide });
            return otherTarget;
          }
          if (areThreadRouteTargetsEqual(currentFocusedTarget, otherTarget)) {
            return otherTarget;
          }
        }

        const nextFocusedPane = focusNew ? otherSide : state.focusedPane;
        set({
          focusedPane: nextFocusedPane,
          leftTarget: otherSide === "left" ? otherTarget : currentFocusedTarget,
          rightTarget: otherSide === "right" ? otherTarget : currentFocusedTarget,
        });
        return nextFocusedPane === otherSide ? otherTarget : (currentFocusedTarget ?? otherTarget);
      },

      focusPane: (side) => {
        const state = get();
        if (state.focusedPane !== side) {
          set({ focusedPane: side });
        }
        return side === "left" ? state.leftTarget : state.rightTarget;
      },

      setPaneTarget: (side, target) => {
        set(side === "left" ? { leftTarget: target } : { rightTarget: target });
      },

      syncRouteTarget: (target) => {
        const state = get();
        if (!state.splitOpen || target === null) return;
        const currentFocused = state.focusedPane === "left" ? state.leftTarget : state.rightTarget;
        if (areThreadRouteTargetsEqual(currentFocused, target)) return;
        set(state.focusedPane === "left" ? { leftTarget: target } : { rightTarget: target });
      },

      swapPanes: () => {
        const state = get();
        if (!state.splitOpen) return;
        set({
          leftTarget: state.rightTarget,
          rightTarget: state.leftTarget,
          focusedPane: otherSplitPaneSide(state.focusedPane),
        });
      },

      closePane: (side) => {
        const state = get();
        const surviving = side === "left" ? state.rightTarget : state.leftTarget;
        set({
          splitOpen: false,
          focusedPane: "left",
          leftTarget: surviving,
          rightTarget: null,
        });
        return surviving;
      },

      closeSplit: () => {
        const state = get();
        const surviving = state.focusedPane === "left" ? state.leftTarget : state.rightTarget;
        set({
          splitOpen: false,
          focusedPane: "left",
          leftTarget: surviving,
          rightTarget: null,
        });
        return surviving;
      },

      setSplitRatio: (ratio) => {
        set({ splitRatio: clampSplitRatio(ratio) });
      },
    }),
    {
      name: "t3code:split-thread:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state): SplitThreadPersistedState => ({
        splitOpen: state.splitOpen,
        focusedPane: state.focusedPane,
        leftTarget: state.leftTarget,
        rightTarget: state.rightTarget,
        splitRatio: state.splitRatio,
      }),
    },
  ),
);
