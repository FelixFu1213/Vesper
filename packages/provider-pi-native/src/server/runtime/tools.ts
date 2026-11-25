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
  applyEdit,
  applyLegacyTextEdit,
  findRecoveredPath,
  legacyHashlineEditsToOps,
  NamedRegisters,
  type EditResult,
  type EditSessionState,
  type LegacyHashlineEdit,
} from "./editEngine.ts";
import {
  computeFileTag,
  decodeNormalizedFile,
  detectLineEnding,
  encodeNormalizedFile,
  FILE_TAG_PATTERN,
  formatSectionHeader,
  normalizeLineEndings,
  splitFileLines,
  stripWriteMarkup,
  type FileAnchorStore,
  type NormalizedFile,
} from "./fileAnchorTypes.ts";
import { buildSimpleDiff } from "./hashline.ts";
import { detectShellFilePatch, MutationRecoveryTracker } from "./mutationRecovery.ts";
import {
  isSensitivePath,
  sensitivePathDeniedMessage,
  WORKSPACE_PATH_DENIED,
} from "./ignoreRules.ts";
import { PathMutex } from "./pathLock.ts";
import type { WorkspaceSandbox } from "./sandbox.ts";
import {
  canonicalizeToolParams,
  describeDirectoryReadHint,
  globFiles,
  normalizeOutputMode,
  PATH_PARAM_ALIASES,
  searchFiles,
  SEARCH_PARAM_ALIASES,
  type GrepSearchResult,
  type SearchFileAnchorSink,
  type SearchOutputMode,
} from "./searchTools.ts";

const T3CODE_THREAD_ID_ENV = "T3CODE_THREAD_ID";

const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_GLOB_RESULTS = 500;
const DEFAULT_MAX_GREP_MATCHES = 200;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BASH_TIMEOUT_MS = 600_000;
const MAX_LINE_CHARS = 16_384;

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
  readonly tag: string;
  readonly line: number;
  readonly preview: string;
  readonly clipped: boolean;
}

export interface GrepFileListing {
  readonly fileName: string;
  readonly tag: string;
}

export interface GrepCount {
  readonly fileName: string;
  readonly tag: string;
  readonly count: number;
}

export interface ShellSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface PiNativeToolDeps {
  readonly sandbox: WorkspaceSandbox;
  readonly anchors: FileAnchorStore;
  readonly registers: NamedRegisters;
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
  readonly mcpSession?: McpProviderSessionConfig;
  readonly threadId?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly shell?: ShellSpec;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly maxImageBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxGlobResults?: number;
  readonly maxGrepMatches?: number;
  readonly globalIgnoreFile?: string | null;
  readonly rgPath?: string | null;
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
  readonly tag?: string;
}

export interface FileChangeDetails {
  readonly fileName: string;
  readonly additions: number;
  readonly deletions: number;
  readonly diffStr: string;
  readonly oldStr: string;
  readonly newStr: string;
  readonly tag?: string;
  readonly warnings?: ReadonlyArray<string>;
  readonly ops?: ReadonlyArray<string>;
}

export interface GlobDetails {
  readonly pattern: string;
  readonly files: ReadonlyArray<string>;
  readonly truncated: boolean;
}

