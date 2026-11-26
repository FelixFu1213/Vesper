import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  PiNativeSessionStore,
  type PersistedThreadSnapshot,
} from "@t3tools/provider-pi-native/server";
import { it as effectIt } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import * as ProjectMemoryService from "../project/ProjectMemoryService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import {
  ThreadContextBreakdownService,
  allocateProportionally,
  analyzeOrchestrationItems,
  classifySystemSection,
  draftContextItem,
  finalizeContextBreakdown,
  layer as breakdownLayer,
  parseMcpToolName,
  parsePiCliSessionJsonl,
  type ContextDraftItem,
} from "./ThreadContextBreakdownService.ts";

const usage = () => ({
  inputTokens: null,
  cachedInputTokens: null,
  cacheHitRate: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  toolUses: 0,
  turnCount: 1,
  compactionCount: 0,
  cost: null,
});

const item = (
  id: string,
  category: ContextDraftItem["category"],
  tokens: number,
): ContextDraftItem =>
  draftContextItem({
    id,
    category,
    kind:
      category === "system"
        ? "system_section"
        : category === "user"
          ? "user_message"
          : "tool_result",
    label: id,
    text: "x".repeat(tokens * 4),
    orderIndex: Number(id.replace(/\D/gu, "")) || 0,
  });

