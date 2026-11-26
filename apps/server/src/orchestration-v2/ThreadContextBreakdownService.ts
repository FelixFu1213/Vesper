// @effect-diagnostics nodeBuiltinImport:off -- reads workspace instruction files and Pi session logs.
import {
  type ChatAttachment,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ServerSettings,
  type ThreadContextBreakdown,
  type ThreadContextBreakdownItem,
  type ThreadContextCategory,
  type ThreadContextCategorySummary,
  type ThreadContextCompactionEvent,
  type ThreadContextFidelity,
  type ThreadContextItemKind,
  type ThreadContextItemMeta,
  type ThreadContextItemStatus,
  type ThreadContextTurnEvent,
  type ThreadContextTurnPoint,
  THREAD_CONTEXT_MAX_ITEMS,
  THREAD_CONTEXT_PREVIEW_MAX_CHARS,
  type ThreadId,
} from "@t3tools/contracts";
import {
  IMAGE_TOKEN_ESTIMATE,
  TOOL_SEARCH_NAME,
  buildT3SystemSections,
  computeContextBudget,
  discoverPiNativeSkills,
  estimateCjkAwareTextTokens,
  listPiNativeBuiltinToolSchemas,
  loadCustomSystemPrompt,
  piNativeSkillsPromptSections,
  PiNativeSessionStore,
  restoreTranscript,
  type PersistedThreadSnapshot,
  type PiNativeSkillDef,
} from "@t3tools/provider-pi-native/server";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DIRECT_DEFERRED_MCP_TOOLS } from "../mcp/McpToolExposure.ts";
import { listAdvertisedT3McpTools, type T3McpToolDescriptor } from "../mcp/McpToolCatalog.ts";
import * as ProjectMemoryService from "../project/ProjectMemoryService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { ProjectRow } from "./ProjectStore.ts";

const ORDER_BAND_SYSTEM = 0;
const ORDER_BAND_TOOLS = 1_000;
const ORDER_BAND_MCP = 2_000;
const ORDER_BAND_COMPACTION_SUMMARY = 2_999;
const ORDER_BAND_CONVERSATION = 3_000;
const MAX_PI_CLI_SESSION_BYTES = 4 * 1024 * 1024;

