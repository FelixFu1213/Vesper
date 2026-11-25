// @effect-diagnostics nodeBuiltinImport:off -- The sandbox needs a real workspace file on disk.
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { OrchestrationV2ProviderGoal } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";

import { PiNativeSettings } from "../../settings.ts";
import {
  createScriptedStreamFn,
  renderScriptedTurn,
  scriptedErrorResponse,
  scriptedTextResponse,
  scriptedToolCallResponse,
  type ScriptedStep,
  type ScriptedStreamFn,
} from "../../testing.ts";
import {
  NativePiSessionRuntime,
  parseCompactionSummary,
  type NativeSessionEvent,
} from "./sessionRuntime.ts";
import type { ToolApprovalRequest } from "./permissions.ts";
import type { PiNativeSkillDef } from "./skillsDiscovery.ts";

const decodeSettings = Schema.decodeSync(PiNativeSettings);

const instanceId = ProviderInstanceId.make("piNative");

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

const policy = (
  overrides: Partial<Parameters<typeof makeRuntime>[0]> & Record<string, unknown> = {},
) => overrides;

interface RuntimeHarness {
  readonly runtime: NativePiSessionRuntime;
  readonly events: NativeSessionEvent[];
  readonly streamFn: ScriptedStreamFn;
  readonly approvals: ToolApprovalRequest[];
}

const makeRuntime = async (
  input: {
    readonly steps?: ReadonlyArray<ScriptedStep>;
    readonly settings?: PiNativeSettings;
    readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
    readonly interactionMode?: "default" | "plan";
    readonly cwd?: string | null;
    readonly autoApprove?: boolean;
    readonly answers?: Record<string, unknown>;
    readonly fetch?: typeof globalThis.fetch;
    readonly mcpSession?: {
      readonly endpoint: string;
      readonly authorizationHeader: string;
    };
    readonly initialGoal?: OrchestrationV2ProviderGoal | null;
    readonly maxGoalChecks?: number;
    readonly streamFn?: StreamFn;
    readonly threadId?: string;
    readonly shell?: { readonly command: string; readonly args: ReadonlyArray<string> };
    readonly skills?: ReadonlyArray<PiNativeSkillDef>;
    readonly discoverSkills?: () => Promise<ReadonlyArray<PiNativeSkillDef>>;
    readonly piAgentDir?: string;
  } = {},
): Promise<RuntimeHarness> => {
  const events: NativeSessionEvent[] = [];
  const approvals: ToolApprovalRequest[] = [];
  const streamFn = createScriptedStreamFn(input.steps ?? [], { now: () => 0 });
  const runtime = await NativePiSessionRuntime.create({
    settings: input.settings ?? settings(),
    modelSelection: { instanceId, model: "default" },
    runtimePolicy: {
      runtimeMode: input.runtimeMode ?? "full-access",
      interactionMode: input.interactionMode ?? "default",
      cwd: input.cwd ?? null,
    },
    onEvent: (event) => events.push(event),
    requestApproval: async (request) => {
      approvals.push(request);
      return input.autoApprove === false ? { decision: "decline" } : { decision: "accept" };
    },
    requestUserInput: async () => input.answers ?? { answer: "yes" },
    ...(input.initialGoal === undefined ? {} : { initialGoal: input.initialGoal }),
    ...(input.maxGoalChecks === undefined ? {} : { maxGoalChecks: input.maxGoalChecks }),
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    ...(input.shell === undefined ? {} : { shell: input.shell }),
    // A developer's own global AGENTS.md and SYSTEM.md must never reach a test.
    piAgentDir: input.piAgentDir ?? (await workspace()),
    now: () => 0,
    streamFn: input.streamFn ?? streamFn,
    scheduleTimer: () => () => undefined,
    sleep: async () => undefined,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    // A developer's own installed skills must never reach a unit test.
    discoverSkills:
      input.discoverSkills !== undefined
        ? async () => ({ skills: await input.discoverSkills!(), serverSkills: [] })
        : async () => ({ skills: input.skills ?? [], serverSkills: [] }),
    ...(input.mcpSession === undefined
      ? {}
      : {
          mcpSession: {
            environmentId: "env-1" as never,
            threadId: "thread-1" as never,
            providerSessionId: "session-1",
            providerInstanceId: instanceId,
            endpoint: input.mcpSession.endpoint,
            authorizationHeader: input.mcpSession.authorizationHeader,
            browserToolsAvailable: true,
          },
        }),
  });
  return { runtime, events, streamFn, approvals };
};

const streamTexts = (events: ReadonlyArray<NativeSessionEvent>): string[] =>
  events.flatMap((event) => (event.type === "stream" && event.done ? [event.text] : []));

const toolNames = (events: ReadonlyArray<NativeSessionEvent>): string[] =>
  events.flatMap((event) =>
    event.type === "tool" && event.phase === "start" ? [event.toolName] : [],
  );

const workspace = async (files: Record<string, string> = {}): Promise<string> => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-native-runtime-"));
  for (const [name, content] of Object.entries(files)) {
    await NodeFSP.writeFile(NodePath.join(dir, name), content, "utf8");
  }
  return dir;
};

const writeFiles = async (root: string, files: Record<string, string>): Promise<void> => {
  for (const [name, content] of Object.entries(files)) {
    const target = NodePath.join(root, name);
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, content, "utf8");
  }
};

const isSystem = (message: { readonly role: string }): boolean => message.role === "system";

const systemSections = (message: unknown): Record<string, string | null> =>
  typeof message === "object" && message !== null && "sections" in message
    ? ((message as { readonly sections?: Record<string, string | null> }).sections ?? {})
    : {};

/** Only the system deltas of one request, never the leading system message. */
const requestDeltas = (
  messages: ReadonlyArray<unknown>,
): ReadonlyArray<Record<string, string | null>> =>
  messages
    .slice(1)
    .filter(
      (message): message is { readonly role: "system" } =>
        typeof message === "object" &&
        message !== null &&
        (message as { readonly role?: unknown }).role === "system",
    )
    .map((message) => systemSections(message));

