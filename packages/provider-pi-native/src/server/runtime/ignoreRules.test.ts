// @effect-diagnostics nodeBuiltinImport:off -- Ignore tests write real temporary files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { isSensitivePath, loadWorkspaceIgnoreRules, rgIgnoreArgs } from "./ignoreRules.ts";

const withDirectory = async (body: (directory: string) => Promise<void>): Promise<void> => {
  const directory = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-native-ignore-")),
  );
  try {
    await body(directory);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
};

const write = async (root: string, name: string, content: string): Promise<void> => {
  const target = NodePath.join(root, name);
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  await NodeFSP.writeFile(target, content);
};

describe("security denylist", () => {
  it("matches keys, env files, and credential bundles case-insensitively", () => {
    for (const name of [
      ".env",
      ".env.local",
      ".ENV.production",
      "server.pem",
      "private.key",
      "id_rsa",
      "id_ed25519",
      "bundle.p12",
      "cert.pfx",
      "credentials.json",
    ]) {
      expect(isSensitivePath(NodePath.join("/ws", name)), name).toBe(true);
    }
    for (const name of [
      ".env.example",
      ".env.sample",
      ".env.template",
      "environment.ts",
      "keys.rs",
      "id_rsa.pub.md",
      "package.json",
      ".pem",
    ]) {
      expect(isSensitivePath(NodePath.join("/ws", name)), name).toBe(false);
    }
  });

  it("blocks the .git/objects tree by path", () => {
    expect(isSensitivePath(NodePath.join("/ws", ".git", "objects", "ab", "cdef"))).toBe(true);
    expect(isSensitivePath(NodePath.join("/ws", ".git", "HEAD"))).toBe(false);
    expect(isSensitivePath(NodePath.join("/ws", "src", "objects", "index.ts"))).toBe(false);
  });
});

describe("workspace ignore layers", () => {
  it("applies app defaults and workspace ignore files to unscoped walks", async () => {
    await withDirectory(async (directory) => {
      await write(directory, ".gitignore", "ignored.ts\n");
      await write(directory, ".ignore", "*.tmp\n");
      await write(directory, ".pi-desktopignore", "manual/\n");
      await write(directory, "global-ignore", "global.txt\n");

      const rules = await loadWorkspaceIgnoreRules({
        ignoreRoot: directory,
        scoped: false,
        globalIgnoreFile: NodePath.join(directory, "global-ignore"),
      });

      expect(rules.isIgnored("node_modules", true)).toBe(true);
      expect(rules.isIgnored("dist", true)).toBe(true);
      expect(rules.isIgnored("foo.log", false)).toBe(true);
      expect(rules.isIgnored(".DS_Store", false)).toBe(true);
      expect(rules.isIgnored("ignored.ts", false)).toBe(true);
      expect(rules.isIgnored("scratch.tmp", false)).toBe(true);
      expect(rules.isIgnored("manual", true)).toBe(true);
      expect(rules.isIgnored("global.txt", false)).toBe(true);
      expect(rules.isIgnored("src/keep.ts", false)).toBe(false);
      expect(rules.ignoreFiles).toEqual([
        NodePath.join(directory, "global-ignore"),
        NodePath.join(directory, ".gitignore"),
        NodePath.join(directory, ".ignore"),
        NodePath.join(directory, ".pi-desktopignore"),
      ]);
    });
  });

  it("keeps only the security denylist for scoped walks", async () => {
    await withDirectory(async (directory) => {
      await write(directory, ".gitignore", "ignored.ts\n");
      const rules = await loadWorkspaceIgnoreRules({
        ignoreRoot: directory,
        scoped: true,
        globalIgnoreFile: null,
      });

      expect(rules.isIgnored("node_modules", true)).toBe(false);
      expect(rules.isIgnored("ignored.ts", false)).toBe(false);
      expect(rules.isIgnored("foo.log", false)).toBe(false);
      expect(rules.ignoreFiles).toEqual([]);

      const args = rgIgnoreArgs(rules);
      expect(args).toContain("!*.pem");
      expect(args).not.toContain("!node_modules");
    });
  });

  it("builds rg arguments for the app defaults and ignore files", async () => {
    await withDirectory(async (directory) => {
      await write(directory, ".gitignore", "ignored.ts\n");
      const rules = await loadWorkspaceIgnoreRules({
        ignoreRoot: directory,
        scoped: false,
        globalIgnoreFile: null,
      });
      const args = rgIgnoreArgs(rules);
      expect(args).toContain("!node_modules");
      expect(args).toContain("!*.log");
      expect(args).toContain("!*.pem");
      expect(args).toContain("--ignore-file");
      expect(args).toContain(NodePath.join(directory, ".gitignore"));
    });
  });

  it("lets a workspace negation re-include a pattern the app defaults do not own", async () => {
    await withDirectory(async (directory) => {
      await write(directory, ".gitignore", "*.tmp\n!keep.tmp\n");
      const rules = await loadWorkspaceIgnoreRules({
        ignoreRoot: directory,
        scoped: false,
        globalIgnoreFile: null,
      });
      expect(rules.isIgnored("drop.tmp", false)).toBe(true);
      expect(rules.isIgnored("keep.tmp", false)).toBe(false);
    });
  });
});

describe("app defaults", () => {
  it("covers dependency trees, build output, and log files", async () => {
    await withDirectory(async (directory) => {
      const rules = await loadWorkspaceIgnoreRules({
        ignoreRoot: directory,
        scoped: false,
        globalIgnoreFile: null,
      });
      expect(rules.isIgnored("node_modules", true)).toBe(true);
      expect(rules.isIgnored("target", true)).toBe(true);
      expect(rules.isIgnored(".git", true)).toBe(true);
      expect(rules.isIgnored("debug.log", false)).toBe(true);
      expect(rules.isIgnored("src", true)).toBe(false);
      expect(rules.isIgnored("index.ts", false)).toBe(false);
    });
  });
});
