import { clampThinkingLevel, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  ModelThinkingLevel,
  ProviderHeaders,
  ProviderResponse,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import * as anthropicMessages from "@earendil-works/pi-ai/api/anthropic-messages";
import * as googleGenerativeAi from "@earendil-works/pi-ai/api/google-generative-ai";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import * as openaiResponses from "@earendil-works/pi-ai/api/openai-responses";
import {
  getBuiltinModels,
  getBuiltinProviders,
  type BuiltinProvider,
} from "@earendil-works/pi-ai/providers/all";
import { settingsSecretLiteral, type ModelSelection } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { Agent, fetch as undiciFetch } from "undici";

import {
  resolveBindingLimits,
  sanitizeProviderHeaders,
  THINKING_LEVELS as CATALOG_THINKING_LEVELS,
  type PiNativeModelBinding,
  type ThinkingLevel,
} from "../../catalog/modelCatalog.ts";
import {
  deepseekRequestCompat,
  isOpenCodeGoModelAnthropic,
  matchNamedPreset,
  OPENCODE_GO_BASE_URL,
  zhipuRequestCompat,
} from "../../catalog/presets.ts";
import type { PiNativeApiStyle, PiNativeSettings } from "../../settings.ts";

/** Wire-backed API styles; `opencode-go` resolves to one of these per model. */
type WireApiStyle = Exclude<PiNativeApiStyle, "opencode-go">;

/** Injected for local endpoints whose SDK still requires a non-empty key. */
export const PI_NATIVE_LOCAL_API_KEY = "pi-native-local";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const thinkingLevelMapFor = (
  levels: readonly ThinkingLevel[],
): Record<ThinkingLevel, string | null> => {
  const map = {} as Record<ThinkingLevel, string | null>;
  for (const level of CATALOG_THINKING_LEVELS) {
    map[level] = levels.includes(level) ? level : null;
  }
  return map;
};

/** `serviceTier` "default" is the standard tier; it must not travel as a wire value. */
const STANDARD_SERVICE_TIER = "default";

const BUILTIN_PROVIDERS = new Set<string>(getBuiltinProviders());

// `Date`/timers/`crypto` use this indirection because Effect diagnostics reject bare globals.
const host = globalThis as unknown as {
  readonly Date: { now: () => number };
  readonly setTimeout: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly crypto: { readonly randomUUID: () => string };
};

export type FetchFunction = typeof globalThis.fetch;

export interface ResolvedModelBinding {
  readonly provider: string;
  readonly modelId: string;
  readonly model: Model<Api>;
  /** The configured style; `opencode-go` keeps its per-model wire API on `model.api`. */
  readonly apiStyle: PiNativeApiStyle;
  readonly apiKey: string;
  /** Nulls suppress SDK-default auth headers on keyless local endpoints. */
  readonly headers: ProviderHeaders;
  readonly thinkingLevel: ModelThinkingLevel | undefined;
  readonly serviceTier: string | undefined;
  /** Effective override, empty when the provider default applies. */
  readonly baseUrl: string;
  readonly custom: boolean;
  /** The saved binding this request resolved through, when one matched. */
  readonly modelBinding?: PiNativeModelBinding | undefined;
  readonly supportsImages: boolean;
  readonly supportsDocuments: boolean;
}

export type PiNativeResolvedModelBinding = ResolvedModelBinding;

export interface ProviderHttpDispatcher {
  close: () => void | Promise<void>;
}

export interface ProviderHttpPoolOptions {
  readonly now?: () => number;
  readonly minRebuildIntervalMs?: number;
  readonly createDispatcher?: () => ProviderHttpDispatcher;
}

const DEFAULT_MIN_REBUILD_INTERVAL_MS = 30_000;

function defaultDispatcher(): ProviderHttpDispatcher {
  return new Agent({
    connections: 32,
    keepAliveTimeout: 30_000,
    headersTimeout: 120_000,
    bodyTimeout: 0,
  });
}

function dispatcherFetch(dispatcher: () => ProviderHttpDispatcher): FetchFunction {
  const fetchFn = (input: Parameters<FetchFunction>[0], init?: Parameters<FetchFunction>[1]) =>
    undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      { ...init, dispatcher: dispatcher() } as Parameters<typeof undiciFetch>[1],
    ) as unknown as ReturnType<FetchFunction>;
  return fetchFn as unknown as FetchFunction;
}

/**
 * Keeps one keep-alive pool per provider instance. Resetting it drops sockets that a
 * failed attempt may have wedged; the reset is throttled so a flapping endpoint cannot
 * churn connection pools.
 */
