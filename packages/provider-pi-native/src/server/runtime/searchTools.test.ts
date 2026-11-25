// @effect-diagnostics nodeBuiltinImport:off -- Search tests write temporary files and spawn a fake rg.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  canonicalizeToolParams,
  describeDirectoryReadHint,
  globFiles,
  normalizeOutputMode,
  SEARCH_PARAM_ALIASES,
  searchFiles,
  type SearchFileAnchorSink,
} from "./searchTools.ts";

const windows = HostProcess.Platform.defaultValue() === "win32";
const SEARCH_MAX_LINE_CHARS = 16_384;

const normalizeForTag = (text: string): string =>
  text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\r]+$/u, ""))
    .join("\n");

const mintFileTag = (content: string): string => {
  const digest = NodeCrypto.createHash("sha256").update(normalizeForTag(content), "utf8").digest();
  const low = ((digest[30] ?? 0) << 8) | (digest[31] ?? 0);
  return low.toString(16).toUpperCase().padStart(4, "0");
};

const withDirectory = async (body: (directory: string) => Promise<void>): Promise<void> => {
  const directory = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-native-search-")),
  );
  try {
    await body(directory);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
};

const write = async (root: string, name: string, content: string): Promise<string> => {
  const target = NodePath.join(root, name);
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  await NodeFSP.writeFile(target, content);
  return target;
};

const setModified = async (target: string, seconds: number): Promise<void> => {
  await NodeFSP.utimes(target, seconds, seconds);
};

const script = async (directory: string, name: string, content: string): Promise<string> => {
  const target = await write(directory, name, content);
  await NodeFSP.chmod(target, 0o755);
  return target;
};

const baseOptions = (directory: string) => ({
  root: directory,
  ignoreRoot: directory,
  scoped: false,
  globalIgnoreFile: null as string | null,
});

