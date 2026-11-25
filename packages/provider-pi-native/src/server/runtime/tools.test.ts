// @effect-diagnostics nodeBuiltinImport:off -- Tool tests read and write real temporary files and spawn real shells.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { NamedRegisters } from "./editEngine.ts";
import { computeFileTag, splitFileLines } from "./fileAnchorTypes.ts";
import { FileSnapshotStore } from "./fileSnapshotStore.ts";
import { MutationRecoveryTracker } from "./mutationRecovery.ts";
import { PathMutex } from "./pathLock.ts";
import { WorkspaceSandbox } from "./sandbox.ts";
import {
  createPiNativeTools,
  type GoalStatusUpdate,
  type GoalStatusUpdateResult,
  type PiNativeToolDeps,
  type PlanSubmission,
  type TodoUpdate,
} from "./tools.ts";

const windows = HostProcess.Platform.defaultValue() === "win32";

interface Harness {
  readonly directory: string;
  readonly anchors: FileSnapshotStore;
  readonly registers: NamedRegisters;
  readonly recovery: MutationRecoveryTracker;
  readonly plans: Array<PlanSubmission>;
  readonly todos: Array<TodoUpdate>;
  readonly compactions: Array<string | undefined>;
  readonly dir: (name: string) => string;
  readonly tool: (name: string) => AgentTool<any>;
}

interface HarnessOptions {
  readonly planMode?: boolean;
  readonly readOnlyRoots?: ReadonlyArray<string>;
  readonly threadId?: string;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly shell?: PiNativeToolDeps["shell"];
  readonly maxOutputBytes?: number;
  readonly maxGlobResults?: number;
  readonly onGoalStatusUpdate?: PiNativeToolDeps["onGoalStatusUpdate"];
}

type HarnessFactory = (options?: HarnessOptions) => Harness;

const withDirectory = async (body: (make: HarnessFactory) => Promise<void>): Promise<void> => {
  const directory = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-native-tools-")),
  );
  const anchors = new FileSnapshotStore();
  const registers = new NamedRegisters();
  const recovery = new MutationRecoveryTracker();
  const plans: Array<PlanSubmission> = [];
  const todos: Array<TodoUpdate> = [];
  const compactions: Array<string | undefined> = [];

  const make: HarnessFactory = (options = {}) => {
    const deps: PiNativeToolDeps = {
      sandbox: new WorkspaceSandbox({
        cwd: directory,
        ...(options.readOnlyRoots === undefined ? {} : { readOnlyRoots: options.readOnlyRoots }),
      }),
      anchors,
      registers,
      recovery,
      locks: new PathMutex(),
      requestUserInput: async () => ({ q1: "A" }),
      onSubmitPlan: (submission) => {
        plans.push(submission);
      },
      onTodoUpdate: (update) => {
        todos.push(update);
      },
      onRequestCompaction: (reason) => {
        compactions.push(reason);
      },
      ...(options.onGoalStatusUpdate === undefined
        ? {}
        : { onGoalStatusUpdate: options.onGoalStatusUpdate }),
      isPlanMode: () => options.planMode === true,
      ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.shell === undefined ? {} : { shell: options.shell }),
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
      ...(options.maxGlobResults === undefined ? {} : { maxGlobResults: options.maxGlobResults }),
    };
    const tools = createPiNativeTools(deps);
    const byName = new Map(tools.map((tool) => [String(tool.name), tool]));
    return {
      directory,
      anchors,
      registers,
      recovery,
      plans,
      todos,
      compactions,
      dir: (name) => NodePath.join(directory, name),
      tool: (name) => {
        const tool = byName.get(name);
        if (tool === undefined) throw new Error(`missing tool ${name}`);
        return tool;
      },
    };
  };

  try {
    await body(make);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
};

const textOf = (result: { readonly content: ReadonlyArray<unknown> }): string => {
  const first = result.content[0];
  if (typeof first !== "object" || first === null) return "";
  const record = first as { readonly type?: string; readonly text?: string };
  return record.type === "text" ? (record.text ?? "") : "";
};

const writeFile = async (directory: string, name: string, content: string): Promise<string> => {
  const target = NodePath.join(directory, name);
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  await NodeFSP.writeFile(target, content);
  return target;
};

const readFile = async (target: string): Promise<string> => NodeFSP.readFile(target, "utf8");

const headerOf = (path: string, content: string): string => `[${path}#${computeFileTag(content)}]`;

const staleTag = (content: string): string =>
  computeFileTag(content) === "0000" ? "0001" : "0000";

const seenOf = (harness: Harness, name: string, content: string): ReadonlyArray<number> => [
  ...(harness.anchors.latestMatchingText(harness.dir(name), content)?.seenLines ?? []),
];

