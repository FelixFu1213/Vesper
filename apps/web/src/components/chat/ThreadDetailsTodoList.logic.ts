import type {
  OrchestrationV2PlanArtifact,
  OrchestrationV2PlanStep,
  PlanId,
} from "@t3tools/contracts";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";

export interface ThreadTodoListSummary {
  readonly planId: PlanId | null;
  readonly steps: ReadonlyArray<OrchestrationV2PlanStep>;
  readonly explanation?: string;
  readonly status: "draft" | "active" | "completed";
  readonly completedCount: number;
  readonly runningCount: number;
  readonly pendingCount: number;
  readonly totalCount: number;
}

type TodoListPlan = Extract<OrchestrationV2PlanArtifact, { readonly kind: "todo_list" }>;
type TodoListTurnItem = Extract<
  ThreadStructure["turnItems"][number],
  { readonly type: "todo_list" }
>;

function summarizeSteps(
  steps: ReadonlyArray<OrchestrationV2PlanStep>,
): Pick<ThreadTodoListSummary, "completedCount" | "runningCount" | "pendingCount" | "totalCount"> {
  let completedCount = 0;
  let runningCount = 0;
  let pendingCount = 0;
  for (const step of steps) {
    if (step.status === "completed") completedCount += 1;
    else if (step.status === "running") runningCount += 1;
    else pendingCount += 1;
  }
  return {
    completedCount,
    runningCount,
    pendingCount,
    totalCount: steps.length,
  };
}

function compareOrder(
  candidate: readonly [number, number, number],
  currentBest: readonly [number, number, number],
): number {
  if (candidate[0] !== currentBest[0]) return candidate[0] - currentBest[0];
  if (candidate[1] !== currentBest[1]) return candidate[1] - currentBest[1];
  return candidate[2] - currentBest[2];
}

export function selectLatestThreadTodoList(
  projection: Pick<ThreadStructure, "plans" | "runs" | "turnItems"> | null | undefined,
): ThreadTodoListSummary | null {
  if (projection == null) return null;

  const runOrdinalById = new Map(projection.runs.map((run) => [run.id, run.ordinal] as const));
  const itemOrdinalByPlanId = new Map<PlanId, number>();
  const todoTurnItems: Array<{ readonly item: TodoListTurnItem; readonly index: number }> = [];

  for (let index = 0; index < projection.turnItems.length; index += 1) {
    const item = projection.turnItems[index];
    if (item?.type !== "todo_list") continue;
    todoTurnItems.push({ item, index });
    const previous = itemOrdinalByPlanId.get(item.planId);
    if (previous === undefined || item.ordinal > previous) {
      itemOrdinalByPlanId.set(item.planId, item.ordinal);
    }
  }

  const todoPlans = projection.plans.filter(
    (plan): plan is TodoListPlan => plan.kind === "todo_list",
  );

  if (todoPlans.length > 0) {
    let best: {
      readonly plan: TodoListPlan;
      readonly order: readonly [number, number, number];
    } | null = null;

    for (let index = 0; index < todoPlans.length; index += 1) {
      const plan = todoPlans[index]!;
      if (plan.status === "superseded") continue;
      const runOrdinal = plan.runId === null ? -1 : (runOrdinalById.get(plan.runId) ?? -1);
      const itemOrdinal = itemOrdinalByPlanId.get(plan.id) ?? -1;
      const order = [runOrdinal, itemOrdinal, index] as const;
      if (best === null || compareOrder(order, best.order) > 0) {
        best = { plan, order };
      }
    }

    if (best === null) {
      return null;
    }

    const { plan } = best;
    if (plan.status === "superseded" || plan.steps.length === 0) {
      return null;
    }

    return {
      planId: plan.id,
      steps: plan.steps,
      ...(plan.explanation === undefined ? {} : { explanation: plan.explanation }),
      status: plan.status,
      ...summarizeSteps(plan.steps),
    };
  }

  if (todoTurnItems.length === 0) return null;

  let bestItem: {
    readonly item: TodoListTurnItem;
    readonly order: readonly [number, number, number];
  } | null = null;

  for (const { item, index } of todoTurnItems) {
    const runOrdinal = item.runId === null ? -1 : (runOrdinalById.get(item.runId) ?? -1);
    const order = [runOrdinal, item.ordinal, index] as const;
    if (bestItem === null || compareOrder(order, bestItem.order) > 0) {
      bestItem = { item, order };
    }
  }

  if (bestItem === null || bestItem.item.steps.length === 0) return null;

  const { item } = bestItem;
  const status = item.steps.every((step) => step.status === "completed") ? "completed" : "active";
  return {
    planId: item.planId,
    steps: item.steps,
    ...(item.explanation === undefined ? {} : { explanation: item.explanation }),
    status,
    ...summarizeSteps(item.steps),
  };
}

export function hasActiveThreadRun(
  projection: Pick<ThreadStructure, "runs"> | null | undefined,
): boolean {
  return (
    projection?.runs.some(
      (run) =>
        run.status === "preparing" ||
        run.status === "queued" ||
        run.status === "starting" ||
        run.status === "running" ||
        run.status === "waiting",
    ) === true
  );
}
