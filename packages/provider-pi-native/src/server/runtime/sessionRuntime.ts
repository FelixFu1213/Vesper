import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type FinishTurn,
  type PrepareNextTurnContext,
  type PrepareRequest,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  contentText,
  isContextOverflow,
  isRecoverableLength,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type ImageContent,
  type Model,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type UserMessage,
} from "@earendil-works/pi-ai";
import type {
  ModelSelection,
  OrchestrationV2HistoricalMessage,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderGoal,
  OrchestrationV2ProviderRetry,
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2UserInputQuestion,
} from "@t3tools/contracts";
import { settingsSecretLiteral } from "@t3tools/contracts";
import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as DateTime from "effect/DateTime";

import type { PiNativeSettings } from "../../settings.ts";
import {
  buildCompactionCheckpoint,
  installCompactionCheckpoint,
  type CompactionCheckpoint,
  type CompactionMode,
  type CompactionSummarizeFn,
} from "./compaction.ts";
import {
  computeContextBudget,
  ContextEstimateCalibration,
  estimateAgentMessagesTokens,
  evaluateContextPressure,
} from "./contextBudget.ts";
import { NamedRegisters } from "./editEngine.ts";
import { FileSnapshotStore } from "./fileSnapshotStore.ts";
import { connectMcpSession, mcpReadOnlyPredicate, type McpAgentTool } from "./mcpBridge.ts";
import { MutationRecoveryTracker } from "./mutationRecovery.ts";
import { PathMutex } from "./pathLock.ts";
import {
  PermissionEngine,
  type ToolApprovalRequest,
  type ToolApprovalResponse,
} from "./permissions.ts";
import {
  createProviderStreamFn,
  ProviderHttpPool,
  resolvePiNativeModelBinding,
  type ResolvedModelBinding,
} from "./providerBinding.ts";
import {
  createProviderRetryStreamFn,
  type ProviderRetryLifecycleEvent,
  type ProviderRetrySleep,
} from "./providerRetry.ts";
import { WorkspaceSandbox } from "./sandbox.ts";
import { StreamDeltaCoalescer, type ScheduleTimer } from "./streamCoalescer.ts";
import { makeSubagentManager, type SubagentManager, type SubagentRecord } from "./subagent.ts";
import {
  buildT3SystemSections,
  SystemTranscriptManager,
  type SystemSectionMap,
} from "./systemTranscript.ts";
import {
  createPiNativeTools,
  EMPTY_TODO_SNAPSHOT,
  type ShellSpec,
  type TodoSnapshot,
} from "./tools.ts";
import { resolveBatchExecutionMode } from "./toolExecutionPolicy.ts";

const host = globalThis as unknown as {
  readonly Date: { now: () => number };
  readonly crypto: { readonly randomUUID: () => string };
};

const SILENT_TURN_NUDGE =
  "Your previous reply was empty. Continue the task and answer the user, or say plainly that you have nothing to add.";

const SUMMARY_SYSTEM_PROMPT =
  "You compress a coding conversation for another agent that must continue the work. Reply with exactly one <compaction_summary> block and nothing else.";

const SUMMARY_INSTRUCTION = [
  "Summarize the conversation below so another agent can continue it without the original messages.",
  "Reply with exactly this shape, filling every heading:",
  "<compaction_summary>",
  "## Goals",
  "## Progress",
  "## Files",
  "## Decisions",
  "## Next Steps",
  "</compaction_summary>",
  "Keep file paths, commands, identifiers, and open questions verbatim.",
].join("\n");

export type NativeSessionStreamKind = "assistant" | "reasoning";

export interface NativeSessionStreamUpdate {
  readonly type: "stream";
  readonly itemId: string;
  readonly kind: NativeSessionStreamKind;
  readonly text: string;
  readonly done: boolean;
}

export interface NativeSessionToolUpdate {
  readonly type: "tool";
  readonly itemId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly phase: "start" | "update" | "end";
  readonly output?: string | undefined;
  readonly result?: unknown;
  readonly isError?: boolean | undefined;
}

export interface NativeSessionPlanSubmitted {
  readonly type: "plan_submitted";
  readonly itemId: string;
  readonly markdown: string;
  readonly summary?: string | undefined;
}

export interface NativeSessionTodoUpdated {
  readonly type: "todo_updated";
  readonly itemId: string;
  readonly steps: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly status: "pending" | "running" | "completed";
  }>;
  readonly explanation?: string | undefined;
}

export interface NativeSessionCompactionUpdate {
  readonly type: "compaction";
  readonly itemId: string;
  readonly status: "running" | "completed" | "failed";
  readonly beforeTokenCount?: number | undefined;
  readonly afterTokenCount?: number | undefined;
  readonly summary?: string | undefined;
}

export interface NativeSessionSubagentUpdate {
  readonly type: "subagent";
  readonly record: SubagentRecord;
}

export interface NativeSessionSteerUpdate {
  readonly type: "steer";
  readonly messageId: string;
  readonly status: "completed" | "cancelled";
}

export interface NativeSessionRetryUpdate {
  readonly type: "retry";
  readonly event: ProviderRetryLifecycleEvent;
}

export interface NativeSessionUsageUpdate {
  readonly type: "usage";
  readonly usage: OrchestrationV2ProviderTurnTokenUsage;
}

export interface NativeSessionGoalUpdated {
  readonly type: "goal_updated";
  readonly goal: OrchestrationV2ProviderGoal | null;
}

export type NativeSessionEvent =
  | NativeSessionStreamUpdate
  | NativeSessionToolUpdate
  | NativeSessionPlanSubmitted
  | NativeSessionTodoUpdated
  | NativeSessionCompactionUpdate
  | NativeSessionSubagentUpdate
  | NativeSessionSteerUpdate
  | NativeSessionRetryUpdate
  | NativeSessionUsageUpdate
  | NativeSessionGoalUpdated;

/** T3 reports the goal banner from these, so the loop stops itself after this many checks. */
const DEFAULT_MAX_GOAL_CHECKS = 8;

export interface NativeSessionFailure {
  readonly failure: OrchestrationV2ProviderFailure;
  readonly retry: OrchestrationV2ProviderRetry | null;
  readonly retryStartedAtMs: number | null;
}

export interface NativeTurnOutcome {
  readonly status: "completed" | "interrupted" | "failed";
  readonly failure: NativeSessionFailure | null;
  readonly outputTruncated: boolean;
}

export interface NativeUserInputRequest {
  readonly itemId: string;
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  readonly signal?: AbortSignal | undefined;
}

export interface NativePiSessionRuntimeOptions {
  readonly settings: PiNativeSettings;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  /** A goal carried over from the adapter, so a recreated runtime keeps running it. */
  readonly initialGoal?: OrchestrationV2ProviderGoal | null | undefined;
  /** How many autonomous continuation checks one goal turn may run before it pauses. */
  readonly maxGoalChecks?: number | undefined;
  readonly threadId?: string | undefined;
  readonly mcpSession?: McpProviderSessionConfig | undefined;
  readonly contextText?: string | undefined;
  /** Roots the session may read but never write, such as the host's attachments folder. */
  readonly readOnlyRoots?: ReadonlyArray<string> | undefined;
  readonly onEvent: (event: NativeSessionEvent) => void;
  readonly requestApproval: (
    request: ToolApprovalRequest,
    signal?: AbortSignal,
  ) => Promise<ToolApprovalResponse>;
  readonly requestUserInput: (input: NativeUserInputRequest) => Promise<Record<string, unknown>>;
  readonly now?: (() => number) | undefined;
  readonly random?: (() => number) | undefined;
  readonly streamFn?: StreamFn | undefined;
  readonly sleep?: ProviderRetrySleep | undefined;
  readonly scheduleTimer?: ScheduleTimer | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly shell?: ShellSpec | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly calibration?: ContextEstimateCalibration | undefined;
}

export interface NativeSnapshotMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly reasoning: string;
  readonly timestamp: number;
}