describe("Read", () => {
  it("emits the whole-file tag header and records displayed lines as seen", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.ts", "alpha\nbeta\n");
      const result = await harness.tool("Read").execute("call-1", { path: "file.ts" });
      expect(textOf(result)).toBe(`${headerOf("file.ts", "alpha\nbeta\n")}\n1:alpha\n2:beta`);
      expect(result.details).toMatchObject({
        startLine: 1,
        endLine: 2,
        totalLines: 2,
        truncated: false,
        image: false,
        tag: computeFileTag("alpha\nbeta\n"),
      });
      expect(result.isError).toBeUndefined();
      expect(seenOf(harness, "file.ts", "alpha\nbeta\n")).toEqual([1, 2]);
    });
  });

  it("honors offset and limit and reports only the window as seen", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.txt", "one\ntwo\nthree\nfour\n");
      const result = await harness.tool("Read").execute("call-1", {
        path: "file.txt",
        offset: 2,
        limit: 2,
      });
      expect(textOf(result).split("\n")).toEqual([
        headerOf("file.txt", "one\ntwo\nthree\nfour\n"),
        "2:two",
        "3:three",
        "",
        "[lines 2-3 of 4]",
      ]);
      expect(result.details).toMatchObject({ startLine: 2, endLine: 3, truncated: true });
      expect(seenOf(harness, "file.txt", "one\ntwo\nthree\nfour\n")).toEqual([2, 3]);
    });
  });

  it("fuses paginated reads into one tag whose seen lines cover both windows", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      const lines = Array.from({ length: 6 }, (_, index) => `line-${index + 1}`);
      const content = `${lines.join("\n")}\n`;
      await writeFile(harness.directory, "file.txt", content);
      const first = await harness.tool("Read").execute("call-1", {
        path: "file.txt",
        offset: 1,
        limit: 3,
      });
      const second = await harness.tool("Read").execute("call-2", {
        path: "file.txt",
        offset: 2,
        limit: 3,
      });
      expect(first.details.tag).toBe(second.details.tag);
      expect(seenOf(harness, "file.txt", content)).toEqual([1, 2, 3, 4]);
    });
  });

  it("returns an image block for supported extensions", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await NodeFSP.writeFile(NodePath.join(harness.directory, "shot.PNG"), bytes);
      const result = await harness.tool("Read").execute("call-1", { path: "shot.PNG" });
      expect(result.content).toEqual([
        { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
      ]);
      expect(result.details).toMatchObject({ image: true });
    });
  });

  it("handles empty and missing files", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "empty.txt", "");
      const empty = await harness.tool("Read").execute("call-1", { path: "empty.txt" });
      expect(textOf(empty)).toBe(`${headerOf("empty.txt", "")}\n[file is empty]`);
      expect(empty.details).toMatchObject({ totalLines: 0, tag: computeFileTag("") });

      const missing = await harness.tool("Read").execute("call-1", { path: "missing.txt" });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toContain("Could not read");
    });
  });

  it("clips an oversized line and excludes it from seen lines", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      const long = "x".repeat(20_000);
      const content = `short\n${long}\n`;
      await writeFile(harness.directory, "wide.txt", content);
      const result = await harness.tool("Read").execute("call-1", { path: "wide.txt" });
      expect(textOf(result)).toContain("[1 line(s) clipped at 16384 characters]");
      expect(textOf(result)).toContain(`2:${"x".repeat(16_384)}`);
      expect(textOf(result)).not.toContain("x".repeat(16_385));
      expect(seenOf(harness, "wide.txt", content)).toEqual([1]);
    });
  });
});

describe("Write", () => {
  it("creates a file, returns the diff, and mints the tag of what landed", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      const result = await harness.tool("Write").execute("call-1", {
        path: "src/new.ts",
        content: "alpha\nbeta\n",
      });
      const tag = computeFileTag("alpha\nbeta\n");
      expect(result.isError).toBeUndefined();
      expect(result.details).toMatchObject({
        fileName: "new.ts",
        additions: 2,
        deletions: 0,
        oldStr: "",
        newStr: "alpha\nbeta\n",
        tag,
      });
      expect(result.details.diffStr).toContain("+alpha");
      expect(textOf(result)).toContain(`[src/new.ts#${tag}]`);
      expect(await readFile(harness.dir("src/new.ts"))).toBe("alpha\nbeta\n");
      expect(seenOf(harness, "src/new.ts", "alpha\nbeta\n")).toEqual([1, 2]);
    });
  });

  it("strips a pasted Read window from incoming content", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await harness.tool("Write").execute("call-1", {
        path: "pasted.ts",
        content: "[src/main.ts#A1B2]\n1:alpha\n2:beta\n",
      });
      expect(await readFile(harness.dir("pasted.ts"))).toBe("alpha\nbeta\n");
    });
  });

  it("preserves an existing BOM and CRLF endings", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const original = Buffer.concat([bom, Buffer.from("one\r\ntwo\r\n")]);
      await NodeFSP.writeFile(NodePath.join(harness.directory, "win.txt"), original);
      const result = await harness.tool("Write").execute("call-1", {
        path: "win.txt",
        content: "one\nthree\n",
      });
      expect(result.details).toMatchObject({ additions: 1, deletions: 1 });
      expect(await NodeFSP.readFile(harness.dir("win.txt"))).toEqual(
        Buffer.concat([bom, Buffer.from("one\r\nthree\r\n")]),
      );
    });
  });

  it("reports deletions when overwriting and clears recovery strikes", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.txt", "one\ntwo\nthree\n");
      const target = harness.dir("file.txt");
      harness.recovery.recordFailure(target, "EDIT_RANGE_INVALID");
      harness.recovery.recordFailure(target, "EDIT_RANGE_INVALID");
      expect(harness.recovery.peek(target)?.strikes).toBe(2);

      const result = await harness.tool("Write").execute("call-1", {
        path: "file.txt",
        content: "one\nthree\n",
      });
      expect(result.details).toMatchObject({ additions: 0, deletions: 1 });
      expect(result.details.oldStr).toBe("one\ntwo\nthree\n");
      expect(harness.recovery.peek(target)).toBeUndefined();
    });
  });

  it("refuses writes into read-only attachment roots", async () => {
    await withDirectory(async (make) => {
      const attachments = await NodeFSP.realpath(
        await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-native-attachment-")),
      );
      try {
        const harness = make({ readOnlyRoots: [attachments] });
        const target = NodePath.join(attachments, "file.txt");
        await NodeFSP.writeFile(target, "fixture");
        const result = await harness.tool("Write").execute("call-1", {
          path: target,
          content: "changed",
        });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("read-only");
        expect(await readFile(target)).toBe("fixture");
      } finally {
        await NodeFSP.rm(attachments, { recursive: true, force: true });
      }
    });
  });
});