export class ProviderHttpPool {
  readonly #now: () => number;
  readonly #minRebuildIntervalMs: number;
  readonly #createDispatcher: () => ProviderHttpDispatcher;
  readonly #fetch: FetchFunction;
  #dispatcher: ProviderHttpDispatcher;
  #lastRebuildAt: number;
  #closed = false;

  constructor(options: ProviderHttpPoolOptions = {}) {
    this.#now = options.now ?? (() => host.Date.now());
    this.#minRebuildIntervalMs = options.minRebuildIntervalMs ?? DEFAULT_MIN_REBUILD_INTERVAL_MS;
    this.#createDispatcher = options.createDispatcher ?? defaultDispatcher;
    this.#dispatcher = this.#createDispatcher();
    this.#fetch = dispatcherFetch(() => this.#dispatcher);
    this.#lastRebuildAt = this.#now();
  }

  getFetch(): FetchFunction {
    return this.#fetch;
  }

  /** Returns true when the pool was replaced; throttled unless `force` is set. */
  rebuild(force = false): boolean {
    if (this.#closed) return false;
    const now = this.#now();
    if (!force && now - this.#lastRebuildAt < this.#minRebuildIntervalMs) return false;
    const stale = this.#dispatcher;
    this.#dispatcher = this.#createDispatcher();
    this.#lastRebuildAt = now;
    void Promise.resolve(stale.close()).catch(() => undefined);
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    void Promise.resolve(this.#dispatcher.close()).catch(() => undefined);
  }
}

/** The Anthropic SDK appends `/v1/messages`, so the configured base must not repeat it. */
export function canonicalizeAnthropicBaseUrl(url: string): string {
  let canonical = url.trim().replace(/\/+$/u, "");
  canonical = canonical.replace(/\/v1\/messages$/iu, "").replace(/\/messages$/iu, "");
  while (/\/v1$/iu.test(canonical)) {
    canonical = canonical.replace(/\/+$/u, "").replace(/\/v1$/iu, "");
  }
  return canonical.replace(/\/+$/u, "");
}

export function canonicalizeProviderBaseUrl(apiStyle: PiNativeApiStyle, url: string): string {
  return apiStyle === "anthropic-messages" ? canonicalizeAnthropicBaseUrl(url) : url.trim();
}

export function providerAuthHeaders(apiKey: string): ProviderHeaders {
  // A real key rides on the SDK's own `apiKey` option; only the keyless case needs headers.
  return apiKey === "" ? { authorization: null, "x-api-key": null } : {};
}

export const OPENCODE_SESSION_HEADER = "x-opencode-session";

export interface OpenCodeEndpointInput {
  readonly apiStyle?: PiNativeApiStyle | undefined;
  readonly provider?: string | undefined;
  readonly vendorKey?: string | undefined;
  readonly baseUrl?: string | undefined;
}

/** Whether a request targets OpenCode Zen or OpenCode Go, which require `x-opencode-session`. */
export function isOpenCodeEndpoint(input: OpenCodeEndpointInput): boolean {
  if (input.apiStyle === "opencode-go") return true;
  const vendor = input.vendorKey?.trim().toLowerCase();
  const provider = input.provider?.trim().toLowerCase();
  if (
    vendor === "opencode-go" ||
    vendor === "opencode" ||
    provider === "opencode-go" ||
    provider === "opencode"
  ) {
    return true;
  }
  const baseUrl = input.baseUrl?.trim();
  if (baseUrl === undefined || baseUrl === "") return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "opencode.ai" || hostname.endsWith(".opencode.ai");
  } catch {
    return false;
  }
}

function hasHeaderCaseInsensitive(headers: ProviderHeaders, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

/** Inject OpenCode's per-conversation routing header when missing so prompt caching works without 400 errors. */
export function withOpenCodeSessionHeader(
  headers: ProviderHeaders,
  input: OpenCodeEndpointInput & { readonly sessionId: string | undefined },
): ProviderHeaders {
  const sessionId = input.sessionId?.trim();
  if (
    sessionId === undefined ||
    sessionId === "" ||
    !isOpenCodeEndpoint(input) ||
    hasHeaderCaseInsensitive(headers, OPENCODE_SESSION_HEADER)
  ) {
    return headers;
  }
  return { ...headers, [OPENCODE_SESSION_HEADER]: sessionId };
}

function apiDefaultProvider(apiStyle: WireApiStyle): "openai" | "anthropic" | "google" {
  switch (apiStyle) {
    case "anthropic-messages":
      return "anthropic";
    case "google-generative-ai":
      return "google";
    case "openai-completions":
    case "openai-responses":
      return "openai";
  }
}

function apiDefaultBaseUrl(apiStyle: WireApiStyle): string {
  switch (apiStyle) {
    case "anthropic-messages":
      return ANTHROPIC_BASE_URL;
    case "google-generative-ai":
      return GOOGLE_BASE_URL;
    case "openai-completions":
    case "openai-responses":
      return OPENAI_BASE_URL;
  }
}

/** OpenCode Go's canonical endpoint, canonicalized for the model's wire API. */
function openCodeGoBaseUrl(api: WireApiStyle): string {
  return canonicalizeProviderBaseUrl(api, OPENCODE_GO_BASE_URL);
}

function builtinModels(provider: string): readonly Model<Api>[] {
  return BUILTIN_PROVIDERS.has(provider) ? getBuiltinModels(provider as BuiltinProvider) : [];
}

function splitModelSlug(slug: string): { providerHint: string | undefined; modelId: string } {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) {
    return { providerHint: undefined, modelId: slug };
  }
  return {
    providerHint: slug.slice(0, separator),
    modelId: slug.slice(separator + 1),
  };
}

function builtinDefaultSlug(apiStyle: WireApiStyle): string {
  const provider = apiDefaultProvider(apiStyle);
  const models = builtinModels(provider);
  if (apiStyle === "openai-responses") {
    const preferred = models.find((model) => model.id === "gpt-5.4");
    if (preferred !== undefined) return `${provider}/${preferred.id}`;
  }
  if (apiStyle === "openai-completions") {
    const preferred = models.find((model) => model.id === "gpt-4o");
    if (preferred !== undefined) return `${provider}/${preferred.id}`;
  }
  const first = models[0];
  if (first !== undefined) return `${provider}/${first.id}`;
  for (const candidate of getBuiltinProviders()) {
    const match = builtinModels(candidate).find((model) => model.api === apiStyle);
    if (match !== undefined) return `${candidate}/${match.id}`;
  }
  for (const candidate of getBuiltinProviders()) {
    const firstModel = builtinModels(candidate)[0];
    if (firstModel !== undefined) return `${candidate}/${firstModel.id}`;
  }
  return `${provider}/default`;
}

/** OpenCode Go publishes its whole catalogue through its own built-in provider. */
function openCodeGoDefaultSlug(): string {
  const first = builtinModels("opencode-go")[0];
  return first === undefined ? "opencode-go/default" : `opencode-go/${first.id}`;
}

function findBuiltinModel(
  modelId: string,
  apiStyle: WireApiStyle,
  providerHint: string | undefined,
  preferOpenCodeGo: boolean,
): Model<Api> | undefined {
  const providers: string[] = [];
  if (providerHint !== undefined) providers.push(providerHint);
  if (preferOpenCodeGo) providers.push("opencode-go");
  providers.push(apiDefaultProvider(apiStyle));
  providers.push(...getBuiltinProviders());
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider)) continue;
    seen.add(provider);
    const match = builtinModels(provider).find((model) => model.id === modelId);
    if (match !== undefined) return match;
  }
  return undefined;
}