export interface NativeSessionSnapshot {
  readonly messages: ReadonlyArray<NativeSnapshotMessage>;
  /** Index in `messages` where each user turn starts. */
  readonly turnBoundaries: ReadonlyArray<number>;
}

export interface NativeForkClone {
  readonly messages: ReadonlyArray<AgentMessage>;
  /** The learned estimate correction, shared so a fork keeps calibrating with its parent. */
  readonly calibration: ContextEstimateCalibration;
  readonly todos: TodoSnapshot;
}

export interface NativeManualCompactionResult {
  readonly beforeTokenCount: number;
  readonly afterTokenCount: number;
  readonly summary: string;
  readonly itemId: string;
}

interface StreamItemState {
  readonly itemId: string;
  readonly kind: NativeSessionStreamKind;
  readonly contentIndex: number;
  text: string;
  completed: boolean;
}

interface ActiveTurnState {
  readonly unreadSteers: Map<string, AgentMessage>;
  readonly streams: Map<string, StreamItemState>;
  readonly toolArgs: Map<string, unknown>;
  readonly toolNames: Map<string, string>;
  readonly toolOutput: Map<string, string>;
  messageIndex: number;
  itemSequence: number;
  preRequestRawEstimate: number | null;
  overflowRecoveryTried: boolean;
  silentTurnTried: boolean;
  manualCompactionRequested: string | null;
  pendingInstall: AgentMessage[] | null;
  pendingAppend: AgentMessage[];
  lastAssistant: AssistantMessage | null;
  retry: ProviderRetryLifecycleEvent | null;
  retryStartedAtMs: number | null;
  failure: NativeSessionFailure | null;
  interrupted: boolean;
  outputTruncated: boolean;
  planSubmittedThisTurn: boolean;
  goalChecksThisTurn: number;
}

const emptyUsage = (): AssistantMessage["usage"] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const isToolCall = (block: unknown): block is ToolCall =>
  typeof block === "object" &&
  block !== null &&
  (block as { readonly type?: unknown }).type === "toolCall";

const textOf = (content: ReadonlyArray<TextContent | ThinkingContent | ToolCall>): string =>
  contentText(content.filter((block): block is TextContent => block.type === "text"));

const asText = (value: unknown): string => {
  if (typeof value !== "object" || value === null) return "";
  const content = (value as { readonly content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks = content.filter(
    (block): block is TextContent =>
      typeof block === "object" &&
      block !== null &&
      (block as { readonly type?: unknown }).type === "text" &&
      typeof (block as { readonly text?: unknown }).text === "string",
  );
  return contentText(blocks);
};

const renderForSummary = (messages: readonly AgentMessage[]): string =>
  messages
    .map((message) => {
      switch (message.role) {
        case "user":
          return `User: ${
            typeof message.content === "string"
              ? message.content
              : contentText(message.content.filter((b): b is TextContent => b.type === "text"))
          }`;
        case "assistant":
          return [
            `Assistant: ${textOf(message.content)}`,
            ...(message.content.some(isToolCall)
              ? [
                  `Tool calls: ${message.content
                    .filter(isToolCall)
                    .map((call) => `${call.name}(${JSON.stringify(call.arguments)})`)
                    .join(", ")}`,
                ]
              : []),
          ].join("\n");
        case "toolResult":
          return `Tool result (${message.toolName}): ${contentText(
            message.content.filter((b): b is TextContent => b.type === "text"),
          ).slice(0, 4_000)}`;
        default:
          return "";
      }
    })
    .filter((line) => line !== "")
    .join("\n\n");

export interface ParsedCompactionSummary {
  readonly goals: string;
  readonly progress: string;
  readonly files: string;
  readonly decisions: string;
  readonly nextSteps: string;
}

/** Reads the five sections of a `<compaction_summary>` reply; throws when none is present. */
export function parseCompactionSummary(text: string): ParsedCompactionSummary {
  const body = /<compaction_summary>([\s\S]*?)<\/compaction_summary>/u.exec(text)?.[1] ?? text;
  const sections: Record<string, string[]> = {};
  let current: string[] | undefined;
  for (const line of body.split(/\r?\n/u)) {
    const heading = /^#{1,6}\s+(.+?)\s*$/u.exec(line.trim());
    if (heading !== null) {
      current = [];
      sections[(heading[1] ?? "").toLowerCase().replaceAll(/\s+/gu, " ")] = current;
      continue;
    }
    current?.push(line);
  }
  const read = (name: string): string => (sections[name] ?? []).join("\n").trim();
  const parsed: ParsedCompactionSummary = {
    goals: read("goals"),
    progress: read("progress"),
    files: read("files"),
    decisions: read("decisions"),
    nextSteps: read("next steps"),
  };
  if (Object.values(parsed).every((value) => value === "")) {
    throw new Error("The compaction summary had no recognizable sections.");
  }
  return parsed;
}

const splitUserTurns = (messages: readonly AgentMessage[]): AgentMessage[][] => {
  const turns: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) turns.push(current);
  return turns;
};

const isTodoStep = (value: unknown): value is TodoSnapshot["steps"][number] => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.trim() !== "" &&
    typeof record.text === "string" &&
    record.text.trim() !== "" &&
    (record.status === "pending" || record.status === "running" || record.status === "completed")
  );
};

const isTodoSnapshot = (value: unknown): value is TodoSnapshot => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.revision !== "number" ||
    !Number.isFinite(record.revision) ||
    record.revision < 0
  )
    return false;
  if (!Array.isArray(record.steps) || !record.steps.every(isTodoStep)) return false;
  return record.explanation === undefined || typeof record.explanation === "string";
};

const cloneTodoSnapshot = (snapshot: TodoSnapshot): TodoSnapshot => ({
  revision: snapshot.revision,
  steps: snapshot.steps.map((step) => ({ ...step })),
  ...(snapshot.explanation === undefined ? {} : { explanation: snapshot.explanation }),
});

const restoreTodosFromMessages = (messages: ReadonlyArray<AgentMessage>): TodoSnapshot => {
  let latest: TodoSnapshot = EMPTY_TODO_SNAPSHOT;
  for (const message of messages) {
    if (
      message.role !== "toolResult" ||
      message.toolName !== "TodoWrite" ||
      message.isError === true
    )
      continue;
    const details = (message as { readonly details?: unknown }).details;
    if (isTodoSnapshot(details)) {
      latest = cloneTodoSnapshot(details);
    }
  }
  return latest;
};

const formatGoalForSummary = (goal: OrchestrationV2ProviderGoal | null): string | undefined => {
  if (goal === null || (goal.status !== "active" && goal.status !== "paused")) return undefined;
  return [
    `Current goal (${goal.status}): ${goal.objective}`,
    ...(goal.lastCheck === undefined ? [] : [`Last check: ${goal.lastCheck}`]),
  ].join("\n");
};

const formatCurrentTodosForSummary = (snapshot: TodoSnapshot): string | undefined => {
  if (snapshot.steps.length === 0) return undefined;
  const lines = [`Current todo list (revision ${snapshot.revision}):`];
  if (snapshot.explanation !== undefined) {
    lines.push(`Explanation: ${snapshot.explanation}`);
  }
  for (const step of snapshot.steps) {
    lines.push(`- [${step.status}] (${step.id}) ${step.text}`);
  }
  return lines.join("\n");
};

const deepCloneMessages = (messages: ReadonlyArray<AgentMessage>): AgentMessage[] =>
  JSON.parse(JSON.stringify(messages)) as AgentMessage[];

const buildUserContent = (
  text: string,
  images: ReadonlyArray<ImageContent>,
): string | Array<TextContent | ImageContent> =>
  images.length === 0 ? text : [{ type: "text", text }, ...images];

