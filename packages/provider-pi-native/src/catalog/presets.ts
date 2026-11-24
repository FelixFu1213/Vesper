/**
 * Static named provider presets and URL/wire-style resolution for Pi Native.
 * Endpoints decide protocol (never model id), and locked styles are never rewritten.
 */

import type { DiscoveryStyle, PiNativeApiStyle, ThinkingProtocol } from "./modelCatalog.ts";

const OPENCODE_GO_API_STYLE = "opencode-go" as const;
const OPENCODE_GO_NAME = "OpenCode Go";
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

/** A first-class service Pi Native can configure in one click. */
export interface PiNativeVendorPreset {
  readonly id: string;
  /** models.dev vendor key persisted as `vendorKey`. */
  readonly vendorKey: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiStyle: PiNativeApiStyle;
  /**
   * Model-list style this deployment documents, when it differs from the one
   * `apiStyle` implies. Only a documented statement belongs here.
   */
  readonly discoveryStyle?: DiscoveryStyle | undefined;
  readonly aliases?: readonly string[] | undefined;
  /** Brand accent used by the settings picker. */
  readonly accentColor: string;
  /** Completions thinking/tool-stream flags for Zhipu / Z.AI hosts. */
  readonly zhipuCompat?: boolean | undefined;
  /** DeepSeek-family reasoning replay flags. */
  readonly deepseekCompat?: boolean | undefined;
}

