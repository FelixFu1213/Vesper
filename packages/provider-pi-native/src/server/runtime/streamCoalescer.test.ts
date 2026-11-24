import { assert, describe, it } from "@effect/vitest";

import { StreamDeltaCoalescer } from "./streamCoalescer.ts";

interface FakeTimerEntry {
  readonly ms: number;
  readonly fire: () => void;
  cancelled?: boolean;
}

function fakeTimers() {
  const scheduled: FakeTimerEntry[] = [];
  let cancellations = 0;
  return {
    scheduled,
    cancelCount: () => cancellations,
    scheduleTimer: (ms: number, callback: () => void) => {
      const entry: FakeTimerEntry = { ms, fire: callback };
      scheduled.push(entry);
      return () => {
        if (entry.cancelled === true) return;
        entry.cancelled = true;
        cancellations += 1;
      };
    },
  };
}

function makeCoalescer(input?: { readonly maxBufferedChars?: number }) {
  const timers = fakeTimers();
  const flushed: Array<[string, string]> = [];
  const coalescer = new StreamDeltaCoalescer({
    ...(input?.maxBufferedChars === undefined ? {} : { maxBufferedChars: input.maxBufferedChars }),
    scheduleTimer: timers.scheduleTimer,
    onFlush: (key, chunk) => {
      flushed.push([key, chunk]);
    },
  });
  return { coalescer, timers, flushed };
}

describe("StreamDeltaCoalescer", () => {
  it("buffers deltas per key and flushes them when the timer fires", () => {
    const { coalescer, timers, flushed } = makeCoalescer();

    coalescer.push("text:a", "Hel");
    coalescer.push("text:a", "lo");
    coalescer.push("text:b", "World");

    assert.deepEqual(flushed, []);
    assert.deepEqual(coalescer.pendingKeys, ["text:a", "text:b"]);
    assert.equal(timers.scheduled.length, 1);
    assert.equal(timers.scheduled[0]?.ms, 40);

    timers.scheduled[0]?.fire();

    assert.deepEqual(flushed, [
      ["text:a", "Hello"],
      ["text:b", "World"],
    ]);
    assert.equal(coalescer.bufferedChars, 0);
  });

  it("flushes immediately once a key reaches the buffered character cap", () => {
    const { coalescer, timers, flushed } = makeCoalescer({ maxBufferedChars: 4 });

    coalescer.push("text:a", "abcd");

    assert.deepEqual(flushed, [["text:a", "abcd"]]);
    assert.equal(timers.scheduled.length, 0);
  });

  it("flushKey emits only that key and cancels the timer when nothing is left", () => {
    const { coalescer, timers, flushed } = makeCoalescer();

    coalescer.push("reasoning:a", "thin");
    coalescer.push("text:a", "text");
    coalescer.flushKey("text:a");

    assert.deepEqual(flushed, [["text:a", "text"]]);
    assert.equal(timers.cancelCount(), 0);

    coalescer.flushKey("reasoning:a");

    assert.deepEqual(flushed, [
      ["text:a", "text"],
      ["reasoning:a", "thin"],
    ]);
    assert.equal(timers.cancelCount(), 1);
    assert.deepEqual(coalescer.pendingKeys, []);
  });

  it("flushAll emits pending keys and cancels the pending timer synchronously", () => {
    const { coalescer, timers, flushed } = makeCoalescer();

    coalescer.push("text:a", "one");
    coalescer.flushAll();

    assert.deepEqual(flushed, [["text:a", "one"]]);
    assert.equal(timers.cancelCount(), 1);

    // The cancelled timer must not flush again if a stale callback is invoked.
    timers.scheduled[0]?.fire();
    assert.deepEqual(flushed, [["text:a", "one"]]);
  });

  it("ignores empty deltas and pushes after dispose", () => {
    const { coalescer, flushed } = makeCoalescer();

    coalescer.push("text:a", "");
    assert.deepEqual(coalescer.pendingKeys, []);

    coalescer.push("text:a", "kept");
    coalescer.dispose();
    assert.deepEqual(flushed, [["text:a", "kept"]]);

    coalescer.push("text:a", "dropped");
    assert.deepEqual(coalescer.pendingKeys, []);
  });
});
