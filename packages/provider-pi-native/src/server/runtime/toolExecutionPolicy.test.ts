import { describe, expect, it } from "vite-plus/test";

import { resolveBatchExecutionMode } from "./toolExecutionPolicy.ts";

describe("resolveBatchExecutionMode", () => {
  it("runs read-only batches in parallel", () => {
    expect(
      resolveBatchExecutionMode([
        { name: "Read", arguments: { path: "a.ts" } },
        { name: "Grep", arguments: { pattern: "needle" } },
        { name: "Glob", arguments: { pattern: "**/*.ts" } },
        { name: "TodoRead", arguments: {} },
      ]),
    ).toBe("parallel");
  });

  it("keeps shell, questions, plans, todos, and compaction sequential", () => {
    for (const name of ["Bash", "asktool", "SubmitPlan", "TodoWrite", "new_context"]) {
      expect(
        resolveBatchExecutionMode([
          { name: "Read", arguments: {} },
          { name, arguments: {} },
        ]),
      ).toBe("sequential");
    }
    expect(
      resolveBatchExecutionMode([
        { name: "TodoWrite", arguments: { steps: [] } },
        { name: "TodoRead", arguments: {} },
      ]),
    ).toBe("sequential");
    expect(
      resolveBatchExecutionMode([
        { name: "TodoWrite", arguments: { steps: [] } },
        { name: "TodoWrite", arguments: { steps: [] } },
      ]),
    ).toBe("sequential");
  });

  it("runs a single mutation in parallel with reads", () => {
    expect(
      resolveBatchExecutionMode([
        { name: "Write", arguments: { path: "a.ts" } },
        { name: "Read", arguments: { path: "b.ts" } },
      ]),
    ).toBe("parallel");
  });

  it("serializes mutations that target different files when a Task is in the batch", () => {
    expect(
      resolveBatchExecutionMode([
        { name: "Task", arguments: { prompt: "explore" } },
        { name: "Write", arguments: { path: "a.ts" } },
      ]),
    ).toBe("sequential");
  });

  it("serializes two mutations to the same path", () => {
    expect(
      resolveBatchExecutionMode([
        { name: "Write", arguments: { path: "src/a.ts" } },
        { name: "Edit", arguments: { filePath: "src/../src/a.ts" } },
      ]),
    ).toBe("sequential");
  });

  it("serializes two mutations when a path is missing or unclear", () => {
    expect(
      resolveBatchExecutionMode([
        { name: "Write", arguments: { content: "x" } },
        { name: "Edit", arguments: { path: "a.ts" } },
      ]),
    ).toBe("sequential");
    expect(
      resolveBatchExecutionMode([
        { name: "Write", arguments: { path: "a.ts" } },
        { name: "Edit", arguments: { path: 42 } },
      ]),
    ).toBe("sequential");
    expect(
      resolveBatchExecutionMode([
        { name: "Write", arguments: { path: "  " } },
        { name: "Edit", arguments: {} },
      ]),
    ).toBe("sequential");
  });

  it("allows distinct paths to run in parallel", () => {
    expect(
      resolveBatchExecutionMode([
        { name: "Write", arguments: { path: "a.ts" } },
        { name: "Edit", arguments: { path: "b.ts" } },
        { name: "Write", arguments: { path: "c.ts" } },
      ]),
    ).toBe("parallel");
  });

  it("handles empty batches", () => {
    expect(resolveBatchExecutionMode([])).toBe("parallel");
  });
});
