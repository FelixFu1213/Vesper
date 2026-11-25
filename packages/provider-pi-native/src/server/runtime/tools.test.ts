// @effect-diagnostics nodeBuiltinImport:off -- Tool tests read and write real temporary files and spawn real shells.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { computeLineTag, SeenLinesTracker } from "./hashline.ts";
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
  readonly seen: SeenLinesTracker;
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
  readonly globalIgnoreFile?: string | null;
  readonly rgPath?: string | null;
  readonly onGoalStatusUpdate?: PiNativeToolDeps["onGoalStatusUpdate"];
}

type HarnessFactory = (options?: HarnessOptions) => Harness;

const withDirectory = async (body: (make: HarnessFactory) => Promise<void>): Promise<void> => {
  const directory = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-native-tools-")),
  );
  const seen = new SeenLinesTracker();
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
      seen,
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
      globalIgnoreFile: options.globalIgnoreFile ?? null,
      rgPath: options.rgPath ?? null,
    };
    const tools = createPiNativeTools(deps);
    const byName = new Map(tools.map((tool) => [String(tool.name), tool]));
    return {
      directory,
      seen,
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

const setModified = async (target: string, seconds: number): Promise<void> => {
  await NodeFSP.utimes(target, seconds, seconds);
};

describe("Read", () => {
  it("formats tagged lines and records the range as seen", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.ts", "alpha\nbeta\n");
      const result = await harness.tool("Read").execute("call-1", { file_path: "file.ts" });
      const expected = `1:${computeLineTag("alpha")}|alpha\n2:${computeLineTag("beta")}|beta`;
      expect(textOf(result)).toBe(expected);
      expect(result.details).toMatchObject({
        startLine: 1,
        endLine: 2,
        totalLines: 2,
        truncated: false,
        image: false,
      });
      expect(result.isError).toBeUndefined();
      expect(harness.seen.hasSeenRange(harness.dir("file.ts"), 1, 2)).toBe(true);
      expect(harness.seen.hasSeenRange(harness.dir("file.ts"), 1, 3)).toBe(false);
    });
  });

  it("honors offset and limit and reports the slice", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.txt", "one\ntwo\nthree\nfour\n");
      const result = await harness.tool("Read").execute("call-1", {
        path: "file.txt",
        offset: 2,
        limit: 2,
      });
      expect(textOf(result).split("\n")).toEqual([
        `2:${computeLineTag("two")}|two`,
        `3:${computeLineTag("three")}|three`,
        "",
        "[lines 2-3 of 4]",
      ]);
      expect(result.details).toMatchObject({ startLine: 2, endLine: 3, truncated: true });
      expect(harness.seen.hasSeenRange(harness.dir("file.txt"), 2, 3)).toBe(true);
      expect(harness.seen.hasSeenRange(harness.dir("file.txt"), 1, 2)).toBe(false);
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
      expect(textOf(empty)).toBe("The file is empty.");
      expect(empty.details).toMatchObject({ totalLines: 0 });

      const missing = await harness.tool("Read").execute("call-1", { path: "missing.txt" });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toContain("Could not read");
    });
  });

  it("suggests Glob instead of reading a directory", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "src/a.ts", "alpha\n");
      const result = await harness.tool("Read").execute("call-1", { path: "src" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("is a directory");
      expect(textOf(result)).toContain("use Glob");
      expect(textOf(result)).toContain('pattern="**/*"');
    });
  });

  it("denies files on the security denylist", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, ".env", "SECRET=1\n");
      await writeFile(harness.directory, "certs/server.pem", "key\n");
      await writeFile(harness.directory, ".env.example", "SECRET=\n");

      for (const name of [".env", "certs/server.pem"]) {
        const read = await harness.tool("Read").execute("call-1", { path: name });
        expect(read.isError).toBe(true);
        expect(textOf(read)).toContain("security denylist");

        const write = await harness.tool("Write").execute("call-2", { path: name, content: "x" });
        expect(write.isError).toBe(true);
        expect(textOf(write)).toContain("security denylist");

        const edit = await harness.tool("Edit").execute("call-3", {
          path: name,
          oldText: "a",
          newText: "b",
        });
        expect(edit.isError).toBe(true);
        expect(textOf(edit)).toContain("security denylist");
      }

      const template = await harness.tool("Read").execute("call-4", { path: ".env.example" });
      expect(template.isError).toBeUndefined();
    });
  });
});

