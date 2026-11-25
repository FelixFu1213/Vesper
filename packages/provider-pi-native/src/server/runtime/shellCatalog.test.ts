// @effect-diagnostics nodeBuiltinImport:off -- Scratch lifecycle tests use a real temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCommandShellCatalog,
  COMMAND_SHELL_DIALECTS,
  COMMAND_SHELL_IDS,
  commandShellDialect,
  probeLoginShellPath,
  resolveTurnShell,
  SessionScratchDir,
} from "./shellCatalog.ts";

const files = (paths: ReadonlyArray<string>) => {
  const present = new Set(paths);
  return (absolute: string) => present.has(absolute);
};

const windowsEnvironment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ProgramFiles: "C:\\Program Files",
  SystemRoot: "C:\\Windows",
  PATH: "C:\\Windows\\System32",
  ...overrides,
});

describe("command shell ids", () => {
  it("keeps the stable id list and dialects", () => {
    expect(COMMAND_SHELL_IDS).toEqual([
      "windows-powershell",
      "windows-pwsh",
      "cmd",
      "git-bash",
      "bash",
    ]);
    expect(COMMAND_SHELL_DIALECTS).toEqual(["powershell", "cmd", "posix"]);
    expect(commandShellDialect("windows-pwsh")).toBe("powershell");
    expect(commandShellDialect("cmd")).toBe("cmd");
    expect(commandShellDialect("git-bash")).toBe("posix");
  });
});

describe("buildCommandShellCatalog", () => {
  it("offers the Windows shells it can find", () => {
    const catalog = buildCommandShellCatalog({
      platform: "win32",
      environment: windowsEnvironment(),
      isFile: files([
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Windows\\System32\\cmd.exe",
      ]),
    });
    expect(catalog.configuredId).toBeNull();
    expect(catalog.effective?.id).toBe("windows-powershell");
    expect(catalog.fallback).toBe(false);
    expect(catalog.choices.map((choice) => choice.id)).toEqual([
      "windows-powershell",
      "windows-pwsh",
      "cmd",
      "git-bash",
      "bash",
    ]);
    expect(catalog.choices.every((choice) => choice.available)).toBe(true);
    expect(catalog.choices.find((choice) => choice.id === "windows-powershell")?.isDefault).toBe(
      true,
    );
  });

  it("falls back to the first available platform shell when the configured one vanished", () => {
    const catalog = buildCommandShellCatalog({
      configuredId: "windows-pwsh",
      platform: "win32",
      environment: windowsEnvironment(),
      isFile: files(["C:\\Windows\\System32\\cmd.exe"]),
    });
    expect(catalog.configuredId).toBe("windows-pwsh");
    expect(catalog.effective?.id).toBe("cmd");
    expect(catalog.fallback).toBe(true);
  });

  it("uses the bash env override on Unix", () => {
    const catalog = buildCommandShellCatalog({
      platform: "linux",
      environment: { PATH: "/usr/bin", T3_PI_BASH: "/opt/custom/bash" },
      isFile: files(["/opt/custom/bash"]),
    });
    expect(catalog.effective?.id).toBe("bash");
    expect(catalog.choices.find((choice) => choice.id === "bash")?.isDefault).toBe(true);
  });

  it("accepts the PI-Desktop override name", () => {
    const catalog = buildCommandShellCatalog({
      platform: "darwin",
      environment: { PATH: "", PI_DESKTOP_BASH: "/opt/homebrew/bin/bash" },
      isFile: files(["/opt/homebrew/bin/bash"]),
    });
    expect(catalog.effective?.id).toBe("bash");
  });
});

