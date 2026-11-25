// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- Attachments are read from disk, turn timestamps are request data, and Stop needs a settle deadline.
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  MessageId,
  parseGoalCommand,
  PlanId,
  RuntimeRequestId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2ProviderGoal,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2TurnItemStatus,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderRequestKind,
  type ThreadId,
  type TurnItemId,
  type NodeId,
} from "@t3tools/contracts";
import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  makeProviderFailure,
  makeProviderRetryTurnItem,
} from "@t3tools/provider-core/server/failure";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { PiNativeSettings } from "../settings.ts";
import { parsePiNativeCompactCommand, parsePiNativeWorkflowCommand } from "./commands.ts";
import { PI_NATIVE_DRIVER_KIND } from "./status.ts";
import {
  NativePiSessionRuntime,
  type NativeSessionEvent,
  type NativeSessionFailure,
  type NativeTurnOutcome,
  type NativeUserInputRequest,
} from "./runtime/sessionRuntime.ts";
import type { ToolApprovalRequest, ToolApprovalResponse, ToolRisk } from "./runtime/permissions.ts";
import { resolvePiNativeModelBinding } from "./runtime/providerBinding.ts";
import type { ProviderRetrySleep } from "./runtime/providerRetry.ts";
import type { ScheduleTimer } from "./runtime/streamCoalescer.ts";
import type { SubagentRecord } from "./runtime/subagent.ts";

export { PI_NATIVE_DRIVER_KIND };

const DRIVER = PI_NATIVE_DRIVER_KIND;

const host = globalThis as unknown as { readonly Date: { now: () => number } };

type TurnItemOf<T extends OrchestrationV2TurnItem["type"]> = Extract<
  OrchestrationV2TurnItem,
  { readonly type: T }
>;

export interface PiNativeAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: PiNativeSettings;
  readonly streamFn?: StreamFn;
  readonly now?: () => number;
  readonly sleep?: ProviderRetrySleep;
  readonly scheduleTimer?: ScheduleTimer;
  readonly random?: () => number;
  readonly fetch?: typeof globalThis.fetch;
}

export type PiNativeAdapterV2DriverEnv =
  | IdAllocator.IdAllocatorV2
  | ProviderHost.ProviderHost
  | McpProviderSessions.McpProviderSessions;

const PI_NATIVE_CAPABILITIES = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    // One in-process session hosts a runtime per app thread, like the Pi provider's threads.
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsNativeResume: false,
    supportsNativeGoals: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: true,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: true,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: true,
    acceptsDeveloperContext: true,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

interface PendingRequest {
  readonly requestId: RuntimeRequestId;
  readonly runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly item: OrchestrationV2TurnItem;
  readonly resolve: (input: {
    readonly decision?: ProviderApprovalDecision;
    readonly feedback?: string;
    readonly answers?: Record<string, unknown>;
  }) => void;
  readonly cancel: () => void;
}

interface OpenMessage {
  readonly messageId: MessageId;
  readonly nodeId: NodeId;
  readonly createdAtMs: number;
  text: string;
  streaming: boolean;
}

interface ActiveTurn {
  readonly state: ThreadState;
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  readonly startedAtMs: number;
  readonly itemOrdinals: Map<string, number>;
  readonly openItems: Map<TurnItemId, OrchestrationV2TurnItem>;
  readonly openMessages: Map<string, OpenMessage>;
  readonly subagents: Map<string, OrchestrationV2Subagent>;
  /** Subagents this turn started that have not settled; drives `background_work.updated`. */
  readonly runningSubagents: Set<string>;
  readonly streamedToolChars: Map<string, number>;
  nextItemOrdinal: number;
  interrupted: boolean;
  failure: NativeSessionFailure | null;
  outputTruncated: boolean;
  settled: boolean;
  done: Promise<void>;
  resolveDone: () => void;
}

interface ThreadState {
  providerThread: OrchestrationV2ProviderThread;
  runtime: NativePiSessionRuntime | null;
  modelSelection: ModelSelection;
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  appThreadId: ThreadId;
  contextText: string | undefined;
  activeTurn: ActiveTurn | null;
  lastTurn: ActiveTurn | null;
  latestTodoPlan: Extract<OrchestrationV2PlanArtifact, { readonly kind: "todo_list" }> | null;
  latestProposedPlan: Extract<
    OrchestrationV2PlanArtifact,
    { readonly kind: "proposed_plan" }
  > | null;
  goal: OrchestrationV2ProviderGoal | null;
}

const providerRequestKind = (risk: ToolRisk): ProviderRequestKind => {
  switch (risk) {
    case "file_edit":
    case "external_write":
      return "file-change";
    case "safe_shell":
    case "shell":
    case "destructive_shell":
      return "command";
    case "external_read":
    case "read":
      return "file-read";
    case "mcp_write":
      return "mcp-elicitation";
  }
};

const isFileChangeTool = (toolName: string): boolean => toolName === "Write" || toolName === "Edit";

const isSearchTool = (toolName: string): boolean => toolName === "Glob" || toolName === "Grep";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringField = (value: unknown, key: string): string | undefined => {
  const field = asRecord(value)?.[key];
  return typeof field === "string" ? field : undefined;
};

const numberField = (value: unknown, key: string): number | undefined => {
  const field = asRecord(value)?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
};

const subagentStatus = (status: SubagentRecord["status"]): OrchestrationV2Subagent["status"] => {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
  }
};

const isSettledSubagent = (status: OrchestrationV2Subagent["status"]): boolean =>
  status !== "running" && status !== "pending" && status !== "waiting" && status !== "idle";

/** Retry progress and the terminal failure share one item so their ordinals stay stable. */
const TERMINAL_FAILURE_ITEM = "terminal-failure";

const isInside = (cwd: string, path: string): boolean => {
  const relative = NodePath.relative(cwd, path);
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

/** Two edits in different folders keep their distinct paths instead of collapsing to a basename. */
const workspaceRelativePath = (cwd: string | null | undefined, path: string): string => {
  if (cwd === null || cwd === undefined || path === "" || !NodePath.isAbsolute(path)) return path;
  return isInside(cwd, path) ? NodePath.relative(cwd, path) : path;
};

const appContextText = (
  appContext: ProviderAdapter.ProviderAdapterV2TurnInput["appContext"],
): string | undefined => {
  const entries = (appContext ?? []).filter((entry) => entry.text.trim() !== "");
  if (entries.length === 0) return undefined;
  return entries
    .map((entry) => `<external_${entry.key}>${entry.text}</external_${entry.key}>`)
    .join("\n\n");
};

const INTERRUPT_SETTLE_TIMEOUT_MS = 15_000;

const stoppedDeadline = (scheduleTimer: ScheduleTimer | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (scheduleTimer === undefined) {
      setTimeout(resolve, INTERRUPT_SETTLE_TIMEOUT_MS);
      return;
    }
    scheduleTimer(INTERRUPT_SETTLE_TIMEOUT_MS, resolve);
  });

const readAttachmentImages = async (
  attachments: ReadonlyArray<ChatAttachment>,
  resolvePath: (attachment: ChatAttachment) => string | null,
): Promise<ImageContent[]> => {
  const images: ImageContent[] = [];
  for (const attachment of attachments) {
    if (!isProviderNativeImageAttachment(attachment)) continue;
    const path = resolvePath(attachment);
    if (path === null) continue;
    const data = await NodeFSP.readFile(path);
    images.push({ type: "image", data: data.toString("base64"), mimeType: attachment.mimeType });
  }
  return images;
};

