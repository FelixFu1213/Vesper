// @effect-diagnostics globalDate:off -- Probe latency is a wall-clock measurement reported to the user.
/**
 * Endpoint-side model discovery for Pi Native: one authenticated model-list
 * request per candidate Base URL, inside one shared budget and confined to the
 * configured origin. Discovery and "Test connection" share these rules.
 */

import * as Schema from "effect/Schema";

import {
  sanitizeProviderHeaders,
  type DiscoveryStyle,
  type PiNativeApiStyle,
  type PiNativeModelInfo,
} from "../../catalog/modelCatalog.ts";
import {
  discoveryStyleForService,
  getBaseUrlIssue,
  matchNamedPreset,
  normalizeBaseUrlInput,
  type PiNativeVendorPreset,
} from "../../catalog/presets.ts";
import { isOpenCodeEndpoint, OPENCODE_SESSION_HEADER } from "../runtime/providerBinding.ts";
import { getDefaultModelsDevCatalog, type ModelsDevCatalog } from "./modelsDevCatalog.ts";

const DISCOVERY_TIMEOUT_MS = 10_000;
/** Total budget for one Base URL sweep; every candidate shares it. */
const DISCOVERY_TOTAL_BUDGET_MS = 12_000;
const MAX_MODELS = 500;
const MAX_REDIRECTS = 3;
const MAX_BASE_URL_CANDIDATES = 4;
const ANTHROPIC_VERSION = "2023-06-01";
const NO_MODEL_LIST_WARNING =
  "This endpoint does not publish a /models list; add model IDs manually.";

/** Subscription plans serve generation on /messages and publish no model list. */
const TOKEN_PLAN_PRESET_IDS: ReadonlySet<string> = new Set([
  "zhipuai-coding-plan",
  "zai-coding-plan",
  "kimi-for-coding",
  "stepfun-plan",
  "minimax-cn",
  "opencode-go",
]);

const PROTOCOL_DEFAULT_BASE_URLS: Readonly<Record<PiNativeApiStyle, string>> = {
  "openai-responses": "https://api.openai.com/v1",
  "openai-completions": "https://api.openai.com/v1",
  "anthropic-messages": "https://api.anthropic.com",
  "google-generative-ai": "https://generativelanguage.googleapis.com/v1beta",
  "opencode-go": "https://opencode.ai/zen/go/v1",
};

const CONTEXT_WINDOW_KEYS = [
  "context_window",
  "context_length",
  "inputTokenLimit",
  "contextWindow",
] as const;
const MAX_TOKENS_KEYS = [
  "max_output_tokens",
  "outputTokenLimit",
  "max_tokens",
  "maxTokens",
] as const;

export interface DiscoveredEndpointModel {
  readonly modelId: string;
  readonly displayName: string;
  readonly contextWindow?: number | undefined;
  readonly maxTokens?: number | undefined;
}

export interface ProbeProviderModelsInput {
  readonly apiStyle: PiNativeApiStyle;
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly vendorKey?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly discoveryStyle?: DiscoveryStyle | undefined;
}

export interface ProbeModelsResult {
  readonly models: PiNativeModelInfo[];
  readonly rawModels: readonly DiscoveredEndpointModel[];
  readonly effectiveBaseUrl: string;
  readonly resolvedFrom?: string | undefined;
  readonly discoveryStyle: DiscoveryStyle;
  readonly skippedDiscovery?: boolean | undefined;
  readonly warning?: string | undefined;
}

export interface TestConnectionResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly effectiveBaseUrl: string;
  readonly modelCount?: number | undefined;
  readonly warning?: string | undefined;
  readonly error?: string | undefined;
}

export const PiNativeDiscoveryFailureReason = Schema.Literals([
  "invalid_endpoint",
  "authentication_failed",
  "probe_failed",
]);
export type PiNativeDiscoveryFailureReason = typeof PiNativeDiscoveryFailureReason.Type;

/** Failure a probe reports; `status` carries the HTTP status when there was one. */
export class PiNativeDiscoveryError extends Schema.TaggedError<
  PiNativeDiscoveryError,
  { readonly brand: unique symbol }
>()("PiNativeDiscoveryError", {
  reason: PiNativeDiscoveryFailureReason,
  message: Schema.String,
  status: Schema.optional(Schema.Int),
}) {}

interface ResolvedEndpoint {
  readonly baseUrl: string;
  readonly discoveryStyle: DiscoveryStyle;
  readonly preset: PiNativeVendorPreset | undefined;
}