describe("searchFiles", () => {
  it("returns content hits newest first with tags and workspace ignores", async () => {
    await withDirectory(async (directory) => {
      const older = await write(directory, "src/a.ts", "first\nconst needle = 1;\n");
      const newer = await write(directory, "src/b.ts", "needle  \r\n");
      await setModified(older, 1_000);
      await setModified(newer, 2_000);
      await write(directory, "node_modules/skip.ts", "needle\n");
      await write(directory, ".gitignore", "generated\n");
      await write(directory, "generated/out.ts", "needle\n");

      const result = await searchFiles({
        ...baseOptions(directory),
        pattern: "needle",
        outputMode: "content",
        caseInsensitive: false,
        headLimit: 200,
        rgPath: null,
      });

      expect(result.files.map((file) => file.path)).toEqual([newer, older]);
      expect(result.files[0]?.tag).toBe(mintFileTag("needle\n"));
      expect(result.files[1]?.hits[0]).toMatchObject({ line: 2, text: "const needle = 1;" });
      expect(result.totalMatches).toBe(2);
      expect(result.truncated).toBe(false);
    });
  });

  it("clips long lines, records unclipped hits as seen, and honors headLimit", async () => {
    await withDirectory(async (directory) => {
      await write(directory, "src/short.ts", "alpha\nconst needle = 1;\n");
      await write(directory, "src/long.ts", `needle${"x".repeat(SEARCH_MAX_LINE_CHARS + 8)}\n`);

      const seen: Array<{ path: string; lines: ReadonlyArray<number> }> = [];
      const anchorSink: SearchFileAnchorSink = {
        recordContentHits: ({ path, lines }) => {
          seen.push({ path, lines });
        },
      };

      const clipped = await searchFiles({
        ...baseOptions(directory),
        pattern: "needle",
        outputMode: "content",
        caseInsensitive: false,
        headLimit: 200,
        rgPath: null,
        anchorSink,
      });
      const longFile = clipped.files.find(
        (file) => file.path === NodePath.join(directory, "src/long.ts"),
      );
      expect(longFile?.hits[0]?.clipped).toBe(true);
      expect(longFile?.hits[0]?.text).toHaveLength(SEARCH_MAX_LINE_CHARS);
      expect(seen.find((entry) => entry.path.endsWith("long.ts"))).toBeUndefined();
      expect(seen.find((entry) => entry.path.endsWith("short.ts"))?.lines).toEqual([2]);

      const limited = await searchFiles({
        ...baseOptions(directory),
        pattern: "needle",
        outputMode: "content",
        caseInsensitive: false,
        headLimit: 1,
        rgPath: null,
      });
      expect(limited.totalMatches).toBe(1);
      expect(limited.truncated).toBe(true);
    });
  });

  it("supports filesWithMatches and count modes", async () => {
    await withDirectory(async (directory) => {
      const a = await write(directory, "a.ts", "needle\nneedle\n");
      const b = await write(directory, "b.ts", "needle\n");
      await setModified(a, 1_000);
      await setModified(b, 2_000);

      const files = await searchFiles({
        ...baseOptions(directory),
        pattern: "needle",
        outputMode: "filesWithMatches",
        caseInsensitive: false,
        headLimit: 1,
        rgPath: null,
      });
      expect(files.files).toHaveLength(1);
      expect(files.files[0]?.path).toBe(b);
      expect(files.totalMatches).toBe(1);
      expect(files.truncated).toBe(true);

      const counts = await searchFiles({
        ...baseOptions(directory),
        pattern: "needle",
        outputMode: "count",
        caseInsensitive: false,
        headLimit: 200,
        rgPath: null,
      });
      expect(counts.files.map((file) => [NodePath.basename(file.path), file.count])).toEqual([
        ["b.ts", 1],
        ["a.ts", 2],
      ]);
      expect(counts.totalMatches).toBe(3);
    });
  });

  it("filters by include glob and searches a scoped tree past app defaults", async () => {
    await withDirectory(async (directory) => {
      await write(directory, "src/a.ts", "needle\n");
      await write(directory, "src/a.md", "needle\n");
      await write(directory, "node_modules/pkg/index.ts", "needle\n");

      const included = await searchFiles({
        ...baseOptions(directory),
        pattern: "needle",
        include: "*.ts",
        outputMode: "content",
        caseInsensitive: false,
        headLimit: 200,
        rgPath: null,
      });
      expect(included.files.map((file) => NodePath.basename(file.path))).toEqual(["a.ts"]);

      const scoped = await searchFiles({
        ...baseOptions(directory),
        root: NodePath.join(directory, "node_modules"),
        scoped: true,
        pattern: "needle",
        outputMode: "content",
        caseInsensitive: false,
        headLimit: 200,
        rgPath: null,
      });
      expect(scoped.files.map((file) => file.path)).toEqual([
        NodePath.join(directory, "node_modules/pkg/index.ts"),
      ]);
    });
  });

  it("falls back to the in-process searcher when rg cannot spawn", async () => {
    await withDirectory(async (directory) => {
      await write(directory, "a.ts", "needle\n");
      const result = await searchFiles({
        ...baseOptions(directory),
        pattern: "needle",
        outputMode: "content",
        caseInsensitive: false,
        headLimit: 200,
        rgPath: NodePath.join(directory, "missing-rg"),
      });
      expect(result.totalMatches).toBe(1);
    });
  });

  it.skipIf(windows)("falls back when rg exits 2", async () => {
    await withDirectory(async (directory) => {
      await write(directory, "a.ts", "needle\n");
      const failing = await script(directory, "rg-fail", "#!/bin/sh\nexit 2\n");
      const result = await searchFiles({
        ...baseOptions(directory),
        pattern: "needle",
        outputMode: "content",
        caseInsensitive: false,
        headLimit: 200,
        rgPath: failing,
      });
      expect(result.totalMatches).toBe(1);
    });
  });

  it.skipIf(windows)("parses the rg --json fast path", async () => {
    await withDirectory(async (directory) => {
      const target = await write(directory, "a.ts", "first\nconst needle = 1;\n");
      const event = JSON.stringify({
        type: "match",
        data: {
          path: { text: target },
          line_number: 2,
          lines: { text: "const needle = 1;\n" },
        },
      });
      const rg = await script(directory, "fake-rg", `#!/bin/sh\nprintf '%s\\n' '${event}'\n`);
      const result = await searchFiles({
        ...baseOptions(directory),
        pattern: "needle",
        outputMode: "content",
        caseInsensitive: false,
        headLimit: 200,
        rgPath: rg,
      });
      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toMatchObject({
        path: target,
        tag: mintFileTag("first\nconst needle = 1;\n"),
      });
      expect(result.files[0]?.hits[0]).toMatchObject({ line: 2, text: "const needle = 1;" });
      expect(result.totalMatches).toBe(1);
    });
  });

  it.skipIf(windows)("propagates truncated when rg stdout hits stdoutCapBytes", async () => {
    await withDirectory(async (directory) => {
      const target = await write(directory, "a.ts", "const needle = 1;\n");
      const event = JSON.stringify({
        type: "match",
        data: {
          path: { text: target },
          line_number: 1,
          lines: { text: "const needle = 1;\n" },
        },
      });
      const rg = await script(
        directory,
        "capped-rg",
        `#!/bin/sh\nprintf '%s\\n' '${event}'\nprintf '%s\\n' '${event}'\n`,
      );
      const result = await searchFiles({
        ...baseOptions(directory),
        pattern: "needle",
        outputMode: "filesWithMatches",
        caseInsensitive: false,
        headLimit: 200,
        rgPath: rg,
        stdoutCapBytes: 32,
      });
      expect(result.truncated).toBe(true);
    });
  });
});

