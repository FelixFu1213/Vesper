import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ManagedPolicyDocument,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ProviderSessionId,
  type ProviderThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { PiNativeSettings } from "@t3tools/provider-pi-native/settings";
import {
  PI_NATIVE_DRIVER_KIND,
  makePiNativeAdapterV2,
  renderScriptedTurn,
  scriptedErrorResponse,
  scriptedTextResponse,
  scriptedToolCallResponse,
  type ScriptedCall,
  type ScriptedTurn,
} from "@t3tools/provider-pi-native/testing";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import {
  makeProviderReplayGate,
  type ProviderReplayGate,
} from "@t3tools/provider-testing/replayGate";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { provideDeterministicTestRuntime } from "../testkit/DeterministicRuntime.ts";
import {
  materializeFixtureInput,
  projectionFor,
  type OrchestratorFixtureInput,
} from "../testkit/fixtures/shared.ts";
import {
  runOrchestratorV2Scenario,
  type OrchestratorV2Scenario,
  type OrchestratorV2ScenarioResult,
  type OrchestratorV2ScenarioStep,
} from "../testkit/OrchestratorScenario.ts";
import { layerWithRegistry } from "../testkit/ProviderReplayHarness.ts";

const INSTANCE_ID = ProviderInstanceId.make("piNative");
const MODEL_SELECTION: ModelSelection = { instanceId: INSTANCE_ID, model: "default" };
/** A named model the same instance offers, for mid-conversation switches. */
const NAMED_MODEL = "gpt-4o";
/** What Pi Native resolves the `default` sentinel to under these settings. */
const RESOLVED_DEFAULT_MODEL = "gpt-5.4";

const SUMMARY_BOOKEND = "Summarize the conversation below";
const SUMMARY =
  "<compaction_summary>\n## Goals\nShip it\n## Progress\nOne answer\n## Files\n(none)\n## Decisions\n(none)\n## Next Steps\nFinish\n</compaction_summary>";

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

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
);

/**
 * The provider seam Pi Native calls for each request. Types come from the package's
 * own testing export, so this test needs no direct dependency on the Pi SDK.
 */
type ProviderStreamFn = (
  model: ScriptedCall["model"],
  context: ScriptedCall["context"],
  options?: unknown,
) => ReturnType<typeof renderScriptedTurn> | Promise<ReturnType<typeof renderScriptedTurn>>;

interface ScriptedCallView {
  readonly model: ScriptedCall["model"];
  readonly context: ScriptedCall["context"];
  readonly serializedContext: string;
  /** The wire options the transport seam received: reasoning, headers, key. */
  readonly options: unknown;
}

/**
 * Answers each request from its own context, so a subagent or compaction request
 * cannot consume the answer the root turn was waiting for.
 */
const makeStreamFn = (respond: (call: ScriptedCallView) => ScriptedTurn) => {
  const calls: ScriptedCallView[] = [];
  const streamFn: ProviderStreamFn = (model, context, options) => {
    const call: ScriptedCallView = {
      model,
      context,
      serializedContext: JSON.stringify(context.messages),
      options,
    };
    calls.push(call);
    return renderScriptedTurn(model, respond(call), 0);
  };
  return Object.assign(streamFn, { calls });
};

const reasoningOf = (call: ScriptedCallView | undefined): string | undefined => {
  const options = call?.options as { readonly reasoning?: string } | undefined;
  return options?.reasoning;
};

const headersOf = (call: ScriptedCallView | undefined): Readonly<Record<string, string>> => {
  const options = call?.options as { readonly headers?: Record<string, string> } | undefined;
  return options?.headers ?? {};
};

const alwaysAnswers = (text: string) => makeStreamFn(() => scriptedTextResponse(text));

const registryLayer = (input: {
  readonly streamFn: ProviderStreamFn;
  readonly settings: PiNativeSettings;
}) =>
  ProviderAdapterRegistry.layerFromAdaptersEffect(
    makePiNativeAdapterV2({
      instanceId: INSTANCE_ID,
      settings: input.settings,
      streamFn: input.streamFn,
      now: () => 0,
      sleep: async () => undefined,
      scheduleTimer: () => () => undefined,
    }).pipe(Effect.map((adapter) => [adapter])),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        IdAllocator.layer,
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

interface ScenarioOptions {
  readonly name: string;
  readonly fixtureInput: OrchestratorFixtureInput;
  readonly streamFn: ProviderStreamFn;
  readonly settings?: PiNativeSettings;
  /** The selection the thread starts on; defaults to the shared sentinel. */
  readonly modelSelection?: ModelSelection;
  readonly managedPolicy?: ManagedPolicyDocument;
  /** Runs after the scenario settled, on the same orchestrator instance. */
  readonly after?: (input: {
    readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
    readonly threadId: ThreadId;
  }) => Effect.Effect<void>;
}

interface ScenarioOutput extends OrchestratorV2ScenarioResult {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly threadId: ThreadId;
  readonly workspace: string;
}

/** Runs a hand-built scenario, for behaviour two app threads of one instance share. */
const runPiNativeThreads = (input: {
  readonly name: string;
  readonly workspace: string;
  readonly streamFn: ProviderStreamFn;
  readonly settings?: PiNativeSettings;
  readonly commands: ReadonlyArray<OrchestrationV2Command>;
  readonly steps: ReadonlyArray<OrchestratorV2ScenarioStep>;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly replayGate?: ProviderReplayGate;
}) =>
  runOrchestratorV2Scenario(
    {
      name: input.name,
      commands: input.commands,
      steps: input.steps,
      projectionThreadIds: input.threadIds,
    },
    input.replayGate === undefined ? {} : { replayGate: input.replayGate },
  ).pipe(
    Effect.provide(
      layerWithRegistry(
        { name: input.name, runtimePolicyOverride: { cwd: input.workspace } },
        registryLayer({
          streamFn: input.streamFn,
          settings: input.settings ?? settings(),
        }),
      ),
    ),
    provideDeterministicTestRuntime,
  );

const createThreadCommand = (input: {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly title: string;
}): OrchestrationV2Command => ({
  type: "thread.create",
  createdBy: "user",
  creationSource: "web",
  commandId: input.commandId,
  threadId: input.threadId,
  projectId: input.projectId,
  title: input.title,
  modelSelection: MODEL_SELECTION,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
});

const dispatchTextCommand = (input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
}): OrchestrationV2Command => ({
  type: "message.dispatch",
  createdBy: "user",
  creationSource: "web",
  commandId: input.commandId,
  threadId: input.threadId,
  messageId: input.messageId,
  text: input.text,
  attachments: [],
  modelSelection: MODEL_SELECTION,
  dispatchMode: { type: "start_immediately" },
});

