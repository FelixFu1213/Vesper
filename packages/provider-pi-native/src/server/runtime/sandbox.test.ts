// @effect-diagnostics nodeBuiltinImport:off -- Sandbox tests exercise real filesystem canonicalization.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { canonicalizePath, WorkspaceSandbox } from "./sandbox.ts";

const windows = HostProcess.Platform.defaultValue() === "win32";

const makeDirectory = async (prefix: string): Promise<string> =>
  NodeFSP.realpath(await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix)));

const withDirectories = async (
  body: (workspace: string, outside: string) => Promise<void>,
): Promise<void> => {
  const workspace = await makeDirectory("pi-native-workspace-");
  const outside = await makeDirectory("pi-native-outside-");
  try {
    await body(workspace, outside);
  } finally {
    await NodeFSP.rm(workspace, { recursive: true, force: true });
    await NodeFSP.rm(outside, { recursive: true, force: true });
  }
};

describe("WorkspaceSandbox", () => {
  it("resolves relative paths against the workspace folder", async () => {
    await withDirectories(async (workspace) => {
      await NodeFSP.writeFile(NodePath.join(workspace, "file.ts"), "const value = 1;\n");
      const sandbox = new WorkspaceSandbox({ cwd: workspace });
      const resolution = await sandbox.resolvePath("file.ts", "read");
      expect(resolution.resolvedPath).toBe(NodePath.join(workspace, "file.ts"));
      expect(resolution.classification).toBe("workspace");
      expect(resolution.denied).toBe(false);
    });
  });

  it("classifies paths outside every root as external", async () => {
    await withDirectories(async (workspace, outside) => {
      const sandbox = new WorkspaceSandbox({ cwd: workspace });
      const resolution = await sandbox.resolvePath(NodePath.join(outside, "secret.txt"), "read");
      expect(resolution.classification).toBe("external");
      expect(resolution.denied).toBe(false);

      const escape = await sandbox.resolvePath("../outside/secret.txt", "read");
      expect(escape.classification).toBe("external");
    });
  });

  it("grants extra roots as writable workspace", async () => {
    await withDirectories(async (workspace, outside) => {
      const sandbox = new WorkspaceSandbox({ cwd: workspace, extraRoots: [outside] });
      const resolution = await sandbox.resolvePath(NodePath.join(outside, "file.ts"), "write");
      expect(resolution.classification).toBe("workspace");
      expect(resolution.denied).toBe(false);
      expect(sandbox.workspaceRoots).toContain(outside);
    });
  });

  it("refuses writes into read-only attachment roots", async () => {
    await withDirectories(async (workspace, outside) => {
      const attachment = NodePath.join(outside, "attachment.png");
      await NodeFSP.writeFile(attachment, "fixture");
      const sandbox = new WorkspaceSandbox({ cwd: workspace, readOnlyRoots: [outside] });

      const read = await sandbox.resolvePath(attachment, "read");
      expect(read.classification).toBe("readonly_attachment");
      expect(read.denied).toBe(false);

      const write = await sandbox.resolvePath(attachment, "write");
      expect(write.classification).toBe("readonly_attachment");
      expect(write.denied).toBe(true);
      expect(write.writeDeniedReason).toContain("read-only");
    });
  });

  it("keeps a not-yet-created file inside its existing parent", async () => {
    await withDirectories(async (workspace) => {
      const sandbox = new WorkspaceSandbox({ cwd: workspace });
      const resolution = await sandbox.resolvePath("nested/deep/new.ts", "write");
      expect(resolution.resolvedPath).toBe(NodePath.join(workspace, "nested/deep/new.ts"));
      expect(resolution.classification).toBe("workspace");
    });
  });

  it.skipIf(windows)("follows a symlinked parent into the outside world", async () => {
    await withDirectories(async (workspace, outside) => {
      await NodeFSP.symlink(outside, NodePath.join(workspace, "link"));
      await NodeFSP.writeFile(NodePath.join(outside, "secret.txt"), "fixture");
      const sandbox = new WorkspaceSandbox({ cwd: workspace });

      const existing = await sandbox.resolvePath("link/secret.txt", "read");
      expect(existing.classification).toBe("external");
      expect(existing.resolvedPath).toBe(NodePath.join(outside, "secret.txt"));

      const created = await sandbox.resolvePath("link/new.txt", "write");
      expect(created.classification).toBe("external");
    });
  });

  it.skipIf(windows)("canonicalizes a symlinked workspace root", async () => {
    await withDirectories(async (workspace) => {
      const link = `${workspace}-link`;
      await NodeFSP.symlink(workspace, link);
      try {
        const sandbox = new WorkspaceSandbox({ cwd: link });
        expect(sandbox.cwd).toBe(workspace);
        const resolution = await sandbox.resolvePath(NodePath.join(workspace, "file.ts"), "read");
        expect(resolution.classification).toBe("workspace");
      } finally {
        await NodeFSP.rm(link, { force: true });
      }
    });
  });

  it("fails cleanly on a relative path without a workspace folder", async () => {
    const sandbox = new WorkspaceSandbox({ cwd: null });
    await expect(sandbox.resolvePath("relative.ts", "read")).rejects.toThrow("no workspace folder");
    const absolute = await sandbox.resolvePath(NodePath.resolve("/tmp/absolute.ts"), "read");
    expect(absolute.classification).toBe("external");
  });

  it("exposes the synchronous resolution for callers that cannot await", async () => {
    await withDirectories(async (workspace) => {
      const sandbox = new WorkspaceSandbox({ cwd: workspace });
      const resolution = sandbox.resolvePathSync("file.ts", "write");
      expect(resolution.resolvedPath).toBe(NodePath.join(workspace, "file.ts"));
      expect(resolution.classification).toBe("workspace");
    });
  });

  it("canonicalizes paths that do not exist yet", async () => {
    await withDirectories(async (workspace) => {
      const target = NodePath.join(workspace, "missing", "file.ts");
      expect(await canonicalizePath(target)).toBe(target);
    });
  });
});
