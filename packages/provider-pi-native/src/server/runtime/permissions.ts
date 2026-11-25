import type { ProviderApprovalDecision, RuntimeMode } from "@t3tools/contracts";
import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";

import { detectShellFilePatch } from "./mutationRecovery.ts";
import type { SandboxResolution, WorkspaceSandbox } from "./sandbox.ts";

export const RUNTIME_MODE_ORDER: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

export const clampRuntimeMode = (
  mode: RuntimeMode,
  ceiling: RuntimeMode | undefined,
): RuntimeMode => {
  if (ceiling === undefined) return mode;
  const modeRank = RUNTIME_MODE_ORDER.indexOf(mode);
  const ceilingRank = RUNTIME_MODE_ORDER.indexOf(ceiling);
  return ceilingRank >= 0 && ceilingRank < modeRank ? ceiling : mode;
};

export type ToolRisk =
  | "read"
  | "file_edit"
  | "safe_shell"
  | "shell"
  | "destructive_shell"
  | "external_read"
  | "external_write"
  | "mcp_write";

const PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "Skill",
  "asktool",
  "SubmitPlan",
  "UpdateGoalStatus",
  "TodoWrite",
  "TodoRead",
  "Task",
  "TaskWait",
  "TaskList",
  "TaskStop",
  "new_context",
]);

const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "Skill",
  "TodoWrite",
  "TodoRead",
  "SubmitPlan",
  "UpdateGoalStatus",
  "asktool",
  "new_context",
]);

const FILE_TOOL_NAMES: ReadonlySet<string> = new Set(["Read", "Write", "Edit", "Glob", "Grep"]);

const PATH_KEYS = ["path", "filePath", "file_path", "target", "directory", "cwd"] as const;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const extractToolPath = (args: unknown): string | undefined => {
  const record = asRecord(args);
  if (record === undefined) return undefined;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
};

const extractCommand = (args: unknown): string | undefined => {
  const record = asRecord(args);
  const command = record?.command;
  return typeof command === "string" ? command : undefined;
};

const SAFE_PROGRAMS: ReadonlySet<string> = new Set([
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "which",
  "echo",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "basename",
  "dirname",
  "printenv",
  "stat",
  "file",
  "du",
  "df",
  "tree",
  "jq",
  "git",
]);

const SAFE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "rev-parse",
  "describe",
  "ls-files",
  "remote",
  "shortlog",
]);

const DESTRUCTIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /\brm\s+-(?:[a-zA-Z]*[rR]|[a-zA-Z]*f[a-zA-Z]*)/u,
  /\bgit\s+reset\s+--hard\b/u,
  /\bgit\s+push\b[^|;&]*(?:\s--force\b|\s-f\b)/u,
  /\bgit\s+clean\s+-[a-zA-Z]*[fdx]/u,
  /\bdd\b[^|;&]*\bof=/u,
  /\bmkfs(?:\.[a-z0-9]+)?\b/u,
  /\bsudo\b/u,
  /\bchmod\s+-[a-zA-Z]*R[a-zA-Z]*\s+777\b/u,
  /:\s*\(\s*\)\s*\{/u,
  /\b(?:shred|killall|pkill|shutdown|reboot|halt)\b/u,
  /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sh|bash|zsh)\b/u,
];

const SHELL_SPLIT_PATTERN = /(?:\|\||&&|[;|&\n])/u;

export type ShellRisk = "safe_shell" | "shell" | "destructive_shell";

export const classifyShellCommand = (command: string): ShellRisk => {
  const trimmed = command.trim();
  if (trimmed === "") return "safe_shell";
  if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(trimmed))) return "destructive_shell";
  if (trimmed.includes("$(") || trimmed.includes("`")) return "shell";
  if (detectShellFilePatch(trimmed).isPatch) return "shell";

  const segments = trimmed.split(SHELL_SPLIT_PATTERN).filter((segment) => segment.trim() !== "");
  if (segments.length === 0) return "shell";
  for (const segment of segments) {
    const words = segment
      .trim()
      .split(/\s+/u)
      .filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word));
    const program = words[0];
    if (program === undefined) continue;
    if (!SAFE_PROGRAMS.has(program)) return "shell";
    if (program === "find") return "shell";
    if (program === "git") {
      const subcommand = words[1];
      if (subcommand === undefined || !SAFE_GIT_SUBCOMMANDS.has(subcommand)) return "shell";
    }
    if (program === "sort" && words.includes("-o")) return "shell";
  }
  return "safe_shell";
};

