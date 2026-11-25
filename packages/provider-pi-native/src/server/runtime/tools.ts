// @effect-diagnostics nodeBuiltinImport:off -- The native tool surface talks to the filesystem, child processes, and the OS directly.
// @effect-diagnostics globalTimers:off -- Bash enforces its timeout with a Node timer; tests inject the sleep seam instead.
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { arr, bool, int, lit, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import type { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  withAgentDeviceEnvironment,
  type McpProviderSessionConfig,
} from "@t3tools/provider-core/server/mcpSession";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  applyHashlineEdits,
  buildSimpleDiff,
  computeFileHash,
  computeLineTag,
  splitFileLines,
  type HashlineEdit,
} from "./hashline.ts";
import { detectShellFilePatch, MutationRecoveryTracker } from "./mutationRecovery.ts";
import { PathMutex } from "./pathLock.ts";
import type { WorkspaceSandbox } from "./sandbox.ts";
import { createSkillTool } from "./skillTool.ts";
import type { PiNativeSkillDef } from "./skillsDiscovery.ts";
import { SeenLinesTracker } from "./hashline.ts";

const T3CODE_THREAD_ID_ENV = "T3CODE_THREAD_ID";

const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_GLOB_RESULTS = 500;
const DEFAULT_MAX_GREP_MATCHES = 200;
const DEFAULT_MAX_GREP_FILE_BYTES = 1024 * 1024;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BASH_TIMEOUT_MS = 600_000;
const MAX_PREVIEW_CHARS = 240;
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules"]);

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface TodoStep {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "running" | "completed";
}

export interface PlanSubmission {
  readonly markdown: string;
  readonly summary?: string;
}

export interface TodoUpdate {
  readonly steps: ReadonlyArray<TodoStep>;
  readonly explanation?: string;
}

export interface TodoSnapshot {
  readonly revision: number;
  readonly steps: ReadonlyArray<TodoStep>;
  readonly explanation?: string;
}

export const EMPTY_TODO_SNAPSHOT: TodoSnapshot = {
  revision: 0,
  steps: [],
};

export interface GrepMatch {
  readonly fileName: string;
  readonly line: number;
  readonly preview: string;
}

export interface ShellSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface PiNativeToolDeps {
  readonly sandbox: WorkspaceSandbox;
  readonly seen: SeenLinesTracker;
  readonly recovery: MutationRecoveryTracker;
  readonly locks: PathMutex;
  readonly requestUserInput: (
    questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>;
  readonly onSubmitPlan: (submission: PlanSubmission) => Promise<void> | void;
  readonly onTodoUpdate: (update: TodoUpdate) => Promise<TodoSnapshot | void> | TodoSnapshot | void;
  readonly readTodos?: () => Promise<TodoSnapshot> | TodoSnapshot;
  readonly onRequestCompaction: (reason?: string) => Promise<void> | void;
  readonly onGoalStatusUpdate?:
    | ((update: GoalStatusUpdate) => Promise<GoalStatusUpdateResult> | GoalStatusUpdateResult)
    | undefined;
  readonly isPlanMode: () => boolean;
  /** The session's live skill catalog; the `Skill` tool always resolves against it. */
  readonly skills?: (() => ReadonlyArray<PiNativeSkillDef>) | undefined;
  readonly mcpSession?: McpProviderSessionConfig;
  readonly threadId?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly shell?: ShellSpec;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly maxImageBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxGlobResults?: number;
  readonly maxGrepMatches?: number;
  readonly defaultBashTimeoutMs?: number;
  readonly maxBashTimeoutMs?: number;
}

export interface ReadDetails {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly truncated: boolean;
  readonly image: boolean;
}

export interface FileChangeDetails {
  readonly fileName: string;
  readonly additions: number;
  readonly deletions: number;
  readonly diffStr: string;
  readonly oldStr: string;
  readonly newStr: string;
}

export interface GlobDetails {
  readonly pattern: string;
  readonly files: ReadonlyArray<string>;
  readonly truncated: boolean;
}

export interface GrepDetails {
  readonly pattern: string;
  readonly matches: ReadonlyArray<GrepMatch>;
  readonly truncated: boolean;
}

export interface BashDetails {
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly shellPatchWarning?: string;
}

export interface AskToolDetails {
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  readonly answers: Readonly<Record<string, unknown>>;
}

export interface PlanDetails {
  readonly markdown: string;
  readonly summary?: string;
}

export interface TodoDetails {
  readonly revision: number;
  readonly steps: ReadonlyArray<TodoStep>;
  readonly explanation?: string;
}

export interface NewContextDetails {
  readonly reason?: string;
  readonly summaryHint?: string;
}

export interface GoalStatusUpdate {
  readonly status: "active" | "complete" | "blocked";
  readonly summary: string;
}

export type GoalStatusUpdateResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly error: string };