const isPiNativeDiscoveryError = Schema.is(PiNativeDiscoveryError);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const trimmedText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const firstPositiveInteger = (
  item: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined => {
  if (item === undefined) return undefined;
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
};

/**
 * The id one row of a model list carries: `id` is the OpenAI and Anthropic
 * shape, `slug` is what some Responses endpoints return, and Google prefixes
 * the name with `models/`.
 */
const listedModelId = (
  style: DiscoveryStyle,
  item: Record<string, unknown> | undefined,
): string | undefined => {
  if (item === undefined) return undefined;
  const raw = style === "google_models" ? item.name : (item.id ?? item.slug);
  if (typeof raw !== "string") return undefined;
  const withoutPrefix = style === "google_models" ? raw.replace(/^models\//u, "") : raw;
  return trimmedText(withoutPrefix);
};

/** Normalize a model-list response body into rows. Pure. */
export function normalizeModelList(
  style: DiscoveryStyle,
  body: unknown,
): DiscoveredEndpointModel[] {
  const record = asRecord(body);
  const rows: readonly unknown[] =
    style === "google_models"
      ? Array.isArray(record?.models)
        ? record.models
        : []
      : Array.isArray(record?.data)
        ? record.data
        : Array.isArray(body)
          ? body
          : Array.isArray(record?.models)
            ? record.models
            : [];
  const models: DiscoveredEndpointModel[] = [];
  const seen = new Set<string>();
  for (const entry of rows) {
    const item = asRecord(entry);
    const modelId = listedModelId(style, item);
    if (modelId === undefined || seen.has(modelId)) continue;
    seen.add(modelId);
    const displayName =
      style === "google_models"
        ? (trimmedText(item?.displayName) ?? modelId)
        : (trimmedText(item?.display_name) ?? trimmedText(item?.name) ?? modelId);
    const contextWindow = firstPositiveInteger(item, CONTEXT_WINDOW_KEYS);
    const maxTokens = firstPositiveInteger(item, MAX_TOKENS_KEYS);
    models.push({
      modelId,
      displayName,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    });
  }
  return models
    .sort((left, right) => left.modelId.localeCompare(right.modelId))
    .slice(0, MAX_MODELS);
}

const resolveEndpoint = (input: ProbeProviderModelsInput): ResolvedEndpoint => {
  const preset = matchNamedPreset({
    vendorKey: input.vendorKey,
    baseUrl: input.baseUrl,
    apiStyle: input.apiStyle,
  });
  const typed = input.baseUrl.trim() === "" ? (preset?.baseUrl ?? "") : input.baseUrl;
  const discoveryStyle =
    input.discoveryStyle ??
    discoveryStyleForService({
      vendorKey: input.vendorKey,
      baseUrl: typed,
      apiStyle: input.apiStyle,
    });
  // A token plan can speak Anthropic Messages and still publish an OpenAI model
  // list, so the base URL is normalized for the route the probe asks.
  const normalizationStyle: PiNativeApiStyle =
    discoveryStyle === "anthropic_models" ? "anthropic-messages" : "openai-completions";
  const normalized = typed.trim() === "" ? "" : normalizeBaseUrlInput(typed, normalizationStyle);
  return {
    baseUrl: normalized === "" ? PROTOCOL_DEFAULT_BASE_URLS[input.apiStyle] : normalized,
    discoveryStyle,
    preset,
  };
};

/** Base URLs worth asking, all on the origin the user typed. */
const candidateBaseUrls = (baseUrl: string): string[] => {
  const candidates: string[] = [];
  const push = (value: string): void => {
    const trimmed = value.replace(/\/+$/u, "");
    if (trimmed === "" || candidates.includes(trimmed)) return;
    candidates.push(trimmed);
  };
  push(baseUrl);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return candidates;
  }
  const path = url.pathname.replace(/\/+$/u, "");
  const root = path.replace(/\/v1$/iu, "");
  push(`${url.origin}${/\/v1$/iu.test(path) ? root : `${path}/v1`}`);
  push(`${url.origin}${root}`);
  return candidates.slice(0, MAX_BASE_URL_CANDIDATES);
};

const modelListUrl = (baseUrl: string, style: DiscoveryStyle): string => {
  const base = baseUrl.replace(/\/+$/u, "");
  if (style !== "anthropic_models") return `${base}/models`;
  // The Anthropic SDK appends `/v1`, so the probe must not repeat it.
  return `${base.endsWith("/v1") ? base : `${base}/v1`}/models`;
};

const authHeaders = (style: DiscoveryStyle, apiKey: string): Record<string, string> => {
  const key = apiKey.trim();
  if (style === "anthropic_models") {
    return {
      ...(key === "" ? {} : { "x-api-key": key }),
      "anthropic-version": ANTHROPIC_VERSION,
      accept: "application/json",
    };
  }
  if (style === "google_models") {
    return {
      ...(key === "" ? {} : { "x-goog-api-key": key }),
      accept: "application/json",
    };
  }
  return {
    ...(key === "" ? {} : { authorization: `Bearer ${key}` }),
    accept: "application/json",
  };
};

/** Merge case-insensitively so a user header can never shadow a transport one. */
const mergeHeaders = (
  base: Record<string, string>,
  extra: Record<string, string>,
): Record<string, string> => {
  const merged = new Map<string, string>();
  for (const [name, value] of Object.entries(base)) merged.set(name.toLowerCase(), value);
  for (const [name, value] of Object.entries(extra)) merged.set(name.toLowerCase(), value);
  return Object.fromEntries(merged);
};

const httpMessage = (status: number): string =>
  status === 401 || status === 403
    ? `The endpoint rejected the credential (HTTP ${status}). Check the API key.`
    : `The endpoint's model list request failed (HTTP ${status}).`;

const redirectTarget = (currentUrl: string, location: string): URL => {
  let next: URL;
  try {
    next = new URL(location, currentUrl);
  } catch {
    throw new PiNativeDiscoveryError({
      reason: "probe_failed",
      message: "The endpoint redirected to an invalid address.",
    });
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    throw new PiNativeDiscoveryError({
      reason: "probe_failed",
      message: "The endpoint redirected to an unsupported scheme.",
    });
  }
  if (next.username !== "" || next.password !== "") {
    throw new PiNativeDiscoveryError({
      reason: "probe_failed",
      message: "The endpoint redirected to a credentialed address.",
    });
  }
  return next;
};

interface ModelListResponse {
  readonly url: string;
  readonly status: number;
  readonly models: readonly DiscoveredEndpointModel[];
}

interface ModelListRequest {
  readonly baseUrl: string;
  readonly style: DiscoveryStyle;
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal;
}

/**
 * One model-list request. Redirects are followed by hand so a hop to another
 * origin drops the credential before it travels.
 */
const requestModelList = async (
  request: ModelListRequest,
  fetchImpl: typeof globalThis.fetch,
): Promise<ModelListResponse> => {
  let url = modelListUrl(request.baseUrl, request.style);
  let headers = request.headers;
  const origin = new URL(url).origin;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: request.signal,
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      const next = redirectTarget(url, location);
      // A credential and user headers stay on the origin they were meant for.
      if (next.origin !== origin) headers = {};
      url = next.toString();
      continue;
    }
    if (!response.ok) {
      throw new PiNativeDiscoveryError({
        reason: "probe_failed",
        message: httpMessage(response.status),
        status: response.status,
      });
    }
    return {
      url,
      status: response.status,
      models: normalizeModelList(request.style, await response.json()),
    };
  }
  throw new PiNativeDiscoveryError({
    reason: "probe_failed",
    message: "The endpoint redirected too many times.",
  });
};