export const makePiNativeAdapterV2 = Effect.fn("makePiNativeAdapterV2")(function* (
  options: PiNativeAdapterV2Options,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const hostService = yield* ProviderHost.ProviderHost;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const services = yield* Effect.context<
    IdAllocator.IdAllocatorV2 | ProviderHost.ProviderHost | McpProviderSessions.McpProviderSessions
  >();

  const openSession = Effect.fn("PiNativeAdapter.openSession")(function* (
    input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
  ) {
    yield* Effect.scope;
    const nowMs = options.now ?? (() => host.Date.now());
    const at = (value = nowMs()): DateTime.Utc => DateTime.makeUnsafe(value);

    const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const threads = new Map<string, ThreadState>();
    const pendingRequests = new Map<string, PendingRequest>();
    const requestOutcome = new Map<
      string,
      { readonly decision?: ProviderApprovalDecision; readonly feedback?: string }
    >();
    const answersOutcome = new Map<string, Record<string, unknown>>();
    let activeTurn: ActiveTurn | null = null;
    let closed = false;
    let tearingDown = false;
    let nativeSequence = 0;

    const binding = resolvePiNativeModelBinding(options.settings, input.modelSelection);
    let session: OrchestrationV2ProviderSession = {
      id: input.providerSessionId,
      driver: DRIVER,
      providerInstanceId: options.instanceId,
      status: "starting",
      cwd: input.runtimePolicy.cwd ?? hostService.paths.cwd,
      model: binding.modelId,
      capabilities: PI_NATIVE_CAPABILITIES,
      extensionStatuses: [],
      createdAt: at(),
      updatedAt: at(),
      lastError: null,
    };

    const emit = (event: ProviderAdapter.ProviderAdapterV2Event): void => {
      if (closed) return;
      Queue.offerUnsafe(queue, event);
    };

    const updateSession = (
      status: OrchestrationV2ProviderSession["status"],
      lastError: string | null,
    ): void => {
      session = { ...session, status, lastError, updatedAt: at() };
      emit({ type: "provider_session.updated", driver: DRIVER, providerSession: session });
    };

    const updateThread = (
      state: ThreadState,
      patch: Partial<OrchestrationV2ProviderThread>,
    ): OrchestrationV2ProviderThread => {
      state.providerThread = { ...state.providerThread, ...patch, updatedAt: at() };
      emit({
        type: "provider_thread.updated",
        driver: DRIVER,
        providerThread: state.providerThread,
      });
      return state.providerThread;
    };

    const nativeItemId = (turn: ActiveTurn, itemId: string): string =>
      `${turn.providerTurn.id}:${itemId}`;

    const itemOrdinal = (turn: ActiveTurn, nativeId: string): number => {
      const existing = turn.itemOrdinals.get(nativeId);
      if (existing !== undefined) return existing;
      const ordinal = turn.nextItemOrdinal++;
      turn.itemOrdinals.set(nativeId, ordinal);
      return ordinal;
    };

    const itemRef = (turn: ActiveTurn, itemId: string) => {
      const nativeId = nativeItemId(turn, itemId);
      return { nativeId, strength: "strong" as const, driver: DRIVER };
    };

    const baseItem = (
      turn: ActiveTurn,
      itemId: string,
      startedAtMs: number,
      updatedAtMs: number,
    ) => {
      const nativeId = nativeItemId(turn, itemId);
      return {
        id: idAllocator.derive.turnItemFromProviderItem({ driver: DRIVER, nativeItemId: nativeId }),
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        nodeId: idAllocator.derive.nodeFromProviderItem({ driver: DRIVER, nativeItemId: nativeId }),
        providerThreadId: turn.input.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: itemRef(turn, itemId),
        parentItemId: null,
        ordinal: itemOrdinal(turn, nativeId),
        startedAt: at(startedAtMs),
        completedAt: null,
        updatedAt: at(updatedAtMs),
      };
    };

    const emitNode = (
      turn: ActiveTurn,
      itemId: string,
      kind: OrchestrationV2ExecutionNode["kind"],
      status: OrchestrationV2ExecutionNode["status"],
      startedAtMs: number,
      completedAtMs: number | null,
    ): void => {
      const nativeId = nativeItemId(turn, itemId);
      emit({
        type: "node.updated",
        driver: DRIVER,
        node: {
          id: idAllocator.derive.nodeFromProviderItem({ driver: DRIVER, nativeItemId: nativeId }),
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          parentNodeId: turn.input.rootNodeId,
          rootNodeId: turn.input.rootNodeId,
          kind,
          status,
          countsForRun: false,
          providerThreadId: turn.input.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: itemRef(turn, itemId),
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: at(startedAtMs),
          completedAt: completedAtMs === null ? null : at(completedAtMs),
        },
      });
    };

    const emitItem = (turn: ActiveTurn, item: OrchestrationV2TurnItem, open: boolean): void => {
      emit({ type: "turn_item.updated", driver: DRIVER, turnItem: item });
      if (open) turn.openItems.set(item.id, item);
      else turn.openItems.delete(item.id);
    };

    const handleStreamEvent = (
      turn: ActiveTurn,
      event: Extract<NativeSessionEvent, { type: "stream" }>,
    ): void => {
      const emittedAt = nowMs();
      if (event.kind === "assistant") {
        const open = turn.openMessages.get(event.itemId);
        const nativeId = nativeItemId(turn, event.itemId);
        const messageId =
          open?.messageId ??
          idAllocator.derive.messageFromProviderItem({ driver: DRIVER, nativeItemId: nativeId });
        const nodeId =
          open?.nodeId ??
          idAllocator.derive.nodeFromProviderItem({ driver: DRIVER, nativeItemId: nativeId });
        const createdAtMs = open?.createdAtMs ?? emittedAt;
        turn.openMessages.set(event.itemId, {
          messageId,
          nodeId,
          createdAtMs,
          text: event.text,
          streaming: !event.done,
        });
        const base = baseItem(turn, event.itemId, createdAtMs, emittedAt);
        emitNode(
          turn,
          event.itemId,
          "assistant_message",
          event.done ? "completed" : "running",
          createdAtMs,
          event.done ? emittedAt : null,
        );
        emitItem(
          turn,
          {
            ...base,
            type: "assistant_message",
            messageId,
            text: event.text,
            streaming: !event.done,
            status: event.done ? "completed" : "running",
            title: null,
            completedAt: event.done ? base.updatedAt : null,
          },
          !event.done,
        );
        const message: OrchestrationV2ConversationMessage = {
          id: messageId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          nodeId,
          role: "assistant",
          text: event.text,
          attachments: [],
          streaming: !event.done,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: at(createdAtMs),
          updatedAt: base.updatedAt,
        };
        emit({ type: "message.updated", driver: DRIVER, message });
        return;
      }
      const base = baseItem(turn, event.itemId, emittedAt, emittedAt);
      emitNode(
        turn,
        event.itemId,
        "reasoning",
        event.done ? "completed" : "running",
        emittedAt,
        event.done ? emittedAt : null,
      );
      emitItem(
        turn,
        {
          ...base,
          type: "reasoning",
          text: event.text,
          streaming: !event.done,
          status: event.done ? "completed" : "running",
          title: null,
          completedAt: event.done ? base.updatedAt : null,
        },
        !event.done,
      );
    };

    const toolStatus = (
      turn: ActiveTurn,
      event: Extract<NativeSessionEvent, { type: "tool" }>,
    ): OrchestrationV2TurnItemStatus => {
      if (event.phase !== "end") return "running";
      if (event.isError === true) return turn.interrupted ? "interrupted" : "failed";
      return "completed";
    };

    const toolItem = (
      turn: ActiveTurn,
      event: Extract<NativeSessionEvent, { type: "tool" }>,
    ): OrchestrationV2TurnItem | null => {
      const status = toolStatus(turn, event);
      const completed = event.phase === "end";
      const emittedAt = nowMs();
      const base = baseItem(turn, event.itemId, emittedAt, emittedAt);
      const shared = {
        ...base,
        status,
        title: event.toolName,
        completedAt: completed ? base.updatedAt : null,
      } as const;
      const args = event.args;
      const details = asRecord(event.result)?.["details"];

      if (event.toolName === "Bash") {
        const exitCode = numberField(details, "exitCode");
        return {
          ...shared,
          type: "command_execution",
          input: stringField(args, "command") ?? "",
          ...(event.output === undefined || event.output === "" ? {} : { output: event.output }),
          ...(event.isError === true ? { outputIndicatesFailure: true } : {}),
          ...(exitCode === undefined ? {} : { exitCode: Math.trunc(exitCode) }),
        };
      }

      if (isFileChangeTool(event.toolName)) {
        const path = stringField(args, "path") ?? stringField(details, "fileName") ?? "";
        const fileName = workspaceRelativePath(turn.input.runtimePolicy.cwd, path);
        const additions = numberField(details, "additions");
        const deletions = numberField(details, "deletions");
        const diffStr = stringField(details, "diffStr");
        const oldStr = stringField(details, "oldStr");
        const newStr = stringField(details, "newStr");
        return {
          ...shared,
          type: "file_change",
          fileName: fileName === "" ? "file" : fileName,
          ...(additions === undefined ? {} : { additions: Math.max(0, Math.trunc(additions)) }),
          ...(deletions === undefined ? {} : { deletions: Math.max(0, Math.trunc(deletions)) }),
          ...(diffStr === undefined ? {} : { diffStr }),
          ...(oldStr === undefined ? {} : { oldStr }),
          ...(newStr === undefined ? {} : { newStr }),
        };
      }

      if (isSearchTool(event.toolName)) {
        const pattern = stringField(args, "pattern");
        const detail = asRecord(event.result)?.["details"];
        const files = asRecord(detail)?.["files"];
        const greps = asRecord(detail)?.["matches"];
        const results = Array.isArray(files)
          ? files
              .filter((value): value is string => typeof value === "string" && value !== "")
              .map((fileName) => ({ fileName }))
          : Array.isArray(greps)
            ? greps.flatMap((entry) => {
                const fileName = stringField(entry, "fileName");
                if (fileName === undefined || fileName === "") return [];
                const line = numberField(entry, "line");
                const preview = stringField(entry, "preview");
                return [
                  {
                    fileName,
                    ...(line === undefined ? {} : { line: Math.max(1, Math.trunc(line)) }),
                    ...(preview === undefined ? {} : { preview }),
                  },
                ];
              })
            : [];
        return {
          ...shared,
          type: "file_search",
          ...(pattern === undefined || pattern === "" ? {} : { pattern }),
          ...(results.length === 0 ? {} : { results }),
        };
      }

      if (event.toolName === "asktool" || event.toolName === "SubmitPlan") return null;

      if (event.toolName === "TodoWrite" && (event.phase !== "end" || event.isError !== true)) {
        return null;
      }

      return {
        ...shared,
        type: "dynamic_tool",
        toolName: event.toolName,
        input: args ?? {},
        ...(event.result === undefined ? {} : { output: event.result }),
      };
    };

    const handleToolEvent = (
      turn: ActiveTurn,
      event: Extract<NativeSessionEvent, { type: "tool" }>,
    ): void => {
      if (event.phase === "update") {
        const itemId = nativeItemId(turn, event.itemId);
        const previous = turn.streamedToolChars.get(itemId) ?? 0;
        const output = event.output ?? "";
        if (output.length <= previous) return;
        emit({
          type: "command_output.delta",
          driver: DRIVER,
          threadId: turn.input.threadId,
          itemId: idAllocator.derive.turnItemFromProviderItem({
            driver: DRIVER,
            nativeItemId: itemId,
          }),
          chunk: output.slice(previous),
        });
        turn.streamedToolChars.set(itemId, output.length);
        return;
      }
      const item = toolItem(turn, event);
      if (item === null) return;
      const emittedAt = nowMs();
      emitNode(
        turn,
        event.itemId,
        "tool_call",
        item.status,
        emittedAt,
        item.completedAt === null ? null : emittedAt,
      );
      emitItem(turn, item, item.completedAt === null);
    };

    const emitPlan = (
      turn: ActiveTurn,
      itemId: string,
      plan: OrchestrationV2PlanArtifact,
    ): void => {
      if (
        plan.kind === "todo_list" &&
        turn.state.latestTodoPlan !== null &&
        turn.state.latestTodoPlan.id !== plan.id
      ) {
        emit({
          type: "plan.updated",
          driver: DRIVER,
          plan: { ...turn.state.latestTodoPlan, status: "superseded" },
        });
      }
      if (plan.kind === "todo_list") {
        turn.state.latestTodoPlan = plan;
      }
      if (
        plan.kind === "proposed_plan" &&
        turn.state.latestProposedPlan !== null &&
        turn.state.latestProposedPlan.id !== plan.id &&
        turn.state.latestProposedPlan.status !== "completed"
      ) {
        // A plan the orchestrator already approved keeps that status; only an open one is dropped.
        emit({
          type: "plan.updated",
          driver: DRIVER,
          plan: { ...turn.state.latestProposedPlan, status: "superseded" },
        });
      }
      if (plan.kind === "proposed_plan") {
        turn.state.latestProposedPlan = plan;
      }
      emit({ type: "plan.updated", driver: DRIVER, plan });
      const emittedAt = nowMs();
      const base = baseItem(turn, itemId, emittedAt, emittedAt);
      emitNode(
        turn,
        itemId,
        plan.kind === "todo_list" ? "todo_list" : "plan",
        "completed",
        emittedAt,
        emittedAt,
      );
      if (plan.kind === "proposed_plan") {
        emitItem(
          turn,
          {
            ...base,
            type: "proposed_plan",
            planId: plan.id,
            markdown: plan.markdown,
            streaming: false,
            status: "completed",
            title: null,
            completedAt: base.updatedAt,
          },
          false,
        );
        return;
      }
      emitItem(
        turn,
        {
          ...base,
          type: "todo_list",
          planId: plan.id,
          steps: plan.steps,
          ...(plan.explanation === undefined ? {} : { explanation: plan.explanation }),
          status: "completed",
          title: null,
          completedAt: base.updatedAt,
        },
        false,
      );
    };

    const planArtifact = (
      turn: ActiveTurn,
      itemId: string,
    ): Pick<OrchestrationV2PlanArtifact, "id" | "threadId" | "runId" | "nodeId" | "status"> => ({
      id: PlanId.make(`plan:${nativeItemId(turn, itemId)}`),
      threadId: turn.input.threadId,
      runId: turn.input.runId,
      nodeId: idAllocator.derive.nodeFromProviderItem({
        driver: DRIVER,
        nativeItemId: nativeItemId(turn, itemId),
      }),
      status: "active",
    });

    const handleCompaction = (
      turn: ActiveTurn,
      event: Extract<NativeSessionEvent, { type: "compaction" }>,
    ): void => {
      const emittedAt = nowMs();
      const base = baseItem(turn, event.itemId, emittedAt, emittedAt);
      const running = event.status === "running";
      emitNode(
        turn,
        event.itemId,
        "system",
        running ? "running" : event.status,
        emittedAt,
        running ? null : emittedAt,
      );
      emitItem(
        turn,
        {
          ...base,
          type: "compaction",
          driver: DRIVER,
          status: event.status,
          title:
            event.status === "running"
              ? "Compacting context..."
              : event.status === "completed"
                ? "Context compacted"
                : "Context compaction failed",
          completedAt: running ? null : base.updatedAt,
          ...(event.summary === undefined ? {} : { summary: event.summary }),
          ...(event.beforeTokenCount === undefined
            ? {}
            : { beforeTokenCount: event.beforeTokenCount }),
          ...(event.afterTokenCount === undefined
            ? {}
            : { afterTokenCount: event.afterTokenCount }),
        },
        running,
      );
    };

    const handleSubagent = (
      turn: ActiveTurn,
      event: Extract<NativeSessionEvent, { type: "subagent" }>,
    ): void => {
      const record = event.record;
      const itemId = `subagent:${record.id}`;
      const subagentId = idAllocator.derive.nodeFromProviderItem({
        driver: DRIVER,
        nativeItemId: nativeItemId(turn, itemId),
      });
      const status = subagentStatus(record.status);
      const finished = isSettledSubagent(status);
      const wasRunning = turn.runningSubagents.size > 0;
      if (finished) turn.runningSubagents.delete(record.id);
      else turn.runningSubagents.add(record.id);
      const running = turn.runningSubagents.size > 0;
      if (running !== wasRunning) {
        emit({
          type: "background_work.updated",
          driver: DRIVER,
          providerTurnId: turn.providerTurn.id,
          pending: running,
        });
      }
      const subagent: OrchestrationV2Subagent = {
        id: subagentId,
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        parentNodeId: turn.input.rootNodeId,
        origin: "provider_native",
        createdBy: "agent",
        driver: DRIVER,
        providerInstanceId: options.instanceId,
        providerThreadId: turn.input.providerThread.id,
        childThreadId: null,
        nativeTaskRef: itemRef(turn, itemId),
        prompt: record.prompt,
        title: record.title,
        model: record.model,
        status,
        ...(record.progress === undefined ? {} : { progress: record.progress }),
        result: record.result,
        startedAt: at(record.startedAtMs),
        completedAt: finished ? at(record.completedAtMs ?? nowMs()) : null,
        updatedAt: at(record.updatedAtMs),
      };
      turn.subagents.set(record.id, subagent);
      emit({ type: "subagent.updated", driver: DRIVER, subagent });
      const base = baseItem(turn, itemId, record.startedAtMs, record.updatedAtMs);
      emitNode(
        turn,
        itemId,
        "subagent",
        finished ? (status === "failed" ? "failed" : "completed") : "running",
        record.startedAtMs,
        finished ? (record.completedAtMs ?? nowMs()) : null,
      );
      emitItem(
        turn,
        {
          ...base,
          type: "subagent",
          subagentId,
          origin: "provider_native",
          driver: DRIVER,
          providerInstanceId: options.instanceId,
          childThreadId: null,
          prompt: record.prompt,
          ...(record.progress === undefined ? {} : { progress: record.progress }),
          result: record.result,
          status,
          title: record.title,
          completedAt: finished ? base.updatedAt : null,
        },
        !finished,
      );
    };

    const handleRetry = (
      turn: ActiveTurn,
      event: Extract<NativeSessionEvent, { type: "retry" }>,
    ): void => {
      const emittedAt = nowMs();
      const itemId = TERMINAL_FAILURE_ITEM;
      const base = baseItem(turn, itemId, emittedAt, emittedAt);
      const status: OrchestrationV2TurnItemStatus =
        event.event.status === "running"
          ? "running"
          : event.event.status === "completed"
            ? "completed"
            : event.event.status === "aborted"
              ? "interrupted"
              : "failed";
      emitItem(
        turn,
        {
          ...makeProviderRetryTurnItem({
            driver: DRIVER,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: base.nodeId,
            providerThreadId: turn.input.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            itemOrdinal: base.ordinal,
            failure: event.event.failure,
            retry: {
              attempt: event.event.attempt,
              maxAttempts: event.event.maxAttempts,
              retryDelayMs: event.event.delayMs,
            },
            status,
            startedAt: DateTime.makeUnsafe(emittedAt),
            updatedAt: DateTime.makeUnsafe(emittedAt),
          }),
          // Retry progress and the terminal failure must land on one item, not two rows.
          id: base.id,
          nodeId: base.nodeId,
          nativeItemRef: base.nativeItemRef,
        },
        status === "running",
      );
    };

    const handleUsage = (
      turn: ActiveTurn,
      event: Extract<NativeSessionEvent, { type: "usage" }>,
    ): void => {
      turn.providerTurn = { ...turn.providerTurn, tokenUsage: event.usage };
      emit({
        type: "provider_turn.updated",
        driver: DRIVER,
        threadId: turn.input.threadId,
        providerTurn: turn.providerTurn,
      });
      updateThread(turn.state, {
        contextUsage: {
          usedTokens: event.usage.usedTokens,
          ...(event.usage.maxTokens == null ? {} : { maxTokens: event.usage.maxTokens }),
          inputTokens: event.usage.inputTokens ?? 0,
          cachedInputTokens: event.usage.cachedInputTokens ?? 0,
          outputTokens: event.usage.outputTokens ?? 0,
        },
      });
    };

    const handleRuntimeEvent = (state: ThreadState, event: NativeSessionEvent): void => {
      if (event.type === "goal_updated") {
        state.goal = event.goal;
        updateThread(state, { goal: event.goal });
        return;
      }
      const turn = state.activeTurn ?? state.lastTurn;
      if (turn === null) return;
      switch (event.type) {
        case "stream":
          handleStreamEvent(turn, event);
          return;
        case "tool":
          handleToolEvent(turn, event);
          return;
        case "plan_submitted":
          emitPlan(turn, event.itemId, {
            ...planArtifact(turn, event.itemId),
            kind: "proposed_plan",
            markdown: event.markdown,
          });
          return;
        case "todo_updated": {
          const steps = event.steps.map((step) => ({
            id: step.id === "" ? "step" : step.id,
            text: step.text === "" ? step.id || "step" : step.text,
            status: step.status,
          }));
          emitPlan(turn, event.itemId, {
            ...planArtifact(turn, event.itemId),
            kind: "todo_list",
            status: steps.every((step) => step.status === "completed") ? "completed" : "active",
            steps,
            ...(event.explanation === undefined ? {} : { explanation: event.explanation }),
          });
          return;
        }
        case "compaction":
          handleCompaction(turn, event);
          return;
        case "subagent":
          handleSubagent(turn, event);
          return;
        case "retry":
          handleRetry(turn, event);
          return;
        case "usage":
          handleUsage(turn, event);
          return;
        case "steer":
          emit({
            type: "steer.updated",
            driver: DRIVER,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            messageId: MessageId.make(event.messageId),
            status: event.status,
          });
          return;
        case "phase":
          emit({
            type: "turn_phase.updated",
            driver: DRIVER,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            phase: event.phase,
            ...(event.detail === undefined ? {} : { detail: event.detail }),
          });
          return;
      }
    };

    const settlePending = (
      pending: PendingRequest,
      outcome: {
        readonly status: "resolved" | "cancelled";
        readonly decision?: ProviderApprovalDecision;
        readonly feedback?: string;
        readonly answers?: Record<string, unknown>;
      },
    ): void => {
      if (!pendingRequests.delete(pending.requestId)) return;
      const resolvedAt = at();
      emit({
        type: "runtime_request.updated",
        driver: DRIVER,
        threadId: pending.node.threadId,
        runtimeRequest: {
          ...pending.runtimeRequest,
          status: outcome.status,
          resolvedAt,
          responseCapability: { type: "not_resumable", reason: "This request has ended." },
          ...(outcome.decision === undefined ? {} : { decision: outcome.decision }),
          ...(outcome.feedback === undefined ? {} : { feedback: outcome.feedback }),
          ...(outcome.answers === undefined ? {} : { answers: outcome.answers }),
        },
      });
      emit({
        type: "node.updated",
        driver: DRIVER,
        node: {
          ...pending.node,
          status: outcome.status === "resolved" ? "completed" : "cancelled",
          completedAt: resolvedAt,
        },
      });
      const item: OrchestrationV2TurnItem = {
        ...pending.item,
        status: outcome.status === "resolved" ? "completed" : "cancelled",
        completedAt: resolvedAt,
        updatedAt: resolvedAt,
      } as OrchestrationV2TurnItem;
      emit({ type: "turn_item.updated", driver: DRIVER, turnItem: item });
    };

    const registerPending = (
      turn: ActiveTurn,
      input: {
        readonly requestId: RuntimeRequestId;
        readonly itemId: string;
        readonly kind: OrchestrationV2RuntimeRequest["kind"];
        readonly item: OrchestrationV2TurnItem;
        readonly nodeKind: OrchestrationV2ExecutionNode["kind"];
      },
    ): {
      readonly promise: Promise<void>;
      readonly cancel: () => void;
    } => {
      let finish: (outcome: {
        readonly cancelled?: boolean;
        readonly decision?: ProviderApprovalDecision;
        readonly feedback?: string;
        readonly answers?: Record<string, unknown>;
      }) => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        finish = (outcome) => {
          settlePending(
            pending,
            outcome.cancelled === true
              ? { status: "cancelled" }
              : {
                  status: "resolved",
                  ...(outcome.decision === undefined ? {} : { decision: outcome.decision }),
                  ...(outcome.feedback === undefined ? {} : { feedback: outcome.feedback }),
                  ...(outcome.answers === undefined ? {} : { answers: outcome.answers }),
                },
          );
          resolve();
        };
      });
      const createdAt = at();
      const nativeId = nativeItemId(turn, input.itemId);
      const node: OrchestrationV2ExecutionNode = {
        id: idAllocator.derive.approvalNode({ requestId: input.requestId }),
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        parentNodeId: turn.input.rootNodeId,
        rootNodeId: turn.input.rootNodeId,
        kind: input.nodeKind,
        status: "waiting",
        countsForRun: false,
        providerThreadId: turn.input.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: { driver: DRIVER, nativeId, strength: "strong" },
        runtimeRequestId: input.requestId,
        checkpointScopeId: null,
        startedAt: createdAt,
        completedAt: null,
      };
      const runtimeRequest: OrchestrationV2RuntimeRequest = {
        id: input.requestId,
        nodeId: node.id,
        providerTurnId: turn.providerTurn.id,
        nativeRequestRef: { driver: DRIVER, nativeId, strength: "strong" },
        kind: input.kind,
        status: "pending",
        responseCapability: {
          type: "live",
          providerSessionId: session.id,
          supportsFeedback: true,
        },
        createdAt,
        resolvedAt: null,
      };
      const pending: PendingRequest = {
        requestId: input.requestId,
        runtimeRequest,
        node,
        item: input.item,
        resolve: (values) => finish(values),
        cancel: () => finish({ cancelled: true }),
      };
      pendingRequests.set(input.requestId, pending);
      emit({
        type: "runtime_request.updated",
        driver: DRIVER,
        threadId: turn.input.threadId,
        runtimeRequest,
      });
      emit({ type: "node.updated", driver: DRIVER, node });
      emitItem(turn, input.item, true);
      return { promise, cancel: pending.cancel };
    };

    const requestApproval = async (
      request: ToolApprovalRequest,
      signal?: AbortSignal,
    ): Promise<ToolApprovalResponse> => {
      const turn = activeTurn;
      if (turn === null) return { decision: "cancel" };
      const itemId = `approval:${request.requestId}`;
      const requestId = RuntimeRequestId.make(`runtime-request:${DRIVER}:${itemId}`);
      const emittedAt = nowMs();
      const base = baseItem(turn, itemId, emittedAt, emittedAt);
      const item: TurnItemOf<"approval_request"> = {
        ...base,
        type: "approval_request",
        requestId,
        requestKind: providerRequestKind(request.risk),
        status: "waiting",
        title: request.summary,
        prompt: request.summary,
        reason: request.detail,
      };
      const registration = registerPending(turn, {
        requestId,
        itemId,
        kind: providerRequestKind(request.risk),
        item,
        nodeKind: "approval_request",
      });
      let aborted = false;
      let releaseAbort: () => void = () => undefined;
      const abortGate = new Promise<void>((resolve) => {
        releaseAbort = resolve;
      });
      const onAbort = (): void => {
        if (aborted) return;
        aborted = true;
        registration.cancel();
        releaseAbort();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
      await Promise.race([registration.promise, abortGate]);
      signal?.removeEventListener("abort", onAbort);
      if (aborted) return { decision: "cancel" };
      const outcome = requestOutcome.get(requestId);
      requestOutcome.delete(requestId);
      if (outcome === undefined) return { decision: "cancel" };
      return {
        decision: outcome.decision ?? "decline",
        ...(outcome.feedback === undefined ? {} : { feedback: outcome.feedback }),
      };
    };

    const requestUserInput = async (
      input: NativeUserInputRequest,
    ): Promise<Record<string, unknown>> => {
      const turn = activeTurn;
      if (turn === null) return {};
      const requestId = RuntimeRequestId.make(`runtime-request:${DRIVER}:${input.itemId}`);
      const emittedAt = nowMs();
      const base = baseItem(turn, input.itemId, emittedAt, emittedAt);
      const item: TurnItemOf<"user_input_request"> = {
        ...base,
        type: "user_input_request",
        requestId,
        questions: [...input.questions],
        status: "waiting",
        title: input.questions[0]?.header ?? "Question",
      };
      const registration = registerPending(turn, {
        requestId,
        itemId: input.itemId,
        kind: "user_input",
        item,
        nodeKind: "user_input_request",
      });
      let aborted = false;
      let releaseAbort: () => void = () => undefined;
      const abortGate = new Promise<void>((resolve) => {
        releaseAbort = resolve;
      });
      const onAbort = (): void => {
        if (aborted) return;
        aborted = true;
        registration.cancel();
        releaseAbort();
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted === true) onAbort();
      await Promise.race([registration.promise, abortGate]);
      input.signal?.removeEventListener("abort", onAbort);
      const answers = answersOutcome.get(requestId) ?? {};
      answersOutcome.delete(requestId);
      return answers;
    };

    const registerThread = (
      args: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
    ): OrchestrationV2ProviderThread => {
      if (closed) throw new Error("The Pi Native session is closed.");
      const existing = args.existingProviderThread;
      if (
        existing !== undefined &&
        (existing.driver !== DRIVER || existing.providerInstanceId !== options.instanceId)
      ) {
        throw new Error("This thread belongs to another Pi Native provider instance.");
      }
      const known = existing === undefined ? undefined : threads.get(existing.id);
      if (known !== undefined) {
        known.modelSelection = args.modelSelection;
        known.policy = args.runtimePolicy;
        known.appThreadId = args.threadId;
        return updateThread(known, {
          status: known.runtime === null ? "not_loaded" : "idle",
          providerSessionId: session.id,
        });
      }
      const nativeThreadId =
        existing?.nativeThreadRef?.nativeId ??
        `pi-native:${options.instanceId}:${++nativeSequence}`;
      const createdAt = at();
      // The run's provider thread row is the identity the orchestrator tracks; adopt it
      // instead of minting a second row it would never see.
      const providerThread: OrchestrationV2ProviderThread =
        existing === undefined
          ? {
              id: idAllocator.derive.providerThread({
                driver: DRIVER,
                providerInstanceId: options.instanceId,
                nativeThreadId,
              }),
              driver: DRIVER,
              providerInstanceId: options.instanceId,
              providerSessionId: session.id,
              appThreadId: args.threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver: DRIVER, nativeId: nativeThreadId, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "not_loaded",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
            }
          : {
              ...existing,
              driver: DRIVER,
              providerInstanceId: options.instanceId,
              providerSessionId: session.id,
              appThreadId: args.threadId,
              nativeThreadRef: { driver: DRIVER, nativeId: nativeThreadId, strength: "strong" },
              nativeConversationHeadRef: existing.nativeConversationHeadRef ?? null,
              status: "not_loaded",
              updatedAt: createdAt,
            };
      threads.set(providerThread.id, {
        providerThread,
        runtime: null,
        modelSelection: args.modelSelection,
        policy: args.runtimePolicy,
        appThreadId: args.threadId,
        contextText: undefined,
        activeTurn: null,
        lastTurn: null,
        latestTodoPlan: null,
        latestProposedPlan: null,
        goal: existing?.goal ?? null,
      });
      emit({ type: "provider_thread.updated", driver: DRIVER, providerThread });
      return providerThread;
    };

    const findThread = (providerThread: OrchestrationV2ProviderThread): ThreadState | undefined => {
      const known = threads.get(providerThread.id);
      if (known !== undefined) return known;
      const nativeId = providerThread.nativeThreadRef?.nativeId;
      if (nativeId === undefined) return undefined;
      return [...threads.values()].find(
        (state) => state.providerThread.nativeThreadRef?.nativeId === nativeId,
      );
    };

    const threadFor = (providerThread: OrchestrationV2ProviderThread): ThreadState => {
      const state = findThread(providerThread);
      if (state === undefined)
        throw new Error("This Pi Native thread is not loaded in the session.");
      return state;
    };

    const ensureRuntime = async (state: ThreadState): Promise<NativePiSessionRuntime> => {
      if (state.runtime !== null) {
        state.runtime.applyRuntimePolicy(state.policy);
        state.runtime.applyModelSelection(state.modelSelection);
        // The adapter owns the goal across runtimes, so a reused runtime adopts it silently.
        if (state.runtime.goal !== state.goal) state.runtime.setGoal(state.goal, { emit: false });
        return state.runtime;
      }
      updateSession("starting", null);
      const mcpSession = await Effect.runPromiseWith(services)(mcpSessions.read(state.appThreadId));
      const runtime = await NativePiSessionRuntime.create({
        settings: options.settings,
        modelSelection: state.modelSelection,
        runtimePolicy: state.policy,
        ...(state.goal === null ? {} : { initialGoal: state.goal }),
        threadId: state.appThreadId,
        ...(mcpSession === undefined ? {} : { mcpSession }),
        ...(state.contextText === undefined ? {} : { contextText: state.contextText }),
        readOnlyRoots: [hostService.paths.attachmentsDir],
        onEvent: (event) => handleRuntimeEvent(state, event),
        requestApproval,
        requestUserInput,
        now: nowMs,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.streamFn === undefined ? {} : { streamFn: options.streamFn }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        ...(options.scheduleTimer === undefined ? {} : { scheduleTimer: options.scheduleTimer }),
        ...(options.random === undefined ? {} : { random: options.random }),
      });
      state.runtime = runtime;
      return runtime;
    };

    const finishTurn = async (
      turn: ActiveTurn,
      outcome: NativeTurnOutcome | null,
      forced?: "cancelled",
    ): Promise<void> => {
      if (turn.settled) return;
      turn.settled = true;
      const state = turn.state;
      const status =
        forced ??
        (outcome?.status === "interrupted"
          ? "interrupted"
          : outcome?.status === "failed"
            ? "failed"
            : "completed");
      const failure = outcome?.failure ?? null;
      turn.interrupted = status === "interrupted" || status === "cancelled";
      turn.failure = failure;
      turn.outputTruncated = outcome?.outputTruncated ?? false;
      const completedAt = at();

      for (const item of turn.openItems.values()) {
        emitItem(
          turn,
          {
            ...item,
            status:
              status === "completed" ? "completed" : status === "failed" ? "failed" : "interrupted",
            ...(item.type === "assistant_message" || item.type === "reasoning"
              ? { streaming: false }
              : {}),
            completedAt,
            updatedAt: completedAt,
          } as OrchestrationV2TurnItem,
          false,
        );
      }
      for (const message of turn.openMessages.values()) {
        if (!message.streaming) continue;
        emit({
          type: "message.updated",
          driver: DRIVER,
          message: {
            id: message.messageId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: message.nodeId,
            role: "assistant",
            text: message.text,
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: at(message.createdAtMs),
            updatedAt: completedAt,
          },
        });
      }
      // A completed turn leaves genuinely running background subagents alone; they settle later.
      for (const subagent of turn.subagents.values()) {
        if (status === "completed" || isSettledSubagent(subagent.status)) continue;
        emit({
          type: "subagent.updated",
          driver: DRIVER,
          subagent: {
            ...subagent,
            status: status === "failed" ? "failed" : "interrupted",
            completedAt,
            updatedAt: completedAt,
          },
        });
      }
      for (const pending of pendingRequests.values()) {
        if (pending.runtimeRequest.providerTurnId === turn.providerTurn.id) pending.cancel();
      }

      turn.providerTurn = {
        ...turn.providerTurn,
        status:
          status === "completed" ? "completed" : status === "failed" ? "failed" : "interrupted",
        completedAt,
      };
      emit({
        type: "provider_turn.updated",
        driver: DRIVER,
        threadId: turn.input.threadId,
        providerTurn: turn.providerTurn,
      });
      updateThread(state, {
        status: "idle",
        ...(state.providerThread.nativeConversationHeadRef === null &&
        state.providerThread.nativeThreadRef !== null
          ? { nativeConversationHeadRef: state.providerThread.nativeThreadRef }
          : {}),
      });
      updateSession(failure === null ? "ready" : "error", failure?.failure.message ?? null);

      if (failure === null) {
        emit({
          type: "turn.terminal",
          driver: DRIVER,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          runOrdinal: Math.max(1, turn.input.runOrdinal),
          status:
            status === "completed"
              ? "completed"
              : status === "interrupted"
                ? "interrupted"
                : "cancelled",
          failure: null,
          ...(turn.outputTruncated
            ? { reason: "The reply reached the model's output limit." }
            : {}),
          threadDisposition: "reusable",
        });
      } else {
        const failureItemId = TERMINAL_FAILURE_ITEM;
        const base = baseItem(turn, failureItemId, nowMs(), nowMs());
        const failureItem: TurnItemOf<"error"> = {
          ...base,
          type: "error",
          status: "failed",
          title: failure.failure.class === "usage_limit" ? "Usage limit reached" : "Provider error",
          completedAt: base.updatedAt,
          failure: failure.failure,
          ...(failure.retry === null ? {} : { retry: failure.retry }),
        };
        emitItem(turn, failureItem, false);
        emit({
          type: "turn.terminal",
          driver: DRIVER,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          runOrdinal: Math.max(1, turn.input.runOrdinal),
          failureItemOrdinal: base.ordinal,
          status: "failed",
          failure: failure.failure,
          ...(failure.retry === null ? {} : { retry: failure.retry }),
          ...(failure.retryStartedAtMs === null
            ? {}
            : { retryStartedAt: at(failure.retryStartedAtMs) }),
          threadDisposition: "reusable",
        });
      }
      state.activeTurn = null;
      if (activeTurn === turn) activeTurn = null;
      turn.resolveDone();
    };

    // `/goal` and `/compact` settle without a provider request, but the turn still needs output.
    const emitDirectAssistantReply = (turn: ActiveTurn, text: string): void => {
      handleStreamEvent(turn, {
        type: "stream",
        itemId: "control:reply",
        kind: "assistant",
        text,
        done: true,
      });
    };

    const formatGoalStatusReply = (goal: OrchestrationV2ProviderGoal | null): string => {
      if (goal === null) return "No goal is set. Use /goal <objective> to start one.";
      return [
        `Goal: ${goal.objective}`,
        `Status: ${goal.status}`,
        `Checks: ${goal.checks ?? 0}`,
        `Tokens used: ${goal.tokensUsed ?? 0}`,
        `Time used: ${goal.timeUsedSeconds ?? 0}s`,
        ...(goal.lastCheck === undefined ? [] : [`Last check: ${goal.lastCheck}`]),
      ].join("\n");
    };

    const runTurn = async (turn: ActiveTurn): Promise<void> => {
      try {
        const runtime = await ensureRuntime(turn.state);
        if (turn.interrupted) {
          await finishTurn(turn, { status: "interrupted", failure: null, outputTruncated: false });
          return;
        }
        const continuation =
          turn.input.restartContinuationOfRunId !== undefined || turn.input.resume === true;
        const goalCommand = continuation ? null : parseGoalCommand(turn.input.message);
        if (goalCommand !== null) {
          switch (goalCommand.type) {
            case "show":
              emitDirectAssistantReply(
                turn,
                formatGoalStatusReply(turn.state.runtime?.goal ?? turn.state.goal),
              );
              await finishTurn(turn, {
                status: "completed",
                failure: null,
                outputTruncated: false,
              });
              return;
            case "clear":
              if (turn.state.goal === null) {
                emitDirectAssistantReply(turn, "No goal is set.");
              } else {
                turn.state.goal = null;
                turn.state.runtime?.setGoal(null, { emit: false });
                updateThread(turn.state, { goal: null });
                emitDirectAssistantReply(turn, "Goal cleared.");
              }
              await finishTurn(turn, {
                status: "completed",
                failure: null,
                outputTruncated: false,
              });
              return;
            case "pause":
              if (turn.state.goal === null) {
                emitDirectAssistantReply(turn, "No goal is set.");
              } else {
                const paused: OrchestrationV2ProviderGoal = {
                  ...turn.state.goal,
                  status: "paused",
                };
                turn.state.goal = paused;
                turn.state.runtime?.setGoal(paused, { emit: false });
                updateThread(turn.state, { goal: paused });
                emitDirectAssistantReply(turn, "Goal paused. Send /goal resume to continue.");
              }
              await finishTurn(turn, {
                status: "completed",
                failure: null,
                outputTruncated: false,
              });
              return;
            case "resume": {
              const current = turn.state.goal;
              if (current === null) {
                emitDirectAssistantReply(
                  turn,
                  "No goal is set. Use /goal <objective> to start one.",
                );
                await finishTurn(turn, {
                  status: "completed",
                  failure: null,
                  outputTruncated: false,
                });
                return;
              }
              const resumed: OrchestrationV2ProviderGoal = { ...current, status: "active" };
              turn.state.goal = resumed;
              runtime.setGoal(resumed, { emit: false });
              updateThread(turn.state, { goal: resumed });
              const outcome = await runtime.runTurn({
                text: `Resume working on the active goal: ${resumed.objective}`,
              });
              await finishTurn(turn, outcome);
              return;
            }
            case "set": {
              const created: OrchestrationV2ProviderGoal = {
                objective: goalCommand.objective,
                status: "active",
                tokensUsed: 0,
                timeUsedSeconds: 0,
                checks: 0,
              };
              turn.state.goal = created;
              runtime.setGoal(created, { emit: false });
              updateThread(turn.state, { goal: created });
              const outcome = await runtime.runTurn({
                text: `Start working on the goal: ${created.objective}`,
              });
              await finishTurn(turn, outcome);
              return;
            }
          }
        }
        if (!continuation) {
          const compactCommand = parsePiNativeCompactCommand(turn.input.message);
          if (compactCommand !== null) {
            await runtime.compactManually(compactCommand.instructions);
            await finishTurn(turn, {
              status: "completed",
              failure: null,
              outputTruncated: false,
            });
            return;
          }
        }
        const workflowCommand = continuation
          ? null
          : parsePiNativeWorkflowCommand(turn.input.message.text);
        const text = await Effect.runPromiseWith(services)(
          providerMessageTextWithAttachmentPaths({
            text: workflowCommand?.promptText ?? turn.input.message.text,
            attachments: turn.input.message.attachments,
            resolveAttachmentPath: hostService.resolveAttachmentPath,
            ...(hostService.resolveExtractedTextPath === undefined
              ? {}
              : { resolveExtractedTextPath: hostService.resolveExtractedTextPath }),
          }),
        );
        // Only a binding that accepts images gets inline content; every other
        // model receives the safe attachment paths in the prompt text instead.
        const resolvedTurnBinding = resolvePiNativeModelBinding(
          options.settings,
          turn.input.modelSelection,
        );
        const images = resolvedTurnBinding.supportsImages
          ? await readAttachmentImages(
              turn.input.message.attachments,
              hostService.resolveAttachmentPath,
            )
          : [];
        if (turn.interrupted) {
          await finishTurn(turn, { status: "interrupted", failure: null, outputTruncated: false });
          return;
        }
        const outcome = await runtime.runTurn({
          text,
          ...(images.length === 0 ? {} : { images }),
          ...(workflowCommand === null
            ? {}
            : {
                workflowDirective: workflowCommand.systemDirective,
                boostThinking: workflowCommand.boostThinking,
              }),
        });
        await finishTurn(turn, outcome);
      } catch (cause) {
        await finishTurn(turn, {
          status: "failed",
          failure: {
            failure: makeProviderFailure({
              class: "provider_error",
              message: cause instanceof Error ? cause.message : "The Pi Native turn failed.",
              retryable: false,
            }),
            retry: null,
            retryStartedAtMs: null,
          },
          outputTruncated: false,
        });
      }
    };

    // `/compact` is a turn of its own: the orchestrator only settles the run on `turn.terminal`.
    const runCompactionTurn = async (turn: ActiveTurn): Promise<void> => {
      try {
        const runtime = await ensureRuntime(turn.state);
        if (turn.interrupted) {
          await finishTurn(turn, { status: "interrupted", failure: null, outputTruncated: false });
          return;
        }
        await runtime.compactManually();
        await finishTurn(turn, { status: "completed", failure: null, outputTruncated: false });
      } catch (cause) {
        await finishTurn(turn, {
          status: "failed",
          failure: {
            failure: makeProviderFailure({
              class: "provider_error",
              message: cause instanceof Error ? cause.message : "The Pi Native compaction failed.",
              retryable: false,
            }),
            retry: null,
            retryStartedAtMs: null,
          },
          outputTruncated: false,
        });
      }
    };

    const beginTurn = (
      turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      run: (turn: ActiveTurn) => Promise<void> = runTurn,
    ): void => {
      const state = findThread(turnInput.providerThread);
      if (state === undefined) {
        throw new Error("Start a turn on a registered Pi Native thread.");
      }
      state.providerThread = { ...state.providerThread, id: turnInput.providerThread.id };
      if (activeTurn !== null) throw new Error("A Pi Native turn is already running.");
      const nativeTurnId = `${state.providerThread.nativeThreadRef?.nativeId ?? state.providerThread.id}:${turnInput.providerTurnOrdinal}`;
      const providerTurn: OrchestrationV2ProviderTurn = {
        id: idAllocator.derive.providerTurn({ driver: DRIVER, nativeTurnId }),
        providerThreadId: turnInput.providerThread.id,
        nodeId: turnInput.rootNodeId,
        runAttemptId: turnInput.attemptId,
        nativeTurnRef: { driver: DRIVER, nativeId: nativeTurnId, strength: "strong" },
        ordinal: Math.max(1, turnInput.providerTurnOrdinal),
        status: "running",
        model: resolvePiNativeModelBinding(options.settings, turnInput.modelSelection).modelId,
        startedAt: at(),
        completedAt: null,
      };
      let resolveDone: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const turn: ActiveTurn = {
        state,
        input: turnInput,
        providerTurn,
        startedAtMs: nowMs(),
        itemOrdinals: new Map(),
        openItems: new Map(),
        openMessages: new Map(),
        subagents: new Map(),
        runningSubagents: new Set(),
        streamedToolChars: new Map(),
        // Item ordinals are unique per turn and never 0, which `failureItemOrdinal` requires.
        nextItemOrdinal: Math.max(1, turnInput.providerTurnOrdinal) * 100 + 1,
        interrupted: false,
        failure: null,
        outputTruncated: false,
        settled: false,
        done,
        resolveDone,
      };
      state.policy = turnInput.runtimePolicy;
      // Leaving plan mode settles its plan: a later plan must not supersede an approved one.
      if (turnInput.runtimePolicy.interactionMode === "default") {
        state.latestProposedPlan = null;
      }
      state.modelSelection = turnInput.modelSelection;
      const contextText = appContextText(turnInput.appContext);
      if (contextText !== undefined) {
        state.contextText = contextText;
        state.runtime?.applyContextText(contextText);
      }
      state.activeTurn = turn;
      state.lastTurn = turn;
      activeTurn = turn;
      emit({
        type: "provider_turn.updated",
        driver: DRIVER,
        threadId: turnInput.threadId,
        providerTurn,
      });
      updateThread(state, {
        status: "active",
        providerSessionId: session.id,
        firstRunOrdinal: state.providerThread.firstRunOrdinal ?? Math.max(1, turnInput.runOrdinal),
        lastRunOrdinal: Math.max(1, turnInput.runOrdinal),
      });
      updateSession("running", null);
      void run(turn);
    };

    const historyMessageId = (state: ThreadState, index: number): MessageId =>
      idAllocator.derive.messageFromProviderItem({
        driver: DRIVER,
        nativeItemId: `${state.providerThread.nativeThreadRef?.nativeId ?? state.providerThread.id}:history:${index}`,
      });

    const snapshotOf = (
      state: ThreadState,
      turnLimit?: number,
    ): ProviderAdapter.ProviderAdapterV2ThreadSnapshot => {
      const snapshot = state.runtime?.getSnapshot() ?? { messages: [], turnBoundaries: [] };
      const limit =
        turnLimit === undefined
          ? snapshot.messages.length
          : (snapshot.turnBoundaries[turnLimit] ?? snapshot.messages.length);
      const messages = snapshot.messages.slice(0, limit);
      const reasoningMessageIds = messages.flatMap((message, index) =>
        message.role === "assistant" && message.reasoning.trim() !== ""
          ? [historyMessageId(state, index)]
          : [],
      );
      return {
        providerThread: state.providerThread,
        providerTurns: [],
        messages: messages.map((message, index) => ({
          id: historyMessageId(state, index),
          threadId: state.appThreadId,
          runId: null,
          nodeId: null,
          role: message.role,
          text: message.text,
          attachments: [],
          streaming: false,
          createdBy: message.role === "user" ? "user" : "agent",
          creationSource: "provider",
          createdAt: at(message.timestamp),
          updatedAt: at(message.timestamp),
        })),
        ...(reasoningMessageIds.length === 0 ? {} : { reasoningMessageIds }),
        runtimeRequests: [],
      };
    };

    const teardown = async (): Promise<void> => {
      if (closed || tearingDown) return;
      tearingDown = true;
      for (const pending of pendingRequests.values()) pending.cancel();
      pendingRequests.clear();
      const turn = activeTurn;
      if (turn !== null) {
        turn.interrupted = true;
        await turn.state.runtime?.abort();
        // Settlement must still reach the queue, so the session closes after it.
        await finishTurn(
          turn,
          { status: "interrupted", failure: null, outputTruncated: false },
          "cancelled",
        );
      }
      for (const state of threads.values()) {
        await state.runtime?.dispose();
        state.runtime = null;
      }
      closed = true;
      Queue.shutdownUnsafe(queue);
    };

    yield* Effect.addFinalizer(() => Effect.promise(() => teardown()).pipe(Effect.ignore));

    updateSession("ready", null);

    const runtimeService: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
      instanceId: options.instanceId,
      driver: DRIVER,
      providerSessionId: input.providerSessionId,
      providerSession: session,
      canResumeAfterRestart: false,
      backgroundTasksEndWithProcess: true,
      events: Stream.fromQueue(queue),
      hasPendingBackgroundWork: Effect.sync(
        () =>
          activeTurn !== null ||
          [...threads.values()].some(
            (state) => state.runtime?.subagents?.hasRunningSubagents() === true,
          ),
      ),
      hasPendingBackgroundWorkForThread: (providerThread, opts) =>
        Effect.sync(() => {
          const state = threads.get(providerThread.id);
          if (state === undefined) return false;
          return (
            state.activeTurn !== null ||
            (opts?.includeSubagents !== false &&
              state.runtime?.subagents?.hasRunningSubagents() === true)
          );
        }),
      getModelContextWindow: (selection) => {
        try {
          return resolvePiNativeModelBinding(options.settings, selection).model.contextWindow;
        } catch {
          return undefined;
        }
      },
      ensureThread: (args) =>
        Effect.try({
          try: () => registerThread(args),
          catch: (cause) =>
            new ProviderAdapter.ProviderAdapterEnsureThreadError({
              driver: DRIVER,
              threadId: args.threadId,
              cause,
            }),
        }),
      resumeThread: (args) =>
        Effect.try({
          try: () =>
            registerThread({
              threadId: args.threadId ?? args.providerThread.appThreadId ?? input.threadId,
              modelSelection: args.modelSelection ?? input.modelSelection,
              runtimePolicy: args.runtimePolicy ?? input.runtimePolicy,
              existingProviderThread: args.providerThread,
            }),
          catch: (cause) =>
            new ProviderAdapter.ProviderAdapterResumeThreadError({
              driver: DRIVER,
              providerSessionId: input.providerSessionId,
              providerThreadId: args.providerThread.id,
              cause,
            }),
        }),
      injectHistory: Effect.fn("PiNativeAdapter.injectHistory")(function* (args) {
        const state = yield* Effect.try({
          try: () => threadFor(args.providerThread),
          catch: (cause) =>
            new ProviderAdapter.ProviderAdapterProtocolError({
              driver: DRIVER,
              detail: "Pi Native cannot inject history into a thread it has not loaded.",
              cause,
            }),
        });
        const runtime = yield* Effect.promise(() => ensureRuntime(state));
        yield* Effect.sync(() => {
          runtime.rehydrateFromHistory(args.messages, args.context);
          state.contextText = args.context;
        });
        return true;
      }),
      startTurn: (args) =>
        Effect.try({
          try: () => beginTurn(args),
          catch: (cause) =>
            new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: DRIVER,
              threadId: args.threadId,
              providerThreadId: args.providerThread.id,
              runId: args.runId,
              cause,
            }),
        }),
      compactThread: Effect.fn("PiNativeAdapter.compactThread")(function* (args) {
        yield* Effect.try({
          try: () => threadFor(args.providerThread),
          catch: (cause) =>
            new ProviderAdapter.ProviderAdapterProtocolError({
              driver: DRIVER,
              detail: "Pi Native cannot compact a thread it has not loaded.",
              cause,
            }),
        });
        yield* Effect.sync(() => beginTurn(args, runCompactionTurn));
      }),
      steerTurn: Effect.fn("PiNativeAdapter.steerTurn")(function* (args) {
        const state = findThread(args.providerThread);
        const turn = state?.activeTurn ?? null;
        if (
          state === undefined ||
          turn === null ||
          turn.providerTurn.id !== args.providerTurnId ||
          state.runtime === null
        ) {
          return yield* new ProviderAdapter.ProviderAdapterSteerDeclinedError({
            driver: DRIVER,
            providerThreadId: args.providerThread.id,
            providerTurnId: args.providerTurnId,
          });
        }
        const text = yield* providerMessageTextWithAttachmentPaths({
          text: args.message.text,
          attachments: args.message.attachments,
          resolveAttachmentPath: hostService.resolveAttachmentPath,
          ...(hostService.resolveExtractedTextPath === undefined
            ? {}
            : { resolveExtractedTextPath: hostService.resolveExtractedTextPath }),
        });
        // Steering keeps images for a vision binding, exactly as a turn's first message does.
        const steerBinding = resolvePiNativeModelBinding(
          options.settings,
          args.modelSelection ?? state.modelSelection,
        );
        const images = steerBinding.supportsImages
          ? yield* Effect.tryPromise({
              try: () =>
                readAttachmentImages(args.message.attachments, hostService.resolveAttachmentPath),
              catch: (cause) =>
                new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: DRIVER,
                  detail: "Pi Native could not read the steering attachment images.",
                  cause,
                }),
            })
          : [];
        const accepted = yield* Effect.sync(() =>
          state.runtime === null
            ? ("declined" as const)
            : state.runtime.steer({
                messageId: args.message.messageId,
                text,
                ...(images.length === 0 ? {} : { images }),
              }),
        );
        if (accepted === "declined") {
          return yield* new ProviderAdapter.ProviderAdapterSteerDeclinedError({
            driver: DRIVER,
            providerThreadId: args.providerThread.id,
            providerTurnId: args.providerTurnId,
          });
        }
        yield* Effect.sync(() =>
          emit({
            type: "steer.updated",
            driver: DRIVER,
            threadId: args.threadId,
            runId: args.runId,
            messageId: args.message.messageId,
            status: "pending",
          }),
        );
      }),
      applyModelSelection: (args) =>
        Effect.sync(() => {
          const state = findThread(args.providerThread);
          if (state === undefined) return;
          state.modelSelection = args.modelSelection;
          const applied = state.runtime?.applyModelSelection(args.modelSelection);
          if (applied !== undefined) {
            session = { ...session, model: applied.modelId, updatedAt: at() };
            emit({ type: "provider_session.updated", driver: DRIVER, providerSession: session });
          }
        }),
      interruptTurn: (args) =>
        Effect.promise(async () => {
          const turn = findThread(args.providerThread)?.activeTurn ?? null;
          if (turn === null || turn.providerTurn.id !== args.providerTurnId) return;
          if (args.mode === "graceful") {
            const result = turn.state.runtime?.requestGracefulStop();
            if (result?.requested !== true) {
              turn.interrupted = true;
            }
            await Promise.race([turn.done, stoppedDeadline(options.scheduleTimer)]);
            return;
          }
          turn.interrupted = true;
          await turn.state.runtime?.abort();
          // A provider that never settles must not block Stop; its terminal still follows.
          await Promise.race([turn.done, stoppedDeadline(options.scheduleTimer)]);
        }),
      stopSubagent: (args) =>
        Effect.promise(async () => {
          const state = findThread(args.providerThread);
          const manager = state?.runtime?.subagents ?? null;
          if (manager === null) return undefined;
          const taskId = args.nativeTaskId.replace(/^subagent:/u, "");
          const stopped = await manager.stopSubagents([taskId]);
          const record = stopped[0];
          if (record === undefined) return undefined;
          return {
            status: "cancelled" as const,
            completedAt: at(record.completedAtMs ?? nowMs()),
            result: null,
          };
        }),
      respondToRuntimeRequest: (args) =>
        Effect.sync(() => {
          const pending = pendingRequests.get(args.requestId);
          if (pending === undefined) return;
          if (pending.runtimeRequest.kind === "user_input") {
            const answers = args.answers ?? {};
            answersOutcome.set(args.requestId, answers);
            pending.resolve({ answers });
            return;
          }
          const outcome = {
            ...(args.decision === undefined ? {} : { decision: args.decision }),
            ...(args.feedback === undefined ? {} : { feedback: args.feedback }),
          };
          requestOutcome.set(args.requestId, outcome);
          pending.resolve(outcome);
        }),
      readThreadSnapshot: (args) =>
        Effect.try({
          try: () => snapshotOf(threadFor(args.providerThread)),
          catch: (cause) =>
            new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
              driver: DRIVER,
              providerThreadId: args.providerThread.id,
              cause,
            }),
        }),
      rollbackThread: Effect.fn("PiNativeAdapter.rollbackThread")(function* (args) {
        const state = yield* Effect.try({
          try: () => threadFor(args.providerThread),
          catch: (cause) =>
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver: DRIVER,
              providerThreadId: args.providerThread.id,
              cause,
            }),
        });
        const target = args.target;
        const targetTurnCount =
          target.type === "thread_start"
            ? 0
            : (() => {
                const index = args.providerThreadTurns.findIndex(
                  (turn) => turn.id === target.providerTurn.id,
                );
                return index >= 0 ? index + 1 : Math.max(1, target.providerTurn.ordinal);
              })();
        yield* Effect.sync(() => {
          state.runtime?.truncateToTurn(targetTurnCount);
          if (targetTurnCount === 0) {
            state.latestTodoPlan = null;
            state.goal = null;
            state.runtime?.setGoal(null, { emit: false });
          }
          updateThread(state, {
            status: state.runtime === null ? "not_loaded" : "idle",
            firstRunOrdinal: targetTurnCount === 0 ? null : state.providerThread.firstRunOrdinal,
            lastRunOrdinal: targetTurnCount === 0 ? null : Math.max(1, target.appRunOrdinal),
            nativeConversationHeadRef: null,
            ...(targetTurnCount === 0 ? { goal: null } : {}),
          });
        });
        return snapshotOf(state, targetTurnCount);
      }),
      forkThread: Effect.fn("PiNativeAdapter.forkThread")(function* (args) {
        const source = yield* Effect.try({
          try: () => threadFor(args.sourceProviderThread),
          catch: (cause) =>
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver: DRIVER,
              providerThreadId: args.sourceProviderThread.id,
              cause,
            }),
        });
        const targetTurnCount =
          args.providerTurnId === undefined
            ? undefined
            : Math.max(
                1,
                (args.sourceProviderTurns?.findIndex((turn) => turn.id === args.providerTurnId) ??
                  -1) + 1,
              );
        const clone = source.runtime?.cloneForFork(targetTurnCount);
        const forked = yield* Effect.try({
          try: () =>
            registerThread({
              threadId: args.targetThreadId,
              modelSelection: args.modelSelection ?? source.modelSelection,
              runtimePolicy: args.runtimePolicy ?? source.policy,
            }),
          catch: (cause) =>
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver: DRIVER,
              providerThreadId: args.sourceProviderThread.id,
              cause,
            }),
        });
        const state = threadFor(forked);
        state.providerThread = updateThread(state, {
          forkedFrom: {
            providerThreadId: args.sourceProviderThread.id,
            ...(args.providerTurnId === undefined ? {} : { providerTurnId: args.providerTurnId }),
          },
        });
        if (clone !== undefined) {
          const runtime = yield* Effect.promise(() => ensureRuntime(state));
          yield* Effect.sync(() =>
            runtime.installMessages(clone.messages, source.contextText, clone.todos),
          );
        }
        return state.providerThread;
      }),
    };

    return runtimeService;
  });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: DRIVER,
    getCapabilities: Effect.fn("PiNativeAdapter.getCapabilities")(() =>
      Effect.succeed(PI_NATIVE_CAPABILITIES),
    ),
    planSelectionTransition: Effect.fn("PiNativeAdapter.planSelectionTransition")(() =>
      Effect.succeed(turnScopedSelectionTransition()),
    ),
    openSession: Effect.fn("PiNativeAdapter.openSession")(function* (input) {
      return yield* openSession(input).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: DRIVER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      );
    }),
  });
});

const decodePiNativeSettings = Schema.decodeSync(PiNativeSettings);

const DEFAULT_PI_NATIVE_SETTINGS = decodePiNativeSettings({});

export const PiNativeAdapterV2Driver: ProviderAdapterDriver<
  PiNativeSettings,
  PiNativeAdapterV2DriverEnv
> = {
  driverKind: DRIVER,
  configSchema: PiNativeSettings,
  defaultConfig: (): PiNativeSettings => DEFAULT_PI_NATIVE_SETTINGS,
  create: Effect.fn("PiNativeAdapterV2Driver.create")(
    function (input: ProviderAdapterDriverCreateInput<PiNativeSettings>) {
      return makePiNativeAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: DRIVER,
              instanceId: input.instanceId,
              detail: "Failed to create the Pi Native adapter.",
              cause,
            }),
        ),
      ),
  ),
};
