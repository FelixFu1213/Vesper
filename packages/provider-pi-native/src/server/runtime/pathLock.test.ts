// @effect-diagnostics nodeBuiltinImport:off -- Lock tests compare real resolved paths.
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { PathMutex } from "./pathLock.ts";

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

const deferred = (): Deferred => {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const file = NodePath.resolve("/workspace/src/file.ts");

describe("PathMutex", () => {
  it("lets readers hold the lock at the same time", async () => {
    const mutex = new PathMutex();
    const gate = deferred();
    const bothStarted = deferred();
    let started = 0;

    const reader = (name: string): Promise<string> =>
      mutex.withReadLock(file, async () => {
        started++;
        if (started === 2) bothStarted.resolve();
        await gate.promise;
        return name;
      });

    const first = reader("first");
    const second = reader("second");
    await bothStarted.promise;
    gate.resolve();

    expect(await first).toBe("first");
    expect(await second).toBe("second");
  });

  it("keeps a writer exclusive against readers", async () => {
    const mutex = new PathMutex();
    const writerGate = deferred();
    const writerStarted = deferred();
    let readStarted = false;

    const writer = mutex.withWriteLock(file, async () => {
      writerStarted.resolve();
      await writerGate.promise;
      return "written";
    });
    await writerStarted.promise;

    const reader = mutex.withReadLock(file, async () => {
      readStarted = true;
      return "read";
    });
    await flushMicrotasks();
    expect(readStarted).toBe(false);

    writerGate.resolve();
    expect(await writer).toBe("written");
    expect(await reader).toBe("read");
  });

  it("keeps two writers apart", async () => {
    const mutex = new PathMutex();
    const gate = deferred();
    const firstStarted = deferred();
    const order: Array<string> = [];

    const first = mutex.withWriteLock(file, async () => {
      order.push("first-start");
      firstStarted.resolve();
      await gate.promise;
      order.push("first-end");
    });
    await firstStarted.promise;

    const second = mutex.withWriteLock(file, async () => {
      order.push("second-start");
    });
    await flushMicrotasks();
    expect(order).toEqual(["first-start"]);

    gate.resolve();
    await first;
    await second;
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("starts the queued writer before readers that arrived later", async () => {
    const mutex = new PathMutex();
    const readerGate = deferred();
    const readerStarted = deferred();
    const order: Array<string> = [];

    const reader = mutex.withReadLock(file, async () => {
      order.push("reader-start");
      readerStarted.resolve();
      await readerGate.promise;
    });
    await readerStarted.promise;

    const writer = mutex.withWriteLock(file, async () => {
      order.push("writer");
    });
    const later = mutex.withReadLock(file, async () => {
      order.push("later-reader");
    });
    await flushMicrotasks();
    expect(order).toEqual(["reader-start"]);

    readerGate.resolve();
    await Promise.all([reader, writer, later]);
    expect(order).toEqual(["reader-start", "writer", "later-reader"]);
  });

  it("normalizes paths so different spellings share one lock", async () => {
    const mutex = new PathMutex();
    const gate = deferred();
    const writerStarted = deferred();
    const awkward = NodePath.join("/workspace/src", "nested", "..", "file.ts");

    const writer = mutex.withWriteLock(awkward, async () => {
      writerStarted.resolve();
      await gate.promise;
    });
    await writerStarted.promise;

    let secondStarted = false;
    const second = mutex.withWriteLock(file, async () => {
      secondStarted = true;
    });
    await flushMicrotasks();
    expect(secondStarted).toBe(false);

    gate.resolve();
    await writer;
    await second;
    expect(secondStarted).toBe(true);
  });

  it("runs independent paths at the same time", async () => {
    const mutex = new PathMutex();
    const gate = deferred();
    const bothStarted = deferred();
    let started = 0;
    const other = NodePath.resolve("/workspace/src/other.ts");

    const lock = (target: string) =>
      mutex.withWriteLock(target, async () => {
        started++;
        if (started === 2) bothStarted.resolve();
        await gate.promise;
      });

    const first = lock(file);
    const second = lock(other);
    await bothStarted.promise;
    gate.resolve();
    await Promise.all([first, second]);
  });

  it("releases the lock when the body throws and reports idleness", async () => {
    const mutex = new PathMutex();
    await expect(
      mutex.withWriteLock(file, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(mutex.isBusy(file)).toBe(false);

    const gate = deferred();
    const running = mutex.withReadLock(file, async () => {
      await gate.promise;
    });
    await flushMicrotasks();
    expect(mutex.isBusy(file)).toBe(true);
    gate.resolve();
    await running;
    expect(mutex.isBusy(file)).toBe(false);
  });
});