const buildTokenUsage = (
  message: AssistantMessage,
  model: Model<Api>,
  nowMs: number,
): OrchestrationV2ProviderTurnTokenUsage => ({
  usedTokens:
    message.usage.input + message.usage.cacheRead + message.usage.cacheWrite + message.usage.output,
  maxTokens: model.contextWindow,
  inputTokens: message.usage.input,
  cachedInputTokens: message.usage.cacheRead,
  outputTokens: message.usage.output,
  updatedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
});

const makeFailure = (
  cause: unknown,
  retry: ProviderRetryLifecycleEvent | null,
): OrchestrationV2ProviderFailure => {
  if (retry !== null) return retry.failure;
  const message =
    typeof cause === "string"
      ? cause
      : cause instanceof Error
        ? cause.message
        : "The Pi Native turn failed.";
  return {
    class: "provider_error",
    message: message.trim() === "" ? "The Pi Native turn failed." : message.slice(0, 4_096),
    code: null,
    retryable: null,
  };
};

const newTurnState = (): ActiveTurnState => ({
  unreadSteers: new Map(),
  streams: new Map(),
  toolArgs: new Map(),
  toolNames: new Map(),
  toolOutput: new Map(),
  messageIndex: 0,
  itemSequence: 0,
  preRequestRawEstimate: null,
  overflowRecoveryTried: false,
  silentTurnTried: false,
  manualCompactionRequested: null,
  pendingInstall: null,
  pendingAppend: [],
  lastAssistant: null,
  retry: null,
  retryStartedAtMs: null,
  failure: null,
  interrupted: false,
  outputTruncated: false,
  planSubmittedThisTurn: false,
  goalChecksThisTurn: 0,
});

/**
 * One in-process Pi agent per native thread. It owns the transcript, tools, permissions,
 * retries, and compaction; the adapter above it only maps its events onto T3 contracts.
 */
export class NativePiSessionRuntime {
  readonly #options: NativePiSessionRuntimeOptions;
  readonly #agent: Agent;
  readonly #systemManager: SystemTranscriptManager;
  readonly #calibration: ContextEstimateCalibration;
  readonly #coalescer: StreamDeltaCoalescer<string>;
  readonly #pool: ProviderHttpPool;
  readonly #sandbox: WorkspaceSandbox;
  readonly #locks = new PathMutex();
  readonly #now: () => number;
  readonly #sessionId: string;
  readonly #unsubscribe: () => void;
  #anchors = new FileSnapshotStore();
  #registers = new NamedRegisters();
  #recovery = new MutationRecoveryTracker();
  #todos: TodoSnapshot = EMPTY_TODO_SNAPSHOT;
  #goal: OrchestrationV2ProviderGoal | null = null;
  #goalActiveStartedAtMs: number | null = null;
  #goalAccumulatedSeconds = 0;
  #workflowDirective: string | undefined;
  #permissions: PermissionEngine;
  #policy: ProviderAdapterV2RuntimePolicy;
  #binding: ResolvedModelBinding;
  #selection: ModelSelection;
  #baseStreamFn: StreamFn;
  #mcpTools: ReadonlyArray<McpAgentTool> = [];
  #mcpReadOnly: (toolName: string) => boolean = () => false;
  #mcpAvailable = false;
  #subagents: SubagentManager | null = null;
  #active: ActiveTurnState | null = null;
  #tailRace: Array<{ readonly messageId: string; readonly message: UserMessage }> = [];
  #abortPromise: Promise<void> | null = null;
  #disposed = false;
  #contextText: string | undefined;
  #sequence = 0;

