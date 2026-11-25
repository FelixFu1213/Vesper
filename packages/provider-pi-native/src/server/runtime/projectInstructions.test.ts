// @effect-diagnostics nodeBuiltinImport:off -- Instruction loading reads real files and symlinks.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectInstructionTracker,
  renderProjectInstructions,
  truncateUtf8,
} from "./projectInstructions.ts";

const makeDirectory = async (prefix: string): Promise<string> =>
  NodeFSP.realpath(await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix)));

interface Roots {
  readonly workspace: string;
  readonly home: string;
  readonly outside: string;
}

const withRoots = async (body: (roots: Roots) => Promise<void>): Promise<void> => {
  const workspace = await makeDirectory("pi-native-workspace-");
  const home = await makeDirectory("pi-native-home-");
  const outside = await makeDirectory("pi-native-outside-");
  try {
    await body({ workspace, home, outside });
  } finally {
    await Promise.all(
      [workspace, home, outside].map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
    );
  }
};

const writeFiles = async (root: string, files: Record<string, string>): Promise<void> => {
  for (const [name, content] of Object.entries(files)) {
    const target = NodePath.join(root, name);
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, content, "utf8");
  }
};

const tracker = (roots: Roots): ProjectInstructionTracker =>
  new ProjectInstructionTracker({ workspaceRoot: roots.workspace, agentDir: roots.home });

const sources = (
  instructions: { readonly entries: ReadonlyArray<{ source: string }> } | undefined,
) => (instructions?.entries ?? []).map((entry) => entry.source);

const contents = (
  instructions: { readonly entries: ReadonlyArray<{ content: string }> } | undefined,
) => (instructions?.entries ?? []).map((entry) => entry.content);

