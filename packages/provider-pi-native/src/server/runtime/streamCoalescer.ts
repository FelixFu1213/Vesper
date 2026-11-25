const host = globalThis as unknown as {
  readonly setTimeout: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
};

/** One frame at 60fps: deltas batch per paint without visible lag. */
const DEFAULT_FLUSH_INTERVAL_MS = 16;
const DEFAULT_MAX_BUFFERED_CHARS = 4_096;

export type ScheduleTimer = (ms: number, callback: () => void) => () => void;

const defaultScheduleTimer: ScheduleTimer = (ms, callback) => {
  const handle = host.setTimeout(callback, ms);
  return () => host.clearTimeout(handle);
};

export interface StreamDeltaCoalescerOptions<TKey extends string> {
  readonly flushIntervalMs?: number;
  readonly maxBufferedChars?: number;
  readonly scheduleTimer?: ScheduleTimer;
  readonly onFlush: (key: TKey, chunk: string) => void;
}

/**
 * Batches token-sized deltas per key so a fast provider cannot flood the event pipeline
 * with one event per token. Order per key is preserved; keys flush independently.
 */
export class StreamDeltaCoalescer<TKey extends string = string> {
  readonly #flushIntervalMs: number;
  readonly #maxBufferedChars: number;
  readonly #scheduleTimer: ScheduleTimer;
  readonly #onFlush: (key: TKey, chunk: string) => void;
  readonly #buffers = new Map<TKey, string>();
  #cancelTimer: (() => void) | undefined;
  #disposed = false;

  constructor(options: StreamDeltaCoalescerOptions<TKey>) {
    this.#flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.#maxBufferedChars = options.maxBufferedChars ?? DEFAULT_MAX_BUFFERED_CHARS;
    this.#scheduleTimer = options.scheduleTimer ?? defaultScheduleTimer;
    this.#onFlush = options.onFlush;
  }

  get pendingKeys(): readonly TKey[] {
    return [...this.#buffers.keys()];
  }

  get bufferedChars(): number {
    let total = 0;
    for (const chunk of this.#buffers.values()) total += chunk.length;
    return total;
  }

  push(key: TKey, delta: string): void {
    if (this.#disposed || delta === "") return;
    const buffered = (this.#buffers.get(key) ?? "") + delta;
    this.#buffers.set(key, buffered);
    if (buffered.length >= this.#maxBufferedChars) {
      this.flushKey(key);
      return;
    }
    this.#armTimer();
  }

  flushKey(key: TKey): void {
    const chunk = this.#buffers.get(key);
    if (chunk === undefined) return;
    this.#buffers.delete(key);
    this.#syncTimer();
    if (chunk !== "") this.#onFlush(key, chunk);
  }

  flushAll(): void {
    const pending = [...this.#buffers.entries()];
    this.#buffers.clear();
    this.#cancelPendingTimer();
    for (const [key, chunk] of pending) {
      if (chunk !== "") this.#onFlush(key, chunk);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.flushAll();
    this.#disposed = true;
  }

  #armTimer(): void {
    if (this.#cancelTimer !== undefined) return;
    this.#cancelTimer = this.#scheduleTimer(this.#flushIntervalMs, () => {
      this.#cancelTimer = undefined;
      this.flushAll();
    });
  }

  #cancelPendingTimer(): void {
    const cancel = this.#cancelTimer;
    this.#cancelTimer = undefined;
    if (cancel !== undefined) cancel();
  }

  #syncTimer(): void {
    if (this.#buffers.size === 0) {
      this.#cancelPendingTimer();
    } else {
      this.#armTimer();
    }
  }
}
