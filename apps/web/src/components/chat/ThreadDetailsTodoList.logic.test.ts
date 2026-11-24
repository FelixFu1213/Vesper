import { NodeId, PlanId, RunId, ThreadId } from "@t3tools/contracts";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { hasActiveThreadRun, selectLatestThreadTodoList } from "./ThreadDetailsTodoList.logic";

const threadId = ThreadId.make("thread-1");
const now = DateTime.makeUnsafe(1_700_000_000_000);

function makeRun(id: string, ordinal: number, status: "running" | "completed" = "completed") {
  return {
    id: RunId.make(id),
    ordinal,
    status,
  } as unknown as ThreadStructure["runs"][number];
}

function makeTodoPlan(input: {
  id: string;
  runId: string | null;
  status?: "draft" | "active" | "completed" | "superseded";
  steps: ReadonlyArray<{ id: string; text: string; status: "pending" | "running" | "completed" }>;
  explanation?: string;
}) {
  return {
    id: PlanId.make(input.id),
    threadId,
    runId: input.runId === null ? null : RunId.make(input.runId),
    nodeId: NodeId.make(`node-${input.id}`),
    kind: "todo_list" as const,
    status: input.status ?? "active",
    steps: input.steps,
    ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
  };
}

function makeTodoTurnItem(input: {
  id: string;
  planId: string;
  runId: string | null;
  ordinal: number;
  steps: ReadonlyArray<{ id: string; text: string; status: "pending" | "running" | "completed" }>;
  explanation?: string;
}) {
  return {
    id: input.id,
    threadId,
    runId: input.runId === null ? null : RunId.make(input.runId),
    nodeId: NodeId.make(`node-${input.id}`),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "todo_list" as const,
    planId: PlanId.make(input.planId),
    steps: input.steps,
    ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
  } as unknown as ThreadStructure["turnItems"][number];
}

describe("selectLatestThreadTodoList", () => {
  it("returns null for empty or null projections", () => {
    expect(selectLatestThreadTodoList(null)).toBeNull();
    expect(selectLatestThreadTodoList(undefined)).toBeNull();
    expect(
      selectLatestThreadTodoList({
        plans: [
          {
            id: PlanId.make("proposed-1"),
            threadId,
            runId: null,
            nodeId: NodeId.make("node-p"),
            kind: "proposed_plan",
            status: "active",
            markdown: "# Plan",
          },
        ],
        runs: [],
        turnItems: [],
      }),
    ).toBeNull();
  });

  it("ignores superseded plans and picks the latest non-superseded plan by run and turn item ordinal", () => {
    const selected = selectLatestThreadTodoList({
      runs: [makeRun("run-1", 1), makeRun("run-2", 2)],
      plans: [
        makeTodoPlan({
          id: "plan-old-run",
          runId: "run-1",
          status: "superseded",
          steps: [{ id: "1", text: "Old", status: "completed" }],
        }),
        makeTodoPlan({
          id: "plan-a",
          runId: "run-2",
          status: "active",
          steps: [{ id: "1", text: "Earlier in run 2", status: "running" }],
        }),
        makeTodoPlan({
          id: "plan-b",
          runId: "run-2",
          status: "completed",
          explanation: "Finished everything",
          steps: [
            { id: "1", text: "Step 1", status: "completed" },
            { id: "2", text: "Step 2", status: "completed" },
          ],
        }),
      ],
      turnItems: [
        makeTodoTurnItem({
          id: "item-1",
          planId: "plan-a",
          runId: "run-2",
          ordinal: 10,
          steps: [{ id: "1", text: "Earlier in run 2", status: "running" }],
        }),
        makeTodoTurnItem({
          id: "item-2",
          planId: "plan-b",
          runId: "run-2",
          ordinal: 20,
          steps: [
            { id: "1", text: "Step 1", status: "completed" },
            { id: "2", text: "Step 2", status: "completed" },
          ],
        }),
      ],
    });

    expect(selected).toEqual({
      planId: PlanId.make("plan-b"),
      status: "completed",
      explanation: "Finished everything",
      completedCount: 2,
      runningCount: 0,
      pendingCount: 0,
      totalCount: 2,
      steps: [
        { id: "1", text: "Step 1", status: "completed" },
        { id: "2", text: "Step 2", status: "completed" },
      ],
    });
  });

  it("returns null when the latest todo plan was explicitly cleared instead of falling back to an older list", () => {
    const selected = selectLatestThreadTodoList({
      runs: [makeRun("run-1", 1), makeRun("run-2", 2)],
      plans: [
        makeTodoPlan({
          id: "plan-1",
          runId: "run-1",
          status: "active",
          steps: [{ id: "1", text: "Old step", status: "running" }],
        }),
        makeTodoPlan({
          id: "plan-2",
          runId: "run-2",
          status: "completed",
          steps: [],
        }),
      ],
      turnItems: [],
    });

    expect(selected).toBeNull();
  });

  it("falls back to todo_list turnItems when plans has no todo_list", () => {
    const selected = selectLatestThreadTodoList({
      runs: [makeRun("run-1", 1)],
      plans: [],
      turnItems: [
        makeTodoTurnItem({
          id: "item-1",
          planId: "plan-from-item",
          runId: "run-1",
          ordinal: 5,
          explanation: "Item fallback",
          steps: [
            { id: "1", text: "Done", status: "completed" },
            { id: "2", text: "Active", status: "running" },
            { id: "3", text: "Queued", status: "pending" },
          ],
        }),
      ],
    });

    expect(selected).toEqual({
      planId: PlanId.make("plan-from-item"),
      status: "active",
      explanation: "Item fallback",
      completedCount: 1,
      runningCount: 1,
      pendingCount: 1,
      totalCount: 3,
      steps: [
        { id: "1", text: "Done", status: "completed" },
        { id: "2", text: "Active", status: "running" },
        { id: "3", text: "Queued", status: "pending" },
      ],
    });
  });
});

describe("hasActiveThreadRun", () => {
  it("reports true only when a run has an active status", () => {
    expect(hasActiveThreadRun(null)).toBe(false);
    expect(hasActiveThreadRun({ runs: [makeRun("run-1", 1, "completed")] })).toBe(false);
    expect(hasActiveThreadRun({ runs: [makeRun("run-2", 2, "running")] })).toBe(true);
  });
});
