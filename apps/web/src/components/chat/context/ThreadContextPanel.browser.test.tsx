import "~/index.css";

import type { ThreadContextBreakdown } from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ breakdown: null as ThreadContextBreakdown | null }));

vi.mock(import("~/state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({
    data: state.breakdown,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useQuietThreadShell: (() => null) as never,
}));

import { act, render as renderUi } from "../../../../test/render";
import { ThreadContextPanel } from "./ThreadContextPanel";

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};

const category = (
  name: ThreadContextBreakdown["categories"][number]["category"],
  tokens: number,
  extra: Partial<ThreadContextBreakdown["categories"][number]> = {},
): ThreadContextBreakdown["categories"][number] => ({
  category: name,
  estimatedTokens: tokens,
  calibratedTokens: tokens,
  itemCount: 1,
  ...extra,
});

const item = (
  id: string,
  overrides: Partial<ThreadContextBreakdown["items"][number]>,
): ThreadContextBreakdown["items"][number] => ({
  id,
  category: "system",
  kind: "system_section",
  label: id,
  estimatedTokens: 100,
  calibratedTokens: 100,
  charCount: 400,
  byteCount: 400,
  orderIndex: 0,
  ...overrides,
});

const breakdown: ThreadContextBreakdown = {
  threadId: threadRef.threadId,
  providerInstanceId: null,
  driver: "claudeAgent",
  model: "claude-sonnet",
  fidelity: "estimated",
  fidelityNote: "Reconstructed from the orchestration transcript.",
  computedAt: "2026-01-01T00:00:00.000Z",
  window: {
    usedTokens: 1_200,
    estimatedTotalTokens: 1_200,
    actualUsedTokens: 1_200,
    maxTokens: 8_000,
    usedPercentage: 15,
    remainingTokens: 6_800,
    autoCompactThreshold: 7_200,
    reserveTokens: 800,
  },
  usage: {
    inputTokens: 1_000,
    cachedInputTokens: 625,
    cacheHitRate: 0.625,
    outputTokens: 200,
    reasoningOutputTokens: 50,
    toolUses: 3,
    turnCount: 2,
    compactionCount: 1,
    cost: null,
  },
  categories: [
    category("system", 400),
    category("mcp", 300, { deferredCount: 12, deferredTokens: 4_000 }),
    category("skills", 100, { deltaTokens: -2_500 }),
    category("user", 200),
    category("assistant", 200),
  ],
  items: [
    item("base-prompt", {
      label: "Base system prompt",
      category: "system",
      preview: "You are a helpful agent.",
      orderIndex: 0,
    }),
    item("mcp-tool", {
      label: "t3_thread_organize",
      category: "mcp",
      kind: "mcp_schema",
      source: "mcp:t3-code",
      meta: { mcpServer: "t3-code", toolName: "t3_thread_organize" },
      orderIndex: 2,
    }),
    item("skill", {
      label: "review",
      category: "skills",
      kind: "skill_loaded",
      meta: { skillId: "review" },
      orderIndex: 1,
    }),
    item("answer", {
      label: "Assistant answer",
      category: "assistant",
      kind: "assistant_answer",
      orderIndex: 3,
    }),
    item("thinking", {
      label: "Assistant reasoning",
      category: "assistant",
      kind: "assistant_reasoning",
      orderIndex: 4,
    }),
  ],
  turns: [
    {
      turnIndex: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
      usedTokens: 400,
      deltaTokens: 400,
      events: [],
    },
    {
      turnIndex: 1,
      timestamp: "2026-01-01T00:01:00.000Z",
      usedTokens: 1_200,
      deltaTokens: 800,
      cachedInputTokens: 500,
      outputTokens: 200,
      categories: {
        system: 400,
        mcp: 300,
        tools: 0,
        skills: 100,
        user: 200,
        assistant: 200,
        tool_results: 0,
        provider_overhead: 0,
      },
      events: ["compaction"],
    },
  ],
  compactions: [
    {
      id: "compaction-1",
      turnIndex: 1,
      timestamp: "2026-01-01T00:01:00.000Z",
      beforeTokens: 3_000,
      afterTokens: 1_200,
      savedTokens: 1_800,
      summaryPreview: "Earlier work summarized.",
    },
  ],
};

async function setup() {
  state.breakdown = breakdown;
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await renderUi(null));
  await act(async () => await screen.rerender(<ThreadContextPanel threadRef={threadRef} />));
  const environment = stack.move();
  return { screen, [Symbol.asyncDispose]: () => environment.disposeAsync() };
}

it("renders the composition bar, legend, KPIs, and timeline with non-zero layout", async () => {
  await using fixture = await setup();
  const { screen } = fixture;
  await expect.element(screen.getByText("Composition")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /System Prompt/ }).first()).toBeVisible();
  await expect.element(screen.getByText("Turns")).toBeVisible();
  await expect.element(screen.getByText("Turn by turn")).toBeVisible();
  await expect.element(screen.getByText("Compaction")).toBeVisible();
  await expect.element(screen.getByText("-2.5k")).toBeVisible();

  const bar = screen.container.querySelector('[role="img"]')!;
  const segments = [...bar.querySelectorAll("button")];
  expect(segments.length).toBeGreaterThan(0);
  for (const segment of segments) {
    expect(segment.getBoundingClientRect().width).toBeGreaterThan(0);
  }

  const timelineList = screen.container.querySelector('[role="list"]')!;
  const turnBars = [...timelineList.querySelectorAll('[role="listitem"] > div > span')];
  expect(turnBars.some((el) => el.getBoundingClientRect().height > 4)).toBe(true);
});

it("focuses a category from the legend or stacked bar and clears it again", async () => {
  await using fixture = await setup();
  const { screen } = fixture;
  const button = (prefix: string) =>
    [...screen.container.querySelectorAll("button")].find((element) =>
      element.textContent?.startsWith(prefix),
    )!;
  await userEvent.click(button("MCP≈"));
  await expect.element(screen.getByText(/Showing only MCP/)).toBeVisible();
  await expect.element(screen.getByText("t3_thread_organize")).toBeVisible();
  await userEvent.click(button("Showing only MCP"));
  expect(screen.container.textContent).not.toContain("Showing only");
});

it("searches MCP and skill items, auto-expands matching groups, and switches to prompt order", async () => {
  await using fixture = await setup();
  const { screen } = fixture;
  const search = screen.container.querySelector<HTMLInputElement>(
    'input[placeholder="Filter system, MCP, tools, skills, messages…"]',
  )!;
  await userEvent.type(search, "review");
  await expect.element(screen.getByText("review")).toBeVisible();
  expect(screen.container.textContent).not.toContain("Base system prompt");
  await userEvent.clear(search);
  await userEvent.click(
    [...screen.container.querySelectorAll("button")].find(
      (element) => element.textContent === "Prompt Order",
    )!,
  );
  await expect.element(screen.getByText("#5")).toBeVisible();
});

it("switches the timeline between total and delta", async () => {
  await using fixture = await setup();
  const { screen } = fixture;
  const delta = [...screen.container.querySelectorAll("button")].find(
    (element) => element.textContent === "Delta",
  )!;
  await userEvent.click(delta);
  expect(delta.getAttribute("aria-pressed")).toBe("true");
});
