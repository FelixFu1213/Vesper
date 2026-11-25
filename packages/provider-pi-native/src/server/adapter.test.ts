// @effect-diagnostics nodeBuiltinImport:off -- Approval tests need a real workspace directory.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEventStream, Model, Api } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { PiNativeSettings } from "../settings.ts";
import {
  createScriptedStreamFn,
  pushScriptedTurn,
  renderScriptedTurn,
  scriptedErrorResponse,
  scriptedTextResponse,
  scriptedToolCallResponse,
  type ScriptedStep,
  type ScriptedTurn,
} from "../testing.ts";
import { makePiNativeAdapterV2, PI_NATIVE_DRIVER_KIND } from "./adapter.ts";

const instanceId = ProviderInstanceId.make("piNative");
const threadId = ThreadId.make("thread-pi-native-test");
const decodeSettings = Schema.decodeSync(PiNativeSettings);

const settings = (overrides: Partial<PiNativeSettings> = {}): PiNativeSettings =>
  decodeSettings({
    enabled: true,
    apiStyle: "openai-responses",
    apiKey: "test-key",
    autoCompact: false,
    infiniteRetry: false,
    enableSubagents: false,
    ...overrides,
  });

const modelSelection: ModelSelection = { instanceId, model: "default" };

const runtimePolicy = (
  overrides: Partial<ProviderAdapter.ProviderAdapterV2RuntimePolicy> = {},
): ProviderAdapter.ProviderAdapterV2RuntimePolicy => ({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
  ...overrides,
});

