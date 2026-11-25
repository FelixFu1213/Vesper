// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- Background jobs own child processes, time their waits, and stamp elapsed time outside an Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeStringDecoder from "node:string_decoder";

import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";

/** Model-facing references preserve the execution owner's native identifier. */
export type JobReference = { readonly kind: "bash" | "delegation"; readonly id: string };

export type BackgroundJobStatus = "running" | "exited" | "failed" | "stopped";

export interface BackgroundJobSummary {
  readonly job: JobReference;
  readonly command: string;
  readonly commandTruncated?: boolean;
  readonly state: BackgroundJobStatus;
  readonly elapsedMs: number;
  readonly exitCode: number | null;
  readonly stopRequested: boolean;
}

export interface BackgroundJobSnapshot extends BackgroundJobSummary {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface BackgroundJobStopOutcome {
  readonly snapshot: BackgroundJobSnapshot;
  readonly stopPending: boolean;
}

export const MAX_BASH_TIMEOUT_SECONDS = 21_600;
const DEFAULT_BASH_TIMEOUT_SECONDS = 60;
const DEFAULT_BASH_TIMEOUT_MS = DEFAULT_BASH_TIMEOUT_SECONDS * 1_000;
const MAX_BASH_TIMEOUT_MS = MAX_BASH_TIMEOUT_SECONDS * 1_000;

const DEFAULT_MAX_RUNNING_JOBS = 10;
const DEFAULT_MAX_FINISHED_JOBS = 50;
const BACKGROUND_TAIL_BYTES = 256 * 1_024;
const DEFAULT_STOP_GRACE_MS = 2_000;
const SETTLE_AFTER_KILL_MS = 500;
const COMMAND_PREVIEW_CHARS = 2_000;

export interface BashTimeoutRequest {
  readonly timeoutSeconds?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly defaultTimeoutMs?: number | undefined;
  readonly maxTimeoutMs?: number | undefined;
}

/** `timeoutSeconds` wins; a value past the six-hour ceiling is read as milliseconds. */
export const normalizeBashTimeout = (request: BashTimeoutRequest): number => {
  const maxMs = request.maxTimeoutMs ?? MAX_BASH_TIMEOUT_MS;
  if (typeof request.timeoutSeconds === "number" && Number.isFinite(request.timeoutSeconds)) {
    const raw =
      request.timeoutSeconds > MAX_BASH_TIMEOUT_SECONDS
        ? Math.round(request.timeoutSeconds / 1_000)
        : Math.round(request.timeoutSeconds);
    const seconds = Math.min(Math.max(raw, 1), MAX_BASH_TIMEOUT_SECONDS);
    return Math.min(seconds * 1_000, maxMs);
  }
  if (typeof request.timeoutMs === "number" && Number.isFinite(request.timeoutMs)) {
    return Math.min(Math.max(Math.round(request.timeoutMs), 1), maxMs);
  }
  return Math.min(request.defaultTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS, maxMs);
};

const TRUNCATION_MARKER = "\n\n[output truncated]\n\n";

export interface StreamCapture {
  readonly push: (chunk: Buffer | string) => void;
  readonly end: () => void;
  readonly text: () => string;
  readonly truncated: () => boolean;
}

const decode = (decoder: NodeStringDecoder.StringDecoder, chunk: Buffer | string): string =>
  typeof chunk === "string" ? chunk : decoder.write(chunk);

/** Foreground capture keeps both ends, so the start and the outcome stay readable. */
export const createHeadTailCapture = (maxBytes: number): StreamCapture => {
  const decoder = new NodeStringDecoder.StringDecoder("utf8");
  const half = Math.max(1, Math.floor(maxBytes / 2));
  let head = "";
  let tail = "";
  let trimmed = false;
  const append = (chunk: string): void => {
    if (chunk === "") return;
    if (!trimmed && head.length + chunk.length <= maxBytes) {
      head += chunk;
      return;
    }
    if (!trimmed) {
      const combined = head + chunk;
      trimmed = true;
      tail = combined.slice(-half);
      head = combined.slice(0, Math.max(0, combined.length - half));
      return;
    }
    tail = (tail + chunk).slice(-half);
  };
  return {
    push: (chunk) => append(decode(decoder, chunk)),
    end: () => append(decode(decoder, decoder.end())),
    text: () => (trimmed ? `${head}${TRUNCATION_MARKER}${tail}` : head),
    truncated: () => trimmed,
  };
};

/** Background capture keeps only the tail; a long-running log's end is what matters. */
export const createTailCapture = (maxBytes: number): StreamCapture => {
  const decoder = new NodeStringDecoder.StringDecoder("utf8");
  let buffer = "";
  let trimmed = false;
  const append = (chunk: string): void => {
    if (chunk === "") return;
    const combined = buffer + chunk;
    if (combined.length > maxBytes) {
      trimmed = true;
      buffer = combined.slice(-maxBytes);
      return;
    }
    buffer = combined;
  };
  return {
    push: (chunk) => append(decode(decoder, chunk)),
    end: () => append(decode(decoder, decoder.end())),
    text: () => buffer,
    truncated: () => trimmed,
  };
};

export interface BackgroundJobProcess {
  readonly pid?: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type BackgroundJobSpawn = (
  executable: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.SpawnOptions,
) => BackgroundJobProcess;

export interface BackgroundJobStartInput {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Ask the runtime for a continuation when the job ends. */
  readonly notifyOnExit?: boolean | undefined;
}

export interface BackgroundJobManagerOptions {
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly spawn?: BackgroundJobSpawn | undefined;
  readonly nextId?: (() => string) | undefined;
  readonly maxRunningJobs?: number | undefined;
  readonly maxFinishedJobs?: number | undefined;
  readonly tailBytes?: number | undefined;
  readonly stopGraceMs?: number | undefined;
  readonly settleAfterKillMs?: number | undefined;
  /** Every terminal state, so the session can publish it. */
  readonly onJobUpdated?: ((snapshot: BackgroundJobSnapshot) => void) | undefined;
  /** Only jobs started with notifyOnExit, which ask for a follow-up. */
  readonly onJobExited?: ((snapshot: BackgroundJobSnapshot) => void) | undefined;
}

interface JobRecord {
  readonly id: string;
  readonly command: string;
  readonly commandTruncated: boolean;
  readonly startedAtMs: number;
  readonly stdout: StreamCapture;
  readonly stderr: StreamCapture;
  readonly child: BackgroundJobProcess;
  readonly notifyOnExit: boolean;
  readonly settled: PromiseWithResolvers<BackgroundJobSnapshot>;
  state: BackgroundJobStatus;
  endedAtMs: number | null;
  exitCode: number | null;
  stopRequested: boolean;
}

const defaultSpawn: BackgroundJobSpawn = (executable, args, options) =>
  NodeChildProcess.spawn(executable, [...args], options) as unknown as BackgroundJobProcess;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Owns one session's detaching Bash processes. They outlive the turn that started them
 * and are stopped only by an explicit stop, the session limit, or session disposal.
 */
export class BackgroundJobManager {
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #spawn: BackgroundJobSpawn;
  readonly #nextId: () => string;
  readonly #maxRunningJobs: number;
  readonly #maxFinishedJobs: number;
  readonly #tailBytes: number;
  readonly #stopGraceMs: number;
  readonly #settleAfterKillMs: number;
  readonly #onJobUpdated: ((snapshot: BackgroundJobSnapshot) => void) | undefined;
  readonly #onJobExited: ((snapshot: BackgroundJobSnapshot) => void) | undefined;
  readonly #jobs = new Map<string, JobRecord>();
  readonly #finished: Array<string> = [];
  readonly #waiters = new Set<() => void>();
  #sequence = 0;