export interface RiskContext {
  /** True for an MCP tool whose remote metadata declares it read-only. */
  readonly mcpReadOnly?: boolean;
}

export const classifyToolRisk = (
  toolName: string,
  args: unknown,
  resolution: SandboxResolution | undefined,
  context?: RiskContext,
): ToolRisk => {
  if (toolName === "Write" || toolName === "Edit") {
    return resolution?.classification === "external" ? "external_write" : "file_edit";
  }
  if (toolName === "Bash") return classifyShellCommand(extractCommand(args) ?? "");
  if (toolName.startsWith("mcp__") && context?.mcpReadOnly !== true) return "mcp_write";
  if (resolution?.classification === "external") return "external_read";
  return "read";
};

const RISK_SUMMARIES: Record<ToolRisk, string> = {
  read: "Read from the workspace",
  file_edit: "Change a file in the workspace",
  safe_shell: "Run a read-only command",
  shell: "Run a command in the workspace",
  destructive_shell: "Run a destructive command",
  external_read: "Read outside the workspace",
  external_write: "Change a file outside the workspace",
  mcp_write: "Run a tool that can change state",
};

export interface ToolApprovalRequest {
  readonly requestId: string;
  readonly toolName: string;
  readonly risk: ToolRisk;
  readonly scopeKey: string;
  readonly summary: string;
  readonly detail: string;
  readonly targetPath?: string;
  readonly command?: string;
}

/** The prompt shape the host renders; named `ToolApprovalPrompt` in the adapter contract. */
export type ToolApprovalPrompt = ToolApprovalRequest;

export interface ToolApprovalResponse {
  readonly decision: ProviderApprovalDecision;
  readonly feedback?: string;
}

export type PermissionDecision =
  | { readonly allowed: true; readonly risk: ToolRisk; readonly reason: string }
  | {
      readonly allowed: false;
      readonly risk: ToolRisk;
      readonly reason: string;
      readonly requestId?: string;
    };

export interface PermissionEngineOptions {
  readonly policy: ProviderAdapterV2RuntimePolicy;
  readonly sandbox: WorkspaceSandbox;
  readonly requestApproval: (
    request: ToolApprovalRequest,
    signal?: AbortSignal,
  ) => Promise<ToolApprovalResponse>;
  readonly isMcpReadOnly?: (toolName: string) => boolean;
  readonly newRequestId?: () => string;
}

const allow = (risk: ToolRisk, reason: string): PermissionDecision => ({
  allowed: true,
  risk,
  reason,
});

const deny = (risk: ToolRisk, reason: string, requestId?: string): PermissionDecision => ({
  allowed: false,
  risk,
  reason,
  ...(requestId === undefined ? {} : { requestId }),
});

const commandProgram = (command: string | undefined): string => {
  if (command === undefined) return "";
  const first = command.trim().split(/\s+/u)[0] ?? "";
  return first;
};

const describeFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class PermissionEngine {
  readonly #policy: ProviderAdapterV2RuntimePolicy;
  readonly #sandbox: WorkspaceSandbox;
  readonly #requestApproval: PermissionEngineOptions["requestApproval"];
  readonly #isMcpReadOnly: ((toolName: string) => boolean) | undefined;
  readonly #newRequestId: () => string;
  readonly #sessionGrants = new Set<string>();
  #requestCounter = 0;

  constructor(options: PermissionEngineOptions) {
    this.#policy = options.policy;
    this.#sandbox = options.sandbox;
    this.#requestApproval = options.requestApproval;
    this.#isMcpReadOnly = options.isMcpReadOnly;
    this.#newRequestId = options.newRequestId ?? (() => `approval-${++this.#requestCounter}`);
  }

  get effectiveRuntimeMode(): RuntimeMode {
    return clampRuntimeMode(this.#policy.runtimeMode, this.#policy.maxRuntimeMode);
  }

  get interactionMode(): ProviderAdapterV2RuntimePolicy["interactionMode"] {
    return this.#policy.interactionMode;
  }

  get runtimePolicy(): ProviderAdapterV2RuntimePolicy {
    return this.#policy;
  }

  #nextRequestId(): string {
    return this.#newRequestId();
  }

  isMcpReadOnly(toolName: string): boolean {
    return this.#isMcpReadOnly?.(toolName) === true;
  }

  async evaluate(
    toolName: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> {
    const targetPath = extractToolPath(args);
    const command = extractCommand(args);
    const isMcpTool = toolName.startsWith("mcp__");
    const mcpReadOnly = isMcpTool && this.isMcpReadOnly(toolName);

    let resolution: SandboxResolution | undefined;
    if (targetPath !== undefined) {
      try {
        resolution = await this.#sandbox.resolvePath(
          targetPath,
          toolName === "Write" || toolName === "Edit" ? "write" : "read",
        );
      } catch (error) {
        if (FILE_TOOL_NAMES.has(toolName)) {
          return deny("read", describeFailure(error));
        }
      }
    }

    if (resolution?.denied === true) {
      const risk = classifyToolRisk(toolName, args, resolution, { mcpReadOnly });
      return deny(risk, resolution.writeDeniedReason ?? `${resolution.resolvedPath} is read-only.`);
    }

    if (this.#policy.interactionMode === "plan") {
      if (PLAN_MODE_ALLOWED_TOOLS.has(toolName) || mcpReadOnly) {
        if (resolution?.classification !== "external") {
          return allow(
            "read",
            mcpReadOnly
              ? "Plan mode allows read-only MCP tools."
              : "Plan mode allows read-only tools.",
          );
        }
      } else {
        return deny(
          classifyToolRisk(toolName, args, resolution, { mcpReadOnly }),
          `Plan mode is read-only: ${toolName} cannot run until the plan is approved, and it was not sent for approval.`,
        );
      }
    }

    // Scratch writes cannot touch the project; the resolver still runs above.
    if ((toolName === "Write" || toolName === "Edit") && resolution?.classification === "scratch") {
      return allow("file_edit", "Session scratch files are outside the project.");
    }

    const readOnly = READ_ONLY_TOOL_NAMES.has(toolName) || mcpReadOnly;
    if (readOnly && resolution?.classification !== "external") {
      return allow("read", `${toolName} only reads within the workspace.`);
    }

    const risk = classifyToolRisk(toolName, args, resolution, { mcpReadOnly });
    const mode = this.effectiveRuntimeMode;

    if (mode === "full-access") {
      return allow(risk, "The session runs with full access.");
    }

    const autoAllowed =
      mode === "auto-accept-edits"
        ? risk === "file_edit" || risk === "safe_shell"
        : mode === "auto"
          ? risk === "file_edit" || risk === "safe_shell" || risk === "shell"
          : false;
    if (autoAllowed) {
      return allow(risk, `${mode} allows ${risk} without asking.`);
    }

    const scopeKey = `${risk}:${toolName}:${resolution?.resolvedPath ?? ""}:${risk === "shell" || risk === "safe_shell" || risk === "destructive_shell" ? commandProgram(command) : ""}`;
    if (this.#sessionGrants.has(scopeKey)) {
      return allow(risk, "The user accepted this for the rest of the session.");
    }

    const request: ToolApprovalRequest = {
      requestId: this.#nextRequestId(),
      toolName,
      risk,
      scopeKey,
      summary: RISK_SUMMARIES[risk],
      detail: [toolName, resolution?.resolvedPath ?? targetPath, command]
        .filter((part): part is string => part !== undefined && part !== "")
        .join(" - "),
      ...(resolution === undefined ? {} : { targetPath: resolution.resolvedPath }),
      ...(command === undefined ? {} : { command }),
    };

    if (signal?.aborted === true) {
      return deny(
        risk,
        "The approval request was cancelled before the user answered.",
        request.requestId,
      );
    }

    let response: ToolApprovalResponse;
    try {
      response = await this.#requestApproval(request, signal);
    } catch (error) {
      return deny(
        risk,
        `The approval request failed: ${describeFailure(error)}`,
        request.requestId,
      );
    }

    const feedback = response.feedback?.trim();
    const withFeedback = (base: string): string =>
      feedback === undefined || feedback === "" ? base : `${base} User feedback: ${feedback}`;

    switch (response.decision) {
      case "accept":
        return allow(risk, "The user approved this call.");
      case "acceptForSession":
      case "acceptAlways":
        this.#sessionGrants.add(scopeKey);
        return allow(risk, "The user approved this for the rest of the session.");
      case "decline":
        return deny(
          risk,
          withFeedback(`The user declined ${toolName}. Do not retry it without new instruction.`),
          request.requestId,
        );
      case "cancel":
        return deny(
          risk,
          withFeedback(`The user cancelled the approval request for ${toolName}.`),
          request.requestId,
        );
    }
  }
}