export class ThreadContextBreakdownError extends Schema.TaggedError<ThreadContextBreakdownError>()(
  "ThreadContextBreakdownError",
  {
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to compute the context breakdown for thread ${this.threadId}: ${this.detail}`;
  }
}

const failure = (threadId: string, detail: string, cause?: unknown) =>
  new ThreadContextBreakdownError({
    threadId,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

/** One analyzed piece of the prompt before calibration spreads the reported total over it. */
export interface ContextDraftItem {
  readonly id: string;
  readonly category: ThreadContextCategory;
  readonly kind: ThreadContextItemKind;
  readonly label: string;
  readonly source?: string;
  readonly status?: ThreadContextItemStatus;
  readonly estimatedTokens: number;
  readonly charCount: number;
  readonly byteCount: number;
  readonly turnIndex?: number;
  readonly orderIndex: number;
  readonly preview?: string;
  readonly previewTruncated?: boolean;
  readonly meta?: ThreadContextItemMeta;
}

export interface ContextDeferredCategory {
  readonly count: number;
  readonly tokens: number;
}

export interface ContextTurnDraft {
  readonly turnIndex: number;
  readonly runId?: string;
  readonly providerTurnId?: string;
  readonly timestamp: string;
  readonly usedTokens?: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly events: ReadonlyArray<ThreadContextTurnEvent>;
  readonly compactionSavedTokens?: number;
  readonly summary?: string;
}

export interface FinalizeContextBreakdownInput {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly driver: string | null;
  readonly model: string | null;
  readonly fidelity: ThreadContextFidelity;
  readonly fidelityNote?: string;
  readonly items: ReadonlyArray<ContextDraftItem>;
  readonly turns: ReadonlyArray<ContextTurnDraft>;
  readonly compactions: ReadonlyArray<ThreadContextCompactionEvent>;
  readonly actualUsedTokens: number | null;
  readonly maxTokens: number | null;
  readonly autoCompactThreshold: number | null;
  readonly reserveTokens: number | null;
  readonly usage: ThreadContextBreakdown["usage"];
  readonly deferred: Partial<Record<ThreadContextCategory, ContextDeferredCategory>>;
  readonly computedAt?: string;
}

const utf8Length = (text: string): number => {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
};

const truncate = (text: string): { preview: string; truncated: boolean } =>
  text.length <= THREAD_CONTEXT_PREVIEW_MAX_CHARS
    ? { preview: text, truncated: false }
    : { preview: text.slice(0, THREAD_CONTEXT_PREVIEW_MAX_CHARS), truncated: true };

/** Builds one draft item, deriving every count from the text it will show. */
export function draftContextItem(input: {
  readonly id: string;
  readonly category: ThreadContextCategory;
  readonly kind: ThreadContextItemKind;
  readonly label: string;
  readonly text?: string;
  readonly source?: string;
  readonly status?: ThreadContextItemStatus;
  readonly turnIndex?: number;
  readonly orderIndex: number;
  readonly estimatedTokens?: number;
  readonly previewText?: string;
  readonly meta?: ThreadContextItemMeta;
}): ContextDraftItem {
  const text = input.text ?? "";
  const preview = truncate(input.previewText ?? text);
  return {
    id: input.id,
    category: input.category,
    kind: input.kind,
    label: input.label,
    estimatedTokens: input.estimatedTokens ?? estimateCjkAwareTextTokens(text),
    charCount: text.length,
    byteCount: utf8Length(text),
    orderIndex: input.orderIndex,
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.turnIndex === undefined ? {} : { turnIndex: input.turnIndex }),
    ...(preview.preview === "" ? {} : { preview: preview.preview }),
    ...(preview.truncated ? { previewTruncated: true } : {}),
    ...(input.meta === undefined ? {} : { meta: input.meta }),
  };
}

/**
 * Spreads `total` over `weights` with largest-remainder rounding, so the parts sum to
 * exactly the total even when every part is a fraction.
 */
export function allocateProportionally(
  weights: ReadonlyArray<number>,
  total: number,
): ReadonlyArray<number> {
  if (weights.length === 0) return [];
  const positive = weights.map((weight) => Math.max(0, weight));
  const weightTotal = positive.reduce((sum, weight) => sum + weight, 0);
  if (weightTotal === 0) {
    const base = Math.floor(total / weights.length);
    return weights.map((_weight, index) =>
      index < total - base * weights.length ? base + 1 : base,
    );
  }
  const exact = positive.map((weight) => (weight / weightTotal) * total);
  const floors = exact.map((value) => Math.floor(value));
  let remainder = total - floors.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) =>
      right.fraction !== left.fraction ? right.fraction - left.fraction : left.index - right.index,
    );
  const result = [...floors];
  for (const entry of order) {
    if (remainder <= 0) break;
    result[entry.index] = (result[entry.index] ?? 0) + 1;
    remainder -= 1;
  }
  return result;
}

const CATEGORY_ORDER: ReadonlyArray<ThreadContextCategory> = [
  "system",
  "mcp",
  "tools",
  "skills",
  "user",
  "assistant",
  "tool_results",
  "provider_overhead",
];

function percentOf(part: number, whole: number | null): number | null {
  return whole === null || whole <= 0 ? null : Math.round((part / whole) * 1_000) / 10;
}

const sumEstimated = (items: ReadonlyArray<ContextDraftItem>): number =>
  items.reduce((sum, item) => sum + item.estimatedTokens, 0);

/**
 * Turns analyzed items into the wire breakdown: calibrates to the provider's reported
 * usage, then guarantees that category totals and the window total agree.
 */
export function finalizeContextBreakdown(
  input: FinalizeContextBreakdownInput,
): ThreadContextBreakdown {
  const computedAt = input.computedAt ?? DateTime.formatIso(DateTime.nowUnsafe());
  const items: ContextDraftItem[] = [...input.items];
  const rawTotal = sumEstimated(items);
  const actualUsedTokens =
    input.actualUsedTokens !== null && input.actualUsedTokens > 0 ? input.actualUsedTokens : null;

  if (actualUsedTokens !== null && input.fidelity === "estimated" && actualUsedTokens > rawTotal) {
    // The provider's own prompt and tool definitions are invisible to T3; charge the
    // difference honestly rather than silently inflating every message.
    const overhead = actualUsedTokens - rawTotal;
    items.push(
      draftContextItem({
        id: "provider-overhead",
        category: "provider_overhead",
        kind: "provider_overhead",
        label: "Provider built-in prompt & tools",
        text: "",
        estimatedTokens: overhead,
        orderIndex: Number.MAX_SAFE_INTEGER - 1,
        previewText: "",
        source: "provider",
      }),
    );
  }

  const estimatedTotalTokens = sumEstimated(items);
  const shouldCalibrate =
    actualUsedTokens !== null &&
    (input.fidelity !== "estimated" || actualUsedTokens < estimatedTotalTokens);
  const calibrated = shouldCalibrate
    ? allocateProportionally(
        items.map((item) => item.estimatedTokens),
        actualUsedTokens,
      )
    : items.map((item) => item.estimatedTokens);
  const usedTokens = calibrated.reduce((sum, value) => sum + value, 0);

  const calibratedById = new Map<string, number>();
  items.forEach((item, index) => calibratedById.set(item.id, calibrated[index] ?? 0));

  const categories: ThreadContextCategorySummary[] = CATEGORY_ORDER.map((category) => {
    const matching = items
      .map((item, index) => ({ item, tokens: calibrated[index] ?? 0 }))
      .filter((entry) => entry.item.category === category);
    const deferred = input.deferred[category];
    const summary: ThreadContextCategorySummary = {
      category,
      estimatedTokens: matching.reduce((sum, entry) => sum + entry.item.estimatedTokens, 0),
      calibratedTokens: matching.reduce((sum, entry) => sum + entry.tokens, 0),
      itemCount: matching.length,
      ...(deferred === undefined
        ? {}
        : { deferredCount: deferred.count, deferredTokens: deferred.tokens }),
    };
    return summary;
  });

  const orderedTurns = [...input.turns].sort((left, right) => left.turnIndex - right.turnIndex);
  let previousUsed = 0;
  const turns: ThreadContextTurnPoint[] = orderedTurns.map((turn) => {
    const rawUsed =
      turn.usedTokens ??
      items
        .filter((item) => item.turnIndex === undefined || item.turnIndex <= turn.turnIndex)
        .reduce((sum, item) => sum + item.estimatedTokens, 0);
    const scale = actualUsedTokens !== null && rawTotal > 0 ? actualUsedTokens / rawTotal : 1;
    const usedTokensForTurn = Math.max(
      0,
      turn.usedTokens ?? Math.round(rawUsed * (actualUsedTokens === null ? 1 : scale)),
    );
    const deltaTokens = usedTokensForTurn - previousUsed;
    previousUsed = usedTokensForTurn;
    const scaledCategories = allocateProportionally(
      CATEGORY_ORDER.map((category) =>
        items
          .filter(
            (item) =>
              item.category === category &&
              (item.turnIndex === undefined || item.turnIndex <= turn.turnIndex),
          )
          .reduce((sum, item) => sum + item.estimatedTokens, 0),
      ),
      usedTokensForTurn,
    );
    const categoryRecord: Record<ThreadContextCategory, number> = {
      system: 0,
      mcp: 0,
      tools: 0,
      skills: 0,
      user: 0,
      assistant: 0,
      tool_results: 0,
      provider_overhead: 0,
    };
    CATEGORY_ORDER.forEach((category, categoryIndex) => {
      categoryRecord[category] = scaledCategories[categoryIndex] ?? 0;
    });
    return {
      turnIndex: turn.turnIndex,
      ...(turn.runId === undefined
        ? {}
        : { runId: turn.runId as NonNullable<ThreadContextTurnPoint["runId"]> }),
      ...(turn.providerTurnId === undefined
        ? {}
        : {
            providerTurnId: turn.providerTurnId as NonNullable<
              ThreadContextTurnPoint["providerTurnId"]
            >,
          }),
      timestamp: turn.timestamp,
      usedTokens: usedTokensForTurn,
      deltaTokens,
      ...(turn.inputTokens === undefined ? {} : { inputTokens: turn.inputTokens }),
      ...(turn.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: turn.cachedInputTokens }),
      ...(turn.outputTokens === undefined ? {} : { outputTokens: turn.outputTokens }),
      ...(turn.reasoningOutputTokens === undefined
        ? {}
        : { reasoningOutputTokens: turn.reasoningOutputTokens }),
      categories: categoryRecord,
      events: [...turn.events],
      ...(turn.compactionSavedTokens === undefined
        ? {}
        : { compactionSavedTokens: turn.compactionSavedTokens }),
      ...(turn.summary === undefined ? {} : { summary: turn.summary }),
    };
  });
  // Category delta badges compare against the previous turn's stack.
  const categoriesWithDelta = categories.map((summary) => {
    const latest = turns.at(-1);
    const previous = turns.at(-2);
    if (latest === undefined || previous === undefined) return summary;
    const latestValue = latest.categories?.[summary.category] ?? 0;
    const previousValue = previous.categories?.[summary.category] ?? 0;
    return { ...summary, deltaTokens: latestValue - previousValue };
  });

  const breakdownItems: ThreadContextBreakdownItem[] = items
    .toSorted((left, right) =>
      left.orderIndex !== right.orderIndex
        ? left.orderIndex - right.orderIndex
        : left.id < right.id
          ? -1
          : left.id > right.id
            ? 1
            : 0,
    )
    .slice(0, THREAD_CONTEXT_MAX_ITEMS)
    .map((item) => ({
      id: item.id,
      category: item.category,
      kind: item.kind,
      label: item.label,
      estimatedTokens: item.estimatedTokens,
      calibratedTokens: calibratedById.get(item.id) ?? 0,
      charCount: item.charCount,
      byteCount: item.byteCount,
      orderIndex: item.orderIndex,
      ...(item.source === undefined ? {} : { source: item.source }),
      ...(item.status === undefined ? {} : { status: item.status }),
      ...(item.turnIndex === undefined ? {} : { turnIndex: item.turnIndex }),
      ...(item.preview === undefined ? {} : { preview: item.preview }),
      ...(item.previewTruncated === true ? { previewTruncated: true } : {}),
      ...(item.meta === undefined ? {} : { meta: item.meta }),
    }));

  const maxTokens = input.maxTokens;
  const autoCompactThreshold = input.autoCompactThreshold;
  const reserveTokens =
    input.reserveTokens ??
    (maxTokens === null
      ? null
      : computeContextBudget({ contextWindow: maxTokens, maxTokens: 0 }).reserveTokens);

  return {
    threadId: input.threadId,
    providerInstanceId: input.providerInstanceId,
    driver: input.driver,
    model: input.model,
    fidelity: input.fidelity,
    ...(input.fidelityNote === undefined ? {} : { fidelityNote: input.fidelityNote }),
    computedAt,
    window: {
      usedTokens,
      estimatedTotalTokens,
      actualUsedTokens,
      maxTokens,
      usedPercentage: percentOf(usedTokens, maxTokens),
      remainingTokens: maxTokens === null ? null : Math.max(0, maxTokens - usedTokens),
      autoCompactThreshold,
      reserveTokens,
    },
    usage: input.usage,
    categories: categoriesWithDelta,
    items: breakdownItems,
    turns,
    compactions: [...input.compactions],
  };
}

const instructionBytes = (text: string): number => utf8Length(text);

const readInstructions = (
  cwd: string | null,
): Effect.Effect<ReadonlyArray<{ name: string; path: string; text: string }>> =>
  Effect.promise(async () => {
    try {
      return await readWorkspaceInstructions(cwd, ["AGENTS.md", "CLAUDE.md"]);
    } catch {
      return [];
    }
  });

const MAX_INSTRUCTION_BYTES = 64 * 1024;

/** Reads `names` from `cwd` and each parent, newest first, capped at 64 KiB. */
async function readWorkspaceInstructions(
  cwd: string | null,
  names: ReadonlyArray<string>,
): Promise<ReadonlyArray<{ name: string; path: string; text: string }>> {
  if (cwd === null || cwd === "") return [];
  const found: Array<{ name: string; path: string; text: string }> = [];
  let remaining = MAX_INSTRUCTION_BYTES;
  let directory = NodePath.resolve(cwd);
  for (let depth = 0; depth < 16 && remaining > 0; depth += 1) {
    for (const name of names) {
      const path = NodePath.join(directory, name);
      const text = await NodeFSP.readFile(path, "utf8").catch(() => undefined);
      if (text === undefined || text.trim() === "") continue;
      if (instructionBytes(text) > remaining) continue;
      remaining -= instructionBytes(text);
      found.push({ name, path, text });
    }
    const parent = NodePath.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return found;
}

const assistantEventFor = (item: OrchestrationV2TurnItem): ThreadContextTurnEvent[] => {
  if (item.type === "compaction") return ["compaction"];
  if (item.type === "user_message" && item.modelSwitch !== undefined) return ["model_switch"];
  return [];
};

/** MCP tool names from a Pi Native `mcp__<server>__<tool>` call. */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const rest = toolName.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator <= 0) return undefined;
  return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
}

const skillTextOf = (text: string): string =>
  [...text.matchAll(/<skill\b[^>]*>[\s\S]*?<\/skill>/giu)].map((match) => match[0]).join("\n");

const stripSkillBlocks = (text: string): string =>
  text.replace(/<skill\b[^>]*>[\s\S]*?<\/skill>/giu, "").trim();

const imageCountOf = (attachments: ReadonlyArray<ChatAttachment>): number =>
  attachments.filter((attachment) => attachment.type === "image").length;

/** The baseline a fresh thread pays before its first message. */
interface StaticPromptInput {
  readonly cwd: string | null;
  readonly driver: string;
  readonly model: string | null;
  readonly memoryContent: string;
  readonly skills: ReadonlyArray<PiNativeSkillDef>;
}

function staticSystemItems(input: StaticPromptInput): ContextDraftItem[] {
  const items: ContextDraftItem[] = [];
  let order = 0;
  const push = (
    key: string,
    label: string,
    text: string,
    extras: Partial<Parameters<typeof draftContextItem>[0]> = {},
  ) => {
    if (text.trim() === "") return;
    items.push(
      draftContextItem({
        id: `static:${key}`,
        category: "system",
        kind: "system_section",
        label,
        text,
        orderIndex: order++,
        ...extras,
      }),
    );
  };
  const defaultRuntime = buildT3SystemSections({
    harness: input.driver,
    ...(input.model === null ? {} : { model: input.model }),
    hasT3Mcp: true,
    ...(input.memoryContent === "" ? {} : { projectMemory: input.memoryContent }),
    ...(input.skills.length === 0
      ? {}
      : { skillSections: piNativeSkillsPromptSections(input.skills) }),
  });
  for (const [section, text] of Object.entries(defaultRuntime)) {
    if (text === null || text === undefined || text.trim() === "") continue;
    if (section === "skills" || section.startsWith("skill:")) {
      items.push(
        draftContextItem({
          id: `static:${section}`,
          category: "skills",
          kind: "skill_catalog",
          label: section === "skills" ? "Skills catalog" : `Skill: ${section.slice(6)}`,
          text,
          orderIndex: order++,
          source: "activated",
          ...(section === "skills" ? {} : { meta: { skillId: section.slice("skill:".length) } }),
        }),
      );
      continue;
    }
    push(section, SECTION_LABELS[section] ?? section, text);
  }
  return items;
}

const SECTION_LABELS: Record<string, string> = {
  runtime: "Runtime & orchestration",
  custom_append: "APPEND_SYSTEM.md",
  project_instructions: "Project instructions (AGENTS.md)",
  context: "App context",
  project_memory: "Project memory",
  tool_activation: "Tool activation",
  context_budget: "Context budget reminder",
  on_demand_tools: "On-demand tools catalog",
  skills: "Skills catalog",
};

const mcpSchemaItems = (
  catalog: ReadonlyArray<T3McpToolDescriptor>,
  activeNames: ReadonlySet<string>,
): { items: ContextDraftItem[]; deferred: ContextDeferredCategory } => {
  const items: ContextDraftItem[] = [];
  let deferredCount = 0;
  let deferredTokens = 0;
  catalog.forEach((tool, index) => {
    if (!activeNames.has(tool.name)) {
      deferredCount += 1;
      deferredTokens += tool.estimatedTokens;
      return;
    }
    items.push(
      draftContextItem({
        id: `mcp-schema:${tool.name}`,
        category: "mcp",
        kind: "mcp_schema",
        label: tool.name,
        text: `${tool.description}\n${tool.schemaJson}`,
        estimatedTokens: tool.estimatedTokens,
        orderIndex: index,
        source: "mcp:t3-code",
        status: "active",
        meta: { mcpServer: "t3-code", toolName: tool.name },
      }),
    );
  });
  return { items, deferred: { count: deferredCount, tokens: deferredTokens } };
};

const builtinToolItems = (
  activeNames: ReadonlySet<string>,
  includeToolSearch: boolean,
): { items: ContextDraftItem[]; deferred: ContextDeferredCategory } => {
  const catalog = listPiNativeBuiltinToolSchemas();
  const deferredTools = catalog.filter(
    (tool) => tool.name !== TOOL_SEARCH_NAME && !activeNames.has(tool.name) && !tool.core,
  );
  const items: ContextDraftItem[] = [];
  let index = 0;
  for (const tool of catalog) {
    if (!activeNames.has(tool.name) && !tool.core) continue;
    items.push(
      draftContextItem({
        id: `tool-schema:${tool.name}`,
        category: "tools",
        kind: "tool_schema",
        label: tool.name,
        text: `${tool.description}\n${JSON.stringify(tool.parameters)}`,
        estimatedTokens: tool.estimatedTokens,
        orderIndex: index++,
        source: tool.core ? "core" : "activated",
        status: "active",
        meta: { toolName: tool.name },
      }),
    );
  }
  if (includeToolSearch && deferredTools.length > 0) {
    const search = catalog.find((tool) => tool.name === TOOL_SEARCH_NAME);
    if (search !== undefined && !activeNames.has(search.name)) {
      items.push(
        draftContextItem({
          id: `tool-schema:${TOOL_SEARCH_NAME}`,
          category: "tools",
          kind: "tool_schema",
          label: TOOL_SEARCH_NAME,
          text: `${search.description}\n${JSON.stringify(search.parameters)}`,
          estimatedTokens: search.estimatedTokens,
          orderIndex: index++,
          source: "core",
          status: "active",
          meta: { toolName: TOOL_SEARCH_NAME },
        }),
      );
    }
  }
  return {
    items,
    deferred: {
      count: deferredTools.length,
      tokens: deferredTools.reduce((sum, tool) => sum + tool.estimatedTokens, 0),
    },
  };
};

const mcpToolNamesForActive = (activated: ReadonlySet<string>): ReadonlySet<string> => {
  const active = new Set(DIRECT_DEFERRED_MCP_TOOLS);
  for (const name of activated) {
    const parsed = parseMcpToolName(name);
    if (parsed?.server === "t3-code") active.add(parsed.tool);
  }
  return active;
};

const latestTurnUsageOf = (
  projection: OrchestrationV2ThreadProjection,
  providerThreadId: string | null,
): OrchestrationV2ProviderTurnTokenUsage | null => {
  let latest: OrchestrationV2ProviderTurnTokenUsage | null = null;
  for (const turn of projection.providerTurns) {
    if (turn.tokenUsage === undefined) continue;
    if (providerThreadId !== null && turn.providerThreadId !== providerThreadId) continue;
    if (latest === null || Date.parse(turn.tokenUsage.updatedAt) >= Date.parse(latest.updatedAt)) {
      latest = turn.tokenUsage;
    }
  }
  return latest;
};

const normalizeInputTokens = (
  driver: string | null,
  rawInput: number | null,
  cachedInput: number | null,
): number | null => {
  if (driver === "piNative" || driver === "pi") {
    if (rawInput === null) return cachedInput;
    return rawInput + (cachedInput ?? 0);
  }
  if (rawInput === null) return null;
  return cachedInput !== null && cachedInput > rawInput ? rawInput + cachedInput : rawInput;
};

const providerUsage = (
  projection: OrchestrationV2ThreadProjection,
  providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] | undefined,
  latestTurnUsage: OrchestrationV2ProviderTurnTokenUsage | null,
  driver: string | null,
): ThreadContextBreakdown["usage"] => {
  const providerThreadId = providerThread?.id ?? null;
  const snapshot = providerThread?.contextUsage ?? null;
  const turnCount = projection.providerTurns.filter(
    (turn) => providerThreadId === null || turn.providerThreadId === providerThreadId,
  ).length;
  const toolUses =
    snapshot?.toolUses ??
    projection.turnItems.filter(
      (item) =>
        item.type === "command_execution" ||
        item.type === "file_change" ||
        item.type === "dynamic_tool",
    ).length;
  const rawInputTokens = snapshot?.inputTokens ?? latestTurnUsage?.inputTokens ?? null;
  const cachedInputTokens =
    snapshot?.cachedInputTokens ?? latestTurnUsage?.cachedInputTokens ?? null;
  const inputTokens = normalizeInputTokens(driver, rawInputTokens, cachedInputTokens);
  const cacheHitRate =
    inputTokens === null || cachedInputTokens === null || inputTokens <= 0
      ? null
      : Math.min(1, Math.max(0, Math.round((cachedInputTokens / inputTokens) * 1_000) / 1_000));
  return {
    inputTokens,
    cachedInputTokens,
    cacheHitRate,
    outputTokens: snapshot?.outputTokens ?? latestTurnUsage?.outputTokens ?? null,
    reasoningOutputTokens:
      snapshot?.reasoningOutputTokens ?? latestTurnUsage?.reasoningOutputTokens ?? null,
    toolUses,
    turnCount,
    compactionCount: 0,
    cost: snapshot?.cost ?? null,
  };
};

/** Maps one Pi Native system section to its category and human label. */
export function classifySystemSection(section: string): {
  readonly category: ThreadContextCategory;
  readonly kind: ThreadContextItemKind;
  readonly label: string;
} {
  if (section === "skills") {
    return { category: "skills", kind: "skill_catalog", label: "Skills catalog" };
  }
  if (section.startsWith("skill:")) {
    return {
      category: "skills",
      kind: "skill_catalog",
      label: `Skill: ${section.slice("skill:".length)}`,
    };
  }
  if (section === "on_demand_tools") {
    return { category: "tools", kind: "tool_catalog", label: "On-demand tools catalog" };
  }
  return {
    category: "system",
    kind: "system_section",
    label: SECTION_LABELS[section] ?? section,
  };
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const record = block as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

function imageBlocks(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter(
    (block) =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "image",
  ).length;
}

const turnIndexLookup = (snapshot: PersistedThreadSnapshot): Map<string, number> =>
  new Map(snapshot.records.map((record) => [record.id, record.turnIndex]));

interface ConversationAnalysis {
  readonly items: ContextDraftItem[];
  readonly turns: ReadonlyArray<ContextTurnDraft>;
  readonly compactions: ReadonlyArray<ThreadContextCompactionEvent>;
}

/** Analyzes the restored Pi Native transcript, one item per message block. */
function analyzePiNativeMessages(
  snapshot: PersistedThreadSnapshot,
  restored: {
    readonly messages: ReadonlyArray<{
      readonly role: string;
      readonly content?: unknown;
      readonly sections?: Record<string, string | null> | undefined;
      readonly toolName?: string;
      readonly isError?: boolean;
      readonly timestamp?: number;
    }>;
    readonly recordIds: ReadonlyMap<unknown, string>;
    readonly checkpoint?: boolean;
  },
): ConversationAnalysis {
  const turnIndexes = turnIndexLookup(snapshot);
  const items: ContextDraftItem[] = [];
  const compactions: ThreadContextCompactionEvent[] = [];
  const checkpointSummary =
    restored.checkpoint === true ? (snapshot.checkpoint?.summary.trim() ?? "") : "";
  const push = (item: ContextDraftItem) => items.push(item);

  restored.messages.forEach((message, messageIndex) => {
    const recordId = restored.recordIds.get(message);
    const turnIndex = recordId === undefined ? undefined : turnIndexes.get(recordId);
    const isLeadingSystem = messageIndex === 0 && message.role === "system";
    const baseOrder = isLeadingSystem ? ORDER_BAND_SYSTEM : ORDER_BAND_CONVERSATION + messageIndex;
    const withTurn = turnIndex === undefined ? {} : { turnIndex };
    if (message.role === "system") {
      let content = blockText(message.content);
      if (isLeadingSystem && checkpointSummary !== "") {
        // restoreTranscript folds checkpoint.summary into leadingSystem; pi:compaction-summary emits it below.
        if (content.trim() === checkpointSummary) {
          content = "";
        } else {
          const suffix = `\n\n${checkpointSummary}`;
          if (content.endsWith(suffix)) {
            content = content.slice(0, -suffix.length);
          }
        }
      }
      if (content.trim() !== "") {
        push(
          draftContextItem({
            id: `pi:system:${messageIndex}`,
            category: "system",
            kind: "system_section",
            label: "Base system prompt",
            text: content,
            source: "builtin",
            orderIndex: baseOrder,
            ...withTurn,
          }),
        );
      }
      let sectionOrder = 0;
      for (const [section, text] of Object.entries(message.sections ?? {})) {
        if (text === null || text.trim() === "") continue;
        const classified = classifySystemSection(section);
        push(
          draftContextItem({
            id: `pi:system:${messageIndex}:${section}`,
            category: classified.category,
            kind: classified.kind,
            label: classified.label,
            text,
            source: "activated",
            orderIndex: isLeadingSystem
              ? ORDER_BAND_SYSTEM + 1 + sectionOrder
              : baseOrder + (sectionOrder + 1) / 1_000,
            ...(section.startsWith("skill:")
              ? { meta: { skillId: section.slice("skill:".length) } }
              : {}),
            ...withTurn,
          }),
        );
        sectionOrder += 1;
      }
      return;
    }
    if (message.role === "user") {
      const content = blockText(message.content);
      const images = imageBlocks(message.content);
      const skillText = skillTextOf(content);
      const userText = stripSkillBlocks(content);
      let blockOrder = 0;
      if (skillText !== "") {
        push(
          draftContextItem({
            id: `pi:user:${messageIndex}:skill`,
            category: "skills",
            kind: "skill_loaded",
            label: "Loaded skill",
            text: skillText,
            source: "user",
            orderIndex: baseOrder + blockOrder / 1_000,
            ...withTurn,
          }),
        );
        blockOrder += 1;
      }
      if (userText !== "" || images > 0) {
        push(
          draftContextItem({
            id: `pi:user:${messageIndex}`,
            category: "user",
            kind: "user_message",
            label: "User message",
            text: userText,
            estimatedTokens: estimateCjkAwareTextTokens(userText) + images * IMAGE_TOKEN_ESTIMATE,
            source: "user",
            orderIndex: baseOrder + blockOrder / 1_000,
            ...(images === 0 ? {} : { meta: { imageCount: images } }),
            ...withTurn,
          }),
        );
      }
      return;
    }
    if (message.role === "assistant") {
      let blockOrder = 0;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const record = block as {
          type?: unknown;
          text?: unknown;
          thinking?: unknown;
          name?: unknown;
          arguments?: unknown;
        };
        if (record.type === "text" && typeof record.text === "string") {
          push(
            draftContextItem({
              id: `pi:assistant:${messageIndex}:${blockOrder}`,
              category: "assistant",
              kind: "assistant_answer",
              label: "Assistant answer",
              text: record.text,
              orderIndex: baseOrder + blockOrder / 1_000,
              ...withTurn,
            }),
          );
        } else if (record.type === "thinking" && typeof record.thinking === "string") {
          push(
            draftContextItem({
              id: `pi:assistant:${messageIndex}:${blockOrder}`,
              category: "assistant",
              kind: "assistant_reasoning",
              label: "Assistant reasoning",
              text: record.thinking,
              orderIndex: baseOrder + blockOrder / 1_000,
              ...withTurn,
            }),
          );
        } else if (record.type === "toolCall") {
          const name = typeof record.name === "string" ? record.name : "tool";
          const text = `${name}\n${JSON.stringify(record.arguments ?? {})}`;
          push(
            draftContextItem({
              id: `pi:assistant:${messageIndex}:${blockOrder}`,
              category: "assistant",
              kind: "assistant_tool_call",
              label: `Tool call: ${name}`,
              text,
              status: "ok",
              orderIndex: baseOrder + blockOrder / 1_000,
              meta: { toolName: name },
              ...withTurn,
            }),
          );
        }
        blockOrder += 1;
      }
      return;
    }
    if (message.role === "toolResult") {
      const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
      const content = blockText(message.content);
      const images = imageBlocks(message.content);
      const mcp = parseMcpToolName(toolName);
      const status = message.isError === true ? "error" : "ok";
      const tokens =
        estimateCjkAwareTextTokens(toolName) +
        estimateCjkAwareTextTokens(content) +
        images * IMAGE_TOKEN_ESTIMATE;
      if (toolName === "Skill") {
        push(
          draftContextItem({
            id: `pi:tool:${messageIndex}`,
            category: "skills",
            kind: "skill_loaded",
            label: "Loaded skill",
            text: content,
            estimatedTokens: tokens,
            status,
            orderIndex: baseOrder,
            meta: { toolName },
            ...withTurn,
          }),
        );
        return;
      }
      if (mcp !== undefined) {
        push(
          draftContextItem({
            id: `pi:tool:${messageIndex}`,
            category: "mcp",
            kind: "mcp_result",
            label: `${mcp.server}: ${mcp.tool}`,
            text: content,
            estimatedTokens: tokens,
            status,
            orderIndex: baseOrder,
            source: `mcp:${mcp.server}`,
            meta: { mcpServer: mcp.server, toolName: mcp.tool, imageCount: images },
            ...withTurn,
          }),
        );
        return;
      }
      push(
        draftContextItem({
          id: `pi:tool:${messageIndex}`,
          category: "tool_results",
          kind: "tool_result",
          label: toolName,
          text: content,
          estimatedTokens: tokens,
          status,
          orderIndex: baseOrder,
          meta: { toolName, ...(images === 0 ? {} : { imageCount: images }) },
          ...withTurn,
        }),
      );
    }
  });

  const checkpoint = snapshot.checkpoint;
  if (checkpoint !== null) {
    const summary = checkpoint.summary;
    compactions.push({
      id: `pi-compaction:${snapshot.providerThreadId}:${checkpoint.createdAtMs}`,
      timestamp: DateTime.formatIso(DateTime.makeUnsafe(checkpoint.createdAtMs)),
      summaryPreview:
        summary.length <= THREAD_CONTEXT_PREVIEW_MAX_CHARS
          ? summary
          : summary.slice(0, THREAD_CONTEXT_PREVIEW_MAX_CHARS),
    });
    if (summary.trim() !== "") {
      push(
        draftContextItem({
          id: "pi:compaction-summary",
          category: "assistant",
          kind: "compaction_summary",
          label: "Compaction summary",
          text: summary,
          orderIndex: ORDER_BAND_COMPACTION_SUMMARY,
          source: "compaction",
          meta: { assistantSubKind: "compaction" },
        }),
      );
    }
  }
  return { items, turns: [], compactions };
}

interface PiCliSessionEntry {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly parentId?: unknown;
  readonly timestamp?: unknown;
  readonly summary?: unknown;
  readonly firstKeptEntryId?: unknown;
  readonly tokensBefore?: unknown;
  readonly beforeTokens?: unknown;
  readonly tokensAfter?: unknown;
  readonly afterTokens?: unknown;
  readonly message?: {
    readonly role?: unknown;
    readonly content?: unknown;
    readonly toolName?: unknown;
    readonly isError?: unknown;
    readonly timestamp?: unknown;
    readonly usage?: {
      readonly input?: unknown;
      readonly cacheRead?: unknown;
      readonly cacheWrite?: unknown;
      readonly output?: unknown;
      readonly totalTokens?: unknown;
    };
  };
}

const finiteNonNegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

const isoTimestampOf = (value: unknown): string => {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return DateTime.formatIso(DateTime.makeUnsafe(value));
  }
  return DateTime.formatIso(DateTime.makeUnsafe(0));
};

/**
 * Parses a Pi CLI `.jsonl` transcript along its active `parentId` branch, applying the
 * latest `compaction` boundary so historical pruned messages are not charged twice.
 */
export function parsePiCliSessionJsonl(jsonlText: string): ConversationAnalysis {
  const byId = new Map<string, PiCliSessionEntry>();
  const linear: PiCliSessionEntry[] = [];
  let lastId: string | undefined;
  for (const rawLine of jsonlText.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const entry = parsed as PiCliSessionEntry;
    linear.push(entry);
    if (typeof entry.id === "string" && entry.id !== "") {
      byId.set(entry.id, entry);
      lastId = entry.id;
    }
  }

  let branch: PiCliSessionEntry[];
  if (lastId !== undefined && byId.size > 0) {
    const reversed: PiCliSessionEntry[] = [];
    const seen = new Set<string>();
    let currentId: string | undefined = lastId;
    while (currentId !== undefined && !seen.has(currentId)) {
      seen.add(currentId);
      const entry = byId.get(currentId);
      if (entry === undefined) break;
      reversed.push(entry);
      currentId =
        typeof entry.parentId === "string" && entry.parentId !== "" ? entry.parentId : undefined;
    }
    branch = reversed.reverse();
  } else {
    branch = linear;
  }

  const compactions: ThreadContextCompactionEvent[] = [];
  let latestCompactionIndex = -1;
  let turnCursor = -1;
  branch.forEach((entry, index) => {
    if (entry.type === "message" && entry.message?.role === "user") {
      turnCursor += 1;
    }
    if (entry.type !== "compaction") return;
    latestCompactionIndex = index;
    const beforeTokens = finiteNonNegative(entry.tokensBefore ?? entry.beforeTokens);
    const afterTokens = finiteNonNegative(entry.tokensAfter ?? entry.afterTokens);
    const summary = typeof entry.summary === "string" ? entry.summary : "";
    const id = typeof entry.id === "string" && entry.id !== "" ? entry.id : `line-${index}`;
    compactions.push({
      id: `pi-cli-compaction:${id}`,
      ...(turnCursor >= 0 ? { turnIndex: turnCursor } : {}),
      timestamp: isoTimestampOf(entry.timestamp),
      ...(beforeTokens === undefined ? {} : { beforeTokens }),
      ...(afterTokens === undefined ? {} : { afterTokens }),
      ...(beforeTokens !== undefined && afterTokens !== undefined
        ? { savedTokens: Math.max(0, beforeTokens - afterTokens) }
        : {}),
      ...(summary === ""
        ? {}
        : {
            summaryPreview:
              summary.length <= THREAD_CONTEXT_PREVIEW_MAX_CHARS
                ? summary
                : summary.slice(0, THREAD_CONTEXT_PREVIEW_MAX_CHARS),
          }),
    });
  });

  const latestCompaction = latestCompactionIndex >= 0 ? branch[latestCompactionIndex] : undefined;
  let activeStart = 0;
  if (latestCompaction !== undefined) {
    const firstKeptId =
      typeof latestCompaction.firstKeptEntryId === "string"
        ? latestCompaction.firstKeptEntryId
        : undefined;
    const keptIndex =
      firstKeptId === undefined ? -1 : branch.findIndex((entry) => entry.id === firstKeptId);
    activeStart = keptIndex >= 0 ? keptIndex : latestCompactionIndex + 1;
  }

  const items: ContextDraftItem[] = [];
  if (latestCompaction !== undefined && typeof latestCompaction.summary === "string") {
    const summary = latestCompaction.summary;
    if (summary.trim() !== "") {
      items.push(
        draftContextItem({
          id: "pi-cli:compaction-summary",
          category: "assistant",
          kind: "compaction_summary",
          label: "Compaction summary",
          text: summary,
          orderIndex: ORDER_BAND_COMPACTION_SUMMARY,
          source: "compaction",
          meta: { assistantSubKind: "compaction" },
        }),
      );
    }
  }

  const turns: ContextTurnDraft[] = [];
  let activeTurnIndex = -1;
  const activeEntries = branch.slice(activeStart);
  activeEntries.forEach((entry, messageIndex) => {
    if (entry.type !== "message" || entry.message === undefined) return;
    const message = entry.message;
    const role = typeof message.role === "string" ? message.role : "";
    const baseOrder = ORDER_BAND_CONVERSATION + messageIndex;
    if (role === "user") {
      activeTurnIndex += 1;
      turns.push({
        turnIndex: activeTurnIndex,
        timestamp: isoTimestampOf(entry.timestamp ?? message.timestamp),
        events: [],
      });
    }
    const withTurn = activeTurnIndex >= 0 ? { turnIndex: activeTurnIndex } : {};
    if (role === "system") {
      const content = blockText(message.content);
      if (content.trim() !== "") {
        items.push(
          draftContextItem({
            id: `pi-cli:system:${messageIndex}`,
            category: "system",
            kind: "system_section",
            label: "Session system prompt",
            text: content,
            source: "builtin",
            orderIndex: messageIndex === 0 ? ORDER_BAND_SYSTEM : baseOrder,
            ...withTurn,
          }),
        );
      }
      return;
    }
    if (role === "user") {
      const content = blockText(message.content);
      const images = imageBlocks(message.content);
      const skillText = skillTextOf(content);
      const userText = stripSkillBlocks(content);
      let blockOrder = 0;
      if (skillText !== "") {
        items.push(
          draftContextItem({
            id: `pi-cli:user:${messageIndex}:skill`,
            category: "skills",
            kind: "skill_loaded",
            label: "Loaded skill",
            text: skillText,
            source: "user",
            orderIndex: baseOrder + blockOrder / 1_000,
            ...withTurn,
          }),
        );
        blockOrder += 1;
      }
      if (userText !== "" || images > 0) {
        items.push(
          draftContextItem({
            id: `pi-cli:user:${messageIndex}`,
            category: "user",
            kind: "user_message",
            label: "User message",
            text: userText,
            estimatedTokens: estimateCjkAwareTextTokens(userText) + images * IMAGE_TOKEN_ESTIMATE,
            source: "user",
            orderIndex: baseOrder + blockOrder / 1_000,
            ...(images === 0 ? {} : { meta: { imageCount: images } }),
            ...withTurn,
          }),
        );
      }
      return;
    }
    if (role === "assistant") {
      let blockOrder = 0;
      const contentBlocks = Array.isArray(message.content) ? message.content : [];
      if (
        contentBlocks.length === 0 &&
        typeof message.content === "string" &&
        message.content !== ""
      ) {
        items.push(
          draftContextItem({
            id: `pi-cli:assistant:${messageIndex}:0`,
            category: "assistant",
            kind: "assistant_answer",
            label: "Assistant answer",
            text: message.content,
            orderIndex: baseOrder,
            ...withTurn,
          }),
        );
      }
      for (const block of contentBlocks) {
        const record = block as {
          type?: unknown;
          text?: unknown;
          thinking?: unknown;
          name?: unknown;
          arguments?: unknown;
        };
        if (record.type === "text" && typeof record.text === "string") {
          items.push(
            draftContextItem({
              id: `pi-cli:assistant:${messageIndex}:${blockOrder}`,
              category: "assistant",
              kind: "assistant_answer",
              label: "Assistant answer",
              text: record.text,
              orderIndex: baseOrder + blockOrder / 1_000,
              ...withTurn,
            }),
          );
        } else if (record.type === "thinking" && typeof record.thinking === "string") {
          items.push(
            draftContextItem({
              id: `pi-cli:assistant:${messageIndex}:${blockOrder}`,
              category: "assistant",
              kind: "assistant_reasoning",
              label: "Assistant reasoning",
              text: record.thinking,
              orderIndex: baseOrder + blockOrder / 1_000,
              ...withTurn,
            }),
          );
        } else if (record.type === "toolCall") {
          const name = typeof record.name === "string" ? record.name : "tool";
          items.push(
            draftContextItem({
              id: `pi-cli:assistant:${messageIndex}:${blockOrder}`,
              category: "assistant",
              kind: "assistant_tool_call",
              label: `Tool call: ${name}`,
              text: `${name}\n${JSON.stringify(record.arguments ?? {})}`,
              status: "ok",
              orderIndex: baseOrder + blockOrder / 1_000,
              meta: { toolName: name },
              ...withTurn,
            }),
          );
        }
        blockOrder += 1;
      }
      const usage = message.usage;
      const currentTurn = turns.at(-1);
      if (usage !== undefined && currentTurn !== undefined) {
        const input = finiteNonNegative(usage.input);
        const cacheRead = finiteNonNegative(usage.cacheRead);
        const cacheWrite = finiteNonNegative(usage.cacheWrite);
        const output = finiteNonNegative(usage.output);
        const total =
          finiteNonNegative(usage.totalTokens) ??
          (input !== undefined || cacheRead !== undefined || output !== undefined
            ? (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) + (output ?? 0)
            : undefined);
        const totalInput = input === undefined ? cacheRead : input + (cacheRead ?? 0);
        turns[turns.length - 1] = {
          ...currentTurn,
          ...(total === undefined ? {} : { usedTokens: total }),
          ...(totalInput === undefined ? {} : { inputTokens: totalInput }),
          ...(cacheRead === undefined ? {} : { cachedInputTokens: cacheRead }),
          ...(output === undefined ? {} : { outputTokens: output }),
        };
      }
      return;
    }
    if (role === "toolResult") {
      const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
      const content = blockText(message.content);
      const images = imageBlocks(message.content);
      const mcp = parseMcpToolName(toolName);
      const status = message.isError === true ? "error" : "ok";
      const tokens =
        estimateCjkAwareTextTokens(toolName) +
        estimateCjkAwareTextTokens(content) +
        images * IMAGE_TOKEN_ESTIMATE;
      if (toolName === "Skill") {
        items.push(
          draftContextItem({
            id: `pi-cli:tool:${messageIndex}`,
            category: "skills",
            kind: "skill_loaded",
            label: "Loaded skill",
            text: content,
            estimatedTokens: tokens,
            status,
            orderIndex: baseOrder,
            meta: { toolName },
            ...withTurn,
          }),
        );
        return;
      }
      if (mcp !== undefined) {
        items.push(
          draftContextItem({
            id: `pi-cli:tool:${messageIndex}`,
            category: "mcp",
            kind: "mcp_result",
            label: `${mcp.server}: ${mcp.tool}`,
            text: content,
            estimatedTokens: tokens,
            status,
            orderIndex: baseOrder,
            source: `mcp:${mcp.server}`,
            meta: { mcpServer: mcp.server, toolName: mcp.tool, imageCount: images },
            ...withTurn,
          }),
        );
        return;
      }
      items.push(
        draftContextItem({
          id: `pi-cli:tool:${messageIndex}`,
          category: "tool_results",
          kind: "tool_result",
          label: toolName,
          text: content,
          estimatedTokens: tokens,
          status,
          orderIndex: baseOrder,
          meta: { toolName, ...(images === 0 ? {} : { imageCount: images }) },
          ...withTurn,
        }),
      );
    }
  });
  return { items, turns, compactions };
}

const providerThreadOf = (
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection["providerThreads"][number] | undefined =>
  projection.providerThreads.toSorted((left, right) => {
    const leftOrdinal = left.lastRunOrdinal ?? left.firstRunOrdinal ?? -1;
    const rightOrdinal = right.lastRunOrdinal ?? right.firstRunOrdinal ?? -1;
    return rightOrdinal - leftOrdinal;
  })[0];

const modelOf = (
  projection: OrchestrationV2ThreadProjection,
  providerThreadId: string | null,
): string | null => {
  const turns = projection.providerTurns
    .filter((turn) => providerThreadId === null || turn.providerThreadId === providerThreadId)
    .toSorted((left, right) => right.ordinal - left.ordinal);
  return turns.find((turn) => turn.model !== undefined)?.model ?? null;
};

/** Text of a message whose turn item stores only a dedupe marker. */
const messageText = (
  projection: OrchestrationV2ThreadProjection,
  messageId: string | null | undefined,
  fallback: string,
): string => {
  if (messageId == null) return fallback;
  const message = projection.messages.find((entry) => entry.id === messageId);
  return message === undefined ? fallback : message.text;
};

/** Conversation items for providers whose prompt T3 reconstructs from its own history. */
export function analyzeOrchestrationItems(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly model: string | null;
}): ConversationAnalysis {
  const items: ContextDraftItem[] = [];
  const compactions: ThreadContextCompactionEvent[] = [];
  const runIdsWithItems = new Set(
    input.turnItems.flatMap((item) => (item.runId === null ? [] : [item.runId])),
  );
  const turns = input.projection.runs
    .filter((run) => runIdsWithItems.has(run.id))
    .toSorted((left, right) => left.ordinal - right.ordinal);
  const turnIndexOfRun = new Map(turns.map((run, index) => [run.id, index]));
  const latestCompaction = input.turnItems
    .filter((item) => item.type === "compaction")
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  const considered =
    latestCompaction === undefined
      ? input.turnItems
      : input.turnItems.filter((item) => item.ordinal >= latestCompaction.ordinal);
  const canObserveSkill = (name: string | null): boolean =>
    name === "Skill" || (name?.startsWith("mcp__") === true && /skill/iu.test(name));
  considered.forEach((item, index) => {
    const turnIndex = item.runId === null ? undefined : turnIndexOfRun.get(item.runId);
    const withTurn = turnIndex === undefined ? {} : { turnIndex };
    const order = index;
    const add = (
      category: ThreadContextCategory,
      kind: ThreadContextItemKind,
      label: string,
      text: string,
      extra: {
        readonly source?: string;
        readonly status?: ThreadContextItemStatus;
        readonly estimatedTokens?: number;
        readonly meta?: ThreadContextItemMeta;
      } = {},
    ) =>
      items.push(
        draftContextItem({
          id: `turn-item:${item.id}:${items.length}`,
          category,
          kind,
          label,
          text,
          orderIndex: order,
          ...withTurn,
          ...extra,
        }),
      );
    switch (item.type) {
      case "user_message": {
        const text = messageText(input.projection, item.messageId, item.text);
        const images = imageCountOf(item.attachments);
        if (text.trim() !== "" || images > 0) {
          add("user", "user_message", "User message", text, {
            estimatedTokens: estimateCjkAwareTextTokens(text) + images * IMAGE_TOKEN_ESTIMATE,
            ...(images === 0 ? {} : { meta: { imageCount: images } }),
          });
        }
        break;
      }
      case "assistant_message": {
        const text = messageText(input.projection, item.messageId, item.text);
        add("assistant", "assistant_answer", "Assistant answer", text);
        break;
      }
      case "reasoning":
        add("assistant", "assistant_reasoning", "Assistant reasoning", item.text);
        break;
      case "proposed_plan":
        add("assistant", "assistant_answer", "Proposed plan", item.markdown);
        break;
      case "command_execution":
        add("tool_results", "tool_result", "Command", `${item.input}\n${item.output ?? ""}`, {
          status:
            item.outputIndicatesFailure === true || (item.exitCode ?? 0) !== 0 ? "error" : "ok",
          meta: { toolName: "Bash" },
        });
        break;
      case "file_change":
        add(
          "tool_results",
          "tool_result",
          `File change: ${item.fileName}`,
          item.diffStr ?? item.newStr ?? "",
          { status: "ok", meta: { toolName: "Edit", filePath: item.fileName } },
        );
        break;
      case "file_search":
        add("tool_results", "tool_result", "File search", item.pattern ?? "", {
          meta: { toolName: "Grep" },
        });
        break;
      case "web_search":
        add("tool_results", "tool_result", "Web search", (item.patterns ?? []).join("\n"), {
          meta: { toolName: "WebSearch" },
        });
        break;
      case "dynamic_tool": {
        const name = item.toolName;
        const output =
          typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
        if (canObserveSkill(name)) {
          add("skills", "skill_loaded", `Skill: ${name ?? "Skill"}`, output, {
            source: "activated",
            ...(name === null ? {} : { meta: { toolName: name } }),
          });
          break;
        }
        const mcp = name === null ? undefined : parseMcpToolName(name);
        if (mcp !== undefined) {
          add("mcp", "mcp_result", `${mcp.server}: ${mcp.tool}`, output, {
            source: `mcp:${mcp.server}`,
            meta: { mcpServer: mcp.server, toolName: mcp.tool },
          });
          break;
        }
        add(
          "tool_results",
          "tool_result",
          name ?? "Tool",
          output,
          name === null ? {} : { meta: { toolName: name } },
        );
        break;
      }
      case "compaction": {
        if (item.summary !== undefined && item.summary.trim() !== "") {
          add("assistant", "compaction_summary", "Compaction summary", item.summary, {
            source: "compaction",
            meta: { assistantSubKind: "compaction" },
          });
          compactions.push({
            id: item.id,
            ...(turnIndex === undefined ? {} : { turnIndex }),
            timestamp: DateTime.toDateUtc(item.updatedAt).toISOString(),
            ...(item.beforeTokenCount === undefined ? {} : { beforeTokens: item.beforeTokenCount }),
            ...(item.afterTokenCount === undefined ? {} : { afterTokens: item.afterTokenCount }),
            ...(item.beforeTokenCount !== undefined && item.afterTokenCount !== undefined
              ? { savedTokens: Math.max(0, item.beforeTokenCount - item.afterTokenCount) }
              : {}),
          });
        }
        break;
      }
      default:
        break;
    }
  });
  const turnDrafts: ContextTurnDraft[] = turns.map((run, index) => {
    const turnItems = input.turnItems.filter((item) => item.runId === run.id);
    const events = [...new Set(turnItems.flatMap(assistantEventFor))];
    const compaction = turnItems.find((item) => item.type === "compaction");
    const saved =
      compaction !== undefined &&
      compaction.type === "compaction" &&
      compaction.beforeTokenCount !== undefined &&
      compaction.afterTokenCount !== undefined
        ? Math.max(0, compaction.beforeTokenCount - compaction.afterTokenCount)
        : undefined;
    return {
      turnIndex: index,
      runId: run.id,
      timestamp: DateTime.toDateUtc(run.startedAt ?? run.requestedAt).toISOString(),
      events,
      ...(saved === undefined ? {} : { compactionSavedTokens: saved }),
      ...(compaction !== undefined &&
      compaction.type === "compaction" &&
      compaction.summary !== undefined
        ? { summary: compaction.summary }
        : {}),
    };
  });
  return { items, turns: turnDrafts, compactions };
}

const providerTurnDrafts = (
  projection: OrchestrationV2ThreadProjection,
  providerThreadId: string | null,
  driver: string | null,
  compactions: ReadonlyArray<ThreadContextCompactionEvent>,
): ReadonlyArray<ContextTurnDraft> => {
  const turns = projection.providerTurns
    .filter((turn) => providerThreadId === null || turn.providerThreadId === providerThreadId)
    .toSorted((left, right) => left.ordinal - right.ordinal);
  const attempts = new Map(projection.attempts.map((attempt) => [attempt.id, attempt]));
  const compactionRunIds = new Set(
    projection.turnItems.flatMap((item) =>
      item.type === "compaction" && item.runId !== null ? [item.runId] : [],
    ),
  );
  const modelSwitchRunIds = new Set(
    projection.turnItems.flatMap((item) =>
      item.type === "user_message" && item.modelSwitch !== undefined && item.runId !== null
        ? [item.runId]
        : [],
    ),
  );
  const skillRunIds = new Set(
    projection.turnItems.flatMap((item) =>
      item.type === "dynamic_tool" && item.toolName === "Skill" && item.runId !== null
        ? [item.runId]
        : [],
    ),
  );
  const compactionTurnIndexes = new Set(
    compactions.flatMap((event) => (event.turnIndex === undefined ? [] : [event.turnIndex])),
  );

  return turns.map((turn, index) => {
    const attempt = turn.runAttemptId === null ? undefined : attempts.get(turn.runAttemptId);
    const runId = attempt?.runId;
    const live = turn.tokenUsage;
    const ledger = turn.turnTokenUsage;
    const rawInput = ledger?.inputTokens ?? live?.inputTokens;
    const cachedInput = ledger?.cachedInputTokens ?? live?.cachedInputTokens;
    const normalizedInput =
      rawInput === undefined && cachedInput === undefined
        ? undefined
        : (normalizeInputTokens(driver, rawInput ?? null, cachedInput ?? null) ?? undefined);
    const outputTokens = ledger?.outputTokens ?? live?.outputTokens;
    const reasoningOutputTokens = ledger?.reasoningTokens ?? live?.reasoningOutputTokens;
    const events: ThreadContextTurnEvent[] = [];
    if ((runId !== undefined && compactionRunIds.has(runId)) || compactionTurnIndexes.has(index)) {
      events.push("compaction");
    }
    if (runId !== undefined && modelSwitchRunIds.has(runId)) {
      events.push("model_switch");
    }
    if (runId !== undefined && skillRunIds.has(runId)) {
      events.push("skill_loaded");
    }
    return {
      turnIndex: index,
      ...(runId === undefined ? {} : { runId }),
      providerTurnId: turn.id,
      timestamp: DateTime.toDateUtc(
        turn.completedAt ?? turn.startedAt ?? DateTime.makeUnsafe(0),
      ).toISOString(),
      ...(live?.usedTokens === undefined ? {} : { usedTokens: live.usedTokens }),
      events,
      ...(normalizedInput === undefined ? {} : { inputTokens: normalizedInput }),
      ...(cachedInput === undefined ? {} : { cachedInputTokens: cachedInput }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
    };
  });
};

const providerSkillsCatalog = (
  providers: ReadonlyArray<import("@t3tools/contracts").ServerProvider>,
  providerInstanceId: ProviderInstanceId | null,
  cwd: string | null,
): ReadonlyArray<{ name: string; description: string }> => {
  if (providerInstanceId === null) return [];
  const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
  if (provider === undefined) return [];
  const workspace =
    cwd === null
      ? undefined
      : provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
  return (workspace?.skills ?? provider.skills).map((skill) => ({
    name: skill.displayName ?? skill.name,
    description: skill.shortDescription ?? skill.description ?? "",
  }));
};

const skillsCatalogText = (skills: ReadonlyArray<{ name: string; description: string }>): string =>
  skills.length === 0
    ? ""
    : [
        "# Skills",
        "",
        "These skills are available to this thread and load through the Skill tool.",
        ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
      ].join("\n");

const memoryText = (memory: {
  content: string;
  entries: ReadonlyArray<{ title: string; content: string }>;
}): string =>
  (memory.entries.length === 0
    ? memory.content
    : memory.entries
        .map((entry) =>
          entry.title === "" ? entry.content : `## ${entry.title}\n\n${entry.content}`,
        )
        .join("\n\n")
  ).trim();

