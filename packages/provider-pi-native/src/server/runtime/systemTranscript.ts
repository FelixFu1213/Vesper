import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import type { OrchestrationV2ProviderGoal } from "@t3tools/contracts";
import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { t3OrchestrationSystemPrompt } from "@t3tools/provider-core/server/orchestrationInstructions";

/** Sections render in this order; later sections may depend on earlier ones. */
export const CANONICAL_SYSTEM_SECTIONS = [
  "runtime",
  "skills",
  "tool_activation",
  "context",
  "context_budget",
] as const;

/** Skills own one section each, appended as `skill:<id>` right after the catalog header. */
export const SKILL_SECTION_PREFIX = "skill:";

export type SystemSectionName =
  | (typeof CANONICAL_SYSTEM_SECTIONS)[number]
  | `${typeof SKILL_SECTION_PREFIX}${string}`;

/** `null` removes a section; `undefined` leaves it untouched. */
export type SystemSectionMap = Partial<Record<string, string | null>>;

const isSkillSection = (name: string): boolean => name.startsWith(SKILL_SECTION_PREFIX);

/** Canonical order, with the per-skill sections kept together behind the catalog header. */
function orderedSectionNames(
  sections: SystemSectionMap | undefined,
  committed?: SystemSectionMap | undefined,
): ReadonlyArray<string> {
  const skillSections = new Set<string>();
  for (const source of [committed, sections]) {
    if (source === undefined) continue;
    for (const name of Object.keys(source)) {
      if (isSkillSection(name)) skillSections.add(name);
    }
  }
  const names: Array<string> = [];
  for (const name of CANONICAL_SYSTEM_SECTIONS) {
    names.push(name);
    if (name === "skills") names.push(...[...skillSections].sort());
  }
  return names;
}

function orderedSections(
  sections: SystemSectionMap | undefined,
): Record<string, string> | undefined {
  if (sections === undefined) return undefined;
  const ordered: Record<string, string> = {};
  for (const name of orderedSectionNames(sections)) {
    const value = sections[name];
    if (typeof value === "string" && value !== "") ordered[name] = value;
  }
  return Object.keys(ordered).length === 0 ? undefined : ordered;
}

export interface SystemTranscriptManagerInput {
  readonly basePrompt: string;
  readonly sections?: SystemSectionMap | undefined;
  readonly timestamp?: number | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * Owns the leading system message and the append-only section deltas that follow it.
 * Deltas only carry changed sections so the cached leading prompt stays byte-identical.
 */
export class SystemTranscriptManager {
  readonly #basePrompt: string;
  #committed: SystemSectionMap;
  readonly #now: () => number;
  readonly initialSystemMessage: SystemMessage | undefined;