const testLayer = (cwd?: string) =>
  Layer.mergeAll(
    NodeServices.layer,
    IdAllocator.layer,
    McpProviderSessions.layer,
    TestProviderHost.layer(cwd === undefined ? {} : { cwd }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );

const makeWorkspace = async (): Promise<string> =>
  NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-native-adapter-"));

const gatedStream = () => {
  const waiting: Array<{
    readonly model: Model<Api>;
    readonly stream: AssistantMessageEventStream;
  }> = [];
  const queued: ScriptedTurn[] = [];
  let requests = 0;
  const streamFn: StreamFn = (model) => {
    requests += 1;
    const stream = createAssistantMessageEventStream();
    const turn = queued.shift();
    if (turn === undefined) waiting.push({ model, stream });
    else pushScriptedTurn(stream, model, turn, 0);
    return stream;
  };
  return {
    streamFn,
    requestCount: () => requests,
    release: (turn: ScriptedTurn) => {
      const next = waiting.shift();
      if (next === undefined) {
        queued.push(turn);
        return;
      }
      pushScriptedTurn(next.stream, next.model, turn, 0);
    },
  };
};

interface Harness {
  readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
  readonly all: ProviderAdapter.ProviderAdapterV2Event[];
  readonly policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly selection: ModelSelection;
  /** The native turn id the adapter derives for a turn ordinal. */
  readonly providerTurnNativeId: (ordinal: number) => string;
  readonly providerTurnId: (ordinal: number) => ProviderTurnId;
  readonly turnInput: (
    ordinal?: number,
    selection?: ModelSelection,
    text?: string,
  ) => Effect.Effect<ProviderAdapter.ProviderAdapterV2TurnInput>;
  readonly takeEvent: <T extends ProviderAdapter.ProviderAdapterV2Event["type"]>(
    type: T,
    predicate?: (event: Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>) => boolean,
  ) => Effect.Effect<Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>>;
}

const makeHarness = Effect.fnUntraced(function* (input: {
  readonly steps?: ReadonlyArray<ScriptedStep>;
  readonly streamFn?: StreamFn;
  readonly policy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly settings?: PiNativeSettings;
  readonly cwd?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly mcpEndpoint?: string;
  readonly appContext?: ProviderAdapter.ProviderAdapterV2TurnInput["appContext"];
}) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const policy = input.policy ?? runtimePolicy();
  const adapter = yield* makePiNativeAdapterV2({
    instanceId,
    settings: input.settings ?? settings(),
    streamFn: input.streamFn ?? createScriptedStreamFn(input.steps ?? [], { now: () => 0 }),
    now: () => 0,
    sleep: async () => undefined,
    scheduleTimer: () => () => undefined,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  if (input.mcpEndpoint !== undefined) {
    yield* (yield* McpProviderSessions.McpProviderSessions).set({
      environmentId: EnvironmentId.make("env-1"),
      threadId,
      providerSessionId: "session-1",
      providerInstanceId: instanceId,
      endpoint: input.mcpEndpoint,
      authorizationHeader: "Bearer test",
      browserToolsAvailable: true,
    });
  }
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("session-1"),
    modelSelection,
    runtimePolicy: policy,
  });
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const all: ProviderAdapter.ProviderAdapterV2Event[] = [];
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        all.push(event);
        Queue.offerUnsafe(events, event);
      }),
    ),
    Effect.forkScoped,
  );
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy: policy,
  });
  const takeEvent = Effect.fnUntraced(function* <
    T extends ProviderAdapter.ProviderAdapterV2Event["type"],
  >(
    type: T,
    predicate: (
      event: Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>,
    ) => boolean = () => true,
  ) {
    for (let index = 0; index < 200; index += 1) {
      const event = yield* Queue.take(events);
      if (
        event.type === type &&
        predicate(event as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>)
      ) {
        return event as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>;
      }
    }
    throw new Error(`No ${type} event arrived.`);
  });
  const turnInput = Effect.fnUntraced(function* (
    ordinal = 1,
    selection: ModelSelection = modelSelection,
    text = "Hello Pi",
    projectMemory?: string,
  ) {
    const now = yield* DateTime.now;
    const appThread: OrchestrationV2AppThread = {
      id: threadId,
      projectId: ProjectId.make("project-pi-native-test"),
      title: "Pi Native test",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection: selection,
      runtimeMode: policy.runtimeMode,
      interactionMode: policy.interactionMode,
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    return {
      appThread,
      threadId,
      runId: RunId.make(`run-${ordinal}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`attempt-${ordinal}`),
      rootNodeId: NodeId.make(`root-${ordinal}`),
      providerThread,
      message: {
        messageId: MessageId.make(`message-${ordinal}`),
        text,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection: selection,
      runtimePolicy: policy,
      ...(input.appContext === undefined ? {} : { appContext: input.appContext }),
      ...(projectMemory === undefined ? {} : { projectMemory }),
    } satisfies ProviderAdapter.ProviderAdapterV2TurnInput;
  });
  const providerTurnNativeId = (ordinal: number): string =>
    `${providerThread.nativeThreadRef?.nativeId ?? providerThread.id}:${Math.max(1, ordinal)}`;
  const providerTurnId = (ordinal: number): ProviderTurnId =>
    idAllocator.derive.providerTurn({
      driver: PI_NATIVE_DRIVER_KIND,
      nativeTurnId: providerTurnNativeId(ordinal),
    });
  return {
    runtime,
    providerThread,
    events,
    all,
    policy,
    selection: modelSelection,
    providerTurnNativeId,
    providerTurnId,
    turnInput,
    takeEvent,
  };
});

const startTurnOn = (
  harness: Harness,
  ordinal = 1,
): Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error> =>
  harness.turnInput(ordinal).pipe(Effect.flatMap(harness.runtime.startTurn));

const startTurnWithText = (
  harness: Harness,
  ordinal: number,
  text: string,
): Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error> =>
  harness
    .turnInput(ordinal, harness.selection, text)
    .pipe(Effect.flatMap(harness.runtime.startTurn));

const assistantTexts = (harness: Harness): string[] =>
  harness.all.flatMap((event) =>
    event.type === "message.updated" && event.message.role === "assistant"
      ? [event.message.text]
      : [],
  );

const threadGoals = (harness: Harness) =>
  harness.all.flatMap((event) =>
    event.type === "provider_thread.updated" ? [event.providerThread.goal ?? null] : [],
  );

const turnItems = (harness: Harness): ReadonlyArray<OrchestrationV2TurnItemShape> =>
  harness.all.flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []));

type OrchestrationV2TurnItemShape = Extract<
  ProviderAdapter.ProviderAdapterV2Event,
  { type: "turn_item.updated" }
>["turnItem"];

describe("makePiNativeAdapterV2", () => {
  it.effect("reports honest capabilities", () =>
    Effect.gen(function* () {
      const adapter = yield* makePiNativeAdapterV2({
        instanceId,
        settings: settings(),
        streamFn: createScriptedStreamFn([]),
        now: () => 0,
      });
      const capabilities = yield* adapter.getCapabilities();
      assert.equal(adapter.driver, PI_NATIVE_DRIVER_KIND);
      assert.isTrue(capabilities.threads.canRollbackThread);
      assert.isTrue(capabilities.threads.canForkThread);
      assert.isTrue(capabilities.turns.supportsActiveSteering);
      assert.isFalse(capabilities.turns.supportsNativeResume);
      assert.isTrue(capabilities.turns.supportsNativeGoals);
      assert.equal(capabilities.identity.nativeTurnIds, "strong");
      // One in-process session hosts a runtime per app thread.
      assert.isTrue(capabilities.sessions.supportsMultipleProviderThreadsPerSession);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("streams a text turn and reports a completed terminal", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ steps: [scriptedTextResponse("Hello from Pi")] });
      yield* startTurnOn(harness);
      const started = yield* harness.takeEvent(
        "provider_turn.updated",
        (event) => event.providerTurn.status === "running",
      );
      assert.equal(started.providerTurn.nativeTurnRef?.driver, PI_NATIVE_DRIVER_KIND);
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.equal(terminal.status, "completed");
      assert.isNull(terminal.failure);
      const messages = harness.all.flatMap((event) =>
        event.type === "message.updated" && event.message.role === "assistant"
          ? [event.message.text]
          : [],
      );
      assert.deepStrictEqual(messages, ["Hello from Pi"]);
      const assistantItems = turnItems(harness).filter((item) => item.type === "assistant_message");
      assert.isTrue(assistantItems.length > 0);
      const snapshot = yield* harness.runtime.readThreadSnapshot!({
        providerThread: harness.providerThread,
      });
      assert.deepStrictEqual(
        snapshot.messages.map((message) => message.role),
        ["user", "assistant"],
      );
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("asks for approval before a write and runs it when accepted", () =>
    Effect.gen(function* () {
      const cwd = yield* Effect.promise(makeWorkspace);
      const harness = yield* makeHarness({
        cwd,
        policy: runtimePolicy({ runtimeMode: "approval-required", cwd }),
        steps: [
          scriptedToolCallResponse([
            { name: "Write", arguments: { path: "note.txt", content: "written" } },
          ]),
          scriptedTextResponse("done"),
        ],
      });
      yield* startTurnOn(harness);
      const request = yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "pending",
      );
      assert.equal(request.runtimeRequest.kind, "file-change");
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: request.runtimeRequest.id,
        decision: "accept",
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.equal(terminal.status, "completed");
      const fileChanges = turnItems(harness).filter(
        (item) => item.type === "file_change" && item.status === "completed",
      );
      assert.isTrue(fileChanges.length > 0);
      const written = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(cwd, "note.txt"), "utf8").then(
          (text) => text,
          () => "",
        ),
      );
      assert.equal(written, "written");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("enforces every runtime mode for file edits", () =>
    Effect.gen(function* () {
      const cases = [
        { mode: "approval-required" as const, asks: true, maxRuntimeMode: undefined },
        { mode: "auto-accept-edits" as const, asks: false, maxRuntimeMode: undefined },
        { mode: "auto" as const, asks: false, maxRuntimeMode: undefined },
        { mode: "full-access" as const, asks: false, maxRuntimeMode: undefined },
        { mode: "full-access" as const, asks: true, maxRuntimeMode: "approval-required" as const },
      ];
      for (const entry of cases) {
        const cwd = yield* Effect.promise(makeWorkspace);
        const harness = yield* makeHarness({
          cwd,
          policy: runtimePolicy({
            runtimeMode: entry.mode,
            cwd,
            ...(entry.maxRuntimeMode === undefined ? {} : { maxRuntimeMode: entry.maxRuntimeMode }),
          }),
          steps: [
            scriptedToolCallResponse([
              { name: "Write", arguments: { path: "note.txt", content: "written" } },
            ]),
            scriptedTextResponse("done"),
          ],
        });
        yield* startTurnOn(harness);
        if (entry.asks) {
          const request = yield* harness.takeEvent(
            "runtime_request.updated",
            (event) => event.runtimeRequest.status === "pending",
          );
          yield* harness.runtime.respondToRuntimeRequest({
            requestId: request.runtimeRequest.id,
            decision: "accept",
          });
        }
        const terminal = yield* harness.takeEvent("turn.terminal");
        assert.equal(terminal.status, "completed");
        const approvals = harness.all.filter(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.kind === "file-change",
        );
        assert.equal(approvals.length > 0, entry.asks);
      }
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("accepts a tool for the session and stops asking", () =>
    Effect.gen(function* () {
      const cwd = yield* Effect.promise(makeWorkspace);
      const harness = yield* makeHarness({
        cwd,
        policy: runtimePolicy({ runtimeMode: "approval-required", cwd }),
        steps: [
          scriptedToolCallResponse([
            { name: "Write", arguments: { path: "one.txt", content: "one" } },
          ]),
          scriptedToolCallResponse([
            { name: "Write", arguments: { path: "one.txt", content: "two" } },
          ]),
          scriptedTextResponse("done"),
        ],
      });
      yield* startTurnOn(harness);
      const first = yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "pending",
      );
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: first.runtimeRequest.id,
        decision: "acceptForSession",
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.equal(terminal.status, "completed");
      const approvals = harness.all.filter(
        (event) =>
          event.type === "runtime_request.updated" &&
          event.runtimeRequest.kind === "file-change" &&
          event.runtimeRequest.status === "pending",
      );
      assert.lengthOf(approvals, 1);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("declines a tool and keeps the turn running", () =>
    Effect.gen(function* () {
      const cwd = yield* Effect.promise(makeWorkspace);
      const harness = yield* makeHarness({
        cwd,
        policy: runtimePolicy({ runtimeMode: "approval-required", cwd }),
        steps: [
          scriptedToolCallResponse([
            { name: "Write", arguments: { path: "note.txt", content: "written" } },
          ]),
          scriptedTextResponse("skipped"),
        ],
      });
      yield* startTurnOn(harness);
      const request = yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "pending",
      );
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: request.runtimeRequest.id,
        decision: "decline",
        feedback: "not now",
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.equal(terminal.status, "completed");
      const readBack = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(cwd, "note.txt"), "utf8").then(
          () => "read" as const,
          () => "missing" as const,
        ),
      );
      assert.equal(readBack, "missing");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("answers a structured question and continues the turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        steps: [
          scriptedToolCallResponse([
            {
              name: "asktool",
              arguments: {
                questions: [
                  {
                    id: "q1",
                    header: "Pick",
                    question: "Which one?",
                    options: [{ label: "A", description: "first" }],
                  },
                ],
              },
            },
          ]),
          scriptedTextResponse("thanks"),
        ],
      });
      yield* startTurnOn(harness);
      const request = yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.kind === "user_input",
      );
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: request.runtimeRequest.id,
        answers: { q1: "A" },
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.equal(terminal.status, "completed");
      const answers = harness.all.flatMap((event) =>
        event.type === "runtime_request.updated" && event.runtimeRequest.answers !== undefined
          ? [event.runtimeRequest.answers]
          : [],
      );
      assert.deepStrictEqual(answers, [{ q1: "A" }]);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("emits a proposed plan and stops after SubmitPlan", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        policy: runtimePolicy({ interactionMode: "plan" }),
        steps: [
          scriptedToolCallResponse([
            { name: "SubmitPlan", arguments: { markdown: "# Plan", summary: "Ship it" } },
          ]),
          scriptedTextResponse("should not run"),
        ],
      });
      yield* startTurnOn(harness);
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.equal(terminal.status, "completed");
      const plans = harness.all.flatMap((event) =>
        event.type === "plan.updated" ? [event.plan] : [],
      );
      assert.equal(plans[0]?.kind, "proposed_plan");
      const planItems = turnItems(harness).filter((item) => item.type === "proposed_plan");
      assert.isTrue(planItems.length > 0);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("supersedes an earlier proposed plan while the thread stays in plan mode", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        policy: runtimePolicy({ interactionMode: "plan" }),
        steps: [
          scriptedToolCallResponse([{ name: "SubmitPlan", arguments: { markdown: "# First" } }]),
          scriptedToolCallResponse([{ name: "SubmitPlan", arguments: { markdown: "# Second" } }]),
        ],
      });
      yield* startTurnOn(harness, 1);
      yield* harness.takeEvent("turn.terminal");
      yield* startTurnOn(harness, 2);
      yield* harness.takeEvent("turn.terminal");

      const proposedPlans = harness.all.flatMap((event) =>
        event.type === "plan.updated" && event.plan.kind === "proposed_plan" ? [event.plan] : [],
      );
      assert.deepStrictEqual(
        proposedPlans.map((plan) => ({ markdown: plan.markdown, status: plan.status })),
        [
          { markdown: "# First", status: "active" },
          { markdown: "# First", status: "superseded" },
          { markdown: "# Second", status: "active" },
        ],
      );
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("keeps an earlier proposed plan when a default-mode turn settles it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        policy: runtimePolicy({ interactionMode: "plan" }),
        steps: [
          scriptedToolCallResponse([{ name: "SubmitPlan", arguments: { markdown: "# First" } }]),
          scriptedTextResponse("implementing"),
          scriptedToolCallResponse([{ name: "SubmitPlan", arguments: { markdown: "# Second" } }]),
        ],
      });
      yield* startTurnOn(harness, 1);
      yield* harness.takeEvent("turn.terminal");
      const defaultTurn = yield* harness.turnInput(2);
      yield* harness.runtime.startTurn({
        ...defaultTurn,
        runtimePolicy: runtimePolicy({ interactionMode: "default" }),
      });
      yield* harness.takeEvent("turn.terminal");
      yield* startTurnOn(harness, 3);
      yield* harness.takeEvent("turn.terminal");

      const proposedPlans = harness.all.flatMap((event) =>
        event.type === "plan.updated" && event.plan.kind === "proposed_plan" ? [event.plan] : [],
      );
      assert.deepStrictEqual(
        proposedPlans.map((plan) => ({ markdown: plan.markdown, status: plan.status })),
        [
          { markdown: "# First", status: "active" },
          { markdown: "# Second", status: "active" },
        ],
      );
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("steers a running turn and declines a steer when idle", () =>
    Effect.gen(function* () {
      const gated = gatedStream();
      const harness = yield* makeHarness({ streamFn: gated.streamFn });
      yield* startTurnOn(harness);
      const providerTurn = yield* harness.takeEvent(
        "provider_turn.updated",
        (event) => event.providerTurn.status === "running",
      );
      yield* harness.runtime.steerTurn({
        threadId,
        runId: RunId.make("run-1"),
        providerThread: harness.providerThread,
        providerTurnId: providerTurn.providerTurn.id,
        message: {
          messageId: MessageId.make("message-steer"),
          text: "steer text",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      const steer = yield* harness.takeEvent("steer.updated");
      assert.equal(steer.status, "pending");
      assert.equal(steer.messageId, MessageId.make("message-steer"));
      yield* Effect.promise(async () => {
        gated.release(scriptedTextResponse("steered reply"));
        gated.release(scriptedTextResponse("after steer"));
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.equal(terminal.status, "completed");
      const declined = yield* harness.runtime
        .steerTurn({
          threadId,
          runId: RunId.make("run-2"),
          providerThread: harness.providerThread,
          providerTurnId: providerTurn.providerTurn.id,
          message: {
            messageId: MessageId.make("message-idle"),
            text: "idle steer",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.flip);
      assert.equal(declined._tag, "ProviderAdapterSteerDeclinedError");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("interrupts a turn that has not produced a response yet", () =>
    Effect.gen(function* () {
      const gated = gatedStream();
      const harness = yield* makeHarness({ streamFn: gated.streamFn });
      yield* startTurnOn(harness);
      const providerTurn = yield* harness.takeEvent(
        "provider_turn.updated",
        (event) => event.providerTurn.status === "running",
      );
      yield* harness.runtime
        .interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: providerTurn.providerTurn.id,
        })
        .pipe(Effect.forkScoped);
      gated.release(scriptedErrorResponse("aborted by the user", { stopReason: "aborted" }));
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.equal(terminal.status, "interrupted");
      assert.isNull(terminal.failure);
      const settled = harness.all.filter(
        (event) => event.type === "turn_item.updated" && event.turnItem.status === "running",
      );
      assert.isTrue(
        turnItems(harness).every((item) => item.status !== "running" && item.status !== "waiting"),
      );
      void settled;
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("reports a usage limit failure as a failed terminal", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        steps: [scriptedErrorResponse("insufficient_quota: the account is out of credits")],
      });
      yield* startTurnOn(harness);
      const terminal = yield* harness.takeEvent(
        "turn.terminal",
        (event) => event.status === "failed",
      );
      assert.equal(terminal.status, "failed");
      assert.equal(terminal.status === "failed" ? terminal.failure.class : null, "usage_limit");
      const errorItems = turnItems(harness).filter((item) => item.type === "error");
      assert.isTrue(errorItems.length > 0);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("compacts the thread through compactThread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        steps: [
          scriptedTextResponse("answer one"),
          scriptedTextResponse(
            "<compaction_summary>\n## Goals\nShip\n## Progress\nOne answer\n## Files\n(none)\n## Decisions\n(none)\n## Next Steps\nFinish\n</compaction_summary>",
          ),
        ],
      });
      yield* startTurnOn(harness);
      yield* harness.takeEvent("turn.terminal");
      const input = yield* harness.turnInput(2);
      yield* harness.runtime.compactThread!(input);
      const compaction = yield* harness.takeEvent(
        "turn_item.updated",
        (event) => event.turnItem.type === "compaction",
      );
      assert.equal(compaction.turnItem.type, "compaction");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("injects history and rolls the thread back to its start", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ steps: [scriptedTextResponse("answer")] });
      const injected = yield* harness.runtime.injectHistory!({
        providerThread: harness.providerThread,
        messages: [
          {
            role: "user",
            text: "imported question",
            threadId,
            runId: null,
            itemId: "item-1" as never,
            providerThreadId: null,
            status: "completed",
            kind: "user_message",
          },
          {
            role: "assistant",
            text: "imported answer",
            threadId,
            runId: null,
            itemId: "item-2" as never,
            providerThreadId: null,
            status: "completed",
            kind: "assistant_message",
          },
        ],
        context: "handoff context",
      });
      assert.isTrue(injected);
      const snapshot = yield* harness.runtime.readThreadSnapshot!({
        providerThread: harness.providerThread,
      });
      assert.deepStrictEqual(
        snapshot.messages.map((message) => message.text),
        ["handoff context", "imported question", "imported answer"],
      );
      const rolled = yield* harness.runtime.rollbackThread!({
        providerThread: harness.providerThread,
        providerThreadTurns: [],
        target: {
          type: "thread_start",
          checkpointId: "checkpoint-1" as never,
          appRunOrdinal: 0,
        },
      });
      assert.lengthOf(rolled.messages, 0);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("forks a thread with its parent's conversation", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ steps: [scriptedTextResponse("answer one")] });
      yield* startTurnOn(harness);
      yield* harness.takeEvent("turn.terminal");
      const forkedThreadId = ThreadId.make("thread-pi-native-fork");
      const forked = yield* harness.runtime.forkThread!({
        sourceProviderThread: harness.providerThread,
        targetThreadId: forkedThreadId,
      });
      assert.equal(forked.appThreadId, forkedThreadId);
      assert.equal(forked.forkedFrom?.providerThreadId, harness.providerThread.id);
      const snapshot = yield* harness.runtime.readThreadSnapshot!({ providerThread: forked });
      assert.deepStrictEqual(
        snapshot.messages.map((message) => message.text),
        ["Hello Pi", "answer one"],
      );
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("runs a turn when the T3 MCP server is unreachable", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        steps: [scriptedTextResponse("still fine")],
        mcpEndpoint: "http://127.0.0.1:1/mcp",
        fetch: async () => {
          throw new Error("ECONNREFUSED 127.0.0.1:1");
        },
      });
      yield* startTurnOn(harness);
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.equal(terminal.status, "completed");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("compacts through a full turn lifecycle without a prior turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        steps: [
          scriptedTextResponse(
            "<compaction_summary>\n## Goals\nShip\n## Progress\nNothing yet\n## Files\n(none)\n## Decisions\n(none)\n## Next Steps\nStart\n</compaction_summary>",
          ),
        ],
      });
      const input = yield* harness.turnInput(1);
      yield* harness.runtime.compactThread!(input);
      const started = yield* harness.takeEvent(
        "provider_turn.updated",
        (event) => event.providerTurn.status === "running",
      );
      assert.equal(started.providerTurn.model, "gpt-5.4");
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.equal(terminal.status, "completed");
      const compactionItems = turnItems(harness).filter((item) => item.type === "compaction");
      assert.deepEqual(
        compactionItems.map((item) => item.status),
        ["completed"],
      );
      const thread = harness.all.filter((event) => event.type === "provider_thread.updated").at(-1);
      assert.equal(
        thread?.type === "provider_thread.updated" ? thread.providerThread.status : "",
        "idle",
      );
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("injects history and rolls the thread back to its start", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ steps: [scriptedTextResponse("answer")] });
      const injected = yield* harness.runtime.injectHistory!({
        providerThread: harness.providerThread,
        messages: [
          {
            role: "user",
            text: "imported question",
            threadId,
            runId: null,
            itemId: "item-1" as never,
            providerThreadId: null,
            status: "completed",
            kind: "user_message",
          },
          {
            role: "assistant",
            text: "imported answer",
            threadId,
            runId: null,
            itemId: "item-2" as never,
            providerThreadId: null,
            status: "completed",
            kind: "assistant_message",
          },
        ],
        context: "handoff context",
      });
      assert.isTrue(injected);
      const snapshot = yield* harness.runtime.readThreadSnapshot!({
        providerThread: harness.providerThread,
      });
      assert.deepStrictEqual(
        snapshot.messages.map((message) => message.text),
        ["handoff context", "imported question", "imported answer"],
      );
      const rolled = yield* harness.runtime.rollbackThread!({
        providerThread: harness.providerThread,
        providerThreadTurns: [],
        target: {
          type: "thread_start",
          checkpointId: "checkpoint-1" as never,
          appRunOrdinal: 0,
        },
      });
      assert.lengthOf(rolled.messages, 0);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("forks a thread with its parent's conversation", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ steps: [scriptedTextResponse("answer one")] });
      yield* startTurnOn(harness);
      yield* harness.takeEvent("turn.terminal");
      const forkedThreadId = ThreadId.make("thread-pi-native-fork");
      const forked = yield* harness.runtime.forkThread!({
        sourceProviderThread: harness.providerThread,
        targetThreadId: forkedThreadId,
      });
      assert.equal(forked.appThreadId, forkedThreadId);
      assert.equal(forked.forkedFrom?.providerThreadId, harness.providerThread.id);
      const snapshot = yield* harness.runtime.readThreadSnapshot!({ providerThread: forked });
      assert.deepStrictEqual(
        snapshot.messages.map((message) => message.text),
        ["Hello Pi", "answer one"],
      );
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("runs a turn when the T3 MCP server is unreachable", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        steps: [scriptedTextResponse("still fine")],
        mcpEndpoint: "http://127.0.0.1:1/mcp",
        fetch: async () => {
          throw new Error("ECONNREFUSED 127.0.0.1:1");
        },
      });
      yield* startTurnOn(harness);
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.equal(terminal.status, "completed");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("numbers item ordinals from one so a failed turn reports its failure item", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        steps: [scriptedErrorResponse("insufficient_quota: the account is out of credits")],
      });
      yield* startTurnOn(harness);
      const terminal = yield* harness.takeEvent(
        "turn.terminal",
        (event) => event.status === "failed",
      );
      assert.equal(
        terminal.status === "failed" ? terminal.failureItemOrdinal : 0,
        // Ordinal 1 opens the item range at 101.
        101,
      );
      const errorItems = turnItems(harness).filter((item) => item.type === "error");
      assert.deepEqual(
        [...new Set(errorItems.map((item) => item.ordinal))],
        [terminal.status === "failed" ? terminal.failureItemOrdinal : 0],
      );
      assert.isTrue(
        errorItems.every((item) =>
          (item.nativeItemRef?.nativeId ?? "").endsWith("terminal-failure"),
        ),
      );
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("shares one item between retry progress and the terminal failure", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        steps: [
          scriptedErrorResponse("socket hang up"),
          scriptedErrorResponse("insufficient_quota: the account is out of credits"),
        ],
      });
      yield* startTurnOn(harness);
      const terminal = yield* harness.takeEvent(
        "turn.terminal",
        (event) => event.status === "failed",
      );
      const failureItemOrdinal = terminal.status === "failed" ? terminal.failureItemOrdinal : 0;
      const errorItems = turnItems(harness).filter((item) => item.type === "error");
      const retryItems = errorItems.filter((item) => item.status === "running");
      assert.isTrue(retryItems.length > 0);
      assert.isTrue(errorItems.length > retryItems.length);
      const failureNativeId = `${harness.providerTurnId(1)}:terminal-failure`;
      assert.deepEqual(
        [...new Set(errorItems.map((item) => item.nativeItemRef?.nativeId))],
        [failureNativeId],
      );
      assert.lengthOf(new Set(errorItems.map((item) => item.id)), 1);
      assert.deepEqual([...new Set(errorItems.map((item) => item.ordinal))], [failureItemOrdinal]);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("reports an interrupted terminal when Stop lands before the turn starts", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ streamFn: gatedStream().streamFn });
      yield* startTurnOn(harness);
      yield* harness.runtime.interruptTurn({
        providerThread: harness.providerThread,
        providerTurnId: harness.providerTurnId(1),
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.equal(terminal.status, "interrupted");
      assert.isNull(terminal.failure);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("settles an interrupted turn exactly once", () =>
    Effect.gen(function* () {
      const gated = gatedStream();
      const harness = yield* makeHarness({ streamFn: gated.streamFn });
      yield* startTurnOn(harness);
      yield* harness.runtime.interruptTurn({
        providerThread: harness.providerThread,
        providerTurnId: harness.providerTurnId(1),
      });
      const interrupted = yield* harness.takeEvent("turn.terminal");
      assert.equal(interrupted.status, "interrupted");
      // The aborted request already returned; settling it again would emit a second terminal.
      yield* startTurnOn(harness, 2);
      gated.release(scriptedTextResponse("second answer"));
      const terminal = yield* harness.takeEvent(
        "turn.terminal",
        (event) => event.providerTurnId === harness.providerTurnId(2),
      );
      assert.equal(terminal.status, "completed");
      assert.deepEqual(
        harness.all
          .filter((event) => event.type === "turn.terminal")
          .map((event) => event.providerTurnId),
        [harness.providerTurnId(1), harness.providerTurnId(2)],
      );
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("tracks background subagents as pending work", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        settings: settings({ enableSubagents: true }),
        steps: [
          scriptedToolCallResponse([
            { name: "Task", arguments: { prompt: "child work", title: "Child" } },
          ]),
          scriptedTextResponse("child report"),
          scriptedTextResponse("parent done"),
        ],
      });
      yield* startTurnOn(harness);
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.equal(terminal.status, "completed");
      const pending = harness.all.flatMap((event) =>
        event.type === "background_work.updated" ? [event.pending] : [],
      );
      assert.deepEqual(pending, [true, false]);
      const subagents = harness.all.filter((event) => event.type === "subagent.updated");
      assert.isTrue(subagents.length > 0);
      assert.isFalse(yield* harness.runtime.hasPendingBackgroundWork!);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("reports the resolved model on the provider turn and passes app context through", () =>
    Effect.gen(function* () {
      const streamFn = createScriptedStreamFn([scriptedTextResponse("context seen")], {
        now: () => 0,
      });
      const harness = yield* makeHarness({
        streamFn,
        appContext: [{ key: "notes", text: "remember the release checklist" }],
      });
      yield* startTurnOn(harness);
      const started = yield* harness.takeEvent(
        "provider_turn.updated",
        (event) => event.providerTurn.status === "running",
      );
      assert.equal(started.providerTurn.model, "gpt-5.4");
      yield* harness.takeEvent("turn.terminal");
      const prompt = JSON.stringify(streamFn.calls[0]?.context.messages ?? []);
      assert.include(prompt, "<external_notes>remember the release checklist</external_notes>");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("applies updated and cleared project memory on later requests", () =>
    Effect.gen(function* () {
      const streamFn = createScriptedStreamFn(
        [
          scriptedTextResponse("first"),
          scriptedTextResponse("second"),
          scriptedTextResponse("third"),
        ],
        { now: () => 0 },
      );
      const harness = yield* makeHarness({ streamFn });
      const startTurn = (ordinal: number, projectMemory?: string) =>
        harness
          .turnInput(ordinal, harness.selection, `turn ${ordinal}`, projectMemory)
          .pipe(Effect.flatMap(harness.runtime.startTurn));

      yield* startTurn(1, "Use the staging database.");
      yield* harness.takeEvent("turn.terminal");
      yield* startTurn(2, "Use the production database.");
      yield* harness.takeEvent("turn.terminal");
      yield* startTurn(3);
      yield* harness.takeEvent("turn.terminal");

      // A delta carries the change, so fold the system messages to read what each request sees.
      const prompts = streamFn.calls.map((call) => {
        let memory: string | null | undefined;
        for (const message of call.context.messages) {
          if (
            message.role !== "system" ||
            typeof message !== "object" ||
            !("sections" in message)
          ) {
            continue;
          }
          const sections =
            (message as { readonly sections?: Record<string, string | null> }).sections ?? {};
          if (Object.hasOwn(sections, "project_memory")) memory = sections["project_memory"];
        }
        return memory;
      });
      assert.include(prompts[0] ?? "", "Use the staging database.");
      assert.include(prompts[1] ?? "", "Use the production database.");
      assert.notInclude(prompts[1] ?? "", "Use the staging database.");
      assert.isNull(prompts[2] ?? null);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("keeps the workspace-relative path of a written file", () =>
    Effect.gen(function* () {
      const cwd = yield* Effect.promise(makeWorkspace);
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(cwd, "src", "a"), { recursive: true }),
      );
      const harness = yield* makeHarness({
        cwd,
        policy: runtimePolicy({ cwd }),
        steps: [
          scriptedToolCallResponse([
            {
              name: "Write",
              arguments: { path: NodePath.join(cwd, "src/a/index.ts"), content: "export {};" },
            },
          ]),
          scriptedTextResponse("written"),
        ],
      });
      yield* startTurnOn(harness);
      yield* harness.takeEvent("turn.terminal");
      const fileChanges = turnItems(harness).filter(
        (item) => item.type === "file_change" && item.status === "completed",
      );
      assert.deepEqual(
        fileChanges.map((item) => (item.type === "file_change" ? item.fileName : "")),
        ["src/a/index.ts"],
      );
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect(
    "projects todo_list lifecycle, suppresses valid TodoWrite dynamic tools, and supports TodoRead",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          steps: [
            scriptedToolCallResponse([
              {
                name: "TodoWrite",
                arguments: {
                  steps: [{ id: "1", text: "First step", status: "running" }],
                  explanation: "Started",
                },
              },
            ]),
            scriptedToolCallResponse([
              {
                name: "TodoWrite",
                arguments: { steps: [{ id: " ", text: "Invalid", status: "pending" }] },
              },
              { name: "TodoRead", arguments: {} },
            ]),
            scriptedToolCallResponse([
              {
                name: "TodoWrite",
                arguments: {
                  steps: [{ id: "1", text: "First step", status: "completed" }],
                },
              },
            ]),
            scriptedTextResponse("finished"),
          ],
        });
        yield* startTurnOn(harness);
        const terminal = yield* harness.takeEvent("turn.terminal");
        assert.equal(terminal.status, "completed");

        const todoPlans = harness.all.flatMap((event) =>
          event.type === "plan.updated" && event.plan.kind === "todo_list" ? [event.plan] : [],
        );
        assert.deepEqual(
          todoPlans.map((plan) => ({
            id: plan.id,
            status: plan.status,
            steps: plan.steps.map((step) => step.status),
          })),
          [
            { id: todoPlans[0]!.id, status: "active", steps: ["running"] },
            { id: todoPlans[0]!.id, status: "superseded", steps: ["running"] },
            { id: todoPlans[2]!.id, status: "completed", steps: ["completed"] },
          ],
        );

        const todoNodes = harness.all.flatMap((event) =>
          event.type === "node.updated" && event.node.kind === "todo_list" ? [event.node] : [],
        );
        assert.lengthOf(todoNodes, 2);

        const dynamicTools = turnItems(harness).filter((item) => item.type === "dynamic_tool");
        // Successful TodoWrite does not emit a duplicate dynamic_tool row; invalid TodoWrite and TodoRead do.
        assert.isFalse(
          dynamicTools.some((item) => item.toolName === "TodoWrite" && item.status !== "failed"),
        );
        assert.isTrue(
          dynamicTools.some((item) => item.toolName === "TodoWrite" && item.status === "failed"),
        );
        const todoRead = dynamicTools.find(
          (item) => item.toolName === "TodoRead" && item.status === "completed",
        );
        assert.isDefined(todoRead);
        assert.include(JSON.stringify(todoRead?.output ?? {}), "First step");
      }).pipe(Effect.provide(testLayer())),
  );

  it.effect("runs /goal end to end: set, show, pause, resume, and clear", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        steps: [
          scriptedTextResponse("working on it"),
          scriptedToolCallResponse([
            { name: "UpdateGoalStatus", arguments: { status: "complete", summary: "tests pass" } },
          ]),
          scriptedTextResponse("verified"),
          scriptedTextResponse("resuming work"),
          scriptedToolCallResponse([
            { name: "UpdateGoalStatus", arguments: { status: "complete", summary: "done again" } },
          ]),
          scriptedTextResponse("finished"),
        ],
      });

      yield* startTurnWithText(harness, 1, "/goal Ship the fix");
      assert.equal((yield* harness.takeEvent("turn.terminal")).status, "completed");
      const started = threadGoals(harness).find(
        (goal) => goal?.objective === "Ship the fix" && goal.status === "active",
      );
      assert.isDefined(started);
      const completed = threadGoals(harness).find((goal) => goal?.status === "complete");
      assert.equal(completed?.objective, "Ship the fix");
      assert.isAbove(completed?.checks ?? 0, 0);
      assert.equal(completed?.lastCheck, "tests pass");

      yield* startTurnWithText(harness, 2, "/goal");
      assert.equal((yield* harness.takeEvent("turn.terminal")).status, "completed");
      yield* startTurnWithText(harness, 3, "/goal pause");
      assert.equal((yield* harness.takeEvent("turn.terminal")).status, "completed");
      assert.isTrue(threadGoals(harness).some((goal) => goal?.status === "paused"));

      yield* startTurnWithText(harness, 4, "/goal resume");
      assert.equal((yield* harness.takeEvent("turn.terminal")).status, "completed");
      const resumed = threadGoals(harness).find((goal) => goal?.lastCheck === "done again");
      assert.equal(resumed?.status, "complete");

      yield* startTurnWithText(harness, 5, "/goal clear");
      assert.equal((yield* harness.takeEvent("turn.terminal")).status, "completed");
      assert.isNull(threadGoals(harness).at(-1) ?? null);

      yield* startTurnWithText(harness, 6, "/goal");
      assert.equal((yield* harness.takeEvent("turn.terminal")).status, "completed");

      const texts = assistantTexts(harness);
      assert.isTrue(texts.some((text) => text.includes("Goal: Ship the fix")));
      assert.isTrue(texts.some((text) => text.includes("Status: complete")));
      assert.include(texts, "Goal paused. Send /goal resume to continue.");
      assert.include(texts, "Goal cleared.");
      assert.include(texts, "No goal is set. Use /goal <objective> to start one.");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("compacts the thread for /compact <instructions>", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        steps: [
          scriptedTextResponse(
            "<compaction_summary>\n## Goals\nKeep going\n## Progress\nOne answer\n## Files\n(none)\n## Decisions\n(none)\n## Next Steps\nFinish\n</compaction_summary>",
          ),
        ],
      });
      yield* startTurnWithText(harness, 1, "/compact focus on diffs");
      assert.equal((yield* harness.takeEvent("turn.terminal")).status, "completed");
      const snapshot = yield* harness.runtime.readThreadSnapshot!({
        providerThread: harness.providerThread,
      });
      assert.isTrue(
        snapshot.messages.some(
          (message) =>
            message.role === "user" &&
            message.text.includes(
              "<compaction_instructions>focus on diffs</compaction_instructions>",
            ),
        ),
      );
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("runs /review, /grill-me, /boost, and /init with a one-turn directive", () =>
    Effect.gen(function* () {
      const requests: Array<{
        readonly text: string;
        readonly activation: string | null;
        readonly reasoning: string | undefined;
      }> = [];
      const streamFn: StreamFn = async (model, context, options) => {
        const user = context.messages.filter((message) => message.role === "user").at(-1);
        const systems = context.messages.filter((message) => message.role === "system");
        const last = systems.at(-1);
        const sections =
          last !== undefined && typeof last === "object" && "sections" in last
            ? ((last as { readonly sections?: Record<string, string | null> }).sections ?? {})
            : {};
        requests.push({
          text:
            user !== undefined && typeof user.content === "string"
              ? user.content
              : JSON.stringify(user?.content ?? ""),
          activation: sections["tool_activation"] ?? null,
          reasoning: (options as { readonly reasoning?: string } | undefined)?.reasoning,
        });
        return renderScriptedTurn(model, scriptedTextResponse("done"), 0);
      };
      const harness = yield* makeHarness({ streamFn });
      const commands = [
        ["/review main...HEAD", "Review the following target and changes:\nmain...HEAD", "review"],
        ["/grill-me onboarding", "onboarding", "grill-me"],
        ["/boost fix the flaky test", "fix the flaky test", "boost"],
        [
          "/init keep commands short",
          "Create or update AGENTS.md with emphasis on:\nkeep commands short",
          "init",
        ],
      ] as const;
      for (const [index, command] of commands.entries()) {
        yield* startTurnWithText(harness, index + 1, command[0]);
        assert.equal((yield* harness.takeEvent("turn.terminal")).status, "completed");
      }
      assert.deepEqual(
        requests.map((request) => request.text),
        commands.map((command) => command[1]),
      );
      for (const [index, command] of commands.entries()) {
        assert.match(
          requests[index]?.activation ?? "",
          new RegExp(`workflow_command name="${command[2]}"`, "u"),
        );
      }
      assert.equal(requests[0]?.reasoning, undefined);
      assert.equal(requests[1]?.reasoning, undefined);
      assert.equal(requests[2]?.reasoning, "high");
      assert.equal(requests[3]?.reasoning, undefined);
    }).pipe(Effect.provide(testLayer())),
  );
});
