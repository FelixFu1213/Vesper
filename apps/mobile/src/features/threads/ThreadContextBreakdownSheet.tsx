import type { EnvironmentId, ThreadContextCategory, ThreadId } from "@t3tools/contracts";
import {
  CONTEXT_CATEGORY_ORDER,
  computeStackedBarGeometry,
  formatCacheHitRate,
} from "@t3tools/client-runtime/state/context-breakdown";
import { msg, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Sheet } from "../../components/ui/Sheet";
import { threadEnvironment } from "../../state/threads";
import { useEnvironmentQuery } from "../../state/query";

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

const CATEGORY_DOT: Readonly<Record<ThreadContextCategory, string>> = {
  system: "bg-sky-500",
  mcp: "bg-violet-500",
  tools: "bg-amber-500",
  skills: "bg-emerald-500",
  user: "bg-blue-500",
  assistant: "bg-indigo-500",
  tool_results: "bg-orange-500",
  provider_overhead: "bg-zinc-400",
};

const formatTokens = (value: number | null): string => {
  if (value === null) return "-";
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 999_500) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
};

/** The thread's context composition on mobile, read only while the sheet is open. */
export function ThreadContextBreakdownSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const query = useEnvironmentQuery(
    threadEnvironment.contextBreakdown({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const [expanded, setExpanded] = useState<ThreadContextCategory | null>(null);
  const breakdown = query.data;
  const geometry = breakdown === null ? null : computeStackedBarGeometry(breakdown);
  const cacheHit =
    breakdown === null
      ? null
      : formatCacheHitRate(breakdown.usage.inputTokens, breakdown.usage.cachedInputTokens);

  return (
    <Sheet title={gt("Context breakdown")} onClose={props.onClose}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        {breakdown === null ? (
          <Text className="text-center text-muted-foreground text-sm">
            {query.error ?? gt("Measuring this thread's context…")}
          </Text>
        ) : (
          <>
            <View className="gap-1">
              <Text className="font-semibold text-base">
                {gt("{used} / {max}", {
                  used: formatTokens(breakdown.window.usedTokens),
                  max: formatTokens(breakdown.window.maxTokens),
                })}
              </Text>
              <Text className="text-muted-foreground text-xs">
                {gt("{percent} used · {remaining} remaining", {
                  percent:
                    breakdown.window.usedPercentage === null
                      ? "-"
                      : `${breakdown.window.usedPercentage.toFixed(0)}%`,
                  remaining: formatTokens(breakdown.window.remainingTokens),
                })}
              </Text>
            </View>

            {geometry === null ? null : (
              <View className="h-4 flex-row overflow-hidden rounded bg-muted">
                {geometry.segments.map((segment) => (
                  <View
                    key={segment.category}
                    style={{ width: `${segment.percent}%` }}
                    className={CATEGORY_DOT[segment.category]}
                  />
                ))}
                {geometry.reserveZone === null ? null : (
                  <View
                    className="absolute inset-y-0 border-border border-l bg-foreground/10"
                    style={{
                      left: `${geometry.reserveZone.leftPercent}%`,
                      width: `${geometry.reserveZone.widthPercent}%`,
                    }}
                  />
                )}
              </View>
            )}

            <View className="gap-1">
              {CONTEXT_CATEGORY_ORDER.flatMap((category) => {
                const summary = breakdown.categories.find((entry) => entry.category === category);
                if (summary === undefined || summary.calibratedTokens <= 0) return [];
                const open = expanded === category;
                const items = [...breakdown.items]
                  .filter((item) => item.category === category)
                  .sort((left, right) => right.calibratedTokens - left.calibratedTokens)
                  .slice(0, 4);
                return [
                  <View key={category} className="rounded-lg border border-border">
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ expanded: open }}
                      className="flex-row items-center gap-2 p-3"
                      onPress={() => setExpanded(open ? null : category)}
                    >
                      <View className={`size-2 rounded-full ${CATEGORY_DOT[category]}`} />
                      <Text className="flex-1 text-sm">{messages(CATEGORY_LABELS[category])}</Text>
                      <Text className="text-muted-foreground text-xs">
                        {formatTokens(summary.calibratedTokens)}
                      </Text>
                      <Text className="text-muted-foreground text-xs">
                        {breakdown.window.usedTokens <= 0
                          ? "0%"
                          : `${Math.round(
                              (summary.calibratedTokens / breakdown.window.usedTokens) * 100,
                            )}%`}
                      </Text>
                      <Text className="text-muted-foreground text-xs">{open ? "▾" : "▸"}</Text>
                    </Pressable>
                    {summary.deferredCount !== undefined && summary.deferredCount > 0 ? (
                      <Text className="px-3 pb-2 text-[11px] text-muted-foreground">
                        {gt("{count} deferred · {saved}k saved", {
                          count: summary.deferredCount,
                          saved: ((summary.deferredTokens ?? 0) / 1_000).toFixed(1),
                        })}
                      </Text>
                    ) : null}
                    {open ? (
                      <View className="gap-2 border-border border-t p-3">
                        {items.map((item) => (
                          <View key={item.id} className="gap-0.5">
                            <View className="flex-row items-baseline gap-2">
                              <Text className="flex-1 text-xs" numberOfLines={1}>
                                {item.label}
                              </Text>
                              <Text className="text-[11px] text-muted-foreground">
                                {formatTokens(item.calibratedTokens)}
                              </Text>
                            </View>
                            {item.preview === undefined ? null : (
                              <Text
                                className="font-mono text-[11px] text-muted-foreground"
                                numberOfLines={3}
                              >
                                {item.preview}
                              </Text>
                            )}
                          </View>
                        ))}
                      </View>
                    ) : null}
                  </View>,
                ];
              })}
            </View>

            <View className="flex-row gap-2 rounded-lg border border-border p-3">
              <Kpi label={gt("Cache hit")} value={cacheHit ?? "-"} />
              <Kpi label={gt("Turns")} value={String(breakdown.usage.turnCount)} />
              <Kpi label={gt("Compactions")} value={String(breakdown.usage.compactionCount)} />
              <Kpi label={gt("Tool calls")} value={String(breakdown.usage.toolUses)} />
            </View>

            <Text className="text-[11px] text-muted-foreground">
              {breakdown.fidelityNote ?? gt("Reconstructed from T3's prompt and history.")}
            </Text>
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}

function Kpi({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View className="flex-1 gap-0.5">
      <Text className="text-[10px] text-muted-foreground">{label}</Text>
      <Text className="font-medium text-xs">{value}</Text>
    </View>
  );
}