describe("NativePiSessionRuntime", () => {
  it("streams assistant text and reasoning with usage", async () => {
    const harness = await makeRuntime({
      steps: [scriptedTextResponse("Hello there", { reasoning: "plan first" })],
    });
    const outcome = await harness.runtime.runTurn({ text: "hi" });
    assert.equal(outcome.status, "completed");
    assert.deepStrictEqual(streamTexts(harness.events), ["plan first", "Hello there"]);
    const usage = harness.events.filter((event) => event.type === "usage");
    assert.lengthOf(usage, 1);
    assert.equal(usage[0]?.type === "usage" ? usage[0].usage.inputTokens : 0, 1_000);
    assert.deepStrictEqual(
      harness.runtime.getSnapshot().messages.map((message) => message.role),
      ["user", "assistant"],
    );
    await harness.runtime.dispose();
  });

  it("blocks mutating tools in plan mode and accepts a submitted plan", async () => {
    const cwd = await workspace({ "notes.txt": "hello\n" });
    const harness = await makeRuntime({
      cwd,
      interactionMode: "plan",
      steps: [
        scriptedToolCallResponse([
          { name: "Write", arguments: { path: "notes.txt", content: "overwritten" } },
        ]),
        scriptedToolCallResponse([
          { name: "Read", arguments: { path: "notes.txt" } },
          { name: "SubmitPlan", arguments: { markdown: "# Plan", summary: "Do it" } },
        ]),
        scriptedTextResponse("done"),
      ],
    });
    const outcome = await harness.runtime.runTurn({ text: "plan it" });
    assert.equal(outcome.status, "completed");
    assert.deepStrictEqual(toolNames(harness.events), ["Write", "Read", "SubmitPlan"]);
    const results = harness.events.flatMap((event) =>
      event.type === "tool" && event.phase === "end"
        ? [{ name: event.toolName, isError: event.isError === true }]
        : [],
    );
    assert.deepStrictEqual(results[0], { name: "Write", isError: true });
    assert.deepStrictEqual(results[1], { name: "Read", isError: false });
    const plan = harness.events.find((event) => event.type === "plan_submitted");
    assert.equal(plan?.type === "plan_submitted" ? plan.markdown : "", "# Plan");
    assert.equal(await NodeFSP.readFile(NodePath.join(cwd, "notes.txt"), "utf8"), "hello\n");
    await harness.runtime.dispose();
  });

  it("reports todo updates from the plan tool", async () => {
    const harness = await makeRuntime({
      steps: [
        scriptedToolCallResponse([
          {
            name: "TodoWrite",
            arguments: {
              steps: [
                { id: "1", text: "Read", status: "completed" },
                { id: "2", text: "Write", status: "running" },
              ],
            },
          },
        ]),
        scriptedTextResponse("done"),
      ],
    });
    await harness.runtime.runTurn({ text: "make a plan" });
    const todo = harness.events.find((event) => event.type === "todo_updated");
    assert.equal(todo?.type === "todo_updated" ? todo.steps.length : 0, 2);
    await harness.runtime.dispose();
  });

  it("validates TodoWrite atomically, persists across compaction, and exposes TodoRead", async () => {
    const harness = await makeRuntime({
      steps: [
        scriptedToolCallResponse([
          {
            name: "TodoWrite",
            arguments: {
              steps: [
                { id: "s1", text: "Read code", status: "completed" },
                { id: "s2", text: "Implement TodoRead", status: "running" },
              ],
              explanation: "Track progress",
            },
          },
        ]),
        scriptedToolCallResponse([
          {
            name: "TodoWrite",
            arguments: {
              steps: [
                { id: "dup", text: "First", status: "pending" },
                { id: "dup", text: "Second", status: "pending" },
              ],
            },
          },
          { name: "TodoRead", arguments: {} },
        ]),
        scriptedToolCallResponse([
          {
            name: "TodoWrite",
            arguments: {
              steps: [
                { id: "s1", text: "Read code", status: "completed" },
                { id: "s2", text: "Implement TodoRead", status: "completed" },
              ],
            },
          },
          { name: "TodoRead", arguments: {} },
        ]),
        scriptedTextResponse("all set"),
        scriptedTextResponse("follow up ok"),
        scriptedTextResponse(
          "<compaction_summary>\n## Goals\nTodos\n## Progress\nDone\n## Files\n(none)\n## Decisions\n(none)\n## Next Steps\nVerify\n</compaction_summary>",
        ),
        scriptedToolCallResponse([{ name: "TodoRead", arguments: {} }]),
        scriptedTextResponse("confirmed after compaction"),
      ],
    });
    const outcome = await harness.runtime.runTurn({ text: "track tasks" });
    assert.equal(outcome.status, "completed");

    const todoEvents = harness.events.filter((event) => event.type === "todo_updated");
    assert.lengthOf(todoEvents, 2);

    const toolEnds = harness.events.filter(
      (event): event is Extract<NativeSessionEvent, { type: "tool" }> =>
        event.type === "tool" && event.phase === "end",
    );
    const invalidWrite = toolEnds[1];
    assert.equal(invalidWrite?.toolName, "TodoWrite");
    assert.isTrue(invalidWrite?.isError);

    const readAfterInvalid = toolEnds[2];
    assert.equal(readAfterInvalid?.toolName, "TodoRead");
    assert.include(
      readAfterInvalid?.output ?? "",
      "revision 1; 1/2 completed, 1 running, 0 pending",
    );
    assert.include(readAfterInvalid?.output ?? "", "- [running] (s2) Implement TodoRead");

    const readAfterUpdate = toolEnds[4];
    assert.equal(readAfterUpdate?.toolName, "TodoRead");
    assert.include(
      readAfterUpdate?.output ?? "",
      "revision 2; 2/2 completed, 0 running, 0 pending",
    );

    const followUp = await harness.runtime.runTurn({ text: "follow up" });
    assert.equal(followUp.status, "completed");

    await harness.runtime.compactManually();
    assert.include(
      JSON.stringify(harness.streamFn.calls.at(-1)?.context.messages ?? []),
      "Current todo list (revision 2):",
    );
    assert.deepStrictEqual(harness.runtime.todos, {
      revision: 2,
      steps: [
        { id: "s1", text: "Read code", status: "completed" },
        { id: "s2", text: "Implement TodoRead", status: "completed" },
      ],
    });

    const postCompact = await harness.runtime.runTurn({ text: "verify todos" });
    assert.equal(postCompact.status, "completed");
    const readPostCompact = harness.events.findLast(
      (event) => event.type === "tool" && event.phase === "end" && event.toolName === "TodoRead",
    );
    assert.include(
      readPostCompact?.type === "tool" ? (readPostCompact.output ?? "") : "",
      "Current todo list (revision 2; 2/2 completed",
    );
    await harness.runtime.dispose();
  });

  it("restores todo state when truncating turns", async () => {
    const harness = await makeRuntime({
      steps: [
        scriptedToolCallResponse([
          {
            name: "TodoWrite",
            arguments: { steps: [{ id: "1", text: "Turn 1", status: "running" }] },
          },
        ]),
        scriptedTextResponse("turn 1 done"),
        scriptedToolCallResponse([
          {
            name: "TodoWrite",
            arguments: { steps: [{ id: "2", text: "Turn 2", status: "completed" }] },
          },
        ]),
        scriptedTextResponse("turn 2 done"),
      ],
    });
    await harness.runtime.runTurn({ text: "first" });
    await harness.runtime.runTurn({ text: "second" });
    assert.equal(harness.runtime.todos.revision, 2);

    harness.runtime.truncateToTurn(1);
    assert.deepStrictEqual(harness.runtime.todos, {
      revision: 1,
      steps: [{ id: "1", text: "Turn 1", status: "running" }],
    });

    harness.runtime.truncateToTurn(0);
    assert.deepStrictEqual(harness.runtime.todos, { revision: 0, steps: [] });
    await harness.runtime.dispose();
  });

  it("keeps subagent TodoWrite and TodoRead isolated from parent todos", async () => {
    const harness = await makeRuntime({
      settings: settings({ enableSubagents: true }),
      steps: [
        scriptedToolCallResponse([
          {
            name: "TodoWrite",
            arguments: { steps: [{ id: "p1", text: "Parent task", status: "running" }] },
          },
        ]),
        scriptedToolCallResponse([
          { name: "Task", arguments: { prompt: "child work", title: "Child" } },
        ]),
        scriptedToolCallResponse([
          {
            name: "TodoWrite",
            arguments: { steps: [{ id: "c1", text: "Child task", status: "completed" }] },
          },
          { name: "TodoRead", arguments: {} },
        ]),
        scriptedTextResponse("child report"),
        scriptedToolCallResponse([{ name: "TodoRead", arguments: {} }]),
        scriptedTextResponse("parent done"),
      ],
    });
    const outcome = await harness.runtime.runTurn({ text: "delegate" });
    assert.equal(outcome.status, "completed");

    const parentTodoEvents = harness.events.filter((event) => event.type === "todo_updated");
    assert.lengthOf(parentTodoEvents, 1);
    assert.deepStrictEqual(harness.runtime.todos, {
      revision: 1,
      steps: [{ id: "p1", text: "Parent task", status: "running" }],
    });
    const parentRead = harness.events.findLast(
      (event) => event.type === "tool" && event.phase === "end" && event.toolName === "TodoRead",
    );
    assert.include(
      parentRead?.type === "tool" ? (parentRead.output ?? "") : "",
      "- [running] (p1) Parent task",
    );
    await harness.runtime.dispose();
  });

  it("marks a steer completed once the next request reads it", async () => {
    const harness = await makeRuntime({
      steps: [
        async () => {
          harness.runtime.steer({ messageId: "message-steer", text: "also do this" });
          return scriptedToolCallResponse([
            {
              name: "TodoWrite",
              arguments: { steps: [{ id: "1", text: "x", status: "pending" }] },
            },
          ]);
        },
        scriptedTextResponse("done"),
      ],
    });
    await harness.runtime.runTurn({ text: "start" });
    const steer = harness.events.filter((event) => event.type === "steer");
    assert.deepStrictEqual(
      steer.map((event) => (event.type === "steer" ? event.status : "")),
      ["completed"],
    );
    await harness.runtime.dispose();
  });

  it("runs one more turn when a steer arrives after the loop settled", async () => {
    const harness = await makeRuntime({
      steps: [scriptedTextResponse("first"), scriptedTextResponse("second")],
    });
    const outcome = await harness.runtime.runTurn({
      text: "start",
      onLoopSettled: () => {
        harness.runtime.steer({ messageId: "late-steer", text: "one more thing" });
      },
    });
    assert.equal(outcome.status, "completed");
    assert.deepStrictEqual(streamTexts(harness.events), ["first", "second"]);
    assert.equal(harness.streamFn.calls.length, 2);
    await harness.runtime.dispose();
  });

  it("declines a steer when no turn is running", async () => {
    const harness = await makeRuntime();
    assert.equal(harness.runtime.steer({ messageId: "idle", text: "hi" }), "declined");
    await harness.runtime.dispose();
  });

  it("interrupts a running turn and settles it", async () => {
    const harness = await makeRuntime({
      steps: [
        async () => {
          await harness.runtime.abort();
          return scriptedErrorResponse("aborted by the user", { stopReason: "aborted" });
        },
      ],
    });
    const outcome = await harness.runtime.runTurn({ text: "start" });
    assert.equal(outcome.status, "interrupted");
    assert.isNull(outcome.failure);
    await harness.runtime.dispose();
  });

  it("compacts on context overflow and continues the turn", async () => {
    const harness = await makeRuntime({
      settings: settings({ autoCompact: true }),
      steps: [
        scriptedToolCallResponse([
          { name: "TodoWrite", arguments: { steps: [{ id: "1", text: "x", status: "running" }] } },
        ]),
        scriptedTextResponse("first answer", { usage: { input: 400_000, output: 10 } }),
        scriptedTextResponse(
          "<compaction_summary>\n## Goals\nKeep going\n## Progress\nOne answer\n## Files\n(none)\n## Decisions\n(none)\n## Next Steps\nFinish\n</compaction_summary>",
        ),
        scriptedTextResponse("second answer"),
      ],
    });
    const outcome = await harness.runtime.runTurn({ text: "start" });
    assert.equal(outcome.status, "completed");
    const compaction = harness.events.filter((event) => event.type === "compaction");
    assert.deepStrictEqual(
      compaction.map((event) => (event.type === "compaction" ? event.status : "")),
      ["running", "completed"],
    );
    assert.deepStrictEqual(streamTexts(harness.events), ["first answer", "second answer"]);
    await harness.runtime.dispose();
  });

  it("recovers an overflow the provider reports as an error", async () => {
    const harness = await makeRuntime({
      settings: settings({ autoCompact: true }),
      steps: [
        scriptedErrorResponse("prompt is too long: 250000 tokens > 200000 maximum"),
        scriptedTextResponse(
          "<compaction_summary>\n## Goals\nKeep going\n## Progress\nNothing yet\n## Files\n(none)\n## Decisions\n(none)\n## Next Steps\nRetry\n</compaction_summary>",
        ),
        scriptedTextResponse("recovered answer"),
      ],
    });
    const outcome = await harness.runtime.runTurn({ text: "start" });
    assert.equal(outcome.status, "completed");
    assert.isNull(outcome.failure);
    const compaction = harness.events.filter((event) => event.type === "compaction");
    assert.isTrue(compaction.length > 0);
    assert.equal(
      compaction.at(-1)?.type === "compaction" ? compaction.at(-1)?.status : "",
      "completed",
    );
    assert.deepStrictEqual(streamTexts(harness.events), ["recovered answer"]);
    assert.equal(harness.streamFn.calls.length, 3);
    const snapshot = harness.runtime.getSnapshot();
    assert.deepStrictEqual(
      snapshot.messages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.isFalse(
      snapshot.messages.some((message) => message.text.includes("prompt is too long")),
    );
    await harness.runtime.dispose();
  });

  it("does not retry an overflow twice", async () => {
    const harness = await makeRuntime({
      settings: settings({ autoCompact: true }),
      steps: [
        scriptedErrorResponse("prompt is too long: 250000 tokens > 200000 maximum"),
        scriptedTextResponse(
          "<compaction_summary>\n## Goals\nKeep going\n## Progress\nNothing yet\n## Files\n(none)\n## Decisions\n(none)\n## Next Steps\nRetry\n</compaction_summary>",
        ),
        scriptedErrorResponse("prompt is too long: 250000 tokens > 200000 maximum"),
      ],
    });
    const outcome = await harness.runtime.runTurn({ text: "start" });
    assert.equal(outcome.status, "failed");
    assert.equal(harness.streamFn.calls.length, 3);
    await harness.runtime.dispose();
  });

  it("compacts manually and truncates history to a turn count", async () => {
    const harness = await makeRuntime({
      steps: [
        scriptedTextResponse("one"),
        scriptedTextResponse("two"),
        scriptedTextResponse(
          "<compaction_summary>\n## Goals\nKeep going\n## Progress\nTwo answers\n## Files\n(none)\n## Decisions\n(none)\n## Next Steps\nFinish\n</compaction_summary>",
        ),
      ],
    });
    await harness.runtime.runTurn({ text: "first" });
    await harness.runtime.runTurn({ text: "second" });
    assert.lengthOf(harness.runtime.getSnapshot().turnBoundaries, 2);
    const compacted = await harness.runtime.compactManually();
    assert.isAbove(compacted.summary.length, 0);
    assert.isAbove(compacted.beforeTokenCount, 0);
    harness.runtime.truncateToTurn(1);
    assert.lengthOf(harness.runtime.getSnapshot().turnBoundaries, 1);
    await harness.runtime.dispose();
  });

  it("rehydrates T3 history and forks a clone at a turn boundary", async () => {
    const harness = await makeRuntime();
    harness.runtime.rehydrateFromHistory([
      {
        role: "user",
        text: "earlier question",
        threadId: "thread-1" as never,
        runId: null,
        itemId: "item-1" as never,
        providerThreadId: null,
        status: "completed",
        kind: "user_message",
      },
      {
        role: "assistant",
        text: "earlier answer",
        threadId: "thread-1" as never,
        runId: null,
        itemId: "item-2" as never,
        providerThreadId: null,
        status: "completed",
        kind: "assistant_message",
      },
    ]);
    const snapshot = harness.runtime.getSnapshot();
    assert.deepStrictEqual(
      snapshot.messages.map((message) => message.text),
      ["earlier question", "earlier answer"],
    );
    const clone = harness.runtime.cloneForFork(1);
    assert.deepStrictEqual(
      clone.messages.filter((message) => message.role !== "system").map((m) => m.role),
      ["user", "assistant"],
    );
    await harness.runtime.dispose();
  });

  it("applies the default model sentinel and a named model", async () => {
    const harness = await makeRuntime();
    const defaulted = harness.runtime.applyModelSelection({ instanceId, model: "default" });
    assert.equal(defaulted.modelId, "gpt-5.4");
    const named = harness.runtime.applyModelSelection({ instanceId, model: "gpt-4o" });
    assert.equal(named.modelId, "gpt-4o");
    const restored = harness.runtime.applyModelSelection({ instanceId, model: "default" });
    assert.equal(restored.modelId, "gpt-5.4");
    await harness.runtime.dispose();
  });

  it("runs a turn when the T3 MCP server is unreachable", async () => {
    const harness = await makeRuntime({
      mcpSession: { endpoint: "http://127.0.0.1:1/mcp", authorizationHeader: "Bearer x" },
      fetch: async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:1");
      },
      steps: [scriptedTextResponse("still works")],
    });
    assert.isFalse(harness.runtime.mcpAvailable);
    const outcome = await harness.runtime.runTurn({ text: "hi" });
    assert.equal(outcome.status, "completed");
    assert.deepStrictEqual(streamTexts(harness.events), ["still works"]);
    await harness.runtime.dispose();
  });

  it("delegates to a subagent and stops it on demand", async () => {
    const harness = await makeRuntime({
      settings: settings({ enableSubagents: true }),
      steps: [
        scriptedToolCallResponse([
          { name: "Task", arguments: { prompt: "child work", title: "Child" } },
        ]),
        scriptedTextResponse("child report"),
        scriptedTextResponse("parent done"),
      ],
    });
    const outcome = await harness.runtime.runTurn({ text: "delegate" });
    assert.equal(outcome.status, "completed");
    const records = harness.events.flatMap((event) =>
      event.type === "subagent" ? [event.record] : [],
    );
    assert.isTrue(records.some((record) => record.status === "completed"));
    assert.deepStrictEqual(streamTexts(harness.events), ["parent done"]);
    assert.isNotNull(harness.runtime.subagents);
    await harness.runtime.dispose();
  });

  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "keeps a background Bash job alive past the turn and cleans up on dispose",
    async () => {
      const threadId = "pi-native-jobs-thread";
      const scratchPath = NodePath.join(NodeOS.tmpdir(), "pi-native-scratch", threadId);
      const harness = await makeRuntime({
        threadId,
        shell: { command: "/bin/sh", args: ["-c"] },
        steps: [
          scriptedToolCallResponse([
            { name: "Bash", arguments: { command: "sleep 30", runInBackground: true } },
          ]),
          scriptedToolCallResponse([{ name: "TaskList", arguments: {} }]),
          scriptedTextResponse("job is running"),
        ],
      });
      const outcome = await harness.runtime.runTurn({ text: "start a job" });
      assert.equal(outcome.status, "completed");
      assert.isTrue(harness.runtime.hasRunningBackgroundJobs);
      assert.isTrue((await NodeFSP.stat(scratchPath)).isDirectory());

      // The job tools stay available with subagents disabled and list the Bash job.
      const listEnd = harness.events.find(
        (event) => event.type === "tool" && event.phase === "end" && event.toolName === "TaskList",
      );
      assert.isDefined(listEnd);
      const listResult = listEnd as {
        readonly isError?: boolean;
        readonly result?: { readonly details?: unknown };
      };
      assert.notEqual(listResult.isError, true);
      const details = listResult.result?.details as {
        readonly backgroundJobs?: {
          readonly tasks?: ReadonlyArray<{ readonly job: { readonly id: string } }>;
        };
      };
      assert.equal(details.backgroundJobs?.tasks?.[0]?.job.id, "bash-1");

      assert.isFalse(await harness.runtime.stopBackgroundJob("bash-404"));
      await harness.runtime.dispose();
      assert.isFalse(harness.runtime.hasRunningBackgroundJobs);
      let removed = false;
      try {
        await NodeFSP.stat(scratchPath);
      } catch {
        removed = true;
      }
      assert.isTrue(removed, "dispose removes the session scratch directory");
    },
  );

  it("continues an active goal autonomously until UpdateGoalStatus completes it", async () => {
    const harness = await makeRuntime({
      initialGoal: {
        objective: "Ship the fix",
        status: "active",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        checks: 0,
      },
      maxGoalChecks: 3,
      steps: [
        scriptedTextResponse("still working"),
        scriptedToolCallResponse([
          { name: "UpdateGoalStatus", arguments: { status: "complete", summary: "tests pass" } },
        ]),
        scriptedTextResponse("verified complete"),
      ],
    });
    const outcome = await harness.runtime.runTurn({ text: "start the goal" });
    assert.equal(outcome.status, "completed");
    assert.deepStrictEqual(streamTexts(harness.events), ["still working", "verified complete"]);
    const goal = harness.runtime.goal;
    assert.equal(goal?.status, "complete");
    // The continuation check plus the UpdateGoalStatus call both count.
    assert.equal(goal?.checks, 2);
    assert.equal(goal?.lastCheck, "tests pass");
    assert.isTrue((goal?.tokensUsed ?? 0) > 0);
    assert.isTrue(
      harness.runtime
        .getSnapshot()
        .messages.some(
          (message) =>
            message.role === "user" &&
            message.text.includes("Autonomous goal check 1/3 for objective: Ship the fix"),
        ),
      "the continuation prompt names the check budget and objective",
    );
    await harness.runtime.dispose();
  });

  it("stops the goal loop when UpdateGoalStatus reports it blocked", async () => {
    const harness = await makeRuntime({
      initialGoal: { objective: "Needs a credential", status: "active", checks: 0 },
      steps: [
        scriptedToolCallResponse([
          { name: "UpdateGoalStatus", arguments: { status: "blocked", summary: "missing token" } },
        ]),
        scriptedTextResponse("I am blocked"),
        scriptedTextResponse("this must not run"),
      ],
    });
    const outcome = await harness.runtime.runTurn({ text: "start" });
    assert.equal(outcome.status, "completed");
    assert.equal(harness.runtime.goal?.status, "blocked");
    assert.deepStrictEqual(streamTexts(harness.events), ["I am blocked"]);
    assert.equal(harness.streamFn.calls.length, 2);
    await harness.runtime.dispose();
  });

  it("pauses an active goal as budget_limited once the check budget runs out", async () => {
    const harness = await makeRuntime({
      initialGoal: { objective: "Endless refactor", status: "active", checks: 0 },
      maxGoalChecks: 2,
      steps: [
        scriptedTextResponse("one"),
        scriptedTextResponse("two"),
        scriptedTextResponse("three"),
        scriptedTextResponse("must not run"),
      ],
    });
    const outcome = await harness.runtime.runTurn({ text: "start" });
    assert.equal(outcome.status, "completed");
    assert.deepStrictEqual(streamTexts(harness.events), ["one", "two", "three"]);
    const goal = harness.runtime.goal;
    assert.equal(goal?.status, "budget_limited");
    assert.equal(goal?.checks, 2);
    assert.match(goal?.lastCheck ?? "", /check limit \(2\)/u);
    const updates = harness.events.flatMap((event) =>
      event.type === "goal_updated" ? [event.goal?.status] : [],
    );
    assert.include(updates, "budget_limited");
    await harness.runtime.dispose();
  });

  it("pauses an active goal when the user interrupts the turn", async () => {
    const harness = await makeRuntime({
      initialGoal: { objective: "Long job", status: "active", checks: 0 },
      steps: [
        async () => {
          await harness.runtime.abort();
          return scriptedErrorResponse("aborted by the user", { stopReason: "aborted" });
        },
      ],
    });
    const outcome = await harness.runtime.runTurn({ text: "start" });
    assert.equal(outcome.status, "interrupted");
    assert.equal(harness.runtime.goal?.status, "paused");
    await harness.runtime.dispose();
  });

  it("does not continue a goal after SubmitPlan or in plan mode", async () => {
    const planned = await makeRuntime({
      initialGoal: { objective: "Plan first", status: "active", checks: 0 },
      steps: [
        scriptedToolCallResponse([
          { name: "SubmitPlan", arguments: { markdown: "# Plan", summary: "Do it" } },
        ]),
        scriptedTextResponse("plan ready"),
        scriptedTextResponse("must not run"),
      ],
    });
    const plannedOutcome = await planned.runtime.runTurn({ text: "plan it" });
    assert.equal(plannedOutcome.status, "completed");
    assert.deepStrictEqual(streamTexts(planned.events), ["plan ready"]);
    assert.equal(planned.runtime.goal?.checks, 0);
    assert.isFalse(
      planned.runtime
        .getSnapshot()
        .messages.some(
          (message) => message.role === "user" && message.text.includes("Autonomous goal check"),
        ),
    );
    await planned.runtime.dispose();

    const planMode = await makeRuntime({
      interactionMode: "plan",
      initialGoal: { objective: "Plan first", status: "active", checks: 0 },
      steps: [scriptedTextResponse("draft plan"), scriptedTextResponse("must not run")],
    });
    const planOutcome = await planMode.runtime.runTurn({ text: "plan it" });
    assert.equal(planOutcome.status, "completed");
    assert.deepStrictEqual(streamTexts(planMode.events), ["draft plan"]);
    assert.equal(planMode.runtime.goal?.checks, 0);
    await planMode.runtime.dispose();
  });

  it("allows UpdateGoalStatus in plan mode and in read-only runtime modes", async () => {
    const harness = await makeRuntime({
      interactionMode: "plan",
      runtimeMode: "approval-required",
      initialGoal: { objective: "Track progress", status: "active", checks: 0 },
      steps: [
        scriptedToolCallResponse([
          { name: "UpdateGoalStatus", arguments: { status: "active", summary: "looked around" } },
        ]),
        scriptedTextResponse("plan draft"),
      ],
    });
    await harness.runtime.runTurn({ text: "plan it" });
    assert.deepStrictEqual(toolNames(harness.events), ["UpdateGoalStatus"]);
    const result = harness.events.find((event) => event.type === "tool" && event.phase === "end");
    assert.equal(result?.type === "tool" ? result.isError === true : true, false);
    assert.deepStrictEqual(harness.approvals, []);
    assert.equal(harness.runtime.goal?.checks, 1);
    await harness.runtime.dispose();
  });

  it("keeps UpdateGoalStatus out of child subagent tools", async () => {
    const declaredTools = (call: {
      readonly context: { readonly messages: ReadonlyArray<unknown> };
    }) =>
      call.context.messages.flatMap((message) => {
        const added = (
          message as { readonly toolsAdded?: ReadonlyArray<{ readonly name: string }> }
        ).toolsAdded;
        return (added ?? []).map((tool) => tool.name);
      });
    const calls: string[][] = [];
    const harness = await makeRuntime({
      settings: settings({ enableSubagents: true }),
      steps: [
        (call) => {
          calls.push(declaredTools(call));
          return scriptedToolCallResponse([
            { name: "Task", arguments: { prompt: "child work", title: "Child" } },
          ]);
        },
        (call) => {
          calls.push(declaredTools(call));
          return scriptedTextResponse("child report");
        },
        (call) => {
          calls.push(declaredTools(call));
          return scriptedTextResponse("parent done");
        },
      ],
    });
    await harness.runtime.runTurn({ text: "delegate" });
    assert.include(calls[0] ?? [], "UpdateGoalStatus");
    assert.notInclude(calls[1] ?? [], "UpdateGoalStatus");
    assert.include(calls[2] ?? [], "UpdateGoalStatus");
    await harness.runtime.dispose();
  });

  it("prompts with one system section per discovered skill", async () => {
    const skills: ReadonlyArray<PiNativeSkillDef> = [
      {
        id: "review",
        name: "Review",
        description: "Reviews changes",
        path: "/workspace/.agents/skills/review/SKILL.md",
        rootDir: "/workspace/.agents/skills/review",
        scope: "project",
        enabled: true,
        disableModelInvocation: false,
      },
      {
        id: "manual",
        name: "Manual",
        path: "/workspace/.agents/skills/manual/SKILL.md",
        rootDir: "/workspace/.agents/skills/manual",
        scope: "project",
        enabled: true,
        disableModelInvocation: true,
      },
    ];
    const harness = await makeRuntime({ steps: [scriptedTextResponse("ok")], skills });
    await harness.runtime.runTurn({ text: "hi" });
    const system = harness.runtime.messages.find((message) => message.role === "system");
    const sections =
      system !== undefined && "sections" in system
        ? ((system as { readonly sections?: Record<string, string | null> }).sections ?? {})
        : {};
    assert.deepInclude(sections, {
      "skill:review": "- `review`: Review (Reviews changes)",
    });
    assert.notProperty(sections, "skill:manual");
    assert.include(
      harness.runtime.skills.map((skill) => skill.id),
      "manual",
    );
    await harness.runtime.dispose();
  });

  it("loads a /skill:<id> invocation for one turn and clears it afterwards", async () => {
    const skills: ReadonlyArray<PiNativeSkillDef> = [
      {
        id: "review",
        name: "Review",
        path: "/workspace/.agents/skills/review/SKILL.md",
        rootDir: "/workspace/.agents/skills/review",
        scope: "project",
        enabled: true,
        disableModelInvocation: false,
      },
    ];
    const root = await workspace({
      "SKILL.md": "---\nname: Review\n---\n\nRead the diff first.\n",
    });
    const skill = {
      ...(skills[0] as PiNativeSkillDef),
      path: NodePath.join(root, "SKILL.md"),
      rootDir: root,
    };
    const activations: Array<string | null> = [];
    const streamFn: StreamFn = async (model, context) => {
      const systems = context.messages.filter((message) => message.role === "system");
      const last = systems.at(-1);
      const sections =
        last !== undefined && typeof last === "object" && "sections" in last
          ? ((last as { readonly sections?: Record<string, string | null> }).sections ?? {})
          : {};
      activations.push(sections["tool_activation"] ?? null);
      return renderScriptedTurn(model, scriptedTextResponse("ok"), 0);
    };
    const harness = await makeRuntime({ streamFn, skills: [skill] });

    await harness.runtime.runTurn({ text: "review this", skillIds: ["review"] });
    await harness.runtime.runTurn({ text: "plain turn" });

    assert.match(activations[0] ?? "", /<skill_content id="review"/u);
    assert.match(activations[0] ?? "", /Read the diff first\./u);
    assert.isNull(activations[1] ?? null);
    await harness.runtime.dispose();
  });

  it("activates the skill behind a $<id> mention the composer inserted", async () => {
    const root = await workspace({
      "SKILL.md": "---\nname: Review\n---\n\nRead the diff first.\n",
    });
    const skills: ReadonlyArray<PiNativeSkillDef> = [
      {
        id: "review",
        name: "Review",
        path: NodePath.join(root, "SKILL.md"),
        rootDir: root,
        scope: "project",
        enabled: true,
        disableModelInvocation: false,
      },
    ];
    const activations: Array<string | null> = [];
    const streamFn: StreamFn = async (model, context) => {
      const systems = context.messages.filter((message) => message.role === "system");
      const last = systems.at(-1);
      const sections =
        last !== undefined && typeof last === "object" && "sections" in last
          ? ((last as { readonly sections?: Record<string, string | null> }).sections ?? {})
          : {};
      activations.push(sections["tool_activation"] ?? null);
      return renderScriptedTurn(model, scriptedTextResponse("ok"), 0);
    };
    const harness = await makeRuntime({ streamFn, skills });

    await harness.runtime.runTurn({ text: "use $review on this branch" });
    await harness.runtime.runTurn({ text: "budget is $5" });

    assert.match(activations[0] ?? "", /<skill_content id="review"/u);
    assert.isNull(activations[1] ?? null);
    await harness.runtime.dispose();
  });

  it("declares the Skill tool and loads a skill through it", async () => {
    const root = await workspace({
      "SKILL.md": "---\nname: Review\n---\n\nRead the diff first.\n",
    });
    const skills: ReadonlyArray<PiNativeSkillDef> = [
      {
        id: "review",
        name: "Review",
        path: NodePath.join(root, "SKILL.md"),
        rootDir: root,
        scope: "project",
        enabled: true,
        disableModelInvocation: false,
      },
    ];
    const harness = await makeRuntime({
      skills,
      steps: [
        scriptedToolCallResponse([{ name: "Skill", arguments: { id: "review" } }]),
        scriptedTextResponse("done"),
      ],
    });

    await harness.runtime.runTurn({ text: "review" });

    assert.deepEqual(toolNames(harness.events), ["Skill"]);
    const loaded = harness.events.find((event) => event.type === "tool" && event.phase === "end");
    assert.match(
      loaded?.type === "tool" ? (loaded.output ?? "") : "",
      /<skill_content id="review"[^>]*>\nRead the diff first\./u,
    );
    await harness.runtime.dispose();
  });

  it("clears the skills header when the last skill is revoked and loads user-only skills on $id", async () => {
    const root = await workspace({
      "SKILL.md":
        "---\nname: Manual\ndisable-model-invocation: true\n---\n\nManual instructions.\n",
    });
    let current: ReadonlyArray<PiNativeSkillDef> = [
      {
        id: "review",
        name: "Review",
        path: "/workspace/.agents/skills/review/SKILL.md",
        rootDir: "/workspace/.agents/skills/review",
        scope: "project",
        enabled: true,
        disableModelInvocation: false,
      },
      {
        id: "manual",
        name: "Manual",
        path: NodePath.join(root, "SKILL.md"),
        rootDir: root,
        scope: "project",
        enabled: true,
        disableModelInvocation: true,
      },
    ];
    const deltas: Array<Record<string, string | null>> = [];
    const streamFn: StreamFn = async (model, context) => {
      const last = context.messages.filter((message) => message.role === "system").at(-1);
      const sections =
        last !== undefined && typeof last === "object" && "sections" in last
          ? ((last as { readonly sections?: Record<string, string | null> }).sections ?? {})
          : {};
      deltas.push(sections);
      return renderScriptedTurn(model, scriptedTextResponse("ok"), 0);
    };
    const harness = await makeRuntime({ streamFn, discoverSkills: async () => current });

    await harness.runtime.runTurn({ text: "run $manual" });
    assert.match(deltas[0]?.tool_activation ?? "", /<skill_content id="manual"/u);

    current = [];
    await harness.runtime.runTurn({ text: "after removal" });
    assert.isTrue(Object.hasOwn(deltas[1] ?? {}, "skills"));
    assert.isNull(deltas[1]?.skills);
    assert.isTrue(Object.hasOwn(deltas[1] ?? {}, "skill:review"));
    assert.isNull(deltas[1]?.["skill:review"]);
    await harness.runtime.dispose();
  });

  it("boosts thinking for one workflow turn and restores it afterwards", async () => {
    const requests: Array<{ reasoning: string | undefined; activation: string | null }> = [];
    const streamFn: StreamFn = async (model, context, options) => {
      const sections = systemSections(context.messages.filter(isSystem).at(-1));
      requests.push({
        reasoning: (options as { readonly reasoning?: string } | undefined)?.reasoning,
        activation: sections["tool_activation"] ?? null,
      });
      return renderScriptedTurn(model, scriptedTextResponse("ok"), 0);
    };
    const harness = await makeRuntime({ streamFn });
    await harness.runtime.runTurn({
      text: "review this",
      workflowDirective: '<workflow_command name="review">check it</workflow_command>',
      boostThinking: true,
    });
    await harness.runtime.runTurn({ text: "plain turn" });
    assert.equal(requests[0]?.reasoning, "high");
    assert.match(requests[0]?.activation ?? "", /workflow_command name="review"/u);
    assert.equal(requests[1]?.reasoning, undefined);
    assert.isNull(requests[1]?.activation ?? null);
    await harness.runtime.dispose();
  });

  it("clears tool_activation with null between turns when subagents are disabled so a workflow directive re-arms cleanly", async () => {
    const requests: Array<{
      hasToolActivationKey: boolean;
      toolActivation: string | null | undefined;
    }> = [];
    const streamFn: StreamFn = async (model, context) => {
      const sections = systemSections(context.messages.filter(isSystem).at(-1));
      requests.push({
        hasToolActivationKey: Object.hasOwn(sections, "tool_activation"),
        toolActivation: sections["tool_activation"],
      });
      return renderScriptedTurn(model, scriptedTextResponse("ok"), 0);
    };
    const harness = await makeRuntime({ streamFn });
    await harness.runtime.runTurn({
      text: "first review",
      workflowDirective: '<workflow_command name="review">check it</workflow_command>',
    });
    await harness.runtime.runTurn({ text: "plain turn" });
    await harness.runtime.runTurn({
      text: "second review",
      workflowDirective: '<workflow_command name="review">check it</workflow_command>',
    });
    assert.match(requests[0]?.toolActivation ?? "", /workflow_command name="review"/u);
    assert.isTrue(requests[1]?.hasToolActivationKey);
    assert.isNull(requests[1]?.toolActivation);
    assert.match(requests[2]?.toolActivation ?? "", /workflow_command name="review"/u);
    await harness.runtime.dispose();
  });

  it("leads with the custom system prompt and places the append and project rules after runtime", async () => {
    const cwd = await workspace();
    await writeFiles(cwd, { ".pi/SYSTEM.md": "Custom persona.", "AGENTS.md": "Repo rules." });
    const piAgentDir = await workspace({
      "SYSTEM.md": "Global persona.",
      "APPEND_SYSTEM.md": "Global append.",
      "AGENTS.md": "Global rules.",
    });
    const requests: Array<{
      content: string | null;
      sections: Record<string, string | null>;
    }> = [];
    const streamFn: StreamFn = async (model, context) => {
      const leading = context.messages[0];
      requests.push({
        content: typeof leading?.content === "string" ? leading.content : null,
        sections: systemSections(leading),
      });
      return renderScriptedTurn(model, scriptedTextResponse("ok"), 0);
    };

    const harness = await makeRuntime({ cwd, piAgentDir, streamFn });
    await harness.runtime.runTurn({ text: "hi" });

    assert.equal(requests[0]?.content, "Custom persona.");
    assert.deepStrictEqual(Object.keys(requests[0]?.sections ?? {}), [
      "runtime",
      "custom_append",
      "project_instructions",
    ]);
    assert.equal(requests[0]?.sections["custom_append"], "Global append.");
    assert.include(requests[0]?.sections["project_instructions"] ?? "", "Global rules.");
    assert.include(requests[0]?.sections["project_instructions"] ?? "", "Repo rules.");
    await harness.runtime.dispose();
  });

  it("adds a nested AGENTS.md once a tool reaches its directory, and only when the chain changes", async () => {
    const cwd = await workspace();
    await writeFiles(cwd, {
      "AGENTS.md": "root rules",
      "pkg/AGENTS.md": "package rules",
      "pkg/note.txt": "hello\n",
      "pkg/other.txt": "again\n",
    });
    const scripted = createScriptedStreamFn(
      [
        scriptedToolCallResponse([
          { name: "Read", arguments: { path: "pkg/note.txt" } },
          { name: "Read", arguments: { path: "pkg/other.txt" } },
        ]),
        scriptedTextResponse("done"),
        scriptedTextResponse("again"),
      ],
      { now: () => 0 },
    );
    const deltas: Array<Record<string, string | null>> = [];
    const streamFn: StreamFn = async (model, context, options) => {
      deltas.push(...requestDeltas(context.messages));
      return scripted(model, context, options);
    };

    const harness = await makeRuntime({ cwd, streamFn });
    await harness.runtime.runTurn({ text: "look at pkg" });
    await harness.runtime.runTurn({ text: "keep going" });

    const instructionDeltas = deltas.filter(
      (sections) => sections["project_instructions"] !== undefined,
    );
    assert.lengthOf(instructionDeltas, 1);
    assert.deepStrictEqual(Object.keys(instructionDeltas[0] ?? {}), ["project_instructions"]);
    assert.include(instructionDeltas[0]?.["project_instructions"] ?? "", "root rules");
    assert.include(instructionDeltas[0]?.["project_instructions"] ?? "", "package rules");
    await harness.runtime.dispose();
  });
});

