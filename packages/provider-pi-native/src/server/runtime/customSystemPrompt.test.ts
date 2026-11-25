// @effect-diagnostics nodeBuiltinImport:off -- Prompt discovery reads real files from disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { loadCustomSystemPrompt } from "./customSystemPrompt.ts";

interface Roots {
  readonly workspace: string;
  readonly agentDir: string;
}

const makeDirectory = async (prefix: string): Promise<string> =>
  await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));

const withRoots = async (body: (roots: Roots) => Promise<void>): Promise<void> => {
  const workspace = await makeDirectory("pi-native-workspace-");
  const agentDir = await makeDirectory("pi-native-agent-");
  try {
    await body({ workspace, agentDir });
  } finally {
    await Promise.all(
      [workspace, agentDir].map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
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

const load = (roots: Roots) =>
  loadCustomSystemPrompt({ workspaceRoot: roots.workspace, agentDir: roots.agentDir });

describe("loadCustomSystemPrompt", () => {
  it("prefers the project prompt files over the global ones", async () => {
    await withRoots(async (roots) => {
      await writeFiles(roots.agentDir, {
        "SYSTEM.md": "global persona",
        "APPEND_SYSTEM.md": "global append",
      });
      await writeFiles(roots.workspace, {
        ".pi/SYSTEM.md": "project persona",
        ".pi/APPEND_SYSTEM.md": "project append",
      });

      expect(await load(roots)).toEqual({ replace: "project persona", append: "project append" });
    });
  });

  it("discovers SYSTEM.md and APPEND_SYSTEM.md independently", async () => {
    await withRoots(async (roots) => {
      await writeFiles(roots.agentDir, { "SYSTEM.md": "global persona" });
      await writeFiles(roots.workspace, { ".pi/APPEND_SYSTEM.md": "project append" });

      expect(await load(roots)).toEqual({
        replace: "global persona",
        append: "project append",
      });
    });
  });

  it("treats whitespace-only files as absent", async () => {
    await withRoots(async (roots) => {
      await writeFiles(roots.agentDir, { "SYSTEM.md": "global persona" });
      await writeFiles(roots.workspace, { ".pi/SYSTEM.md": "  \n\t" });

      expect(await load(roots)).toEqual({ replace: "global persona" });
    });
  });

  it("caps a prompt at 64 KiB without splitting a character", async () => {
    await withRoots(async (roots) => {
      await writeFiles(roots.workspace, { ".pi/APPEND_SYSTEM.md": "é".repeat(40 * 1024) });

      expect((await load(roots))?.append).toBe("é".repeat(32 * 1024));
    });
  });

  it("returns undefined when no prompt file exists", async () => {
    await withRoots(async (roots) => {
      expect(await load(roots)).toBeUndefined();
      expect(
        await loadCustomSystemPrompt({ workspaceRoot: null, agentDir: roots.agentDir }),
      ).toBeUndefined();
    });
  });
});
