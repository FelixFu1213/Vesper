// @effect-diagnostics globalTimers:off -- A Bash wait is bounded by a timer, not by a sleep loop.
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { arr, lit, num, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";

import {
  MAX_BASH_TIMEOUT_SECONDS,
  type BackgroundJobManager,
  type BackgroundJobSnapshot,
} from "./backgroundJobs.ts";

const DEFAULT_WAIT_TIMEOUT_SECONDS = 60;

const JOB_SCHEMA = obj(
  {
    kind: union([lit("bash"), lit("delegation")], { description: "Who owns the job." }),
    id: str({ minLength: 1, description: "The id Bash or Task returned." }),
  },
  {
    description:
      "An explicit job returned by Bash or Task. For delegation jobs, a delegationIds array selecting other subagents takes precedence over job.id; an omitted/empty delegationIds or only this id targets just this job. For Bash jobs, omit delegationIds or pass an empty array, and omit mode/minCompleted or pass all/1.",
  },
);

const TASK_WAIT_PARAMS = obj({
  taskIds: opt(arr(str(), { description: "Subagent ids to wait for. Omit to wait for all." })),
  delegationIds: opt(
    arr(str(), { description: "Subagent ids to wait for, as strict model clients send them." }),
  ),
  timeoutMs: opt(num({ minimum: 0, description: "Give up waiting after this many milliseconds." })),
  timeoutSeconds: opt(
    num({
      minimum: 1,
      maximum: MAX_BASH_TIMEOUT_SECONDS,
      description: "Give up waiting after this many seconds.",
    }),
  ),
  mode: opt(oneOf(["all", "any"], { description: "Wait for every target or for the first one." })),
  minCompleted: opt(num({ minimum: 1, description: "How many targets must settle in any mode." })),
  job: opt(JOB_SCHEMA),
});

const TASK_LIST_PARAMS = obj({});

const TASK_STOP_PARAMS = obj({
  taskId: opt(str({ description: "Subagent id to stop. Omit to stop every running subagent." })),
  delegationIds: opt(arr(str(), { description: "Subagent ids to stop." })),
  job: opt(JOB_SCHEMA),
});

const text = (value: string) => ({ type: "text" as const, text: value });

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Accepts the shapes strict Responses-style clients send, and rejects the rest. */
function resolveJobTarget(params: {
  readonly job?: unknown;
  readonly delegationIds?: ReadonlyArray<string> | undefined;
  readonly mode?: string | undefined;
  readonly minCompleted?: number | undefined;
}): { readonly kind: "bash" | "delegation"; readonly id: string } | undefined {
  const job = params.job;
  if (job === undefined) return undefined;
  const record = asRecord(job);
  if (record === undefined) throw new Error("job must be an object with a kind and an id.");
  if (record.kind !== "bash" && record.kind !== "delegation") {
    throw new Error("job must contain a kind (bash or delegation) and a nonempty id");
  }
  if (typeof record.id !== "string" || record.id.trim() === "") {
    throw new Error("job must contain a kind (bash or delegation) and a nonempty id");
  }
  if (Object.keys(record).some((key) => key !== "kind" && key !== "id")) {
    throw new Error("job must contain only a kind (bash or delegation) and a nonempty id");
  }
  const id = record.id;
  if (record.kind === "delegation") {
    const delegationIds = params.delegationIds;
    if (delegationIds !== undefined) {
      if (
        !Array.isArray(delegationIds) ||
        delegationIds.some((value) => typeof value !== "string")
      ) {
        throw new Error(
          "delegationIds must be an array of delegation ids. To select subagents, drop job and retry with delegationIds; to target this one job, omit delegationIds.",
        );
      }
      // The multi-target path already honors delegationIds, so prefer it over the job.
      if (delegationIds.some((value) => value !== id)) return undefined;
    }
  } else if (
    (params.delegationIds !== undefined && params.delegationIds.length !== 0) ||
    (params.mode !== undefined && params.mode !== "all" && params.mode !== "any") ||
    (params.minCompleted !== undefined && params.minCompleted !== 1)
  ) {
    throw new Error(
      "A Bash job accepts only an omitted or empty delegationIds, an omitted/all/any mode and an omitted/1 minCompleted. To select subagents, omit job and use delegationIds.",
    );
  }
  return { kind: record.kind, id };
}

function observation(
  snapshot: BackgroundJobSnapshot,
  status: "completed" | "timeout" | "interrupted",
): AgentToolResult<{ readonly status: string; readonly job: BackgroundJobSnapshot }> {
  return {
    content: [text(JSON.stringify({ status, ...snapshot }))],
    details: { status, job: snapshot },
  };
}

function failure(message: string, details: unknown): AgentToolResult<unknown> {
  return { content: [text(message)], details, isError: true };
}

export interface JobToolDelegates {
  readonly wait?: AgentTool<any> | undefined;
  readonly list?: AgentTool<any> | undefined;
  readonly stop?: AgentTool<any> | undefined;
}

export interface JobToolRoutingDeps {
  readonly backgroundJobs: BackgroundJobManager;
  readonly delegates?: JobToolDelegates | undefined;
  readonly defaultWaitTimeoutSeconds?: number | undefined;
}

export interface JobToolRouting {
  readonly tools: ReadonlyArray<AgentTool<any>>;
  /** Steering interrupts a Bash wait without touching the process it waits on. */
  readonly interruptWaits: () => void;
}

const parseSeconds = (params: {
  readonly timeoutSeconds?: number | undefined;
}): number | undefined => {
  const seconds = params.timeoutSeconds;
  if (seconds === undefined) return undefined;
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > MAX_BASH_TIMEOUT_SECONDS) {
    throw new Error(`timeoutSeconds must be between 1 and ${MAX_BASH_TIMEOUT_SECONDS}`);
  }
  return seconds;
};

