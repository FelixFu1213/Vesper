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
import type {
  ProviderAdapterV2RuntimePolicy,
  ProviderAdapterV2TurnPhase,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { PiNativeSettings } from "../../settings.ts";
import { piNativeSkillMentions } from "../commands.ts";
import {
  buildCompactionCheckpoint,
  CompactionBudgetError,
  installCompactionCheckpoint,
  type CompactionCheckpoint,
  type CompactionMode,
  type CompactionSummarizeFn,
} from "./compaction.ts";
import { compactionRequestOptions } from "./compactionRequest.ts";
import { ContextEstimateCalibration } from "./contextCalibration.ts";
import {
  computeContextBudget,
  ContextBudgetReminderTracker,
  estimateAgentMessagesTokens,
  evaluateContextPressure,
  projectContextRequest,
  supportsMidConversationSystemMessages,
  type ContextProjection,
  type ContextRequestTool,
} from "./contextBudget.ts";
import { BackgroundJobManager, type BackgroundJobSnapshot } from "./backgroundJobs.ts";
import { loadCustomSystemPrompt, type CustomSystemPrompt } from "./customSystemPrompt.ts";
import { DeferredToolRegistry } from "./deferredTools.ts";
import { NamedRegisters } from "./editEngine.ts";
import { FileSnapshotStore } from "./fileSnapshotStore.ts";
import {
  syncToolActivation,
  toolActivationSection,
  toolDeclarationPolicy,
} from "./fixedToolDeclarations.ts";
import { createJobToolRouting, type JobToolRouting } from "./jobToolRouting.ts";
import {
  connectMcpSession,
  mcpReadOnlyPredicate,
  type McpAgentTool,
  type McpConnectResult,
} from "./mcpBridge.ts";
import { MutationRecoveryTracker } from "./mutationRecovery.ts";
import { PathMutex } from "./pathLock.ts";
import {
  PermissionEngine,
  type ToolApprovalRequest,
  type ToolApprovalResponse,
} from "./permissions.ts";
import { ProjectInstructionTracker, renderProjectInstructions } from "./projectInstructions.ts";
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
import type {
  PersistedCompactionCheckpoint,
  PersistedTranscriptRecord,
  PiNativeSessionStoreService,
} from "./sessionStore.ts";
import {
  probeLoginShellPath,
  resolveTurnShell,
  SessionScratchDir,
  type TurnShell,
} from "./shellCatalog.ts";
import {
  discoverPiNativeSkills,
  piNativeSkillsDigest,
  piNativeSkillsPromptSections,
  type DiscoverPiNativeSkillsInput,
  type PiNativeSkillDef,
  type PiNativeSkillDiscovery,
} from "./skillsDiscovery.ts";
import { formatPiNativeSkillContent, loadPiNativeSkill } from "./skillTool.ts";
import { StreamDeltaCoalescer, type ScheduleTimer } from "./streamCoalescer.ts";
import { makeSubagentManager, type SubagentManager, type SubagentRecord } from "./subagent.ts";
import {
  buildT3SystemSections,
  SystemTranscriptManager,
  type SystemSectionMap,
} from "./systemTranscript.ts";
import { projectMemoryPrompt } from "./projectMemoryPrompt.ts";
import { serializeSystemMessage, SystemTranscriptJournal } from "./systemTranscriptJournal.ts";
import {
  createPiNativeTools,
  EMPTY_TODO_SNAPSHOT,
  type ShellSpec,
  type TodoSnapshot,
} from "./tools.ts";
import { resolveBatchExecutionMode } from "./toolExecutionPolicy.ts";
import { restoreTodosFromMessages, restoreTranscript } from "./transcriptRecovery.ts";

const host = globalThis as unknown as {
  readonly Date: { now: () => number };
  readonly crypto: { readonly randomUUID: () => string };
};

const SILENT_TURN_NUDGE =
  "Your previous reply was empty. Continue the task and answer the user, or say plainly that you have nothing to add.";

const PROGRESS_ONLY_PLAN_NUDGE =
  "Your previous reply only announced the next step and stopped. Carry it out now, then submit the plan with SubmitPlan when it is ready.";

const PROGRESS_ONLY_GOAL_NUDGE =
  "Your previous reply only announced the next step and stopped. Carry it out now, or call UpdateGoalStatus once the work is verified done.";

/** A progress update is short; a long report is a final answer even if it mentions next steps. */
const PROGRESS_ONLY_MAX_CHARS = 400;

const PROGRESS_FORWARD_INTENT =
  /\b(?:let me|let's|i'?ll|i will|i'?m going to|going to|about to|next(?:,| up| i'?ll)|still (?:need|have) to|remaining|left to|working on|writing|reading|updating|implementing|checking|running|creating|fixing|reviewing|proceeding|continuing|starting)\b/iu;

/** A reply that opens by claiming the work is done; only a later forward clause makes it progress. */
const PROGRESS_TERMINAL_LEAD =
  /^(?:done|all done|complete(?:d)?|finished|implemented|resolved|verified|successful(?:ly)?|the (?:approved )?(?:plan|goal) is (?:complete|done))\b/iu;

/**
 * Visible text that only announces work it has not done yet: plan and goal continuation use it to
 * ask once more instead of ending a turn on a promise. A final answer, a tool call, or a
 * structured report never qualifies.
 */
export function isProgressOnlyAssistantTurn(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > PROGRESS_ONLY_MAX_CHARS) return false;
  if (/^#{1,6}\s/mu.test(trimmed)) return false;
  if (trimmed.endsWith(":")) return true;
  if (!PROGRESS_FORWARD_INTENT.test(trimmed)) return false;
  if (!PROGRESS_TERMINAL_LEAD.test(trimmed)) return true;
  // A report can name a finished step and still announce the next one.
  return PROGRESS_FORWARD_INTENT.test(trimmed.replace(PROGRESS_TERMINAL_LEAD, ""));
}

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
  /** Why summarization was abandoned and a retained tail installed instead. */
  readonly failureReason?: string | undefined;
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

export interface NativeSessionPhaseUpdate {
  readonly type: "phase";
  readonly phase: ProviderAdapterV2TurnPhase;
  readonly detail?: string | undefined;
}