export interface GrepDetails {
  readonly pattern: string;
  readonly outputMode: SearchOutputMode;
  readonly matches: ReadonlyArray<GrepMatch>;
  readonly files: ReadonlyArray<GrepFileListing>;
  readonly counts: ReadonlyArray<GrepCount>;
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

const toPosix = (value: string): string => value.split(NodePath.sep).join("/");

const formatGrepBody = (result: GrepSearchResult, pattern: string, root: string): string => {
  if (result.files.length === 0) return `No matches for ${pattern} under ${root}.`;
  const lines: Array<string> = [];
  for (const file of result.files) {
    const header = `[${file.path}#${file.tag}]`;
    if (result.mode === "content") {
      lines.push(header);
      for (const hit of file.hits) lines.push(`${hit.line}: ${hit.text}`);
      continue;
    }
    if (result.mode === "filesWithMatches") {
      lines.push(header);
      continue;
    }
    lines.push(`${file.count}  ${header}`);
  }
  const noun = result.mode === "filesWithMatches" ? "files" : "matches";
  const summary =
    result.mode === "filesWithMatches"
      ? `[${result.files.length} ${noun}${result.truncated ? ", truncated" : ""}]`
      : `[${result.totalMatches} ${noun} in ${result.files.length} files${result.truncated ? ", truncated" : ""}]`;
  return `${lines.join("\n")}\n\n${summary}`;
};
const imageMimeType = (target: string): string | undefined =>
  IMAGE_MIME_TYPES[NodePath.extname(target).toLowerCase()];

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

const asLegacyHashlineEdit = (value: unknown): LegacyHashlineEdit | undefined => {
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
  path: opt(str({ description: "File path, absolute or relative to the workspace folder." })),
  file_path: opt(str({ description: "Alias for path." })),
  offset: opt(int({ minimum: 1, description: "First line to read, 1-indexed." })),
  limit: opt(int({ minimum: 1, description: "How many lines to read." })),
});

const WRITE_PARAMS = obj({
  path: opt(str({ description: "File path to create or overwrite." })),
  file_path: opt(str({ description: "Alias for path." })),
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
  path: opt(str({ description: "File path to edit. Edit never creates files; use Write." })),
  file_path: opt(str({ description: "Alias for path." })),
  tag: opt(
    str({
      description:
        "4 uppercase hex from the latest Read, Grep, Write, or Edit result for this path.",
    }),
  ),
  ops: opt(
    str({
      description:
        'Operation headers and + body rows, newline separated: "PUT 12.=14:", "PUT <3:", "PUT >$", "CUT 7.=9", "PUT 12*", "MV dest.ts", "REM".',
    }),
  ),
  edits: opt(
    arr(HASHLINE_EDIT_SCHEMA, {
      description: "Legacy hashline edits; ops is preferred.",
    }),
  ),
  oldText: opt(str({ description: "Legacy compatibility: exact text to replace." })),
  newText: opt(str({ description: "Legacy compatibility: replacement text for oldText." })),
  old_string: opt(str({ description: "Legacy compatibility alias for oldText." })),
  new_string: opt(str({ description: "Legacy compatibility alias for newText." })),
});

const GLOB_PARAMS = obj({
  pattern: opt(str({ description: 'Glob such as "**/*.ts".' })),
  query: opt(str({ description: "Alias for pattern." })),
  path: opt(str({ description: "Directory to search; defaults to the workspace folder." })),
});

