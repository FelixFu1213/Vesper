// @effect-diagnostics globalDate:off globalTimers:off -- Subagent timestamps and the AbortSignal-aware
// default sleep run outside an Effect runtime; callers inject `now` and `sleep` in tests.
import {
  Agent,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type AgentTool,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  contentText,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { arr, bool, num, obj, opt, str } from "@earendil-works/pi-schema";

export const MAX_SUBAGENT_REPORT_CHARS = 12_000;

const REPORT_TRUNCATION_SUFFIX = "...[truncated]";
const PROGRESS_REPORT_CHARS = 2_000;
const DEFAULT_STOP_SETTLE_GRACE_MS = 2_000;
const TITLE_CHARS = 60;

export type SubagentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface SubagentRecord {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly model: string;
  readonly status: SubagentStatus;
  readonly progress?: string;
  readonly result: string | null;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  readonly updatedAtMs: number;
}

export interface SubagentChildAgent {
  readonly run: () => Promise<string>;
  readonly abort: () => void;
}

export interface CreateChildAgentInput {
  readonly taskId: string;
  readonly prompt: string;
  readonly model?: string;
  readonly signal: AbortSignal;
  readonly onProgress?: (text: string) => void;
}

/** One model a subagent may be pointed at, from the parent's allowed bindings. */
export interface SubagentModelOption {
  readonly id: string;
  readonly label?: string | undefined;
}

export interface PiNativeChildAgentOptions {
  readonly defaultModel?: Model<Api>;
  /** The parent's current model, read at spawn time so a switch applies. */
  readonly getDefaultModel?: () => Model<Api> | undefined;
  readonly parentSessionId?: string | undefined;
  readonly streamFn?: StreamFn;
  readonly buildChildTools?: (input: { readonly taskId: string }) => ReadonlyArray<AgentTool<any>>;
  readonly systemPrompt?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly resolveModel?: (reference: string) => Model<Api> | undefined;
  readonly getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  readonly beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  readonly afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
}

export interface SubagentManagerDeps {
  readonly createChildAgent?: (input: CreateChildAgentInput) => Promise<SubagentChildAgent>;
  readonly childAgent?: PiNativeChildAgentOptions;
  readonly onSubagentEvent?: (record: SubagentRecord) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly nextId?: () => string;
  readonly defaultModelId?: string;
  /** The parent's current model id, read when a task starts. */
  readonly getDefaultModelId?: () => string | undefined;
  /** Opt-in model choices advertised in the Task tool description. */
  readonly availableModels?: () => ReadonlyArray<SubagentModelOption>;
  readonly maxReportChars?: number;
  readonly stopSettleGraceMs?: number;
}

export interface SubagentTaskToolResult {
  readonly taskId: string;
  readonly title: string;
  readonly status: SubagentStatus;
  readonly model: string;
  readonly result: string | null;
  readonly continuedInBackground: boolean;
}

export interface SubagentWaitToolResult {
  readonly interruptedBySteering: boolean;
  readonly timedOut: boolean;
  readonly runningTaskIds: ReadonlyArray<string>;
  readonly completed: ReadonlyArray<SubagentRecord>;
}

export interface SubagentListToolResult {
  readonly subagents: ReadonlyArray<SubagentRecord>;
}

export interface SubagentStopToolResult {
  readonly stoppedTaskIds: ReadonlyArray<string>;
  readonly subagents: ReadonlyArray<SubagentRecord>;
}

export interface SubagentManager {
  readonly tools: AgentTool<any>[];
  readonly interruptWaits: () => void;
  readonly hasRunningSubagents: () => boolean;
  readonly listSubagents: () => ReadonlyArray<SubagentRecord>;
  readonly getSubagent: (id: string) => SubagentRecord | undefined;
  readonly stopSubagents: (ids?: ReadonlyArray<string>) => Promise<ReadonlyArray<SubagentRecord>>;
  readonly stopAll: (
    status?: "cancelled" | "interrupted",
  ) => Promise<ReadonlyArray<SubagentRecord>>;
}

const taskParameters = obj({
  title: opt(str({ description: "Short label for the delegated task." })),
  prompt: str({ description: "Self-contained instructions for the subagent." }),
  model: opt(str({ description: "Model slug for the subagent." })),
  background: opt(bool({ description: "Return immediately and keep the subagent running." })),
});

const taskWaitParameters = obj({
  taskIds: opt(
    arr(str(), { description: "Subagent ids to wait for. Omit to wait for all running." }),
  ),
  timeoutMs: opt(num({ minimum: 0, description: "Give up waiting after this many milliseconds." })),
});

const taskListParameters = obj({});

const taskStopParameters = obj({
  taskId: opt(str({ description: "Subagent id to stop. Omit to stop every running subagent." })),
});

export const capSubagentReport = (
  text: string,
  maxChars: number = MAX_SUBAGENT_REPORT_CHARS,
): string => {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const keep = Math.max(0, maxChars - REPORT_TRUNCATION_SUFFIX.length);
  if (keep === 0) return REPORT_TRUNCATION_SUFFIX.slice(0, Math.max(0, maxChars));
  return `${trimmed.slice(0, keep)}${REPORT_TRUNCATION_SUFFIX}`;
};

const defaultTitle = (prompt: string): string => {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  if (line === "") return "Subagent";
  return line.length <= TITLE_CHARS ? line : `${line.slice(0, TITLE_CHARS - 3).trimEnd()}...`;
};

const TERMINAL_STATUSES: ReadonlySet<SubagentStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const isTerminal = (status: SubagentStatus): boolean => TERMINAL_STATUSES.has(status);

const failureText = (error: unknown): string =>
  error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "The subagent failed without a message.";

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const lastAssistantText = (messages: ReadonlyArray<Message>): string => {
  const assistant = messages.findLast(
    (message): message is AssistantMessage => message.role === "assistant",
  );
  if (assistant === undefined) {
    throw new Error("The subagent returned no assistant message.");
  }
  if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
    throw new Error("The subagent stopped before it reported a result.");
  }
  const text = contentText(assistant.content).trim();
  if (text === "") {
    throw new Error("The subagent returned an empty report.");
  }
  return text;
};