describe("Write", () => {
  it("creates a file and returns the diff and content", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      const result = await harness.tool("Write").execute("call-1", {
        path: "src/new.ts",
        content: "alpha\nbeta\n",
      });
      expect(result.isError).toBeUndefined();
      expect(result.details).toMatchObject({
        fileName: "new.ts",
        additions: 2,
        deletions: 0,
        oldStr: "",
        newStr: "alpha\nbeta\n",
      });
      expect(result.details.diffStr).toContain("+alpha");
      expect(await readFile(harness.dir("src/new.ts"))).toBe("alpha\nbeta\n");
      expect(harness.seen.hasSeenRange(harness.dir("src/new.ts"), 1, 2)).toBe(true);
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
  it("applies hashline edits built from the tags Read returned", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.ts", "alpha\nbeta\ngamma\n");
      await harness.tool("Read").execute("call-1", { path: "file.ts" });

      const result = await harness.tool("Edit").execute("call-2", {
        path: "file.ts",
        edits: [{ op: "PUT", start: `2:${computeLineTag("beta")}`, content: "BETA\nBETA-2" }],
      });
      expect(result.isError).toBeUndefined();
      expect(await readFile(harness.dir("file.ts"))).toBe("alpha\nBETA\nBETA-2\ngamma\n");
      expect(result.details).toMatchObject({ additions: 2, deletions: 1 });
    });
  });

  it("rejects unseen lines with a free retry", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.ts", "alpha\nbeta\n");
      const result = await harness.tool("Edit").execute("call-1", {
        path: "file.ts",
        edits: [{ op: "CUT", start: `1:${computeLineTag("alpha")}` }],
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("EDIT_LINES_UNSEEN");
      expect(harness.recovery.peek(harness.dir("file.ts"))).toMatchObject({
        strikes: 0,
        freeRetryUsed: true,
      });
    });
  });

  it("hard-stops after three failed mutations and blocks Write", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.ts", "alpha\nbeta\n");
      const cut = { op: "CUT", start: `1:${computeLineTag("alpha")}` };

      const free = await harness.tool("Edit").execute("call-1", { path: "file.ts", edits: [cut] });
      expect(textOf(free)).toContain("EDIT_LINES_UNSEEN");
      expect(textOf(free)).toContain("One free retry");

      const first = await harness.tool("Edit").execute("call-2", { path: "file.ts", edits: [cut] });
      expect(textOf(first)).toContain("failed mutation 1 of 3");
      const second = await harness
        .tool("Edit")
        .execute("call-3", { path: "file.ts", edits: [cut] });
      expect(textOf(second)).toContain("failed mutation 2 of 3");
      const third = await harness.tool("Edit").execute("call-4", { path: "file.ts", edits: [cut] });
      expect(textOf(third)).toContain("Stop mutating");
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

  it("reports a tag mismatch after a read", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "file.ts", "alpha\n");
      await harness.tool("Read").execute("call-1", { path: "file.ts" });
      const result = await harness.tool("Edit").execute("call-2", {
        path: "file.ts",
        edits: [{ op: "CUT", start: "1:zz" }],
      });
      expect(textOf(result)).toContain("EDIT_TAG_MISMATCH");
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

  it("rejects missing, ambiguous, and unchanged edits", async () => {
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
      expect(textOf(noEdits)).toContain("both oldText and newText");

      const missing = await harness.tool("Edit").execute("call-4", {
        path: "missing.txt",
        oldText: "a",
        newText: "b",
      });
      expect(textOf(missing)).toContain("does not exist");

      await harness.tool("Read").execute("call-5", { path: "file.txt" });
      const noChange = await harness.tool("Edit").execute("call-6", {
        path: "file.txt",
        edits: [{ op: "PUT", start: `1:${computeLineTag("same")}`, content: "same" }],
      });
      expect(textOf(noChange)).toContain("EDIT_NO_CHANGE");
    });
  });
});