const text = (value: string): TextContent => ({ type: "text", text: value });

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const fail = <T>(message: string, details: T): AgentToolResult<T> => ({
  content: [text(message)],
  details,
  isError: true,
});

const ok = <T>(message: string, details: T): AgentToolResult<T> => ({
  content: [text(message)],
  details,
});

const readIfExists = async (target: string): Promise<string | undefined> => {
  try {
    return await NodeFSP.readFile(target, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
};

const imageMimeType = (target: string): string | undefined =>
  IMAGE_MIME_TYPES[NodePath.extname(target).toLowerCase()];

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const globToRegExp = (pattern: string): RegExp => {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern.charAt(index);
    if (char === "*") {
      if (pattern.charAt(index + 1) === "*") {
        if (pattern.charAt(index + 2) === "/") {
          source += "(?:.*/)?";
          index += 3;
          continue;
        }
        source += ".*";
        index += 2;
        continue;
      }
      source += "[^/]*";
      index++;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index++;
      continue;
    }
    if (char === "{") {
      const close = pattern.indexOf("}", index);
      if (close !== -1) {
        const options = pattern
          .slice(index + 1, close)
          .split(",")
          .map((option) => escapeRegExp(option));
        source += `(?:${options.join("|")})`;
        index = close + 1;
        continue;
      }
    }
    source += escapeRegExp(char);
    index++;
  }
  return new RegExp(`^${source}$`, "u");
};

const toPosix = (value: string): string => value.split(NodePath.sep).join("/");

const matchesGlob = (matcher: RegExp, pattern: string, relativePath: string): boolean => {
  const normalized = toPosix(relativePath);
  return matcher.test(pattern.includes("/") ? normalized : NodePath.basename(normalized));
};

interface WalkRequest {
  readonly root: string;
  readonly isFull: () => boolean;
  readonly visit: (fullPath: string, relativePath: string) => Promise<void> | void;
}

const walk = async (request: WalkRequest): Promise<boolean> => {
  const stack: Array<string> = [request.root];
  while (stack.length > 0) {
    if (request.isFull()) return true;
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = await NodeFSP.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (request.isFull()) return true;
      const fullPath = NodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      await request.visit(fullPath, NodePath.relative(request.root, fullPath));
    }
  }
  return false;
};

const toUserInputQuestion = (question: {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly description: string;
    readonly value?: string;
    readonly preview?: string;
  }>;
  readonly multiSelect?: boolean;
  readonly allowCustomAnswer?: boolean;
  readonly initialAnswer?: string;
  readonly required?: boolean;
}): OrchestrationV2UserInputQuestion => ({
  id: question.id,
  header: question.header,
  question: question.question,
  options: question.options.map((option) => ({
    label: option.label,
    description: option.description,
    ...(option.value === undefined ? {} : { value: option.value }),
    ...(option.preview === undefined ? {} : { preview: option.preview }),
  })),
  ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
  ...(question.allowCustomAnswer === undefined
    ? {}
    : { allowCustomAnswer: question.allowCustomAnswer }),
  ...(question.initialAnswer === undefined ? {} : { initialAnswer: question.initialAnswer }),
  ...(question.required === undefined ? {} : { required: question.required }),
});

const asHashlineEdit = (value: unknown): HashlineEdit | undefined => {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  if (
    record.op === "PUT" &&
    typeof record.start === "string" &&
    typeof record.content === "string"
  ) {
    return {
      op: "PUT",
      start: record.start,
      content: record.content,
      ...(typeof record.end === "string" ? { end: record.end } : {}),
    };
  }
  if (record.op === "CUT" && typeof record.start === "string") {
    return {
      op: "CUT",
      start: record.start,
      ...(typeof record.end === "string" ? { end: record.end } : {}),
    };
  }
  if (
    record.op === "INS" &&
    typeof record.after === "string" &&
    typeof record.content === "string"
  ) {
    return { op: "INS", after: record.after, content: record.content };
  }
  return undefined;
};

const READ_PARAMS = obj({
  path: str({ description: "File path, absolute or relative to the workspace folder." }),
  offset: opt(int({ minimum: 1, description: "First line to read, 1-indexed." })),
  limit: opt(int({ minimum: 1, description: "How many lines to read." })),
});

const WRITE_PARAMS = obj({
  path: str({ description: "File path to create or overwrite." }),
  content: str({ description: "Full file content after the write." }),
});

const HASHLINE_EDIT_SCHEMA = union([
  obj({
    op: lit("PUT"),
    start: str({ description: 'First line as "line:tag", for example "12:ab".' }),
    end: opt(str({ description: "Last line of the range, inclusive." })),
    content: str({ description: "Replacement lines." }),
  }),
  obj({
    op: lit("CUT"),
    start: str({ description: 'First line as "line:tag".' }),
    end: opt(str({ description: "Last line of the range, inclusive." })),
  }),
  obj({
    op: lit("INS"),
    after: str({ description: 'Line to insert after as "line:tag", or "0" for the top.' }),
    content: str({ description: "Lines to insert." }),
  }),
]);

