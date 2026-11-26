import type { ThreadContextBreakdown, ThreadContextBreakdownItem } from "@t3tools/contracts";
import {
  CONTEXT_CATEGORY_ORDER,
  filterAndSortContextItems,
  type ContextAssistantKind,
  type ContextItemSort,
} from "@t3tools/client-runtime/state/context-breakdown";
import { msg, useGT, useMessages } from "gt-react";
import { CheckIcon, ChevronDownIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import type { MessageResolver } from "~/i18n/messages";
import { Input } from "~/components/ui/input";
import { CONTEXT_CATEGORY_STYLES } from "./contextColors";
import { contextCategoryPercent, formatContextPercent } from "./contextFormat";

type Category = (typeof CONTEXT_CATEGORY_ORDER)[number];
type View = "grouped" | "order";

const CATEGORY_LABELS = {
  system: msg("System Prompt"),
  mcp: msg("MCP"),
  tools: msg("Tools"),
  skills: msg("Skills"),
  user: msg("User"),
  assistant: msg("Assistant"),
  tool_results: msg("Tool Results"),
  provider_overhead: msg("Provider Overhead"),
} as const;

type Message = Parameters<MessageResolver>[0];

const ASSISTANT_FILTERS: ReadonlyArray<{
  readonly value: ContextAssistantKind;
  readonly label: Message;
}> = [
  { value: "all", label: msg("All") },
  { value: "answer", label: msg("Answer") },
  { value: "reasoning", label: msg("Thinking") },
  { value: "tool_call", label: msg("Tool Calls") },
];

const SORTS: ReadonlyArray<{
  readonly value: ContextItemSort;
  readonly label: Message;
}> = [
  { value: "size", label: msg("Size ↓") },
  { value: "order", label: msg("Order") },
  { value: "name", label: msg("Name") },
];

/** Searchable, sortable item list with grouped and prompt-order views. */
export function ContextInspectorCard({
  breakdown,
  focusedCategory,
  onClearCategory,
}: {
  readonly breakdown: ThreadContextBreakdown;
  readonly focusedCategory: Category | null;
  readonly onClearCategory: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<ContextItemSort>("size");
  const [assistantKind, setAssistantKind] = useState<ContextAssistantKind>("all");
  const [view, setView] = useState<View>("grouped");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const copy = (item: ThreadContextBreakdownItem) => {
    void navigator.clipboard.writeText(item.preview ?? item.label).then(() => {
      setCopiedId(item.id);
      setTimeout(() => setCopiedId(null), 1_200);
    });
  };
  const filtered = filterAndSortContextItems(breakdown.items, {
    query,
    sortBy,
    assistantKind: view === "grouped" ? assistantKind : "all",
    category: focusedCategory,
  });
  const ordered = [...filtered].sort((left, right) => right.orderIndex - left.orderIndex);

  return (
    <section className="rounded-lg border border-border/60 bg-card/40">
      <div className="flex flex-wrap items-center gap-2 px-3 pt-3">
        <h3 className="font-medium text-sm">{gt("Items")}</h3>
        <div className="min-w-40 flex-1">
          <Input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={gt("Filter system, MCP, tools, skills, messages…")}
            aria-label={gt("Filter context items")}
          />
        </div>
        <div className="flex items-center gap-0.5 rounded-md border border-border/60 p-0.5">
          {SORTS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={sortBy === option.value}
              onClick={() => setSortBy(option.value)}
              className={cn(
                "cursor-pointer rounded-sm px-1.5 py-0.5 text-2xs",
                sortBy === option.value
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {messages(option.label)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5 rounded-md border border-border/60 p-0.5">
          {(["grouped", "order"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              onClick={() => setView(option)}
              className={cn(
                "cursor-pointer rounded-sm px-1.5 py-0.5 text-2xs",
                view === option
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option === "grouped" ? gt("Grouped") : gt("Prompt Order")}
            </button>
          ))}
        </div>
      </div>

      {focusedCategory !== null ? (
        <div className="px-3 pt-2">
          <button
            type="button"
            onClick={onClearCategory}
            className="cursor-pointer rounded-full bg-muted px-2 py-0.5 text-2xs text-muted-foreground hover:text-foreground"
          >
            {gt("Showing only {category} · clear", {
              category: messages(CATEGORY_LABELS[focusedCategory]),
            })}
          </button>
        </div>
      ) : null}

      {view === "grouped" ? (
        <div className="flex flex-col px-1.5 pt-2 pb-1.5">
          {CONTEXT_CATEGORY_ORDER.flatMap((category) => {
            const items = filtered.filter((item) => item.category === category);
            if (items.length === 0) return [];
            const summary = breakdown.categories.find((entry) => entry.category === category);
            const isSearching = query.trim() !== "";
            const open =
              isSearching || focusedCategory === category || expanded.has(`group:${category}`);
            return [
              <div key={category}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => {
                    if (focusedCategory === category) onClearCategory();
                    else toggleExpanded(`group:${category}`);
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-left"
                >
                  <ChevronDownIcon
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground transition-transform",
                      !open && "-rotate-90",
                    )}
                  />
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      CONTEXT_CATEGORY_STYLES[category].fillClassName,
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {messages(CATEGORY_LABELS[category])}
                  </span>
                  <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                    {items.length} · {formatContextWindowTokens(summary?.calibratedTokens ?? 0)}
                  </span>
                  <span className="w-8 shrink-0 text-right text-2xs text-muted-foreground tabular-nums">
                    {formatContextPercent(
                      summary === undefined
                        ? null
                        : contextCategoryPercent(summary.calibratedTokens, breakdown),
                    )}
                  </span>
                  {summary?.deltaTokens !== undefined && summary.deltaTokens !== 0 ? (
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-1 text-3xs tabular-nums",
                        summary.deltaTokens > 0
                          ? cn(
                              CONTEXT_CATEGORY_STYLES.tool_results.surfaceClassName,
                              CONTEXT_CATEGORY_STYLES.tool_results.textClassName,
                            )
                          : cn(
                              CONTEXT_CATEGORY_STYLES.skills.surfaceClassName,
                              CONTEXT_CATEGORY_STYLES.skills.textClassName,
                            ),
                      )}
                    >
                      {summary.deltaTokens > 0 ? "+" : "-"}
                      {formatContextWindowTokens(Math.abs(summary.deltaTokens))}
                    </span>
                  ) : null}
                </button>
                {open ? (
                  <>
                    {category === "assistant" ? (
                      <div className="flex flex-wrap gap-1 px-7 py-1">
                        {ASSISTANT_FILTERS.map((filter) => (
                          <button
                            key={filter.value}
                            type="button"
                            aria-pressed={assistantKind === filter.value}
                            onClick={() => setAssistantKind(filter.value)}
                            className={cn(
                              "cursor-pointer rounded-full border border-border/60 px-1.5 py-0.5 text-3xs",
                              assistantKind === filter.value
                                ? "bg-accent text-foreground"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            {messages(filter.label)}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <ul className="flex flex-col">
                      {items.map((item) => (
                        <InspectorRow
                          key={item.id}
                          item={item}
                          expanded={expanded.has(item.id)}
                          copied={copiedId === item.id}
                          onToggle={() => toggleExpanded(item.id)}
                          onCopy={() => copy(item)}
                        />
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>,
            ];
          })}
        </div>
      ) : (
        <ul className="flex flex-col px-1.5 pt-2 pb-1.5">
          {ordered.map((item, index) => (
            <InspectorRow
              key={item.id}
              item={item}
              position={ordered.length - index}
              expanded={expanded.has(item.id)}
              copied={copiedId === item.id}
              onToggle={() => toggleExpanded(item.id)}
              onCopy={() => copy(item)}
            />
          ))}
        </ul>
      )}

      {filtered.length === 0 ? (
        <p className="px-3 pb-3 text-muted-foreground text-xs">
          {gt("No items match this filter.")}
        </p>
      ) : null}
    </section>
  );
}

function itemBadge(item: ThreadContextBreakdownItem): Message | null {
  switch (item.kind) {
    case "mcp_schema":
      return msg("Schema");
    case "mcp_result":
      return msg("Result");
    case "skill_catalog":
      return msg("Catalog");
    case "skill_loaded":
      return msg("Loaded");
    case "provider_overhead":
      return msg("Built-in");
    default:
      return null;
  }
}

function InspectorRow({
  item,
  position,
  expanded,
  copied,
  onToggle,
  onCopy,
}: {
  readonly item: ThreadContextBreakdownItem;
  readonly position?: number;
  readonly expanded: boolean;
  readonly copied: boolean;
  readonly onToggle: () => void;
  readonly onCopy: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const style = CONTEXT_CATEGORY_STYLES[item.category];
  const badge = itemBadge(item);
  return (
    <li className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-left hover:bg-accent/50"
        >
          <span className={cn("h-5 w-0.5 shrink-0 rounded-full", style.fillClassName)} />
          {position !== undefined ? (
            <span className="w-8 shrink-0 text-3xs text-muted-foreground tabular-nums">
              #{position}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-xs">{item.label}</span>
          {item.turnIndex !== undefined ? (
            <span className="shrink-0 rounded-full bg-muted px-1 text-3xs text-muted-foreground">
              {gt("T{turn}", { turn: item.turnIndex + 1 })}
            </span>
          ) : null}
          {item.meta?.mcpServer !== undefined ? (
            <span className="shrink-0 rounded-full bg-muted px-1 text-3xs text-muted-foreground">
              mcp:{item.meta.mcpServer}
            </span>
          ) : null}
          {badge !== null ? (
            <span
              className={cn(
                "shrink-0 rounded-full px-1 text-3xs",
                style.surfaceClassName,
                style.textClassName,
              )}
            >
              {messages(badge)}
            </span>
          ) : null}
          <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
            {formatContextWindowTokens(item.calibratedTokens)}
          </span>
          <ChevronDownIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform",
              !expanded && "-rotate-90",
            )}
          />
        </button>
      </div>
      {expanded ? (
        <div className="relative mx-1.5 mb-1 rounded-sm border border-border/60 bg-muted/30">
          <pre className="max-h-48 overflow-auto p-2 pr-9 font-mono text-2xs break-words whitespace-pre-wrap">
            {item.preview ?? gt("No preview for this item.")}
          </pre>
          <button
            type="button"
            onClick={onCopy}
            aria-label={gt("Copy item content")}
            className="absolute top-1 right-1 cursor-pointer rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          </button>
          {item.previewTruncated ? (
            <p className="border-border/60 border-t px-2 py-1 text-3xs text-muted-foreground">
              {gt("Preview truncated to the first 4,000 characters.")}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
