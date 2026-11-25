import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { obj, str } from "@earendil-works/pi-schema";

import { restoredToolActivation } from "./fixedToolDeclarations.ts";

export const TOOL_SEARCH_NAME = "ToolSearch";
export const ON_DEMAND_TOOLS_SECTION = "on_demand_tools";

/** Declared on every request; a capability the model must go looking for is one it skips. */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "Task",
  "TaskWait",
  "TaskList",
  "TaskStop",
  "Skill",
]);

const MAX_ACTIVATIONS_PER_SEARCH = 4;
const MAX_CATALOG_ENTRIES = 40;
const MAX_DESCRIPTION_CHARS = 120;

const SEARCH_PARAMS = obj({
  query: str({
    description:
      "Exact tool name or a short capability description, for example `TodoWrite` or `list threads`.",
  }),
});

const SEARCH_DESCRIPTION = `Find and activate an on-demand tool by exact name or capability. Call this before using a tool listed under ${ON_DEMAND_TOOLS_SECTION}, even when its schema is already visible. Activation never bypasses approval or mode restrictions.`;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const compact = (description: string): string => {
  const text = description.replaceAll(/\s+/gu, " ").trim();
  return text.length <= MAX_DESCRIPTION_CHARS
    ? text
    : `${text.slice(0, MAX_DESCRIPTION_CHARS - 3)}...`;
};

const toolNameList = (value: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(value)) return [];
  const names = value.filter((name): name is string => typeof name === "string" && name.length > 0);
  return [...new Set(names)];
};

/** Reads the canonical activation field, then the historical one. */
const activationNames = (details: unknown): ReadonlyArray<string> => {
  const record = asRecord(details);
  return toolNameList(record?.addedToolNames ?? record?.activated);
};

export interface DeferredToolSearchDetails {
  readonly query: string;
  readonly matches: ReadonlyArray<string>;
  readonly addedToolNames: ReadonlyArray<string>;
}

export interface DeferredToolRegistryOptions {
  /** Finds tools on the T3 MCP server; the bridge then lists them for the next request. */
  readonly searchRemoteTools?: ((query: string) => Promise<ReadonlyArray<string>>) | undefined;
}

export class DeferredToolRegistry {
  readonly #searchRemoteTools: ((query: string) => Promise<ReadonlyArray<string>>) | undefined;
  #tools: ReadonlyArray<AgentTool<any>> = [];
  #deferred = new Map<string, AgentTool<any>>();
  #active = new Set<string>();
  #activeList: AgentTool<any>[] = [];
  readonly #searchTool: AgentTool<any, DeferredToolSearchDetails>;

  constructor(options: DeferredToolRegistryOptions = {}) {
    this.#searchRemoteTools = options.searchRemoteTools;
    this.#searchTool = {
      name: TOOL_SEARCH_NAME,
      label: "Tool Search",
      description: SEARCH_DESCRIPTION,
      parameters: SEARCH_PARAMS,
      executionMode: "sequential",
      execute: async (_toolCallId, params) => {
        const query = typeof params?.query === "string" ? params.query.trim() : "";
        const local = this.#matchDeferred(query);
        const remote =
          this.#searchRemoteTools === undefined || query === ""
            ? []
            : await this.#searchRemoteTools(query);
        const matches = [...new Set([...local, ...remote])];
        const added = this.activate(matches);
        const available = [...this.#deferred.keys()].sort();
        const preview = available.slice(0, MAX_CATALOG_ENTRIES);
        const remaining = available.length - preview.length;
        const text =
          added.length > 0
            ? `Activated on-demand tools: ${added.join(", ")}. They are callable on your next step.`
            : matches.length > 0
              ? `These tools are already active: ${matches.join(", ")}.`
              : `No matching on-demand tool. Available names: ${preview.join(", ")}${
                  remaining > 0 ? `, and ${remaining} more` : ""
                }.`;
        const content: TextContent[] = [{ type: "text", text }];
        return {
          content,
          details: { query, matches, addedToolNames: added },
        };
      },
    };
  }

  /** Re-partitions the registered tools; activation survives while its name stays deferred. */
  setTools(tools: ReadonlyArray<AgentTool<any>>): void {
    this.#tools = tools.filter((tool) => tool.name !== TOOL_SEARCH_NAME);
    this.#deferred = new Map(
      this.#tools
        .filter((tool) => !CORE_TOOL_NAMES.has(tool.name))
        .map((tool) => [tool.name, tool]),
    );
    for (const name of this.#active) {
      if (!this.#deferred.has(name)) this.#active.delete(name);
    }
    this.#rebuildActiveList();
  }