const providerSessionOf = (projection: OrchestrationV2ThreadProjection) =>
  projection.providerThreads.at(-1)?.providerSessionId ?? null;

const legacyProviderThread = (input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly nativeThreadId: string;
  readonly providerSessionId: ProviderSessionId;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread => ({
  id: input.idAllocator.derive.providerThread({
    driver: PI_NATIVE_DRIVER_KIND,
    nativeThreadId: input.nativeThreadId,
  }),
  driver: PI_NATIVE_DRIVER_KIND,
  providerInstanceId: INSTANCE_ID,
  providerSessionId: input.providerSessionId,
  appThreadId: input.threadId,
  ownerNodeId: null,
  nativeThreadRef: {
    driver: PI_NATIVE_DRIVER_KIND,
    nativeId: input.nativeThreadId,
    strength: "strong",
  },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: input.now,
  updatedAt: input.now,
});

const legacyAppThread = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly providerThreadId: ProviderThreadId;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread => ({
  id: input.threadId,
  projectId: input.projectId,
  title: "Pre-upgrade Pi Native thread",
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: INSTANCE_ID,
  modelSelection: MODEL_SELECTION,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: input.providerThreadId,
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: input.threadId,
  },
  forkedFrom: null,
  createdAt: input.now,
  updatedAt: input.now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

/** Runs the real OrchestratorV2 + ingestor + SQLite projections against the in-process adapter. */
const runPiNativeScenario = (input: ScenarioOptions) =>
  Effect.gen(function* () {
    const workspace = yield* checkpointWorkspace(`pi-native-v2-${input.name}`);
    const result = yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const materialized = yield* materializeFixtureInput({
        scenario: input.name,
        fixtureInput: input.fixtureInput,
        driver: PI_NATIVE_DRIVER_KIND,
        modelSelection: input.modelSelection ?? MODEL_SELECTION,
      }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
      const scenario: OrchestratorV2Scenario & {
        readonly runtimePolicyOverride: { readonly cwd: string };
      } = {
        name: input.name,
        commands: materialized.commands,
        steps: materialized.steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { cwd: workspace },
      };
      const scenarioResult = yield* runOrchestratorV2Scenario(scenario);
      const projection = projectionFor(scenarioResult, input.name);
      const threadId = materialized.projectionThreadIds[0];
      if (threadId === undefined) {
        return yield* Effect.die(new Error(`${input.name} materialized no thread.`));
      }
      if (input.after !== undefined) {
        yield* input.after({ orchestrator, threadId });
      }
      return { ...scenarioResult, projection, threadId, workspace } satisfies ScenarioOutput;
    }).pipe(
      Effect.provide(
        layerWithRegistry(
          { name: input.name, runtimePolicyOverride: { cwd: workspace } },
          registryLayer({
            streamFn: input.streamFn,
            settings: input.settings ?? settings(),
          }),
          input.managedPolicy === undefined ? {} : { managedPolicy: input.managedPolicy },
        ),
      ),
    );
    return result;
  }).pipe(provideDeterministicTestRuntime);

const runIds = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.map((run) => run.status);

const itemsOf = <T extends OrchestrationV2TurnItem["type"]>(
  projection: OrchestrationV2ThreadProjection,
  type: T,
): ReadonlyArray<Extract<OrchestrationV2TurnItem, { type: T }>> =>
  projection.turnItems.filter(
    (item): item is Extract<OrchestrationV2TurnItem, { type: T }> => item.type === type,
  );

const readWorkspaceFile = (workspace: string, relativePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(workspace, relativePath);
    return (yield* fileSystem.exists(file)) ? yield* fileSystem.readFileString(file) : null;
  });

const message = (text: string) => ({ type: "message" as const, text });

/** A complete stored binding, so a test only states the field it is about. */
const binding = (
  id: string,
  overrides: Partial<PiNativeSettings["modelBindings"][number]> = {},
): PiNativeSettings["modelBindings"][number] => ({
  id,
  contextWindow: 200_000,
  contextWindowSource: "catalog",
  maxTokens: 8_192,
  maxTokensSource: "catalog",
  thinkingLevels: [],
  defaultThinkingLevel: null,
  ...overrides,
});

