// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Shell discovery inspects the filesystem and bounds the login-shell PATH probe with a timer.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const COMMAND_SHELL_IDS = [
  "windows-powershell",
  "windows-pwsh",
  "cmd",
  "git-bash",
  "bash",
] as const;

export type CommandShellId = (typeof COMMAND_SHELL_IDS)[number];

export const COMMAND_SHELL_DIALECTS = ["powershell", "cmd", "posix"] as const;

export type CommandShellDialect = (typeof COMMAND_SHELL_DIALECTS)[number];

export interface CommandShellOption {
  readonly id: CommandShellId;
  readonly label: string;
  readonly dialect: CommandShellDialect;
  readonly available: boolean;
  readonly isDefault: boolean;
}

export interface CommandShellCatalog {
  readonly configuredId: CommandShellId | null;
  readonly effective: CommandShellOption | null;
  readonly fallback: boolean;
  readonly choices: ReadonlyArray<CommandShellOption>;
}

/** The shell a turn runs its Bash calls with; id and dialect stay fixed for that turn. */
export interface TurnShell {
  readonly id: CommandShellId;
  readonly dialect: CommandShellDialect;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
}

export interface ShellDiscoveryOptions {
  readonly platform?: NodeJS.Platform | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  /** Injected so discovery never touches the filesystem in tests. */
  readonly isFile?: ((absolute: string) => boolean) | undefined;
}

export type CommandShellCatalogInput = ShellDiscoveryOptions & {
  readonly configuredId?: CommandShellId | null | undefined;
};

export type ResolveTurnShellInput = CommandShellCatalogInput & {
  /** Reuse a catalog a caller already built for this turn. */
  readonly catalog?: CommandShellCatalog | undefined;
  readonly loginShell?: boolean | undefined;
};

const SHELL_NOT_FOUND = "SHELL_NOT_FOUND";

const SHELL_LABELS: Readonly<Record<CommandShellId, string>> = {
  "windows-powershell": "Windows PowerShell",
  "windows-pwsh": "PowerShell 7",
  cmd: "Command Prompt",
  "git-bash": "Git Bash",
  bash: "Bash",
};

export const commandShellDialect = (id: CommandShellId): CommandShellDialect => {
  switch (id) {
    // Windows PowerShell 5.1 and PowerShell 7 share one invocation contract.
    case "windows-powershell":
    case "windows-pwsh":
      return "powershell";
    case "cmd":
      return "cmd";
    case "git-bash":
    case "bash":
      return "posix";
  }
};

const defaultCommandShellForPlatform = (platform: NodeJS.Platform): CommandShellId =>
  platform === "win32" ? "windows-powershell" : "bash";

/** IDs a platform can offer, in the order a fallback picks them. */
const platformShellIds = (platform: NodeJS.Platform): ReadonlyArray<CommandShellId> =>
  platform === "win32"
    ? ["windows-powershell", "windows-pwsh", "cmd", "git-bash", "bash"]
    : ["bash", "git-bash"];

const isExecutableFile = (absolute: string): boolean => {
  try {
    return NodeFS.statSync(absolute).isFile();
  } catch {
    return false;
  }
};

/** Windows shells use win32 path rules even when discovery runs on another platform. */
const pathApi = (platform: NodeJS.Platform): typeof NodePath.win32 =>
  platform === "win32" ? NodePath.win32 : NodePath.posix;

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

const firstExisting = (
  candidates: ReadonlyArray<string | undefined>,
  isFile: (absolute: string) => boolean,
): string | undefined => {
  for (const candidate of candidates) {
    const path = nonEmpty(candidate);
    if (path !== undefined && isFile(path)) return path;
  }
  return undefined;
};

const pathDelimiter = (platform: NodeJS.Platform): string => (platform === "win32" ? ";" : ":");

const findOnPath = (
  name: string,
  input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly platform: NodeJS.Platform;
    readonly isFile: (absolute: string) => boolean;
    readonly accept?: ((candidate: string) => boolean) | undefined;
  },
): string | undefined => {
  const searchPath = input.environment.PATH ?? input.environment.Path ?? "";
  const accept = input.accept ?? (() => true);
  for (const directory of searchPath.split(pathDelimiter(input.platform))) {
    const trimmed = directory.trim().replace(/^"(.*)"$/u, "$1");
    if (trimmed === "") continue;
    const candidate = pathApi(input.platform).join(trimmed, name);
    if (!accept(candidate)) continue;
    if (input.isFile(candidate)) return candidate;
  }
  return undefined;
};