const makeAgentChildAgent = async (
  input: CreateChildAgentInput,
  options: PiNativeChildAgentOptions | undefined,
): Promise<SubagentChildAgent> => {
  if (options?.streamFn === undefined) {
    throw new Error(
      "Pi Native subagents need a child agent runner. Set a default model in Pi Native settings.",
    );
  }
  const fallbackModel = options.getDefaultModel?.() ?? options.defaultModel;
  const model =
    input.model === undefined
      ? fallbackModel
      : (options.resolveModel?.(input.model) ?? fallbackModel);
  if (model === undefined) {
    throw new Error("Pi Native has no model configured for subagents.");
  }
  const agent = new Agent({
    sessionId: options.parentSessionId
      ? `${options.parentSessionId}:${input.taskId}`
      : input.taskId,
    initialState: {
      model,
      tools: [...(options.buildChildTools?.({ taskId: input.taskId }) ?? [])],
      ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
      ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    },
    streamFn: options.streamFn,
    ...(options.getApiKey === undefined ? {} : { getApiKey: options.getApiKey }),
    ...(options.beforeToolCall === undefined ? {} : { beforeToolCall: options.beforeToolCall }),
    ...(options.afterToolCall === undefined ? {} : { afterToolCall: options.afterToolCall }),
  });
  const unsubscribe = agent.subscribe((event) => {
    if (event.type !== "message_update" || event.message.role !== "assistant") return;
    const text = contentText(event.message.content);
    if (text !== "") input.onProgress?.(text);
  });
  const onAbort = (): void => {
    agent.abort();
  };
  input.signal.addEventListener("abort", onAbort, { once: true });
  return {
    run: async () => {
      try {
        await agent.prompt(input.prompt);
        await agent.waitForIdle();
      } finally {
        input.signal.removeEventListener("abort", onAbort);
        unsubscribe();
      }
      return lastAssistantText(agent.state.messages);
    },
    abort: () => {
      agent.abort();
    },
  };
};

interface SubagentTask {
  record: SubagentRecord;
  readonly controller: AbortController;
  handle: SubagentChildAgent | undefined;
  readonly settlement: PromiseWithResolvers<SubagentRecord>;
  readonly runDone: PromiseWithResolvers<void>;
}