describe("ProjectInstructionTracker", () => {
  it("chains the global file, then the workspace root down to the file's directory", async () => {
    await withRoots(async (roots) => {
      await writeFiles(roots.home, { "AGENTS.md": "global rules" });
      await writeFiles(roots.workspace, {
        "AGENTS.md": "root rules",
        "pkg/AGENTS.md": "package rules",
        "pkg/src/file.ts": "",
      });

      const loaded = await tracker(roots).visit("pkg/src/file.ts");

      expect(sources(loaded)).toEqual(["~/.pi/agent/AGENTS.md", "AGENTS.md", "pkg/AGENTS.md"]);
      expect(contents(loaded)).toEqual(["global rules", "root rules", "package rules"]);
    });
  });

  it("takes one file per directory by precedence", async () => {
    await withRoots(async (roots) => {
      await writeFiles(roots.workspace, {
        "AGENTS.override.md": "root override",
        "AGENTS.md": "root agents",
        "CLAUDE.md": "root claude",
        "a/CLAUDE.md": "a claude",
        "a/.claude/CLAUDE.md": "a dot claude",
        "b/.claude/CLAUDE.md": "b dot claude",
      });
      const chain = tracker(roots);

      expect(contents(await chain.visit())).toEqual(["root override"]);
      expect(contents(await chain.visit("a/file.ts"))).toEqual(["root override", "a claude"]);
      expect(contents(await chain.visit("b/file.ts"))).toEqual(["root override", "b dot claude"]);
    });
  });

  it("never reads an instruction file whose real path leaves the workspace", async () => {
    await withRoots(async (roots) => {
      await writeFiles(roots.outside, { "AGENTS.md": "host rules" });
      await writeFiles(roots.workspace, { "pkg/AGENTS.md": "package rules" });
      await NodeFSP.symlink(
        NodePath.join(roots.outside, "AGENTS.md"),
        NodePath.join(roots.workspace, "AGENTS.md"),
      );

      const loaded = await tracker(roots).visit("pkg/file.ts");

      expect(contents(loaded)).toEqual(["package rules"]);
    });
  });

  it("keeps the root chain for a path outside the workspace", async () => {
    await withRoots(async (roots) => {
      await writeFiles(roots.workspace, { "AGENTS.md": "root rules" });
      await writeFiles(roots.outside, { "AGENTS.md": "host rules" });

      const loaded = await tracker(roots).visit(NodePath.join(roots.outside, "file.ts"));

      expect(contents(loaded)).toEqual(["root rules"]);
    });
  });

  it("truncates an oversized file with a notice and stops before closer directories", async () => {
    await withRoots(async (roots) => {
      const filler = "é".repeat(20 * 1024);
      await writeFiles(roots.workspace, {
        "AGENTS.md": filler,
        "pkg/AGENTS.md": "package rules",
      });

      const loaded = await tracker(roots).visit("pkg/file.ts");
      const entry = loaded?.entries[0];
      const [kept, notice] = (entry?.content ?? "").split("\n\n");

      expect(sources(loaded)).toEqual(["AGENTS.md"]);
      // 32 KiB keeps exactly 16,384 two-byte characters, never half of one.
      expect(kept).toBe("é".repeat(16 * 1024));
      expect(notice).toContain("Vesper truncated AGENTS.md");
      expect(notice).toContain("the first 32768 of 40960 bytes");
    });
  });

  it("caps the global file and the project chain independently", async () => {
    await withRoots(async (roots) => {
      await writeFiles(roots.home, { "AGENTS.md": "g".repeat(40 * 1024) });
      await writeFiles(roots.workspace, { "AGENTS.md": "root rules" });

      const loaded = await tracker(roots).visit();

      expect(sources(loaded)).toEqual(["~/.pi/agent/AGENTS.md", "AGENTS.md"]);
      expect(loaded?.entries[0]?.content).toContain("Vesper truncated ~/.pi/agent/AGENTS.md");
      expect(loaded?.entries[1]?.content).toBe("root rules");
    });
  });

  it("reports a change only when the chain digest changes", async () => {
    await withRoots(async (roots) => {
      await writeFiles(roots.workspace, { "AGENTS.md": "v1", "pkg/AGENTS.md": "package rules" });
      const chain = tracker(roots);

      expect(contents(await chain.visit())).toEqual(["v1"]);
      expect(await chain.visit()).toBeUndefined();

      await writeFiles(roots.workspace, { "AGENTS.md": "v2" });
      expect(contents(await chain.visit())).toEqual(["v2"]);

      expect(contents(await chain.visit("pkg/file.ts"))).toEqual(["v2", "package rules"]);
      expect(chain.current?.entries).toHaveLength(2);
      expect(await chain.visit("pkg/other.ts")).toBeUndefined();
    });
  });

  it("loads nothing when no instruction file exists", async () => {
    await withRoots(async (roots) => {
      expect(await tracker(roots).visit()).toBeUndefined();
      expect(tracker(roots).current).toBeUndefined();
    });
  });
});

describe("renderProjectInstructions", () => {
  it("renders one heading per entry, nearest last, and nothing for an empty chain", () => {
    expect(renderProjectInstructions(undefined)).toBeUndefined();
    expect(renderProjectInstructions({ entries: [] })).toBeUndefined();

    const rendered = renderProjectInstructions({
      entries: [
        { source: "AGENTS.md", content: "root rules" },
        { source: "pkg/AGENTS.md", content: "package rules" },
      ],
    });

    expect(rendered).toContain("# Project instructions");
    expect(rendered).toContain("package rules");
    expect(rendered?.indexOf("## AGENTS.md") ?? 0).toBeLessThan(
      rendered?.indexOf("## pkg/AGENTS.md") ?? 0,
    );
  });
});

describe("truncateUtf8", () => {
  it("leaves text under the cap alone and cuts multibyte text on a character boundary", () => {
    expect(truncateUtf8("abc", 3)).toEqual({
      text: "abc",
      bytes: 3,
      totalBytes: 3,
      truncated: false,
    });

    const cut = truncateUtf8("aé", 2);
    expect(cut).toEqual({ text: "a", bytes: 1, totalBytes: 3, truncated: true });
  });
});