interface CustomModelMatch {
  readonly slug: string;
  readonly name: string | undefined;
}

function findCustomModel(
  settings: PiNativeSettings,
  slug: string,
  modelId: string,
): CustomModelMatch | undefined {
  const normalizedSlug = slug.toLowerCase();
  const normalizedId = modelId.toLowerCase();
  for (const entry of settings.customModels) {
    const entrySlug = typeof entry === "string" ? entry : entry.slug;
    const entryName = typeof entry === "string" ? undefined : entry.name;
    const normalizedEntry = entrySlug.toLowerCase();
    if (normalizedEntry === normalizedSlug || normalizedEntry === normalizedId) {
      return { slug: entrySlug, name: entryName };
    }
  }
  return undefined;
}

/** Match a saved binding by id or alias; case-insensitive so UI casing never matters. */
function findPiNativeModelBinding(
  settings: PiNativeSettings,
  reference: string,
): PiNativeModelBinding | undefined {
  const normalized = reference.trim().toLowerCase();
  if (normalized === "") return undefined;
  return settings.modelBindings.find(
    (binding) =>
      binding.id.trim().toLowerCase() === normalized ||
      (binding.alias?.trim().toLowerCase() ?? "") === normalized,
  );
}

function synthesizedModel(input: {
  readonly provider: string;
  readonly modelId: string;
  readonly apiStyle: WireApiStyle;
  readonly name: string | undefined;
  readonly baseUrl: string;
}): Model<Api> {
  return {
    id: input.modelId,
    name: input.name ?? input.modelId,
    api: input.apiStyle,
    provider: input.provider,
    baseUrl: input.baseUrl,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

/**
 * Resolve the thinking level for one request.
 *
 * "omit" (or an omitted option on a binding whose default is "omit") sends no
 * reasoning override at all; a concrete binding default applies when the UI sent
 * no choice. The result is clamped to the model's own supported ladder.
 */
function readThinkingLevel(
  model: Model<Api>,
  selection: ModelSelection,
  binding: PiNativeModelBinding | undefined,
): ModelThinkingLevel | undefined {
  if (!model.reasoning) return undefined;
  const requested = getModelSelectionStringOptionValue(selection, "thinking");
  const candidate: string | undefined =
    requested !== undefined ? requested : (binding?.defaultThinkingLevel ?? undefined);
  if (candidate === undefined || candidate === "omit" || candidate === "off") return undefined;
  const level = CATALOG_THINKING_LEVELS.find((entry) => entry === candidate);
  return level === undefined ? undefined : clampThinkingLevel(model, level);
}

function readServiceTier(selection: ModelSelection): string | undefined {
  const tier = getModelSelectionStringOptionValue(selection, "serviceTier");
  if (tier === undefined || tier === "" || tier === STANDARD_SERVICE_TIER) return undefined;
  return tier;
}

function resolveWireApi(settings: PiNativeSettings, modelId: string): WireApiStyle {
  return settings.apiStyle === "opencode-go"
    ? isOpenCodeGoModelAnthropic(modelId)
      ? "anthropic-messages"
      : "openai-completions"
    : settings.apiStyle;
}

function resolveDefaultReference(settings: PiNativeSettings): string {
  const configured = settings.defaultModel.trim();
  if (configured !== "") return configured;
  return settings.modelBindings[0]?.id ?? "default";
}

export function resolvePiNativeModelBinding(
  settings: PiNativeSettings,
  selection: ModelSelection,
): ResolvedModelBinding {
  const apiStyle = settings.apiStyle;
  const apiKey = settingsSecretLiteral(settings.apiKey);
  const requested = selection.model.trim();
  const reference = requested === "default" ? resolveDefaultReference(settings) : requested;
  const modelBinding = findPiNativeModelBinding(settings, reference);
  const openCodeGo = apiStyle === "opencode-go";

  const slug =
    modelBinding !== undefined
      ? modelBinding.id
      : reference !== "default"
        ? reference
        : openCodeGo
          ? openCodeGoDefaultSlug()
          : builtinDefaultSlug(apiStyle as WireApiStyle);
  const { providerHint, modelId: splitModelId } = splitModelSlug(slug);
  // A saved binding stores the exact wire model id (e.g. OpenRouter `anthropic/claude-sonnet-4-6`),
  // so only the lookup hint strips any leading vendor prefix.
  const wireModelId = modelBinding !== undefined ? modelBinding.id : splitModelId;
  const wireApi = resolveWireApi(settings, wireModelId);
  const custom = findCustomModel(settings, slug, splitModelId);
  const vendorKey = settings.vendorKey.trim();
  const preset = matchNamedPreset({
    vendorKey,
    apiStyle: settings.apiStyle,
    ...(settings.baseUrl.trim() === "" ? {} : { baseUrl: settings.baseUrl }),
  });
  // A named service owns its endpoint and its catalog records; a model id that
  // also exists in another provider's catalog must not borrow that transport.
  const builtinHint =
    providerHint ?? (vendorKey !== "" && BUILTIN_PROVIDERS.has(vendorKey) ? vendorKey : undefined);
  const builtin = findBuiltinModel(splitModelId, wireApi, builtinHint, openCodeGo);
  const provider =
    modelBinding !== undefined && vendorKey !== ""
      ? vendorKey
      : (providerHint ??
        (vendorKey !== "" ? vendorKey : openCodeGo ? "opencode-go" : apiDefaultProvider(wireApi)));
  const bindingName = modelBinding?.displayName?.trim() || modelBinding?.alias?.trim();
  const name = bindingName === "" || bindingName === undefined ? custom?.name : bindingName;
  const baseUrlOverride = settings.baseUrl.trim();
  const serviceDefaultBaseUrl = openCodeGo
    ? openCodeGoBaseUrl(wireApi)
    : vendorKey !== "" && preset !== undefined
      ? canonicalizeProviderBaseUrl(wireApi, preset.baseUrl)
      : undefined;

  const baseModel: Model<Api> =
    builtin === undefined
      ? synthesizedModel({
          provider,
          modelId: wireModelId,
          apiStyle: wireApi,
          name,
          baseUrl: serviceDefaultBaseUrl ?? apiDefaultBaseUrl(wireApi),
        })
      : {
          ...builtin,
          id: wireModelId,
          api: wireApi,
          provider,
          ...(serviceDefaultBaseUrl === undefined ? {} : { baseUrl: serviceDefaultBaseUrl }),
          ...(name === undefined ? {} : { name }),
        };

  const limits =
    modelBinding === undefined
      ? undefined
      : resolveBindingLimits(
          {
            contextWindow: baseModel.contextWindow,
            maxTokens: baseModel.maxTokens,
            source: builtin === undefined ? "generic" : "catalog",
          },
          modelBinding,
        );
  const contextWindow = limits?.binding.contextWindow ?? baseModel.contextWindow;
  const maxTokens = limits?.binding.maxTokens ?? baseModel.maxTokens;

  const enabledThinkingLevels = modelBinding?.thinkingLevels ?? [];
  const reasoning = enabledThinkingLevels.some((level) => level !== "off") || baseModel.reasoning;
  const thinkingLevelMap =
    enabledThinkingLevels.length > 0
      ? thinkingLevelMapFor(enabledThinkingLevels)
      : baseModel.thinkingLevelMap;

  const effectiveBaseUrl =
    baseUrlOverride === ""
      ? baseModel.baseUrl
      : canonicalizeProviderBaseUrl(wireApi, baseUrlOverride);

  const zhipuCompat =
    wireApi === "openai-completions"
      ? zhipuRequestCompat({ vendorKey, baseUrl: effectiveBaseUrl })
      : undefined;
  const deepseekCompat =
    wireApi === "openai-completions"
      ? deepseekRequestCompat({ vendorKey, baseUrl: effectiveBaseUrl, modelId: wireModelId })
      : undefined;
  const explicitReasoningEffort =
    typeof modelBinding?.supportsReasoningEffort === "boolean"
      ? { supportsReasoningEffort: modelBinding.supportsReasoningEffort }
      : {};
  const compat =
    wireApi === "openai-completions"
      ? {
          ...(baseModel.compat as Record<string, unknown> | undefined),
          ...zhipuCompat,
          ...deepseekCompat,
          ...explicitReasoningEffort,
        }
      : wireApi === "anthropic-messages" && modelBinding?.thinkingProtocol !== undefined
        ? {
            ...(baseModel.compat as Record<string, unknown> | undefined),
            forceAdaptiveThinking: modelBinding.thinkingProtocol === "adaptive",
          }
        : baseModel.compat;

  const model: Model<Api> = {
    ...baseModel,
    baseUrl: effectiveBaseUrl,
    contextWindow,
    maxTokens,
    reasoning,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    ...(compat === undefined ? {} : { compat }),
  } as Model<Api>;

  // A saved binding's explicit overrides win; otherwise the built-in record's
  // published input modalities answer for the model.
  const publishedImages = model.input.includes("image");
  const supportsImages =
    typeof modelBinding?.supportsImages === "boolean"
      ? modelBinding.supportsImages
      : publishedImages;
  const supportsDocuments =
    typeof modelBinding?.supportsDocuments === "boolean" ? modelBinding.supportsDocuments : false;

  return {
    provider: model.provider,
    modelId: model.id,
    model,
    apiStyle,
    apiKey,
    headers: { ...providerAuthHeaders(apiKey), ...sanitizeProviderHeaders(settings.headers) },
    thinkingLevel: readThinkingLevel(model, selection, modelBinding),
    serviceTier: readServiceTier(selection),
    baseUrl: baseUrlOverride === "" ? "" : effectiveBaseUrl,
    custom: custom !== undefined || modelBinding !== undefined,
    ...(modelBinding === undefined ? {} : { modelBinding }),
    supportsImages,
    supportsDocuments,
  };
}

type PiNativeStreamOptions = SimpleStreamOptions & { readonly serviceTier?: string };

export interface ProviderStreamDependencies {
  readonly binding: ResolvedModelBinding;
  readonly sessionId?: string | undefined;
  readonly pool?: ProviderHttpPool | undefined;
  readonly overrideStreamFn?: StreamFn | undefined;
  readonly onResponse?:
    | ((response: ProviderResponse, model: Model<Api>) => void | Promise<void>)
    | undefined;
  readonly extraHeaders?: ProviderHeaders | undefined;
  readonly now?: () => number;
}

function streamModuleFor(api: string): StreamFn | undefined {
  switch (api) {
    case "openai-responses":
      return openaiResponses.streamSimple as unknown as StreamFn;
    case "openai-completions":
      return openaiCompletions.streamSimple as unknown as StreamFn;
    case "anthropic-messages":
      return anthropicMessages.streamSimple as unknown as StreamFn;
    case "google-generative-ai":
      return googleGenerativeAi.streamSimple as unknown as StreamFn;
    default:
      return undefined;
  }
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createFailedAssistantStream(input: {
  readonly model: Model<Api>;
  readonly errorMessage: string;
  readonly timestamp: number;
  readonly stopReason?: "error" | "aborted";
}): AssistantMessageEventStream {
  const stopReason = input.stopReason ?? "error";
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: input.model.api,
    provider: input.model.provider,
    model: input.model.id,
    usage: emptyUsage(),
    stopReason,
    errorMessage: input.errorMessage,
    timestamp: input.timestamp,
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "error", reason: stopReason, error: message });
  return stream;
}

function buildRequestOptions(
  model: Model<Api>,
  deps: ProviderStreamDependencies,
  options: SimpleStreamOptions | undefined,
  fallbackOpenCodeSessionId: () => string,
): PiNativeStreamOptions {
  const binding = deps.binding;
  const target: OpenCodeEndpointInput = {
    apiStyle: binding.apiStyle,
    provider: model.provider,
    baseUrl: model.baseUrl || binding.baseUrl,
  };
  const optionSession = options?.sessionId?.trim();
  const depSession = deps.sessionId?.trim();
  const sessionId =
    optionSession !== undefined && optionSession !== ""
      ? optionSession
      : depSession !== undefined && depSession !== ""
        ? depSession
        : isOpenCodeEndpoint(target)
          ? fallbackOpenCodeSessionId()
          : undefined;
  const headers = withOpenCodeSessionHeader(
    { ...binding.headers, ...deps.extraHeaders },
    { ...target, sessionId },
  );
  // A keyless local endpoint still needs a syntactically valid key; the null headers strip it.
  const apiKey =
    binding.apiKey !== ""
      ? binding.apiKey
      : binding.baseUrl !== ""
        ? PI_NATIVE_LOCAL_API_KEY
        : undefined;
  const reasoning = options?.reasoning ?? binding.thinkingLevel;
  const fetchImpl =
    model.api === "google-generative-ai" || deps.pool === undefined
      ? undefined
      : deps.pool.getFetch();
  const samplingParams =
    binding.serviceTier === undefined ||
    (model.api !== "openai-responses" && model.api !== "openai-completions")
      ? options?.samplingParams
      : { ...options?.samplingParams, service_tier: binding.serviceTier };
  return {
    ...options,
    maxRetries: 0,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(reasoning === undefined || reasoning === "off" ? {} : { reasoning }),
    ...(samplingParams === undefined ? {} : { samplingParams }),
    ...(deps.onResponse === undefined ? {} : { onResponse: deps.onResponse }),
  };
}

export function createProviderStreamFn(deps: ProviderStreamDependencies): StreamFn {
  let generatedOpenCodeSessionId: string | undefined;
  const fallbackOpenCodeSessionId = (): string => {
    generatedOpenCodeSessionId ??= `pi-native-session-${host.crypto.randomUUID()}`;
    return generatedOpenCodeSessionId;
  };
  const override = deps.overrideStreamFn;
  if (override !== undefined) {
    // The seam stands where the real transport would be called, so an override sees
    // the resolved key, headers and reasoning rather than the raw agent options.
    return (model, context, options) =>
      override(
        model,
        context,
        buildRequestOptions(model, deps, options, fallbackOpenCodeSessionId),
      );
  }
  return (model, context, options) => {
    const streamFn = streamModuleFor(model.api);
    if (streamFn === undefined) {
      return createFailedAssistantStream({
        model,
        errorMessage: `Pi Native does not support the ${model.api} API style.`,
        timestamp: (deps.now ?? (() => host.Date.now()))(),
      });
    }
    return streamFn(
      model,
      context,
      buildRequestOptions(model, deps, options, fallbackOpenCodeSessionId),
    );
  };
}
