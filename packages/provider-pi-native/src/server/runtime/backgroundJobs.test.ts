// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- Background job tests drive fake processes and one real short child process.
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "vite-plus/test";

import {
  BackgroundJobManager,
  createHeadTailCapture,
  createTailCapture,
  normalizeBashTimeout,
  type BackgroundJobProcess,
  type BackgroundJobSnapshot,
} from "./backgroundJobs.ts";

const windows = HostProcess.Platform.defaultValue() === "win32";

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

interface FakeProcessHandle {
  readonly process: BackgroundJobProcess;
  readonly kills: Array<NodeJS.Signals | number | undefined>;
  readonly pushStdout: (chunk: Buffer | string) => void;
  readonly pushStderr: (chunk: Buffer | string) => void;
  readonly close: (code?: number | null) => void;
  readonly fail: () => void;
}

const makeProcess = (
  options: {
    readonly pid?: number;
    readonly onKill?: (signal: NodeJS.Signals | number | undefined) => void;
  } = {},
): FakeProcessHandle => {
  const stdout = makeStream();
  const stderr = makeStream();
  const listeners = new Map<string, Array<(...args: never[]) => void>>();
  const kills: Array<NodeJS.Signals | number | undefined> = [];
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) {
      (listener as (...values: unknown[]) => void)(...args);
    }
  };
  const process = {
    pid: options.pid,
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
      options.onKill?.(signal);
      return true;
    },
  } satisfies BackgroundJobProcess;
  return {
    process,
    kills,
    pushStdout: stdout.push,
    pushStderr: stderr.push,
    close: (code = 0) => emit("close", code, null),
    fail: () => emit("error", new Error("spawn failed")),
  };
};

const makeManager = (
  options: {
    readonly maxRunningJobs?: number;
    readonly maxFinishedJobs?: number;
    readonly onKill?: (signal: NodeJS.Signals | number | undefined) => void;
  } = {},
) => {
  const spawned: FakeProcessHandle[] = [];
  const exited: BackgroundJobSnapshot[] = [];
  let clock = 0;
  const manager = new BackgroundJobManager({
    now: () => (clock += 10),
    sleep: async () => undefined,
    spawn: () => {
      const handle = makeProcess(options);
      spawned.push(handle);
      return handle.process;
    },
    ...(options.maxRunningJobs === undefined ? {} : { maxRunningJobs: options.maxRunningJobs }),
    ...(options.maxFinishedJobs === undefined ? {} : { maxFinishedJobs: options.maxFinishedJobs }),
    onJobExited: (snapshot) => exited.push(snapshot),
  });
  return { manager, spawned, exited };
};

const startInput = (command = "printf hello") => ({
  command,
  executable: "/bin/sh",
  args: ["-c"],
  cwd: "/workspace",
  env: {},
});

describe("normalizeBashTimeout", () => {
  it("defaults to sixty seconds and accepts a seconds override", () => {
    expect(normalizeBashTimeout({})).toBe(60_000);
    expect(normalizeBashTimeout({ timeoutSeconds: 5 })).toBe(5_000);
    expect(normalizeBashTimeout({ timeoutSeconds: 21_600 })).toBe(21_600_000);
  });

  it("reads a past-the-ceiling seconds value as milliseconds", () => {
    expect(normalizeBashTimeout({ timeoutSeconds: 30_000 })).toBe(30_000);
    expect(normalizeBashTimeout({ timeoutSeconds: 21_601 })).toBe(22_000);
  });

  it("clamps without throwing", () => {
    expect(normalizeBashTimeout({ timeoutSeconds: 0 })).toBe(1_000);
    expect(normalizeBashTimeout({ timeoutSeconds: -5 })).toBe(1_000);
    expect(normalizeBashTimeout({ timeoutSeconds: 10_000_000 })).toBe(10_000_000);
  });

  it("keeps the legacy millisecond override and its defaults", () => {
    expect(normalizeBashTimeout({ timeoutMs: 1_234 })).toBe(1_234);
    expect(normalizeBashTimeout({ defaultTimeoutMs: 120_000 })).toBe(120_000);
    expect(normalizeBashTimeout({ timeoutSeconds: 5, defaultTimeoutMs: 120_000 })).toBe(5_000);
    expect(normalizeBashTimeout({ timeoutSeconds: 21_600, maxTimeoutMs: 600_000 })).toBe(600_000);
    expect(normalizeBashTimeout({ timeoutMs: 900_000, maxTimeoutMs: 600_000 })).toBe(600_000);
  });
});