describe("PiNativeAdapterV2 through OrchestratorV2", () => {
  it.effect("streams assistant text and reasoning into a completed run", () =>
    Effect.gen(function* () {
      const streamFn = alwaysAnswers("Hello from Pi Native");
      const { projection } = yield* runPiNativeScenario({
        name: "pi-native-simple",
        fixtureInput: { steps: [message("Hello Pi")] },
        streamFn,
      });
      assert.deepEqual(runIds(projection), ["completed"]);
      assert.deepEqual(
        itemsOf(projection, "assistant_message").map((item) => item.text),
        ["Hello from Pi Native"],
      );
      const [providerTurn] = projection.providerTurns;
      assert.equal(providerTurn?.model, RESOLVED_DEFAULT_MODEL);
      assert.isAbove(providerTurn?.tokenUsage?.usedTokens ?? 0, 0);
      assert.deepEqual(
        projection.messages
          .filter((entry) => entry.role === "assistant")
          .map((entry) => entry.text),
        ["Hello from Pi Native"],
      );
      assert.deepEqual(
        projection.runtimeRequests.filter((request) => request.status === "pending"),
        [],
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("streams reasoning as its own turn item", () =>
    Effect.gen(function* () {
      const streamFn = makeStreamFn(() =>
        scriptedTextResponse("Reasoned answer", { reasoning: "Think first" }),
      );
      const { projection } = yield* runPiNativeScenario({
        name: "pi-native-reasoning",
        fixtureInput: { steps: [message("think")] },
        streamFn,
      });
      assert.deepEqual(
        itemsOf(projection, "reasoning").map((item) => item.text),
        ["Think first"],
      );
      assert.deepEqual(
        itemsOf(projection, "reasoning").map((item) => item.status),
        ["completed"],
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("keeps conversation context and follows the model selection across turns", () =>
    Effect.gen(function* () {
      const streamFn = makeStreamFn((call) =>
        scriptedTextResponse(
          call.serializedContext.includes("third question") ? "third answer" : "earlier answer",
        ),
      );
      const { projection } = yield* runPiNativeScenario({
        name: "pi-native-multi-turn",
        fixtureInput: {
          steps: [
            message("first question"),
            { type: "set_model", model: NAMED_MODEL },
            message("second question"),
            { type: "set_model", model: "default" },
            message("third question"),
          ],
        },
        streamFn,
      });
      assert.deepEqual(runIds(projection), ["completed", "completed", "completed"]);
      assert.deepEqual(
        projection.providerTurns.map((turn) => turn.model),
        [RESOLVED_DEFAULT_MODEL, NAMED_MODEL, RESOLVED_DEFAULT_MODEL],
      );
      assert.deepEqual(
        projection.runs.map((run) => run.modelSelection.model),
        ["default", NAMED_MODEL, "default"],
      );
      const third = streamFn.calls.at(-1);
      assert.equal(third?.model.id, RESOLVED_DEFAULT_MODEL);
      assert.include(third?.serializedContext ?? "", "first question");
      assert.include(third?.serializedContext ?? "", "earlier answer");
      assert.include(third?.serializedContext ?? "", "second question");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("asks before a write in approval-required and records the file change", () =>
    Effect.gen(function* () {
      const streamFn = makeStreamFn((call) =>
        call.serializedContext.includes("note.txt")
          ? scriptedTextResponse("done")
          : scriptedToolCallResponse([
              { name: "Write", arguments: { path: "note.txt", content: "written" } },
            ]),
      );
      const { projection, workspace } = yield* runPiNativeScenario({
        name: "pi-native-approval-required",
        fixtureInput: {
          runtimeMode: "approval-required",
          steps: [message("write a file"), { type: "approve_next_runtime_request" }],
        },
        streamFn,
      });
      assert.deepEqual(runIds(projection), ["completed"]);
      assert.deepEqual(
        projection.runtimeRequests.map((request) => [request.kind, request.decision]),
        [["file-change", "accept"]],
      );
      const [fileChange] = itemsOf(projection, "file_change");
      assert.equal(fileChange?.fileName, "note.txt");
      assert.equal(fileChange?.status, "completed");
      assert.equal(yield* readWorkspaceFile(workspace, "note.txt"), "written");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("declines a write and keeps the turn going", () =>
    Effect.gen(function* () {
      const streamFn = makeStreamFn((call) =>
        call.serializedContext.includes("note.txt")
          ? scriptedTextResponse("skipped")
          : scriptedToolCallResponse([
              { name: "Write", arguments: { path: "note.txt", content: "written" } },
            ]),
      );
      const { projection, workspace } = yield* runPiNativeScenario({
        name: "pi-native-approval-declined",
        fixtureInput: {
          runtimeMode: "approval-required",
          steps: [
            message("write a file"),
            { type: "approve_next_runtime_request", decision: "decline" },
          ],
        },
        streamFn,
      });
      assert.deepEqual(runIds(projection), ["completed"]);
      assert.deepEqual(
        projection.runtimeRequests.map((request) => [request.kind, request.decision]),
        [["file-change", "decline"]],
      );
      assert.isNull(yield* readWorkspaceFile(workspace, "note.txt"));
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("writes without asking in auto-accept-edits but asks before a shell command", () =>
    Effect.gen(function* () {
      const streamFn = makeStreamFn((call) =>
        call.serializedContext.includes("note.txt")
          ? scriptedTextResponse("done")
          : scriptedToolCallResponse([
              { name: "Write", arguments: { path: "note.txt", content: "written" } },
              { name: "Bash", arguments: { command: "node --version" } },
            ]),
      );
      const { projection, workspace } = yield* runPiNativeScenario({
        name: "pi-native-auto-accept-edits",
        fixtureInput: {
          runtimeMode: "auto-accept-edits",
          steps: [message("write and run"), { type: "approve_next_runtime_request" }],
        },
        streamFn,
      });
      assert.deepEqual(runIds(projection), ["completed"]);
      assert.deepEqual(
        projection.runtimeRequests.map((request) => request.kind),
        ["command"],
      );
      assert.equal(yield* readWorkspaceFile(workspace, "note.txt"), "written");
      assert.deepEqual(
        itemsOf(projection, "file_change").map((item) => item.status),
        ["completed"],
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("enforces the managed runtime-mode ceiling through the orchestrator", () =>
    Effect.gen(function* () {
      const streamFn = makeStreamFn((call) =>
        call.serializedContext.includes("note.txt")
          ? scriptedTextResponse("done")
          : scriptedToolCallResponse([
              { name: "Write", arguments: { path: "note.txt", content: "written" } },
            ]),
      );
      let refused: string | undefined;
      const { projection, workspace } = yield* runPiNativeScenario({
        name: "pi-native-managed-ceiling",
        fixtureInput: {
          runtimeMode: "approval-required",
          steps: [message("write a file"), { type: "approve_next_runtime_request" }],
        },
        streamFn,
        managedPolicy: {
          schemaVersion: 1,
          organization: "Example",
          limits: { maxRuntimeMode: "approval-required" },
        },
        after: ({ orchestrator, threadId }) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(
              orchestrator.dispatch({
                type: "thread.runtime-mode.set",
                commandId: CommandId.make("above-ceiling"),
                threadId,
                runtimeMode: "full-access",
              }),
            );
            assert.isTrue(Exit.isFailure(exit));
            refused = Exit.isFailure(exit) ? exit.cause.toString() : undefined;
          }),
      });
      assert.include(refused ?? "", "OrchestratorRuntimeModeAboveCeilingError");
      assert.deepEqual(runIds(projection), ["completed"]);
      // The clamped mode still asks before the write, and the approval is what let it run.
      assert.deepEqual(
        projection.runtimeRequests
          .filter((request) => request.kind === "file-change")
          .map((request) => request.decision),
        ["accept"],
      );
      assert.equal(yield* readWorkspaceFile(workspace, "note.txt"), "written");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("answers a structured question and finishes the turn", () =>
    Effect.gen(function* () {
      let stage = 0;
      const streamFn = makeStreamFn((call) => {
        stage += 1;
        if (stage === 1) {
          return scriptedToolCallResponse([
            { name: "ToolSearch", arguments: { query: "asktool" } },
          ]);
        }
        return call.serializedContext.includes("Which one?")
          ? scriptedTextResponse("thanks")
          : scriptedToolCallResponse([
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
            ]);
      });
      const { projection } = yield* runPiNativeScenario({
        name: "pi-native-structured-question",
        fixtureInput: {
          steps: [
            message("ask me"),
            { type: "answer_next_user_input_request", answers: { q1: "A" } },
          ],
        },
        streamFn,
      });
      assert.deepEqual(runIds(projection), ["completed"]);
      const [request] = projection.runtimeRequests.filter(
        (candidate) => candidate.kind === "user_input",
      );
      assert.equal(request?.status, "resolved");
      assert.deepEqual(request?.answers, { q1: "A" });
      assert.deepEqual(
        itemsOf(projection, "user_input_request").map((item) => item.status),
        ["completed"],
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("blocks mutations in plan mode and records the proposed plan", () =>
    Effect.gen(function* () {
      let planned = false;
      const streamFn = makeStreamFn(() => {
        if (planned) return scriptedTextResponse("should not run");
        planned = true;
        return scriptedToolCallResponse([
          { name: "Write", arguments: { path: "note.txt", content: "nope" } },
          { name: "Read", arguments: { path: "README.md" } },
          { name: "SubmitPlan", arguments: { markdown: "# Plan", summary: "Ship it" } },
        ]);
      });
      const { projection, workspace } = yield* runPiNativeScenario({
        name: "pi-native-plan-mode",
        fixtureInput: { interactionMode: "plan", steps: [message("plan it")] },
        streamFn,
      });
      assert.deepEqual(runIds(projection), ["completed"]);
      assert.isNull(yield* readWorkspaceFile(workspace, "note.txt"));
      assert.deepEqual(
        projection.runtimeRequests.filter((request) => request.status === "pending"),
        [],
      );
      const [plan] = projection.plans.filter((candidate) => candidate.kind === "proposed_plan");
      assert.equal(plan?.markdown, "# Plan");
      assert.deepEqual(
        itemsOf(projection, "proposed_plan").map((item) => item.markdown),
        ["# Plan"],
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("steers a running turn and completes once the model reads the steer", () =>
    Effect.gen(function* () {
      const streamFn = makeStreamFn((call) => {
        if (call.serializedContext.includes("steered question")) {
          return scriptedTextResponse("steered answer");
        }
        return call.serializedContext.includes("note.txt")
          ? scriptedTextResponse("after the write")
          : scriptedToolCallResponse([
              { name: "Write", arguments: { path: "note.txt", content: "written" } },
            ]);
      });
      const { projection } = yield* runPiNativeScenario({
        name: "pi-native-steering",
        fixtureInput: {
          runtimeMode: "approval-required",
          steps: [
            message("start"),
            { type: "steer", text: "steered question", targetRunIndex: 1 },
            { type: "approve_next_runtime_request" },
          ],
        },
        streamFn,
      });
      assert.deepEqual(runIds(projection), ["completed"]);
      const steerItem = projection.turnItems.find(
        (item) => item.type === "user_message" && item.text === "steered question",
      );
      // The steer belongs to the running run, and the model read it before the turn ended.
      assert.equal(steerItem?.runId, projection.runs[0]?.id);
      assert.equal(steerItem?.status, "completed");
      assert.deepEqual(
        itemsOf(projection, "assistant_message").map((item) => item.text),
        ["steered answer"],
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("interrupts a turn blocked on approval", () =>
    Effect.gen(function* () {
      const streamFn = makeStreamFn((call) =>
        call.serializedContext.includes("note.txt")
          ? scriptedTextResponse("should not run")
          : scriptedToolCallResponse([
              { name: "Write", arguments: { path: "note.txt", content: "written" } },
            ]),
      );
      const { projection, workspace } = yield* runPiNativeScenario({
        name: "pi-native-interrupt",
        fixtureInput: {
          runtimeMode: "approval-required",
          steps: [
            message("write a file"),
            {
              type: "interrupt",
              targetRunIndex: 1,
              waitForTurnItemType: "approval_request",
              waitForTurnItemStatus: "waiting",
            },
          ],
        },
        streamFn,
      });
      assert.deepEqual(runIds(projection), ["interrupted"]);
      assert.deepEqual(
        projection.runtimeRequests.map((request) => request.status),
        ["cancelled"],
      );
      assert.isFalse(
        projection.turnItems.some((item) => item.status === "running" || item.status === "waiting"),
      );
      assert.isNull(yield* readWorkspaceFile(workspace, "note.txt"));
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("compacts a conversation through a /compact run", () =>
    Effect.gen(function* () {
      const streamFn = makeStreamFn((call) =>
        call.serializedContext.includes(SUMMARY_BOOKEND)
          ? scriptedTextResponse(SUMMARY)
          : scriptedTextResponse("first answer"),
      );
      const { projection } = yield* runPiNativeScenario({
        name: "pi-native-compaction",
        fixtureInput: {
          steps: [message("Hello Pi"), message("second question"), message("/compact")],
        },
        streamFn,
      });
      assert.deepEqual(runIds(projection), ["completed", "completed", "completed"]);
      const [compaction] = itemsOf(projection, "compaction");
      assert.equal(compaction?.status, "completed");
      assert.equal(compaction?.title, "Context compacted");
      assert.include(compaction?.summary ?? "", "## Goals");
      assert.isTrue(
        streamFn.calls.some((call) => call.serializedContext.includes(SUMMARY_BOOKEND)),
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("records a delegated subagent in the projection", () =>
    Effect.gen(function* () {
      const streamFn = makeStreamFn((call) => {
        if (call.serializedContext.includes("child work"))
          return scriptedTextResponse("child report");
        return call.serializedContext.includes("parent done")
          ? scriptedTextResponse("done")
          : scriptedToolCallResponse([
              { name: "Task", arguments: { prompt: "child work", title: "Child" } },
            ]);
      });
      const { projection } = yield* runPiNativeScenario({
        name: "pi-native-subagent",
        fixtureInput: { steps: [message("delegate")] },
        streamFn,
        settings: settings({ enableSubagents: true }),
      });
      assert.deepEqual(runIds(projection), ["completed"]);
      const [subagent] = projection.subagents;
      assert.equal(subagent?.origin, "provider_native");
      assert.equal(subagent?.prompt, "child work");
      assert.equal(subagent?.status, "completed");
      assert.deepEqual(
        itemsOf(projection, "subagent").map((item) => item.title),
        ["Child"],
      );
      assert.include(
        itemsOf(projection, "assistant_message").map((item) => item.text),
        "child report",
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("rolls a conversation back to a checkpoint and continues from it", () =>
    Effect.gen(function* () {
      const streamFn = makeStreamFn((call) =>
        scriptedTextResponse(
          call.serializedContext.includes("after rollback question")
            ? "after rollback answer"
            : "earlier answer",
        ),
      );
      const { projection } = yield* runPiNativeScenario({
        name: "pi-native-rollback",
        fixtureInput: {
          steps: [
            message("first question"),
            message("second question"),
            { type: "rollback", checkpointScopeSuffix: "root", checkpointSuffix: "1" },
            message("after rollback question"),
          ],
        },
        streamFn,
      });
      assert.deepEqual(runIds(projection), ["completed", "rolled_back", "completed"]);
      const afterRollback = streamFn.calls.at(-1);
      assert.include(afterRollback?.serializedContext ?? "", "first question");
      assert.notInclude(afterRollback?.serializedContext ?? "", "second question");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("forks a thread and continues with the inherited conversation", () =>
    Effect.gen(function* () {
      const streamFn = makeStreamFn((call) =>
        scriptedTextResponse(
          call.serializedContext.includes("fork question") ? "fork answer" : "first answer",
        ),
      );
      const result = yield* runPiNativeScenario({
        name: "pi-native-fork",
        fixtureInput: {
          steps: [
            message("first question"),
            { type: "fork", fromRunIndex: 1, text: "fork question" },
          ],
        },
        streamFn,
      });
      const source = result.projection;
      const forked = [...result.projections.values()].find(
        (candidate) => candidate.thread.id !== source.thread.id,
      );
      assert.isDefined(forked);
      if (forked === undefined) return;
      assert.equal(forked.thread.lineage.parentThreadId, source.thread.id);
      assert.deepEqual(runIds(forked), ["completed"]);
      const forkPrompt = streamFn.calls.at(-1)?.serializedContext ?? "";
      assert.include(forkPrompt, "first question");
      assert.include(forkPrompt, "first answer");
      assert.include(forkPrompt, "fork question");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("reports a quota failure as a usage-limit terminal", () =>
    Effect.gen(function* () {
      const failingStreamFn: ProviderStreamFn = (model) =>
        renderScriptedTurn(
          model,
          scriptedErrorResponse("insufficient_quota: the account is out of credits"),
          0,
        );
      const { projection } = yield* runPiNativeScenario({
        name: "pi-native-usage-limit",
        fixtureInput: { steps: [message("spend money")] },
        streamFn: failingStreamFn,
      });
      assert.deepEqual(runIds(projection), ["failed"]);
      const [error] = itemsOf(projection, "error");
      assert.equal(error?.failure.class, "usage_limit");
      assert.equal(error?.status, "failed");
      assert.deepEqual(
        projection.providerTurns.map((turn) => turn.status),
        ["failed"],
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("switches model and thinking level mid-conversation through modelBindings", () =>
    Effect.gen(function* () {
      const streamFn = makeStreamFn((call) =>
        scriptedTextResponse(
          call.serializedContext.includes("third question") ? "third answer" : "answer",
        ),
      );
      const { projection } = yield* runPiNativeScenario({
        name: "pi-native-thinking-switch",
        fixtureInput: {
          steps: [
            message("first question"),
            {
              type: "set_model",
              model: "gpt-4o",
              options: [{ id: "thinking", value: "high" }],
            },
            message("second question"),
            { type: "set_model_options", options: [{ id: "thinking", value: "omit" }] },
            message("third question"),
          ],
        },
        modelSelection: {
          instanceId: INSTANCE_ID,
          model: "gpt-5.4",
          options: [{ id: "thinking", value: "low" }],
        },
        settings: settings({
          defaultModel: "gpt-5.4",
          modelBindings: [
            binding("gpt-5.4", { thinkingLevels: ["low", "medium", "high"] }),
            binding("gpt-4o", { thinkingLevels: ["low", "high"] }),
          ],
        }),
        streamFn,
      });

      assert.deepEqual(runIds(projection), ["completed", "completed", "completed"]);
      assert.deepEqual(
        streamFn.calls.map((call) => call.model.id),
        ["gpt-5.4", "gpt-4o", "gpt-4o"],
      );
      assert.deepEqual(
        streamFn.calls.map((call) => reasoningOf(call)),
        // `omit` sends no reasoning override at all, so the provider default applies.
        ["low", "high", undefined],
      );
      assert.deepEqual(
        projection.runs.map((run) => run.modelSelection.model),
        ["gpt-5.4", "gpt-4o", "gpt-4o"],
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("compacts on the next turn from the binding's own context window", () =>
    Effect.gen(function* () {
      const longAnswer = "long answer ".repeat(12_000);
      const streamFn = makeStreamFn((call) => {
        if (call.serializedContext.includes(SUMMARY_BOOKEND)) return scriptedTextResponse(SUMMARY);
        if (call.serializedContext.includes("second question")) {
          return scriptedTextResponse("second answer");
        }
        return scriptedTextResponse(longAnswer, { usage: { input: 26_000 } });
      });
      const { projection } = yield* runPiNativeScenario({
        name: "pi-native-binding-budget-compaction",
        fixtureInput: {
          steps: [message("first question"), message("second question")],
        },
        settings: settings({
          autoCompact: true,
          defaultModel: "gpt-5.4",
          modelBindings: [
            binding("gpt-5.4", {
              contextWindow: 40_000,
              contextWindowSource: "user",
              maxTokens: 8_192,
              maxTokensSource: "user",
            }),
          ],
        }),
        streamFn,
      });

      assert.deepEqual(runIds(projection), ["completed", "completed"]);
      assert.isAbove(projection.providerTurns[0]?.tokenUsage?.usedTokens ?? 0, 20_000);
      const compactions = itemsOf(projection, "compaction");
      assert.lengthOf(compactions, 1);
      const [compaction] = compactions;
      assert.equal(compaction?.status, "completed");
      // 40k window, 8k output: reserve 16,384, so auto-compaction starts at 21,254.
      assert.isAtLeast(compaction?.beforeTokenCount ?? 0, 21_254);
      assert.isBelow(compaction?.afterTokenCount ?? 0, compaction?.beforeTokenCount ?? 0);
      assert.isTrue(
        streamFn.calls.some((call) => call.serializedContext.includes(SUMMARY_BOOKEND)),
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("keeps images out of an inline block when the binding refuses them", () =>
    Effect.gen(function* () {
      const streamFn = alwaysAnswers("read the path");
      yield* runPiNativeScenario({
        name: "pi-native-image-refused",
        fixtureInput: {
          steps: [
            {
              type: "message",
              text: "look at this screenshot",
              attachments: [
                {
                  type: "image",
                  id: "shot-1",
                  name: "shot.png",
                  mimeType: "image/png",
                  sizeBytes: 2_048,
                },
              ],
            },
          ],
        },
        settings: settings({
          defaultModel: "gpt-5.4",
          modelBindings: [binding("gpt-5.4", { supportsImages: false })],
        }),
        streamFn,
      });

      const [call] = streamFn.calls;
      const userMessage = call?.context.messages.findLast((entry) => entry.role === "user");
      assert.isDefined(userMessage);
      // A refused image reaches the model as a safe path in the prompt text instead.
      assert.isString(userMessage?.content);
      assert.include(String(userMessage?.content), "Attached image");
      assert.notInclude(call?.serializedContext ?? "", '"type":"image"');
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("advertises and runs only subagent models that opted in", () =>
    Effect.gen(function* () {
      const streamFn = makeStreamFn((call) => {
        if (call.serializedContext.includes("child work"))
          return scriptedTextResponse("child report");
        return call.serializedContext.includes("parent done")
          ? scriptedTextResponse("done")
          : scriptedToolCallResponse([
              {
                name: "Task",
                arguments: { prompt: "child work", title: "Child", model: "fast-sub-model" },
              },
            ]);
      });
      const { projection } = yield* runPiNativeScenario({
        name: "pi-native-subagent-opt-in",
        fixtureInput: { steps: [message("delegate")] },
        settings: settings({
          enableSubagents: true,
          defaultModel: "parent-model",
          modelBindings: [
            binding("parent-model"),
            binding("fast-sub-model", { availableForSubagents: true }),
            binding("hidden-sub-model"),
          ],
        }),
        streamFn,
      });

      assert.deepEqual(runIds(projection), ["completed"]);
      const parentContext = streamFn.calls[0]?.serializedContext ?? "";
      assert.include(parentContext, "fast-sub-model");
      assert.notInclude(parentContext, "hidden-sub-model");
      const childCall = streamFn.calls.find(
        (call) =>
          call.model.id === "fast-sub-model" && call.serializedContext.includes("child work"),
      );
      assert.isDefined(childCall);
      const [subagent] = projection.subagents;
      assert.equal(subagent?.model, "fast-sub-model");
      assert.equal(subagent?.status, "completed");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("sanitizes custom headers and routes OpenCode Go per model wire API", () =>
    Effect.gen(function* () {
      const streamFn = makeStreamFn((call) =>
        scriptedTextResponse(
          call.serializedContext.includes("second question") ? "second answer" : "first answer",
        ),
      );
      const { projection, threadId } = yield* runPiNativeScenario({
        name: "pi-native-opencode-go-headers",
        fixtureInput: {
          steps: [
            message("first question"),
            { type: "set_model", model: "glm-5" },
            message("second question"),
          ],
        },
        settings: settings({
          apiStyle: "opencode-go",
          defaultModel: "claude-sonnet-4-6",
          headers: {
            "X-Tenant": "acme",
            Authorization: "forged",
            "x-api-key": "forged",
          },
          modelBindings: [binding("claude-sonnet-4-6"), binding("glm-5")],
        }),
        streamFn,
      });

      assert.deepEqual(runIds(projection), ["completed", "completed"]);
      const [claude, glm] = streamFn.calls;
      assert.equal(claude?.model.id, "claude-sonnet-4-6");
      assert.equal(claude?.model.api, "anthropic-messages");
      assert.equal(claude?.model.provider, "opencode-go");
      assert.equal(claude?.model.baseUrl, "https://opencode.ai/zen/go");
      assert.equal(glm?.model.id, "glm-5");
      assert.equal(glm?.model.api, "openai-completions");
      // The custom header and stable OpenCode routing session travel; transport-owned auth headers never do.
      assert.deepEqual(headersOf(claude), {
        "X-Tenant": "acme",
        "x-opencode-session": threadId,
      });
      assert.deepEqual(headersOf(glm), {
        "X-Tenant": "acme",
        "x-opencode-session": threadId,
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("projects TodoWrite plans and lets the model verify state with TodoRead", () =>
    Effect.gen(function* () {
      let stage = 0;
      const streamFn = makeStreamFn(() => {
        stage += 1;
        if (stage === 1) {
          return scriptedToolCallResponse([{ name: "ToolSearch", arguments: { query: "todo" } }]);
        }
        if (stage === 2) {
          return scriptedToolCallResponse([
            {
              name: "TodoWrite",
              arguments: {
                steps: [
                  { id: "1", text: "Inspect files", status: "completed" },
                  { id: "2", text: "Verify output", status: "running" },
                ],
                explanation: "Working through tasks",
              },
            },
          ]);
        }
        if (stage === 3) {
          return scriptedToolCallResponse([
            {
              name: "TodoWrite",
              arguments: { steps: [{ id: "1", text: "   ", status: "pending" }] },
            },
            { name: "TodoRead", arguments: {} },
          ]);
        }
        if (stage === 4) {
          return scriptedToolCallResponse([
            {
              name: "TodoWrite",
              arguments: {
                steps: [
                  { id: "1", text: "Inspect files", status: "completed" },
                  { id: "2", text: "Verify output", status: "completed" },
                ],
              },
            },
          ]);
        }
        return scriptedTextResponse("done");
      });

      const { projection } = yield* runPiNativeScenario({
        name: "pi-native-todo-write-read",
        fixtureInput: { steps: [message("manage todo checklist")] },
        streamFn,
      });

      assert.deepEqual(runIds(projection), ["completed"]);
      assert.include(
        streamFn.calls[3]?.serializedContext ?? "",
        "Current todo list (revision 1; 1/2 completed, 1 running, 0 pending):",
      );
      assert.include(streamFn.calls[3]?.serializedContext ?? "", "- [running] (2) Verify output");

      const todoPlans = projection.plans.filter((plan) => plan.kind === "todo_list");
      assert.deepEqual(
        todoPlans.map((plan) => plan.status),
        ["superseded", "completed"],
      );
      assert.equal(todoPlans[1]?.steps[1]?.status, "completed");

      const todoItems = itemsOf(projection, "todo_list");
      assert.lengthOf(todoItems, 2);
      assert.isTrue(projection.nodes.some((node) => node.kind === "todo_list"));

      const dynamicTools = itemsOf(projection, "dynamic_tool");
      assert.isTrue(
        dynamicTools.some((item) => item.toolName === "TodoWrite" && item.status === "failed"),
      );
      assert.isTrue(
        dynamicTools.some((item) => item.toolName === "TodoRead" && item.status === "completed"),
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("runs two app threads of one piNative instance in parallel", () =>
    Effect.gen(function* () {
      const workspace = yield* checkpointWorkspace("pi-native-v2-parallel-threads");
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const projectId = yield* idAllocator.allocate.project({ fixtureName: "pi-native-parallel" });
      const firstThreadId = yield* idAllocator.allocate.thread({
        fixtureName: "pi-native-parallel-first",
        projectId,
      });
      const secondThreadId = yield* idAllocator.allocate.thread({
        fixtureName: "pi-native-parallel-second",
        projectId,
      });
      const firstPrompt = "first thread question";
      const secondPrompt = "second thread question";
      const commands: Array<OrchestrationV2Command> = [
        createThreadCommand({
          commandId: yield* idAllocator.allocate.command({
            fixtureName: "pi-native-parallel",
            commandName: "create-first",
          }),
          projectId,
          threadId: firstThreadId,
          title: "First thread",
        }),
        createThreadCommand({
          commandId: yield* idAllocator.allocate.command({
            fixtureName: "pi-native-parallel",
            commandName: "create-second",
          }),
          projectId,
          threadId: secondThreadId,
          title: "Second thread",
        }),
      ];
      const firstMessage = dispatchTextCommand({
        commandId: yield* idAllocator.allocate.command({
          fixtureName: "pi-native-parallel",
          commandName: "first-message",
        }),
        threadId: firstThreadId,
        messageId: yield* idAllocator.allocate.message({ threadId: firstThreadId, ordinal: 1 }),
        text: firstPrompt,
      });
      const secondMessage = dispatchTextCommand({
        commandId: yield* idAllocator.allocate.command({
          fixtureName: "pi-native-parallel",
          commandName: "second-message",
        }),
        threadId: secondThreadId,
        messageId: yield* idAllocator.allocate.message({ threadId: secondThreadId, ordinal: 1 }),
        text: secondPrompt,
      });
      commands.push(firstMessage, secondMessage);
      const firstRunId = idAllocator.derive.run({ threadId: firstThreadId, ordinal: 1 });
      const secondRunId = idAllocator.derive.run({ threadId: secondThreadId, ordinal: 1 });

      // The first thread's provider request stays open until after the second thread's run ends.
      const gate = makeProviderReplayGate(["first-thread-turn"]);
      const streamFn: ProviderStreamFn = (model, context) =>
        JSON.stringify(context.messages).includes(firstPrompt)
          ? gate
              .beforeEmit("first-thread-turn")
              .then(() => renderScriptedTurn(model, scriptedTextResponse("first answer"), 0))
          : renderScriptedTurn(model, scriptedTextResponse("second answer"), 0);

      const result = yield* runPiNativeThreads({
        name: "pi-native-parallel-threads",
        workspace,
        streamFn,
        commands,
        threadIds: [firstThreadId, secondThreadId],
        replayGate: gate,
        steps: [
          { type: "dispatch", command: commands[0]! },
          { type: "dispatch", command: commands[1]! },
          { type: "dispatch", command: firstMessage },
          { type: "advance_clock", duration: "1 millis" },
          {
            type: "await_run_status",
            threadId: firstThreadId,
            runId: firstRunId,
            status: "running",
          },
          { type: "dispatch", command: secondMessage },
          { type: "advance_clock", duration: "1 millis" },
          {
            type: "await_run_status",
            threadId: secondThreadId,
            runId: secondRunId,
            status: "completed",
          },
          { type: "release_replay_gate", label: "first-thread-turn" },
          {
            type: "await_run_status",
            threadId: firstThreadId,
            runId: firstRunId,
            status: "completed",
          },
        ],
      });

      const first = result.projections.get(firstThreadId);
      const second = result.projections.get(secondThreadId);
      assert.isDefined(first);
      assert.isDefined(second);
      if (first === undefined || second === undefined) return;
      assert.deepEqual(runIds(first), ["completed"]);
      assert.deepEqual(runIds(second), ["completed"]);
      assert.deepEqual(
        itemsOf(first, "assistant_message").map((item) => item.text),
        ["first answer"],
      );
      assert.deepEqual(
        itemsOf(second, "assistant_message").map((item) => item.text),
        ["second answer"],
      );
      const firstSession = providerSessionOf(first);
      const secondSession = providerSessionOf(second);
      assert.isString(firstSession);
      assert.isString(secondSession);
      assert.notEqual(firstSession, secondSession);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("gives pre-upgrade threads sharing the legacy session their own sessions", () =>
    Effect.gen(function* () {
      const workspace = yield* checkpointWorkspace("pi-native-v2-legacy-sessions");
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({ fixtureName: "pi-native-legacy" });
      const firstThreadId = yield* idAllocator.allocate.thread({
        fixtureName: "pi-native-legacy-first",
        projectId,
      });
      const secondThreadId = yield* idAllocator.allocate.thread({
        fixtureName: "pi-native-legacy-second",
        projectId,
      });
      // What an upgrade finds: two threads persisted against the one shared session.
      const legacySharedSession = IdAllocator.derive.providerSession({
        providerInstanceId: INSTANCE_ID,
      });
      const firstProviderThread = legacyProviderThread({
        idAllocator,
        threadId: firstThreadId,
        nativeThreadId: "legacy-first",
        providerSessionId: legacySharedSession,
        now,
      });
      const secondProviderThread = legacyProviderThread({
        idAllocator,
        threadId: secondThreadId,
        nativeThreadId: "legacy-second",
        providerSessionId: legacySharedSession,
        now,
      });
      const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
        {
          id: yield* idAllocator.allocate.event({ threadId: firstThreadId }),
          type: "thread.created",
          threadId: firstThreadId,
          occurredAt: now,
          payload: legacyAppThread({
            threadId: firstThreadId,
            projectId,
            providerThreadId: firstProviderThread.id,
            now,
          }),
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: firstThreadId }),
          type: "provider-thread.updated",
          threadId: firstThreadId,
          occurredAt: now,
          payload: firstProviderThread,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: secondThreadId }),
          type: "thread.created",
          threadId: secondThreadId,
          occurredAt: now,
          payload: legacyAppThread({
            threadId: secondThreadId,
            projectId,
            providerThreadId: secondProviderThread.id,
            now,
          }),
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: secondThreadId }),
          type: "provider-thread.updated",
          threadId: secondThreadId,
          occurredAt: now,
          payload: secondProviderThread,
        },
      ];

      const firstPrompt = "first thread question";
      const secondPrompt = "second thread question";
      const firstMessage = dispatchTextCommand({
        commandId: yield* idAllocator.allocate.command({
          fixtureName: "pi-native-legacy",
          commandName: "first-message",
        }),
        threadId: firstThreadId,
        messageId: yield* idAllocator.allocate.message({ threadId: firstThreadId, ordinal: 1 }),
        text: firstPrompt,
      });
      const secondMessage = dispatchTextCommand({
        commandId: yield* idAllocator.allocate.command({
          fixtureName: "pi-native-legacy",
          commandName: "second-message",
        }),
        threadId: secondThreadId,
        messageId: yield* idAllocator.allocate.message({ threadId: secondThreadId, ordinal: 1 }),
        text: secondPrompt,
      });
      const firstRunId = idAllocator.derive.run({ threadId: firstThreadId, ordinal: 1 });
      const secondRunId = idAllocator.derive.run({ threadId: secondThreadId, ordinal: 1 });

      const gate = makeProviderReplayGate(["first-thread-turn"]);
      const streamFn: ProviderStreamFn = (model, context) =>
        JSON.stringify(context.messages).includes(firstPrompt)
          ? gate
              .beforeEmit("first-thread-turn")
              .then(() => renderScriptedTurn(model, scriptedTextResponse("first answer"), 0))
          : renderScriptedTurn(model, scriptedTextResponse("second answer"), 0);

      const result = yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        yield* eventSink.write({ events });
        return yield* runOrchestratorV2Scenario(
          {
            name: "pi-native-legacy-sessions",
            commands: [firstMessage, secondMessage],
            steps: [
              { type: "dispatch", command: firstMessage },
              { type: "advance_clock", duration: "1 millis" },
              {
                type: "await_run_status",
                threadId: firstThreadId,
                runId: firstRunId,
                status: "running",
              },
              { type: "dispatch", command: secondMessage },
              { type: "advance_clock", duration: "1 millis" },
              {
                type: "await_run_status",
                threadId: secondThreadId,
                runId: secondRunId,
                status: "completed",
              },
              { type: "release_replay_gate", label: "first-thread-turn" },
              {
                type: "await_run_status",
                threadId: firstThreadId,
                runId: firstRunId,
                status: "completed",
              },
            ],
            projectionThreadIds: [firstThreadId, secondThreadId],
          },
          { replayGate: gate },
        );
      }).pipe(
        Effect.provide(
          layerWithRegistry(
            {
              name: "pi-native-legacy-sessions",
              runtimePolicyOverride: { cwd: workspace },
            },
            registryLayer({ streamFn, settings: settings() }),
            {},
          ),
        ),
        provideDeterministicTestRuntime,
      );

      const first = result.projections.get(firstThreadId);
      const second = result.projections.get(secondThreadId);
      assert.isDefined(first);
      assert.isDefined(second);
      if (first === undefined || second === undefined) return;
      assert.deepEqual(runIds(first), ["completed"]);
      assert.deepEqual(runIds(second), ["completed"]);
      assert.deepEqual(
        itemsOf(first, "assistant_message").map((item) => item.text),
        ["first answer"],
      );
      assert.deepEqual(
        itemsOf(second, "assistant_message").map((item) => item.text),
        ["second answer"],
      );
      const firstSession = providerSessionOf(first);
      const secondSession = providerSessionOf(second);
      assert.isString(firstSession);
      assert.isString(secondSession);
      assert.notEqual(firstSession, secondSession);
      assert.notEqual(firstSession, legacySharedSession);
      assert.notEqual(secondSession, legacySharedSession);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