const programFilesRoots = (environment: NodeJS.ProcessEnv): ReadonlyArray<string> => {
  const roots = [
    environment.ProgramW6432,
    environment.ProgramFiles,
    environment["ProgramFiles(x86)"],
  ];
  return roots.flatMap((root) => {
    const value = nonEmpty(root);
    return value === undefined ? [] : [value];
  });
};

const systemRoot = (environment: NodeJS.ProcessEnv): string =>
  nonEmpty(environment.SystemRoot) ?? "C:\\Windows";

interface ShellDiscovery {
  readonly executables: ReadonlyMap<CommandShellId, string>;
  /** An explicit bash request from the environment; a missing path is an error, not a fallback. */
  readonly bashOverride: string | undefined;
  readonly searched: ReadonlyArray<string>;
}

const discoverUnixShells = (
  environment: NodeJS.ProcessEnv,
  isFile: (absolute: string) => boolean,
  override: string | undefined,
  platform: NodeJS.Platform,
): {
  readonly executables: Map<CommandShellId, string>;
  readonly searched: ReadonlyArray<string>;
} => {
  const known = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"];
  const bash = firstExisting([override, ...known], isFile);
  const executables = new Map<CommandShellId, string>();
  executables.set(
    "bash",
    bash ?? findOnPath("bash", { environment, platform, isFile }) ?? "/bin/sh",
  );
  const gitBash = findOnPath("bash", { environment, platform, isFile });
  if (gitBash !== undefined && bash !== undefined) executables.set("git-bash", gitBash);
  return { executables, searched: [override ?? "", ...known] };
};