const EDIT_PARAMS = obj({
  path: str({ description: "File path to edit." }),
  edits: opt(arr(HASHLINE_EDIT_SCHEMA, { description: "Hashline edits using tags from Read." })),
  oldText: opt(str({ description: "Exact text to replace when edits is omitted." })),
  newText: opt(str({ description: "Replacement text for oldText." })),
});

const GLOB_PARAMS = obj({
  pattern: str({ description: 'Glob such as "**/*.ts".' }),
  path: opt(str({ description: "Directory to search; defaults to the workspace folder." })),
});

const GREP_PARAMS = obj({
  pattern: str({ description: "Regular expression to search for." }),
  path: opt(str({ description: "Directory or file to search; defaults to the workspace folder." })),
  glob: opt(str({ description: "Only search files matching this glob." })),
  caseSensitive: opt(bool({ description: "Set false for a case-insensitive search." })),
});

const BASH_PARAMS = obj({
  command: str({ description: "Shell command to run in the workspace folder." }),
  timeoutMs: opt(int({ minimum: 1, description: "Timeout in milliseconds." })),
});

const ASK_QUESTION_SCHEMA = obj({
  id: str(),
  header: str(),
  question: str(),
  options: arr(
    obj({
      label: str(),
      description: str(),
      value: opt(str()),
      preview: opt(str()),
    }),
  ),
  multiSelect: opt(bool()),
  allowCustomAnswer: opt(bool()),
  initialAnswer: opt(str()),
  required: opt(bool()),
});

const ASK_PARAMS = obj({
  questions: arr(ASK_QUESTION_SCHEMA, { minItems: 1 }),
});

const PLAN_PARAMS = obj({
  markdown: str({ description: "The plan, in markdown." }),
  summary: opt(str({ description: "One-line summary of the plan." })),
});

const TODO_PARAMS = obj({
  steps: arr(
    obj({
      id: str(),
      text: str(),
      status: oneOf(["pending", "running", "completed"]),
    }),
  ),
  explanation: opt(str()),
});

const TODO_READ_PARAMS = obj({});

type TodoValidationResult =
  | { readonly ok: true; readonly update: TodoUpdate }
  | { readonly ok: false; readonly error: string };

const validateTodoUpdate = (params: {
  readonly steps: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly status: TodoStep["status"];
  }>;
  readonly explanation?: string;
}): TodoValidationResult => {
  const seenIds = new Set<string>();
  const steps: TodoStep[] = [];
  for (let index = 0; index < params.steps.length; index++) {
    const raw = params.steps[index];
    if (raw === undefined) continue;
    const id = raw.id.trim();
    if (id === "") {
      return { ok: false, error: `Todo step at index ${index} must have a non-empty id.` };
    }
    if (seenIds.has(id)) {
      return {
        ok: false,
        error: `Duplicate todo step id "${id}". Every step must have a unique id.`,
      };
    }
    seenIds.add(id);
    const textValue = raw.text.trim();
    if (textValue === "") {
      return { ok: false, error: `Todo step "${id}" must have non-empty text.` };
    }
    if (raw.status !== "pending" && raw.status !== "running" && raw.status !== "completed") {
      return {
        ok: false,
        error: `Todo step "${id}" has invalid status "${String(raw.status)}".`,
      };
    }
    steps.push({ id, text: textValue, status: raw.status });
  }
  const trimmedExplanation = params.explanation?.trim();
  const explanation =
    trimmedExplanation !== undefined && trimmedExplanation !== "" ? trimmedExplanation : undefined;
  return {
    ok: true,
    update: {
      steps,
      ...(explanation === undefined ? {} : { explanation }),
    },
  };
};

const summarizeTodoCounts = (steps: ReadonlyArray<TodoStep>) => {
  let completed = 0;
  let running = 0;
  let pending = 0;
  for (const step of steps) {
    if (step.status === "completed") completed++;
    else if (step.status === "running") running++;
    else pending++;
  }
  return { total: steps.length, completed, running, pending };
};

const formatTodoLines = (snapshot: TodoSnapshot): ReadonlyArray<string> => {
  const lines: string[] = [];
  if (snapshot.explanation !== undefined) {
    lines.push(`Explanation: ${snapshot.explanation}`);
  }
  for (const step of snapshot.steps) {
    lines.push(`- [${step.status}] (${step.id}) ${step.text}`);
  }
  return lines;
};

const formatTodoWriteOutput = (snapshot: TodoSnapshot): string => {
  const { total, completed, running, pending } = summarizeTodoCounts(snapshot.steps);
  if (total === 0) {
    return `Updated 0 todo steps (revision ${snapshot.revision}). Todo list is empty.`;
  }
  const noun = total === 1 ? "step" : "steps";
  return [
    `Updated ${total} todo ${noun} (revision ${snapshot.revision}; ${completed}/${total} completed, ${running} running, ${pending} pending):`,
    ...formatTodoLines(snapshot),
  ].join("\n");
};