export const createJobToolRouting = (deps: JobToolRoutingDeps): JobToolRouting => {
  const manager = deps.backgroundJobs;
  const delegates = deps.delegates ?? {};
  const defaultWaitMs = (deps.defaultWaitTimeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS) * 1_000;
  const waitControllers = new Set<AbortController>();

  const delegationTargets = (params: {
    readonly taskIds?: ReadonlyArray<string> | undefined;
    readonly delegationIds?: ReadonlyArray<string> | undefined;
  }): ReadonlyArray<string> => [
    ...new Set([...(params.taskIds ?? []), ...(params.delegationIds ?? [])]),
  ];

  /** A subagent wait keeps its millisecond budget; seconds convert to it. */
  const delegationTimeout = (params: {
    readonly timeoutSeconds?: number | undefined;
    readonly timeoutMs?: number | undefined;
  }): { readonly timeoutMs?: number } => {
    const seconds = parseSeconds(params);
    if (seconds !== undefined) return { timeoutMs: Math.ceil(seconds * 1_000) };
    return params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs };
  };

  const taskWait: AgentTool<typeof TASK_WAIT_PARAMS> = {
    name: "TaskWait",
    label: "Wait for background work",
    description: [
      "Wait until the listed subagents finish, or until the turn receives steering. Waiting never stops anything.",
      'For a background Bash command, pass its job reference ({kind: "bash", id: backgroundTaskId}). Returns state, exitCode and bounded stdout/stderr tails. A timeout or an interrupted wait leaves the process running; call TaskWait again when needed.',
      "Omit job to keep the subagent defaults.",
    ].join("\n"),
    parameters: TASK_WAIT_PARAMS,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const job = resolveJobTarget(params);
      if (job === undefined) {
        if (delegates.wait === undefined) {
          return failure(
            "Subagents are disabled in this session, so there is nothing to wait for.",
            {
              tasks: [],
            },
          );
        }
        const targets = delegationTargets(params);
        return await delegates.wait.execute(
          toolCallId,
          {
            ...(targets.length === 0 ? {} : { taskIds: targets }),
            ...delegationTimeout(params),
          },
          signal,
          onUpdate,
        );
      }
      if (job.kind === "delegation") {
        if (delegates.wait === undefined) {
          return failure("Subagents are disabled in this session.", { taskIds: [job.id] });
        }
        return await delegates.wait.execute(
          toolCallId,
          { taskIds: [job.id], ...delegationTimeout(params) },
          signal,
          onUpdate,
        );
      }
      const seconds = parseSeconds(params);
      const budgetMs =
        seconds === undefined ? (params.timeoutMs ?? defaultWaitMs) : Math.ceil(seconds * 1_000);
      const controller = new AbortController();
      waitControllers.add(controller);
      const onOuterAbort = (): void => controller.abort();
      signal?.addEventListener("abort", onOuterAbort, { once: true });
      try {
        const snapshot = await manager.wait(job.id, budgetMs, controller.signal);
        const status =
          controller.signal.aborted || signal?.aborted === true
            ? "interrupted"
            : snapshot.state === "running"
              ? "timeout"
              : "completed";
        return observation(snapshot, status);
      } finally {
        waitControllers.delete(controller);
        signal?.removeEventListener("abort", onOuterAbort);
      }
    },
  };

  const taskList: AgentTool<typeof TASK_LIST_PARAMS> = {
    name: "TaskList",
    label: "List background work",
    description:
      "List the subagents this session spawned and its retained background Bash jobs, with their status and progress.",
    parameters: TASK_LIST_PARAMS,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const base =
        delegates.list === undefined
          ? {
              content: [text("Subagents are disabled in this session.")],
              details: { subagents: [] } as Record<string, unknown>,
            }
          : await delegates.list.execute(toolCallId, params, signal, onUpdate);
      const tasks = manager.list();
      const details = asRecord(base.details) ?? {};
      const summary =
        tasks.length === 0
          ? "No background Bash jobs are running or retained."
          : `Background Bash jobs: ${JSON.stringify(tasks)}`;
      return {
        ...base,
        content: [...base.content, text(summary)],
        details: { ...details, backgroundJobs: { supported: true, tasks } },
      };
    },
  };

  const taskStop: AgentTool<typeof TASK_STOP_PARAMS> = {
    name: "TaskStop",
    label: "Stop background work",
    description: [
      "Stop the listed subagents, or every running subagent when no id is given. Their reports are discarded.",
      "Pass job to stop one explicit Bash or delegation job. Omitting job never stops Bash processes. A Bash stopRequested flag acknowledges the request; only a terminal state confirms the outcome.",
    ].join("\n"),
    parameters: TASK_STOP_PARAMS,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const job = resolveJobTarget(params);
      if (job === undefined) {
        if (delegates.stop === undefined) {
          return failure(
            "Subagents are disabled in this session, so no subagent was stopped. Pass job to stop a background Bash job.",
            { stoppedTaskIds: [], subagents: [] },
          );
        }
        const targets = delegationTargets(params);
        if (targets.length === 0) {
          return await delegates.stop.execute(
            toolCallId,
            params.taskId === undefined ? {} : { taskId: params.taskId },
            signal,
            onUpdate,
          );
        }
        const stopped: Array<string> = [];
        const records: unknown[] = [];
        for (const target of targets) {
          const result = await delegates.stop.execute(
            toolCallId,
            { taskId: target },
            signal,
            onUpdate,
          );
          const details = asRecord(result.details) ?? {};
          const ids = Array.isArray(details.stoppedTaskIds) ? details.stoppedTaskIds : [];
          stopped.push(...ids.filter((id): id is string => typeof id === "string"));
          const subagents = Array.isArray(details.subagents) ? details.subagents : [];
          records.push(...subagents);
        }
        return {
          content: [
            text(
              stopped.length === 0
                ? "No running subagents were stopped."
                : `Stopped: ${stopped.join(", ")}.`,
            ),
          ],
          details: { stoppedTaskIds: stopped, subagents: records },
        };
      }
      if (job.kind === "delegation") {
        if (delegates.stop === undefined) {
          return failure("Subagents are disabled in this session.", { taskIds: [job.id] });
        }
        return await delegates.stop.execute(toolCallId, { taskId: job.id }, signal, onUpdate);
      }
      const outcome = await manager.stop(job.id);
      const status = outcome.stopPending ? "stopPending" : "completed";
      return {
        content: [text(JSON.stringify({ status, ...outcome.snapshot }))],
        details: { status, job: outcome.snapshot },
      };
    },
  };

  return {
    tools: [taskWait, taskList, taskStop],
    interruptWaits: () => {
      for (const controller of waitControllers) controller.abort();
    },
  };
};