  get deferredNames(): ReadonlySet<string> {
    return new Set(this.#deferred.keys());
  }

  get activeNames(): ReadonlyArray<string> {
    return [...this.#active].sort();
  }

  isDeferred(name: string): boolean {
    return this.#deferred.has(name);
  }

  isActive(name: string): boolean {
    return this.#active.has(name);
  }

  /** Activates the requested deferred names and returns the ones that were not active yet. */
  activate(names: ReadonlyArray<string>): ReadonlyArray<string> {
    const activated: string[] = [];
    for (const name of names) {
      if (!this.#deferred.has(name) || this.#active.has(name)) continue;
      this.#active.add(name);
      activated.push(name);
    }
    if (activated.length > 0) this.#rebuildActiveList();
    return activated;
  }

  /** Clears activated deferred tools (used on rollback or transcript replacement). */
  resetActivation(): void {
    if (this.#active.size === 0) return;
    this.#active.clear();
    this.#rebuildActiveList();
  }

  /** Every registered tool plus `ToolSearch`, for routes that declare the catalog up front. */
  allDeclarations(): AgentTool<any>[] {
    return [...this.#tools, this.#searchTool];
  }

  /** Core tools, the activated deferred tools, and `ToolSearch` when anything is deferred. */
  activeTools(): AgentTool<any>[] {
    return this.#activeList;
  }

  /** The bounded `# On-demand tools` catalog; empty when every tool is core. */
  catalogSection(): string {
    if (this.#deferred.size === 0) return "";
    const names = [...this.#deferred.keys()].sort();
    const visible = names.slice(0, MAX_CATALOG_ENTRIES);
    const lines = visible.map((name) => {
      const description = this.#deferred.get(name)?.description ?? "";
      return `- ${name}: ${compact(description)}`;
    });
    if (names.length > visible.length) {
      lines.push(`- ... ${names.length - visible.length} more; search by exact name or capability`);
    }
    return [
      "# On-demand tools",
      `These capabilities are not declared until you load them. Call ${TOOL_SEARCH_NAME} with an exact tool name or a short capability description before using one; activation never bypasses approval or mode restrictions.`,
      ...lines,
    ].join("\n");
  }

  /**
   * Restores activation from the transcript. Only successful `ToolSearch` results after the
   * latest system record count, so a removed tool cannot be resurrected by old history.
   */
  restore(messages: ReadonlyArray<AgentMessage>, fixedDeclarationKey?: string): void {
    if (this.#deferred.size === 0) return;
    if (fixedDeclarationKey !== undefined) {
      const restored = restoredToolActivation(messages, fixedDeclarationKey);
      if (restored === undefined) return;
      this.activate(restored.active);
      this.#replaySearchResults(messages.slice(restored.replayFrom));
      return;
    }
    const lastSystem = messages.map((message) => message.role).lastIndexOf("system");
    this.#replaySearchResults(messages.slice(lastSystem + 1));
  }

  #replaySearchResults(messages: ReadonlyArray<AgentMessage>): void {
    for (const message of messages) {
      if (message.role !== "toolResult") continue;
      if (message.toolName !== TOOL_SEARCH_NAME || message.isError === true) continue;
      const details = asRecord(message.details);
      this.activate(activationNames(details ?? message));
    }
  }

  #rebuildActiveList(): void {
    const tools: AgentTool<any>[] = [];
    for (const tool of this.#tools) {
      if (CORE_TOOL_NAMES.has(tool.name) || this.#active.has(tool.name)) tools.push(tool);
    }
    if (this.#deferred.size > 0) tools.push(this.#searchTool);
    this.#activeList = tools;
  }

  #matchDeferred(query: string): ReadonlyArray<string> {
    const normalized = query.trim().toLowerCase();
    if (normalized === "") return [];
    const terms = normalized.split(/[\s,;|/]+/u).filter(Boolean);
    return [...this.#deferred.entries()]
      .map(([name, tool]) => {
        const normalizedName = name.toLowerCase();
        const description = tool.description.toLowerCase();
        let score = 0;
        if (normalizedName === normalized) score += 10_000;
        else if (normalizedName.includes(normalized)) score += 2_000;
        for (const term of terms) {
          if (normalizedName.includes(term)) score += 300;
          if (description.includes(term)) score += 25;
        }
        return { name, score };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) =>
        right.score !== left.score ? right.score - left.score : left.name < right.name ? -1 : 1,
      )
      .slice(0, MAX_ACTIVATIONS_PER_SEARCH)
      .map((candidate) => candidate.name);
  }
}