export interface ThreadContextBreakdownServiceShape {
  readonly read: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadContextBreakdown, ThreadContextBreakdownError>;
}

export class ThreadContextBreakdownService extends Context.Service<
  ThreadContextBreakdownService,
  ThreadContextBreakdownServiceShape
>()("t3/orchestration-v2/ThreadContextBreakdownService") {}

const dedupeCompactions = (
  events: ReadonlyArray<ThreadContextCompactionEvent>,
): ReadonlyArray<ThreadContextCompactionEvent> => {
  const byId = new Map<string, ThreadContextCompactionEvent>();
  for (const event of events) {
    if (!byId.has(event.id)) byId.set(event.id, event);
  }
  return [...byId.values()].toSorted(
    (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );
};

const piNativeModelContextWindow = (
  settings: ServerSettings | null,
  providerInstanceId: ProviderInstanceId | null,
  model: string | null,
): number | null => {
  if (settings === null || providerInstanceId === null) return null;
  const config = settings.providerInstances[providerInstanceId]?.config as
    | { readonly defaultModel?: unknown; readonly modelBindings?: unknown }
    | undefined;
  if (config === undefined || !Array.isArray(config.modelBindings)) return null;
  const defaultModel = typeof config.defaultModel === "string" ? config.defaultModel.trim() : "";
  const targetModel = model !== null && model !== "" && model !== "default" ? model : defaultModel;
  const bindings = config.modelBindings as ReadonlyArray<{
    readonly id?: unknown;
    readonly contextWindow?: unknown;
  }>;
  const matched =
    (targetModel !== "" ? bindings.find((entry) => entry?.id === targetModel) : undefined) ??
    (bindings.length === 1 ? bindings[0] : undefined);
  return typeof matched?.contextWindow === "number" &&
    Number.isFinite(matched.contextWindow) &&
    matched.contextWindow > 0
    ? matched.contextWindow
    : null;
};

const readPiCliTranscript = (
  nativeSessionPath: string | null | undefined,
): Effect.Effect<ConversationAnalysis | null> =>
  Effect.tryPromise({
    try: async () => {
      if (
        nativeSessionPath === undefined ||
        nativeSessionPath === null ||
        nativeSessionPath === ""
      ) {
        return null;
      }
      const stat = await NodeFSP.stat(nativeSessionPath).catch(() => null);
      if (
        stat === null ||
        !stat.isFile() ||
        stat.size === 0 ||
        stat.size > MAX_PI_CLI_SESSION_BYTES
      ) {
        return null;
      }
      const raw = await NodeFSP.readFile(nativeSessionPath, "utf8");
      const parsed = parsePiCliSessionJsonl(raw);
      return parsed.items.length > 0 || parsed.compactions.length > 0 ? parsed : null;
    },
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed((): ConversationAnalysis | null => null));

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const memories = yield* ProjectMemoryService.ProjectMemoryService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const sessionStore = yield* Effect.serviceOption(PiNativeSessionStore);
  const serverSettings = yield* Effect.serviceOption(ServerSettingsService);

  const read = Effect.fn("ThreadContextBreakdownService.read")(function* (threadId: ThreadId) {
    const projection = yield* projections
      .getThreadProjection(threadId)
      .pipe(
        Effect.mapError((cause) =>
          failure(threadId, "Could not read the thread projection.", cause),
        ),
      );
    const project: ProjectRow | undefined = yield* projects.get(projection.thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((cause) => failure(threadId, "Could not read the project.", cause)),
    );
    const memory = yield* memories
      .get(projection.thread.projectId)
      .pipe(Effect.mapError((cause) => failure(threadId, "Could not read project memory.", cause)));
    const allProviders = yield* providers.getProviders;
    const providerThread = providerThreadOf(projection);
    const providerInstanceId =
      providerThread?.providerInstanceId ?? projection.thread.modelSelection.instanceId ?? null;
    const registeredProvider =
      providerInstanceId === null
        ? undefined
        : allProviders.find((entry) => entry.instanceId === providerInstanceId);
    const driver = providerThread?.driver ?? registeredProvider?.driver ?? null;
    const model =
      modelOf(projection, providerThread?.id ?? null) ??
      projection.thread.modelSelection.model ??
      null;
    const cwd = projection.thread.worktreePath ?? project?.workspaceRoot ?? null;
    const latestTurnUsage = latestTurnUsageOf(projection, providerThread?.id ?? null);
    const snapshotUsage = providerThread?.contextUsage ?? null;
    const usage = providerUsage(projection, providerThread, latestTurnUsage, driver);
    const snapshotUpdatedAtMs =
      providerThread === undefined
        ? Number.NEGATIVE_INFINITY
        : DateTime.toEpochMillis(providerThread.updatedAt);
    const turnUsageUpdatedAtMs =
      latestTurnUsage === null ? Number.NEGATIVE_INFINITY : Date.parse(latestTurnUsage.updatedAt);
    const latestUsageUpdatedAtMs = Math.max(snapshotUpdatedAtMs, turnUsageUpdatedAtMs);
    const latestCompletedCompaction = projection.turnItems.findLast(
      (item) => item.type === "compaction" && item.status === "completed",
    );
    const compactionAfterUsage =
      latestCompletedCompaction !== undefined &&
      latestCompletedCompaction.type === "compaction" &&
      latestCompletedCompaction.afterTokenCount !== undefined &&
      DateTime.toEpochMillis(
        latestCompletedCompaction.completedAt ?? latestCompletedCompaction.updatedAt,
      ) > latestUsageUpdatedAtMs;
    const rawUsedTokens = compactionAfterUsage
      ? latestCompletedCompaction.afterTokenCount!
      : latestTurnUsage !== null &&
          (snapshotUsage === null || turnUsageUpdatedAtMs >= snapshotUpdatedAtMs)
        ? latestTurnUsage.usedTokens
        : (snapshotUsage?.usedTokens ?? latestTurnUsage?.usedTokens ?? null);
    const actualUsedTokens = rawUsedTokens !== null && rawUsedTokens > 0 ? rawUsedTokens : null;

    let maxTokens = latestTurnUsage?.maxTokens ?? snapshotUsage?.maxTokens ?? null;
    if (maxTokens === null && driver === "piNative" && Option.isSome(serverSettings)) {
      const settings = yield* serverSettings.value.getSettings.pipe(
        Effect.orElseSucceed(() => null),
      );
      maxTokens = piNativeModelContextWindow(settings, providerInstanceId, model);
    }
    const budget =
      maxTokens === null ? null : computeContextBudget({ contextWindow: maxTokens, maxTokens: 0 });
    const autoCompactThreshold =
      latestTurnUsage?.autoCompactThreshold ??
      snapshotUsage?.autoCompactThreshold ??
      budget?.autoCompactThreshold ??
      null;
    const reserveTokens = budget?.reserveTokens ?? null;
    const memoryContent = memoryText(memory);
    const providerSkills = providerSkillsCatalog(allProviders, providerInstanceId, cwd);
    const projectionCompactions = compactionEventsFromProjection(projection);

    if (driver === "piNative") {
      const now = yield* Clock.currentTimeMillis;
      const snapshot =
        providerThread === undefined || Option.isNone(sessionStore)
          ? null
          : yield* sessionStore.value
              .loadThread(providerThread.id)
              .pipe(
                Effect.mapError((cause) =>
                  failure(threadId, "Could not read the Pi Native session.", cause),
                ),
              );
      const skills: ReadonlyArray<PiNativeSkillDef> = yield* Effect.tryPromise({
        try: async () => {
          if (cwd === null) return [];
          const discovery = await discoverPiNativeSkills({ cwd, environment: process.env });
          return discovery.skills;
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed((): ReadonlyArray<PiNativeSkillDef> => []));
      const activatedNames = new Set<string>();
      for (const name of parseActivatedToolNames(snapshot?.meta?.activatedToolNamesJson)) {
        activatedNames.add(name);
      }
      const builtinNames = new Set(
        listPiNativeBuiltinToolSchemas()
          .filter((tool) => tool.core)
          .map((tool) => tool.name),
      );
      for (const name of activatedNames) {
        if (!name.startsWith("mcp__")) builtinNames.add(name);
      }
      const builtinSchemas = builtinToolItems(builtinNames, true);
      const mcpSchemas = mcpSchemaItems(
        listAdvertisedT3McpTools(),
        mcpToolNamesForActive(activatedNames),
      );

      const analyzedItems: ContextDraftItem[] = [];
      let turns: ReadonlyArray<ContextTurnDraft> = [];
      let compactions: ReadonlyArray<ThreadContextCompactionEvent> = projectionCompactions;
      let baselineOrder = ORDER_BAND_SYSTEM;

      if (snapshot === null || snapshot.records.length === 0) {
        const custom = yield* Effect.tryPromise({
          try: () => loadCustomSystemPrompt({ workspaceRoot: cwd }),
          catch: () => undefined,
        }).pipe(
          Effect.orElseSucceed((): Awaited<ReturnType<typeof loadCustomSystemPrompt>> => undefined),
        );
        const staticItems = staticSystemItems({
          cwd,
          driver: "Pi Native",
          model,
          memoryContent,
          skills,
        });
        const instructions = yield* readInstructions(cwd);
        if (custom?.replace !== undefined) {
          analyzedItems.push(
            draftContextItem({
              id: "static:system-md",
              category: "system",
              kind: "system_section",
              label: "SYSTEM.md",
              text: custom.replace,
              source: "project",
              orderIndex: baselineOrder++,
            }),
          );
        }
        for (const item of staticItems) {
          analyzedItems.push({ ...item, orderIndex: baselineOrder++ });
        }
        if (custom?.append !== undefined && custom.append.trim() !== "") {
          analyzedItems.push(
            draftContextItem({
              id: "static:append-system-md",
              category: "system",
              kind: "system_section",
              label: "APPEND_SYSTEM.md",
              text: custom.append,
              source: "project",
              orderIndex: baselineOrder++,
            }),
          );
        }
        for (const instruction of instructions) {
          analyzedItems.push(
            draftContextItem({
              id: `static:instructions:${instruction.path}`,
              category: "system",
              kind: "system_section",
              label: `Project instructions (${instruction.name})`,
              text: instruction.text,
              source: "project",
              orderIndex: baselineOrder++,
              meta: { filePath: instruction.path },
            }),
          );
        }
      } else {
        const restored = yield* Effect.tryPromise({
          try: async () =>
            restoreTranscript({
              snapshot,
              model: { api: "unknown", provider: "pi", model: model ?? "unknown" },
              now,
              supportsVision: true,
              readImage: async () => null,
            }),
          catch: (cause) => failure(threadId, "Could not restore the Pi Native transcript.", cause),
        });
        const analysis = analyzePiNativeMessages(snapshot, restored);
        analyzedItems.push(...analysis.items);
        compactions = dedupeCompactions(
          projectionCompactions.length > 0 ? projectionCompactions : analysis.compactions,
        );
        turns = providerTurnDrafts(projection, providerThread?.id ?? null, driver, compactions);
      }
      const allItems = [
        ...analyzedItems,
        ...builtinSchemas.items.map((item) => ({
          ...item,
          orderIndex: ORDER_BAND_TOOLS + item.orderIndex,
        })),
        ...mcpSchemas.items.map((item) => ({
          ...item,
          orderIndex: ORDER_BAND_MCP + item.orderIndex,
        })),
      ];
      return finalizeContextBreakdown({
        threadId,
        providerInstanceId,
        driver,
        model,
        fidelity: "exact",
        fidelityNote:
          "Read from the Pi Native transcript this thread actually sends, including its system sections and tool declarations.",
        items: allItems,
        turns,
        compactions,
        actualUsedTokens,
        maxTokens,
        autoCompactThreshold,
        reserveTokens,
        usage: { ...usage, compactionCount: compactions.length },
        deferred: { tools: builtinSchemas.deferred, mcp: mcpSchemas.deferred },
      });
    }

    const baselineSkills = skillsCatalogText(providerSkills);
    const instructions = yield* readInstructions(cwd);
    const staticItems = staticSystemItems({
      cwd,
      driver: driver ?? "T3 Code",
      model,
      memoryContent,
      skills: [],
    });
    const baseItems: ContextDraftItem[] = [];
    let order = ORDER_BAND_SYSTEM;
    for (const instruction of instructions) {
      baseItems.push(
        draftContextItem({
          id: `static:instructions:${instruction.path}`,
          category: "system",
          kind: "system_section",
          label: `Project instructions (${instruction.name})`,
          text: instruction.text,
          source: "project",
          orderIndex: order++,
          meta: { filePath: instruction.path },
        }),
      );
    }
    for (const item of staticItems) {
      baseItems.push({ ...item, orderIndex: order++ });
    }
    if (baselineSkills !== "") {
      baseItems.push(
        draftContextItem({
          id: "static:skills",
          category: "skills",
          kind: "skill_catalog",
          label: "Skills catalog",
          text: baselineSkills,
          source: "activated",
          orderIndex: order++,
        }),
      );
    }
    const deferMcp = driver === "claudeAgent" || driver === "pi";
    const mcpActive = deferMcp
      ? new Set(DIRECT_DEFERRED_MCP_TOOLS)
      : new Set(listAdvertisedT3McpTools().map((tool) => tool.name));
    const mcpItems = mcpSchemaItems(listAdvertisedT3McpTools(), mcpActive);
    const piCliAnalysis =
      driver === "pi"
        ? yield* readPiCliTranscript(providerThread?.nativeThreadRef?.nativeId)
        : null;
    const analysis =
      piCliAnalysis ??
      analyzeOrchestrationItems({
        projection,
        turnItems: projection.turnItems,
        model,
      });
    const conversationItems =
      piCliAnalysis !== null
        ? piCliAnalysis.items
        : analysis.items.map((item) => ({
            ...item,
            orderIndex: ORDER_BAND_CONVERSATION + item.orderIndex,
          }));
    const compactions = dedupeCompactions(
      projectionCompactions.length > 0 && piCliAnalysis === null
        ? projectionCompactions
        : [...analysis.compactions, ...projectionCompactions],
    );
    const turns =
      piCliAnalysis !== null && projection.providerTurns.length > 0
        ? providerTurnDrafts(projection, providerThread?.id ?? null, driver, compactions).map(
            (turn, index) => {
              const cliTurn = piCliAnalysis.turns[index];
              return turn.usedTokens !== undefined || cliTurn?.usedTokens === undefined
                ? turn
                : { ...turn, usedTokens: cliTurn.usedTokens };
            },
          )
        : analysis.turns;
    const fidelity: ThreadContextFidelity = driver === "pi" ? "calibrated" : "estimated";
    return finalizeContextBreakdown({
      threadId,
      providerInstanceId,
      driver,
      model,
      fidelity,
      fidelityNote:
        fidelity === "calibrated"
          ? piCliAnalysis !== null
            ? "Read from the Pi session transcript plus T3's prompt and MCP catalog, then anchored to the provider's reported usage."
            : "Composed from T3's prompt, the workspace instruction chain, and the orchestration transcript, then anchored to the provider's reported usage."
          : "Reconstructed from T3's prompt, workspace instructions, and the orchestration transcript. The provider's own built-in prompt and tool definitions are not exposed.",
      items: [
        ...baseItems,
        ...mcpItems.items.map((item) => ({
          ...item,
          orderIndex: ORDER_BAND_MCP + item.orderIndex,
        })),
        ...conversationItems,
      ],
      turns,
      compactions,
      actualUsedTokens,
      maxTokens,
      autoCompactThreshold,
      reserveTokens,
      usage: {
        ...usage,
        compactionCount: compactions.length,
      },
      deferred: { mcp: mcpItems.deferred },
    });
  });

  return ThreadContextBreakdownService.of({ read });
});

export const layer = Layer.effect(ThreadContextBreakdownService, make);

function parseActivatedToolNames(json: string | null | undefined): ReadonlyArray<string> {
  if (json === undefined || json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === "string" && name !== "")
      : [];
  } catch {
    return [];
  }
}

function compactionEventsFromProjection(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<ThreadContextCompactionEvent> {
  return projection.turnItems.flatMap((item) => {
    if (item.type !== "compaction") return [];
    const run = projection.runs.find((entry) => entry.id === item.runId);
    const turnIndex =
      run === undefined
        ? undefined
        : projection.runs
            .toSorted((left, right) => left.ordinal - right.ordinal)
            .findIndex((entry) => entry.id === run.id);
    return [
      {
        id: item.id,
        ...(turnIndex === undefined || turnIndex < 0 ? {} : { turnIndex }),
        timestamp: DateTime.toDateUtc(item.updatedAt).toISOString(),
        ...(item.beforeTokenCount === undefined ? {} : { beforeTokens: item.beforeTokenCount }),
        ...(item.afterTokenCount === undefined ? {} : { afterTokens: item.afterTokenCount }),
        ...(item.beforeTokenCount !== undefined && item.afterTokenCount !== undefined
          ? { savedTokens: Math.max(0, item.beforeTokenCount - item.afterTokenCount) }
          : {}),
        ...(item.summary === undefined
          ? {}
          : {
              summaryPreview:
                item.summary.length <= THREAD_CONTEXT_PREVIEW_MAX_CHARS
                  ? item.summary
                  : item.summary.slice(0, THREAD_CONTEXT_PREVIEW_MAX_CHARS),
            }),
      },
    ];
  });
}