const finalize = (overrides: Partial<Parameters<typeof finalizeContextBreakdown>[0]> = {}) =>
  finalizeContextBreakdown({
    threadId: "thread-1" as never,
    providerInstanceId: null,
    driver: "claudeAgent",
    model: "claude-sonnet",
    fidelity: "estimated",
    items: [item("1", "system", 100), item("2", "user", 300)],
    turns: [],
    compactions: [],
    actualUsedTokens: null,
    maxTokens: 1_000,
    autoCompactThreshold: 800,
    reserveTokens: 100,
    usage: usage(),
    deferred: {},
    computedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

describe("allocateProportionally", () => {
  it("sums to the total with largest-remainder rounding", () => {
    const allocated = allocateProportionally([1, 1, 1], 10);
    expect(allocated.reduce((sum, value) => sum + value, 0)).toBe(10);
    expect(allocated).toEqual([4, 3, 3]);
  });

  it("gives every part one token when the weights are all zero", () => {
    expect(allocateProportionally([0, 0], 3)).toEqual([2, 1]);
  });

  it("returns nothing for no weights", () => {
    expect(allocateProportionally([], 5)).toEqual([]);
  });
});

describe("finalizeContextBreakdown", () => {
  it("keeps the raw estimate and window totals in agreement without reported usage", () => {
    const breakdown = finalize();
    expect(breakdown.window.usedTokens).toBe(400);
    expect(breakdown.window.estimatedTotalTokens).toBe(400);
    expect(breakdown.categories.reduce((sum, category) => sum + category.calibratedTokens, 0)).toBe(
      400,
    );
  });

  it("anchors an exact breakdown to the reported usage", () => {
    const breakdown = finalize({ fidelity: "exact", actualUsedTokens: 1_000 });
    expect(breakdown.window.usedTokens).toBe(1_000);
    expect(breakdown.categories.reduce((sum, category) => sum + category.calibratedTokens, 0)).toBe(
      1_000,
    );
    expect(breakdown.items[0]?.calibratedTokens).toBe(250);
    expect(breakdown.items[1]?.calibratedTokens).toBe(750);
  });

  it("charges an estimated provider's unexplained prompt as provider overhead", () => {
    const breakdown = finalize({ actualUsedTokens: 900 });
    const overhead = breakdown.categories.find(
      (category) => category.category === "provider_overhead",
    );
    expect(overhead?.calibratedTokens).toBe(500);
    expect(breakdown.items.some((entry) => entry.kind === "provider_overhead")).toBe(true);
    expect(breakdown.categories.reduce((sum, category) => sum + category.calibratedTokens, 0)).toBe(
      900,
    );
  });

  it("scales an estimate down when the provider reports less usage", () => {
    const breakdown = finalize({ actualUsedTokens: 200 });
    expect(breakdown.window.usedTokens).toBe(200);
    expect(breakdown.items[0]?.calibratedTokens).toBe(50);
    expect(breakdown.items[1]?.calibratedTokens).toBe(150);
  });

  it("caps items but keeps category totals whole", () => {
    const many = Array.from({ length: 520 }, (_unused, index) => item(`${index + 1}`, "user", 1));
    const breakdown = finalize({ items: many, actualUsedTokens: null });
    expect(breakdown.items.length).toBeLessThanOrEqual(500);
    expect(breakdown.categories.reduce((sum, category) => sum + category.calibratedTokens, 0)).toBe(
      breakdown.window.usedTokens,
    );
  });

  it("carries deferred tool counts into the category summary", () => {
    const breakdown = finalize({
      deferred: { mcp: { count: 30, tokens: 12_000 } },
    });
    const mcp = breakdown.categories.find((category) => category.category === "mcp");
    expect(mcp?.deferredCount).toBe(30);
    expect(mcp?.deferredTokens).toBe(12_000);
  });
});

describe("classifySystemSection", () => {
  it("routes skill and on-demand tool sections to their own categories", () => {
    expect(classifySystemSection("skills")).toMatchObject({
      category: "skills",
      kind: "skill_catalog",
    });
    expect(classifySystemSection("skill:review")).toMatchObject({
      category: "skills",
      kind: "skill_catalog",
      label: "Skill: review",
    });
    expect(classifySystemSection("on_demand_tools")).toMatchObject({
      category: "tools",
      kind: "tool_catalog",
    });
    expect(classifySystemSection("project_instructions")).toMatchObject({
      category: "system",
      kind: "system_section",
      label: "Project instructions (AGENTS.md)",
    });
  });
});

describe("parseMcpToolName", () => {
  it("splits a bridged MCP tool name", () => {
    expect(parseMcpToolName("mcp__t3-code__t3_thread_list")).toEqual({
      server: "t3-code",
      tool: "t3_thread_list",
    });
  });

  it("ignores a built-in tool or a malformed name", () => {
    expect(parseMcpToolName("Read")).toBeUndefined();
    expect(parseMcpToolName("mcp__t3-code")).toBeUndefined();
  });
});

const turnItem = (
  overrides: Partial<OrchestrationV2TurnItem> & Pick<OrchestrationV2TurnItem, "type">,
) =>
  ({
    id: `item-${overrides.type}`,
    threadId: "thread-1",
    runId: "run-1",
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(0),
    ...overrides,
  }) as OrchestrationV2TurnItem;

const projection = (turnItems: ReadonlyArray<OrchestrationV2TurnItem>) =>
  ({
    thread: { projectId: "project-1" },
    runs: [
      {
        id: "run-1",
        ordinal: 1,
        startedAt: DateTime.makeUnsafe(0),
        requestedAt: DateTime.makeUnsafe(0),
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [{ id: "message-1", text: "hello from the message" }],
    plans: [],
    turnItems,
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: DateTime.makeUnsafe(0),
  }) as unknown as OrchestrationV2ThreadProjection;

describe("analyzeOrchestrationItems", () => {
  it("classifies conversation, commands, and MCP tool results", () => {
    const items = [
      turnItem({
        type: "user_message",
        messageId: MessageId.make("message-1"),
        text: "",
        attachments: [],
      }),
      turnItem({
        type: "assistant_message",
        messageId: MessageId.make("answer-message"),
        text: "answer",
        streaming: false,
      }),
      turnItem({
        type: "command_execution",
        input: "ls",
        output: "file.ts",
        exitCode: 0,
      }),
      turnItem({
        type: "dynamic_tool",
        toolName: "mcp__t3-code__t3_thread_list",
        input: {},
        output: "threads",
      }),
    ] as unknown as ReadonlyArray<OrchestrationV2TurnItem>;
    const analysis = analyzeOrchestrationItems({
      projection: projection(items),
      turnItems: items,
      model: "claude-sonnet",
    });
    expect(analysis.items.map((entry) => entry.category)).toEqual([
      "user",
      "assistant",
      "tool_results",
      "mcp",
    ]);
    expect(analysis.items[0]?.preview).toBe("hello from the message");
    expect(analysis.items[2]?.status).toBe("ok");
    expect(analysis.items[3]?.meta?.mcpServer).toBe("t3-code");
    expect(analysis.turns).toHaveLength(1);
    expect(analysis.turns[0]?.runId).toBe("run-1");
  });

  it("drops conversation the latest compaction summarized", () => {
    const items = [
      turnItem({
        type: "user_message",
        messageId: MessageId.make("message-1"),
        text: "old",
        attachments: [],
      }),
      turnItem({
        type: "compaction",
        driver: null,
        summary: "summary",
        beforeTokenCount: 1_000,
        afterTokenCount: 200,
        ordinal: 1,
      }),
      turnItem({
        type: "user_message",
        messageId: MessageId.make("new-message"),
        text: "new",
        attachments: [],
        ordinal: 2,
      }),
    ] as unknown as ReadonlyArray<OrchestrationV2TurnItem>;
    const analysis = analyzeOrchestrationItems({
      projection: projection(items),
      turnItems: items,
      model: null,
    });
    const previews = analysis.items.map((entry) => entry.preview);
    expect(previews).not.toContain("old");
    expect(previews).toContain("new");
    expect(previews).toContain("summary");
    expect(analysis.compactions[0]?.savedTokens).toBe(800);
  });

  it("charges an image attachment its fixed token budget", () => {
    const items = [
      turnItem({
        type: "user_message",
        messageId: MessageId.make("image-message"),
        text: "",
        attachments: [
          { type: "image", id: "image-1", name: "a.png", mimeType: "image/png", sizeBytes: 10 },
        ],
      }),
    ] as unknown as ReadonlyArray<OrchestrationV2TurnItem>;
    const analysis = analyzeOrchestrationItems({
      projection: projection(items),
      turnItems: items,
      model: null,
    });
    expect(analysis.items[0]?.estimatedTokens).toBe(1_600);
    expect(analysis.items[0]?.meta?.imageCount).toBe(1);
  });
});

describe("parsePiCliSessionJsonl", () => {
  it("follows the active parentId branch, trims at compaction, and classifies items", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "pruned old question" }] },
      }),
      JSON.stringify({
        type: "compaction",
        id: "cmp-1",
        parentId: "m1",
        timestamp: "2026-01-01T00:00:02.000Z",
        summary: "Earlier work compacted.",
        tokensBefore: 4_000,
        tokensAfter: 800,
      }),
      JSON.stringify({
        type: "message",
        id: "m2-abandoned",
        parentId: "cmp-1",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "user", content: [{ type: "text", text: "abandoned branch message" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m2",
        parentId: "cmp-1",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: { role: "user", content: [{ type: "text", text: "active prompt" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m3",
        parentId: "m2",
        timestamp: "2026-01-01T00:00:05.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "pondering" },
            { type: "toolCall", name: "mcp__t3-code__t3_thread_list", arguments: {} },
            { type: "text", text: "done" },
          ],
          usage: { input: 200, cacheRead: 800, cacheWrite: 0, output: 50, totalTokens: 1_050 },
        },
      }),
      JSON.stringify({
        type: "message",
        id: "m4",
        parentId: "m3",
        timestamp: "2026-01-01T00:00:06.000Z",
        message: {
          role: "toolResult",
          toolName: "mcp__t3-code__t3_thread_list",
          content: [{ type: "text", text: "[]" }],
          isError: false,
        },
      }),
      JSON.stringify({
        type: "message",
        id: "m5",
        parentId: "m4",
        timestamp: "2026-01-01T00:00:07.000Z",
        message: {
          role: "toolResult",
          toolName: "Skill",
          content: [{ type: "text", text: "skill instructions" }],
          isError: false,
        },
      }),
    ].join("\n");

    const parsed = parsePiCliSessionJsonl(jsonl);
    const previews = parsed.items.map((entry) => entry.preview);
    expect(previews).not.toContain("pruned old question");
    expect(previews).not.toContain("abandoned branch message");
    expect(previews).toContain("active prompt");
    expect(previews).toContain("Earlier work compacted.");
    expect(parsed.compactions).toHaveLength(1);
    expect(parsed.compactions[0]?.savedTokens).toBe(3_200);
    expect(parsed.turns[0]?.usedTokens).toBe(1_050);
    expect(
      parsed.items.some((entry) => entry.category === "mcp" && entry.kind === "mcp_result"),
    ).toBe(true);
    expect(
      parsed.items.some((entry) => entry.category === "skills" && entry.kind === "skill_loaded"),
    ).toBe(true);
  });
});