const GREP_PARAMS = obj({
  pattern: opt(str({ description: "Regular expression to search for." })),
  query: opt(str({ description: "Alias for pattern." })),
  path: opt(str({ description: "Directory or file to search; defaults to the workspace folder." })),
  include: opt(str({ description: 'Only search files matching this glob, such as "*.ts".' })),
  glob: opt(str({ description: "Alias for include." })),
  outputMode: opt(
    str({ description: "content, filesWithMatches, or count. Defaults to content." }),
  ),
  output_mode: opt(str({ description: "Alias for outputMode." })),
  caseInsensitive: opt(bool({ description: "Set true for a case-insensitive search." })),
  headLimit: opt(int({ minimum: 1, description: "Maximum matches or files to return." })),
  head_limit: opt(int({ minimum: 1, description: "Alias for headLimit." })),
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

  const displayPath = (target: string): string => {
    const cwd = deps.sandbox.cwd;
    if (cwd === null) return target;
    const relative = NodePath.relative(cwd, target);
    return relative === "" || relative.startsWith("..") || NodePath.isAbsolute(relative)
      ? target
      : toPosix(relative);
  };

  const allLines = (text: string): ReadonlySet<number> =>
    new Set(splitFileLines(text).map((_line, index) => index + 1));

  const readNormalized = async (target: string): Promise<NormalizedFile | undefined> => {
    try {
      return decodeNormalizedFile(await NodeFSP.readFile(target));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
  };

  const emptyReadDetails = (target: string): ReadDetails => ({
    path: target,
    startLine: 0,
    endLine: 0,
    totalLines: 0,
    truncated: false,
    image: false,
  });

  const commitContent = async (
    target: string,
    beforeText: string,
    after: NormalizedFile,
  ): Promise<FileChangeDetails> => {
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, encodeNormalizedFile(after));
    const diff = buildSimpleDiff(target, beforeText, after.text);
    const tag = deps.anchors.record(target, after.text, allLines(after.text));
    deps.recovery.recordSuccess(target);
    return {
      fileName: NodePath.basename(target),
      additions: diff.additions,
      deletions: diff.deletions,
      diffStr: diff.diffStr,
      oldStr: beforeText,
      newStr: after.text,
      tag,
    };
  };

  const editSession = (): EditSessionState => ({
    store: deps.anchors,
    registers: deps.registers,
  });

  const describeEditFailure = (
    failure: {
      readonly code: string;
      readonly message: string;
      readonly extras?: {
        readonly unseenLines?: ReadonlyArray<{
          readonly line: number;
          readonly text: string;
          readonly clipped: boolean;
        }>;
      };
    },
    target: string,
  ): string => {
    const state = deps.recovery.recordFailure(target, failure.code);
    const reveal = (failure.extras?.unseenLines ?? []).map(
      (row) => `${row.line}: ${row.text}${row.clipped ? " ..." : ""}`,
    );
    return [
      `${failure.code}: ${failure.message}`,
      ...(reveal.length === 0 ? [] : ["", ...reveal]),
      "",
      state.message,
    ].join("\n");
  };

  const readTool: AgentTool<typeof READ_PARAMS, ReadDetails> = {
    name: "Read",
    label: "Read",
    description:
      "Read a file from the workspace. Text comes back as lineNum:tag|line; use those tags for Edit.",
    parameters: READ_PARAMS,
    execute: async (_toolCallId, rawParams) => {
      const params = canonicalizeToolParams(rawParams, PATH_PARAM_ALIASES);
      const path = params.path;
      if (path === undefined) {
        return fail("A path is required.", emptyReadDetails(""));
      }
      try {
        const resolution = await deps.sandbox.resolvePath(path, "read");
        const target = resolution.resolvedPath;
        if (isSensitivePath(target)) {
          return fail(sensitivePathDeniedMessage(target), emptyReadDetails(target));
        }
        return await deps.locks.withReadLock(target, async () => {
          const stat = await NodeFSP.stat(target);
          if (stat.isDirectory()) {
            return fail(describeDirectoryReadHint(target), emptyReadDetails(target));
          }
          if (!stat.isFile()) {
            return fail(`${target} is not a regular file.`, emptyReadDetails(target));
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

          const file = decodeNormalizedFile(await NodeFSP.readFile(target));
          deps.recovery.recordSuccess(target);

          const lines = splitFileLines(file.text);
          const totalLines = lines.length;
          const tag = computeFileTag(file.text);
          const header = formatSectionHeader(displayPath(target), tag);
          if (totalLines === 0) {
            deps.anchors.record(target, file.text, new Set());
            return ok(`${header}\n[file is empty]`, {
              path: target,
              startLine: 0,
              endLine: 0,
              totalLines: 0,
              truncated: false,
              image: false,
              tag,
            });
          }
          const startLine = Math.min(Math.max(params.offset ?? 1, 1), totalLines);
          const limit = params.limit ?? totalLines - startLine + 1;
          const endLine = Math.min(startLine + Math.max(limit, 1) - 1, totalLines);
          const seen = new Set<number>();
          const formatted = lines
            .slice(startLine - 1, endLine)
            .map((line, index) => {
              const lineNumber = startLine + index;
              const chars = [...line];
              if (chars.length <= MAX_LINE_CHARS) seen.add(lineNumber);
              return `${lineNumber}:${chars.slice(0, MAX_LINE_CHARS).join("")}`;
            })
            .join("\n");
          deps.anchors.record(target, file.text, seen);
          const clipped = endLine - startLine + 1 - seen.size;
          const truncated = endLine < totalLines || startLine > 1;
          const footer = [
            ...(truncated ? [`[lines ${startLine}-${endLine} of ${totalLines}]`] : []),
            ...(clipped === 0
              ? []
              : [`[${clipped} line(s) clipped at ${MAX_LINE_CHARS} characters]`]),
          ];
          const body = [header, formatted, ...(footer.length === 0 ? [] : ["", ...footer])].join(
            "\n",
          );
          return ok(body, {
            path: target,
            startLine,
            endLine,
            totalLines,
            truncated,
            image: false,
            tag,
          });
        });
      } catch (error) {
        return fail(`Could not read ${path}: ${describe(error)}`, emptyReadDetails(path));
      }
    },
  };

  const writeTool: AgentTool<typeof WRITE_PARAMS, FileChangeDetails | { readonly error: string }> =
    {
      name: "Write",
      label: "Write",
      description: "Create or overwrite a file with the full content, then return the diff.",
      parameters: WRITE_PARAMS,
      execute: async (_toolCallId, rawParams) => {
        const params = canonicalizeToolParams(rawParams, PATH_PARAM_ALIASES);
        const path = params.path;
        if (path === undefined)
          return fail("A path is required.", { error: "A path is required." });
        try {
          const resolution = await deps.sandbox.resolvePath(path, "write");
          const target = resolution.resolvedPath;
          if (isSensitivePath(target)) {
            return fail(sensitivePathDeniedMessage(target), { error: WORKSPACE_PATH_DENIED });
          }
          if (resolution.denied) {
            return fail(
              resolution.writeDeniedReason ?? `${resolution.resolvedPath} is read-only.`,
              {
                error: resolution.writeDeniedReason ?? "read-only path",
              },
            );
          }
          return await deps.locks.withWriteLock(target, async () => {
            const guard = writeGuard(target);
            if (guard !== undefined) return fail(guard, { error: guard });
            const existing = await readNormalized(target);
            const after: NormalizedFile = {
              text: normalizeLineEndings(stripWriteMarkup(params.content)),
              ending: existing?.ending ?? detectLineEnding(params.content),
              bom: existing?.bom ?? false,
              utf16: existing?.utf16,
            };
            const details = await commitContent(target, existing?.text ?? "", after);
            return ok(
              `Wrote ${formatSectionHeader(displayPath(target), details.tag ?? "")} (${details.additions} additions, ${details.deletions} deletions).`,
              details,
            );
          });
        } catch (error) {
          return fail(`Could not write ${path}: ${describe(error)}`, {
            error: describe(error),
          });
        }
      },
    };

  const editTool: AgentTool<typeof EDIT_PARAMS, FileChangeDetails | { readonly error: string }> = {
    name: "Edit",
    label: "Edit",
    description:
      "Edit one existing file by position. Send the tag from Read, Grep, Write, or your last Edit, plus ops such as `PUT 12.=14:` with `+TEXT` rows, `PUT <3:`, `PUT >$:`, `CUT 7.=9`, `PUT 12*`, `MV dest.ts`, or `REM`. Body rows are the final content only.",
    parameters: EDIT_PARAMS,
    execute: async (_toolCallId, rawParams) => {
      const params = canonicalizeToolParams(rawParams, PATH_PARAM_ALIASES);
      const path = params.path;
      if (path === undefined) {
        return fail("A path is required.", { error: "A path is required." });
      }
      try {
        let resolution = await deps.sandbox.resolvePath(path, "write");
        if (isSensitivePath(resolution.resolvedPath)) {
          return fail(sensitivePathDeniedMessage(resolution.resolvedPath), {
            error: WORKSPACE_PATH_DENIED,
          });
        }
        if (resolution.denied) {
          return fail(resolution.writeDeniedReason ?? `${resolution.resolvedPath} is read-only.`, {
            error: resolution.writeDeniedReason ?? "read-only path",
          });
        }
        let target = resolution.resolvedPath;
        const rawTag = params.tag?.trim().toUpperCase() ?? "";
        let file = await readNormalized(target);
        if (file === undefined && FILE_TAG_PATTERN.test(rawTag)) {
          const recovered = findRecoveredPath(deps.anchors, path, target, rawTag);
          if (recovered !== undefined) {
            resolution = await deps.sandbox.resolvePath(recovered, "write");
            if (isSensitivePath(resolution.resolvedPath)) {
              return fail(sensitivePathDeniedMessage(resolution.resolvedPath), {
                error: WORKSPACE_PATH_DENIED,
              });
            }
            if (resolution.denied) {
              return fail(
                resolution.writeDeniedReason ?? `${resolution.resolvedPath} is read-only.`,
                { error: resolution.writeDeniedReason ?? "read-only path" },
              );
            }
            target = resolution.resolvedPath;
            file = await readNormalized(target);
          }
        }
        if (file === undefined) {
          return fail(`Cannot edit ${target}: the file does not exist. Use Write first.`, {
            error: "missing file",
          });
        }
        const live = file;
        return await deps.locks.withWriteLock(
          target,
          async (): Promise<AgentToolResult<FileChangeDetails | { readonly error: string }>> => {
            const guard = writeGuard(target);
            if (guard !== undefined) return fail(guard, { error: guard });
            const session = editSession();
            const oldText = params.oldText ?? params.old_string;
            const newText = params.newText ?? params.new_string;
            const extraWarnings: Array<string> = [];
            let result: EditResult;
            if (params.ops !== undefined) {
              result = applyEdit({
                path,
                canonicalPath: target,
                tag: rawTag,
                ops: params.ops,
                text: live.text,
                session,
              });
            } else if (oldText !== undefined) {
              if (newText === undefined) {
                return fail("oldText needs newText; send ops with the file tag instead.", {
                  error: "missing newText",
                });
              }
              result = applyLegacyTextEdit({
                path,
                canonicalPath: target,
                text: live.text,
                oldText,
                newText,
                session,
              });
            } else if (params.edits !== undefined) {
              if (!Array.isArray(params.edits)) {
                return fail("edits must be an array of PUT, CUT, or INS objects.", {
                  error: "invalid edits",
                });
              }
              const legacy: Array<LegacyHashlineEdit> = [];
              for (const value of params.edits) {
                const edit = asLegacyHashlineEdit(value);
                if (edit === undefined) {
                  return fail("An edit is not a valid PUT, CUT, or INS object.", {
                    error: "invalid edit",
                  });
                }
                legacy.push(edit);
              }
              const lowered = legacyHashlineEditsToOps(legacy);
              if ("ok" in lowered) {
                return fail(`${lowered.code}: ${lowered.message}`, { error: lowered.code });
              }
              if (!FILE_TAG_PATTERN.test(rawTag)) {
                extraWarnings.push(
                  "edits[] carried no tag; applied to the live file with the provenance gate",
                );
              }
              result = applyEdit({
                path,
                canonicalPath: target,
                tag: FILE_TAG_PATTERN.test(rawTag) ? rawTag : computeFileTag(live.text),
                ops: lowered.ops,
                text: live.text,
                session,
              });
            } else {
              return fail("Provide ops with tag, edits, or oldText/newText.", {
                error: "no edit given",
              });
            }
            if (!result.ok) {
              return fail(describeEditFailure(result, target), { error: result.code });
            }

            let movedTo: string | undefined;
            if (result.movedTo !== undefined) {
              const dest = await deps.sandbox.resolvePath(result.movedTo, "write");
              if (isSensitivePath(dest.resolvedPath)) {
                return fail(sensitivePathDeniedMessage(dest.resolvedPath), {
                  error: WORKSPACE_PATH_DENIED,
                });
              }
              if (dest.denied) {
                return fail(dest.writeDeniedReason ?? `${dest.resolvedPath} is read-only.`, {
                  error: dest.writeDeniedReason ?? "read-only path",
                });
              }
              if (dest.resolvedPath === target) {
                deps.recovery.recordFailure(target, "EDIT_NO_CHANGE");
                return fail(
                  `EDIT_NO_CHANGE: MV ${result.movedTo} resolves to ${target}; the source is untouched. Use a distinct destination.`,
                  { error: "EDIT_NO_CHANGE" },
                );
              }
              movedTo = dest.resolvedPath;
            }

            if (result.deleteFile) {
              await NodeFSP.rm(target, { force: true });
              deps.anchors.invalidatePath(target);
              deps.recovery.recordSuccess(target);
              const diff = buildSimpleDiff(target, live.text, "");
              return ok(`Removed ${formatSectionHeader(displayPath(target), result.tag)}.`, {
                fileName: NodePath.basename(target),
                additions: diff.additions,
                deletions: diff.deletions,
                diffStr: diff.diffStr,
                oldStr: live.text,
                newStr: "",
                tag: result.tag,
                warnings: [...extraWarnings, ...result.warnings],
                ops: result.ops,
              });
            }

            await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
            await NodeFSP.writeFile(
              target,
              encodeNormalizedFile({
                text: result.text,
                ending: live.ending,
                bom: live.bom,
                utf16: live.utf16,
              }),
            );
            if (movedTo === undefined) {
              deps.anchors.record(target, result.text, allLines(result.text));
            } else {
              await NodeFSP.mkdir(NodePath.dirname(movedTo), { recursive: true });
              await NodeFSP.rename(target, movedTo);
              deps.anchors.invalidatePath(target);
              deps.anchors.record(movedTo, result.text, allLines(result.text));
              deps.recovery.recordSuccess(movedTo);
            }
            deps.recovery.recordSuccess(target);

            const finalPath = movedTo ?? target;
            const diff = buildSimpleDiff(target, live.text, result.text);
            const warnings = [...extraWarnings, ...result.warnings];
            const summary = `Edited ${formatSectionHeader(displayPath(finalPath), result.tag)} (${diff.additions} additions, ${diff.deletions} deletions).`;
            const blockLines = result.blocks.map(
              (block) => `[block] ${block.op} -> lines ${block.start}-${block.end}`,
            );
            const warningLines = warnings.map((warning) => `[warning] ${warning}`);
            return ok([summary, ...blockLines, ...warningLines].join("\n"), {
              fileName: NodePath.basename(finalPath),
              additions: diff.additions,
              deletions: diff.deletions,
              diffStr: diff.diffStr,
              oldStr: live.text,
              newStr: result.text,
              tag: result.tag,
              warnings,
              ops: result.ops,
            });
          },
        );
      } catch (error) {
        return fail(`Could not edit ${path}: ${describe(error)}`, {
          error: describe(error),
        });
      }
    },
  };

  const globTool: AgentTool<typeof GLOB_PARAMS, GlobDetails> = {
    name: "Glob",
    label: "Glob",
    description:
      "Find files by glob under the workspace. Results are ordered newest first and honor workspace ignore rules.",
    parameters: GLOB_PARAMS,
    execute: async (_toolCallId, rawParams) => {
      const params = canonicalizeToolParams(rawParams, SEARCH_PARAM_ALIASES);
      const pattern = params.pattern;
      if (pattern === undefined) {
        return fail("A glob pattern is required.", {
          pattern: "",
          files: [],
          truncated: false,
        });
      }
      try {
        const resolution = await deps.sandbox.resolvePath(params.path ?? ".", "read");
        const root = resolution.resolvedPath;
        const stat = await NodeFSP.stat(root);
        if (!stat.isDirectory()) {
          return fail(`${root} is not a directory; Glob searches a directory.`, {
            pattern,
            files: [],
            truncated: false,
          });
        }
        const result = await globFiles({
          root,
          ignoreRoot: deps.sandbox.cwd ?? root,
          scoped: params.path !== undefined,
          pattern,
          limit: maxGlobResults,
          ...(deps.globalIgnoreFile === undefined
            ? {}
            : { globalIgnoreFile: deps.globalIgnoreFile }),
        });
        const body =
          result.files.length === 0
            ? `No files match ${pattern} under ${root}.`
            : `${result.files.join("\n")}\n\n[${result.files.length} files${result.truncated ? ", truncated" : ""}]`;
        return ok(body, { pattern, files: result.files, truncated: result.truncated });
      } catch (error) {
        return fail(`Could not glob ${pattern}: ${describe(error)}`, {
          pattern,
          files: [],
          truncated: false,
        });
      }
    },
  };

  const emptyGrepDetails = (pattern: string): GrepDetails => ({
    pattern,
    outputMode: "content",
    matches: [],
    files: [],
    counts: [],
    truncated: false,
  });

  const grepTool: AgentTool<typeof GREP_PARAMS, GrepDetails> = {
    name: "Grep",
    label: "Grep",
    description:
      "Search text files for a regular expression. Results are ordered newest first, honor workspace ignore rules, and can return content, filesWithMatches, or count.",
    parameters: GREP_PARAMS,
    execute: async (_toolCallId, rawParams) => {
      const params = canonicalizeToolParams(rawParams, {
        ...PATH_PARAM_ALIASES,
        ...SEARCH_PARAM_ALIASES,
      });
      const pattern = params.pattern;
      if (pattern === undefined) {
        return fail("A pattern is required.", emptyGrepDetails(""));
      }
      let outputMode: SearchOutputMode;
      try {
        outputMode = normalizeOutputMode(params.outputMode);
      } catch (error) {
        return fail(describe(error), emptyGrepDetails(pattern));
      }
      try {
        const resolution = await deps.sandbox.resolvePath(params.path ?? ".", "read");
        const root = resolution.resolvedPath;
        const anchorSink: SearchFileAnchorSink = {
          recordContentHits: ({ path, content, lines }) => {
            deps.anchors.record(path, normalizeLineEndings(content), new Set(lines));
          },
        };
        const result = await searchFiles({
          root,
          ignoreRoot: deps.sandbox.cwd ?? root,
          scoped: params.path !== undefined,
          pattern,
          outputMode,
          caseInsensitive: params.caseInsensitive === true,
          headLimit: Math.max(1, params.headLimit ?? maxGrepMatches),
          anchorSink,
          ...(params.include === undefined ? {} : { include: params.include }),
          ...(deps.globalIgnoreFile === undefined
            ? {}
            : { globalIgnoreFile: deps.globalIgnoreFile }),
          ...(deps.rgPath === undefined ? {} : { rgPath: deps.rgPath }),
        });
        const matches: ReadonlyArray<GrepMatch> =
          outputMode === "content"
            ? result.files.flatMap((file) =>
                file.hits.map((hit) => ({
                  fileName: file.path,
                  tag: file.tag,
                  line: hit.line,
                  preview: hit.text,
                  clipped: hit.clipped,
                })),
              )
            : [];
        const details: GrepDetails = {
          pattern,
          outputMode,
          matches,
          files:
            outputMode === "filesWithMatches"
              ? result.files.map((file) => ({ fileName: file.path, tag: file.tag }))
              : [],
          counts:
            outputMode === "count"
              ? result.files.map((file) => ({
                  fileName: file.path,
                  tag: file.tag,
                  count: file.count,
                }))
              : [],
          truncated: result.truncated,
        };
        return ok(formatGrepBody(result, pattern, root), details);
      } catch (error) {
        return fail(`Could not grep ${pattern}: ${describe(error)}`, emptyGrepDetails(pattern));
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
    askTool,
    submitPlanTool,
    todoTool,
    todoReadTool,
    newContextTool,
    ...(deps.onGoalStatusUpdate === undefined ? [] : [updateGoalStatusTool]),
  ];
};