export const PI_NATIVE_VENDOR_PRESETS: readonly PiNativeVendorPreset[] = [
  {
    id: "openai",
    vendorKey: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiStyle: "openai-responses",
    accentColor: "#10A37F",
  },
  {
    id: "anthropic",
    vendorKey: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    apiStyle: "anthropic-messages",
    accentColor: "#D97757",
  },
  {
    id: "google",
    vendorKey: "google",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiStyle: "google-generative-ai",
    aliases: ["gemini"],
    accentColor: "#4285F4",
  },
  {
    id: "openrouter",
    vendorKey: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiStyle: "openai-completions",
    accentColor: "#6366F1",
  },
  {
    id: "groq",
    vendorKey: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiStyle: "openai-completions",
    accentColor: "#F55036",
  },
  {
    id: "xai",
    vendorKey: "xai",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    apiStyle: "openai-completions",
    accentColor: "#374151",
  },
  {
    id: "mistral",
    vendorKey: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    apiStyle: "openai-completions",
    accentColor: "#FF7000",
  },
  {
    id: "togetherai",
    vendorKey: "togetherai",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    apiStyle: "openai-completions",
    aliases: ["together"],
    accentColor: "#0F6FFF",
  },
  {
    id: "fireworks-ai",
    vendorKey: "fireworks-ai",
    name: "Fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiStyle: "openai-completions",
    aliases: ["fireworks"],
    accentColor: "#FF5C28",
  },
  {
    id: OPENCODE_GO_API_STYLE,
    vendorKey: "opencode-go",
    name: OPENCODE_GO_NAME,
    baseUrl: OPENCODE_GO_BASE_URL,
    apiStyle: OPENCODE_GO_API_STYLE,
    aliases: ["opencode-go-v1"],
    accentColor: "#7C3AED",
  },
  {
    id: "zai",
    vendorKey: "zai",
    name: "Z.AI",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiStyle: "openai-completions",
    zhipuCompat: true,
    accentColor: "#2563EB",
  },
  {
    id: "zai-coding-plan",
    vendorKey: "zai-coding-plan",
    name: "Z.AI Coding Plan",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    apiStyle: "openai-completions",
    zhipuCompat: true,
    accentColor: "#1D4ED8",
  },
  {
    id: "deepseek",
    vendorKey: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiStyle: "openai-completions",
    deepseekCompat: true,
    accentColor: "#4D6BFE",
  },
  {
    id: "alibaba-cn",
    vendorKey: "alibaba-cn",
    name: "Alibaba (China)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiStyle: "openai-completions",
    aliases: ["dashscope", "qwen"],
    accentColor: "#FF6A00",
  },
  {
    id: "moonshotai-cn",
    vendorKey: "moonshotai-cn",
    name: "Moonshot AI (China)",
    baseUrl: "https://api.moonshot.cn/v1",
    apiStyle: "openai-completions",
    aliases: ["moonshot"],
    accentColor: "#F59E0B",
  },
  {
    id: "zhipuai",
    vendorKey: "zhipuai",
    name: "Zhipu AI",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiStyle: "openai-completions",
    aliases: ["zhipu", "bigmodel"],
    zhipuCompat: true,
    accentColor: "#3B82F6",
  },
  {
    id: "zhipuai-coding-plan",
    vendorKey: "zhipuai-coding-plan",
    name: "Zhipu AI Coding Plan",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    apiStyle: "openai-completions",
    aliases: ["zai-coding-cn"],
    zhipuCompat: true,
    accentColor: "#0EA5E9",
  },
  {
    id: "siliconflow-cn",
    vendorKey: "siliconflow-cn",
    name: "SiliconFlow (China)",
    baseUrl: "https://api.siliconflow.cn/v1",
    apiStyle: "openai-completions",
    accentColor: "#8B5CF6",
  },
  {
    id: "volcengine",
    vendorKey: "volcengine",
    name: "Volcengine Ark",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiStyle: "openai-completions",
    aliases: ["doubao", "ark"],
    accentColor: "#1664FF",
  },
  {
    id: "minimax-cn",
    vendorKey: "minimax-cn",
    name: "MiniMax",
    baseUrl: "https://api.minimaxi.com/anthropic/v1",
    apiStyle: "anthropic-messages",
    aliases: ["minimax"],
    accentColor: "#E11D48",
  },
  {
    id: "minimax-cn-openai",
    vendorKey: "minimax-cn",
    name: "MiniMax (OpenAI)",
    baseUrl: "https://api.minimaxi.com/v1",
    apiStyle: "openai-completions",
    aliases: ["minimax-openai", "minimax-compatible"],
    accentColor: "#F43F5E",
  },
  {
    id: "stepfun-plan",
    vendorKey: "stepfun-plan",
    name: "StepFun Plan",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
    apiStyle: "anthropic-messages",
    // Subscription plan: generation on /messages, model list with a Bearer token.
    discoveryStyle: "openai_models",
    aliases: ["stepfun-step-plan", "stepfun-ai-step-plan"],
    accentColor: "#06B6D4",
  },
  {
    id: "xiaomi",
    vendorKey: "xiaomi",
    name: "Xiaomi",
    baseUrl: "https://api.xiaomimimo.com/v1",
    apiStyle: "openai-completions",
    aliases: ["mimo", "xiaomimimo"],
    accentColor: "#FF6900",
  },
  {
    id: "kimi-for-coding",
    vendorKey: "kimi-for-coding",
    name: "Kimi For Coding",
    baseUrl: "https://api.kimi.com/coding/v1",
    apiStyle: "anthropic-messages",
    aliases: ["kimi-coding", "kimi"],
    accentColor: "#16A34A",
  },
  {
    id: "ant-ling",
    vendorKey: "ant-ling",
    name: "Ant Ling",
    baseUrl: "https://api.ant-ling.com/v1",
    apiStyle: "openai-completions",
    accentColor: "#14B8A6",
  },
  {
    id: "baseten",
    vendorKey: "baseten",
    name: "Baseten",
    baseUrl: "https://inference.baseten.co/v1",
    apiStyle: "openai-completions",
    accentColor: "#0D9488",
  },
  {
    id: "cerebras",
    vendorKey: "cerebras",
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    apiStyle: "openai-completions",
    accentColor: "#F97316",
  },
  {
    id: "huggingface",
    vendorKey: "huggingface",
    name: "Hugging Face",
    baseUrl: "https://router.huggingface.co/v1",
    apiStyle: "openai-completions",
    aliases: ["hugging-face", "hf"],
    accentColor: "#FFD21E",
  },
  {
    id: "meta",
    vendorKey: "meta",
    name: "Meta",
    baseUrl: "https://api.meta.ai/v1",
    apiStyle: "openai-responses",
    accentColor: "#0866FF",
  },
  {
    id: "minimax",
    vendorKey: "minimax",
    name: "MiniMax (International)",
    baseUrl: "https://api.minimax.io/anthropic/v1",
    apiStyle: "anthropic-messages",
    accentColor: "#BE123C",
  },
  {
    id: "moonshotai",
    vendorKey: "moonshotai",
    name: "Moonshot AI (International)",
    baseUrl: "https://api.moonshot.ai/v1",
    apiStyle: "openai-completions",
    accentColor: "#D97706",
  },
  {
    id: "nvidia",
    vendorKey: "nvidia",
    name: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiStyle: "openai-completions",
    aliases: ["nim"],
    accentColor: "#76B900",
  },
  {
    id: "opencode",
    vendorKey: "opencode",
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    apiStyle: "openai-completions",
    aliases: ["opencode-zen"],
    accentColor: "#22C55E",
  },
  {
    id: "vercel",
    vendorKey: "vercel",
    name: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    apiStyle: "openai-completions",
    aliases: ["vercel-ai-gateway"],
    accentColor: "#111111",
  },
];

