// @effect-diagnostics nodeBuiltinImport:off -- Lock keys are filesystem identity, resolved synchronously.
import * as NodePath from "node:path";

interface Waiter {
  readonly kind: "read" | "write";
  readonly resolve: () => void;
}

interface LockState {
  readers: number;
  writer: boolean;
  readonly queue: Array<Waiter>;
}

const idle = (state: LockState): boolean =>
  state.readers === 0 && !state.writer && state.queue.length === 0;

export class PathMutex {
  readonly #states = new Map<string, LockState>();

  #state(key: string): LockState {
    const existing = this.#states.get(key);
    if (existing !== undefined) return existing;
    const created: LockState = { readers: 0, writer: false, queue: [] };
    this.#states.set(key, created);
    return created;
  }

  #acquire(key: string, kind: "read" | "write"): Promise<void> {
    const state = this.#state(key);
    const available =
      kind === "read"
        ? !state.writer && state.queue.length === 0
        : !state.writer && state.readers === 0 && state.queue.length === 0;
    if (available) {
      if (kind === "read") state.readers++;
      else state.writer = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      state.queue.push({ kind, resolve });
    });
  }

  #release(key: string, kind: "read" | "write"): void {
    const state = this.#states.get(key);
    if (state === undefined) return;
    if (kind === "read") state.readers = Math.max(state.readers - 1, 0);
    else state.writer = false;

    // FIFO: only the queue head can start, so a waiting writer blocks later readers.
    while (state.queue.length > 0) {
      const head = state.queue[0];
      if (head === undefined) break;
      if (head.kind === "write") {
        if (state.writer || state.readers > 0) break;
        state.queue.shift();
        state.writer = true;
        head.resolve();
        break;
      }
      if (state.writer) break;
      state.queue.shift();
      state.readers++;
      head.resolve();
    }

    if (idle(state)) this.#states.delete(key);
  }

  async withReadLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const key = NodePath.resolve(filePath);
    await this.#acquire(key, "read");
    try {
      return await fn();
    } finally {
      this.#release(key, "read");
    }
  }

  async withWriteLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const key = NodePath.resolve(filePath);
    await this.#acquire(key, "write");
    try {
      return await fn();
    } finally {
      this.#release(key, "write");
    }
  }

  isBusy(filePath: string): boolean {
    const state = this.#states.get(NodePath.resolve(filePath));
    return state !== undefined && !idle(state);
  }
}