describe("Edit", () => {
  it("applies ops anchored on the tag Read returned", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.ts", "alpha\nbeta\ngamma\n");
      const read = await harness.tool("Read").execute("call-1", { path: "file.ts" });

      const result = await harness.tool("Edit").execute("call-2", {
        path: "file.ts",
        tag: read.details.tag,
        ops: "PUT 2.=2:\n+BETA\n+BETA-2",
      });
      expect(result.isError).toBeUndefined();
      expect(await readFile(harness.dir("file.ts"))).toBe("alpha\nBETA\nBETA-2\ngamma\n");
      expect(result.details).toMatchObject({
        additions: 2,
        deletions: 1,
        tag: computeFileTag("alpha\nBETA\nBETA-2\ngamma\n"),
      });
      expect(textOf(result)).toContain(headerOf("file.ts", "alpha\nBETA\nBETA-2\ngamma\n"));
    });
  });

  it("covers ranges, gaps, append, and block locators", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(
        harness.directory,
        "file.ts",
        "const a = 1;\nfunction f() {\n  return 2;\n}\n",
      );
      const read = await harness.tool("Read").execute("call-1", { path: "file.ts" });
      const tag = read.details.tag;

      const replaced = await harness.tool("Edit").execute("call-2", {
        path: "file.ts",
        tag,
        ops: "PUT 1.=1:\n+const a = 2;\nPUT >$:\n+const tail = 3;",
      });
      expect(replaced.isError).toBeUndefined();
      expect(await readFile(harness.dir("file.ts"))).toBe(
        "const a = 2;\nfunction f() {\n  return 2;\n}\nconst tail = 3;\n",
      );

      const block = await harness.tool("Edit").execute("call-3", {
        path: "file.ts",
        tag: replaced.details.tag,
        ops: "PUT 2*:\n+function f() {\n+  return 3;\n+}",
      });
      expect(block.isError).toBeUndefined();
      expect(await readFile(harness.dir("file.ts"))).toBe(
        "const a = 2;\nfunction f() {\n  return 3;\n}\nconst tail = 3;\n",
      );
      expect(block.details.ops).toEqual(["PUT 2*:"]);

      const insertBefore = await harness.tool("Edit").execute("call-4", {
        path: "file.ts",
        tag: block.details.tag,
        ops: "PUT <1:\n+// header",
      });
      expect(insertBefore.isError).toBeUndefined();
      expect((await readFile(harness.dir("file.ts"))).startsWith("// header\n")).toBe(true);
    });
  });

  it("reports resolved block spans for a direct apply", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.ts", "function f() {\n  return 1;\n}\n");
      const read = await harness.tool("Read").execute("call-1", { path: "file.ts" });
      const result = await harness.tool("Edit").execute("call-2", {
        path: "file.ts",
        tag: read.details.tag,
        ops: "PUT 1*:\n+function f() {\n+  return 2;\n+}",
      });
      expect(textOf(result)).toContain("[block] PUT 1*: -> lines 1-3");
    });
  });

  it("declines a block locator on an unsupported language", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "notes.txt", "a\nb\nc\n");
      const read = await harness.tool("Read").execute("call-1", { path: "notes.txt" });
      const result = await harness.tool("Edit").execute("call-2", {
        path: "notes.txt",
        tag: read.details.tag,
        ops: "PUT 1*:\n+x",
      });
      expect(textOf(result)).toContain("EDIT_BLOCK_UNRESOLVED");
      expect(textOf(result)).toContain("use PUT 1.=1:");
    });
  });

  it("records session registers across calls and moves files", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "source.ts", "alpha\nbeta\n");
      await writeFile(harness.directory, "target.ts", "one\ntwo\n");
      const source = await harness.tool("Read").execute("call-1", { path: "source.ts" });
      const cut = await harness.tool("Edit").execute("call-2", {
        path: "source.ts",
        tag: source.details.tag,
        ops: "CUT 1.=1 @line",
      });
      expect(cut.isError).toBeUndefined();
      expect(await readFile(harness.dir("source.ts"))).toBe("beta\n");

      const target = await harness.tool("Read").execute("call-3", { path: "target.ts" });
      const paste = await harness.tool("Edit").execute("call-4", {
        path: "target.ts",
        tag: target.details.tag,
        ops: "PUT <1 @line",
      });
      expect(paste.isError).toBeUndefined();
      expect(await readFile(harness.dir("target.ts"))).toBe("alpha\none\ntwo\n");

      const moved = await harness.tool("Edit").execute("call-5", {
        path: "target.ts",
        tag: paste.details.tag,
        ops: "MV renamed.ts",
      });
      expect(moved.isError).toBeUndefined();
      expect(moved.details.fileName).toBe("renamed.ts");
      expect(await readFile(harness.dir("renamed.ts"))).toBe("alpha\none\ntwo\n");
      await expect(NodeFSP.readFile(harness.dir("target.ts"))).rejects.toThrow();
    });
  });

  it("removes a file with REM", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "gone.txt", "alpha\n");
      const read = await harness.tool("Read").execute("call-1", { path: "gone.txt" });
      const result = await harness.tool("Edit").execute("call-2", {
        path: "gone.txt",
        tag: read.details.tag,
        ops: "REM",
      });
      expect(result.isError).toBeUndefined();
      expect(result.details.newStr).toBe("");
      await expect(NodeFSP.readFile(harness.dir("gone.txt"))).rejects.toThrow();
    });
  });

  it("reveals unseen anchors once so an honest retry applies", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.ts", "one\ntwo\nthree\nfour\n");
      const read = await harness.tool("Read").execute("call-1", {
        path: "file.ts",
        offset: 1,
        limit: 2,
      });
      const ops = "PUT 4.=4:\n+FOUR";
      const rejected = await harness.tool("Edit").execute("call-2", {
        path: "file.ts",
        tag: read.details.tag,
        ops,
      });
      expect(textOf(rejected)).toContain("EDIT_LINES_UNSEEN");
      expect(textOf(rejected)).toContain("4: four");
      expect(textOf(rejected)).toContain("retry the same tag unchanged");
      expect(harness.recovery.peek(harness.dir("file.ts"))).toMatchObject({
        strikes: 0,
        freeRetryUsed: true,
      });

      const retried = await harness.tool("Edit").execute("call-3", {
        path: "file.ts",
        tag: read.details.tag,
        ops,
      });
      expect(retried.isError).toBeUndefined();
      expect(await readFile(harness.dir("file.ts"))).toBe("one\ntwo\nthree\nFOUR\n");
    });
  });

  it("does not merge a clipped unseen-line reveal", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      const long = "y".repeat(600);
      await writeFile(harness.directory, "file.ts", `${long}\nshort\n`);
      await harness.tool("Read").execute("call-1", { path: "file.ts", offset: 2, limit: 1 });
      const result = await harness.tool("Edit").execute("call-2", {
        path: "file.ts",
        tag: computeFileTag(`${long}\nshort\n`),
        ops: "PUT 1.=1:\n+LONG",
      });
      expect(textOf(result)).toContain("EDIT_LINES_UNSEEN");
      expect(textOf(result)).toContain("reveal is truncated");
      expect(await readFile(harness.dir("file.ts"))).toBe(`${long}\nshort\n`);
    });
  });

  it("recovers a stale tag when every anchor moved by one consistent offset", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.ts", "a\nb\nc\n");
      const read = await harness.tool("Read").execute("call-1", { path: "file.ts" });
      await writeFile(harness.directory, "file.ts", "zero\na\nb\nc\n");
      const result = await harness.tool("Edit").execute("call-2", {
        path: "file.ts",
        tag: read.details.tag,
        ops: "PUT 2.=2:\n+B",
      });
      expect(result.isError).toBeUndefined();
      expect(await readFile(harness.dir("file.ts"))).toBe("zero\na\nB\nc\n");
      expect(textOf(result)).toContain("[warning]");
      expect(textOf(result)).toContain("anchors moved by +1 line(s)");
    });
  });

  it("rejects a stale tag when the anchored line itself changed", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.ts", "a\nb\nc\n");
      const read = await harness.tool("Read").execute("call-1", { path: "file.ts" });
      await writeFile(harness.directory, "file.ts", "a\nB2\nc\n");
      const result = await harness.tool("Edit").execute("call-2", {
        path: "file.ts",
        tag: read.details.tag,
        ops: "PUT 2.=2:\n+B",
      });
      expect(textOf(result)).toContain("EDIT_TAG_MISMATCH");
      expect(textOf(result)).toContain("Current content at the anchors");
      expect(await readFile(harness.dir("file.ts"))).toBe("a\nB2\nc\n");
    });
  });

  it("rebinds a mistyped path by basename and tag", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "src/main.ts", "a\nb\n");
      const read = await harness.tool("Read").execute("call-1", { path: "src/main.ts" });
      const result = await harness.tool("Edit").execute("call-2", {
        path: "main.ts",
        tag: read.details.tag,
        ops: "PUT 2.=2:\n+B",
      });
      expect(result.isError).toBeUndefined();
      expect(await readFile(harness.dir("src/main.ts"))).toBe("a\nB\n");
    });
  });

  it("applies a stale tag at the file tail as position-stable", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.ts", "a\nb\n");
      const read = await harness.tool("Read").execute("call-1", { path: "file.ts" });
      await writeFile(harness.directory, "file.ts", "a\nb\nc\n");
      const result = await harness.tool("Edit").execute("call-2", {
        path: "file.ts",
        tag: read.details.tag,
        ops: "PUT >$:\n+d",
      });
      expect(result.isError).toBeUndefined();
      expect(await readFile(harness.dir("file.ts"))).toBe("a\nb\nc\nd\n");
      expect(textOf(result)).toContain("applied at the file head/tail");
    });
  });

  it("requires a well-formed tag for ops", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.ts", "a\n");
      const result = await harness.tool("Edit").execute("call-1", {
        path: "file.ts",
        ops: "CUT 1.=1",
      });
      expect(textOf(result)).toContain("EDIT_TAG_REQUIRED");
      expect(await readFile(harness.dir("file.ts"))).toBe("a\n");
    });
  });

  it("hard-stops after three counted failures and blocks Write", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.ts", "alpha\nbeta\n");
      const tag = staleTag("alpha\nbeta\n");
      const ops = "CUT 1.=1";

      const free = await harness.tool("Edit").execute("call-1", {
        path: "file.ts",
        tag,
        ops,
      });
      expect(textOf(free)).toContain("One free retry");

      for (const call of ["call-2", "call-3", "call-4"]) {
        await harness.tool("Edit").execute(call, { path: "file.ts", tag, ops });
      }
      expect(harness.recovery.peek(harness.dir("file.ts"))?.hardStop).toBe(true);

      const blocked = await harness.tool("Write").execute("call-5", {
        path: "file.ts",
        content: "replaced\n",
      });
      expect(blocked.isError).toBe(true);
      expect(textOf(blocked)).toContain("Stop mutating");
      expect(await readFile(harness.dir("file.ts"))).toBe("alpha\nbeta\n");
    });
  });

  it("falls back to a single exact oldText replacement", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.txt", "one\ntwo\nthree\n");
      const result = await harness.tool("Edit").execute("call-1", {
        path: "file.txt",
        oldText: "two",
        newText: "TWO",
      });
      expect(result.isError).toBeUndefined();
      expect(await readFile(harness.dir("file.txt"))).toBe("one\nTWO\nthree\n");
      expect(result.details).toMatchObject({ additions: 1, deletions: 1 });
    });
  });

  it("accepts old_string aliases and multi-line legacy replacements", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.txt", "one\ntwo\nthree\nfour\n");
      const result = await harness.tool("Edit").execute("call-1", {
        path: "file.txt",
        old_string: "two\nthree",
        new_string: "TWO\nTHREE",
      });
      expect(result.isError).toBeUndefined();
      expect(await readFile(harness.dir("file.txt"))).toBe("one\nTWO\nTHREE\nfour\n");
    });
  });

  it("lowers legacy edits[] through the same engine", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.ts", "alpha\nbeta\ngamma\n");
      const result = await harness.tool("Edit").execute("call-1", {
        path: "file.ts",
        edits: [{ op: "PUT", start: "2:zz", content: "BETA" }],
      });
      expect(result.isError).toBeUndefined();
      expect(await readFile(harness.dir("file.ts"))).toBe("alpha\nBETA\ngamma\n");
      expect(result.details.warnings?.[0]).toContain("carried no tag");
    });
  });

  it("rejects missing, ambiguous, unchanged, and self-move edits", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.txt", "same\nsame\n");
      const notFound = await harness.tool("Edit").execute("call-1", {
        path: "file.txt",
        oldText: "absent",
        newText: "x",
      });
      expect(textOf(notFound)).toContain("does not appear");

      const ambiguous = await harness.tool("Edit").execute("call-2", {
        path: "file.txt",
        oldText: "same",
        newText: "x",
      });
      expect(textOf(ambiguous)).toContain("appears 2 times");

      const noEdits = await harness.tool("Edit").execute("call-3", { path: "file.txt" });
      expect(textOf(noEdits)).toContain("Provide ops with tag, edits, or oldText/newText");

      const missing = await harness.tool("Edit").execute("call-4", {
        path: "missing.txt",
        oldText: "a",
        newText: "b",
      });
      expect(textOf(missing)).toContain("does not exist");

      const read = await harness.tool("Read").execute("call-5", { path: "file.txt" });
      const noChange = await harness.tool("Edit").execute("call-6", {
        path: "file.txt",
        tag: read.details.tag,
        ops: "PUT 1.=1:\n+same",
      });
      expect(textOf(noChange)).toContain("EDIT_NO_CHANGE");

      const selfMove = await harness.tool("Edit").execute("call-7", {
        path: "file.txt",
        tag: read.details.tag,
        ops: "MV ./file.txt",
      });
      expect(textOf(selfMove)).toContain("EDIT_NO_CHANGE");
      expect(await readFile(harness.dir("file.txt"))).toBe("same\nsame\n");
    });
  });

  it("rejects malformed ops with a concrete replacement form", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.ts", "a\nb\n");
      const read = await harness.tool("Read").execute("call-1", { path: "file.ts" });
      const result = await harness.tool("Edit").execute("call-2", {
        path: "file.ts",
        tag: read.details.tag,
        ops: "PUT 1.=1\n+x",
      });
      expect(textOf(result)).toContain("EDIT_PARSE_FAILED");
      expect(textOf(result)).toContain("PUT 1.=1:");
      expect(await readFile(harness.dir("file.ts"))).toBe("a\nb\n");
    });
  });

  it("preserves UTF-16 and CRLF when editing", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      const original = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("one\r\ntwo\r\n", "utf16le"),
      ]);
      await NodeFSP.writeFile(NodePath.join(harness.directory, "wide.txt"), original);
      const read = await harness.tool("Read").execute("call-1", { path: "wide.txt" });
      const result = await harness.tool("Edit").execute("call-2", {
        path: "wide.txt",
        tag: read.details.tag,
        ops: "PUT 2.=2:\n+TWO",
      });
      expect(result.isError).toBeUndefined();
      expect(await NodeFSP.readFile(harness.dir("wide.txt"))).toEqual(
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("one\r\nTWO\r\n", "utf16le")]),
      );
    });
  });

  it("keeps a missing trailing newline", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.txt", "alpha\nbeta");
      const read = await harness.tool("Read").execute("call-1", { path: "file.txt" });
      await harness.tool("Edit").execute("call-2", {
        path: "file.txt",
        tag: read.details.tag,
        ops: "PUT 2.=2:\n+BETA",
      });
      expect(await readFile(harness.dir("file.txt"))).toBe("alpha\nBETA");
      expect(splitFileLines("alpha\nBETA")).toEqual(["alpha", "BETA"]);
    });
  });
});