/** Canonical comparison form of an endpoint: scheme, host, path, no trailing slash. */
export function normalizeEndpointUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (raw === undefined || raw === "") return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withScheme);
    const pathname = parsed.pathname.replace(/\/+$/u, "");
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}`;
  } catch {
    return raw.replace(/\/+$/u, "").toLowerCase();
  }
}

const operationSuffixes = [
  { suffix: "/chat/completions", apiStyle: "openai-completions" },
  { suffix: "/responses", apiStyle: "openai-responses" },
  { suffix: "/messages", apiStyle: "anthropic-messages" },
] as const satisfies ReadonlyArray<{ suffix: string; apiStyle: PiNativeApiStyle }>;

const stripOperationSuffix = (
  value: string,
): { readonly baseUrl: string; readonly apiStyle: PiNativeApiStyle } | undefined => {
  const lower = value.toLowerCase().replace(/\/+$/u, "");
  for (const entry of operationSuffixes) {
    if (!lower.endsWith(entry.suffix)) continue;
    const base = value.slice(0, value.replace(/\/+$/u, "").length - entry.suffix.length);
    return { baseUrl: base.replace(/\/+$/u, ""), apiStyle: entry.apiStyle };
  }
  return undefined;
};

/** The Anthropic SDK appends `/v1/messages`, so the configured base must not repeat it. */
function canonicalizeAnthropicBaseUrl(url: string): string {
  let canonical = url.trim().replace(/\/+$/u, "");
  canonical = canonical.replace(/\/v1\/messages$/iu, "").replace(/\/messages$/iu, "");
  while (/\/v1$/iu.test(canonical)) {
    canonical = canonical.replace(/\/+$/u, "").replace(/\/v1$/iu, "");
  }
  return canonical.replace(/\/+$/u, "");
}

/**
 * Normalize a user-typed Base URL for the selected wire style: add the missing
 * scheme, drop a pasted operation suffix of the same family, and canonicalize
 * the Anthropic root the SDK expects.
 */
export function normalizeBaseUrlInput(url: string, apiStyle: PiNativeApiStyle): string {
  const trimmed = url.trim();
  if (trimmed === "") return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  const withoutSlash = withScheme.replace(/\/+$/u, "");
  const operation = stripOperationSuffix(withoutSlash);
  const family = apiStyle === OPENCODE_GO_API_STYLE ? "openai-completions" : apiStyle;
  const base =
    operation !== undefined && operation.apiStyle === family ? operation.baseUrl : withoutSlash;
  const final = base.replace(/\/+$/u, "");
  return apiStyle === "anthropic-messages" ? canonicalizeAnthropicBaseUrl(final) : final;
}

/** A human-readable reason a Base URL cannot be used, or undefined when it can. */
export function getBaseUrlIssue(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed === "") return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return "Enter a valid URL.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Use an http or https URL.";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "Remove credentials from the URL.";
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    return "Remove the query string and fragment from the URL.";
  }
  return undefined;
}

const endpointHost = (value: string | undefined): string | undefined => {
  const normalized = normalizeEndpointUrl(value);
  if (normalized === undefined) return undefined;
  try {
    return new URL(normalized).host.toLowerCase();
  } catch {
    return undefined;
  }
};

const normalizedVendorKey = (value: string | undefined): string =>
  (value ?? "").trim().toLowerCase().replace(/_/gu, "-");

const presetByUrl = (url: string): PiNativeVendorPreset | undefined => {
  const exact = PI_NATIVE_VENDOR_PRESETS.find(
    (preset) => normalizeEndpointUrl(preset.baseUrl) === url,
  );
  if (exact !== undefined) return exact;
  if (url.includes("open.bigmodel.cn")) {
    return PI_NATIVE_VENDOR_PRESETS.find(
      (preset) => preset.id === (url.includes("/coding/") ? "zhipuai-coding-plan" : "zhipuai"),
    );
  }
  if (url.includes("api.z.ai")) {
    return PI_NATIVE_VENDOR_PRESETS.find(
      (preset) => preset.id === (url.includes("/coding/") ? "zai-coding-plan" : "zai"),
    );
  }
  return undefined;
};

/**
 * Resolve a named endpoint from a stored row. URL wins over the vendor key so
 * an API plan and its Coding Plan sibling cannot match the wrong record.
 */
export function matchNamedPreset(input: {
  readonly vendorKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly apiStyle?: string | undefined;
}): PiNativeVendorPreset | undefined {
  const url = normalizeEndpointUrl(input.baseUrl);
  if (url !== undefined) {
    const byUrl = presetByUrl(url);
    if (byUrl !== undefined) return byUrl;
    const host = endpointHost(input.baseUrl);
    if (host !== undefined) {
      const byHostMatches = PI_NATIVE_VENDOR_PRESETS.filter(
        (preset) => endpointHost(preset.baseUrl) === host,
      );
      if (byHostMatches.length > 0) {
        return (
          byHostMatches.find((preset) => preset.apiStyle === input.apiStyle) ?? byHostMatches[0]
        );
      }
    }
  }
  if (input.apiStyle === OPENCODE_GO_API_STYLE) {
    return PI_NATIVE_VENDOR_PRESETS.find((preset) => preset.id === OPENCODE_GO_API_STYLE);
  }
  const key = normalizedVendorKey(input.vendorKey);
  if (key === "" || key === "custom") return undefined;
  const matches = PI_NATIVE_VENDOR_PRESETS.filter(
    (preset) =>
      preset.vendorKey === key || preset.id === key || preset.aliases?.includes(key) === true,
  );
  if (matches.length <= 1) return matches[0];
  // Several presets share one models.dev vendor (MiniMax Anthropic vs OpenAI):
  // the selected wire style disambiguates them.
  return matches.find((preset) => preset.apiStyle === input.apiStyle) ?? matches[0];
}

/** Wire style a discovery probe asks in, mirroring the transport adapter list. */
export function discoveryStyleForApiStyle(apiStyle?: PiNativeApiStyle | null): DiscoveryStyle {
  if (apiStyle === "anthropic-messages") return "anthropic_models";
  if (apiStyle === "google-generative-ai") return "google_models";
  // `opencode-go` and every OpenAI-compatible style authenticate a model list
  // the same way.
  return "openai_models";
}

/** Probe style for a configured service, honouring a documented override. */
export function discoveryStyleForService(input: {
  readonly vendorKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly apiStyle: PiNativeApiStyle;
}): DiscoveryStyle {
  const preset = matchNamedPreset(input);
  return preset?.discoveryStyle ?? discoveryStyleForApiStyle(input.apiStyle);
}

export interface EndpointDraft {
  readonly baseUrl: string;
  readonly apiStyle: PiNativeApiStyle;
  /** True when detection changed the style the caller already had selected. */
  readonly autoDetected: boolean;
  readonly matchedPreset?: PiNativeVendorPreset | undefined;
}

const detectedStyleFromUrl = (url: string): PiNativeApiStyle | undefined => {
  const operation = stripOperationSuffix(url);
  if (operation !== undefined) return operation.apiStyle;
  const normalized = normalizeEndpointUrl(url);
  if (normalized === undefined) return undefined;
  try {
    const pathname = new URL(normalized).pathname.replace(/\/+$/u, "");
    if (/\/v1beta$/iu.test(pathname)) return "google-generative-ai";
  } catch {
    return undefined;
  }
  return undefined;
};

/**
 * Resolve a Base URL draft into the endpoint that will really be used.
 *
 * Detection only runs while the style is unlocked: an explicit user choice is
 * never rewritten by a pasted URL. A known preset host contributes its style,
 * and a pasted operation suffix is stripped from the address.
 */
export function resolveEndpointDraft(
  baseUrl: string,
  currentApiStyle: PiNativeApiStyle,
  styleLocked = false,
): EndpointDraft {
  const matchedPreset = matchNamedPreset({ baseUrl });
  if (styleLocked) {
    return {
      baseUrl: normalizeBaseUrlInput(baseUrl, currentApiStyle),
      apiStyle: currentApiStyle,
      autoDetected: false,
      ...(matchedPreset === undefined ? {} : { matchedPreset }),
    };
  }
  const detected = detectedStyleFromUrl(baseUrl) ?? matchedPreset?.apiStyle;
  const apiStyle = detected ?? currentApiStyle;
  return {
    baseUrl: normalizeBaseUrlInput(baseUrl, apiStyle),
    apiStyle,
    autoDetected: detected !== undefined && detected !== currentApiStyle,
    ...(matchedPreset === undefined ? {} : { matchedPreset }),
  };
}

export function isZhipuEndpoint(input: {
  readonly vendorKey?: string | undefined;
  readonly baseUrl?: string | undefined;
}): boolean {
  return matchNamedPreset(input)?.zhipuCompat === true;
}

/** pi-ai completions flags for Zhipu / Z.AI thinking and tool streaming. */
export function zhipuRequestCompat(input: {
  readonly vendorKey?: string | undefined;
  readonly baseUrl?: string | undefined;
}): { readonly thinkingFormat: "zai"; readonly zaiToolStream: true } | undefined {
  return isZhipuEndpoint(input) ? { thinkingFormat: "zai", zaiToolStream: true } : undefined;
}

const mentionsDeepSeek = (value: string | undefined): boolean =>
  (value ?? "").toLowerCase().includes("deepseek");

/**
 * DeepSeek thinking mode requires every replayed assistant message to carry a
 * reasoning field. pi-ai auto-detects only `provider === "deepseek"` or a
 * `deepseek.com` URL, so detect the family from vendor key, URL, model id or
 * catalog family as well.
 */
export function isDeepSeekReasoningReplay(input: {
  readonly vendorKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly modelId?: string | undefined;
  readonly family?: string | undefined;
}): boolean {
  const key = normalizedVendorKey(input.vendorKey);
  if (key.includes("deepseek")) return true;
  if ((input.baseUrl ?? "").toLowerCase().includes("deepseek.com")) return true;
  return mentionsDeepSeek(input.modelId) || mentionsDeepSeek(input.family);
}

/** Official DeepSeek Completions hosts still accept an empty reasoning replay. */
export function isOfficialDeepSeekEndpoint(input: {
  readonly baseUrl?: string | undefined;
}): boolean {
  const baseUrl = input.baseUrl?.trim();
  if (baseUrl === undefined || baseUrl === "") return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "deepseek.com" || hostname.endsWith(".deepseek.com");
  } catch {
    return false;
  }
}

export interface DeepSeekRequestCompat {
  readonly requiresReasoningContentOnAssistantMessages: true;
  /** Relays reported rejecting OpenAI-style `reasoning_effort`. */
  readonly supportsReasoningEffort?: false;
  /** Missing reasoning is filled with a documented placeholder. */
  readonly requiresNonEmptyReasoningReplay?: true;
}

/** pi-ai completions flags for DeepSeek-family reasoning replay. */
export function deepseekRequestCompat(input: {
  readonly vendorKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly modelId?: string | undefined;
  readonly family?: string | undefined;
}): DeepSeekRequestCompat | undefined {
  if (!isDeepSeekReasoningReplay(input)) return undefined;
  if (isOfficialDeepSeekEndpoint(input)) {
    return { requiresReasoningContentOnAssistantMessages: true };
  }
  return {
    requiresReasoningContentOnAssistantMessages: true,
    supportsReasoningEffort: false,
    requiresNonEmptyReasoningReplay: true,
  };
}

/**
 * OpenCode Go serves Claude and MiniMax models on Anthropic Messages and every
 * other model on Chat Completions, so the wire route is per model.
 */
export function isOpenCodeGoModelAnthropic(modelId: string): boolean {
  return /(claude|minimax)/iu.test(modelId);
}

/** Thinking protocol a model likely expects on Anthropic Messages. */
export function thinkingProtocolForModel(modelId: string): ThinkingProtocol {
  return /(opus-4\.[7-9]|opus-5|fable|sonnet-5)/iu.test(modelId) ? "adaptive" : "legacy";
}