const discoverWindowsShells = (
  environment: NodeJS.ProcessEnv,
  isFile: (absolute: string) => boolean,
): {
  readonly executables: Map<CommandShellId, string>;
  readonly searched: ReadonlyArray<string>;
} => {
  const executables = new Map<CommandShellId, string>();
  const searched: string[] = [];
  const windowsPath = pathApi("win32");
  const programFiles = programFilesRoots(environment);
  const pathSearch = (name: string, accept?: (candidate: string) => boolean) =>
    findOnPath(name, {
      environment,
      platform: "win32",
      isFile,
      ...(accept === undefined ? {} : { accept }),
    });

  const pwshCandidates = programFiles.flatMap((root) => [
    windowsPath.join(root, "PowerShell", "7", "pwsh.exe"),
    windowsPath.join(root, "PowerShell", "7-preview", "pwsh.exe"),
  ]);
  searched.push(...pwshCandidates, "pwsh.exe on PATH");
  const pwsh = firstExisting(pwshCandidates, isFile) ?? pathSearch("pwsh.exe");
  if (pwsh !== undefined) executables.set("windows-pwsh", pwsh);

  const systemPowerShell = windowsPath.join(
    systemRoot(environment),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  searched.push(systemPowerShell, "powershell.exe on PATH");
  const powershell = firstExisting([systemPowerShell], isFile) ?? pathSearch("powershell.exe");
  if (powershell !== undefined) executables.set("windows-powershell", powershell);

  const gitBashCandidates = programFiles.flatMap((root) => [
    windowsPath.join(root, "Git", "bin", "bash.exe"),
    windowsPath.join(root, "Git", "usr", "bin", "bash.exe"),
  ]);
  const gitFromPath = pathSearch("git.exe");
  const gitRoot =
    gitFromPath === undefined ? undefined : windowsPath.dirname(windowsPath.dirname(gitFromPath));
  const gitBashFromGit =
    gitRoot === undefined
      ? undefined
      : firstExisting(
          [
            windowsPath.join(gitRoot, "bin", "bash.exe"),
            windowsPath.join(gitRoot, "usr", "bin", "bash.exe"),
          ],
          isFile,
        );
  // WSL's System32 launcher shares the name but not the filesystem contract.
  const wslLauncher = windowsPath.join(systemRoot(environment), "System32");
  const gitBash =
    firstExisting(gitBashCandidates, isFile) ??
    gitBashFromGit ??
    pathSearch("bash.exe", (candidate) => !candidate.startsWith(wslLauncher));
  if (gitBash !== undefined) executables.set("git-bash", gitBash);

  const cmd =
    firstExisting([nonEmpty(environment.ComSpec)], isFile) ??
    firstExisting([windowsPath.join(systemRoot(environment), "System32", "cmd.exe")], isFile) ??
    "cmd.exe";
  executables.set("cmd", cmd);

  // A Git Bash install is the same bash users configure explicitly on Windows.
  if (gitBash !== undefined) executables.set("bash", executables.get("bash") ?? gitBash);
  return { executables, searched };
};

const discoverShells = (input?: ShellDiscoveryOptions): ShellDiscovery => {
  const platform = input?.platform ?? HostProcess.Platform.defaultValue();
  const environment = input?.environment ?? process.env;
  const isFile = input?.isFile ?? isExecutableFile;
  const bashOverride = nonEmpty(environment.T3_PI_BASH) ?? nonEmpty(environment.PI_DESKTOP_BASH);
  if (platform === "win32") {
    const discovered = discoverWindowsShells(environment, isFile);
    return { executables: discovered.executables, bashOverride, searched: discovered.searched };
  }
  const discovered = discoverUnixShells(environment, isFile, bashOverride, platform);
  return { executables: discovered.executables, bashOverride, searched: discovered.searched };
};

export const buildCommandShellCatalog = (input?: CommandShellCatalogInput): CommandShellCatalog => {
  const platform = input?.platform ?? HostProcess.Platform.defaultValue();
  const configuredId = input?.configuredId ?? null;
  const discovered = discoverShells(input);
  const defaultId = defaultCommandShellForPlatform(platform);
  const choices = platformShellIds(platform).map((id): CommandShellOption => ({
    id,
    label: SHELL_LABELS[id],
    dialect: commandShellDialect(id),
    available: discovered.executables.has(id),
    isDefault: id === defaultId,
  }));
  const supported = choices.filter((choice) => choice.available);
  const configured =
    configuredId === null ? undefined : supported.find((choice) => choice.id === configuredId);
  const effective = configured ?? supported[0] ?? null;
  return {
    configuredId,
    effective,
    fallback: configuredId !== null && effective?.id !== configuredId,
    choices,
  };
};

const shellNotFound = (
  id: CommandShellId,
  discovered: ShellDiscovery,
  platform: NodeJS.Platform,
): Error => {
  const searched = discovered.searched.filter((entry) => entry !== "").join(", ");
  return Object.assign(
    new Error(
      `${SHELL_NOT_FOUND}: could not find the ${SHELL_LABELS[id]} shell. Searched: ${searched}. ${
        platform === "win32"
          ? "Install Git for Windows for Bash."
          : "Install bash to run shell commands."
      }`,
    ),
    { code: SHELL_NOT_FOUND },
  );
};

const shellArgs = (
  id: CommandShellId,
  executable: string,
  platform: NodeJS.Platform,
  loginShell: boolean,
): ReadonlyArray<string> => {
  const dialect = commandShellDialect(id);
  if (dialect === "powershell") {
    return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"];
  }
  if (dialect === "cmd") return ["/c"];
  if (id === "git-bash" || platform === "win32") return ["-c"];
  // A plain `/bin/sh` fallback has no login profile worth sourcing.
  const isBash = pathApi(platform).basename(executable).toLowerCase().startsWith("bash");
  return isBash && loginShell ? ["-lc"] : ["-c"];
};

export const resolveTurnShell = (input?: ResolveTurnShellInput): TurnShell => {
  const platform = input?.platform ?? HostProcess.Platform.defaultValue();
  const catalog = input?.catalog ?? buildCommandShellCatalog(input);
  const effective = catalog.effective;
  const discovered = discoverShells(input);
  const requestedId =
    effective?.id ?? catalog.configuredId ?? defaultCommandShellForPlatform(platform);
  if (discovered.bashOverride !== undefined && requestedId !== "git-bash") {
    const bash = discovered.executables.get("bash");
    if (bash !== discovered.bashOverride) {
      throw Object.assign(
        new Error(
          `${SHELL_NOT_FOUND}: T3_PI_BASH/PI_DESKTOP_BASH points at ${discovered.bashOverride}, which is not an executable file.`,
        ),
        { code: SHELL_NOT_FOUND },
      );
    }
  }
  const executable = effective === null ? undefined : discovered.executables.get(effective.id);
  if (effective === null || executable === undefined) {
    throw shellNotFound(requestedId, discovered, platform);
  }
  return {
    id: effective.id,
    dialect: effective.dialect,
    executable,
    args: shellArgs(effective.id, executable, platform, input?.loginShell !== false),
  };
};

/** Mirrors `sessionId` into a single safe path segment so scratch cleanup stays inside the base. */
const safeSegment = (value: string): string => {
  const safe = value.replaceAll(/[^A-Za-z0-9._-]+/gu, "_").replace(/^\.+/u, "");
  return safe === "" ? "session" : safe.slice(0, 120);
};

export interface SessionScratchDirOptions {
  readonly sessionId: string;
  /** Defaults to `<tmpdir>/pi-native-scratch`; tests pass their own directory. */
  readonly baseRoot?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

/**
 * Per-session scratch space outside the workspace. It is created on the first write or
 * command and removed with the session, so agent drafts never dirty the project.
 */
export class SessionScratchDir {
  readonly #baseRoot: string;
  readonly #path: string;
  readonly #platform: NodeJS.Platform;
  #created = false;

  constructor(options: SessionScratchDirOptions) {
    const platform = options.platform ?? HostProcess.Platform.defaultValue();
    const path = pathApi(platform);
    this.#baseRoot = options.baseRoot ?? path.join(NodeOS.tmpdir(), "pi-native-scratch");
    this.#path = path.join(this.#baseRoot, safeSegment(options.sessionId));
    this.#platform = platform;
  }

  get path(): string {
    return this.#path;
  }

  get created(): boolean {
    return this.#created;
  }

  async ensureCreated(): Promise<string> {
    if (!this.#created) {
      await NodeFSP.mkdir(this.#path, { recursive: true });
      this.#created = true;
    }
    return this.#path;
  }

  async cleanup(): Promise<void> {
    this.#created = false;
    await NodeFSP.rm(this.#path, { recursive: true, force: true });
  }

  /** POSIX shells get forward slashes; PowerShell and cmd keep the native spelling. */
  formatForShell(dialect: CommandShellDialect): string {
    return dialect === "posix" ? this.#path.replaceAll("\\", "/") : this.#path;
  }

  get platform(): NodeJS.Platform {
    return this.#platform;
  }
}

export type LoginShellPathRunner = (
  executable: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
) => Promise<string | null>;

export interface LoginShellPathProbeInput extends ShellDiscoveryOptions {
  readonly timeoutMs?: number | undefined;
  readonly cache?: Map<string, Promise<string | null>> | undefined;
  /** Injected in tests so no interactive login shell is ever spawned. */
  readonly run?: LoginShellPathRunner | undefined;
}

const LOGIN_SHELL_PROBE_TIMEOUT_MS = 5_000;
const loginShellPathCache = new Map<string, Promise<string | null>>();

const runLoginShellProbe: LoginShellPathRunner = (executable, args, timeoutMs) =>
  new Promise<string | null>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(executable, [...args], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish(null);
      return;
    }
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // A shell that already exited needs no signal.
      }
      finish(null);
    }, timeoutMs);
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code === 0 ? output.trim() || null : null));
  });