describe("Glob and Grep", () => {
  it("finds files by glob while skipping ignored directories", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "a.ts", "");
      await writeFile(harness.directory, "src/b.ts", "");
      await writeFile(harness.directory, "src/nested/c.md", "");
      await writeFile(harness.directory, "node_modules/skip.ts", "");
      await writeFile(harness.directory, ".git/skip.ts", "");

      const result = await harness.tool("Glob").execute("call-1", { pattern: "**/*.ts" });
      expect(result.details.files).toEqual(["a.ts", "src/b.ts"]);
      expect(result.details.truncated).toBe(false);

      const markdown = await harness.tool("Glob").execute("call-2", { pattern: "**/*.md" });
      expect(markdown.details.files).toEqual(["src/nested/c.md"]);
    });
  });

  it("caps glob results", async () => {
    await withDirectory(async (make) => {
      const harness = make({ maxGlobResults: 1 });
      await writeFile(harness.directory, "one.ts", "");
      await writeFile(harness.directory, "two.ts", "");
      const result = await harness.tool("Glob").execute("call-1", { pattern: "*.ts" });
      expect(result.details.files).toHaveLength(1);
      expect(result.details.truncated).toBe(true);
    });
  });

  it("grep reports file, line, and preview while skipping binaries", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "src/a.ts", "first\nconst needle = 1;\n");
      await writeFile(harness.directory, "src/notes.json", "needle\n");
      await NodeFSP.writeFile(
        NodePath.join(harness.directory, "src/binary.bin"),
        Buffer.from([0x00, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]),
      );

      const result = await harness.tool("Grep").execute("call-1", { pattern: "needle" });
      const matches = result.details.matches as ReadonlyArray<{
        fileName: string;
        line: number;
        preview: string;
      }>;
      expect(matches).toHaveLength(2);
      expect(matches.map((match) => match.fileName)).toEqual([
        harness.dir("src/a.ts"),
        harness.dir("src/notes.json"),
      ]);
      expect(matches[0]).toMatchObject({ line: 2, preview: "const needle = 1;" });

      const filtered = await harness.tool("Grep").execute("call-2", {
        pattern: "needle",
        glob: "*.ts",
      });
      expect(filtered.details.matches).toHaveLength(1);

      const caseInsensitive = await harness.tool("Grep").execute("call-3", {
        pattern: "NEEDLE",
        caseSensitive: false,
      });
      expect(caseInsensitive.details.matches).toHaveLength(2);

      const none = await harness.tool("Grep").execute("call-4", { pattern: "absent" });
      expect(textOf(none)).toContain("No matches");
    });
  });

  it("rejects invalid regular expressions", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      const result = await harness.tool("Grep").execute("call-1", { pattern: "(" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Invalid pattern");
    });
  });
});