interface ModelListSweep {
  /** The last candidate that answered with a body, if any. */
  readonly answered: ModelListResponse | undefined;
  /** The candidate whose answer is used, when one published models. */
  readonly winner: string | undefined;
  readonly lastStatus: number | undefined;
}

const sweepModelLists = async (args: {
  readonly baseUrl: string;
  readonly style: DiscoveryStyle;
  readonly headers: Record<string, string>;
  readonly fetchImpl: typeof globalThis.fetch;
}): Promise<ModelListSweep> => {
  const deadline = Date.now() + DISCOVERY_TOTAL_BUDGET_MS;
  let answered: ModelListResponse | undefined;
  let lastStatus: number | undefined;
  for (const candidate of candidateBaseUrls(args.baseUrl)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const response = await requestModelList(
        {
          baseUrl: candidate,
          style: args.style,
          headers: args.headers,
          signal: AbortSignal.timeout(Math.min(DISCOVERY_TIMEOUT_MS, remaining)),
        },
        args.fetchImpl,
      );
      answered = response;
      lastStatus = response.status;
      if (response.models.length > 0) {
        return { answered: response, winner: candidate, lastStatus };
      }
    } catch (error) {
      if (!isPiNativeDiscoveryError(error)) throw error;
      lastStatus = error.status;
      // A refused credential is final: the key must not travel to another shape.
      if (error.status === 401 || error.status === 403) {
        throw new PiNativeDiscoveryError({
          reason: "authentication_failed",
          message: error.message,
          status: error.status,
        });
      }
      // No HTTP status means the host itself is unreachable, not a URL shape.
      if (error.status === undefined) throw error;
    }
  }
  return { answered, winner: undefined, lastStatus };
};