const formatTodoReadOutput = (snapshot: TodoSnapshot): string => {
  const { total, completed, running, pending } = summarizeTodoCounts(snapshot.steps);
  if (total === 0) {
    return `Todo list is empty (revision ${snapshot.revision}).`;
  }
  return [
    `Current todo list (revision ${snapshot.revision}; ${completed}/${total} completed, ${running} running, ${pending} pending):`,
    ...formatTodoLines(snapshot),
  ].join("\n");
};

const NEW_CONTEXT_PARAMS = obj({
  reason: opt(str({ description: "Why the context should be compacted now." })),
  summaryHint: opt(str({ description: "What the summary must keep." })),
});

const GOAL_STATUS_PARAMS = obj({
  status: union([lit("active"), lit("complete"), lit("blocked")]),
  summary: str({ description: "A concise check or verification summary." }),
});

const isFull = (count: number, limit: number): boolean => count >= limit;

const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const defaultShell = (): ShellSpec =>
  HostProcess.Platform.defaultValue() === "win32"
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/c"] }
    : { command: "/bin/sh", args: ["-c"] };

export const createPiNativeTools = (deps: PiNativeToolDeps): ReadonlyArray<AgentTool<any>> => {
  const maxImageBytes = deps.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxOutputBytes = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxGlobResults = deps.maxGlobResults ?? DEFAULT_MAX_GLOB_RESULTS;
  const maxGrepMatches = deps.maxGrepMatches ?? DEFAULT_MAX_GREP_MATCHES;
  const defaultBashTimeoutMs = deps.defaultBashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  const maxBashTimeoutMs = deps.maxBashTimeoutMs ?? DEFAULT_MAX_BASH_TIMEOUT_MS;
  const shell = deps.shell ?? defaultShell();

  const writeGuard = (target: string): string | undefined => {
    const state = deps.recovery.peek(target);
    if (state?.hardStop !== true) return undefined;
    return `Stop mutating ${target}: ${state.strikes} edits failed in a row. Re-read the file and ask the user how to proceed.`;
  };

  const commit = async (
    target: string,
    before: string,
    after: string,
  ): Promise<FileChangeDetails> => {
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, after, "utf8");
    const diff = buildSimpleDiff(target, before, after);
    deps.seen.recordWrite(target, after);
    deps.recovery.recordSuccess(target);
    return {
      fileName: NodePath.basename(target),
      additions: diff.additions,
      deletions: diff.deletions,
      diffStr: diff.diffStr,
      oldStr: before,
      newStr: after,
    };
  };

  const readTool: AgentTool<typeof READ_PARAMS, ReadDetails> = {
    name: "Read",
    label: "Read",
    description:
      "Read a file from the workspace. Text comes back as lineNum:tag|line; use those tags for Edit.",
    parameters: READ_PARAMS,
    execute: async (_toolCallId, params) => {
      try {
        const resolution = await deps.sandbox.resolvePath(params.path, "read");
        const target = resolution.resolvedPath;
        return await deps.locks.withReadLock(target, async () => {
          const stat = await NodeFSP.stat(target);
          if (!stat.isFile()) {
            return fail(`${target} is not a regular file.`, {
              path: target,
              startLine: 0,
              endLine: 0,
              totalLines: 0,
              truncated: false,
              image: false,
            });
          }
          const mimeType = imageMimeType(target);
          if (mimeType !== undefined) {
            if (stat.size > maxImageBytes) {
              return fail(
                `${target} is ${stat.size} bytes; images larger than ${maxImageBytes} bytes are not attached.`,
                {
                  path: target,
                  startLine: 0,
                  endLine: 0,
                  totalLines: 0,
                  truncated: false,
                  image: true,
                },
              );
            }
            const data = await NodeFSP.readFile(target);
            const image: ImageContent = {
              type: "image",
              data: data.toString("base64"),
              mimeType,
            };
            return {
              content: [image],
              details: {
                path: target,
                startLine: 1,
                endLine: 1,
                totalLines: 1,
                truncated: false,
                image: true,
              },
            };
          }

          const content = await NodeFSP.readFile(target, "utf8");
          deps.recovery.recordSuccess(target);

          const lines = splitFileLines(content).lines;
          const totalLines = lines.length;
          if (totalLines === 0) {
            return ok("The file is empty.", {
              path: target,
              startLine: 0,
              endLine: 0,
              totalLines: 0,
              truncated: false,
              image: false,
            });
          }
          const startLine = Math.min(Math.max(params.offset ?? 1, 1), totalLines);
          const limit = params.limit ?? totalLines - startLine + 1;
          const endLine = Math.min(startLine + Math.max(limit, 1) - 1, totalLines);
          const slice = lines.slice(startLine - 1, endLine);
          const formatted = slice
            .map((line, index) => `${startLine + index}:${computeLineTag(line)}|${line}`)
            .join("\n");
          deps.seen.recordRead(target, startLine, endLine, computeFileHash(content));
          const truncated = endLine < totalLines || startLine > 1;
          const body = truncated
            ? `${formatted}\n\n[lines ${startLine}-${endLine} of ${totalLines}]`
            : formatted;
          return ok(body, {
            path: target,
            startLine,
            endLine,
            totalLines,
            truncated,
            image: false,
          });
        });
      } catch (error) {
        return fail(`Could not read ${params.path}: ${describe(error)}`, {
          path: params.path,
          startLine: 0,
          endLine: 0,
          totalLines: 0,
          truncated: false,
          image: false,
        });
      }
    },
  };

  const writeTool: AgentTool<typeof WRITE_PARAMS, FileChangeDetails | { readonly error: string }> =
    {
      name: "Write",
      label: "Write",
      description: "Create or overwrite a file with the full content, then return the diff.",
      parameters: WRITE_PARAMS,
      execute: async (_toolCallId, params) => {
        try {
          const resolution = await deps.sandbox.resolvePath(params.path, "write");
          if (resolution.denied) {
            return fail(
              resolution.writeDeniedReason ?? `${resolution.resolvedPath} is read-only.`,
              {
                error: resolution.writeDeniedReason ?? "read-only path",
              },
            );
          }
          const target = resolution.resolvedPath;
          return await deps.locks.withWriteLock(target, async () => {
            const guard = writeGuard(target);
            if (guard !== undefined) return fail(guard, { error: guard });
            const before = (await readIfExists(target)) ?? "";
            const details = await commit(target, before, params.content);
            return ok(
              `Wrote ${target} (${details.additions} additions, ${details.deletions} deletions).`,
              details,
            );
          });
        } catch (error) {
          return fail(`Could not write ${params.path}: ${describe(error)}`, {
            error: describe(error),
          });
        }
      },
    };

  const editTool: AgentTool<typeof EDIT_PARAMS, FileChangeDetails | { readonly error: string }> = {
    name: "Edit",
    label: "Edit",
    description:
      "Change a file with hashline edits that cite the tags from Read, or with one exact oldText replacement.",
    parameters: EDIT_PARAMS,
    execute: async (_toolCallId, params) => {
      let target = params.path;
      try {
        const resolution = await deps.sandbox.resolvePath(params.path, "write");
        if (resolution.denied) {
          return fail(resolution.writeDeniedReason ?? `${resolution.resolvedPath} is read-only.`, {
            error: resolution.writeDeniedReason ?? "read-only path",
          });
        }
        target = resolution.resolvedPath;
        return await deps.locks.withWriteLock(
          target,
          async (): Promise<AgentToolResult<FileChangeDetails | { readonly error: string }>> => {
            const guard = writeGuard(target);
            if (guard !== undefined) return fail(guard, { error: guard });
            const before = await readIfExists(target);
            if (before === undefined) {
              return fail(`Cannot edit ${target}: the file does not exist. Use Write first.`, {
                error: "missing file",
              });
            }

            const rawEdits: unknown = params.edits;
            if (params.edits !== undefined) {
              if (!Array.isArray(rawEdits)) {
                return fail("edits must be an array of hashline edits.", {
                  error: "invalid edits",
                });
              }
              const edits: Array<HashlineEdit> = [];
              for (const value of rawEdits) {
                const edit = asHashlineEdit(value);
                if (edit === undefined) {
                  return fail("An edit is not a valid PUT, CUT, or INS object.", {
                    error: "invalid edit",
                  });
                }
                edits.push(edit);
              }
              const applied = applyHashlineEdits(before, edits, {
                isSeen: (line) => deps.seen.hasSeenRange(target, line, line),
              });
              if (!applied.ok) {
                const state = deps.recovery.recordFailure(target, applied.error.code);
                return fail(`${applied.error.code}: ${applied.error.message}\n\n${state.message}`, {
                  error: applied.error.code,
                });
              }
              const details = await commit(target, before, applied.content);
              return ok(
                `Edited ${target} (${details.additions} additions, ${details.deletions} deletions).`,
                details,
              );
            }

            const { oldText, newText } = params;
            if (oldText === undefined || newText === undefined) {
              return fail("Provide edits, or both oldText and newText.", {
                error: "no edit given",
              });
            }
            if (oldText === "") {
              return fail("oldText must not be empty; use Write to create a file.", {
                error: "empty oldText",
              });
            }
            const occurrences = before.split(oldText).length - 1;
            if (occurrences === 0) {
              return fail(
                `oldText does not appear in ${target}. Re-read the file and copy the text exactly.`,
                { error: "oldText not found" },
              );
            }
            if (occurrences > 1) {
              return fail(
                `oldText appears ${occurrences} times in ${target}. Include more surrounding text so it is unique.`,
                { error: "oldText is ambiguous" },
              );
            }
            const after = before.replace(oldText, newText);
            const details = await commit(target, before, after);
            return ok(
              `Edited ${target} (${details.additions} additions, ${details.deletions} deletions).`,
              details,
            );
          },
        );
      } catch (error) {
        return fail(`Could not edit ${params.path}: ${describe(error)}`, {
          error: describe(error),
        });
      }
    },
  };

  const globTool: AgentTool<typeof GLOB_PARAMS, GlobDetails> = {
    name: "Glob",
    label: "Glob",
    description: "Find files by glob under the workspace, skipping .git and node_modules.",
    parameters: GLOB_PARAMS,
    execute: async (_toolCallId, params) => {
      try {
        const resolution = await deps.sandbox.resolvePath(params.path ?? ".", "read");
        const root = resolution.resolvedPath;
        const matcher = globToRegExp(params.pattern);
        const files: Array<string> = [];
        const truncated = await walk({
          root,
          isFull: () => isFull(files.length, maxGlobResults),
          visit: (_fullPath, relativePath) => {
            if (matchesGlob(matcher, params.pattern, relativePath)) {
              files.push(toPosix(relativePath));
            }
          },
        });
        const sorted = files
          .slice(0, maxGlobResults)
          .sort((left, right) => left.localeCompare(right));
        const body =
          sorted.length === 0
            ? `No files match ${params.pattern} under ${root}.`
            : `${sorted.join("\n")}\n\n[${sorted.length} files${truncated ? ", truncated" : ""}]`;
        return ok(body, { pattern: params.pattern, files: sorted, truncated });
      } catch (error) {
        return fail(`Could not glob ${params.pattern}: ${describe(error)}`, {
          pattern: params.pattern,
          files: [],
          truncated: false,
        });
      }
    },
  };

  const grepTool: AgentTool<typeof GREP_PARAMS, GrepDetails> = {
    name: "Grep",
    label: "Grep",
    description: "Search text files for a regular expression, skipping binaries and .git.",
    parameters: GREP_PARAMS,
    execute: async (_toolCallId, params) => {
      try {
        const resolution = await deps.sandbox.resolvePath(params.path ?? ".", "read");
        const root = resolution.resolvedPath;
        let regex: RegExp;
        try {
          regex = new RegExp(params.pattern, params.caseSensitive === false ? "iu" : "u");
        } catch (error) {
          return fail(`Invalid pattern: ${describe(error)}`, {
            pattern: params.pattern,
            matches: [],
            truncated: false,
          });
        }
        const globMatcher = params.glob === undefined ? undefined : globToRegExp(params.glob);
        const matches: Array<GrepMatch> = [];

        const searchFile = async (fullPath: string): Promise<void> => {
          const stat = await NodeFSP.stat(fullPath);
          if (stat.size > DEFAULT_MAX_GREP_FILE_BYTES) return;
          const buffer = await NodeFSP.readFile(fullPath);
          if (buffer.subarray(0, 8000).includes(0)) return;
          const lines = buffer.toString("utf8").split(/\r?\n/u);
          for (let index = 0; index < lines.length; index++) {
            if (isFull(matches.length, maxGrepMatches)) return;
            const line = lines[index] ?? "";
            regex.lastIndex = 0;
            if (!regex.test(line)) continue;
            matches.push({
              fileName: fullPath,
              line: index + 1,
              preview: line.trim().slice(0, MAX_PREVIEW_CHARS),
            });
          }
        };

        const stat = await NodeFSP.stat(root);
        let truncated = false;
        if (stat.isFile()) {
          await searchFile(root);
        } else {
          truncated = await walk({
            root,
            isFull: () => isFull(matches.length, maxGrepMatches),
            visit: async (fullPath, relativePath) => {
              const glob = params.glob;
              if (globMatcher !== undefined && glob !== undefined) {
                if (!matchesGlob(globMatcher, glob, relativePath)) return;
              }
              await searchFile(fullPath);
            },
          });
        }

        const body =
          matches.length === 0
            ? `No matches for ${params.pattern} under ${root}.`
            : `${matches
                .map((match) => `${match.fileName}:${match.line}: ${match.preview}`)
                .join("\n")}\n\n[${matches.length} matches${truncated ? ", truncated" : ""}]`;
        return ok(body, { pattern: params.pattern, matches, truncated });
      } catch (error) {
        return fail(`Could not grep ${params.pattern}: ${describe(error)}`, {
          pattern: params.pattern,
          matches: [],
          truncated: false,
        });
      }
    },
  };

  const bashTool: AgentTool<typeof BASH_PARAMS, BashDetails> = {
    name: "Bash",
    label: "Bash",
    description:
      "Run a shell command in the workspace folder and stream its output. Writes should use Write or Edit.",
    parameters: BASH_PARAMS,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const command = params.command;
      const patch = detectShellFilePatch(command);
      const timeoutMs = Math.min(
        Math.max(params.timeoutMs ?? defaultBashTimeoutMs, 1),
        maxBashTimeoutMs,
      );
      const cwd = deps.sandbox.cwd ?? process.cwd();
      const environment = withAgentDeviceEnvironment(
        deps.environment ?? process.env,
        deps.mcpSession,
      );
      const env: NodeJS.ProcessEnv = {
        ...environment,
        ...(deps.threadId === undefined ? {} : { [T3CODE_THREAD_ID_ENV]: deps.threadId }),
      };
      const shellPatchWarning = patch.isPatch
        ? `${patch.reason ?? "shell writes files"}; prefer Edit or Write so the change shows as a diff.`
        : undefined;

      if (isAborted(signal)) {
        const aborted: BashDetails = {
          command,
          exitCode: null,
          output: "",
          truncated: false,
          timedOut: false,
          aborted: true,
          ...(shellPatchWarning === undefined ? {} : { shellPatchWarning }),
        };
        return fail("The command was cancelled before it started.", aborted);
      }

      let child: NodeChildProcess.ChildProcess;
      try {
        child = NodeChildProcess.spawn(shell.command, [...shell.args, command], {
          cwd,
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        return fail(`Could not start the command: ${describe(error)}`, {
          command,
          exitCode: null,
          output: "",
          truncated: false,
          timedOut: false,
          aborted: false,
          ...(shellPatchWarning === undefined ? {} : { shellPatchWarning }),
        });
      }

      let outputHead = "";
      let outputTail = "";
      let truncated = false;
      let killed = false;

      const capture = (chunk: string): void => {
        if (outputHead.length < maxOutputBytes) {
          outputHead += chunk;
          if (outputHead.length > maxOutputBytes) {
            truncated = true;
            const half = Math.floor(maxOutputBytes / 2);
            outputTail = outputHead.slice(-half);
            outputHead = outputHead.slice(0, half);
          }
          return;
        }
        truncated = true;
        outputTail = (outputTail + chunk).slice(-Math.floor(maxOutputBytes / 2));
      };

      const currentOutput = (): string =>
        truncated ? `${outputHead}\n\n[output truncated]\n\n${outputTail}` : outputHead;

      const emitUpdate = (): void => {
        onUpdate?.({
          content: [text(currentOutput())],
          details: {
            command,
            exitCode: null,
            output: currentOutput(),
            truncated,
            timedOut: false,
            aborted: false,
            ...(shellPatchWarning === undefined ? {} : { shellPatchWarning }),
          },
        });
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        capture(chunk.toString("utf8"));
        emitUpdate();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        capture(chunk.toString("utf8"));
        emitUpdate();
      });

      const terminate = (): void => {
        if (killed) return;
        killed = true;
        const pid = child.pid;
        if (pid === undefined) return;
        try {
          signalProcessGroup(pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };

      const onAbort = (): void => {
        terminate();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<void>((resolve) => {
        if (deps.sleep !== undefined) {
          void deps.sleep(timeoutMs).then(resolve, resolve);
          return;
        }
        timeoutHandle = setTimeout(resolve, timeoutMs);
      });

      let exited = false;
      const exitPromise = new Promise<number | null>((resolve) => {
        child.once("close", (code) => {
          exited = true;
          resolve(code);
        });
        child.once("error", () => {
          exited = true;
          resolve(null);
        });
      });

      try {
        await Promise.race([exitPromise, timeoutPromise]);
        const timedOut = !exited;
        if (timedOut) terminate();
        const exitCode = await exitPromise;
        const aborted = isAborted(signal);
        const details: BashDetails = {
          command,
          exitCode,
          output: currentOutput(),
          truncated,
          timedOut,
          aborted,
          ...(shellPatchWarning === undefined ? {} : { shellPatchWarning }),
        };
        if (aborted) {
          return fail("The command was cancelled.", details);
        }
        const status = timedOut
          ? `Command timed out after ${timeoutMs}ms.`
          : `Command exited with code ${exitCode ?? "null"}.`;
        const body = details.output === "" ? status : `${details.output}\n\n${status}`;
        const withWarning =
          shellPatchWarning === undefined ? body : `${body}\n\n[warning] ${shellPatchWarning}`;
        const result = ok(withWarning, details);
        return timedOut ? { ...result, isError: true } : result;
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", onAbort);
        terminate();
      }
    },
  };

  const askTool: AgentTool<typeof ASK_PARAMS, AskToolDetails> = {
    name: "asktool",
    label: "asktool",
    description: "Ask the user one or more structured questions and wait for the answers.",
    parameters: ASK_PARAMS,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const questions = params.questions.map(toUserInputQuestion);
      try {
        const answers = await deps.requestUserInput(questions, signal);
        return {
          content: [text(JSON.stringify(answers, null, 2))],
          details: { questions, answers },
        };
      } catch (error) {
        return fail(`Could not ask the user: ${describe(error)}`, { questions, answers: {} });
      }
    },
  };

  const submitPlanTool: AgentTool<typeof PLAN_PARAMS, PlanDetails> = {
    name: "SubmitPlan",
    label: "SubmitPlan",
    description: "Submit the plan as markdown; a plan-mode turn ends once the plan is submitted.",
    parameters: PLAN_PARAMS,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const summary = params.summary?.trim();
      const normalizedSummary = summary === undefined || summary === "" ? undefined : summary;
      const submission: PlanSubmission = {
        markdown: params.markdown,
        ...(normalizedSummary === undefined ? {} : { summary: normalizedSummary }),
      };
      if (params.markdown.trim() === "") {
        return fail("Plan markdown cannot be empty.", submission);
      }
      await deps.onSubmitPlan(submission);
      return {
        content: [
          text(
            normalizedSummary === undefined
              ? "Plan submitted."
              : `Plan submitted: ${normalizedSummary}`,
          ),
        ],
        details: submission,
        terminate: deps.isPlanMode(),
      };
    },
  };

  let fallbackTodos: TodoSnapshot = EMPTY_TODO_SNAPSHOT;
  const readCurrentTodos = async (): Promise<TodoSnapshot> =>
    deps.readTodos ? await deps.readTodos() : fallbackTodos;

  const todoTool: AgentTool<typeof TODO_PARAMS, TodoDetails> = {
    name: "TodoWrite",
    label: "TodoWrite",
    description:
      "Replace the visible todo list for this thread. Each step must have a unique non-empty id, non-empty text, and status (pending, running, or completed). Invalid updates are rejected without modifying the stored list. Use TodoRead to inspect the current stored list.",
    parameters: TODO_PARAMS,
    execute: async (_toolCallId, params) => {
      const validated = validateTodoUpdate(params);
      if (!validated.ok) {
        return fail(validated.error, await readCurrentTodos());
      }
      const committed = await deps.onTodoUpdate(validated.update);
      const snapshot: TodoSnapshot = committed ?? {
        revision: fallbackTodos.revision + 1,
        ...validated.update,
      };
      fallbackTodos = snapshot;
      return ok(formatTodoWriteOutput(snapshot), snapshot);
    },
  };

  const todoReadTool: AgentTool<typeof TODO_READ_PARAMS, TodoDetails> = {
    name: "TodoRead",
    label: "TodoRead",
    description:
      "Read the current visible todo list for this session, including its revision, step IDs, statuses, and text.",
    parameters: TODO_READ_PARAMS,
    execute: async () => {
      const snapshot = await readCurrentTodos();
      return ok(formatTodoReadOutput(snapshot), snapshot);
    },
  };

  const newContextTool: AgentTool<typeof NEW_CONTEXT_PARAMS, NewContextDetails> = {
    name: "new_context",
    label: "new_context",
    description: "Ask T3 Code to compact this conversation into a fresh context.",
    parameters: NEW_CONTEXT_PARAMS,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      await deps.onRequestCompaction(params.reason);
      return {
        content: [text("Context compaction requested.")],
        details: {
          ...(params.reason === undefined ? {} : { reason: params.reason }),
          ...(params.summaryHint === undefined ? {} : { summaryHint: params.summaryHint }),
        },
      };
    },
  };

  const updateGoalStatusTool: AgentTool<typeof GOAL_STATUS_PARAMS, GoalStatusUpdateResult> = {
    name: "UpdateGoalStatus",
    label: "UpdateGoalStatus",
    description:
      "Record a check on the active goal. Use complete once every acceptance criterion is objectively verified, blocked when the goal cannot progress, or active for a progress check.",
    parameters: GOAL_STATUS_PARAMS,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const summary = params.summary.trim();
      const update: GoalStatusUpdate = { status: params.status, summary };
      if (summary === "") {
        return fail("A goal status summary cannot be empty.", {
          ok: false,
          error: "A goal status summary cannot be empty.",
        });
      }
      const callback = deps.onGoalStatusUpdate;
      if (callback === undefined) {
        return fail("Goal status updates are unavailable in this session.", {
          ok: false,
          error: "Goal status updates are unavailable in this session.",
        });
      }
      const result = await callback(update);
      return result.ok ? ok(result.message, result) : fail(result.error, result);
    },
  };

  return [
    readTool,
    writeTool,
    editTool,
    globTool,
    grepTool,
    bashTool,
    createSkillTool({ skills: () => deps.skills?.() ?? [] }),
    askTool,
    submitPlanTool,
    todoTool,
    todoReadTool,
    newContextTool,
    ...(deps.onGoalStatusUpdate === undefined ? [] : [updateGoalStatusTool]),
  ];
};