describe("Bash", () => {
  it("streams output and reports the exit code", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      const result = await harness.tool("Bash").execute("call-1", { command: "printf hello" });
      expect(result.details).toMatchObject({
        command: "printf hello",
        exitCode: 0,
        output: "hello",
        truncated: false,
        timedOut: false,
        aborted: false,
      });
      expect(textOf(result)).toContain("hello");
      expect(textOf(result)).toContain("exited with code 0");
    });
  });

  it.skipIf(windows)("reports a non-zero exit code", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      const result = await harness.tool("Bash").execute("call-1", { command: "exit 3" });
      expect(result.details.exitCode).toBe(3);
    });
  });

  it("warns when the shell writes files", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      const result = await harness.tool("Bash").execute("call-1", {
        command: "printf content > out.txt",
      });
      expect(result.details.shellPatchWarning).toContain("prefer Edit or Write");
      expect(textOf(result)).toContain("[warning]");
      expect(await readFile(harness.dir("out.txt"))).toBe("content");
    });
  });

  it("caps the captured output", async () => {
    await withDirectory(async (make) => {
      const harness = make({ maxOutputBytes: 20 });
      const result = await harness.tool("Bash").execute("call-1", {
        command: "printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
      });
      expect(result.details.truncated).toBe(true);
      expect(result.details.output).toContain("[output truncated]");
    });
  });

  it("passes the thread id to the command", async () => {
    await withDirectory(async (make) => {
      const harness = make({ threadId: "thread-9" });
      const result = await harness.tool("Bash").execute("call-1", {
        command: 'printf "$T3CODE_THREAD_ID"',
      });
      expect(result.details.output).toBe("thread-9");
    });
  });

  it("does not start an already aborted command", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      const controller = new AbortController();
      controller.abort();
      const result = await harness
        .tool("Bash")
        .execute("call-1", { command: "printf hello" }, controller.signal);
      expect(result.isError).toBe(true);
      expect(result.details.aborted).toBe(true);
      expect(result.details.exitCode).toBeNull();
    });
  });

  it.skipIf(windows)("kills the command when the timeout elapses", async () => {
    await withDirectory(async (make) => {
      const harness = make({
        sleep: () => Promise.resolve(),
        shell: { command: "/bin/sh", args: ["-c", "sleep 30; true"] },
      });
      const result = await harness.tool("Bash").execute("call-1", { command: "ignored" });
      expect(result.isError).toBe(true);
      expect(result.details.timedOut).toBe(true);
      expect(textOf(result)).toContain("timed out");
    });
  });
});

