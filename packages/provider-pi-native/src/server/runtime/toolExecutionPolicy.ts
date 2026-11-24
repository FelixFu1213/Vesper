// @effect-diagnostics nodeBuiltinImport:off -- Batch policy compares synchronous path spellings.
import * as NodePath from "node:path";

export type BatchExecutionMode = "parallel" | "sequential";

export interface BatchToolCall {
  readonly name: string;
  readonly arguments: unknown;
}

const ALWAYS_SEQUENTIAL: ReadonlySet<string> = new Set([
  "Bash",
  "asktool",
  "SubmitPlan",
  "TodoWrite",
  "new_context",
]);

const MUTATING_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit"]);

const PATH_KEYS = ["path", "filePath", "file_path"] as const;

const resolveTarget = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return NodePath.normalize(value.trim());
    }
  }
  return undefined;
};

/** Same-path writes must not interleave; everything else may run at the same time. */
export const resolveBatchExecutionMode = (
  toolCalls: ReadonlyArray<BatchToolCall>,
): BatchExecutionMode => {
  if (toolCalls.some((call) => ALWAYS_SEQUENTIAL.has(call.name))) return "sequential";

  const mutating = toolCalls.filter((call) => MUTATING_TOOLS.has(call.name));
  if (mutating.length === 0) return "parallel";

  if (toolCalls.some((call) => call.name === "Task")) return "sequential";
  if (mutating.length < 2) return "parallel";

  const targets = mutating.map((call) => resolveTarget(call.arguments));
  if (targets.some((target) => target === undefined)) return "sequential";
  const distinct = new Set(targets);
  return distinct.size === targets.length ? "parallel" : "sequential";
};
