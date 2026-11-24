/**
 * Shared vocabulary for Pi Native's model configuration surface.
 *
 * This module is deliberately free of I/O and Node built-ins: the web settings
 * form, the server catalog and the tests all import it, so the wire styles,
 * capability filters, binding helpers and formatting rules cannot drift apart.
 */

import * as Schema from "effect/Schema";

/** Wire protocols a Pi Native endpoint can speak. */
export const PI_NATIVE_API_STYLES = [
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "openai-completions", label: "OpenAI Chat Completions" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-generative-ai", label: "Google Gemini" },
  { value: "opencode-go", label: "OpenCode Go" },
] as const;

export const PiNativeApiStyle = Schema.Literals(PI_NATIVE_API_STYLES.map((style) => style.value));
export type PiNativeApiStyle = typeof PiNativeApiStyle.Type;

/**
 * How a model-list probe asks a service what it serves.
 *
 * A successful `GET {base}/models` with a Bearer token proves the endpoint
 * answers OpenAI-compatible discovery and nothing about the generation route.
 */
export const DiscoveryStyle = Schema.Literals([
  "openai_models",
  "anthropic_models",
  "google_models",
]);
export type DiscoveryStyle = typeof DiscoveryStyle.Type;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const ThinkingLevel = Schema.Literals(THINKING_LEVELS);
export type ThinkingLevel = typeof ThinkingLevel.Type;

/** A session may additionally defer to the provider's own default ("omit"). */
const SESSION_THINKING_LEVELS = [...THINKING_LEVELS, "omit"] as const;

export const SessionThinkingLevel = Schema.Literals(SESSION_THINKING_LEVELS);
export type SessionThinkingLevel = typeof SessionThinkingLevel.Type;

/** How an Anthropic-compatible endpoint expects effort to be expressed. */
export const ThinkingProtocol = Schema.Literals(["legacy", "adaptive"]);
export type ThinkingProtocol = typeof ThinkingProtocol.Type;

/** Who owns a saved limit: the catalog record or the user's own number. */
export const ModelLimitSource = Schema.Literals(["catalog", "user"]);
export type ModelLimitSource = typeof ModelLimitSource.Type;

/** One published capability a catalog row can be checked against. */
export const ModelFilter = Schema.Literals(["reasoning", "vision", "tools", "attachments", "pdf"]);
export type ModelFilter = typeof ModelFilter.Type;

export type ModelInputModality = "text" | "image" | "pdf" | "audio" | "video";