describe("stream captures", () => {
  it("keeps multibyte characters split across chunks intact", () => {
    const capture = createHeadTailCapture(64);
    const emoji = Buffer.from("😀", "utf8");
    capture.push(emoji.subarray(0, 2));
    capture.push(emoji.subarray(2));
    capture.push(Buffer.from(" done", "utf8"));
    capture.end();
    expect(capture.text()).toBe("😀 done");
    expect(capture.truncated()).toBe(false);
  });

  it("keeps head and tail of a long foreground stream apart with a marker", () => {
    const capture = createHeadTailCapture(8);
    capture.push("abcdefghij");
    capture.end();
    expect(capture.truncated()).toBe(true);
    expect(capture.text()).toContain("[output truncated]");
    expect(capture.text().startsWith("abcd")).toBe(true);
    expect(capture.text().endsWith("ghij")).toBe(true);
  });

  it("keeps only the tail of a background stream", () => {
    const capture = createTailCapture(4);
    capture.push("abcdefgh");
    capture.end();
    expect(capture.text()).toBe("efgh");
    expect(capture.truncated()).toBe(true);

    const exact = createTailCapture(4);
    exact.push("abcd");
    exact.end();
    expect(exact.text()).toBe("abcd");
    expect(exact.truncated()).toBe(false);
  });
});