/** Request-only reminders never reach the transcript, so they are counted in the request. */
const reminderMessages = (messages: ReadonlyArray<{ readonly content?: unknown }>): number =>
  messages.filter((message) => {
    const content = message.content;
    return typeof content === "string"
      ? content.includes("<context_budget>")
      : JSON.stringify(content ?? "").includes("<context_budget>");
  }).length;

describe("NativePiSessionRuntime context budget", () => {
  it("reminds the model once per checkpoint window and not again on the next turn", async () => {
    const harness = await makeRuntime({
      settings: settings({
        modelBindings: [
          {
            id: "default",
            contextWindow: 20_000,
            maxTokens: 2_000,
            thinkingLevels: [],
            defaultThinkingLevel: null,
          },
        ],
      }),
      steps: [scriptedTextResponse("one"), scriptedTextResponse("two")],
    });

    await harness.runtime.runTurn({ text: "a".repeat(4 * 4_000) });
    const first = harness.streamFn.calls[0]?.context.messages ?? [];
    assert.equal(reminderMessages(first), 1);

    await harness.runtime.runTurn({ text: "again" });
    const second = harness.streamFn.calls[1]?.context.messages ?? [];
    assert.equal(reminderMessages(second), 0);
    await harness.runtime.dispose();
  });

  it("reports why a compaction summary was abandoned", async () => {
    const harness = await makeRuntime({
      settings: settings({ autoCompact: true }),
      steps: [
        scriptedErrorResponse("prompt is too long: 250000 tokens > 200000 maximum"),
        scriptedTextResponse("I could not summarize this conversation."),
        scriptedTextResponse("recovered answer"),
      ],
    });

    const outcome = await harness.runtime.runTurn({ text: "start" });
    assert.equal(outcome.status, "completed");
    assert.deepStrictEqual(streamTexts(harness.events), ["recovered answer"]);

    const completed = harness.events.filter(
      (event) => event.type === "compaction" && event.status === "completed",
    );
    assert.isAbove(completed.length, 0);
    const reason = completed.at(-1);
    assert.include(
      reason?.type === "compaction" ? (reason.failureReason ?? "") : "",
      "no recognizable sections",
    );
    await harness.runtime.dispose();
  });
});

describe("parseCompactionSummary", () => {
  it("reads the five sections of a summary block", () => {
    const parsed = parseCompactionSummary(
      "intro\n<compaction_summary>\n## Goals\nA\n## Progress\nB\n## Files\nC\n## Decisions\nD\n## Next Steps\nE\n</compaction_summary>",
    );
    assert.deepStrictEqual(parsed, {
      goals: "A",
      progress: "B",
      files: "C",
      decisions: "D",
      nextSteps: "E",
    });
  });

  it("rejects text without a summary", () => {
    assert.throws(() => parseCompactionSummary("no summary here"));
  });
});

void policy;
void settings;