/** Published metadata for one model, before a user binds it. */
export interface PiNativeModelInfo {
  readonly modelId: string;
  readonly displayName: string;
  readonly vendorKey?: string | undefined;
  readonly description?: string | undefined;
  readonly family?: string | undefined;
  readonly reasoning: boolean;
  readonly toolCall: boolean;
  readonly attachment: boolean;
  readonly inputModalities: readonly ModelInputModality[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly supportedThinkingLevels?: readonly ThinkingLevel[] | undefined;
  readonly thinkingProtocol?: ThinkingProtocol | undefined;
  readonly reasoningOptions?: readonly { readonly type: string }[] | undefined;
  readonly defaultTemperature?: number | undefined;
  readonly catalogSource?: "models.dev" | "pi-ai" | "discovered" | undefined;
}

/** One model a user has bound to this provider instance. */
export interface PiNativeModelBinding {
  readonly id: string;
  readonly displayName?: string | undefined;
  readonly alias?: string | undefined;
  readonly contextWindow: number;
  readonly contextWindowSource?: ModelLimitSource | undefined;
  readonly maxTokens: number;
  readonly maxTokensSource?: ModelLimitSource | undefined;
  readonly thinkingLevels: readonly ThinkingLevel[];
  readonly defaultThinkingLevel: SessionThinkingLevel | null;
  readonly thinkingProtocol?: ThinkingProtocol | undefined;
  readonly supportsReasoningEffort?: boolean | null | undefined;
  readonly supportsImages?: boolean | null | undefined;
  readonly supportsDocuments?: boolean | null | undefined;
  readonly availableForSubagents?: boolean | undefined;
}

export const CATALOG_DEFAULT_CONTEXT_WINDOW = 128_000;
export const CATALOG_DEFAULT_MAX_TOKENS = 8_192;

export const CONTEXT_WINDOW_PRESETS = [
  32_768, 65_536, 128_000, 200_000, 256_000, 400_000, 1_000_000,
] as const;

export const MAX_OUTPUT_PRESETS = [4_096, 8_192, 16_384, 32_768, 65_536, 128_000] as const;

const trimFraction = (value: string): string =>
  value.includes(".") ? value.replace(/0+$/u, "").replace(/\.$/u, "") : value;

/**
 * Compact token count for dense UI: `128k`, `8.2k`, `1M`, or `-` when unset.
 */
export function formatTokenCount(tokens?: number | null): string {
  if (tokens === undefined || tokens === null || !Number.isFinite(tokens) || tokens <= 0) {
    return "-";
  }
  if (tokens < 1_000) return String(Math.round(tokens));
  const thousands = tokens / 1_000;
  // Rounding can push a `k` mantissa to 1000 (999,999 -> `1000k`); promote it.
  if (thousands < 1_000) return `${trimFraction(thousands.toFixed(1))}k`;
  return `${trimFraction((tokens / 1_000_000).toFixed(2))}M`;
}

const THINKING_ORDER: readonly ThinkingLevel[] = THINKING_LEVELS;

/** Sort thinking levels into canonical ascending order, dropping duplicates. */
export function sortThinkingLevels(levels: readonly ThinkingLevel[]): ThinkingLevel[] {
  return [...new Set(levels)].sort(
    (left, right) => THINKING_ORDER.indexOf(left) - THINKING_ORDER.indexOf(right),
  );
}

/**
 * Thinking choices a binding's default selector offers: its configured levels
 * in canonical order, followed by `omit` ("provider default") when any exist.
 */
export function bindingDefaultThinkingMenuLevels(
  enabledLevels: readonly ThinkingLevel[],
): SessionThinkingLevel[] {
  const sorted = sortThinkingLevels(enabledLevels);
  return sorted.length === 0 ? [] : [...sorted, "omit"];
}

/**
 * Resolve a binding's default thinking level against its enabled ladder.
 *
 * `omit` stays a deliberate "provider default" choice; a concrete level that the
 * binding no longer enables falls back to `medium`, then the first enabled level.
 */
export function resolveBindingDefaultThinkingLevel(
  current: SessionThinkingLevel | null,
  enabledLevels: readonly ThinkingLevel[],
): SessionThinkingLevel | null {
  const sorted = sortThinkingLevels(enabledLevels);
  if (current === "omit") return "omit";
  if (current !== null && sorted.includes(current)) return current;
  if (sorted.length === 0) return null;
  return sorted.includes("medium") ? "medium" : (sorted[0] ?? null);
}

const positiveTokenCount = (value?: number | null): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value);
};

/**
 * Resolve a model's effective context window from its catalog baseline.
 *
 * A `catalog` binding follows the published record, so a corrected window reaches
 * a binding saved before the fix; a `user` binding is the user's own number and is
 * never replaced. A binding without provenance keeps its stored value.
 */
export function effectiveContextWindow(
  publishedContextWindow?: number | null,
  configuredContextWindow?: number | null,
  source?: ModelLimitSource | null,
): number | undefined {
  const published = positiveTokenCount(publishedContextWindow);
  const configured = positiveTokenCount(configuredContextWindow);

  if (source === "catalog") return published ?? configured;
  if (source === "user") return configured ?? published;
  if (configured === undefined) return published;
  return configured;
}

/** Resolve a model's effective output cap; provenance is independent per limit. */
export function effectiveMaxTokens(
  publishedMaxTokens?: number | null,
  configuredMaxTokens?: number | null,
  source?: ModelLimitSource | null,
): number | undefined {
  const published = positiveTokenCount(publishedMaxTokens);
  const configured = positiveTokenCount(configuredMaxTokens);

  if (source === "catalog") return published ?? configured;
  if (source === "user") return configured ?? published;
  if (configured === undefined) return published;
  return configured;
}

export interface ModelLimitCatalogConfig {
  readonly contextWindow?: number | null;
  readonly maxTokens?: number | null;
  /** `generic` marks a lookup that found no real record; it never replaces a save. */
  readonly source?: "catalog" | "user" | "generic" | string | null;
}

type BindingLimits = Pick<
  PiNativeModelBinding,
  "contextWindow" | "maxTokens" | "contextWindowSource" | "maxTokensSource"
>;

/**
 * Resolve a saved binding's limits against its catalog baseline.
 * Context-window and output-cap provenance remain independent.
 */
