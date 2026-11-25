// @effect-diagnostics nodeBuiltinImport:off -- Ignore rules are read from the workspace at tool execution time.
import ignore from "ignore";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const WORKSPACE_PATH_DENIED = "WORKSPACE_PATH_DENIED";

const WORKSPACE_IGNORE_FILES = [
  ".gitignore",
  ".ignore",
  ".pi-ignore",
  ".pi-desktopignore",
] as const;

const DEFAULT_IGNORED_DIRECTORIES = [
  "node_modules",
  "dist",
  "build",
  ".target",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "coverage",
  ".turbo",
  ".next",
  ".cache",
  ".git",
] as const;

const DEFAULT_IGNORED_FILES = [".DS_Store"];
const DEFAULT_IGNORED_SUFFIXES = [".log"];
const SENSITIVE_FILE_NAMES = ["id_rsa", "id_ed25519", "credentials.json", ".env"];
const SENSITIVE_SUFFIXES = [".pem", ".key", ".p12", ".pfx"];
const ENV_TEMPLATE_SUFFIXES = [".example", ".sample", ".template"];

const toPosix = (value: string): string => value.split(NodePath.sep).join("/");

const lowerCase = (value: string): string => value.toLowerCase();

const isSensitiveFileName = (name: string): boolean => {
  const lower = lowerCase(name);
  if (lower.startsWith(".env.")) {
    return !ENV_TEMPLATE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
  }
  if (SENSITIVE_FILE_NAMES.includes(lower)) return true;
  return SENSITIVE_SUFFIXES.some(
    (suffix) => lower.length > suffix.length && lower.endsWith(suffix),
  );
};

export const isSensitivePath = (target: string): boolean => {
  if (isSensitiveFileName(NodePath.basename(target))) return true;
  let previousWasGit = false;
  for (const component of target.split(NodePath.sep)) {
    if (previousWasGit && component === "objects") return true;
    previousWasGit = component === ".git";
  }
  return false;
};

export const sensitivePathDeniedMessage = (display: string): string =>
  `${display} is blocked by the workspace security denylist (private keys, .env files, and credential bundles are never exposed to tools).`;

const isDefaultIgnoredEntry = (name: string, isDirectory: boolean): boolean => {
  if (isDirectory) return (DEFAULT_IGNORED_DIRECTORIES as ReadonlyArray<string>).includes(name);
  return (
    DEFAULT_IGNORED_FILES.includes(name) ||
    DEFAULT_IGNORED_SUFFIXES.some((suffix) => name.length > suffix.length && name.endsWith(suffix))
  );
};

const resolveGlobalIgnoreFile = (): string => {
  const dataDir = process.env.PI_DESKTOP_DATA_DIR ?? NodePath.join(NodeOS.homedir(), ".pi-desktop");
  return NodePath.join(dataDir, "ignore");
};

export interface WorkspaceIgnoreRules {
  readonly scoped: boolean;
  readonly ignoreRoot: string;
  readonly ignoreFiles: ReadonlyArray<string>;
  isIgnored(relativePath: string, isDirectory: boolean): boolean;
}

export interface WorkspaceIgnoreOptions {
  readonly ignoreRoot: string;
  readonly scoped: boolean;
  readonly globalIgnoreFile?: string | null;
}

const readIgnoreFile = async (target: string): Promise<string | undefined> => {
  try {
    return await NodeFSP.readFile(target, "utf8");
  } catch {
    return undefined;
  }
};

export const loadWorkspaceIgnoreRules = async (
  options: WorkspaceIgnoreOptions,
): Promise<WorkspaceIgnoreRules> => {
  if (options.scoped) {
    return {
      scoped: true,
      ignoreRoot: options.ignoreRoot,
      ignoreFiles: [],
      isIgnored: () => false,
    };
  }

  const matcher = ignore();
  const ignoreFiles: Array<string> = [];
  const globalIgnoreFile =
    options.globalIgnoreFile === undefined ? resolveGlobalIgnoreFile() : options.globalIgnoreFile;
  if (globalIgnoreFile !== null) {
    const content = await readIgnoreFile(globalIgnoreFile);
    if (content !== undefined) {
      matcher.add(content);
      ignoreFiles.push(globalIgnoreFile);
    }
  }
  for (const name of WORKSPACE_IGNORE_FILES) {
    const target = NodePath.join(options.ignoreRoot, name);
    const content = await readIgnoreFile(target);
    if (content === undefined) continue;
    matcher.add(content);
    ignoreFiles.push(target);
  }

  return {
    scoped: false,
    ignoreRoot: options.ignoreRoot,
    ignoreFiles,
    isIgnored: (relativePath, isDirectory) => {
      const name = NodePath.basename(relativePath);
      if (isDefaultIgnoredEntry(name, isDirectory)) return true;
      const normalized = toPosix(relativePath);
      return matcher.ignores(isDirectory ? `${normalized}/` : normalized);
    },
  };
};

const denyGlobArgs = (): Array<string> => {
  const args: Array<string> = [];
  for (const name of SENSITIVE_FILE_NAMES) args.push("--glob", `!${name}`);
  for (const suffix of SENSITIVE_SUFFIXES) args.push("--glob", `!*${suffix}`);
  args.push("--glob", "!.git/objects");
  return args;
};

export const rgIgnoreArgs = (rules: WorkspaceIgnoreRules): Array<string> => {
  const args = denyGlobArgs();
  if (rules.scoped) return args;
  for (const name of DEFAULT_IGNORED_DIRECTORIES) args.push("--glob", `!${name}`);
  for (const name of DEFAULT_IGNORED_FILES) args.push("--glob", `!${name}`);
  for (const suffix of DEFAULT_IGNORED_SUFFIXES) args.push("--glob", `!*${suffix}`);
  for (const file of rules.ignoreFiles) args.push("--ignore-file", file);
  return args;
};