/**
 * Reads the PATH a user's login shell would have. macOS starts GUI apps without
 * `~/.zshrc`, so nvm/pnpm/Homebrew would otherwise be invisible to Bash. Best effort,
 * 5s-bounded, cached per shell for the life of the process.
 */
export const probeLoginShellPath = async (
  input?: LoginShellPathProbeInput,
): Promise<string | null> => {
  const platform = input?.platform ?? HostProcess.Platform.defaultValue();
  if (platform === "win32") return null;
  const environment = input?.environment ?? process.env;
  const isFile = input?.isFile ?? isExecutableFile;
  const shell = firstExisting(
    [nonEmpty(environment.SHELL), "/bin/zsh", "/bin/bash", "/bin/sh"],
    isFile,
  );
  if (shell === undefined) return null;
  const cache = input?.cache ?? loginShellPathCache;
  const cached = cache.get(shell);
  if (cached !== undefined) return await cached;
  const run = input?.run ?? runLoginShellProbe;
  const probe = run(
    shell,
    ["-lic", 'printf %s "$PATH"'],
    input?.timeoutMs ?? LOGIN_SHELL_PROBE_TIMEOUT_MS,
  )
    .then((value) => value?.trim() || null)
    .catch(() => null);
  cache.set(shell, probe);
  return await probe;
};