export function resolveBindingLimits<C extends ModelLimitCatalogConfig, B extends BindingLimits>(
  catalogConfig: C,
  binding: B,
): { readonly catalogConfig: C; readonly binding: B } {
  const publishedRecord = catalogConfig.source !== "generic";
  const published = publishedRecord ? positiveTokenCount(catalogConfig.contextWindow) : undefined;
  const publishedMax = publishedRecord ? positiveTokenCount(catalogConfig.maxTokens) : undefined;

  const contextWindowSource = binding.contextWindowSource ?? "user";
  const maxTokensSource = binding.maxTokensSource ?? "user";
  const resolvedContext = effectiveContextWindow(
    published,
    binding.contextWindow,
    contextWindowSource,
  );
  const resolvedMax = effectiveMaxTokens(publishedMax, binding.maxTokens, maxTokensSource);

  if (resolvedContext === undefined && resolvedMax === undefined) {
    return { catalogConfig, binding };
  }
  return {
    catalogConfig: {
      ...catalogConfig,
      ...(resolvedContext === undefined ? {} : { contextWindow: resolvedContext }),
      ...(resolvedMax === undefined ? {} : { maxTokens: resolvedMax }),
    },
    binding: {
      ...binding,
      ...(resolvedContext === undefined
        ? {}
        : { contextWindow: resolvedContext, contextWindowSource }),
      ...(resolvedMax === undefined ? {} : { maxTokens: resolvedMax, maxTokensSource }),
    },
  };
}

/** Whether a published record satisfies a capability filter. */
export function modelMatchesFilter(model: PiNativeModelInfo, filter: ModelFilter): boolean {
  switch (filter) {
    case "reasoning":
      return model.reasoning || (model.supportedThinkingLevels?.length ?? 0) > 0;
    case "vision":
      return model.inputModalities.includes("image");
    case "tools":
      return model.toolCall;
    case "attachments":
      return model.attachment;
    case "pdf":
      return model.inputModalities.includes("pdf");
  }
}

/** Effective image input for a binding: the user override, else the published flag. */
export function bindingSupportsImages(
  binding?: Pick<PiNativeModelBinding, "supportsImages"> | null,
  info?: PiNativeModelInfo | null,
): boolean {
  if (typeof binding?.supportsImages === "boolean") return binding.supportsImages;
  return info ? modelMatchesFilter(info, "vision") : false;
}

/** Effective document (PDF) input for a binding: the user override, else the catalog. */
export function bindingSupportsDocuments(
  binding?: Pick<PiNativeModelBinding, "supportsDocuments"> | null,
  info?: PiNativeModelInfo | null,
): boolean {
  if (typeof binding?.supportsDocuments === "boolean") return binding.supportsDocuments;
  return info ? modelMatchesFilter(info, "pdf") : false;
}

const publishedThinkingLevels = (info: PiNativeModelInfo): ThinkingLevel[] => {
  if (info.supportedThinkingLevels !== undefined) {
    return info.supportedThinkingLevels.filter((level) => level !== "off");
  }
  if (!info.reasoning) return [];
  const options = info.reasoningOptions ?? [];
  if (options.length === 0) return [];
  const ladder = options.find((option) => option.type === "effort");
  if (ladder === undefined) return [];
  return ["low", "medium", "high"];
};

const defaultThinkingLevelFor = (levels: readonly ThinkingLevel[]): SessionThinkingLevel | null => {
  if (levels.length === 0) return null;
  return levels.includes("medium") ? "medium" : (levels[0] ?? null);
};

/**
 * Build the persisted binding for a published record. Published limits and
 * thinking levels seed a fresh binding, so a newly picked model needs no manual
 * token entry; a `catalog` marker lets a later correction still reach it.
 */
export function bindingFromModelInfo(info: PiNativeModelInfo): PiNativeModelBinding {
  const thinkingLevels = sortThinkingLevels(publishedThinkingLevels(info));
  return {
    id: info.modelId.trim(),
    ...(info.displayName.trim() === "" ? {} : { displayName: info.displayName.trim() }),
    contextWindow: info.contextWindow || CATALOG_DEFAULT_CONTEXT_WINDOW,
    contextWindowSource: "catalog",
    maxTokens: info.maxTokens || CATALOG_DEFAULT_MAX_TOKENS,
    maxTokensSource: "catalog",
    thinkingLevels,
    defaultThinkingLevel: defaultThinkingLevelFor(thinkingLevels),
    ...(info.thinkingProtocol === undefined ? {} : { thinkingProtocol: info.thinkingProtocol }),
    // Absent overrides keep following the catalog, so corrections still reach
    // an already saved binding.
    supportsImages: null,
    supportsDocuments: null,
  };
}

/**
 * Binding for a hand-typed id the catalog does publish. The stored id stays what
 * the user typed: a catalog spelling that differs in case must not retarget it.
 */
export function bindingForCustomModel(
  id: string,
  enriched?: PiNativeModelInfo,
): PiNativeModelBinding {
  if (enriched !== undefined) return { ...bindingFromModelInfo(enriched), id: id.trim() };
  return {
    id: id.trim(),
    // An unpublished model seeds from the generic values but keeps them
    // catalog-sourced, so a record appearing later can still take over.
    contextWindow: CATALOG_DEFAULT_CONTEXT_WINDOW,
    contextWindowSource: "catalog",
    maxTokens: CATALOG_DEFAULT_MAX_TOKENS,
    maxTokensSource: "catalog",
    thinkingLevels: [],
    defaultThinkingLevel: null,
    supportsImages: null,
    supportsDocuments: null,
  };
}