describe("Glob and Grep", () => {
  it("finds files by glob newest first while skipping ignored directories", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "a.ts", "");
      await writeFile(harness.directory, "src/b.ts", "");
      await writeFile(harness.directory, "src/nested/c.md", "");
      await writeFile(harness.directory, "node_modules/skip.ts", "");
      await writeFile(harness.directory, ".git/skip.ts", "");
      await setModified(harness.dir("a.ts"), 1_000);
      await setModified(harness.dir("src/nested/c.md"), 2_000);
      await setModified(harness.dir("src/b.ts"), 3_000);
      await setModified(harness.dir("node_modules/skip.ts"), 4_000);

      const result = await harness.tool("Glob").execute("call-1", { pattern: "**/*.ts" });
      expect(result.details.files).toEqual([harness.dir("src/b.ts"), harness.dir("a.ts")]);
      expect(result.details.truncated).toBe(false);

      const markdown = await harness.tool("Glob").execute("call-2", { query: "**/*.md" });
      expect(markdown.details.files).toEqual([harness.dir("src/nested/c.md")]);
    });
  });

  it("caps glob results after newest-first sorting", async () => {
    await withDirectory(async (make) => {
      const harness = make({ maxGlobResults: 1 });
      await writeFile(harness.directory, "one.ts", "");
      await writeFile(harness.directory, "two.ts", "");
      await setModified(harness.dir("one.ts"), 2_000);
      await setModified(harness.dir("two.ts"), 1_000);
      const result = await harness.tool("Glob").execute("call-1", { pattern: "*.ts" });
      expect(result.details.files).toEqual([harness.dir("one.ts")]);
      expect(result.details.truncated).toBe(true);
    });
  });

  it("honors workspace ignore files for Glob and Grep", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, ".ignore", "generated\n");
      await writeFile(harness.directory, "generated/out.ts", "needle\n");
      await writeFile(harness.directory, "src/keep.ts", "needle\n");

      const glob = await harness.tool("Glob").execute("call-1", { pattern: "**/*.ts" });
      expect(glob.details.files).toEqual([harness.dir("src/keep.ts")]);

      const grep = await harness.tool("Grep").execute("call-2", { pattern: "needle" });
      expect(grep.details.matches).toHaveLength(1);
      expect(grep.details.matches[0]).toMatchObject({ fileName: harness.dir("src/keep.ts") });
    });
  });

  it("drops denylisted files from Glob and Grep", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, ".env", "needle\n");
      await writeFile(harness.directory, "certs/server.pem", "needle\n");
      await writeFile(harness.directory, ".env.example", "needle\n");

      const glob = await harness.tool("Glob").execute("call-1", { pattern: "**/*" });
      expect(glob.details.files).toEqual([harness.dir(".env.example")]);

      const grep = await harness.tool("Grep").execute("call-2", { pattern: "needle" });
      expect(grep.details.matches.map((match: { fileName: string }) => match.fileName)).toEqual([
        harness.dir(".env.example"),
      ]);
    });
  });

  it("grep reports file, line, tag, and preview while skipping binaries", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "src/a.ts", "first\nconst needle = 1;\n");
      await writeFile(harness.directory, "src/notes.json", "needle\n");
      await setModified(harness.dir("src/a.ts"), 2_000);
      await setModified(harness.dir("src/notes.json"), 1_000);
      await NodeFSP.writeFile(
        NodePath.join(harness.directory, "src/binary.bin"),
        Buffer.from([0x00, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]),
      );

      const result = await harness.tool("Grep").execute("call-1", { pattern: "needle" });
      const matches = result.details.matches as ReadonlyArray<{
        fileName: string;
        tag: string;
        line: number;
        preview: string;
      }>;
      expect(matches).toHaveLength(2);
      expect(matches.map((match) => match.fileName)).toEqual([
        harness.dir("src/a.ts"),
        harness.dir("src/notes.json"),
      ]);
      expect(matches[0]).toMatchObject({ line: 2, preview: "const needle = 1;" });
      for (const match of matches) expect(match.tag).toMatch(/^[0-9A-F]{4}$/u);
      expect(textOf(result)).toContain(`[${harness.dir("src/a.ts")}#${matches[0]!.tag}]`);
      expect(textOf(result)).toContain("2: const needle = 1;");

      const filtered = await harness.tool("Grep").execute("call-2", {
        pattern: "needle",
        include: "*.ts",
      });
      expect(filtered.details.matches).toHaveLength(1);

      const caseInsensitive = await harness.tool("Grep").execute("call-3", {
        pattern: "NEEDLE",
        caseInsensitive: true,
      });
      expect(caseInsensitive.details.matches).toHaveLength(2);

      const none = await harness.tool("Grep").execute("call-4", { pattern: "absent" });
      expect(textOf(none)).toContain("No matches");
    });
  });

  it("supports filesWithMatches and count output modes with aliases", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      await writeFile(harness.directory, "a.ts", "needle\nneedle\n");
      await writeFile(harness.directory, "b.ts", "needle\n");
      await setModified(harness.dir("a.ts"), 2_000);
      await setModified(harness.dir("b.ts"), 1_000);

      const files = await harness.tool("Grep").execute("call-1", {
        query: "needle",
        output_mode: "files_with_matches",
      });
      expect(files.details.outputMode).toBe("filesWithMatches");
      expect(files.details.files).toEqual([
        { fileName: harness.dir("a.ts"), tag: files.details.files[0].tag },
        { fileName: harness.dir("b.ts"), tag: files.details.files[1].tag },
      ]);

      const limited = await harness.tool("Grep").execute("call-2", {
        pattern: "needle",
        outputMode: "filesWithMatches",
        head_limit: 1,
      });
      expect(limited.details.files).toHaveLength(1);
      expect(limited.details.truncated).toBe(true);

      const counts = await harness.tool("Grep").execute("call-3", {
        pattern: "needle",
        outputMode: "count",
      });
      expect(counts.details.counts).toEqual([
        { fileName: harness.dir("a.ts"), tag: counts.details.counts[0].tag, count: 2 },
        { fileName: harness.dir("b.ts"), tag: counts.details.counts[1].tag, count: 1 },
      ]);
      expect(counts.details.matches).toEqual([]);

      const headLimited = await harness.tool("Grep").execute("call-4", {
        pattern: "needle",
        headLimit: 1,
      });
      expect(headLimited.details.matches).toHaveLength(1);
      expect(headLimited.details.truncated).toBe(true);
    });
  });

  it("marks unclipped content hits as seen", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      const longLine = `needle${"x".repeat(20_000)}`;
      await writeFile(harness.directory, "src/a.ts", "alpha\nconst needle = 1;\n");
      await writeFile(harness.directory, "src/long.ts", `${longLine}\n`);

      const result = await harness.tool("Grep").execute("call-1", { pattern: "needle" });
      const matches = result.details.matches as ReadonlyArray<{
        fileName: string;
        clipped: boolean;
      }>;
      expect(matches.find((match) => match.fileName === harness.dir("src/long.ts"))?.clipped).toBe(
        true,
      );
      expect(harness.seen.hasSeenRange(harness.dir("src/a.ts"), 2, 2)).toBe(true);
      expect(harness.seen.hasSeenRange(harness.dir("src/long.ts"), 1, 1)).toBe(false);
    });
  });

  it("rejects invalid regular expressions", async () => {
    await withDirectory(async (make) => {
      const harness = make();
      const result = await harness.tool("Grep").execute("call-1", { pattern: "(" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Invalid regular expression");
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