describe("BackgroundJobManager", () => {
  it("starts a detached job and reports it as running", () => {
    const { manager, spawned } = makeManager();
    const snapshot = manager.start(startInput("sleep 5"));
    expect(snapshot.job).toEqual({ kind: "bash", id: "bash-1" });
    expect(snapshot.command).toBe("sleep 5");
    expect(snapshot.state).toBe("running");
    expect(snapshot.exitCode).toBeNull();
    expect(spawned).toHaveLength(1);
    expect(manager.hasRunningJobs()).toBe(true);
    expect(manager.list()).toHaveLength(1);
  });

  it("refuses more than ten running jobs per session", () => {
    const { manager } = makeManager();
    for (let index = 0; index < 10; index++) manager.start(startInput());
    expect(() => manager.start(startInput())).toThrowError(/maximum of 10 background Bash jobs/u);
  });

  it("publishes a terminal state after the output drains", async () => {
    const { manager, spawned, exited } = makeManager();
    const started = manager.start(startInput());
    const handle = spawned[0];
    if (handle === undefined) throw new Error("expected a spawned process");
    handle.pushStdout("out");
    handle.pushStderr("err");
    handle.close(3);
    const snapshot = await manager.wait(started.job.id, 1_000);
    expect(snapshot.state).toBe("failed");
    expect(snapshot.exitCode).toBe(3);
    expect(snapshot.stdout).toBe("out");
    expect(snapshot.stderr).toBe("err");
    expect(manager.hasRunningJobs()).toBe(false);
    // Notifications require an explicit opt-in.
    expect(exited).toHaveLength(0);
  });

  it("returns a running snapshot when a wait times out without killing", async () => {
    const { manager, spawned } = makeManager();
    const started = manager.start(startInput());
    const snapshot = await manager.wait(started.job.id, 0);
    expect(snapshot.state).toBe("running");
    expect(spawned[0]?.kills).toEqual([]);
  });

  it("resolves a wait when the caller aborts without killing", async () => {
    const { manager, spawned } = makeManager();
    const started = manager.start(startInput());
    const controller = new AbortController();
    controller.abort();
    const snapshot = await manager.wait(started.job.id, 1_000, controller.signal);
    expect(snapshot.state).toBe("running");
    expect(spawned[0]?.kills).toEqual([]);
  });

  it("stops with SIGTERM and reports the settled state", async () => {
    let handle: FakeProcessHandle;
    const manager = new BackgroundJobManager({
      now: () => 0,
      sleep: async () => undefined,
      spawn: () => {
        handle = makeProcess({
          onKill: (signal) => {
            if (signal === "SIGTERM") handle.close(0);
          },
        });
        return handle.process;
      },
    });
    const started = manager.start(startInput());
    const outcome = await manager.stop(started.job.id);
    expect(handle!.kills).toEqual(["SIGTERM"]);
    expect(outcome.stopPending).toBe(false);
    expect(outcome.snapshot.state).toBe("stopped");
    expect(outcome.snapshot.stopRequested).toBe(true);
  });

  it("escalates to SIGKILL and reports stopPending while the process survives", async () => {
    const { manager, spawned } = makeManager();
    const started = manager.start(startInput());
    const outcome = await manager.stop(started.job.id);
    expect(spawned[0]?.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(outcome.stopPending).toBe(true);
    expect(outcome.snapshot.state).toBe("running");
    expect(outcome.snapshot.stopRequested).toBe(true);
  });

  it("does not signal an already finished job", async () => {
    const { manager, spawned } = makeManager();
    const started = manager.start(startInput());
    spawned[0]?.close(0);
    await manager.wait(started.job.id, 1_000);
    const outcome = await manager.stop(started.job.id);
    expect(outcome.stopPending).toBe(false);
    expect(outcome.snapshot.state).toBe("exited");
    expect(spawned[0]?.kills).toEqual([]);
  });

  it("signals every running job", async () => {
    const { manager, spawned } = makeManager();
    manager.start(startInput());
    manager.start(startInput());
    await manager.stopAll();
    expect(spawned.flatMap((handle) => handle.kills)).toEqual([
      "SIGTERM",
      "SIGKILL",
      "SIGTERM",
      "SIGKILL",
    ]);
  });

  it("notifies once for a notifying job only", async () => {
    const { manager, spawned, exited } = makeManager();
    manager.start({ ...startInput(), notifyOnExit: true });
    manager.start(startInput());
    for (const handle of spawned) {
      handle.pushStdout("done");
      handle.close(0);
    }
    expect(exited).toHaveLength(1);
    expect(exited[0]?.stdout).toBe("done");
    expect(exited[0]?.state).toBe("exited");
  });

  it("retains a bounded finished history", async () => {
    const { manager, spawned } = makeManager({ maxFinishedJobs: 2 });
    for (let index = 0; index < 3; index++) {
      manager.start(startInput());
      spawned.at(index)?.close(0);
    }
    const ids = manager.list().map((summary) => summary.job.id);
    expect(ids).toEqual(["bash-2", "bash-3"]);
  });

  it("rejects unknown ids", async () => {
    const { manager } = makeManager();
    await expect(manager.wait("bash-404", 0)).rejects.toThrowError(/Unknown background job/u);
    await expect(manager.stop("bash-404")).rejects.toThrowError(/Unknown background job/u);
  });

  it.skipIf(windows)("drains a real child process's separated streams", async () => {
    const manager = new BackgroundJobManager();
    const started = manager.start({
      ...startInput(),
      cwd: process.cwd(),
      executable: process.execPath,
      args: ["-e"],
      command: "process.stdout.write('out'); process.stderr.write('err'); process.exit(3);",
    });
    const snapshot = await manager.wait(started.job.id, 10_000);
    expect(snapshot.state).toBe("failed");
    expect(snapshot.exitCode).toBe(3);
    expect(snapshot.stdout).toBe("out");
    expect(snapshot.stderr).toBe("err");
    expect(snapshot.job).toEqual({ kind: "bash", id: "bash-1" });
  });
});