  constructor(options: BackgroundJobManagerOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? defaultSleep;
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#nextId =
      options.nextId ??
      (() => {
        this.#sequence += 1;
        return `bash-${this.#sequence}`;
      });
    this.#maxRunningJobs = options.maxRunningJobs ?? DEFAULT_MAX_RUNNING_JOBS;
    this.#maxFinishedJobs = options.maxFinishedJobs ?? DEFAULT_MAX_FINISHED_JOBS;
    this.#tailBytes = options.tailBytes ?? BACKGROUND_TAIL_BYTES;
    this.#stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.#settleAfterKillMs = options.settleAfterKillMs ?? SETTLE_AFTER_KILL_MS;
    this.#onJobUpdated = options.onJobUpdated;
    this.#onJobExited = options.onJobExited;
  }

  #summary(record: JobRecord): BackgroundJobSummary {
    const endedAtMs = record.endedAtMs ?? this.#now();
    return {
      job: { kind: "bash", id: record.id },
      command: record.command,
      ...(record.commandTruncated ? { commandTruncated: true } : {}),
      state: record.state,
      elapsedMs: Math.max(0, endedAtMs - record.startedAtMs),
      exitCode: record.exitCode,
      stopRequested: record.stopRequested,
    };
  }

  #snapshot(record: JobRecord): BackgroundJobSnapshot {
    return {
      ...this.#summary(record),
      stdout: record.stdout.text(),
      stderr: record.stderr.text(),
      truncated: record.stdout.truncated() || record.stderr.truncated(),
    };
  }

  #notifyWaiters(): void {
    for (const waiter of this.#waiters) waiter();
  }