interface Waiter {
  readonly check: () => void;
  readonly interrupt: () => void;
}

type WaitOutcome = "settled" | "interrupted" | "timedOut";

export const makeSubagentManager = (deps: SubagentManagerDeps = {}): SubagentManager => {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const maxReportChars = deps.maxReportChars ?? MAX_SUBAGENT_REPORT_CHARS;
  const stopSettleGraceMs = deps.stopSettleGraceMs ?? DEFAULT_STOP_SETTLE_GRACE_MS;
  let sequence = 0;
  const nextId =
    deps.nextId ??
    (() => {
      sequence += 1;
      return `subagent-${sequence}`;
    });
  const tasks = new Map<string, SubagentTask>();
  const waiters = new Set<Waiter>();

  const notifyWaiters = (): void => {
    for (const waiter of waiters) waiter.check();
  };

  const update = (task: SubagentTask, patch: Partial<SubagentRecord>): SubagentRecord => {
    task.record = { ...task.record, ...patch, updatedAtMs: now() };
    deps.onSubagentEvent?.(task.record);
    notifyWaiters();
    return task.record;
  };

  const settle = (task: SubagentTask, status: SubagentStatus, result: string | null): void => {
    if (isTerminal(task.record.status)) return;
    const record = update(task, { status, result, completedAtMs: now() });
    task.settlement.resolve(record);
  };

  const isSettledId = (id: string): boolean => {
    const task = tasks.get(id);
    return task === undefined || isTerminal(task.record.status);
  };

  const waitFor = (
    targetIds: ReadonlyArray<string>,
    timeoutMs: number | undefined,
  ): Promise<WaitOutcome> => {
    const { promise, resolve } = Promise.withResolvers<WaitOutcome>();
    const timeoutController = new AbortController();
    let finished = false;
    const waiter: Waiter = {
      check: () => {
        if (!targetIds.every(isSettledId)) return;
        complete("settled");
      },
      interrupt: () => {
        complete("interrupted");
      },
    };
    const complete = (outcome: WaitOutcome): void => {
      if (finished) return;
      finished = true;
      waiters.delete(waiter);
      timeoutController.abort();
      resolve(outcome);
    };
    waiters.add(waiter);
    waiter.check();
    if (timeoutMs !== undefined) {
      void sleep(timeoutMs, timeoutController.signal).then(
        () => complete("timedOut"),
        () => complete("timedOut"),
      );
    }
    return promise;
  };

  const registerTask = (input: {
    readonly prompt: string;
    readonly title?: string;
    readonly model?: string;
  }): SubagentTask => {
    const id = nextId();
    const startedAtMs = now();
    const task: SubagentTask = {
      record: {
        id,
        title: input.title ?? defaultTitle(input.prompt),
        prompt: input.prompt,
        model: input.model ?? deps.getDefaultModelId?.() ?? deps.defaultModelId ?? "default",
        status: "running",
        result: null,
        startedAtMs,
        completedAtMs: null,
        updatedAtMs: startedAtMs,
      },
      controller: new AbortController(),
      handle: undefined,
      settlement: Promise.withResolvers<SubagentRecord>(),
      runDone: Promise.withResolvers<void>(),
    };
    tasks.set(id, task);
    deps.onSubagentEvent?.(task.record);
    return task;
  };

  const startChild = async (
    task: SubagentTask,
    prompt: string,
    model: string | undefined,
  ): Promise<void> => {
    if (isTerminal(task.record.status)) {
      task.runDone.resolve();
      return;
    }
    const onProgress = (text: string): void => {
      if (isTerminal(task.record.status)) return;
      update(task, { progress: capSubagentReport(text, PROGRESS_REPORT_CHARS) });
    };
    try {
      const childInput: CreateChildAgentInput = {
        taskId: task.record.id,
        prompt,
        ...(model === undefined ? {} : { model }),
        signal: task.controller.signal,
        onProgress,
      };
      const handle =
        deps.createChildAgent === undefined
          ? await makeAgentChildAgent(childInput, deps.childAgent)
          : await deps.createChildAgent(childInput);
      task.handle = handle;
      if (task.controller.signal.aborted) {
        handle.abort();
        task.runDone.resolve();
        return;
      }
      const run = handle.run();
      void run
        .then(
          (text) => {
            if (isTerminal(task.record.status)) return;
            settle(task, "completed", capSubagentReport(text, maxReportChars));
          },
          (error: unknown) => {
            if (isTerminal(task.record.status)) return;
            if (task.controller.signal.aborted) {
              settle(task, "cancelled", null);
              return;
            }
            settle(task, "failed", capSubagentReport(failureText(error), maxReportChars));
          },
        )
        .finally(() => task.runDone.resolve());
    } catch (error) {
      settle(task, "failed", capSubagentReport(failureText(error), maxReportChars));
      task.runDone.resolve();
    }
  };

  const activeTasks = (): ReadonlyArray<SubagentTask> =>
    [...tasks.values()].filter((task) => !isTerminal(task.record.status));

  const stopTasks = async (
    targets: ReadonlyArray<SubagentTask>,
    status: "cancelled" | "interrupted",
  ): Promise<ReadonlyArray<SubagentRecord>> => {
    for (const task of targets) {
      task.controller.abort();
      try {
        task.handle?.abort();
      } catch {
        // A child abort hook must never block the parent turn from stopping.
      }
      settle(task, status, null);
    }
    await Promise.all(
      targets.map((task) =>
        Promise.race([
          task.runDone.promise,
          sleep(stopSettleGraceMs).then(
            () => undefined,
            () => undefined,
          ),
        ]),
      ),
    );
    return targets.map((task) => ({ ...task.record }));
  };

  const stopTargets = (ids?: ReadonlyArray<string>): ReadonlyArray<SubagentTask> => {
    if (ids === undefined) return activeTasks();
    const seen = new Set<string>();
    const targets: Array<SubagentTask> = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const task = tasks.get(id);
      if (task === undefined || isTerminal(task.record.status)) continue;
      targets.push(task);
    }
    return targets;
  };

  const waitTargetIds = (ids: ReadonlyArray<string> | undefined): ReadonlyArray<string> => {
    if (ids !== undefined && ids.length > 0) return ids.filter((id) => tasks.has(id));
    return activeTasks().map((task) => task.record.id);
  };

  const waitResult = (
    targets: ReadonlyArray<string>,
    outcome: WaitOutcome,
  ): SubagentWaitToolResult => ({
    interruptedBySteering: outcome === "interrupted",
    timedOut: outcome === "timedOut",
    runningTaskIds: targets.filter((id) => !isSettledId(id)),
    completed: targets.flatMap((id) => {
      const task = tasks.get(id);
      return task === undefined || !isTerminal(task.record.status) ? [] : [{ ...task.record }];
    }),
  });

  const taskToolResult = (
    record: SubagentRecord,
    continuedInBackground: boolean,
  ): SubagentTaskToolResult => ({
    taskId: record.id,
    title: record.title,
    status: record.status,
    model: record.model,
    result: record.result,
    continuedInBackground,
  });

  const taskContent = (result: SubagentTaskToolResult): string => {
    const header = `${result.title} (${result.taskId}) is ${result.status}.`;
    if (result.result !== null && result.result !== "") return `${header}\n\n${result.result}`;
    return result.continuedInBackground
      ? `${header} It keeps running in the background; wait for it with TaskWait.`
      : header;
  };

  const waitContent = (result: SubagentWaitToolResult): string => {
    if (result.interruptedBySteering) {
      const running =
        result.runningTaskIds.length === 0 ? "none" : result.runningTaskIds.join(", ");
      return `Stopped waiting because the turn received steering. Still running: ${running}.`;
    }
    if (result.timedOut) {
      const running =
        result.runningTaskIds.length === 0 ? "none" : result.runningTaskIds.join(", ");
      return `Wait timed out. Still running: ${running}.`;
    }
    if (result.completed.length === 0) return "No subagents were running.";
    return result.completed
      .map((record) => taskContent(taskToolResult(record, false)))
      .join("\n\n");
  };

  const availableModelOptions = deps.availableModels?.() ?? [];
  const availableModelList =
    availableModelOptions.length === 0
      ? ""
      : ` Models you may pass as \`model\`: ${availableModelOptions
          .map((option) =>
            option.label === undefined || option.label === ""
              ? option.id
              : `${option.id} (${option.label})`,
          )
          .join(", ")}.`;
  const taskTool: AgentTool<typeof taskParameters> = {
    name: "Task",
    label: "Delegate a task",
    description: `Delegate a self-contained task to an in-process subagent. It reports only its final assistant text, so pass every detail the child needs.${availableModelList}`,
    parameters: taskParameters,
    execute: async (_toolCallId, params) => {
      const task = registerTask({
        prompt: params.prompt,
        ...(params.title === undefined ? {} : { title: params.title }),
        ...(params.model === undefined ? {} : { model: params.model }),
      });
      if (params.background === true) {
        void startChild(task, params.prompt, params.model);
        const result = taskToolResult(task.record, true);
        return { content: [{ type: "text", text: taskContent(result) }], details: result };
      }
      const waiting = waitFor([task.record.id], undefined);
      void startChild(task, params.prompt, params.model);
      const outcome = await waiting;
      const result = taskToolResult(task.record, outcome === "interrupted");
      return { content: [{ type: "text", text: taskContent(result) }], details: result };
    },
  };

  const taskWaitTool: AgentTool<typeof taskWaitParameters> = {
    name: "TaskWait",
    label: "Wait for subagents",
    description:
      "Wait until listed subagents finish, or until the turn receives steering. Waiting never stops a running subagent.",
    parameters: taskWaitParameters,
    execute: async (_toolCallId, params) => {
      const targets = waitTargetIds(params.taskIds);
      const outcome: WaitOutcome =
        targets.length === 0 ? "settled" : await waitFor(targets, params.timeoutMs);
      const result = waitResult(targets, outcome);
      return { content: [{ type: "text", text: waitContent(result) }], details: result };
    },
  };

  const taskListTool: AgentTool<typeof taskListParameters> = {
    name: "TaskList",
    label: "List subagents",
    description: "List the subagents this turn spawned, with their status and progress.",
    parameters: taskListParameters,
    execute: async () => {
      const result: SubagentListToolResult = {
        subagents: [...tasks.values()].map((task) => ({ ...task.record })),
      };
      const text =
        result.subagents.length === 0
          ? "No subagents have been spawned."
          : result.subagents
              .map(
                (record) =>
                  `${record.id} ${record.status} ${record.title}${record.progress === undefined ? "" : `: ${record.progress}`}`,
              )
              .join("\n");
      return { content: [{ type: "text", text }], details: result };
    },
  };

  const taskStopTool: AgentTool<typeof taskStopParameters> = {
    name: "TaskStop",
    label: "Stop subagents",
    description:
      "Stop the listed subagents, or every running subagent when no id is given. Their reports are discarded.",
    parameters: taskStopParameters,
    execute: async (_toolCallId, params) => {
      const targets = stopTargets(params.taskId === undefined ? undefined : [params.taskId]);
      const records = await stopTasks(targets, "cancelled");
      const result: SubagentStopToolResult = {
        stoppedTaskIds: records.map((record) => record.id),
        subagents: records,
      };
      const text =
        result.stoppedTaskIds.length === 0
          ? "No running subagents were stopped."
          : `Stopped: ${result.stoppedTaskIds.join(", ")}.`;
      return { content: [{ type: "text", text }], details: result };
    },
  };

  return {
    tools: [taskTool, taskWaitTool, taskListTool, taskStopTool],
    interruptWaits: () => {
      for (const waiter of waiters) waiter.interrupt();
    },
    hasRunningSubagents: () => activeTasks().length > 0,
    listSubagents: () => [...tasks.values()].map((task) => ({ ...task.record })),
    getSubagent: (id: string) => {
      const task = tasks.get(id);
      return task === undefined ? undefined : { ...task.record };
    },
    stopSubagents: async (ids?: ReadonlyArray<string>) => stopTasks(stopTargets(ids), "cancelled"),
    stopAll: async (status: "cancelled" | "interrupted" = "cancelled") =>
      stopTasks(activeTasks(), status),
  };
};