describe("conversation tools", () => {
  it("asks structured questions through the runtime", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      const result = await harness.tool("asktool").execute("call-1", {
        questions: [
          {
            id: "q1",
            header: "Pick",
            question: "Which option?",
            options: [{ label: "A", description: "first" }],
            multiSelect: false,
          },
        ],
      });
      expect(result.isError).toBeUndefined();
      expect(result.details.questions).toHaveLength(1);
      expect(result.details.questions[0]).toMatchObject({ id: "q1", multiSelect: false });
      expect(result.details.answers).toEqual({ q1: "A" });
      expect(textOf(result)).toContain('"q1": "A"');
    });
  });

  it("submits a plan and terminates only in plan mode", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      const result = await harness.tool("SubmitPlan").execute("call-1", {
        markdown: "# Plan\n",
        summary: "Ship it",
      });
      expect(harness.plans).toEqual([{ markdown: "# Plan\n", summary: "Ship it" }]);
      expect(result.terminate).toBe(false);

      const planMode = make({ planMode: true });
      const inPlan = await planMode.tool("SubmitPlan").execute("call-2", { markdown: "# Plan" });
      expect(inPlan.terminate).toBe(true);
      expect(planMode.plans.at(-1)).toEqual({ markdown: "# Plan" });
    });
  });

  it("rejects an empty plan without submitting it", async () => {
    await withDirectory(async (make) => {
      const harness = make({ planMode: true });
      const result = await harness.tool("SubmitPlan").execute("call-1", {
        markdown: "  \n\t\n ",
        summary: "Ship it",
      });
      expect(result.isError).toBe(true);
      expect(result.terminate).toBeUndefined();
      expect(harness.plans).toEqual([]);
      expect(textOf(result)).toContain("Plan markdown cannot be empty.");
    });
  });

  it("trims a plan summary and omits one that is blank", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      const trimmed = await harness.tool("SubmitPlan").execute("call-1", {
        markdown: "# Plan",
        summary: "  Ship it  ",
      });
      expect(harness.plans).toEqual([{ markdown: "# Plan", summary: "Ship it" }]);
      expect(textOf(trimmed)).toBe("Plan submitted: Ship it");

      const blank = await harness.tool("SubmitPlan").execute("call-2", {
        markdown: "# Plan",
        summary: "   ",
      });
      expect(blank.details).toEqual({ markdown: "# Plan" });
      expect(textOf(blank)).toBe("Plan submitted.");
    });
  });

  it("offers UpdateGoalStatus only while a goal callback is wired", async () => {
    await withDirectory(async (make) => {
      const plain = make();
      expect(() => plain.tool("UpdateGoalStatus")).toThrow(/missing tool UpdateGoalStatus/u);

      const updates: GoalStatusUpdate[] = [];
      const results: GoalStatusUpdateResult[] = [];
      const withGoal = make({
        onGoalStatusUpdate: (update) => {
          updates.push(update);
          if (update.status === "blocked") {
            return { ok: false, error: "the goal is already blocked" };
          }
          return { ok: true, message: `Goal marked ${update.status}.` };
        },
      });
      const accepted = await withGoal.tool("UpdateGoalStatus").execute("call-1", {
        status: "complete",
        summary: "  All tests pass  ",
      });
      expect(updates).toEqual([{ status: "complete", summary: "All tests pass" }]);
      expect(textOf(accepted)).toBe("Goal marked complete.");
      expect(accepted.isError).toBeUndefined();

      const rejected = await withGoal.tool("UpdateGoalStatus").execute("call-2", {
        status: "blocked",
        summary: "waiting",
      });
      expect(rejected.isError).toBe(true);
      expect(textOf(rejected)).toBe("the goal is already blocked");

      const blank = await withGoal.tool("UpdateGoalStatus").execute("call-3", {
        status: "active",
        summary: "   ",
      });
      expect(blank.isError).toBe(true);
      expect(textOf(blank)).toContain("cannot be empty");
      expect(updates).toHaveLength(2);
      results.push(accepted.details as GoalStatusUpdateResult);
      expect(results[0]).toEqual({ ok: true, message: "Goal marked complete." });
    });
  });

  it("updates todos and requests compaction", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      const todo = await harness.tool("TodoWrite").execute("call-1", {
        steps: [
          { id: "1", text: "Read the code", status: "completed" },
          { id: "2", text: "Change it", status: "running" },
        ],
        explanation: "Halfway",
      });
      expect(harness.todos).toEqual([
        {
          steps: [
            { id: "1", text: "Read the code", status: "completed" },
            { id: "2", text: "Change it", status: "running" },
          ],
          explanation: "Halfway",
        },
      ]);
      expect(textOf(todo)).toContain("2 todo steps");

      const compaction = await harness.tool("new_context").execute("call-2", {
        reason: "long thread",
      });
      expect(harness.compactions).toEqual(["long thread"]);
      expect(compaction.details).toEqual({ reason: "long thread" });
    });
  });

  it("reads committed todos with TodoRead and rejects invalid TodoWrite atomically", async () => {
    await withDirectory(async (make) => {
      const harness = make();

      const initialRead = await harness.tool("TodoRead").execute("call-0", {});
      expect(initialRead.isError).toBeUndefined();
      expect(textOf(initialRead)).toContain("Todo list is empty (revision 0).");
      expect(initialRead.details).toEqual({ revision: 0, steps: [] });

      const firstWrite = await harness.tool("TodoWrite").execute("call-1", {
        steps: [
          { id: "step-1", text: "Inspect codebase", status: "completed" },
          { id: "step-2", text: "Add TodoRead", status: "running" },
        ],
        explanation: "Initial checklist",
      });
      expect(firstWrite.isError).toBeUndefined();
      expect(textOf(firstWrite)).toContain("revision 1; 1/2 completed, 1 running, 0 pending");
      expect(textOf(firstWrite)).toContain("- [running] (step-2) Add TodoRead");
      expect(firstWrite.details).toEqual({
        revision: 1,
        steps: [
          { id: "step-1", text: "Inspect codebase", status: "completed" },
          { id: "step-2", text: "Add TodoRead", status: "running" },
        ],
        explanation: "Initial checklist",
      });

      for (const invalid of [
        { steps: [{ id: "  ", text: "Blank id", status: "pending" }] },
        {
          steps: [
            { id: "dup", text: "First", status: "pending" },
            { id: "dup", text: "Second", status: "pending" },
          ],
        },
        { steps: [{ id: "step-3", text: "   ", status: "pending" }] },
      ]) {
        const failed = await harness.tool("TodoWrite").execute("call-bad", invalid);
        expect(failed.isError).toBe(true);
        expect(harness.todos).toHaveLength(1);
        expect(failed.details).toEqual(firstWrite.details);
      }

      const confirmed = await harness.tool("TodoRead").execute("call-2", {});
      expect(confirmed.isError).toBeUndefined();
      expect(confirmed.details).toEqual({
        revision: 1,
        steps: [
          { id: "step-1", text: "Inspect codebase", status: "completed" },
          { id: "step-2", text: "Add TodoRead", status: "running" },
        ],
        explanation: "Initial checklist",
      });
      expect(textOf(confirmed)).toContain("Current todo list (revision 1;");
      expect(textOf(confirmed)).toContain("- [completed] (step-1) Inspect codebase");
      expect(textOf(confirmed)).toContain("- [running] (step-2) Add TodoRead");

      const cleared = await harness.tool("TodoWrite").execute("call-3", { steps: [] });
      expect(cleared.isError).toBeUndefined();
      expect(textOf(cleared)).toBe("Updated 0 todo steps (revision 2). Todo list is empty.");

      const afterClear = await harness.tool("TodoRead").execute("call-4", {});
      expect(afterClear.details).toEqual({ revision: 2, steps: [] });
      expect(textOf(afterClear)).toBe("Todo list is empty (revision 2).");
    });
  });
});
