// @effect-diagnostics nodeBuiltinImport:off -- Instruction files are read from the real filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** One file per directory, strongest name first. */
const INSTRUCTION_FILE_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "CLAUDE.md",
  NodePath.join(".claude", "CLAUDE.md"),
];
// The global file and the project chain have independent budgets so an
// oversized global file can never starve project instructions.
const MAX_GLOBAL_INSTRUCTION_BYTES = 32 * 1024;
const MAX_PROJECT_INSTRUCTION_BYTES = 32 * 1024;
const GLOBAL_INSTRUCTION_SOURCE = "~/.pi/agent/AGENTS.md";
const DEFAULT_AGENT_DIR = NodePath.join(NodeOS.homedir(), ".pi", "agent");

export interface ProjectInstruction {
  readonly source: string;
  readonly content: string;
}

export interface ProjectInstructions {
  readonly entries: ReadonlyArray<ProjectInstruction>;
}

export interface TruncatedText {
  readonly text: string;
  /** UTF-8 bytes of `text`. */
  readonly bytes: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

/** Keep at most `maxBytes` of UTF-8 content without splitting a character. */
export function truncateUtf8(content: string, maxBytes: number): TruncatedText {
  const totalBytes = Buffer.byteLength(content, "utf8");
  if (totalBytes <= maxBytes) {
    return { text: content, bytes: totalBytes, totalBytes, truncated: false };
  }
  let bytes = 0;
  let end = 0;
  for (const char of content) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  return { text: content.slice(0, end), bytes, totalBytes, truncated: true };
}

function isWithinRoot(root: string, candidate: string): boolean {
  const boundary = root.endsWith(NodePath.sep) ? root : `${root}${NodePath.sep}`;
  return candidate === root || candidate.startsWith(boundary);
}

interface LimitedInstruction {
  readonly entry: ProjectInstruction;
  /** UTF-8 bytes of file content kept, excluding any truncation notice. */
  readonly bytes: number;
  readonly truncated: boolean;
}

/** A cut is never silent: the notice names the source and the kept/total byte counts. */
function limitInstruction(source: string, content: string, maxBytes: number): LimitedInstruction {
  const limited = truncateUtf8(content, maxBytes);
  if (!limited.truncated) {
    return { entry: { source, content }, bytes: limited.bytes, truncated: false };
  }
  const notice = `[Vesper truncated ${source}: loaded the first ${limited.bytes} of ${limited.totalBytes} bytes; the rest of this file is not in context.]`;
  const kept = limited.text.trimEnd();
  return {
    entry: { source, content: kept === "" ? notice : `${kept}\n\n${notice}` },
    bytes: limited.bytes,
    truncated: true,
  };
}

async function readInstruction(
  workspaceRoot: string,
  canonicalWorkspaceRoot: string,
  directory: string,
  remaining: number,
): Promise<LimitedInstruction | undefined> {
  for (const name of INSTRUCTION_FILE_NAMES) {
    try {
      const file = NodePath.join(directory, name);
      // Instructions are never read from outside the project, so a symlinked
      // instruction file cannot pull host files into the prompt.
      if (!isWithinRoot(canonicalWorkspaceRoot, await NodeFSP.realpath(file))) continue;
      const content = (await NodeFSP.readFile(file, "utf8")).trim();
      if (content === "") continue;
      return limitInstruction(
        NodePath.relative(workspaceRoot, file).replaceAll("\\", "/") || name,
        content,
        remaining,
      );
    } catch {
      // Try the next recognized name, then the next directory.
    }
  }
  return undefined;
}

/**
 * Resolve the project chain from the workspace root down to the directory that
 * owns `workspacePath`, so nested files get the last word. A target outside the
 * root keeps the root's own chain instead of dropping project instructions.
 */
async function loadProjectInstructions(
  workspaceRoot: string | null | undefined,
  workspacePath?: string,
  maxBytes = MAX_PROJECT_INSTRUCTION_BYTES,
): Promise<ProjectInstructions | undefined> {
  if (!workspaceRoot?.trim()) return undefined;

  const root = NodePath.resolve(workspaceRoot);
  const canonicalRoot = await NodeFSP.realpath(root).catch(() => root);
  const target = workspacePath?.trim() ? NodePath.resolve(root, workspacePath) : root;
  const targetDirectory =
    isWithinRoot(root, target) && target !== root ? NodePath.dirname(target) : root;
  const directories: string[] = [];
  for (let current = targetDirectory; ; current = NodePath.dirname(current)) {
    directories.unshift(current);
    if (current === root) break;
  }

  const entries: ProjectInstruction[] = [];
  let remaining = Math.max(0, maxBytes);
  for (const directory of directories) {
    if (remaining <= 0) break;
    const loaded = await readInstruction(root, canonicalRoot, directory, remaining);
    if (loaded === undefined) continue;
    entries.push(loaded.entry);
    // A truncated file has used up the budget; closer files are not loaded.
    if (loaded.truncated) break;
    remaining -= loaded.bytes;
  }
  return entries.length > 0 ? { entries } : undefined;
}

/** The global file precedes the project chain, and each is capped independently. */
async function loadInstructionChain(
  workspaceRoot: string | null | undefined,
  workspacePath: string | undefined,
  globalPath: string,
): Promise<ProjectInstructions | undefined> {
  const entries: ProjectInstruction[] = [];
  try {
    const content = (await NodeFSP.readFile(globalPath, "utf8")).trim();
    if (content !== "") {
      entries.push(
        limitInstruction(GLOBAL_INSTRUCTION_SOURCE, content, MAX_GLOBAL_INSTRUCTION_BYTES).entry,
      );
    }
  } catch {
    // A missing global file is an expected first-run state.
  }
  const project = await loadProjectInstructions(workspaceRoot, workspacePath);
  return entries.length > 0 || project !== undefined
    ? { entries: [...entries, ...(project?.entries ?? [])] }
    : undefined;
}

function digestInstructions(instructions: ProjectInstructions | undefined): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const entry of instructions?.entries ?? []) {
    hash.update(entry.source).update("\u0000").update(entry.content).update("\u0000");
  }
  return hash.digest("hex");
}