  private constructor(options: NativePiSessionRuntimeOptions, binding: ResolvedModelBinding) {
    this.#options = options;
    this.#now = options.now ?? (() => host.Date.now());
    this.#sessionId =
      options.threadId !== undefined && options.threadId.trim() !== ""
        ? options.threadId.trim()
        : `pi-native-session-${host.crypto.randomUUID()}`;
    this.#binding = binding;
    this.#selection = options.modelSelection;
    this.#policy = options.runtimePolicy;
    this.#contextText = options.contextText;
    const initialGoal = options.initialGoal ?? null;
    this.#goal =
      initialGoal === null
        ? null
        : { ...initialGoal, timeUsedSeconds: initialGoal.timeUsedSeconds ?? 0 };
    this.#goalAccumulatedSeconds = initialGoal?.timeUsedSeconds ?? 0;
    // A goal carried over from a previous runtime resumes its clock only while already active.
    this.#goalActiveStartedAtMs = initialGoal?.status === "active" ? this.#now() : null;
    this.#calibration = options.calibration ?? new ContextEstimateCalibration();
    this.#pool = new ProviderHttpPool({ now: this.#now });
    this.#sandbox = new WorkspaceSandbox({
      cwd: options.runtimePolicy.cwd,
      extraRoots: options.runtimePolicy.workspace?.extraRoots ?? [],
      readOnlyRoots: options.readOnlyRoots ?? [],
    });
    this.#permissions = this.#makePermissions();
    this.#coalescer = new StreamDeltaCoalescer<string>({
      ...(options.scheduleTimer === undefined ? {} : { scheduleTimer: options.scheduleTimer }),
      onFlush: (key) => this.#flushKey(key),
    });
    this.#baseStreamFn = this.#makeBaseStreamFn();
    this.#systemManager = new SystemTranscriptManager({
      basePrompt: "",
      sections: this.#desiredSections(),
      timestamp: this.#now(),
    });
    const initialSystem = this.#systemManager.initialSystemMessage;
    this.#agent = new Agent({
      sessionId: this.#sessionId,
      initialState: {
        model: binding.model,
        thinkingLevel: binding.thinkingLevel ?? "off",
        tools: this.#buildToolList(),
        ...(initialSystem === undefined ? {} : { messages: [initialSystem] }),
      },
      streamFn: this.#makeRetryStreamFn(this.#baseStreamFn),
      beforeToolCall: this.#beforeToolCall,
      finishTurn: this.#finishTurn,
      prepareRequest: this.#prepareRequest,
      prepareNextTurnWithContext: this.#prepareNextTurn,
    });
    this.#unsubscribe = this.#agent.subscribe((event) => this.#handleAgentEvent(event));
  }

  static async create(options: NativePiSessionRuntimeOptions): Promise<NativePiSessionRuntime> {
    const runtime = new NativePiSessionRuntime(
      options,
      resolvePiNativeModelBinding(options.settings, options.modelSelection),
    );
    await runtime.#connectMcp();
    runtime.#rebuildTools();
    return runtime;
  }

  get model(): Model<Api> {
    return this.#binding.model;
  }

  get modelId(): string {
    return this.#binding.modelId;
  }

  get contextWindow(): number {
    return this.#binding.model.contextWindow;
  }

  get hasActiveTurn(): boolean {
    return this.#active !== null;
  }

  get messages(): ReadonlyArray<AgentMessage> {
    return this.#agent.state.messages;
  }

  get mcpAvailable(): boolean {
    return this.#mcpAvailable;
  }

  get subagents(): SubagentManager | null {
    return this.#subagents;
  }

  get todos(): TodoSnapshot {
    return cloneTodoSnapshot(this.#todos);
  }

  /** The goal with its elapsed active time folded in, so callers never see a stale clock. */
  get goal(): OrchestrationV2ProviderGoal | null {
    return this.#snapshotGoalWithElapsed();
  }

  /**
   * Replaces the goal and keeps the active clock honest across transitions: leaving
   * `"active"` banks the elapsed seconds and entering it starts a fresh stretch.
   */
  setGoal(
    goal: OrchestrationV2ProviderGoal | null,
    options?: { readonly emit?: boolean },
  ): OrchestrationV2ProviderGoal | null {
    const wasActive = this.#goal?.status === "active";
    if (wasActive && this.#goalActiveStartedAtMs !== null) {
      this.#goalAccumulatedSeconds += Math.max(
        0,
        Math.floor((this.#now() - this.#goalActiveStartedAtMs) / 1_000),
      );
      this.#goalActiveStartedAtMs = null;
    }
    if (goal !== null && !wasActive) {
      this.#goalAccumulatedSeconds = goal.timeUsedSeconds ?? 0;
    }
    if (goal?.status === "active") {
      this.#goalActiveStartedAtMs = this.#now();
    }
    this.#goal = goal === null ? null : { ...goal, timeUsedSeconds: this.#goalAccumulatedSeconds };
    const normalized = this.#snapshotGoalWithElapsed();
    if (options?.emit !== false) this.#emit({ type: "goal_updated", goal: normalized });
    return normalized;
  }

  #snapshotGoalWithElapsed(): OrchestrationV2ProviderGoal | null {
    if (this.#goal === null) return null;
    if (this.#goal.status !== "active" || this.#goalActiveStartedAtMs === null) return this.#goal;
    const elapsed = Math.max(0, Math.floor((this.#now() - this.#goalActiveStartedAtMs) / 1_000));
    return { ...this.#goal, timeUsedSeconds: this.#goalAccumulatedSeconds + elapsed };
  }

  tokenEstimate(): number {
    return estimateAgentMessagesTokens(this.#agent.state.messages);
  }

  contextBudget(): { readonly usedTokens: number; readonly maxTokens: number } {
    return {
      usedTokens: this.tokenEstimate(),
      maxTokens: computeContextBudget(this.#binding.model).contextWindow,
    };
  }

  #makePermissions(): PermissionEngine {
    return new PermissionEngine({
      policy: this.#policy,
      sandbox: this.#sandbox,
      requestApproval: this.#options.requestApproval,
      isMcpReadOnly: (toolName) => this.#mcpReadOnly(toolName),
      newRequestId: () => `pi-native-approval-${++this.#sequence}`,
    });
  }

  #makeBaseStreamFn(): StreamFn {
    return createProviderStreamFn({
      binding: this.#binding,
      sessionId: this.#sessionId,
      pool: this.#pool,
      now: this.#now,
      ...(this.#options.streamFn === undefined ? {} : { overrideStreamFn: this.#options.streamFn }),
    });
  }

  #makeRetryStreamFn(inner: StreamFn): StreamFn {
    return createProviderRetryStreamFn(inner, {
      infiniteRetry: this.#options.settings.infiniteRetry,
      now: this.#now,
      ...(this.#options.random === undefined ? {} : { random: this.#options.random }),
      ...(this.#options.sleep === undefined ? {} : { sleep: this.#options.sleep }),
      ...(this.#options.scheduleTimer === undefined
        ? {}
        : { scheduleTimer: this.#options.scheduleTimer }),
      onRetryEvent: (event) => this.#handleRetry(event),
      onConnectionPoolReset: () => {
        void this.#pool.rebuild(true);
      },
    });
  }

  #childStreamFn: StreamFn = (model, context, options) =>
    this.#agent.streamFunction(model, context, options);

  #toolDependencies(): Parameters<typeof createPiNativeTools>[0] {
    return {
      sandbox: this.#sandbox,
      anchors: this.#anchors,
      registers: this.#registers,
      recovery: this.#recovery,
      locks: this.#locks,
      requestUserInput: (questions, signal) =>
        this.#options.requestUserInput({
          itemId: `input:${++this.#sequence}`,
          questions,
          signal,
        }),
      onSubmitPlan: (submission) => {
        if (this.#active !== null) this.#active.planSubmittedThisTurn = true;
        this.#emit({
          type: "plan_submitted",
          itemId: `plan:${++this.#sequence}`,
          markdown: submission.markdown,
          ...(submission.summary === undefined ? {} : { summary: submission.summary }),
        });
      },
      onGoalStatusUpdate: (update) => {
        if (this.#goal === null) {
          return { ok: false, error: "No goal is currently active on this thread." };
        }
        if (this.#goal.status !== "active") {
          return {
            ok: false,
            error: `Cannot update goal status while goal is ${this.#goal.status}.`,
          };
        }
        const checks = (this.#goal.checks ?? 0) + 1;
        const snapshot = this.#snapshotGoalWithElapsed();
        if (snapshot !== null) {
          this.setGoal({
            ...snapshot,
            status: update.status,
            checks,
            lastCheck: update.summary,
          });
        }
        return { ok: true, message: `Goal marked ${update.status} (check ${checks}).` };
      },
      onTodoUpdate: (update) => {
        const snapshot: TodoSnapshot = {
          revision: this.#todos.revision + 1,
          steps: update.steps.map((step) => ({ ...step })),
          ...(update.explanation === undefined ? {} : { explanation: update.explanation }),
        };
        this.#todos = snapshot;
        this.#emit({
          type: "todo_updated",
          itemId: `todo:${++this.#sequence}`,
          steps: snapshot.steps,
          ...(snapshot.explanation === undefined ? {} : { explanation: snapshot.explanation }),
        });
        return cloneTodoSnapshot(snapshot);
      },
      readTodos: () => cloneTodoSnapshot(this.#todos),
      onRequestCompaction: (reason) => {
        if (this.#active !== null) this.#active.manualCompactionRequested = reason ?? "manual";
      },
      isPlanMode: () => this.#policy.interactionMode === "plan",
      ...(this.#options.threadId === undefined ? {} : { threadId: this.#options.threadId }),
      ...(this.#options.shell === undefined ? {} : { shell: this.#options.shell }),
      ...(this.#options.environment === undefined
        ? {}
        : { environment: this.#options.environment }),
      ...(this.#options.mcpSession === undefined ? {} : { mcpSession: this.#options.mcpSession }),
    };
  }

  #buildToolList(): AgentTool<any>[] {
    return [
      ...createPiNativeTools(this.#toolDependencies()),
      ...(this.#mcpTools as AgentTool<any>[]),
      ...(this.#subagents?.tools ?? []),
    ];
  }

  #rebuildTools(): void {
    this.#agent.state.tools = this.#buildToolList();
  }

  async #connectMcp(): Promise<void> {
    const config = this.#options.mcpSession;
    if (config === undefined) {
      this.#clearMcp();
      return;
    }
    const result = await connectMcpSession(config, {
      toolExposure: "eager",
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
    });
    // An unreachable T3 MCP server removes tools; it must never fail the turn.
    if (!result.available) {
      this.#clearMcp();
      return;
    }
    this.#mcpTools = result.tools;
    this.#mcpReadOnly = mcpReadOnlyPredicate(result.metadata);
    this.#mcpAvailable = true;
    this.#permissions = this.#makePermissions();
    this.#ensureSubagents();
  }

  #clearMcp(): void {
    this.#mcpTools = [];
    this.#mcpReadOnly = () => false;
    this.#mcpAvailable = false;
  }

  async refreshMcp(): Promise<void> {
    await this.#connectMcp();
    this.#ensureSubagents();
    this.#rebuildTools();
  }

  #ensureSubagents(): void {
    if (!this.#options.settings.enableSubagents || this.#subagents !== null) return;
    this.#subagents = makeSubagentManager({
      now: this.#now,
      ...(this.#options.sleep === undefined ? {} : { sleep: this.#options.sleep }),
      defaultModelId: this.#binding.modelId,
      getDefaultModelId: () => this.#binding.modelId,
      availableModels: () =>
        this.#options.settings.modelBindings
          .filter((binding) => binding.availableForSubagents === true)
          .map((binding) => ({
            id: binding.id,
            ...((binding.alias ?? binding.displayName) === undefined
              ? {}
              : { label: binding.alias?.trim() || binding.displayName?.trim() || binding.id }),
          })),
      onSubagentEvent: (record) => this.#emit({ type: "subagent", record }),
      childAgent: {
        defaultModel: this.#binding.model,
        getDefaultModel: () => this.#binding.model,
        parentSessionId: this.#sessionId,
        streamFn: this.#childStreamFn,
        ...(this.#binding.thinkingLevel === undefined || this.#binding.thinkingLevel === "off"
          ? {}
          : { thinkingLevel: this.#binding.thinkingLevel }),
        buildChildTools: () => {
          let childTodos: TodoSnapshot = EMPTY_TODO_SNAPSHOT;
          return createPiNativeTools({
            ...this.#toolDependencies(),
            onSubmitPlan: () => undefined,
            // Only the parent thread owns the goal, so children must not steer it.
            onGoalStatusUpdate: undefined,
            onTodoUpdate: (update) => {
              childTodos = {
                revision: childTodos.revision + 1,
                steps: update.steps.map((step) => ({ ...step })),
                ...(update.explanation === undefined ? {} : { explanation: update.explanation }),
              };
              return cloneTodoSnapshot(childTodos);
            },
            readTodos: () => cloneTodoSnapshot(childTodos),
            onRequestCompaction: () => undefined,
          }).concat(this.#mcpTools as AgentTool<any>[]);
        },
        resolveModel: (reference) =>
          resolvePiNativeModelBinding(this.#options.settings, {
            ...this.#selection,
            model: reference,
          }).model,
        getApiKey: () => {
          const key = settingsSecretLiteral(this.#options.settings.apiKey);
          return key === "" ? undefined : key;
        },
        // Child approvals route through the parent's engine so they reach the same callbacks.
        beforeToolCall: (context, signal) => this.#beforeToolCall(context, signal),
      },
    });
    this.#rebuildTools();
  }

  #desiredSections(contextBudget?: string): SystemSectionMap {
    const sections = buildT3SystemSections({
      harness: "Pi Native",
      model: this.#binding.modelId,
      modelName: this.#binding.model.name,
      ...(this.#binding.thinkingLevel === undefined
        ? {}
        : { reasoningEffort: this.#binding.thinkingLevel }),
      runtimePolicy: this.#policy,
      hasT3Mcp: this.#mcpAvailable,
      planMode: this.#policy.interactionMode === "plan",
      goal: this.#snapshotGoalWithElapsed(),
      ...(this.#workflowDirective === undefined
        ? {}
        : { workflowDirective: this.#workflowDirective }),
      ...(this.#contextText === undefined || this.#contextText === ""
        ? {}
        : { context: this.#contextText }),
      ...(contextBudget === undefined ? {} : { contextBudget }),
      toolActivation: this.#options.settings.enableSubagents
        ? "<tool_activation>Task, TaskWait, TaskList, and TaskStop delegate self-contained work to in-process subagents.</tool_activation>"
        : "",
    });
    return {
      ...sections,
      // Explicitly null out cleared tool_activation so SystemTranscriptManager emits a reset delta and re-arms future turns.
      tool_activation: sections.tool_activation ?? null,
    };
  }

  #contextBudgetSection(usedTokens: number, limit: number): string {
    return `<context_budget>About ${usedTokens} of ${limit} context tokens are in use. Summarize or compact before the limit.</context_budget>`;
  }

  #emit(event: NativeSessionEvent): void {
    this.#options.onEvent(event);
  }

  #flushKey(key: string): void {
    if (key.startsWith("tool:")) {
      const state = this.#active;
      const itemId = key.slice("tool:".length);
      const output = state?.toolOutput.get(itemId);
      if (state === null || state === undefined || output === undefined) return;
      this.#emit({
        type: "tool",
        itemId,
        toolName: state.toolNames.get(itemId) ?? "tool",
        args: state.toolArgs.get(itemId),
        phase: "update",
        output,
      });
      return;
    }
    const state = this.#active;
    const item = state?.streams.get(key);
    if (item === undefined || item.completed) return;
    this.#emit({
      type: "stream",
      itemId: item.itemId,
      kind: item.kind,
      text: item.text,
      done: false,
    });
  }

  #handleRetry(event: ProviderRetryLifecycleEvent): void {
    const state = this.#active;
    if (state !== null) {
      state.retry = event;
      if (event.status === "running") state.retryStartedAtMs = this.#now();
    }
    this.#emit({ type: "retry", event });
  }

  #handleAgentEvent(event: AgentEvent): void {
    const state = this.#active;
    if (state === null) return;
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") state.messageIndex += 1;
        return;
      case "message_update":
        if (event.message.role !== "assistant") return;
        this.#handleAssistantEvent(state, event.assistantMessageEvent);
        return;
      case "message_end":
        if (event.message.role === "assistant") this.#finishAssistantMessage(state, event.message);
        return;
      case "tool_execution_start":
        this.#startTool(state, event.toolCallId, event.toolName, event.args);
        return;
      case "tool_execution_update":
        this.#updateTool(state, event.toolCallId, event.partialResult);
        return;
      case "tool_execution_end":
        this.#endTool(state, event.toolCallId, event.toolName, event.result, event.isError);
        return;
      case "turn_end":
      case "agent_end":
        this.#coalescer.flushAll();
        return;
      default:
        return;
    }
  }

  #streamKey(state: ActiveTurnState, kind: NativeSessionStreamKind, contentIndex: number): string {
    return `${kind}:${state.messageIndex}:${contentIndex}`;
  }

  #streamItem(
    state: ActiveTurnState,
    key: string,
    kind: NativeSessionStreamKind,
    contentIndex: number,
  ): StreamItemState {
    const existing = state.streams.get(key);
    if (existing !== undefined) return existing;
    const created: StreamItemState = {
      itemId: `message:${++state.itemSequence}`,
      kind,
      contentIndex,
      text: "",
      completed: false,
    };
    state.streams.set(key, created);
    return created;
  }

  #handleAssistantEvent(state: ActiveTurnState, event: AssistantMessageEvent): void {
    switch (event.type) {
      case "text_delta": {
        const key = this.#streamKey(state, "assistant", event.contentIndex);
        this.#streamItem(state, key, "assistant", event.contentIndex).text += event.delta;
        this.#coalescer.push(key, event.delta);
        return;
      }
      case "thinking_delta": {
        const key = this.#streamKey(state, "reasoning", event.contentIndex);
        this.#streamItem(state, key, "reasoning", event.contentIndex).text += event.delta;
        this.#coalescer.push(key, event.delta);
        return;
      }
      case "text_end":
      case "thinking_end": {
        const kind = event.type === "text_end" ? "assistant" : "reasoning";
        const key = this.#streamKey(state, kind, event.contentIndex);
        const item = this.#streamItem(state, key, kind, event.contentIndex);
        item.text = event.content;
        this.#completeStreamItem(key, item);
        return;
      }
      default:
        return;
    }
  }

  #completeStreamItem(key: string, item: StreamItemState): void {
    if (item.completed) return;
    item.completed = true;
    this.#coalescer.flushKey(key);
    this.#emit({
      type: "stream",
      itemId: item.itemId,
      kind: item.kind,
      text: item.text,
      done: true,
    });
  }

  #finishAssistantMessage(state: ActiveTurnState, message: AssistantMessage): void {
    this.#coalescer.flushAll();
    state.lastAssistant = message;
    for (const [key, item] of state.streams) {
      if (item.completed) continue;
      const block = message.content[item.contentIndex];
      const text =
        block === undefined
          ? item.text
          : block.type === "text"
            ? block.text
            : block.type === "thinking"
              ? block.thinking
              : item.text;
      item.text = text;
      this.#completeStreamItem(key, item);
    }
    const promptTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
    if (state.preRequestRawEstimate !== null && promptTokens > 0) {
      this.#calibration.recordSample(state.preRequestRawEstimate, promptTokens);
    }
    if (promptTokens > 0) {
      this.#emit({
        type: "usage",
        usage: buildTokenUsage(message, this.#binding.model, this.#now()),
      });
    }
    this.#recordGoalUsage(message);
  }

  /** Active goals accumulate tokens and wall-clock time so `/goal` shows real progress. */
  #recordGoalUsage(message: AssistantMessage): void {
    if (this.#goal?.status !== "active") return;
    const snapshot = this.#snapshotGoalWithElapsed();
    if (snapshot === null) return;
    const messageTokens =
      message.usage.totalTokens > 0
        ? message.usage.totalTokens
        : message.usage.input +
          message.usage.output +
          message.usage.cacheRead +
          message.usage.cacheWrite;
    if (messageTokens === 0) return;
    // `setGoal` folds the elapsed seconds and re-emits, so no separate clock refresh is needed.
    this.setGoal({ ...snapshot, tokensUsed: (snapshot.tokensUsed ?? 0) + messageTokens });
  }

  #startTool(state: ActiveTurnState, toolCallId: string, toolName: string, args: unknown): void {
    this.#coalescer.flushAll();
    const itemId = `tool:${toolCallId}`;
    state.toolArgs.set(itemId, args);
    state.toolNames.set(itemId, toolName);
    this.#emit({ type: "tool", itemId, toolName, args, phase: "start" });
  }

  #updateTool(state: ActiveTurnState, toolCallId: string, partialResult: unknown): void {
    const itemId = `tool:${toolCallId}`;
    const output = asText(partialResult);
    if (output === "") return;
    state.toolOutput.set(itemId, output);
    this.#coalescer.push(`tool:${itemId}`, output);
  }

  #endTool(
    state: ActiveTurnState,
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
  ): void {
    const itemId = `tool:${toolCallId}`;
    this.#coalescer.flushKey(`tool:${itemId}`);
    const output = asText(result);
    state.toolOutput.delete(itemId);
    this.#emit({
      type: "tool",
      itemId,
      toolName,
      args: state.toolArgs.get(itemId),
      phase: "end",
      ...(output === "" ? {} : { output }),
      result,
      isError,
    });
  }

  #beforeToolCall = async (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined> => {
    const argumentsError = context.toolCall.argumentsError;
    if (argumentsError !== undefined) {
      return { block: true, reason: `Malformed tool arguments: ${argumentsError}` };
    }
    const batch = context.assistantMessage.content
      .filter(isToolCall)
      .map((call) => ({ name: call.name, arguments: call.arguments }));
    if (batch.length > 0) {
      this.#agent.toolExecution = resolveBatchExecutionMode(batch);
    }
    const decision = await this.#permissions.evaluate(context.toolCall.name, context.args, signal);
    if (!decision.allowed) return { block: true, reason: decision.reason };
    return undefined;
  };

  #prepareRequest: PrepareRequest = async (request) => {
    const state = this.#active;
    if (state === null) return undefined;
    const pressure = evaluateContextPressure(
      request.context.messages,
      request.model,
      this.#calibration,
    );
    state.preRequestRawEstimate = pressure.rawTokens;
    const budgetSection =
      pressure.warningLevel === "none"
        ? undefined
        : this.#contextBudgetSection(pressure.calibratedTokens, pressure.hardLimit);
    const delta = this.#systemManager.diffSections(
      this.#desiredSections(budgetSection),
      this.#now(),
    );
    let messages = request.context.messages;
    if (delta !== null) messages = [...messages, delta];
    this.#consumeSteers(messages);
    if (this.#options.settings.autoCompact && pressure.shouldCompact) {
      const compacted = await this.#compactWith("active_turn", undefined, messages);
      if (compacted !== null) {
        this.#agent.state.messages = compacted.messages;
        messages = compacted.messages;
      }
    }
    if (messages === request.context.messages) return undefined;
    return {
      context: {
        messages,
        ...(request.context.tools === undefined ? {} : { tools: request.context.tools }),
      },
      model: request.model,
    };
  };

  #finishTurn: FinishTurn = async (turn) => {
    const state = this.#active;
    if (state === null) return undefined;
    state.lastAssistant = turn.message;
    if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") {
      return undefined;
    }
    if (turn.message.stopReason === "length") state.outputTruncated = true;

    if (state.manualCompactionRequested !== null) {
      state.manualCompactionRequested = null;
      const compacted = await this.#compactWith("completed_turn", 1);
      if (compacted !== null) {
        state.pendingInstall = compacted.messages;
        return { action: "continue" };
      }
    }

    if (this.#shouldRecoverOverflow(turn.message, state)) {
      state.overflowRecoveryTried = true;
      // An overflowed request cannot be retried, so the whole turn folds into a summary.
      const compacted = await this.#compactWith("completed_turn", 0);
      if (compacted !== null) {
        state.pendingInstall = compacted.messages;
        state.pendingAppend = [
          {
            role: "user",
            content:
              "The conversation was compacted because the previous request exceeded the context window. Continue the task from the summary above.",
            timestamp: this.#now(),
          } satisfies UserMessage,
        ];
        return { action: "continue" };
      }
    }

    const silent =
      turn.message.stopReason === "stop" &&
      textOf(turn.message.content).trim() === "" &&
      !turn.message.content.some(isToolCall) &&
      !state.silentTurnTried;
    if (silent) {
      state.silentTurnTried = true;
      state.pendingAppend = [
        { role: "user", content: SILENT_TURN_NUDGE, timestamp: this.#now() } satisfies UserMessage,
      ];
      return { action: "continue" };
    }

    if (
      this.#goal === null ||
      this.#goal.status !== "active" ||
      this.#policy.interactionMode === "plan" ||
      state.planSubmittedThisTurn ||
      turn.message.stopReason !== "stop" ||
      turn.message.content.some(isToolCall)
    ) {
      return undefined;
    }
    const maxChecks = Math.max(1, this.#options.maxGoalChecks ?? DEFAULT_MAX_GOAL_CHECKS);
    if (state.goalChecksThisTurn < maxChecks) {
      state.goalChecksThisTurn += 1;
      const snapshot = this.#snapshotGoalWithElapsed();
      if (snapshot !== null) {
        this.setGoal({ ...snapshot, checks: (snapshot.checks ?? 0) + 1 });
      }
      state.pendingAppend = [
        {
          role: "user",
          content: [
            `Autonomous goal check ${state.goalChecksThisTurn}/${maxChecks} for objective: ${this.#goal.objective}`,
            'The turn ended while this goal is still active. Verify your work carefully against all criteria (run checks/tests if applicable). Continue working if anything remains, or call UpdateGoalStatus with status="complete" and a concise summary once verified done (or status="blocked" if blocked).',
          ].join("\n"),
          timestamp: this.#now(),
        } satisfies UserMessage,
      ];
      return { action: "continue" };
    }
    const snapshot = this.#snapshotGoalWithElapsed();
    if (snapshot !== null) {
      this.setGoal({
        ...snapshot,
        status: "budget_limited",
        lastCheck: `Paused after reaching the autonomous check limit (${maxChecks}). Send /goal resume to continue.`,
      });
    }
    return undefined;
  };

  #shouldRecoverOverflow(message: AssistantMessage, state: ActiveTurnState): boolean {
    if (!this.#options.settings.autoCompact || state.overflowRecoveryTried) return false;
    return (
      isContextOverflow(message, this.#binding.model.contextWindow) ||
      isRecoverableLength(message, this.#binding.model.maxTokens)
    );
  }

  #prepareNextTurn = (context: PrepareNextTurnContext) => {
    const state = this.#active;
    if (state === null) return undefined;
    const install = state.pendingInstall;
    state.pendingInstall = null;
    const append = state.pendingAppend;
    state.pendingAppend = [];
    if (install !== null) {
      this.#agent.state.messages = install;
      return {
        context: {
          messages: install,
          ...(context.context.tools === undefined ? {} : { tools: context.context.tools }),
        },
        ...(append.length === 0 ? {} : { messages: append }),
      };
    }
    return append.length === 0 ? undefined : { messages: append };
  };

  #makeSummarizeFn(): CompactionSummarizeFn {
    return async (request) => {
      const rendered = renderForSummary(request.messages);
      if (rendered.trim() === "") throw new Error("Nothing to summarize.");
      const todoSection = formatCurrentTodosForSummary(this.#todos);
      const goalSection = formatGoalForSummary(this.#snapshotGoalWithElapsed());
      const extras = [todoSection, goalSection].filter(
        (section): section is string => section !== undefined,
      );
      const transcript = extras.length === 0 ? rendered : `${rendered}\n\n${extras.join("\n\n")}`;
      const context = normalizeContext({
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `${SUMMARY_INSTRUCTION}\n\n---\n\n${transcript}`,
            timestamp: request.timestamp,
          },
        ],
        tools: [],
      });
      const stream = await this.#baseStreamFn(this.#binding.model, context, { maxRetries: 0 });
      let text = "";
      for await (const event of stream) {
        if (event.type === "done") text = contentText(event.message.content);
        else if (event.type === "error") {
          throw new Error(event.error.errorMessage ?? "The summary request failed.");
        }
      }
      return parseCompactionSummary(text);
    };
  }

  async #compactWith(
    mode: CompactionMode,
    pinnedRecentTurns?: number,
    sourceMessages?: ReadonlyArray<AgentMessage>,
  ): Promise<{
    readonly messages: AgentMessage[];
    readonly summarizedMessageCount: number;
  } | null> {
    const source = sourceMessages ?? this.#agent.state.messages;
    const itemId = `compaction:${++this.#sequence}`;
    const before = estimateAgentMessagesTokens(source);
    this.#emit({ type: "compaction", itemId, status: "running", beforeTokenCount: before });
    try {
      const checkpoint = await buildCompactionCheckpoint({
        messages: source,
        mode,
        model: this.#binding.model,
        timestamp: this.#now(),
        summarizeFn: this.#makeSummarizeFn(),
        pinnedRecentTurns: mode === "completed_turn" ? (pinnedRecentTurns ?? 1) : undefined,
      });
      const installed = installCompactionCheckpoint(source, checkpoint);
      const after = estimateAgentMessagesTokens(installed);
      this.#emit({
        type: "compaction",
        itemId,
        status: "completed",
        beforeTokenCount: before,
        afterTokenCount: after,
        summary: checkpoint.summary,
      });
      return { messages: installed, summarizedMessageCount: checkpoint.summarizedMessageCount };
    } catch {
      this.#emit({ type: "compaction", itemId, status: "failed", beforeTokenCount: before });
      return null;
    }
  }

  async compactManually(instructions?: string): Promise<NativeManualCompactionResult> {
    const before = this.tokenEstimate();
    const checkpoint: CompactionCheckpoint = await buildCompactionCheckpoint({
      messages: this.#agent.state.messages,
      mode: "completed_turn",
      model: this.#binding.model,
      timestamp: this.#now(),
      summarizeFn: this.#makeSummarizeFn(),
      pinnedRecentTurns: 1,
    });
    let installed = installCompactionCheckpoint(this.#agent.state.messages, checkpoint);
    if (instructions !== undefined && instructions.trim() !== "") {
      installed = [
        ...installed,
        {
          role: "user",
          content: `<compaction_instructions>${instructions.trim()}</compaction_instructions>`,
          timestamp: this.#now(),
        } satisfies UserMessage,
      ];
    }
    this.#agent.state.messages = installed;
    const itemId = `compaction:${++this.#sequence}`;
    const after = estimateAgentMessagesTokens(installed);
    this.#emit({
      type: "compaction",
      itemId,
      status: "completed",
      beforeTokenCount: before,
      afterTokenCount: after,
      summary: checkpoint.summary,
    });
    return {
      beforeTokenCount: before,
      afterTokenCount: after,
      summary: checkpoint.summary,
      itemId,
    };
  }

  #consumeSteers(messages: readonly AgentMessage[]): void {
    const state = this.#active;
    if (state === null || state.unreadSteers.size === 0) return;
    const present = new Set<AgentMessage>(messages);
    for (const [messageId, message] of state.unreadSteers) {
      if (!present.has(message)) continue;
      state.unreadSteers.delete(messageId);
      this.#emit({ type: "steer", messageId, status: "completed" });
    }
  }

  #cancelUnreadSteers(state: ActiveTurnState): void {
    for (const messageId of state.unreadSteers.keys()) {
      this.#emit({ type: "steer", messageId, status: "cancelled" });
    }
    state.unreadSteers.clear();
  }

  /** Returns "declined" when no turn is running, so the adapter can decline the steer. */
  steer(input: {
    readonly messageId: string;
    readonly text: string;
    readonly images?: ReadonlyArray<ImageContent> | undefined;
  }): "accepted" | "declined" {
    const state = this.#active;
    if (state === null) return "declined";
    const message: UserMessage = {
      role: "user",
      content: buildUserContent(input.text, input.images ?? []),
      timestamp: this.#now(),
    };
    // Steering unblocks TaskWait without cancelling the running subagents.
    this.#subagents?.interruptWaits();
    if (this.#agent.state.isStreaming) {
      state.unreadSteers.set(input.messageId, message);
      this.#agent.steer(message);
      return "accepted";
    }
    // The loop already decided to stop but the turn lock is still held: run one more turn.
    this.#tailRace.push({ messageId: input.messageId, message });
    return "accepted";
  }

  async runTurn(input: {
    readonly text: string;
    readonly images?: ReadonlyArray<ImageContent>;
    /** A one-turn system directive for a workflow command such as `/review`. */
    readonly workflowDirective?: string | undefined;
    /** `/boost` runs the turn at the highest thinking level the model accepts. */
    readonly boostThinking?: boolean | undefined;
    /** Test seam: runs in the window between loop settle and lock release. */
    readonly onLoopSettled?: () => void;
  }): Promise<NativeTurnOutcome> {
    if (this.#active !== null) throw new Error("A Pi Native turn is already running.");
    this.#ensureSubagents();
    const state = newTurnState();
    this.#active = state;
    this.#tailRace = [];
    this.#agent.clearAllQueues();
    // The goal clock measures active execution, not time spent idle between turns.
    if (this.#goal?.status === "active" && this.#goalActiveStartedAtMs === null) {
      this.#goalActiveStartedAtMs = this.#now();
    }
    const previousThinkingLevel = this.#agent.state.thinkingLevel;
    const elevateThinking =
      input.boostThinking === true &&
      this.#binding.model.reasoning === true &&
      (previousThinkingLevel === "off" ||
        previousThinkingLevel === "minimal" ||
        previousThinkingLevel === "low" ||
        previousThinkingLevel === "medium");
    if (elevateThinking) this.#agent.state.thinkingLevel = "high";
    this.#workflowDirective = input.workflowDirective;
    const prompt: UserMessage = {
      role: "user",
      content: buildUserContent(input.text, input.images ?? []),
      timestamp: this.#now(),
    };
    // `pi-agent-core` keeps the thinking level across turns, so a boost must not leak forward.
    try {
      await this.#agent.prompt(prompt);
      await this.#agent.waitForIdle();
      await this.#recoverErrorOverflow(state);
      input.onLoopSettled?.();
      for (;;) {
        const pending = this.#tailRace.splice(0);
        if (pending.length === 0) break;
        for (const entry of pending) {
          state.unreadSteers.set(entry.messageId, entry.message);
          this.#agent.steer(entry.message);
        }
        await this.#agent.continue();
        await this.#agent.waitForIdle();
      }
    } catch (cause) {
      state.failure = { failure: makeFailure(cause, null), retry: null, retryStartedAtMs: null };
    } finally {
      if (elevateThinking) this.#agent.state.thinkingLevel = previousThinkingLevel;
      this.#workflowDirective = undefined;
    }
    this.#coalescer.flushAll();
    this.#cancelUnreadSteers(state);
    this.#active = null;
    const outcome = this.#outcome(state);
    if (outcome.status === "interrupted" && this.#goal?.status === "active") {
      const snapshot = this.#snapshotGoalWithElapsed();
      if (snapshot !== null) this.setGoal({ ...snapshot, status: "paused" });
    }
    return outcome;
  }

  /**
   * `pi-agent-core` hard-exits the loop on `stopReason: "error"`, so an overflow reported
   * as an error can only be recovered after `prompt()` returns: fold, then resume once.
   */
  async #recoverErrorOverflow(state: ActiveTurnState): Promise<void> {
    const failed = state.lastAssistant;
    if (state.interrupted || failed?.stopReason !== "error") return;
    if (!this.#shouldRecoverOverflow(failed, state)) return;
    state.overflowRecoveryTried = true;
    const messages = this.#agent.state.messages;
    const source = messages.filter(
      (message, index) =>
        index !== messages.length - 1 ||
        message.role !== "assistant" ||
        message.stopReason !== "error",
    );
    // `active_turn` keeps the current turn verbatim, which is exactly the turn that overflowed.
    const active = await this.#compactWith("active_turn", undefined, source);
    const compacted =
      active === null ||
      active.summarizedMessageCount === 0 ||
      estimateAgentMessagesTokens(active.messages) >= estimateAgentMessagesTokens(source)
        ? ((await this.#compactWith("completed_turn", 0, source)) ?? active)
        : active;
    if (compacted === null) return;
    const resume: UserMessage = {
      role: "user",
      content:
        "The conversation was compacted because the previous request exceeded the context window. Continue the task from the summary above.",
      timestamp: this.#now(),
    };
    // `continue()` needs a user or tool result last, and a full compaction leaves only the system prompt.
    const last = compacted.messages.at(-1);
    this.#agent.state.messages =
      last === undefined || last.role === "system" || last.role === "assistant"
        ? [...compacted.messages, resume]
        : compacted.messages;
    state.lastAssistant = null;
    state.failure = null;
    state.retry = null;
    state.retryStartedAtMs = null;
    await this.#agent.continue();
    await this.#agent.waitForIdle();
  }

  #outcome(state: ActiveTurnState): NativeTurnOutcome {
    const message = state.lastAssistant;
    if (state.interrupted || message?.stopReason === "aborted") {
      return { status: "interrupted", failure: null, outputTruncated: false };
    }
    if (state.failure !== null) {
      return { status: "failed", failure: state.failure, outputTruncated: state.outputTruncated };
    }
    if (message?.stopReason === "error") {
      const failed = state.retry !== null && state.retry.status === "failed" ? state.retry : null;
      return {
        status: "failed",
        failure: {
          failure: failed?.failure ?? makeFailure(message.errorMessage, null),
          retry:
            failed === null
              ? null
              : {
                  attempt: failed.attempt,
                  maxAttempts: failed.maxAttempts,
                  retryDelayMs: failed.delayMs,
                },
          retryStartedAtMs: state.retryStartedAtMs,
        },
        outputTruncated: state.outputTruncated,
      };
    }
    return {
      status: "completed",
      failure: null,
      outputTruncated: state.outputTruncated || message?.stopReason === "length",
    };
  }

  abort(): Promise<void> {
    this.#abortPromise ??= this.#abort().finally(() => {
      this.#abortPromise = null;
    });
    return this.#abortPromise;
  }

  async #abort(): Promise<void> {
    const state = this.#active;
    if (state === null) return;
    state.interrupted = true;
    this.#agent.abort();
    this.#coalescer.flushAll();
    this.#cancelUnreadSteers(state);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.abort();
    await this.#subagents?.stopAll("interrupted");
    this.#unsubscribe();
    this.#coalescer.dispose();
    this.#pool.close();
  }

  applyModelSelection(selection: ModelSelection): ResolvedModelBinding {
    const binding = resolvePiNativeModelBinding(this.#options.settings, selection);
    this.#selection = selection;
    this.#binding = binding;
    this.#agent.state.model = binding.model;
    this.#agent.state.thinkingLevel = binding.thinkingLevel ?? "off";
    this.#baseStreamFn = this.#makeBaseStreamFn();
    this.#agent.streamFunction = this.#makeRetryStreamFn(this.#baseStreamFn);
    // The Task tool advertises the parent's allowed models, and a new binding
    // can change both the child default and the prompt sections.
    this.#rebuildTools();
    return binding;
  }

  applyRuntimePolicy(policy: ProviderAdapterV2RuntimePolicy): void {
    this.#policy = policy;
    this.#permissions = this.#makePermissions();
  }

  /** App threads can hand over new model context between turns; sections re-diff on the next request. */
  applyContextText(contextText: string): void {
    this.#contextText = contextText;
  }

  #leadingSystem(): AgentMessage | undefined {
    return this.#systemManager.initialSystemMessage;
  }

  #clearTrackers(): void {
    this.#anchors = new FileSnapshotStore();
    this.#registers = new NamedRegisters();
    this.#recovery = new MutationRecoveryTracker();
  }

  rehydrateFromHistory(
    messages: ReadonlyArray<OrchestrationV2HistoricalMessage>,
    contextText?: string,
  ): void {
    const model = this.#binding.model;
    const timestamp = this.#now();
    const converted: AgentMessage[] = [];
    if (contextText !== undefined && contextText.trim() !== "") {
      converted.push({ role: "user", content: contextText, timestamp });
    }
    for (const message of messages) {
      if (message.role === "user") {
        converted.push({ role: "user", content: message.text, timestamp });
        continue;
      }
      if (message.text.trim() === "") continue;
      converted.push({
        role: "assistant",
        content: [{ type: "text", text: message.text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp,
      } satisfies AssistantMessage);
    }
    const leading = this.#leadingSystem();
    this.#agent.state.messages = leading === undefined ? converted : [leading, ...converted];
    this.#todos = EMPTY_TODO_SNAPSHOT;
    this.#clearTrackers();
    this.#rebuildTools();
  }

  truncateToTurn(targetTurnCount: number): void {
    const leading = this.#leadingSystem();
    const turns = splitUserTurns(
      this.#agent.state.messages.filter((message) => message.role !== "system"),
    );
    const kept = turns.slice(0, Math.max(0, targetTurnCount)).flat();
    this.#agent.state.messages = leading === undefined ? kept : [leading, ...kept];
    this.#todos = restoreTodosFromMessages(kept);
    this.#clearTrackers();
    this.#rebuildTools();
  }

  cloneForFork(targetTurnCount?: number): NativeForkClone {
    const leading = this.#leadingSystem();
    const nonSystem = this.#agent.state.messages.filter((message) => message.role !== "system");
    const turns = splitUserTurns(nonSystem);
    const kept =
      targetTurnCount === undefined
        ? nonSystem
        : turns.slice(0, Math.max(0, targetTurnCount)).flat();
    return {
      messages: deepCloneMessages(leading === undefined ? kept : [leading, ...kept]),
      calibration: this.#calibration,
      todos:
        targetTurnCount === undefined
          ? cloneTodoSnapshot(this.#todos)
          : restoreTodosFromMessages(kept),
    };
  }

  installMessages(
    messages: ReadonlyArray<AgentMessage>,
    contextText?: string,
    todos?: TodoSnapshot,
  ): void {
    this.#agent.state.messages = deepCloneMessages(messages);
    this.#todos =
      todos === undefined ? restoreTodosFromMessages(messages) : cloneTodoSnapshot(todos);
    if (contextText !== undefined && contextText.trim() !== "") {
      this.#contextText = contextText;
    }
  }

  getSnapshot(): NativeSessionSnapshot {
    const messages: NativeSnapshotMessage[] = [];
    const turnBoundaries: number[] = [];
    for (const message of this.#agent.state.messages) {
      if (message.role === "system") continue;
      if (message.role === "user") {
        turnBoundaries.push(messages.length);
        messages.push({
          role: "user",
          text:
            typeof message.content === "string"
              ? message.content
              : contentText(message.content.filter((b): b is TextContent => b.type === "text")),
          reasoning: "",
          timestamp: message.timestamp,
        });
        continue;
      }
      if (message.role !== "assistant") continue;
      const text = textOf(message.content);
      const reasoning = message.content
        .filter((block): block is ThinkingContent => block.type === "thinking")
        .map((block) => block.thinking)
        .join("\n");
      if (text.trim() === "" && reasoning.trim() === "") continue;
      messages.push({ role: "assistant", text, reasoning, timestamp: message.timestamp });
    }
    return { messages, turnBoundaries };
  }
}
