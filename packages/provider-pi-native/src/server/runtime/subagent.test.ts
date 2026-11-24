import { contentText } from "@earendil-works/pi-ai";
import { describe, expect, it } from "@effect/vitest";

import {
  capSubagentReport,
  makeSubagentManager,
  MAX_SUBAGENT_REPORT_CHARS,
  type CreateChildAgentInput,
  type SubagentChildAgent,
  type SubagentManager,
  type SubagentRecord,
} from "./subagent.ts";

interface ChildFixture {
  readonly input: CreateChildAgentInput;
  readonly completion: PromiseWithResolvers<string>;
  aborted: boolean;
  readonly complete: (text: string) => void;
  readonly fail: (error: Error) => void;
}

const createChildFactory = () => {
  const children: Array<ChildFixture> = [];
  const createChildAgent = async (input: CreateChildAgentInput): Promise<SubagentChildAgent> => {
    const completion = Promise.withResolvers<string>();
    const fixture: ChildFixture = {
      input,
      completion,
      aborted: false,
      complete: (text) => completion.resolve(text),
      fail: (error) => completion.reject(error),
    };
    children.push(fixture);
    return {
      run: () => completion.promise,
      abort: () => {
        fixture.aborted = true;
      },
    };
  };
  return { children, createChildAgent };
};

const requireChild = (children: ReadonlyArray<ChildFixture>, index: number): ChildFixture => {
  const child = children.at(index);
  if (child === undefined) throw new Error(`expected child ${index} to be created`);
  return child;
};

const lastChild = (children: ReadonlyArray<ChildFixture>): ChildFixture =>
  requireChild(children, children.length - 1);

const createRecorder = () => {
  const events: Array<SubagentRecord> = [];
  const firstSettled = Promise.withResolvers<SubagentRecord>();
  const onSubagentEvent = (record: SubagentRecord): void => {
    events.push(record);
    if (record.status !== "running" && record.status !== "pending") {
      firstSettled.resolve(record);
    }
  };
  return { events, onSubagentEvent, settled: firstSettled.promise };
};

const countingClock = () => {
  let value = 0;
  return () => {
    value += 10;
    return value;
  };
};

const immediateSleep = async (): Promise<void> => {};

const createSleepController = () => {
  const pending: Array<() => void> = [];
  const sleep = (): Promise<void> =>
    new Promise((resolve) => {
      pending.push(resolve);
    });
  const release = (): void => {
    for (const resolve of pending.splice(0)) resolve();
  };
  return { pending, sleep, release };
};

const sequentialIds = () => {
  let value = 0;
  return () => {
    value += 1;
    return `sub-${value}`;
  };
};

const toolNamed = (manager: SubagentManager, name: string) => {
  const tool = manager.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
};

const managerWithChildren = (recorder: ReturnType<typeof createRecorder>) => {
  const factory = createChildFactory();
  const manager = makeSubagentManager({
    createChildAgent: factory.createChildAgent,
    onSubagentEvent: recorder.onSubagentEvent,
    now: countingClock(),
    nextId: sequentialIds(),
    sleep: immediateSleep,
  });
  return { factory, manager };
};

describe("capSubagentReport", () => {
  it("keeps short reports as written and marks a cut report", () => {
    expect(capSubagentReport("  done  ")).toBe("done");
    const capped = capSubagentReport("x".repeat(MAX_SUBAGENT_REPORT_CHARS + 500));
    expect(capped).toHaveLength(MAX_SUBAGENT_REPORT_CHARS);
    expect(capped.endsWith("...[truncated]")).toBe(true);
  });

  it("leaves a report of exactly the limit untouched", () => {
    const exact = "y".repeat(MAX_SUBAGENT_REPORT_CHARS);
    expect(capSubagentReport(exact)).toBe(exact);
  });
});