  #signal(record: JobRecord, signal: NodeJS.Signals): void {
    const pid = record.child.pid;
    if (pid !== undefined) {
      try {
        signalProcessGroup(pid, signal);
        return;
      } catch {
        // The group may already be gone; the single process signal still applies.
      }
    }
    try {
      record.child.kill(signal);
    } catch {
      // A process that already exited needs no signal.
    }
  }

  #publish(record: JobRecord): void {
    if (record.state !== "running") return;
    record.endedAtMs = this.#now();
    record.stdout.end();
    record.stderr.end();
    record.state = record.stopRequested ? "stopped" : record.exitCode === 0 ? "exited" : "failed";
    this.#finished.push(record.id);
    while (this.#finished.length > this.#maxFinishedJobs) {
      const oldest = this.#finished.shift();
      if (oldest !== undefined) this.#jobs.delete(oldest);
    }
    const snapshot = this.#snapshot(record);
    record.settled.resolve(snapshot);
    this.#notifyWaiters();
    this.#onJobUpdated?.(snapshot);
    if (record.notifyOnExit) this.#onJobExited?.(snapshot);
  }

  get runningCount(): number {
    return [...this.#jobs.values()].filter((record) => record.state === "running").length;
  }

  hasRunningJobs(): boolean {
    return this.runningCount > 0;
  }

  start(input: BackgroundJobStartInput): BackgroundJobSnapshot {
    if (this.runningCount >= this.#maxRunningJobs) {
      throw new Error(
        `This session already runs the maximum of ${this.#maxRunningJobs} background Bash jobs. Wait for one with TaskWait or stop one with TaskStop before starting another.`,
      );
    }
    const id = this.#nextId();
    const commandTruncated = input.command.length > COMMAND_PREVIEW_CHARS;
    const stdout = createTailCapture(this.#tailBytes);
    const stderr = createTailCapture(this.#tailBytes);
    const child = this.#spawn(input.executable, [...input.args, input.command], {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const record: JobRecord = {
      id,
      command: commandTruncated ? input.command.slice(0, COMMAND_PREVIEW_CHARS) : input.command,
      commandTruncated,
      startedAtMs: this.#now(),
      stdout,
      stderr,
      child,
      notifyOnExit: input.notifyOnExit === true,
      settled: Promise.withResolvers<BackgroundJobSnapshot>(),
      state: "running",
      endedAtMs: null,
      exitCode: null,
      stopRequested: false,
    };
    this.#jobs.set(id, record);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    // `close` follows the stdio streams, so a terminal state never hides queued output.
    child.on("close", (code) => {
      record.exitCode = code;
      this.#publish(record);
    });
    child.on("error", () => {
      record.exitCode = record.exitCode ?? null;
      this.#publish(record);
    });
    return this.#snapshot(record);
  }

  get(id: string): BackgroundJobSnapshot | undefined {
    const record = this.#jobs.get(id);
    return record === undefined ? undefined : this.#snapshot(record);
  }

  list(): ReadonlyArray<BackgroundJobSummary> {
    return [...this.#jobs.values()].map((record) => this.#summary(record));
  }

  /** Waiting never kills the process; a timeout returns the current running snapshot. */
  async wait(
    id: string,
    timeoutMs: number,
    signal?: AbortSignal | undefined,
  ): Promise<BackgroundJobSnapshot> {
    const record = this.#jobs.get(id);
    if (record === undefined) throw new Error(`Unknown background job "${id}".`);
    if (record.state !== "running") return this.#snapshot(record);
    if (signal?.aborted === true) return this.#snapshot(record);
    return await new Promise<BackgroundJobSnapshot>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        this.#waiters.delete(finish);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve(this.#snapshot(record));
      };
      let timer: NodeJS.Timeout | undefined;
      this.#waiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
      if (timeoutMs <= 0) {
        finish();
        return;
      }
      timer = setTimeout(finish, timeoutMs);
    });
  }

  /** SIGTERM, then SIGKILL after the grace window, both through the process group. */
  async stop(id: string, graceMs?: number | undefined): Promise<BackgroundJobStopOutcome> {
    return await this.#stopWithin(id, graceMs ?? this.#stopGraceMs, this.#settleAfterKillMs);
  }

  async #stopWithin(
    id: string,
    graceMs: number,
    settleAfterKillMs: number,
  ): Promise<BackgroundJobStopOutcome> {
    const record = this.#jobs.get(id);
    if (record === undefined) throw new Error(`Unknown background job "${id}".`);
    if (record.state !== "running") {
      return { snapshot: this.#snapshot(record), stopPending: false };
    }
    record.stopRequested = true;
    this.#signal(record, "SIGTERM");
    await this.#settleWithin(record, graceMs);
    if (record.state === "running") {
      this.#signal(record, "SIGKILL");
      await this.#settleWithin(record, settleAfterKillMs);
    }
    return { snapshot: this.#snapshot(record), stopPending: record.state === "running" };
  }

  async #settleWithin(record: JobRecord, graceMs: number): Promise<void> {
    if (record.state !== "running") return;
    await Promise.race([record.settled.promise, this.#sleep(Math.max(0, graceMs))]);
  }

  /** Session teardown must not wait for a stop grace window; the group dies on SIGKILL. */
  async stopAll(): Promise<void> {
    const running = [...this.#jobs.values()].filter((record) => record.state === "running");
    await Promise.all(running.map((record) => this.#stopWithin(record.id, 0, 0)));
  }
}