export interface ProjectInstructionTrackerOptions {
  /** The workspace the project chain is scoped to; `null` loads only the global file. */
  readonly workspaceRoot: string | null | undefined;
  /** Overrides `~/.pi/agent`, where the global `AGENTS.md` lives. */
  readonly agentDir?: string | undefined;
}

/**
 * Loads instructions on demand for the directory a tool is about to touch, so
 * nested rules become visible only once the turn reaches them. The digest guard
 * keeps an unchanged chain from re-rendering a system section.
 */
export class ProjectInstructionTracker {
  readonly #workspaceRoot: string | null | undefined;
  readonly #globalPath: string;
  #current: ProjectInstructions | undefined;
  #digest = "";

  constructor(options: ProjectInstructionTrackerOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#globalPath = NodePath.join(options.agentDir ?? DEFAULT_AGENT_DIR, "AGENTS.md");
  }

  /** The chain most recently loaded for the directory scope in use. */
  get current(): ProjectInstructions | undefined {
    return this.#current;
  }

  /** Reloads the chain for `workspacePath`; `undefined` means the content is unchanged. */
  async visit(workspacePath?: string): Promise<ProjectInstructions | undefined> {
    const next = await loadInstructionChain(this.#workspaceRoot, workspacePath, this.#globalPath);
    const digest = digestInstructions(next);
    if (digest === this.#digest) return undefined;
    this.#digest = digest;
    this.#current = next;
    return next;
  }
}

/** Rendered as the `project_instructions` section, after the custom append and before skills. */
export function renderProjectInstructions(
  instructions: ProjectInstructions | undefined,
): string | undefined {
  if (instructions === undefined || instructions.entries.length === 0) return undefined;
  return [
    "# Project instructions",
    "",
    "The following instructions are loaded by Vesper. Follow them when they apply to the task; entries later in this section are closer to the file being worked on and take precedence.",
    "",
    ...instructions.entries.flatMap((entry) => [`## ${entry.source}`, "", entry.content, ""]),
  ]
    .join("\n")
    .trimEnd();
}
