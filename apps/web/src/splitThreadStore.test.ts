import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { DraftId } from "./composerDraftStore";
import {
  areThreadRouteTargetsEqual,
  DEFAULT_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  useSplitThreadStore,
} from "./splitThreadStore";
import type { ThreadRouteTarget } from "./threadRoutes";

const targetA: ThreadRouteTarget = {
  kind: "server",
  threadRef: {
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("thread-a"),
  },
};

const targetB: ThreadRouteTarget = {
  kind: "server",
  threadRef: {
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("thread-b"),
  },
};

const targetC: ThreadRouteTarget = {
  kind: "server",
  threadRef: {
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("thread-c"),
  },
};

const draftTarget: ThreadRouteTarget = {
  kind: "draft",
  draftId: "draft-1" as DraftId,
};

describe("useSplitThreadStore", () => {
  beforeEach(() => {
    useSplitThreadStore.setState({
      splitOpen: false,
      focusedPane: "left",
      leftTarget: null,
      rightTarget: null,
      splitRatio: DEFAULT_SPLIT_RATIO,
    });
  });

  it("opens split view with current target on left and new target on right", () => {
    const next = useSplitThreadStore.getState().openSplitWithTarget(targetA, targetB);
    const state = useSplitThreadStore.getState();

    expect(state.splitOpen).toBe(true);
    expect(state.focusedPane).toBe("right");
    expect(areThreadRouteTargetsEqual(state.leftTarget, targetA)).toBe(true);
    expect(areThreadRouteTargetsEqual(state.rightTarget, targetB)).toBe(true);
    expect(areThreadRouteTargetsEqual(next, targetB)).toBe(true);
  });

  it("focuses the other pane instead of duplicating when target is already open there", () => {
    useSplitThreadStore.getState().openSplitWithTarget(targetA, targetB);
    useSplitThreadStore.getState().focusPane("left");

    const next = useSplitThreadStore.getState().openSplitWithTarget(targetA, targetB);
    const state = useSplitThreadStore.getState();

    expect(state.focusedPane).toBe("right");
    expect(areThreadRouteTargetsEqual(next, targetB)).toBe(true);
    expect(areThreadRouteTargetsEqual(state.leftTarget, targetA)).toBe(true);
    expect(areThreadRouteTargetsEqual(state.rightTarget, targetB)).toBe(true);
  });

  it("allows duplicating when allowDuplicate is true", () => {
    useSplitThreadStore.getState().openSplitWithTarget(targetA, targetA, { allowDuplicate: true });
    const state = useSplitThreadStore.getState();

    expect(state.splitOpen).toBe(true);
    expect(areThreadRouteTargetsEqual(state.leftTarget, targetA)).toBe(true);
    expect(areThreadRouteTargetsEqual(state.rightTarget, targetA)).toBe(true);
  });

  it("replaces the non-focused pane when opening a third target in split view", () => {
    useSplitThreadStore.getState().openSplitWithTarget(targetA, targetB);
    // Right (B) is focused; opening C replaces Left (A) and focuses Left.
    const next = useSplitThreadStore.getState().openSplitWithTarget(targetB, targetC);
    const state = useSplitThreadStore.getState();

    expect(state.focusedPane).toBe("left");
    expect(areThreadRouteTargetsEqual(state.leftTarget, targetC)).toBe(true);
    expect(areThreadRouteTargetsEqual(state.rightTarget, targetB)).toBe(true);
    expect(areThreadRouteTargetsEqual(next, targetC)).toBe(true);
  });

  it("swaps left and right panes while keeping the same thread focused", () => {
    useSplitThreadStore.getState().openSplitWithTarget(targetA, targetB);
    useSplitThreadStore.getState().swapPanes();
    const state = useSplitThreadStore.getState();

    expect(state.focusedPane).toBe("left");
    expect(areThreadRouteTargetsEqual(state.leftTarget, targetB)).toBe(true);
    expect(areThreadRouteTargetsEqual(state.rightTarget, targetA)).toBe(true);
  });

  it("closes a pane and keeps the surviving pane target", () => {
    useSplitThreadStore.getState().openSplitWithTarget(targetA, draftTarget);
    const surviving = useSplitThreadStore.getState().closePane("left");
    const state = useSplitThreadStore.getState();

    expect(state.splitOpen).toBe(false);
    expect(state.focusedPane).toBe("left");
    expect(areThreadRouteTargetsEqual(surviving, draftTarget)).toBe(true);
    expect(areThreadRouteTargetsEqual(state.leftTarget, draftTarget)).toBe(true);
    expect(state.rightTarget).toBeNull();
  });

  it("clamps splitRatio within bounds", () => {
    useSplitThreadStore.getState().setSplitRatio(0.05);
    expect(useSplitThreadStore.getState().splitRatio).toBe(MIN_SPLIT_RATIO);

    useSplitThreadStore.getState().setSplitRatio(0.95);
    expect(useSplitThreadStore.getState().splitRatio).toBe(MAX_SPLIT_RATIO);

    useSplitThreadStore.getState().setSplitRatio(Number.NaN);
    expect(useSplitThreadStore.getState().splitRatio).toBe(DEFAULT_SPLIT_RATIO);
  });
});