describe("resolveTurnShell", () => {
  it("pins bash with a login shell on Unix", () => {
    const shell = resolveTurnShell({
      platform: "linux",
      environment: { PATH: "/usr/bin" },
      isFile: files(["/bin/bash"]),
    });
    expect(shell).toEqual({
      id: "bash",
      dialect: "posix",
      executable: "/bin/bash",
      args: ["-lc"],
    });
  });

  it("honors a non-login request", () => {
    const shell = resolveTurnShell({
      platform: "linux",
      environment: { PATH: "/usr/bin" },
      isFile: files(["/usr/bin/bash"]),
      loginShell: false,
    });
    expect(shell.args).toEqual(["-c"]);
  });

  it("falls back to /bin/sh when bash is missing", () => {
    const shell = resolveTurnShell({
      platform: "linux",
      environment: { PATH: "" },
      isFile: files([]),
    });
    expect(shell.executable).toBe("/bin/sh");
    expect(shell.args).toEqual(["-c"]);
  });

  it("rejects a bash override that is not an executable", () => {
    expect(() =>
      resolveTurnShell({
        platform: "linux",
        environment: { PATH: "/usr/bin", T3_PI_BASH: "/missing/bash" },
        isFile: files(["/bin/bash"]),
      }),
    ).toThrowError(/SHELL_NOT_FOUND/u);
  });

  it("uses Git Bash with -c on Windows", () => {
    const shell = resolveTurnShell({
      platform: "win32",
      configuredId: "git-bash",
      environment: windowsEnvironment({ PATH: "C:\\Program Files\\Git\\bin" }),
      isFile: files([
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files\\Git\\bin\\git.exe",
      ]),
    });
    expect(shell.id).toBe("git-bash");
    expect(shell.executable).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(shell.args).toEqual(["-c"]);
  });

  it("finds Git Bash next to the git on PATH and skips the WSL launcher", () => {
    const shell = resolveTurnShell({
      platform: "win32",
      configuredId: "git-bash",
      environment: windowsEnvironment({
        PATH: "C:\\Windows\\System32;C:\\Tools\\Git\\cmd",
        ProgramFiles: "C:\\Absent",
      }),
      isFile: files([
        "C:\\Tools\\Git\\cmd\\git.exe",
        "C:\\Tools\\Git\\bin\\bash.exe",
        "C:\\Windows\\System32\\bash.exe",
        "C:\\Windows\\System32\\cmd.exe",
      ]),
    });
    expect(shell.executable).toBe("C:\\Tools\\Git\\bin\\bash.exe");
  });

  it("uses PowerShell's non-interactive invocation", () => {
    const shell = resolveTurnShell({
      platform: "win32",
      configuredId: "windows-pwsh",
      environment: windowsEnvironment(),
      isFile: files([
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        "C:\\Windows\\System32\\cmd.exe",
      ]),
    });
    expect(shell.id).toBe("windows-pwsh");
    expect(shell.args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  });

  it("uses cmd with /c", () => {
    const shell = resolveTurnShell({
      platform: "win32",
      environment: windowsEnvironment(),
      isFile: files(["C:\\Windows\\System32\\cmd.exe"]),
    });
    expect(shell.id).toBe("cmd");
    expect(shell.args).toEqual(["/c"]);
  });
});

describe("probeLoginShellPath", () => {
  it("returns the login shell PATH and caches it per shell", async () => {
    const calls: Array<{ executable: string; args: ReadonlyArray<string>; timeoutMs: number }> = [];
    const cache = new Map<string, Promise<string | null>>();
    const input = {
      platform: "darwin" as const,
      environment: { SHELL: "/bin/zsh" },
      isFile: files(["/bin/zsh"]),
      cache,
      run: async (executable: string, args: ReadonlyArray<string>, timeoutMs: number) => {
        calls.push({ executable, args, timeoutMs });
        return "/opt/homebrew/bin:/usr/bin";
      },
    };
    expect(await probeLoginShellPath(input)).toBe("/opt/homebrew/bin:/usr/bin");
    expect(await probeLoginShellPath(input)).toBe("/opt/homebrew/bin:/usr/bin");
    expect(calls).toEqual([
      { executable: "/bin/zsh", args: ["-lic", 'printf %s "$PATH"'], timeoutMs: 5_000 },
    ]);
  });

  it("falls back to null when the probe fails or times out", async () => {
    const failed = await probeLoginShellPath({
      platform: "linux",
      environment: { SHELL: "/bin/bash" },
      isFile: files(["/bin/bash"]),
      cache: new Map(),
      run: async () => null,
    });
    expect(failed).toBeNull();

    const thrown = await probeLoginShellPath({
      platform: "linux",
      environment: {},
      isFile: files(["/bin/sh"]),
      cache: new Map(),
      run: async () => {
        throw new Error("timed out");
      },
    });
    expect(thrown).toBeNull();
  });

  it("does nothing on Windows", async () => {
    expect(
      await probeLoginShellPath({ platform: "win32", environment: {}, isFile: () => true }),
    ).toBeNull();
  });
});

describe("SessionScratchDir", () => {
  const withBase = async (body: (base: string) => Promise<void>): Promise<void> => {
    const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-native-scratch-test-"));
    try {
      await body(base);
    } finally {
      await NodeFSP.rm(base, { recursive: true, force: true });
    }
  };

  it("creates the session directory lazily and removes it on cleanup", async () => {
    await withBase(async (base) => {
      const scratch = new SessionScratchDir({ sessionId: "thread/one", baseRoot: base });
      expect(scratch.path).toBe(NodePath.join(base, "thread_one"));
      expect(scratch.created).toBe(false);

      const path = await scratch.ensureCreated();
      expect(path).toBe(scratch.path);
      expect(scratch.created).toBe(true);
      expect((await NodeFSP.stat(path)).isDirectory()).toBe(true);

      await NodeFSP.writeFile(NodePath.join(path, "draft.txt"), "draft");
      await scratch.cleanup();
      expect(scratch.created).toBe(false);
      await expect(NodeFSP.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("formats the path for POSIX shells but keeps it native for PowerShell and cmd", () => {
    const scratch = new SessionScratchDir({
      sessionId: "s1",
      baseRoot: "C:\\scratch",
      platform: "win32",
    });
    expect(scratch.formatForShell("posix")).toBe("C:/scratch/s1");
    expect(scratch.formatForShell("powershell")).toBe("C:\\scratch\\s1");
    expect(scratch.formatForShell("cmd")).toBe("C:\\scratch\\s1");
  });

  it("keeps an empty session id usable", () => {
    const scratch = new SessionScratchDir({ sessionId: "...", baseRoot: "/tmp/scratch" });
    expect(scratch.path).toBe(NodePath.join("/tmp/scratch", "session"));
  });
});