export interface NativeSessionBackgroundJobUpdate {
  readonly type: "background_job";
  readonly snapshot: BackgroundJobSnapshot;
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
  | NativeSessionGoalUpdated
  | NativeSessionPhaseUpdate
  | NativeSessionBackgroundJobUpdate;

/** T3 reports the goal banner from these, so the loop stops itself after this many checks. */
const DEFAULT_MAX_GOAL_CHECKS = 8;

/** Discovers the workspace catalog, or nothing when the session has no workspace folder. */
const discoverSkillCatalog = async (
  options: NativePiSessionRuntimeOptions,
): Promise<ReadonlyArray<PiNativeSkillDef>> => {
  const cwd = options.runtimePolicy.cwd;
  const discover = options.discoverSkills;
  // Without a workspace folder only an injected catalog still applies.
  if (discover === undefined && (cwd === null || cwd.trim() === "")) return [];
  try {
    const discovery = await (discover ?? discoverPiNativeSkills)({
      cwd: cwd === null || cwd.trim() === "" ? process.cwd() : cwd,
      environment: options.environment ?? process.env,
    });
    return discovery.skills;
  } catch {
    // A broken catalog must never fail the turn; the session keeps the skills it had.
    return [];
  }
};

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
  /** Durable user-authored notes for the project, rendered after app context. */
  readonly projectMemory?: string | undefined;
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
  /** Overrides `~/.pi/agent`, where the global `AGENTS.md` and `SYSTEM.md` files live. */
  readonly piAgentDir?: string | undefined;
  readonly streamFn?: StreamFn | undefined;
  readonly sleep?: ProviderRetrySleep | undefined;
  readonly scheduleTimer?: ScheduleTimer | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly shell?: ShellSpec | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  /** Test seam for the Unix login-shell PATH probe; defaults to the real, cached probe. */
  readonly loginShellPath?: (() => Promise<string | null>) | undefined;
  readonly calibration?: ContextEstimateCalibration | undefined;
  /** Durable transcript owner; optional so adapter tests run without a database. */
  readonly sessionStore?: PiNativeSessionStoreService | undefined;
  readonly providerThreadId?: string | undefined;
  /** Discovery seam: tests inject a fixed catalog instead of walking the real filesystem. */
  readonly discoverSkills?:
    | ((input: DiscoverPiNativeSkillsInput) => Promise<PiNativeSkillDiscovery>)
    | undefined;
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
  /** Bumped when a consumed steer must start a fresh assistant bubble. */
  streamEpoch: number;
  steeringSplitPending: boolean;
  itemSequence: number;
  /** The full-request projection the pending request was gated on. */
  preRequest: ContextProjection | null;
  overflowRecoveryTried: boolean;
  silentTurnTried: boolean;
  progressOnlyTried: boolean;
  gracefulStopRequested: boolean;
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

const isCompactionBudgetError = Schema.is(CompactionBudgetError);

/** The request-visible shape of an executable tool, for the budget estimate. */
const contextRequestTools = (
  tools: ReadonlyArray<AgentTool<any>> | undefined,
): ReadonlyArray<ContextRequestTool> =>
  (tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

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

const cloneTodoSnapshot = (snapshot: TodoSnapshot): TodoSnapshot => ({
  revision: snapshot.revision,
  steps: snapshot.steps.map((step) => ({ ...step })),
  ...(snapshot.explanation === undefined ? {} : { explanation: snapshot.explanation }),
});

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
  streamEpoch: 0,
  steeringSplitPending: false,
  itemSequence: 0,
  preRequest: null,
  overflowRecoveryTried: false,
  silentTurnTried: false,
  progressOnlyTried: false,
  gracefulStopRequested: false,
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

/** The instructions a tool run may widen; only file tools can reveal nested rules. */
const PATH_SCOPED_INSTRUCTION_TOOLS: ReadonlySet<string> = new Set(["Read", "Write", "Edit"]);

/** Project instructions and prompts are scoped to the thread's main folder. */
function instructionWorkspaceRoot(policy: ProviderAdapterV2RuntimePolicy): string | null {
  const cwd = policy.cwd?.trim();
  if (cwd !== undefined && cwd !== "") return cwd;
  return policy.workspace?.folders[0]?.path ?? null;
}

interface ResolvedSessionPrompts {
  readonly customPrompt: CustomSystemPrompt | undefined;
  readonly instructions: ProjectInstructionTracker;
}

/**
 * One in-process Pi agent per native thread. It owns the transcript, tools, permissions,
 * retries, and compaction; the adapter above it only maps its events onto T3 contracts.
 */
export class NativePiSessionRuntime {
  readonly #options: NativePiSessionRuntimeOptions;
  readonly #agent: Agent;
  readonly #systemManager: SystemTranscriptManager;
  readonly #calibration: ContextEstimateCalibration;
  readonly #reminders = new ContextBudgetReminderTracker();
  readonly #coalescer: StreamDeltaCoalescer<string>;
  readonly #pool: ProviderHttpPool;
  readonly #sandbox: WorkspaceSandbox;
  readonly #backgroundJobs: BackgroundJobManager;
  readonly #scratch: SessionScratchDir;
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
  #mcpSession: McpConnectResult | undefined;
  #mcpReadOnly: (toolName: string) => boolean = () => false;
  #mcpAvailable = false;
  readonly #registry: DeferredToolRegistry;
  #fixedDeclarationKey: string | null = null;
  #skills: ReadonlyArray<PiNativeSkillDef>;
  #subagents: SubagentManager | null = null;
  #jobRouting: JobToolRouting | null = null;
  #loginShellPathPromise: Promise<string | null> | null = null;
  #turnShell: TurnShell | null = null;
  #backgroundNotes: Array<string> = [];
  #active: ActiveTurnState | null = null;
  #phase: {
    readonly phase: ProviderAdapterV2TurnPhase;
    readonly detail?: string | undefined;
  } | null = null;
  #tailRace: Array<{ readonly messageId: string; readonly message: UserMessage }> = [];
  #abortPromise: Promise<void> | null = null;
  #disposed = false;
  #contextText: string | undefined;
  #projectMemory: string | undefined;
  readonly #instructions: ProjectInstructionTracker;
  readonly #customAppend: string | undefined;
  #sequence = 0;
  readonly #store: PiNativeSessionStoreService | null;
  readonly #persistenceKey: string;
  readonly #journal = new SystemTranscriptJournal();
  readonly #recordIds = new WeakMap<AgentMessage, string>();
  #restoredMessages = new WeakSet<AgentMessage>();
  #recordSequence = 0;
  #turnCursor = 0;
  #lastRecordId: string | null = null;
  #writeTail: Promise<void> = Promise.resolve();
  #restoredTranscript = false;
  #hydrating: Promise<boolean> | null = null;

  private constructor(
    options: NativePiSessionRuntimeOptions,
    binding: ResolvedModelBinding,
    skills: ReadonlyArray<PiNativeSkillDef>,
    prompts: ResolvedSessionPrompts,
  ) {
    this.#options = options;
    this.#skills = skills;
    this.#now = options.now ?? (() => host.Date.now());
    this.#store = options.sessionStore ?? null;
    this.#persistenceKey = options.providerThreadId?.trim() || "";
    this.#sessionId =
      options.threadId !== undefined && options.threadId.trim() !== ""
        ? options.threadId.trim()
        : `pi-native-session-${host.crypto.randomUUID()}`;
    this.#binding = binding;
    this.#selection = options.modelSelection;
    this.#policy = options.runtimePolicy;
    this.#contextText = options.contextText;
    this.#projectMemory = options.projectMemory;
    this.#instructions = prompts.instructions;
    this.#customAppend = prompts.customPrompt?.append;
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
    this.#scratch = new SessionScratchDir({ sessionId: this.#sessionId });
    this.#backgroundJobs = new BackgroundJobManager({
      now: this.#now,
      onJobUpdated: (snapshot) => this.#emit({ type: "background_job", snapshot }),
      onJobExited: (snapshot) => this.#handleBackgroundJobExit(snapshot),
    });
    this.#sandbox = new WorkspaceSandbox({
      cwd: options.runtimePolicy.cwd,
      extraRoots: options.runtimePolicy.workspace?.extraRoots ?? [],
      readOnlyRoots: options.readOnlyRoots ?? [],
      scratchRoots: [this.#scratch.path],
    });
    this.#permissions = this.#makePermissions();
    this.#registry = new DeferredToolRegistry({
      searchRemoteTools: (query) => this.#searchRemoteTools(query),
    });
    this.#coalescer = new StreamDeltaCoalescer<string>({
      ...(options.scheduleTimer === undefined ? {} : { scheduleTimer: options.scheduleTimer }),
      onFlush: (key) => this.#flushKey(key),
    });
    this.#baseStreamFn = this.#makeBaseStreamFn();
    // Build the loadout first so the cached leading prompt already carries its catalog.
    const initialTools = this.#buildToolList();
    this.#systemManager = new SystemTranscriptManager({
      // A custom `SYSTEM.md` owns the persona slot; the operational rules stay in sections.
      basePrompt: prompts.customPrompt?.replace ?? "",
      sections: this.#desiredSections(),
      timestamp: this.#now(),
    });
    const initialSystem = this.#systemManager.initialSystemMessage;
    this.#agent = new Agent({
      sessionId: this.#sessionId,
      initialState: {
        model: binding.model,
        thinkingLevel: binding.thinkingLevel ?? "off",
        tools: initialTools,
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
    const workspaceRoot = instructionWorkspaceRoot(options.runtimePolicy);
    const agentDir = options.piAgentDir === undefined ? {} : { agentDir: options.piAgentDir };
    const instructions = new ProjectInstructionTracker({ workspaceRoot, ...agentDir });
    // Root instructions belong to the leading system message, so read them before the first request.
    await instructions.visit();
    const customPrompt = await loadCustomSystemPrompt({ workspaceRoot, ...agentDir });
    const runtime = new NativePiSessionRuntime(
      options,
      resolvePiNativeModelBinding(options.settings, options.modelSelection),
      await discoverSkillCatalog(options),
      { customPrompt, instructions },
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

  /** Background Bash jobs outlive their turn, so the adapter polls this for pending work. */
  get hasRunningBackgroundJobs(): boolean {
    return this.#backgroundJobs.hasRunningJobs();
  }

  async stopBackgroundJob(id: string): Promise<boolean> {
    if (this.#backgroundJobs.get(id) === undefined) return false;
    await this.#backgroundJobs.stop(id);
    return true;
  }

  get todos(): TodoSnapshot {
    return cloneTodoSnapshot(this.#todos);
  }

  /** The catalog this workspace offers, for `/skill:<id>` validation in the adapter. */
  get skills(): ReadonlyArray<PiNativeSkillDef> {
    return this.#skills;
  }

  /**
   * Rescans the workspace so skills added, edited, or removed mid-session reach the
   * transcript: the prompt sections append a minimal delta and revoked ones go null.
   */
  async refreshSkills(): Promise<void> {
    const discovered = await discoverSkillCatalog(this.#options);
    if (piNativeSkillsDigest(discovered) === piNativeSkillsDigest(this.#skills)) return;
    this.#skills = discovered;
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
    // Entering or leaving an active goal changes which goal tools the next request declares.
    if (wasActive !== (goal?.status === "active")) this.#rebuildTools();
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
    return projectContextRequest(
      this.#agent.state.messages,
      contextRequestTools(this.#agent.state.tools),
    ).cost.totalTokens;
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
        this.#persistAsync();
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
      backgroundJobs: this.#backgroundJobs,
      onBackgroundJobStarted: (snapshot) => this.#emit({ type: "background_job", snapshot }),
      scratch: this.#scratch,
      resolveShell: () => this.#currentTurnShell(),
      loginShellPath: () => this.#cachedLoginShellPath(),
      skills: () => this.#skills,
      ...(this.#options.threadId === undefined ? {} : { threadId: this.#options.threadId }),
      ...(this.#options.shell === undefined ? {} : { shell: this.#options.shell }),
      ...(this.#options.environment === undefined
        ? {}
        : { environment: this.#options.environment }),
      ...(this.#options.mcpSession === undefined ? {} : { mcpSession: this.#options.mcpSession }),
    };
  }

  #currentTurnShell(): TurnShell {
    this.#turnShell ??= resolveTurnShell(
      this.#options.environment === undefined ? {} : { environment: this.#options.environment },
    );
    return this.#turnShell;
  }

  #cachedLoginShellPath(): Promise<string | null> {
    this.#loginShellPathPromise ??=
      this.#options.loginShellPath !== undefined
        ? this.#options.loginShellPath()
        : probeLoginShellPath(
            this.#options.environment === undefined
              ? {}
              : { environment: this.#options.environment },
          );
    return this.#loginShellPathPromise;
  }

  /** A notifying job leaves a status note for the next request. */
  #handleBackgroundJobExit(snapshot: BackgroundJobSnapshot): void {
    if (this.#disposed) return;
    const seconds = Math.max(0, Math.round(snapshot.elapsedMs / 1_000));
    const lines = [
      `Background task ${snapshot.job.id} ${snapshot.state} after ${seconds}s with exit code ${snapshot.exitCode ?? "null"}.`,
      "Read its output with TaskWait or TaskList if the result still matters.",
    ];
    if (snapshot.stdout.trim() !== "") {
      lines.push(`stdout (tail):\n${snapshot.stdout.slice(-2_000)}`);
    }
    if (snapshot.stderr.trim() !== "") {
      lines.push(`stderr (tail):\n${snapshot.stderr.slice(-2_000)}`);
    }
    this.#backgroundNotes.push(lines.join("\n"));
    while (this.#backgroundNotes.length > 5) this.#backgroundNotes.shift();
  }

  #allTools(): AgentTool<any>[] {
    const subagentTools = (this.#subagents?.tools ?? []) as AgentTool<any>[];
    const delegate = (name: string): AgentTool<any> | undefined =>
      subagentTools.find((tool) => tool.name === name);
    const wait = delegate("TaskWait");
    const list = delegate("TaskList");
    const stop = delegate("TaskStop");
    const routing = createJobToolRouting({
      backgroundJobs: this.#backgroundJobs,
      delegates: {
        ...(wait === undefined ? {} : { wait }),
        ...(list === undefined ? {} : { list }),
        ...(stop === undefined ? {} : { stop }),
      },
    });
    this.#jobRouting = routing;
    return [
      ...createPiNativeTools(this.#toolDependencies()),
      ...(this.#mcpTools as AgentTool<any>[]),
      // Task stays with the subagent manager; the job tools route both owners.
      ...subagentTools.filter(
        (tool) => tool.name !== "TaskWait" && tool.name !== "TaskList" && tool.name !== "TaskStop",
      ),
      ...routing.tools,
    ];
  }

  /**
   * Partitions the catalog into core and on-demand tools, then returns what this request
   * declares. Mode-required tools are activated here so a plan or goal never stalls.
   */
  #buildToolList(): AgentTool<any>[] {
    const tools = this.#allTools();
    this.#registry.setTools(tools);
    if (this.#policy.interactionMode === "plan") this.#registry.activate(["asktool", "SubmitPlan"]);
    if (this.#goal?.status === "active") this.#registry.activate(["UpdateGoalStatus"]);
    const policy = toolDeclarationPolicy(
      this.#binding.model,
      tools,
      this.#registry.deferredNames,
      Object.values(this.#desiredSections())
        .filter((section): section is string => typeof section === "string")
        .join("\n\n"),
      this.#options.modelSelection.instanceId,
    );
    this.#fixedDeclarationKey = policy.tools === undefined ? null : policy.key;
    this.#registry.restore(
      this.#agent?.state.messages ?? [],
      this.#fixedDeclarationKey ?? undefined,
    );
    return this.#declaredTools();
  }

  #declaredTools(): AgentTool<any>[] {
    return this.#fixedDeclarationKey === null
      ? this.#registry.activeTools()
      : this.#registry.allDeclarations();
  }

  #rebuildTools(): void {
    this.#agent.state.tools = this.#buildToolList();
  }

  /** Restores on-demand activation, for example from a transcript or an adapter handoff. */
  activateTools(names: ReadonlyArray<string>): ReadonlyArray<string> {
    const activated = this.#registry.activate(names);
    if (activated.length > 0) this.#rebuildTools();
    return activated;
  }

  async #searchRemoteTools(query: string): Promise<ReadonlyArray<string>> {
    const session = this.#mcpSession;
    if (session === undefined) return [];
    const names = await session.searchTools(query);
    if (names.length === 0) return [];
    this.#mcpTools = await session.refreshTools();
    this.#mcpReadOnly = mcpReadOnlyPredicate(session.metadata);
    this.#rebuildTools();
    return names;
  }

  async #connectMcp(): Promise<void> {
    const config = this.#options.mcpSession;
    if (config === undefined) {
      this.#clearMcp();
      return;
    }
    const result = await connectMcpSession(config, {
      toolExposure: "deferred",
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
    });
    // An unreachable T3 MCP server removes tools; it must never fail the turn.
    if (!result.available) {
      this.#clearMcp();
      return;
    }
    this.#mcpSession = result;
    this.#mcpTools = result.tools;
    this.#mcpReadOnly = mcpReadOnlyPredicate(result.metadata);
    this.#mcpAvailable = true;
    this.#permissions = this.#makePermissions();
    this.#ensureSubagents();
  }

  #clearMcp(): void {
    this.#mcpSession = undefined;
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
    const projectInstructions = renderProjectInstructions(this.#instructions.current);
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
      ...(this.#projectMemory === undefined || this.#projectMemory === ""
        ? {}
        : { projectMemory: this.#projectMemory }),
      ...(this.#scratch.created ? { scratchDir: this.#scratch.path } : {}),
      ...(contextBudget === undefined ? {} : { contextBudget }),
      onDemandTools: this.#registry.catalogSection(),
      skillSections: piNativeSkillsPromptSections(this.#skills),
      ...(this.#customAppend === undefined ? {} : { customAppend: this.#customAppend }),
      ...(projectInstructions === undefined ? {} : { projectInstructions }),
      toolActivation: this.#options.settings.enableSubagents
        ? "<tool_activation>Task delegates self-contained work to in-process subagents. TaskWait, TaskList, and TaskStop cover both subagents and background Bash jobs.</tool_activation>"
        : "",
    });
    const activationRecord =
      this.#fixedDeclarationKey === null
        ? undefined
        : toolActivationSection(this.#fixedDeclarationKey, new Set(this.#registry.activeNames));
    const toolActivation = [sections.tool_activation, activationRecord]
      .filter((part): part is string => part !== undefined && part !== "")
      .join("\n\n");
    return {
      ...sections,
      // Explicitly null empty sections so a cleared one (or revoked last skill / cleared memory) emits a reset delta instead of staying cached.
      skills: sections.skills ?? null,
      on_demand_tools: sections.on_demand_tools ?? null,
      tool_activation: toolActivation === "" ? null : toolActivation,
      project_instructions: sections.project_instructions ?? null,
      project_memory: sections.project_memory ?? null,
    };
  }

  /**
   * Loads the skills this turn invoked: `/skill:<id>` explicitly, or the `$<id>` tokens the
   * composer inserted. The document rides one turn's system directive, like a workflow command.
   */
  async #skillDirective(
    text: string,
    explicitSkillIds: ReadonlyArray<string>,
  ): Promise<string | undefined> {
    const installed = this.#skills.map((skill) => skill.id);
    const requested = [
      ...new Set([...explicitSkillIds, ...piNativeSkillMentions(text, installed)]),
    ];
    const documents: Array<string> = [];
    for (const id of requested) {
      const loaded = await loadPiNativeSkill(this.#skills, id, { allowModelDisabled: true });
      if (!loaded.ok) continue;
      documents.push(formatPiNativeSkillContent(loaded.skill, loaded.body));
    }
    return documents.length === 0 ? undefined : documents.join("\n\n");
  }

  #emit(event: NativeSessionEvent): void {
    this.#options.onEvent(event);
  }

  /** Status only, so a repeated phase is not resent; the adapter forwards each one as ephemeral. */
  #emitPhase(phase: ProviderAdapterV2TurnPhase, detail?: string): void {
    const state = this.#active;
    if (
      phase !== "stopping" &&
      state !== null &&
      (state.gracefulStopRequested || state.interrupted)
    ) {
      return;
    }
    const current = this.#phase;
    if (current !== null && current.phase === phase && current.detail === detail) return;
    this.#phase = detail === undefined ? { phase } : { phase, detail };
    this.#emit({ type: "phase", phase, ...(detail === undefined ? {} : { detail }) });
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
    this.#coalescer.flushAll();
    const state = this.#active;
    if (state !== null) {
      state.retry = event;
      if (event.status === "running") {
        state.retryStartedAtMs = this.#now();
        this.#emitPhase("recovering");
      }
    }
    this.#emit({ type: "retry", event });
  }

  #handleAgentEvent(event: AgentEvent): void {
    const state = this.#active;
    if (state === null) return;
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") {
          state.messageIndex += 1;
          if (state.steeringSplitPending) {
            state.steeringSplitPending = false;
            state.streamEpoch += 1;
          }
        }
        return;
      case "message_update":
        if (event.message.role !== "assistant") return;
        this.#handleAssistantEvent(state, event.assistantMessageEvent);
        return;
      case "message_end":
        this.#persistAsync([event.message]);
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
        this.#persistAsync(event.toolResults);
        this.#coalescer.flushAll();
        return;
      case "agent_end":
        this.#coalescer.flushAll();
        return;
      default:
        return;
    }
  }

  #streamKey(state: ActiveTurnState, kind: NativeSessionStreamKind, contentIndex: number): string {
    return `${kind}:${state.streamEpoch}:${state.messageIndex}:${contentIndex}`;
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
        this.#emitPhase("streaming");
        const key = this.#streamKey(state, "assistant", event.contentIndex);
        this.#streamItem(state, key, "assistant", event.contentIndex).text += event.delta;
        this.#coalescer.push(key, event.delta);
        return;
      }
      case "thinking_delta": {
        this.#emitPhase("streaming");
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
    const projection = state.preRequest;
    if (projection !== null && promptTokens > 0) {
      this.#recordCalibrationSample(projection, promptTokens);
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
    this.#emitPhase(toolName === "TaskWait" ? "waiting-subagents" : "tool", toolName);
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
    const toolName = context.toolCall.name;
    if (this.#registry.isDeferred(toolName) && !this.#registry.isActive(toolName)) {
      return {
        block: true,
        reason: `Tool ${toolName} is on demand. Call ToolSearch with "${toolName}" first, then call it on the next step.`,
      };
    }
    const decision = await this.#permissions.evaluate(toolName, context.args, signal);
    if (!decision.allowed) return { block: true, reason: decision.reason };
    await this.#refreshPathInstructions(context.toolCall.name, context.args);
    return undefined;
  };

  /** Nested rules only matter once a turn reaches their directory, so they load there. */
  async #refreshPathInstructions(toolName: string, args: unknown): Promise<void> {
    if (!PATH_SCOPED_INSTRUCTION_TOOLS.has(toolName)) return;
    const workspacePath =
      typeof args === "object" && args !== null
        ? (args as { readonly path?: unknown }).path
        : undefined;
    if (typeof workspacePath !== "string" || workspacePath.trim() === "") return;
    await this.#instructions.visit(workspacePath.trim());
  }

  #prepareRequest: PrepareRequest = async (request) => {
    const state = this.#active;
    if (state === null) return undefined;
    this.#emitPhase("preparing");
    const pressure = this.#evaluatePressure(request.context.messages, request.context.tools);
    state.preRequest = pressure.projection;
    const reminder = this.#reminders.select({
      remainingTokens: pressure.remainingTokens,
      hardLimit: pressure.hardLimit,
      midConversationSystem: supportsMidConversationSystemMessages(this.#binding.model),
    });
    const delta = this.#systemManager.diffSections(
      this.#desiredSections(reminder?.role === "system" ? reminder.text : undefined),
      this.#now(),
    );
    let messages = request.context.messages;
    if (delta !== null) messages = syncToolActivation(messages, delta);
    const tools = this.#declaredTools();
    await this.#appendNewRecords(this.#agent.state.messages);
    await this.#appendSystemDeclarations(messages);
    if (this.#backgroundNotes.length > 0) {
      const notes = this.#backgroundNotes.splice(0);
      messages = [
        ...messages,
        {
          role: "user",
          content: `<background_tasks>\n${notes.join("\n\n")}\n</background_tasks>`,
          timestamp: this.#now(),
        } satisfies UserMessage,
      ];
    }
    if (reminder?.role === "user") {
      // Request-only: a synthetic user reminder protects the cached prefix on the
      // providers whose adapters cannot carry a mid-conversation system message.
      messages = [
        ...messages,
        { role: "user", content: reminder.text, timestamp: this.#now() } satisfies UserMessage,
      ];
    }
    this.#consumeSteers(messages);
    if (this.#options.settings.autoCompact && pressure.shouldCompact) {
      const compacted = await this.#compactWith("active_turn", undefined, messages);
      if (compacted !== null) {
        this.#agent.state.messages = compacted.messages;
        messages = compacted.messages;
      }
      this.#emitPhase("preparing");
    }
    // The request is about to be issued; the first token ends this phase.
    this.#emitPhase("waiting-model");
    if (messages === request.context.messages && tools === request.context.tools) return undefined;
    return { context: { messages, tools }, model: request.model };
  };

  #finishTurn: FinishTurn = async (turn) => {
    const state = this.#active;
    if (state === null) return undefined;
    state.lastAssistant = turn.message;
    if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") {
      return undefined;
    }
    if (turn.message.stopReason === "length") state.outputTruncated = true;

    // A graceful stop ends the loop here, leaving in-flight work to finish on its own.
    if (state.gracefulStopRequested) {
      state.gracefulStopRequested = false;
      state.interrupted = true;
      this.#emitPhase("stopping");
      return { action: "end" };
    }

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
      this.#emitPhase("recovering");
      // An overflowed request cannot be retried, so the whole turn folds into a summary.
      const compacted = await this.#compactWith("completed_turn", 0);
      if (compacted !== null) {
        this.#emitPhase("recovering");
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

    // Autonomous plan/goal: announcing a step and stopping is progress, not an answer.
    const text = textOf(turn.message.content).trim();
    const planMode = this.#policy.interactionMode === "plan" && !state.planSubmittedThisTurn;
    const goalActive = this.#goal?.status === "active";
    if (
      (planMode || goalActive) &&
      turn.message.stopReason === "stop" &&
      text !== "" &&
      !turn.message.content.some(isToolCall) &&
      !state.silentTurnTried &&
      !state.progressOnlyTried &&
      !state.gracefulStopRequested &&
      isProgressOnlyAssistantTurn(text)
    ) {
      state.progressOnlyTried = true;
      state.pendingAppend = [
        {
          role: "user",
          content: planMode ? PROGRESS_ONLY_PLAN_NUDGE : PROGRESS_ONLY_GOAL_NUDGE,
          timestamp: this.#now(),
        } satisfies UserMessage,
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
    if (install !== null) this.#agent.state.messages = install;
    const tools = this.#declaredTools();
    this.#agent.state.tools = tools;
    // The declared tools ride on the context, so a ToolSearch activation is callable next step.
    return {
      context: {
        messages: install ?? context.context.messages,
        tools,
      },
      ...(append.length === 0 ? {} : { messages: append }),
    };
  };

  #evaluatePressure(
    messages: ReadonlyArray<AgentMessage>,
    tools: ReadonlyArray<AgentTool<any>> | undefined,
  ) {
    return evaluateContextPressure({
      messages,
      model: this.#binding.model,
      tools: contextRequestTools(tools),
      calibration: this.#calibration,
    });
  }

  /** One real provider report, folded into the series that can measure it. */
  #recordCalibrationSample(projection: ContextProjection, realTotal: number): void {
    if (projection.calibration.lastUsageIndex === null) {
      this.#calibration.recordUnanchored(projection.calibration.tokens, realTotal);
      return;
    }
    this.#calibration.recordAnchored(
      projection.calibration.usageTokens,
      projection.calibration.trailingTokens,
      realTotal,
    );
  }

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
      const stream = await this.#baseStreamFn(
        this.#binding.model,
        context,
        compactionRequestOptions({ sessionId: this.#sessionId, model: this.#binding.model }),
      );
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
    this.#emitPhase("compacting");
    this.#emit({ type: "compaction", itemId, status: "running", beforeTokenCount: before });
    const build = (strategy: CompactionMode): Promise<CompactionCheckpoint> =>
      buildCompactionCheckpoint({
        messages: source,
        mode: strategy,
        model: this.#binding.model,
        timestamp: this.#now(),
        summarizeFn: this.#makeSummarizeFn(),
        pinnedRecentTurns: strategy === "completed_turn" ? (pinnedRecentTurns ?? 1) : undefined,
      });
    let checkpoint: CompactionCheckpoint;
    try {
      checkpoint = await build(mode);
    } catch (cause) {
      if (!isCompactionBudgetError(cause)) {
        this.#emit({ type: "compaction", itemId, status: "failed", beforeTokenCount: before });
        return null;
      }
      // Even the summary could not make the retained turn fit, so the only
      // remaining move is a new window that carries just the active goal.
      try {
        checkpoint = await build("fresh_window");
      } catch {
        this.#emit({ type: "compaction", itemId, status: "failed", beforeTokenCount: before });
        return null;
      }
    }
    const installed = installCompactionCheckpoint(source, checkpoint);
    this.#reminders.reset();
    this.#emit({
      type: "compaction",
      itemId,
      status: "completed",
      beforeTokenCount: checkpoint.beforeTokens,
      afterTokenCount: checkpoint.afterTokens,
      summary: checkpoint.summary,
      ...(checkpoint.failureReason === null ? {} : { failureReason: checkpoint.failureReason }),
    });
    await this.#persistCheckpoint(checkpoint, source, installed);
    return { messages: installed, summarizedMessageCount: checkpoint.summarizedMessageCount };
  }

  async compactManually(instructions?: string): Promise<NativeManualCompactionResult> {
    const source = this.#agent.state.messages;
    const checkpoint: CompactionCheckpoint = await buildCompactionCheckpoint({
      messages: source,
      mode: "completed_turn",
      model: this.#binding.model,
      timestamp: this.#now(),
      summarizeFn: this.#makeSummarizeFn(),
      pinnedRecentTurns: 1,
    });
    const installedBase = installCompactionCheckpoint(source, checkpoint);
    let instructionMessage: UserMessage | undefined;
    let installed: AgentMessage[] = installedBase;
    if (instructions !== undefined && instructions.trim() !== "") {
      instructionMessage = {
        role: "user",
        content: `<compaction_instructions>${instructions.trim()}</compaction_instructions>`,
        timestamp: this.#now(),
      };
      installed = [...installedBase, instructionMessage];
    }
    this.#agent.state.messages = installed;
    this.#reminders.reset();
    const itemId = `compaction:${++this.#sequence}`;
    const after = estimateAgentMessagesTokens(installed);
    this.#emit({
      type: "compaction",
      itemId,
      status: "completed",
      beforeTokenCount: checkpoint.beforeTokens,
      afterTokenCount: after,
      summary: checkpoint.summary,
      ...(checkpoint.failureReason === null ? {} : { failureReason: checkpoint.failureReason }),
    });
    await this.#persistCheckpoint(checkpoint, source, installedBase);
    if (instructionMessage !== undefined) {
      await this.#appendNewRecords([instructionMessage]);
    }
    await this.#persistMeta();
    return {
      beforeTokenCount: checkpoint.beforeTokens,
      afterTokenCount: after,
      summary: checkpoint.summary,
      itemId,
    };
  }

  #consumeSteers(messages: readonly AgentMessage[]): void {
    const state = this.#active;
    if (state === null || state.unreadSteers.size === 0) return;
    const present = new Set<AgentMessage>(messages);
    let consumed = false;
    for (const [messageId, message] of state.unreadSteers) {
      if (!present.has(message)) continue;
      state.unreadSteers.delete(messageId);
      consumed = true;
      this.#emit({ type: "steer", messageId, status: "completed" });
    }
    if (!consumed) return;
    // Steering closes the pre-steering bubble: flush what it streamed and start the next reply
    // in a new item, so the two replies never merge.
    this.#coalescer.flushAll();
    state.steeringSplitPending = true;
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
    if (state === null || state.gracefulStopRequested || state.interrupted) return "declined";
    const message: UserMessage = {
      role: "user",
      content: buildUserContent(input.text, input.images ?? []),
      timestamp: this.#now(),
    };
    // Steering unblocks TaskWait without cancelling the running subagents.
    this.#subagents?.interruptWaits();
    // A Bash wait is interrupted too; the process it waited on keeps running.
    this.#jobRouting?.interruptWaits();
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
    /** Skills the user invoked explicitly, such as `/skill:<id>`. */
    readonly skillIds?: ReadonlyArray<string> | undefined;
    /** Test seam: runs in the window between loop settle and lock release. */
    readonly onLoopSettled?: () => void;
  }): Promise<NativeTurnOutcome> {
    if (this.#active !== null) throw new Error("A Pi Native turn is already running.");
    // A shell change between turns takes effect at the start of the next one.
    this.#turnShell = null;
    this.#ensureSubagents();
    await this.refreshSkills();
    const state = newTurnState();
    this.#active = state;
    this.#phase = null;
    this.#emitPhase("starting");
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
    const turnDirective = [
      input.workflowDirective,
      await this.#skillDirective(input.text, input.skillIds ?? []),
    ]
      .filter((part): part is string => part !== undefined && part !== "")
      .join("\n\n");
    this.#workflowDirective = turnDirective === "" ? undefined : turnDirective;
    const prompt: UserMessage = {
      role: "user",
      content: buildUserContent(input.text, input.images ?? []),
      timestamp: this.#now(),
    };
    // Durable before dispatch: a crash after this point must not lose the user turn.
    await this.#appendNewRecords([prompt]);
    // `pi-agent-core` keeps the thinking level across turns, so a boost must not leak forward.
    try {
      await this.#agent.prompt(prompt);
      await this.#agent.waitForIdle();
      await this.#recoverErrorOverflow(state);
      input.onLoopSettled?.();
      for (;;) {
        if (state.interrupted || state.gracefulStopRequested) break;
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
    await this.persistCurrentTranscript().catch(() => undefined);
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
    if (state.interrupted || state.gracefulStopRequested || failed?.stopReason !== "error") return;
    if (!this.#shouldRecoverOverflow(failed, state)) return;
    state.overflowRecoveryTried = true;
    this.#emitPhase("recovering");
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
    if (state.interrupted || state.gracefulStopRequested || message?.stopReason === "aborted") {
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

  /** Ask the loop to stop after the current assistant/tool step instead of aborting it. */
  requestGracefulStop(): { readonly requested: boolean } {
    const state = this.#active;
    if (this.#disposed || state === null) return { requested: false };
    state.gracefulStopRequested = true;
    this.#agent.clearAllQueues();
    this.#tailRace = [];
    this.#cancelUnreadSteers(state);
    this.#emitPhase("stopping");
    return { requested: true };
  }

  abort(): Promise<void> {
    this.#abortPromise ??= this.#abort().finally(() => {
      this.#abortPromise = null;
    });
    return this.#abortPromise;
  }

  async #abort(): Promise<void> {
    const state = this.#active;
    if (state !== null) {
      state.interrupted = true;
      this.#emitPhase("stopping");
      this.#agent.abort();
      this.#coalescer.flushAll();
      this.#cancelUnreadSteers(state);
    }
    // Subagents outlive their parent's step, so an interrupt has to settle them too.
    await this.#subagents?.stopAll("interrupted");
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.abort();
    await this.#writeTail;
    await this.#subagents?.stopAll("interrupted");
    await this.#backgroundJobs.stopAll();
    await this.#scratch.cleanup();
    this.#backgroundNotes = [];
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
    // Plan mode requires SubmitPlan and asktool, so the declared loadout follows the mode.
    this.#rebuildTools();
  }

  /** App threads can hand over new model context between turns; sections re-diff on the next request. */
  applyContextText(contextText: string): void {
    this.#contextText = contextText;
    this.#persistAsync();
  }

  /** Updated or cleared project memory lands on the next request as a section delta. */
  applyProjectMemory(content: string | undefined): void {
    this.#projectMemory = projectMemoryPrompt(content) === undefined ? undefined : content;
  }

  #leadingSystem(): AgentMessage | undefined {
    return this.#systemManager.initialSystemMessage;
  }

  #clearTrackers(): void {
    this.#anchors = new FileSnapshotStore();
    this.#registers = new NamedRegisters();
    this.#recovery = new MutationRecoveryTracker();
  }

  get hasPersistedTranscript(): boolean {
    return this.#restoredTranscript;
  }

  #newRecordId(): string {
    return `pi-native-record-${host.crypto.randomUUID()}`;
  }

  #enqueueWrite(work: () => Promise<void>): Promise<void> {
    const next = this.#writeTail.then(work);
    this.#writeTail = next.catch(() => undefined);
    return next;
  }

  /** Base64 never reaches durable rows; an admitted ref is the only restorable form. */
  #serializeMessage(message: AgentMessage): string {
    if (
      (message.role !== "user" && message.role !== "toolResult") ||
      typeof message.content === "string"
    ) {
      return JSON.stringify(message);
    }
    const content = message.content.map((block) => {
      if (block.type !== "image") return block;
      const ref = (block as { readonly ref?: string }).ref;
      return {
        type: "image" as const,
        data: "",
        mimeType: block.mimeType,
        ...(ref === undefined || ref === "" ? {} : { ref }),
      };
    });
    return JSON.stringify({ ...message, content });
  }

  async #appendNewRecords(messages: readonly AgentMessage[]): Promise<void> {
    const store = this.#store;
    if (store === null || this.#persistenceKey === "") return;
    const records: PersistedTranscriptRecord[] = [];
    for (const message of messages) {
      if (message.role === "system") continue;
      if (this.#recordIds.has(message) || this.#restoredMessages.has(message)) continue;
      const id = this.#newRecordId();
      const turnIndex =
        message.role === "user" ? this.#turnCursor++ : Math.max(0, this.#turnCursor - 1);
      this.#recordIds.set(message, id);
      this.#lastRecordId = id;
      records.push({
        id,
        providerThreadId: this.#persistenceKey,
        sequence: this.#recordSequence++,
        turnIndex,
        role: message.role,
        timestampMs: message.timestamp,
        messageJson: this.#serializeMessage(message),
        system: null,
      });
    }
    if (records.length === 0) return;
    await this.#enqueueWrite(() =>
      Effect.runPromise(store.appendRecords({ providerThreadId: this.#persistenceKey, records })),
    );
  }

  async #appendSystemDeclarations(messages: readonly AgentMessage[]): Promise<void> {
    const store = this.#store;
    if (store === null || this.#persistenceKey === "") return;
    const declarations = this.#journal.declare(
      messages,
      (message) => this.#recordIds.get(message),
      () => this.#newRecordId(),
    );
    if (declarations.length === 0) return;
    const records: PersistedTranscriptRecord[] = declarations.map((declaration) => ({
      id: declaration.id,
      providerThreadId: this.#persistenceKey,
      sequence: this.#recordSequence++,
      // System rows survive every turn rollback.
      turnIndex: -1,
      role: "system",
      timestampMs: declaration.timestampMs,
      messageJson: declaration.messageJson,
      system: {
        version: 1,
        beforeMessageId: declaration.beforeMessageId,
        afterMessageId: declaration.afterMessageId,
      },
    }));
    await this.#enqueueWrite(() =>
      Effect.runPromise(store.appendRecords({ providerThreadId: this.#persistenceKey, records })),
    );
    for (const declaration of declarations) {
      this.#journal.markPersisted(declaration.message, declaration.id);
    }
  }

  async #persistMeta(): Promise<void> {
    const store = this.#store;
    if (store === null || this.#persistenceKey === "") return;
    const meta = {
      providerThreadId: this.#persistenceKey,
      todosJson: JSON.stringify(this.#todos),
      contextText: this.#contextText ?? null,
      activatedToolNamesJson: JSON.stringify(this.#agent.state.tools.map((tool) => tool.name)),
      updatedAtMs: this.#now(),
    };
    await this.#enqueueWrite(() => Effect.runPromise(store.saveMeta(meta)));
  }

  async #persistCheckpoint(
    checkpoint: CompactionCheckpoint,
    sourceMessages: readonly AgentMessage[],
    installedMessages: readonly AgentMessage[],
  ): Promise<void> {
    const store = this.#store;
    if (store === null || this.#persistenceKey === "") return;
    const leadingSystemJson =
      checkpoint.leadingSystem === undefined
        ? null
        : serializeSystemMessage(checkpoint.leadingSystem);
    if (leadingSystemJson !== null) this.#journal.rememberCheckpoint(leadingSystemJson);
    let throughMessageId: string | null = null;
    for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
      const candidate = sourceMessages[index];
      if (candidate === undefined || candidate.role === "system") continue;
      const id = this.#recordIds.get(candidate);
      if (id !== undefined) {
        throughMessageId = id;
        break;
      }
    }
    if (throughMessageId === null) throughMessageId = this.#lastRecordId;
    for (const message of installedMessages) {
      if (message.role === "system") {
        this.#journal.markPersisted(message, this.#newRecordId());
      } else {
        this.#restoredMessages.add(message);
      }
    }
    const record: PersistedCompactionCheckpoint = {
      providerThreadId: this.#persistenceKey,
      throughMessageId,
      mode: checkpoint.mode,
      summary: checkpoint.summary,
      leadingSystemJson,
      retainedMessagesJson: JSON.stringify(
        checkpoint.retainedMessages.map((message) => JSON.parse(this.#serializeMessage(message))),
      ),
      summarizedMessageCount: checkpoint.summarizedMessageCount,
      chunkCount: checkpoint.chunkCount,
      usedFallback: checkpoint.usedFallback,
      createdAtMs: checkpoint.timestamp,
    };
    await this.#enqueueWrite(() => Effect.runPromise(store.saveCheckpoint(record)));
  }

  /** Flushes user/assistant/tool/system rows and metadata for the current state. */
  async persistCurrentTranscript(): Promise<void> {
    if (this.#store === null || this.#persistenceKey === "") return;
    await this.#appendNewRecords(this.#agent.state.messages);
    await this.#appendSystemDeclarations(this.#agent.state.messages);
    await this.#persistMeta();
  }

  #persistAsync(messages?: readonly AgentMessage[]): void {
    if (this.#store === null || this.#persistenceKey === "") return;
    void (async () => {
      if (messages !== undefined) await this.#appendNewRecords(messages);
      else await this.persistCurrentTranscript();
    })().catch(() => undefined);
  }

  /** Restores the durable transcript; false when this thread has no native rows yet. */
  restorePersistedSession(): Promise<boolean> {
    if (this.#hydrating !== null) return this.#hydrating;
    this.#hydrating = (async () => {
      const store = this.#store;
      if (store === null || this.#persistenceKey === "") return false;
      const snapshot = await Effect.runPromise(store.loadThread(this.#persistenceKey)).catch(
        () => null,
      );
      if (snapshot === null || snapshot.records.length === 0) return false;
      const model = this.#binding.model;
      const restored = await restoreTranscript({
        snapshot,
        model: { api: model.api, provider: model.provider, model: model.id },
        now: this.#now(),
        supportsVision: this.#binding.supportsImages,
      }).catch(() => null);
      if (restored === null) return false;
      this.#agent.state.messages = [...restored.messages];
      this.#todos = cloneTodoSnapshot(restored.todos);
      if (
        this.#contextText === undefined &&
        snapshot.meta?.contextText !== null &&
        snapshot.meta?.contextText !== undefined
      ) {
        this.#contextText = snapshot.meta.contextText;
      }
      this.#restoredTranscript = true;
      this.#recordSequence = snapshot.records.reduce(
        (next: number, record: PersistedTranscriptRecord) => Math.max(next, record.sequence + 1),
        0,
      );
      this.#lastRecordId =
        [...snapshot.records].reverse().find((record) => record.system === null)?.id ?? null;
      this.#turnCursor = snapshot.records.reduce(
        (next: number, record: PersistedTranscriptRecord) =>
          record.turnIndex < 0 ? next : Math.max(next, record.turnIndex + 1),
        0,
      );
      if (snapshot.checkpoint?.leadingSystemJson) {
        this.#journal.rememberCheckpoint(snapshot.checkpoint.leadingSystemJson);
      }
      for (const [message, id] of restored.recordIds) {
        this.#recordIds.set(message, id);
      }
      for (const message of this.#agent.state.messages) {
        this.#restoredMessages.add(message);
        if (message.role === "system") {
          this.#journal.markPersisted(
            message,
            restored.recordIds.get(message) ?? this.#newRecordId(),
          );
        }
      }
      this.#clearTrackers();
      this.#registry.resetActivation();
      this.#rebuildTools();
      return true;
    })();
    return this.#hydrating;
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
    this.#restoredMessages = new WeakSet();
    this.#restoredTranscript = false;
    this.#turnCursor = converted.filter((message) => message.role === "user").length;
    this.#clearTrackers();
    this.#registry.resetActivation();
    this.#rebuildTools();
  }

  async truncateToTurn(targetTurnCount: number): Promise<void> {
    const leading = this.#leadingSystem();
    const turns = splitUserTurns(
      this.#agent.state.messages.filter((message) => message.role !== "system"),
    );
    const kept = turns.slice(0, Math.max(0, targetTurnCount)).flat();
    this.#agent.state.messages = leading === undefined ? kept : [leading, ...kept];
    this.#todos = restoreTodosFromMessages(kept);
    this.#turnCursor = Math.min(Math.max(0, targetTurnCount), turns.length);
    this.#lastRecordId = null;
    for (const message of this.#agent.state.messages) {
      const id = this.#recordIds.get(message);
      if (id !== undefined) this.#lastRecordId = id;
    }
    this.#clearTrackers();
    this.#registry.resetActivation();
    this.#rebuildTools();
    const store = this.#store;
    if (store !== null && this.#persistenceKey !== "") {
      await this.#enqueueWrite(() =>
        Effect.runPromise(
          store.truncateAfterTurn({
            providerThreadId: this.#persistenceKey,
            targetTurnCount,
          }),
        ),
      );
      await this.#persistMeta();
    }
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
    this.#restoredMessages = new WeakSet();
    this.#restoredTranscript = false;
    this.#turnCursor = messages.filter((message) => message.role === "user").length;
    this.#clearTrackers();
    this.#registry.resetActivation();
    this.#rebuildTools();
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