  constructor(input: SystemTranscriptManagerInput) {
    this.#basePrompt = input.basePrompt;
    this.#committed = input.sections ?? {};
    this.#now = input.now ?? (() => 0);
    const timestamp = input.timestamp ?? this.#now();
    const sections = orderedSections(this.#committed);
    this.initialSystemMessage =
      this.#basePrompt === "" && sections === undefined
        ? undefined
        : {
            role: "system",
            content: this.#basePrompt,
            ...(sections === undefined ? {} : { sections }),
            timestamp,
          };
  }

  get committedSections(): Readonly<SystemSectionMap> {
    return this.#committed;
  }

  get basePrompt(): string {
    return this.#basePrompt;
  }

  /**
   * Commits `next` and returns the delta message, or null when nothing changed.
   * Unchanged sections are omitted so a delta never re-sends the cached prefix.
   */
  diffSections(next: SystemSectionMap, timestamp: number): SystemMessage | null {
    const changed: Record<string, string | null> = {};
    for (const name of orderedSectionNames(next, this.#committed)) {
      const value = next[name];
      const committed = this.#committed[name];
      if (value === undefined) {
        // A skill that left the catalog is revoked explicitly; other sections stay untouched.
        if (isSkillSection(name) && typeof committed === "string") changed[name] = null;
        continue;
      }
      if (committed === value) continue;
      changed[name] = value === "" ? null : value;
    }
    const committed: SystemSectionMap = { ...this.#committed, ...next };
    for (const [name, value] of Object.entries(changed)) {
      if (value === null) committed[name] = null;
    }
    this.#committed = committed;
    const names = Object.keys(changed);
    if (names.length === 0) return null;
    return { role: "system", content: "", sections: changed, timestamp };
  }
}

export interface FoldedTranscript {
  readonly leadingSystem: SystemMessage | undefined;
  readonly nonSystemMessages: AgentMessage[];
}

/**
 * Collapses every system message of a transcript into one leading message. Compaction
 * checkpoints replay this folded prefix instead of the whole delta chain.
 */
export function foldForCheckpoint(
  messages: readonly AgentMessage[],
  timestamp: number,
): FoldedTranscript {
  const contents: string[] = [];
  const sections: Record<string, string | null> = {};
  let seenSystem = false;
  const firstSystem: SystemMessage | undefined = messages.find(
    (message): message is SystemMessage => message.role === "system",
  );
  for (const message of messages) {
    if (message.role !== "system") continue;
    seenSystem = true;
    appendContent(contents, message.content);
    if (message.sections !== undefined) {
      for (const [name, value] of Object.entries(message.sections)) {
        sections[name] = value;
      }
    }
  }
  const nonSystemMessages = messages.filter((message) => message.role !== "system");
  if (!seenSystem || firstSystem === undefined) {
    return { leadingSystem: undefined, nonSystemMessages };
  }
  const nonNullSections: Record<string, string> = {};
  for (const [name, value] of Object.entries(sections)) {
    if (value !== null) nonNullSections[name] = value;
  }
  const content = contents.filter((value) => value !== "").join("\n\n");
  const leadingSystem: SystemMessage = {
    role: "system",
    content,
    ...(Object.keys(nonNullSections).length === 0 ? {} : { sections: nonNullSections }),
    timestamp: firstSystem.timestamp || timestamp,
  };
  return { leadingSystem, nonSystemMessages };
}

function appendContent(target: string[], content: SystemMessage["content"]): void {
  if (typeof content === "string") {
    if (content !== "") target.push(content);
    return;
  }
  for (const block of content) {
    if (block.type === "text" && block.text !== "") target.push(block.text);
  }
}

const PLAN_MODE_SECTION =
  "<plan_mode>You are in plan mode. Investigate the codebase using read-only tools and formulate a concrete implementation plan. Do not modify files or run commands that change state. When the plan is ready for user review, call SubmitPlan with the complete markdown plan and wait for the user to approve execution or request revisions.</plan_mode>";

function goalModeSection(goal: OrchestrationV2ProviderGoal): string {
  return [
    "<goal_mode>",
    `Objective: ${goal.objective}`,
    `Checks recorded so far: ${goal.checks ?? 0}.`,
    'Verify every acceptance criterion objectively before finishing. When the objective is satisfied, call UpdateGoalStatus with status: "complete" and a concise verification summary.',
    'If the goal cannot progress without missing user input or external dependencies, call UpdateGoalStatus with status: "blocked" and explain what is missing.',
    'To record an intermediate verification, call UpdateGoalStatus with status: "active" and a short progress summary.',
    "</goal_mode>",
  ].join("\n");
}

export interface BuildT3SystemSectionsInput {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly pullRequestLinking?: boolean | undefined;
  readonly runtimePolicy?: Pick<ProviderAdapterV2RuntimePolicy, "cwd" | "workspace"> | undefined;
  readonly hasT3Mcp?: boolean | undefined;
  readonly hasDeviceTools?: boolean | undefined;
  /** Skill names and descriptions available to this thread, as one rendered block. */
  readonly skillSummary?: string | undefined;
  /** Per-section skill catalog; `skill:<id>` keys append as the catalog changes. */
  readonly skillSections?: Readonly<Record<string, string | null>> | undefined;
  readonly toolActivation?: string | undefined;
  readonly context?: string | undefined;
  readonly contextBudget?: string | undefined;
  readonly planMode?: boolean | undefined;
  readonly goal?: OrchestrationV2ProviderGoal | null | undefined;
  readonly workflowDirective?: string | undefined;
}

/** Assembles the managed sections in canonical order; empty sections are dropped. */
export function buildT3SystemSections(input: BuildT3SystemSectionsInput): SystemSectionMap {
  const runtime = [
    buildRuntimeInstructions({
      harness: input.harness,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.modelName === undefined ? {} : { modelName: input.modelName }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      ...(input.pullRequestLinking === undefined
        ? {}
        : { pullRequestLinking: input.pullRequestLinking }),
      ...(input.runtimePolicy === undefined ? {} : { runtimePolicy: input.runtimePolicy }),
    }),
    t3OrchestrationSystemPrompt(input.hasT3Mcp === true, input.hasDeviceTools === true),
  ]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("\n\n");
  const toolActivation = [
    input.toolActivation,
    input.goal?.status === "active" ? goalModeSection(input.goal) : undefined,
    input.workflowDirective === undefined ? undefined : input.workflowDirective.trim(),
    input.planMode === true ? PLAN_MODE_SECTION : undefined,
  ]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("\n\n");
  return {
    runtime,
    ...(input.skillSummary === undefined || input.skillSummary === ""
      ? {}
      : { skills: input.skillSummary }),
    ...input.skillSections,
    ...(toolActivation === "" ? {} : { tool_activation: toolActivation }),
    ...(input.context === undefined || input.context === "" ? {} : { context: input.context }),
    ...(input.contextBudget === undefined || input.contextBudget === ""
      ? {}
      : { context_budget: input.contextBudget }),
  };
}