describe("globFiles", () => {
  it("orders matches newest first and applies the ignore layers", async () => {
    await withDirectory(async (directory) => {
      const older = await write(directory, "src/a.ts", "");
      const newer = await write(directory, "src/b.ts", "");
      await setModified(older, 1_000);
      await setModified(newer, 2_000);
      await write(directory, "node_modules/pkg/c.ts", "");
      await write(directory, ".pi-ignore", "*.md\n");
      await write(directory, "notes.md", "");

      const result = await globFiles({
        ...baseOptions(directory),
        pattern: "src/**/*",
        limit: 500,
      });
      expect(result.files).toEqual([newer, older]);
      expect(result.truncated).toBe(false);

      const all = await globFiles({
        ...baseOptions(directory),
        pattern: "**/*.ts",
        limit: 500,
      });
      expect(all.files).toEqual([newer, older]);
    });
  });
});

describe("parameter aliases", () => {
  it("folds alias spellings onto canonical names", () => {
    expect(
      canonicalizeToolParams(
        {
          file_path: "/tmp/a.ts",
          query: "needle",
          glob: "*.ts",
          output_mode: "count",
          head_limit: 5,
        },
        { file_path: "path", ...SEARCH_PARAM_ALIASES },
      ),
    ).toEqual({
      path: "/tmp/a.ts",
      pattern: "needle",
      include: "*.ts",
      outputMode: "count",
      headLimit: 5,
    });
  });

  it("keeps the canonical value when both spellings are present", () => {
    expect(
      canonicalizeToolParams({ path: "/canonical", file_path: "/alias" }, { file_path: "path" }),
    ).toEqual({ path: "/canonical" });
  });

  it("normalizes output mode spellings", () => {
    expect(normalizeOutputMode(undefined)).toBe("content");
    expect(normalizeOutputMode("files_with_matches")).toBe("filesWithMatches");
    expect(normalizeOutputMode("files-with-matches")).toBe("filesWithMatches");
    expect(normalizeOutputMode("count")).toBe("count");
    expect(() => normalizeOutputMode("nope")).toThrow(/unknown outputMode/u);
  });
});

describe("describeDirectoryReadHint", () => {
  it("names Glob and the recursive pattern", () => {
    expect(describeDirectoryReadHint("/workspace/src")).toContain("is a directory");
    expect(describeDirectoryReadHint("/workspace/src")).toContain('pattern="**/*"');
    expect(describeDirectoryReadHint("/workspace/src")).toContain("use Glob");
  });
});