const canSkipDiscovery = (endpoint: ResolvedEndpoint): boolean =>
  endpoint.discoveryStyle === "anthropic_models" ||
  (endpoint.preset !== undefined && TOKEN_PLAN_PRESET_IDS.has(endpoint.preset.id));

/**
 * Ask a configured endpoint what it serves and enrich the rows from the
 * catalog. Endpoint-reported limits outrank the catalog's own numbers.
 */
export async function probeProviderModels(
  input: ProbeProviderModelsInput,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  catalog: ModelsDevCatalog = getDefaultModelsDevCatalog(),
): Promise<ProbeModelsResult> {
  const endpoint = resolveEndpoint(input);
  const issue = getBaseUrlIssue(endpoint.baseUrl);
  if (issue !== undefined) {
    throw new PiNativeDiscoveryError({ reason: "invalid_endpoint", message: issue });
  }
  if (endpoint.baseUrl === "") {
    return {
      models: [],
      rawModels: [],
      effectiveBaseUrl: "",
      discoveryStyle: endpoint.discoveryStyle,
      skippedDiscovery: true,
      warning: "Enter a Base URL to list models.",
    };
  }
  const baseHeaders = authHeaders(endpoint.discoveryStyle, input.apiKey ?? "");
  if (
    isOpenCodeEndpoint({
      apiStyle: input.apiStyle,
      vendorKey: input.vendorKey,
      baseUrl: endpoint.baseUrl,
    })
  ) {
    // @effect-diagnostics-next-line cryptoRandomUUID:off -- Probes run outside Effect and only need an ephemeral routing token.
    baseHeaders[OPENCODE_SESSION_HEADER] = `pi-native-probe-${globalThis.crypto.randomUUID()}`;
  }
  const headers = mergeHeaders(baseHeaders, sanitizeProviderHeaders(input.headers));
  const sweep = await sweepModelLists({
    baseUrl: endpoint.baseUrl,
    style: endpoint.discoveryStyle,
    headers,
    fetchImpl,
  });
  const effectiveBaseUrl = sweep.winner ?? endpoint.baseUrl;
  const rawModels = sweep.answered?.models ?? [];

  if (rawModels.length === 0) {
    if (sweep.answered !== undefined) {
      return {
        models: [],
        rawModels: [],
        effectiveBaseUrl,
        ...(effectiveBaseUrl === endpoint.baseUrl ? {} : { resolvedFrom: endpoint.baseUrl }),
        discoveryStyle: endpoint.discoveryStyle,
        warning:
          "The endpoint responded successfully but returned no models. Add model IDs manually.",
      };
    }
    const missingList = sweep.lastStatus === 404 || sweep.lastStatus === 405;
    if (missingList && canSkipDiscovery(endpoint)) {
      return {
        models: [],
        rawModels: [],
        effectiveBaseUrl,
        discoveryStyle: endpoint.discoveryStyle,
        skippedDiscovery: true,
        warning: NO_MODEL_LIST_WARNING,
      };
    }
    throw new PiNativeDiscoveryError({
      reason: "probe_failed",
      message:
        sweep.lastStatus === undefined
          ? "The endpoint could not be reached."
          : httpMessage(sweep.lastStatus),
      ...(sweep.lastStatus === undefined ? {} : { status: sweep.lastStatus }),
    });
  }

  const models = await catalog.enrichDiscoveredModels(rawModels, input.vendorKey);
  return {
    models,
    rawModels,
    effectiveBaseUrl,
    ...(effectiveBaseUrl === endpoint.baseUrl ? {} : { resolvedFrom: endpoint.baseUrl }),
    discoveryStyle: endpoint.discoveryStyle,
  };
}

const describeFailure = (error: unknown): string =>
  isPiNativeDiscoveryError(error) ? error.message : "The endpoint could not be reached.";

export async function testProviderConnection(
  input: ProbeProviderModelsInput,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  catalog: ModelsDevCatalog = getDefaultModelsDevCatalog(),
): Promise<TestConnectionResult> {
  const startedAt = Date.now();
  const endpoint = resolveEndpoint(input);
  try {
    const probed = await probeProviderModels(input, fetchImpl, catalog);
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      effectiveBaseUrl: probed.effectiveBaseUrl,
      modelCount: probed.models.length,
      ...(probed.warning === undefined ? {} : { warning: probed.warning }),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      effectiveBaseUrl: endpoint.baseUrl,
      error: describeFailure(error),
    };
  }
}
