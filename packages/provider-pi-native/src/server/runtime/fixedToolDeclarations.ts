// @effect-diagnostics nodeBuiltinImport:off -- The snapshot fingerprint is a SHA-256 digest of the declared catalog.
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
  getCurrentSystemMessage,
  toToolDeclaration,
  type Api,
  type Model,
  type SystemMessage,
} from "@earendil-works/pi-ai";
import * as NodeCrypto from "node:crypto";

import { computeContextBudget, estimateCjkAwareTextTokens } from "./contextBudget.ts";

/** The activation record rides at the end of the section that already describes tool usage. */
export const TOOL_ACTIVATION_SECTION = "tool_activation";

const ACTIVATION_VERSION = 1;
/** DeepSeek Chat Completions accepts at most 128 functions. Never truncate a catalog. */
const MAX_DECLARED_TOOLS = 128;
const SNAPSHOT_PATTERN = /^[a-f0-9]{64}$/u;

export interface ToolDeclarationPolicy {
  readonly key: string;
  /** Set only when the route can declare the whole catalog once and keep it stable. */
  readonly tools?: ReadonlyArray<AgentTool<any>>;
  readonly fallback?: "tool-count" | "context-budget";
}

export interface RestoredToolActivation {
  readonly active: ReadonlyArray<string>;
  readonly replayFrom: number;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Only the verified Flash route replays mid-conversation system updates without tool deltas. */
const supportsFixedDeclarations = (model: Model<Api>): boolean => {
  const compat = asRecord(model.compat);
  return (
    model.id === "deepseek-flash" &&
    model.api === "openai-completions" &&
    model.baseUrl.replace(/\/+$/u, "") === "https://api.deepseek.com" &&
    compat?.supportsMidConvoSystemMessages === true
  );
};

export const toolDeclarationPolicy = (
  model: Model<Api>,
  tools: ReadonlyArray<AgentTool<any>>,
  deferred: ReadonlySet<string>,
  prompt: string,
  accountId: string,
): ToolDeclarationPolicy => {
  const ordered = [...tools].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const key = NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        account: accountId,
        model: model.id,
        api: model.api,
        endpoint: model.baseUrl.replace(/\/+$/u, ""),
        tools: ordered.map(toToolDeclaration),
        deferred: [...deferred].sort(),
      }),
    )
    .digest("hex");
  if (!supportsFixedDeclarations(model)) return { key };
  if (ordered.length > MAX_DECLARED_TOOLS) return { key, fallback: "tool-count" };
  const budget = computeContextBudget(model);
  const declaredTokens =
    estimateCjkAwareTextTokens(prompt) +
    ordered.reduce(
      (total, tool) => total + estimateCjkAwareTextTokens(JSON.stringify(toToolDeclaration(tool))),
      0,
    );
  // A fixed catalog must not consume the headroom the conversation tail still needs.
  if (declaredTokens >= budget.warningThreshold) return { key, fallback: "context-budget" };
  return { key, tools: ordered };
};

export const toolActivationSection = (key: string, active: ReadonlySet<string>): string =>
  JSON.stringify({
    version: ACTIVATION_VERSION,
    snapshot: key,
    active: [...active].sort(),
  });

const parseActivationRecord = (
  section: string,
): { readonly snapshot: string; readonly active: ReadonlyArray<string> } | undefined => {
  const line = section.trimEnd().split("\n").at(-1)?.trim() ?? "";
  if (!line.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  if (record === undefined || record.version !== ACTIVATION_VERSION) return undefined;
  const snapshot = record.snapshot;
  if (typeof snapshot !== "string" || !SNAPSHOT_PATTERN.test(snapshot)) return undefined;
  const active = record.active;
  if (
    !Array.isArray(active) ||
    !active.every((name): name is string => typeof name === "string" && name !== "")
  ) {
    return undefined;
  }
  if (new Set(active).size !== active.length) return undefined;
  return { snapshot, active };
};

/**
 * A declaration is not activation. Malformed, unknown-version, and mismatched snapshots
 * fail closed, so a stale epoch can never resurrect tools the current catalog removed.
 */
export const restoredToolActivation = (
  messages: ReadonlyArray<AgentMessage>,
  key: string,
): RestoredToolActivation | undefined => {
  const section = getCurrentSystemMessage(messages)?.sections?.[TOOL_ACTIVATION_SECTION];
  if (section === undefined || section === null) return undefined;
  const closed: RestoredToolActivation = { active: [], replayFrom: messages.length };
  const record = parseActivationRecord(section);
  if (record === undefined || record.snapshot !== key) return closed;
  const lastState = messages
    .map(
      (message) =>
        message.role === "system" &&
        message.sections !== undefined &&
        TOOL_ACTIVATION_SECTION in message.sections,
    )
    .lastIndexOf(true);
  return { active: record.active, replayFrom: lastState + 1 };
};

/** Activation is appended after the result, never inserted into old instructions. */
export const syncToolActivation = (
  messages: AgentMessage[],
  delta: SystemMessage,
): AgentMessage[] => {
  const section = delta.sections?.[TOOL_ACTIVATION_SECTION];
  if (
    typeof section === "string" &&
    getCurrentSystemMessage(messages)?.sections?.[TOOL_ACTIVATION_SECTION] === section
  ) {
    return messages;
  }
  return [...messages, delta];
};
