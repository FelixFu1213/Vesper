import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vite-plus/test";

import { BackgroundJobManager, type BackgroundJobProcess } from "./backgroundJobs.ts";
import { createJobToolRouting, type JobToolDelegates } from "./jobToolRouting.ts";

interface FakeStream {
  readonly stream: NodeJS.ReadableStream;
  readonly push: (chunk: Buffer | string) => void;
}

const makeStream = (): FakeStream => {
  const listeners: Array<(chunk: Buffer) => void> = [];
  return {
    stream: {
      on: (_event: string, listener: (chunk: Buffer) => void) => {
        listeners.push(listener);
        return undefined;
      },
    } as unknown as NodeJS.ReadableStream,
    push: (chunk) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      for (const listener of listeners) listener(buffer);
    },
  };
};

interface FakeHandle {
  readonly process: BackgroundJobProcess;
  readonly kills: Array<NodeJS.Signals | number | undefined>;
  readonly pushStdout: (chunk: string) => void;
  readonly close: (code?: number) => void;
}

const makeFake = (options: { readonly stopCloses?: boolean } = {}): FakeHandle => {
  const stdout = makeStream();
  const stderr = makeStream();
  const listeners = new Map<string, Array<(...args: never[]) => void>>();
  const kills: Array<NodeJS.Signals | number | undefined> = [];
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) {
      (listener as (...values: unknown[]) => void)(...args);
    }
  };
  const handle: FakeHandle = {
    process: {
      pid: undefined,
      stdout: stdout.stream,
      stderr: stderr.stream,
      on: ((event: string, listener: (...args: never[]) => void) => {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
        return undefined;
      }) as BackgroundJobProcess["on"],
      kill: (signal?: NodeJS.Signals | number) => {
        kills.push(signal);
        if (options.stopCloses === true && signal === "SIGTERM") emit("close", 0, null);
        return true;
      },
    },
    kills,
    pushStdout: stdout.push,
    close: (code = 0) => emit("close", code, null),
  };
  return handle;
};

const makeJobs = (options: { readonly stopCloses?: boolean } = {}) => {
  const handles: FakeHandle[] = [];
  const manager = new BackgroundJobManager({
    now: () => 0,
    sleep: async () => undefined,
    spawn: () => {
      const handle = makeFake(options);
      handles.push(handle);
      return handle.process;
    },
  });
  return { manager, handles };
};

const startJob = (manager: BackgroundJobManager, command = "sleep 5"): string => {
  const snapshot = manager.start({
    command,
    executable: "/bin/sh",
    args: ["-c"],
    cwd: "/workspace",
    env: {},
  });
  return snapshot.job.id;
};

interface StubTool {
  readonly tool: AgentTool<any>;
  readonly calls: Array<Record<string, unknown>>;
}

const makeStub = (name: string, details: unknown): StubTool => {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    tool: {
      name,
      label: name,
      description: `${name} stub`,
      parameters: {},
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        calls.push(params);
        return { content: [{ type: "text" as const, text: "delegate" }], details };
      },
    },
  };
};

const makeDelegates = (): {
  readonly delegates: JobToolDelegates;
  readonly wait: StubTool;
  readonly list: StubTool;
  readonly stop: StubTool;
} => {
  const wait = makeStub("TaskWait", { wait: true });
  const list = makeStub("TaskList", { subagents: [{ id: "sub-1", status: "completed" }] });
  const stop = makeStub("TaskStop", { stoppedTaskIds: ["sub-1"], subagents: [] });
  return {
    wait,
    list,
    stop,
    delegates: { wait: wait.tool, list: list.tool, stop: stop.tool },
  };
};

const toolNamed = (tools: ReadonlyArray<AgentTool<any>>, name: string): AgentTool<any> => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
};

const textOf = (result: { readonly content: ReadonlyArray<unknown> }): string =>
  result.content.map((part) => (part as { readonly text?: string }).text ?? "").join("\n");