const CODING_HINT =
  /(opus|sonnet|claude|gpt-5|gpt-4|codex|o[34]|gemini-[^ ]*pro|deepseek|kimi|qwen|glm|grok|mistral-large|codestral|llama-[^ ]*instruct)/iu;
const FAST_HINT = /(haiku|mini|flash|lite|instant|small|air|turbo|nano)/iu;
const NON_CHAT_HINT = /(embed|rerank|whisper|tts|moderation|image|vision-only|guard)/iu;

const recommendationScore = (info: PiNativeModelInfo): number => {
  let score = 0;
  if (info.toolCall) score += 40;
  else score -= 40;
  if (info.reasoning) score += 20;
  if (info.attachment) score += 5;
  score += Math.min(30, Math.log2(Math.max(1, info.contextWindow / 8_192)) * 4);
  if (CODING_HINT.test(`${info.modelId} ${info.displayName}`)) score += 15;
  if (NON_CHAT_HINT.test(info.modelId)) score -= 100;
  return score;
};

/**
 * Pick 1-3 strong representative models for a newly added service: a flagship
 * coding model, a fast sibling when the catalog publishes one, and a third
 * distinct strong row. Discovery order only breaks ties, so the result is stable.
 */
export function recommendModelsForService(
  models: readonly PiNativeModelInfo[],
  vendorKey?: string,
): PiNativeModelBinding[] {
  const pool = models.filter(
    (model) =>
      (vendorKey === undefined || model.vendorKey === undefined || model.vendorKey === vendorKey) &&
      !NON_CHAT_HINT.test(model.modelId),
  );
  const candidates = pool.length > 0 ? pool : models;
  const ranked = candidates
    .map((model, index) => ({ model, index, score: recommendationScore(model) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const chosen: PiNativeModelInfo[] = [];
  const take = (candidate: PiNativeModelInfo | undefined): void => {
    if (candidate === undefined) return;
    if (chosen.some((existing) => existing.modelId === candidate.modelId)) return;
    chosen.push(candidate);
  };

  take(ranked[0]?.model);
  take(ranked.find((entry) => FAST_HINT.test(entry.model.modelId))?.model);
  take(ranked[1]?.model);
  if (chosen.length === 0) take(ranked[0]?.model);

  return chosen.slice(0, 3).map((model) => bindingFromModelInfo(model));
}

/** Headers the transport owns; a user-supplied value must never override them. */
export const RESERVED_PROVIDER_HEADERS = [
  "authorization",
  "proxy-authorization",
  "host",
  "content-type",
  "content-length",
  "cookie",
  "set-cookie",
  "connection",
  "x-api-key",
  "api-key",
  "chatgpt-account-id",
  "x-goog-api-key",
] as const;

const RESERVED_PROVIDER_HEADER_SET: ReadonlySet<string> = new Set(RESERVED_PROVIDER_HEADERS);

/**
 * Keep only user headers the transport can safely forward: trimmed names and
 * values, no line breaks (header injection), and nothing that would redefine
 * authentication, framing or routing.
 */
export function sanitizeProviderHeaders(headers?: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  if (headers === undefined) return result;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim();
    if (
      name === "" ||
      name.includes("\r") ||
      name.includes("\n") ||
      RESERVED_PROVIDER_HEADER_SET.has(name.toLowerCase())
    ) {
      continue;
    }
    if (typeof rawValue !== "string") continue;
    const value = rawValue.trim();
    if (value.includes("\r") || value.includes("\n")) continue;
    result[name] = value;
  }
  return result;
}

/** One trimmed model row in the bundled models.dev snapshot. */
export interface PiNativeBundledModel {
  readonly id: string;
  readonly name: string;
  readonly family?: string | undefined;
  readonly reasoning: boolean;
  readonly tool_call: boolean;
  readonly attachment: boolean;
  readonly modalities?:
    | { readonly input?: readonly string[]; readonly output?: readonly string[] }
    | undefined;
  readonly limit?: { readonly context?: number; readonly output?: number } | undefined;
  readonly interleaved?: boolean | undefined;
}

export interface PiNativeBundledVendor {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly models: Readonly<Record<string, PiNativeBundledModel>>;
}

/** The lean offline models.dev snapshot bundled with the provider. */
export type PiNativeBundledModelsDev = Readonly<Record<string, PiNativeBundledVendor>>;