function makeServiceLayer(options: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly snapshot?: PersistedThreadSnapshot | null;
  readonly settings?: ServerSettings;
}) {
  const layers = [
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadProjection: () => Effect.succeed(options.projection),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeedSome({
          projectId: ProjectId.make("project-1"),
          title: "Project",
          workspaceRoot: "",
        } as never),
    }),
    Layer.mock(ProjectMemoryService.ProjectMemoryService)({
      get: () => Effect.succeed({ content: "Remember this rule.", entries: [] } as never),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(options.providers ?? []),
    }),
    ...(options.snapshot === undefined
      ? []
      : [
          Layer.mock(PiNativeSessionStore)({
            durable: true,
            loadThread: () => Effect.succeed(options.snapshot!),
          }),
        ]),
    ...(options.settings === undefined
      ? []
      : [
          Layer.mock(ServerSettingsService)({
            getSettings: Effect.succeed(options.settings),
          }),
        ]),
  ] as const;

  return breakdownLayer.pipe(Layer.provide(Layer.mergeAll(...layers)));
}

describe("ThreadContextBreakdownService", () => {
  effectIt.effect(
    "analyzes a non-empty Pi Native thread with ToolSearch, cache normalization, and ordered bands",
    () => {
      const threadId = ThreadId.make("thread-pi-native");
      const piProjection = {
        thread: {
          id: threadId,
          projectId: ProjectId.make("project-1"),
          worktreePath: null,
          modelSelection: { instanceId: ProviderInstanceId.make("piNative"), model: "gpt-5" },
        },
        runs: [
          {
            id: "run-1",
            ordinal: 1,
            startedAt: DateTime.makeUnsafe(1_000),
            requestedAt: DateTime.makeUnsafe(1_000),
          },
          {
            id: "run-2",
            ordinal: 2,
            startedAt: DateTime.makeUnsafe(2_000),
            requestedAt: DateTime.makeUnsafe(2_000),
          },
        ],
        attempts: [
          { id: "att-1", runId: "run-1" },
          { id: "att-2", runId: "run-2" },
        ],
        providerThreads: [
          {
            id: "pt-1",
            providerInstanceId: ProviderInstanceId.make("piNative"),
            driver: "piNative",
            lastRunOrdinal: 2,
            updatedAt: DateTime.makeUnsafe(3_000),
            contextUsage: {
              usedTokens: 1_000,
              maxTokens: 128_000,
              inputTokens: 100,
              cachedInputTokens: 900,
              outputTokens: 50,
            },
          },
        ],
        providerTurns: [
          {
            id: "turn-1",
            providerThreadId: "pt-1",
            runAttemptId: "att-1",
            ordinal: 1,
            model: "gpt-5",
            startedAt: DateTime.makeUnsafe(1_000),
            completedAt: DateTime.makeUnsafe(1_500),
            tokenUsage: {
              usedTokens: 400,
              maxTokens: 128_000,
              inputTokens: 400,
              cachedInputTokens: 0,
              outputTokens: 20,
              updatedAt: "2026-01-01T00:00:01.000Z",
            },
          },
          {
            id: "turn-2",
            providerThreadId: "pt-1",
            runAttemptId: "att-2",
            ordinal: 2,
            model: "gpt-5",
            startedAt: DateTime.makeUnsafe(2_000),
            completedAt: DateTime.makeUnsafe(2_500),
            tokenUsage: {
              usedTokens: 1_000,
              maxTokens: 128_000,
              inputTokens: 100,
              cachedInputTokens: 900,
              outputTokens: 50,
              updatedAt: "2026-01-01T00:00:03.000Z",
            },
          },
        ],
        turnItems: [
          turnItem({
            id: TurnItemId.make("cmp-item"),
            type: "compaction",
            runId: RunId.make("run-2"),
            ordinal: 5,
            summary: "Summary of turn 1",
            beforeTokenCount: 1_200,
            afterTokenCount: 300,
            updatedAt: DateTime.makeUnsafe(2_100),
          }),
        ],
        messages: [],
      } as unknown as OrchestrationV2ThreadProjection;

      const systemMessageJson = JSON.stringify({
        role: "system",
        content: "Base system prompt",
        sections: {
          runtime: "Runtime rules",
          skills: "# Skills",
          "skill:review": "- review: Code review",
          on_demand_tools: "# On-demand tools",
        },
        timestamp: 1_000,
      });

      const snapshot: PersistedThreadSnapshot = {
        providerThreadId: "pt-1",
        records: [
          {
            id: "rec-sys",
            providerThreadId: "pt-1",
            sequence: 0,
            turnIndex: 0,
            role: "system",
            timestampMs: 1_000,
            messageJson: systemMessageJson,
            system: { version: 1, beforeMessageId: "rec-old", afterMessageId: null },
          },
          {
            id: "rec-old",
            providerThreadId: "pt-1",
            sequence: 1,
            turnIndex: 0,
            role: "user",
            timestampMs: 1_500,
            messageJson: JSON.stringify({
              role: "user",
              content: [{ type: "text", text: "Earlier task summarized at checkpoint" }],
              timestamp: 1_500,
            }),
            system: null,
          },
          {
            id: "rec-u1",
            providerThreadId: "pt-1",
            sequence: 2,
            turnIndex: 1,
            role: "user",
            timestampMs: 2_000,
            messageJson: JSON.stringify({
              role: "user",
              content: [{ type: "text", text: "Run review" }],
              timestamp: 2_000,
            }),
            system: null,
          },
          {
            id: "rec-a1",
            providerThreadId: "pt-1",
            sequence: 3,
            turnIndex: 1,
            role: "assistant",
            timestampMs: 2_200,
            messageJson: JSON.stringify({
              role: "assistant",
              content: [
                { type: "thinking", thinking: "Thinking..." },
                { type: "toolCall", id: "c1", name: "mcp__t3-code__t3_thread_list", arguments: {} },
                { type: "text", text: "All done" },
              ],
              api: "openai-responses",
              provider: "openai",
              model: "gpt-5",
              usage: {
                input: 100,
                output: 50,
                cacheRead: 900,
                cacheWrite: 0,
                totalTokens: 1_050,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: 2_200,
            }),
            system: null,
          },
          {
            id: "rec-tr1",
            providerThreadId: "pt-1",
            sequence: 4,
            turnIndex: 1,
            role: "toolResult",
            timestampMs: 2_300,
            messageJson: JSON.stringify({
              role: "toolResult",
              toolCallId: "c1",
              toolName: "mcp__t3-code__t3_thread_list",
              content: [{ type: "text", text: "[]" }],
              isError: false,
              timestamp: 2_300,
            }),
            system: null,
          },
          {
            id: "rec-tr2",
            providerThreadId: "pt-1",
            sequence: 5,
            turnIndex: 1,
            role: "toolResult",
            timestampMs: 2_400,
            messageJson: JSON.stringify({
              role: "toolResult",
              toolCallId: "c2",
              toolName: "Skill",
              content: [{ type: "text", text: "Review checklist" }],
              isError: false,
              timestamp: 2_400,
            }),
            system: null,
          },
        ],
        checkpoint: {
          providerThreadId: "pt-1",
          throughMessageId: "rec-old",
          mode: "completed_turn",
          summary: "Summary of turn 1",
          leadingSystemJson: systemMessageJson,
          retainedMessagesJson: JSON.stringify([]),
          summarizedMessageCount: 1,
          chunkCount: 1,
          usedFallback: false,
          createdAtMs: 2_100,
        },
        meta: {
          providerThreadId: "pt-1",
          todosJson: null,
          contextText: null,
          activatedToolNamesJson: JSON.stringify(["TodoWrite"]),
          updatedAtMs: 2_500,
        },
      };

      return Effect.gen(function* () {
        const service = yield* ThreadContextBreakdownService;
        const result = yield* service.read(threadId);
        expect(result.fidelity).toBe("exact");
        expect(result.driver).toBe("piNative");
        expect(result.window.usedTokens).toBe(1_000);
        expect(result.categories.reduce((sum, entry) => sum + entry.calibratedTokens, 0)).toBe(
          1_000,
        );
        expect(result.usage.inputTokens).toBe(1_000);
        expect(result.usage.cacheHitRate).toBe(0.9);
        expect(result.compactions).toHaveLength(1);
        expect(result.usage.compactionCount).toBe(1);
        expect(result.turns[0]?.events).not.toContain("compaction");
        expect(result.turns[1]?.events).toContain("compaction");
        expect(result.items.some((entry) => entry.label === "ToolSearch")).toBe(true);
        expect(result.items.some((entry) => entry.label === "TodoWrite")).toBe(true);
        const sysItem = result.items.find((entry) => entry.label === "Base system prompt");
        const toolItem = result.items.find((entry) => entry.kind === "tool_schema");
        const mcpItem = result.items.find((entry) => entry.kind === "mcp_schema");
        const userItem = result.items.find((entry) => entry.kind === "user_message");
        expect(sysItem).toBeDefined();
        expect(sysItem?.preview ?? "").not.toContain("Summary of turn 1");
        expect(result.items.some((entry) => entry.kind === "compaction_summary")).toBe(true);
        expect(sysItem!.orderIndex).toBeLessThan(toolItem!.orderIndex);
        expect(toolItem!.orderIndex).toBeLessThan(mcpItem!.orderIndex);
        expect(mcpItem!.orderIndex).toBeLessThan(userItem!.orderIndex);
      }).pipe(
        Effect.provide(
          makeServiceLayer({
            projection: piProjection,
            snapshot,
          }),
        ),
      );
    },
  );

  effectIt.effect(
    "resolves turn-0 Pi Native provider driver and modelBinding contextWindow",
    () => {
      const threadId = ThreadId.make("thread-pi-native-fresh");
      const instanceId = ProviderInstanceId.make("piNative_opencode-go");
      const freshProjection = {
        thread: {
          id: threadId,
          projectId: ProjectId.make("project-1"),
          worktreePath: null,
          modelSelection: { instanceId, model: "gpt-5.6-luna" },
        },
        runs: [],
        attempts: [],
        providerThreads: [],
        providerTurns: [],
        turnItems: [],
        messages: [],
      } as unknown as OrchestrationV2ThreadProjection;

      const providers: ReadonlyArray<ServerProvider> = [
        { instanceId, driver: "piNative", skills: [] } as unknown as ServerProvider,
      ];
      const settings = {
        providerInstances: {
          [instanceId]: {
            driver: "piNative",
            config: {
              defaultModel: "gpt-5.6-luna",
              modelBindings: [{ id: "gpt-5.6-luna", contextWindow: 256_000, maxTokens: 16_384 }],
            },
          },
        },
      } as unknown as ServerSettings;

      return Effect.gen(function* () {
        const service = yield* ThreadContextBreakdownService;
        const result = yield* service.read(threadId);
        expect(result.driver).toBe("piNative");
        expect(result.model).toBe("gpt-5.6-luna");
        expect(result.fidelity).toBe("exact");
        expect(result.window.maxTokens).toBe(256_000);
        expect(result.window.usedTokens).toBeGreaterThan(0);
        expect(result.items.some((entry) => entry.category === "system")).toBe(true);
        expect(result.items.some((entry) => entry.category === "tools")).toBe(true);
        expect(result.items.some((entry) => entry.category === "mcp")).toBe(true);
      }).pipe(
        Effect.provide(
          makeServiceLayer({
            projection: freshProjection,
            providers,
            snapshot: null,
            settings,
          }),
        ),
      );
    },
  );

  effectIt.effect("deduplicates compactions and computes turn deltas on estimated threads", () => {
    const threadId = ThreadId.make("thread-claude");
    const claudeTurnItems = [
      turnItem({
        id: TurnItemId.make("u1"),
        type: "user_message",
        runId: RunId.make("run-1"),
        messageId: MessageId.make("m1"),
        text: "first turn prompt",
        attachments: [],
        ordinal: 0,
      }),
      turnItem({
        id: TurnItemId.make("cmp-1"),
        type: "compaction",
        runId: RunId.make("run-2"),
        driver: null,
        summary: "compacted turn 1",
        beforeTokenCount: 2_000,
        afterTokenCount: 500,
        ordinal: 1,
      }),
      turnItem({
        id: TurnItemId.make("u2"),
        type: "user_message",
        runId: RunId.make("run-2"),
        messageId: MessageId.make("m2"),
        text: "second turn prompt",
        attachments: [],
        ordinal: 2,
      }),
    ] as unknown as ReadonlyArray<OrchestrationV2TurnItem>;

    const claudeProjection = {
      thread: {
        id: threadId,
        projectId: ProjectId.make("project-1"),
        worktreePath: null,
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet",
        },
      },
      runs: [
        {
          id: "run-1",
          ordinal: 1,
          startedAt: DateTime.makeUnsafe(1_000),
          requestedAt: DateTime.makeUnsafe(1_000),
        },
        {
          id: "run-2",
          ordinal: 2,
          startedAt: DateTime.makeUnsafe(2_000),
          requestedAt: DateTime.makeUnsafe(2_000),
        },
      ],
      attempts: [],
      providerThreads: [
        {
          id: "pt-c1",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          driver: "claudeAgent",
          lastRunOrdinal: 2,
          updatedAt: DateTime.makeUnsafe(2_000),
          contextUsage: { usedTokens: 5_000, maxTokens: 200_000 },
        },
      ],
      providerTurns: [],
      turnItems: claudeTurnItems,
      messages: [
        { id: "m1", text: "first turn prompt" },
        { id: "m2", text: "second turn prompt" },
      ],
    } as unknown as OrchestrationV2ThreadProjection;

    return Effect.gen(function* () {
      const service = yield* ThreadContextBreakdownService;
      const result = yield* service.read(threadId);
      expect(result.compactions).toHaveLength(1);
      expect(result.usage.compactionCount).toBe(1);
    }).pipe(Effect.provide(makeServiceLayer({ projection: claudeProjection })));
  });
});