describe("TaskWait routing", () => {
  it("waits for a Bash job and returns its terminal snapshot", async () => {
    const { manager, handles } = makeJobs();
    const { delegates, wait } = makeDelegates();
    const routing = createJobToolRouting({ backgroundJobs: manager, delegates });
    const id = startJob(manager);
    handles[0]?.pushStdout("finished");
    handles[0]?.close(0);

    const result = await toolNamed(routing.tools, "TaskWait").execute(
      "call-1",
      { job: { kind: "bash", id }, timeoutMs: 0 },
      undefined,
      undefined,
    );
    expect(wait.calls).toHaveLength(0);
    expect(result.details).toMatchObject({
      status: "completed",
      job: { job: { kind: "bash", id }, state: "exited", stdout: "finished" },
    });
    expect(textOf(result)).toContain('"status":"completed"');
  });

  it("reports a timeout without killing the process", async () => {
    const { manager, handles } = makeJobs();
    const routing = createJobToolRouting({ backgroundJobs: manager });
    const id = startJob(manager);
    const result = await toolNamed(routing.tools, "TaskWait").execute(
      "call-1",
      { job: { kind: "bash", id }, timeoutMs: 0 },
      undefined,
      undefined,
    );
    expect(result.details).toMatchObject({ status: "timeout", job: { state: "running" } });
    expect(handles[0]?.kills).toEqual([]);
    expect(manager.get(id)?.state).toBe("running");
  });

  it("interrupts a Bash wait on steering without killing the process", async () => {
    const { manager, handles } = makeJobs();
    const routing = createJobToolRouting({ backgroundJobs: manager });
    const id = startJob(manager);
    const pending = toolNamed(routing.tools, "TaskWait").execute(
      "call-1",
      { job: { kind: "bash", id }, timeoutMs: 60_000 },
      undefined,
      undefined,
    );
    routing.interruptWaits();
    const result = await pending;
    expect(result.details).toMatchObject({ status: "interrupted", job: { state: "running" } });
    expect(handles[0]?.kills).toEqual([]);
  });

  it("validates the wait budget", async () => {
    const { manager } = makeJobs();
    const routing = createJobToolRouting({ backgroundJobs: manager });
    const id = startJob(manager);
    await expect(
      toolNamed(routing.tools, "TaskWait").execute(
        "call-1",
        { job: { kind: "bash", id }, timeoutSeconds: 0 },
        undefined,
        undefined,
      ),
    ).rejects.toThrowError(/timeoutSeconds must be between 1 and 21600/u);
  });

  it("rejects subagent selectors on a Bash job", async () => {
    const { manager } = makeJobs();
    const { delegates } = makeDelegates();
    const routing = createJobToolRouting({ backgroundJobs: manager, delegates });
    const id = startJob(manager);
    await expect(
      toolNamed(routing.tools, "TaskWait").execute(
        "call-1",
        { job: { kind: "bash", id }, delegationIds: ["sub-1"] },
        undefined,
        undefined,
      ),
    ).rejects.toThrowError(/A Bash job accepts only/u);
  });

  it("prefers delegationIds over a conflicting delegation job", async () => {
    const { manager } = makeJobs();
    const { delegates, wait } = makeDelegates();
    const routing = createJobToolRouting({ backgroundJobs: manager, delegates });
    await toolNamed(routing.tools, "TaskWait").execute(
      "call-1",
      {
        job: { kind: "delegation", id: "sub-1" },
        delegationIds: ["sub-1", "sub-2"],
        timeoutSeconds: 10,
      },
      undefined,
      undefined,
    );
    expect(wait.calls).toEqual([{ taskIds: ["sub-1", "sub-2"], timeoutMs: 10_000 }]);
  });

  it("routes a delegation job to the subagent wait", async () => {
    const { manager } = makeJobs();
    const { delegates, wait } = makeDelegates();
    const routing = createJobToolRouting({ backgroundJobs: manager, delegates });
    await toolNamed(routing.tools, "TaskWait").execute(
      "call-1",
      { job: { kind: "delegation", id: "sub-9" } },
      undefined,
      undefined,
    );
    expect(wait.calls).toEqual([{ taskIds: ["sub-9"] }]);
  });

  it("routes plain delegationIds to the subagent wait", async () => {
    const { manager } = makeJobs();
    const { delegates, wait } = makeDelegates();
    const routing = createJobToolRouting({ backgroundJobs: manager, delegates });
    await toolNamed(routing.tools, "TaskWait").execute(
      "call-1",
      { taskIds: ["sub-1"], delegationIds: ["sub-2"] },
      undefined,
      undefined,
    );
    expect(wait.calls).toEqual([{ taskIds: ["sub-1", "sub-2"] }]);
  });

  it("explains that subagents are disabled", async () => {
    const { manager } = makeJobs();
    const routing = createJobToolRouting({ backgroundJobs: manager });
    const result = await toolNamed(routing.tools, "TaskWait").execute(
      "call-1",
      { taskIds: ["sub-1"] },
      undefined,
      undefined,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Subagents are disabled");
  });
});

describe("TaskList routing", () => {
  it("lists subagents and background Bash jobs", async () => {
    const { manager } = makeJobs();
    const { delegates } = makeDelegates();
    const routing = createJobToolRouting({ backgroundJobs: manager, delegates });
    startJob(manager, "build");
    const result = await toolNamed(routing.tools, "TaskList").execute(
      "call-1",
      {},
      undefined,
      undefined,
    );
    expect(result.details).toMatchObject({
      subagents: [{ id: "sub-1", status: "completed" }],
      backgroundJobs: { supported: true, tasks: [{ command: "build", state: "running" }] },
    });
    expect(textOf(result)).toContain("Background Bash jobs:");
  });

  it("lists jobs when subagents are disabled", async () => {
    const { manager } = makeJobs();
    const routing = createJobToolRouting({ backgroundJobs: manager });
    const result = await toolNamed(routing.tools, "TaskList").execute(
      "call-1",
      {},
      undefined,
      undefined,
    );
    expect(result.details).toMatchObject({
      subagents: [],
      backgroundJobs: { supported: true, tasks: [] },
    });
    expect(textOf(result)).toContain("No background Bash jobs");
  });
});

describe("TaskStop routing", () => {
  it("never stops a Bash job when job is omitted", async () => {
    const { manager, handles } = makeJobs();
    const { delegates, stop } = makeDelegates();
    const routing = createJobToolRouting({ backgroundJobs: manager, delegates });
    const id = startJob(manager);
    await toolNamed(routing.tools, "TaskStop").execute("call-1", {}, undefined, undefined);
    expect(stop.calls).toEqual([{}]);
    expect(handles[0]?.kills).toEqual([]);
    expect(manager.get(id)?.state).toBe("running");
  });

  it("stops one Bash job and returns its terminal snapshot", async () => {
    const { manager } = makeJobs({ stopCloses: true });
    const routing = createJobToolRouting({ backgroundJobs: manager });
    const id = startJob(manager);
    const result = await toolNamed(routing.tools, "TaskStop").execute(
      "call-1",
      { job: { kind: "bash", id } },
      undefined,
      undefined,
    );
    expect(result.details).toMatchObject({
      status: "completed",
      job: { job: { kind: "bash", id }, state: "stopped" },
    });
  });

  it("reports stopPending when the process outlives the grace window", async () => {
    const { manager } = makeJobs();
    const routing = createJobToolRouting({ backgroundJobs: manager });
    const id = startJob(manager);
    const result = await toolNamed(routing.tools, "TaskStop").execute(
      "call-1",
      { job: { kind: "bash", id } },
      undefined,
      undefined,
    );
    expect(result.details).toMatchObject({ status: "stopPending", job: { state: "running" } });
  });

  it("routes a delegation job to the subagent stop", async () => {
    const { manager } = makeJobs();
    const { delegates, stop } = makeDelegates();
    const routing = createJobToolRouting({ backgroundJobs: manager, delegates });
    await toolNamed(routing.tools, "TaskStop").execute(
      "call-1",
      { job: { kind: "delegation", id: "sub-4" } },
      undefined,
      undefined,
    );
    expect(stop.calls).toEqual([{ taskId: "sub-4" }]);
  });

  it("stops every named delegation id", async () => {
    const { manager } = makeJobs();
    const { delegates, stop } = makeDelegates();
    const routing = createJobToolRouting({ backgroundJobs: manager, delegates });
    await toolNamed(routing.tools, "TaskStop").execute(
      "call-1",
      { delegationIds: ["sub-1", "sub-2"] },
      undefined,
      undefined,
    );
    expect(stop.calls).toEqual([{ taskId: "sub-1" }, { taskId: "sub-2" }]);
  });

  it("explains that no subagent was stopped when subagents are disabled", async () => {
    const { manager } = makeJobs();
    const routing = createJobToolRouting({ backgroundJobs: manager });
    const result = await toolNamed(routing.tools, "TaskStop").execute(
      "call-1",
      {},
      undefined,
      undefined,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Pass job to stop a background Bash job");
  });

  it("rejects a malformed job reference", async () => {
    const { manager } = makeJobs();
    const routing = createJobToolRouting({ backgroundJobs: manager });
    await expect(
      toolNamed(routing.tools, "TaskStop").execute(
        "call-1",
        { job: { kind: "bash", id: " " } },
        undefined,
        undefined,
      ),
    ).rejects.toThrowError(/nonempty id/u);
  });
});