describe("makeSubagentManager", () => {
  it("runs a foreground subagent and reports its final text", async () => {
    const recorder = createRecorder();
    const { factory, manager } = managerWithChildren(recorder);
    const pending = toolNamed(manager, "Task").execute("call-1", {
      prompt: "Count the files",
      title: "Count files",
    });
    const child = requireChild(factory.children, 0);
    expect(child.input.taskId).toBe("sub-1");
    expect(child.input.prompt).toBe("Count the files");
    expect(manager.getSubagent("sub-1")?.status).toBe("running");
    child.complete("There are three files.");
    const result = await pending;
    expect(result.details).toEqual({
      taskId: "sub-1",
      title: "Count files",
      status: "completed",
      model: "default",
      result: "There are three files.",
      continuedInBackground: false,
    });
    expect(contentText(result.content)).toContain("There are three files.");
    expect(manager.hasRunningSubagents()).toBe(false);
  });

  it("returns immediately for a background subagent and lists its progress", async () => {
    const recorder = createRecorder();
    const { factory, manager } = managerWithChildren(recorder);
    const result = await toolNamed(manager, "Task").execute("call-1", {
      prompt: "Long job",
      background: true,
    });
    expect(result.details).toMatchObject({ status: "running", continuedInBackground: true });
    const child = lastChild(factory.children);
    child.input.onProgress?.("step 1");
    const listed = await toolNamed(manager, "TaskList").execute("call-2", {});
    expect(listed.details.subagents).toHaveLength(1);
    expect(listed.details.subagents[0]).toMatchObject({ status: "running", progress: "step 1" });
    child.complete("job done");
    await recorder.settled;
    expect(manager.getSubagent("sub-1")).toMatchObject({
      status: "completed",
      result: "job done",
    });
    expect(manager.listSubagents()).toHaveLength(1);
  });

  it("caps a long report at the shared limit", async () => {
    const recorder = createRecorder();
    const { factory, manager } = managerWithChildren(recorder);
    const pending = toolNamed(manager, "Task").execute("call-1", { prompt: "Spill" });
    lastChild(factory.children).complete("z".repeat(MAX_SUBAGENT_REPORT_CHARS + 2_000));
    const result = await pending;
    expect(result.details.result).toHaveLength(MAX_SUBAGENT_REPORT_CHARS);
    expect(result.details.result.endsWith("...[truncated]")).toBe(true);
    expect(manager.getSubagent("sub-1")?.result).toHaveLength(MAX_SUBAGENT_REPORT_CHARS);
  });

  it("settles a failing child as failed", async () => {
    const recorder = createRecorder();
    const { factory, manager } = managerWithChildren(recorder);
    const pending = toolNamed(manager, "Task").execute("call-1", { prompt: "Break" });
    lastChild(factory.children).fail(new Error("Model exploded"));
    const result = await pending;
    expect(result.details).toMatchObject({ status: "failed", result: "Model exploded" });
  });

  it("fails the task when no child runner is configured", async () => {
    const manager = makeSubagentManager({ now: countingClock() });
    const result = await toolNamed(manager, "Task").execute("call-1", { prompt: "Anything" });
    expect(result.details.status).toBe("failed");
    expect(result.details.result).toContain("child agent runner");
  });

  it("resolves TaskWait when the waited subagent finishes", async () => {
    const recorder = createRecorder();
    const { factory, manager } = managerWithChildren(recorder);
    await toolNamed(manager, "Task").execute("call-1", { prompt: "Work", background: true });
    const waiting = toolNamed(manager, "TaskWait").execute("call-2", { taskIds: ["sub-1"] });
    const child = lastChild(factory.children);
    child.complete("report");
    const result = await waiting;
    expect(result.details).toMatchObject({
      interruptedBySteering: false,
      timedOut: false,
      runningTaskIds: [],
    });
    expect(result.details.completed).toHaveLength(1);
    expect(result.details.completed[0]).toMatchObject({ result: "report" });
  });

  it("releases TaskWait on steering without aborting the subagent", async () => {
    const recorder = createRecorder();
    const { factory, manager } = managerWithChildren(recorder);
    await toolNamed(manager, "Task").execute("call-1", { prompt: "Work", background: true });
    const waiting = toolNamed(manager, "TaskWait").execute("call-2", { taskIds: ["sub-1"] });
    manager.interruptWaits();
    const result = await waiting;
    expect(result.details).toEqual({
      interruptedBySteering: true,
      timedOut: false,
      runningTaskIds: ["sub-1"],
      completed: [],
    });
    const child = lastChild(factory.children);
    expect(child.aborted).toBe(false);
    expect(manager.hasRunningSubagents()).toBe(true);
  });

  it("hands a foreground subagent to the background when steering interrupts", async () => {
    const recorder = createRecorder();
    const { factory, manager } = managerWithChildren(recorder);
    const pending = toolNamed(manager, "Task").execute("call-1", { prompt: "Work" });
    manager.interruptWaits();
    const result = await pending;
    expect(result.details).toMatchObject({ status: "running", continuedInBackground: true });
    const child = lastChild(factory.children);
    expect(child.aborted).toBe(false);
    child.complete("late report");
    await recorder.settled;
    expect(manager.getSubagent("sub-1")?.result).toBe("late report");
  });

  it("times out TaskWait and leaves the subagent running", async () => {
    const recorder = createRecorder();
    const controller = createSleepController();
    const factory = createChildFactory();
    const manager = makeSubagentManager({
      createChildAgent: factory.createChildAgent,
      onSubagentEvent: recorder.onSubagentEvent,
      now: countingClock(),
      nextId: sequentialIds(),
      sleep: controller.sleep,
    });
    await toolNamed(manager, "Task").execute("call-1", { prompt: "Slow", background: true });
    const waiting = toolNamed(manager, "TaskWait").execute("call-2", {
      taskIds: ["sub-1"],
      timeoutMs: 5_000,
    });
    controller.release();
    const result = await waiting;
    expect(result.details).toMatchObject({
      interruptedBySteering: false,
      timedOut: true,
      runningTaskIds: ["sub-1"],
    });
    expect(lastChild(factory.children).aborted).toBe(false);
  });

  it("stops one subagent and then every remaining one", async () => {
    const recorder = createRecorder();
    const { factory, manager } = managerWithChildren(recorder);
    await toolNamed(manager, "Task").execute("call-1", { prompt: "First", background: true });
    await toolNamed(manager, "Task").execute("call-2", { prompt: "Second", background: true });
    const stopped = await toolNamed(manager, "TaskStop").execute("call-3", { taskId: "sub-1" });
    expect(stopped.details.stoppedTaskIds).toEqual(["sub-1"]);
    expect(manager.getSubagent("sub-1")?.status).toBe("cancelled");
    expect(requireChild(factory.children, 0).aborted).toBe(true);
    expect(requireChild(factory.children, 1).aborted).toBe(false);
    const remaining = await manager.stopAll("interrupted");
    expect(remaining.map((record) => record.status)).toEqual(["interrupted"]);
    expect(remaining.map((record) => record.id)).toEqual(["sub-2"]);
    expect(requireChild(factory.children, 1).aborted).toBe(true);
    expect(manager.hasRunningSubagents()).toBe(false);
  });

  it("reports a stop of nothing when no subagent is running", async () => {
    const recorder = createRecorder();
    const { manager } = managerWithChildren(recorder);
    const result = await toolNamed(manager, "TaskStop").execute("call-1", {});
    expect(result.details.stoppedTaskIds).toEqual([]);
    expect(contentText(result.content)).toBe("No running subagents were stopped.");
  });

  it("keeps task records bounded after cancellation while the child is still pending", async () => {
    const recorder = createRecorder();
    const { factory, manager } = managerWithChildren(recorder);
    const pending = toolNamed(manager, "Task").execute("call-1", { prompt: "Never ends" });
    await toolNamed(manager, "TaskStop").execute("call-2", {});
    const result = await pending;
    expect(result.details).toMatchObject({ status: "cancelled", result: null });
    expect(lastChild(factory.children).completion.promise).toBeInstanceOf(Promise);
  });
});

describe("subagent model selection", () => {
  it("reads the parent's current default model id and advertises allowed models", async () => {
    const factory = createChildFactory();
    let current = "parent-model-v1";
    const manager = makeSubagentManager({
      createChildAgent: factory.createChildAgent,
      getDefaultModelId: () => current,
      availableModels: () => [{ id: "fast-model", label: "Fast" }, { id: "deep-model" }],
      now: countingClock(),
      nextId: sequentialIds(),
    });

    const description = toolNamed(manager, "Task").description;
    expect(description).toContain("fast-model (Fast)");
    expect(description).toContain("deep-model");

    const pending = toolNamed(manager, "Task").execute("call-1", { prompt: "Do it" });
    current = "parent-model-v2";
    const child = requireChild(factory.children, 0);
    expect(manager.getSubagent("sub-1")?.model).toBe("parent-model-v1");
    child.complete("done");
    const result = await pending;
    expect(result.details.model).toBe("parent-model-v1");

    const second = toolNamed(manager, "Task").execute("call-2", { prompt: "Again" });
    requireChild(factory.children, 1).complete("again");
    const secondResult = await second;
    expect(secondResult.details.model).toBe("parent-model-v2");
  });
});
