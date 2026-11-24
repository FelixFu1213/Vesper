// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- The catalog cache is a filesystem boundary, and its timestamps are cache metadata.
/**
 * Server-side models.dev catalog for Pi Native: the bundled offline snapshot,
 * an optional disk cache and remote refresh, plus pi-ai built-in records as a
 * secondary baseline. Browser clients never load this module.
 */

import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import bundledModelsDev from "../../catalog/bundledModelsDev.json" with { type: "json" };
import {
  CATALOG_DEFAULT_CONTEXT_WINDOW,
  CATALOG_DEFAULT_MAX_TOKENS,
  sortThinkingLevels,
  type ModelInputModality,
  type PiNativeBundledModel,
  type PiNativeBundledModelsDev,
  type PiNativeBundledVendor,
  type PiNativeModelInfo,
  type ThinkingLevel,
} from "../../catalog/modelCatalog.ts";
import { PI_NATIVE_VENDOR_PRESETS, thinkingProtocolForModel } from "../../catalog/presets.ts";
import type { DiscoveredEndpointModel } from "./modelDiscovery.ts";

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const MODELS_DEV_TIMEOUT_MS = 10_000;
const CACHE_FILE_NAME = "pi-native-models-dev-cache.json";
const MODEL_INPUT_MODALITIES: ReadonlySet<string> = new Set([
  "text",
  "image",
  "pdf",
  "audio",
  "video",
]);

export interface ModelsDevCatalogDeps {
  /** Directory that holds the cache file; without one nothing is persisted. */
  readonly stateDir?: string | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly now?: (() => number) | undefined;
}

export interface ModelsDevCatalogStatus {
  readonly loaded: boolean;
  readonly source: "bundled" | "remote" | "empty";
  readonly fetchedAt?: string | undefined;
  readonly providerCount: number;
  readonly modelCount: number;
  readonly lastError?: string | undefined;
}

export interface ModelsDevCatalogRefreshResult {
  readonly status: ModelsDevCatalogStatus;
  readonly updated: boolean;
}

/** One catalog record plus the source that published it. */
interface CatalogRecord {
  readonly info: PiNativeModelInfo;
  readonly source: "models.dev" | "pi-ai";
}

interface CatalogIndex {
  readonly byVendor: ReadonlyMap<string, ReadonlyMap<string, CatalogRecord>>;
  readonly byLeaf: ReadonlyMap<string, readonly CatalogRecord[]>;
  readonly providerCount: number;
  readonly modelCount: number;
}

export interface ModelsDevCatalog {
  readonly ensureLoaded: () => Promise<boolean>;
  readonly getStatus: () => ModelsDevCatalogStatus;
  readonly refresh: () => Promise<ModelsDevCatalogRefreshResult>;
  readonly lookupModel: (
    modelId: string,
    vendorKey?: string | undefined,
  ) => Promise<PiNativeModelInfo | undefined>;
  readonly enrichDiscoveredModels: (
    discovered: readonly DiscoveredEndpointModel[],
    vendorKey?: string | undefined,
  ) => Promise<PiNativeModelInfo[]>;
}

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

const trimmedText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const normalizeModelId = (value: string): string => value.trim().toLowerCase();

/** Last `/`-segment of an id: what a gateway prefix leaves of the published name. */
const leafOf = (value: string): string => value.slice(value.lastIndexOf("/") + 1);

const RELEASE_STAMP = /(?:[-_@])(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{4}\.\d{2}\.\d{2})$/u;

const stripReleaseStamp = (value: string): string => value.replace(RELEASE_STAMP, "");

const modalitiesFrom = (value: unknown): ModelInputModality[] => {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set<ModelInputModality>();
  for (const entry of raw) {
    if (typeof entry !== "string" || !MODEL_INPUT_MODALITIES.has(entry)) continue;
    seen.add(entry as ModelInputModality);
  }
  return seen.size === 0 ? ["text"] : [...seen];
};

/** Trim one bundled vendor row, dropping anything the catalog contract omits. */
const trimVendorModels = (value: unknown): Record<string, PiNativeBundledModel> => {
  const models: Record<string, PiNativeBundledModel> = {};
  for (const [key, entry] of Object.entries(asRecord(value) ?? {})) {
    const model = asRecord(entry);
    const id = trimmedText(model?.id) ?? trimmedText(key);
    if (model === undefined || id === undefined) continue;
    const modalities = asRecord(model.modalities);
    models[key] = {
      id,
      name: trimmedText(model.name) ?? id,
      family: trimmedText(model.family),
      reasoning: model.reasoning === true,
      tool_call: model.tool_call === true,
      attachment: model.attachment === true,
      modalities: {
        input: Array.isArray(modalities?.input)
          ? modalities.input.filter((item): item is string => typeof item === "string")
          : [],
        output: Array.isArray(modalities?.output)
          ? modalities.output.filter((item): item is string => typeof item === "string")
          : [],
      },
      limit: {
        context: positiveInteger(asRecord(model.limit)?.context) ?? 0,
        output: positiveInteger(asRecord(model.limit)?.output) ?? 0,
      },
      interleaved: model.interleaved === true,
    };
  }
  return models;
};

/** Trim a models.dev payload to the fields the bundled snapshot carries. */
const trimModelsDev = (payload: unknown): PiNativeBundledModelsDev => {
  const vendors: Record<string, PiNativeBundledVendor> = {};
  for (const [vendorKey, entry] of Object.entries(asRecord(payload) ?? {})) {
    const vendor = asRecord(entry);
    if (vendor === undefined) continue;
    const models = trimVendorModels(vendor.models);
    if (Object.keys(models).length === 0) continue;
    vendors[vendorKey] = {
      id: trimmedText(vendor.id) ?? vendorKey,
      name: trimmedText(vendor.name) ?? vendorKey,
      models,
    };
  }
  return vendors;
};

const bundledTrimmed = (): PiNativeBundledModelsDev => trimModelsDev(bundledModelsDev as unknown);

const infoFromBundled = (vendorKey: string, model: PiNativeBundledModel): PiNativeModelInfo => {
  const reasoning = model.reasoning === true;
  const protocol = reasoning ? thinkingProtocolForModel(model.id) : undefined;
  const supportedThinkingLevels: ThinkingLevel[] | undefined =
    protocol === undefined
      ? undefined
      : protocol === "adaptive"
        ? ["low", "medium", "high", "max"]
        : ["low", "medium", "high"];
  return {
    modelId: model.id,
    displayName: trimmedText(model.name) ?? model.id,
    vendorKey,
    ...(model.family === undefined ? {} : { family: model.family }),
    reasoning,
    toolCall: model.tool_call !== false,
    attachment: model.attachment === true,
    inputModalities: modalitiesFrom(model.modalities?.input),
    contextWindow: positiveInteger(model.limit?.context) ?? 0,
    maxTokens: positiveInteger(model.limit?.output) ?? 0,
    ...(supportedThinkingLevels === undefined ? {} : { supportedThinkingLevels }),
    ...(protocol === undefined ? {} : { thinkingProtocol: protocol }),
    catalogSource: "models.dev",
  };
};

const infoFromPiAi = (model: Model<Api>): PiNativeModelInfo => {
  const reasoning = model.reasoning === true;
  const levels = reasoning
    ? sortThinkingLevels(
        getSupportedThinkingLevels(model).filter(
          (level): level is ThinkingLevel => level !== "off",
        ),
      )
    : [];
  return {
    modelId: model.id,
    displayName: trimmedText(model.name) ?? model.id,
    vendorKey: model.provider,
    reasoning,
    toolCall: true,
    attachment: model.input.includes("image"),
    inputModalities: modalitiesFrom(model.input),
    contextWindow: positiveInteger(model.contextWindow) ?? 0,
    maxTokens: positiveInteger(model.maxTokens) ?? 0,
    ...(levels.length > 0 ? { supportedThinkingLevels: levels } : {}),
    ...(reasoning ? { thinkingProtocol: thinkingProtocolForModel(model.id) } : {}),
    catalogSource: "pi-ai",
  };
};

/** Fill every field the primary record states nothing about from the secondary one. */
const mergeRecords = (primary: CatalogRecord, secondary: CatalogRecord): CatalogRecord => {
  const left = primary.info;
  const right = secondary.info;
  const preferSecondaryLevels =
    primary.source === "models.dev" &&
    secondary.source === "pi-ai" &&
    (right.supportedThinkingLevels?.length ?? 0) > 0;
  const supportedThinkingLevels = preferSecondaryLevels
    ? right.supportedThinkingLevels
    : (left.supportedThinkingLevels ?? right.supportedThinkingLevels);
  return {
    source: primary.source,
    info: {
      ...left,
      attachment: left.attachment || right.attachment,
      inputModalities:
        left.inputModalities.length === 0 ? right.inputModalities : left.inputModalities,
      contextWindow: left.contextWindow > 0 ? left.contextWindow : right.contextWindow,
      maxTokens: left.maxTokens > 0 ? left.maxTokens : right.maxTokens,
      ...(left.family === undefined && right.family !== undefined ? { family: right.family } : {}),
      ...(supportedThinkingLevels === undefined ? {} : { supportedThinkingLevels }),
    },
  };
};

const buildIndex = (catalog: PiNativeBundledModelsDev): CatalogIndex => {
  const byVendor = new Map<string, Map<string, CatalogRecord>>();
  let providerCount = 0;
  let modelCount = 0;

  const put = (vendorKey: string, record: CatalogRecord): void => {
    const key = normalizeModelId(vendorKey);
    let bucket = byVendor.get(key);
    if (bucket === undefined) {
      bucket = new Map();
      byVendor.set(key, bucket);
    }
    const modelKey = normalizeModelId(record.info.modelId);
    const existing = bucket.get(modelKey);
    if (existing === undefined) {
      bucket.set(modelKey, record);
      return;
    }
    bucket.set(modelKey, mergeRecords(existing, record));
  };

  for (const [vendorKey, vendor] of Object.entries(catalog)) {
    providerCount += 1;
    for (const model of Object.values(vendor.models)) {
      modelCount += 1;
      put(vendorKey, { info: infoFromBundled(vendorKey, model), source: "models.dev" });
    }
  }

  for (const provider of getBuiltinProviders()) {
    for (const model of getBuiltinModels(provider)) {
      // models.dev states richer modalities and limits, so it keeps precedence.
      put(model.provider, { info: infoFromPiAi(model), source: "pi-ai" });
    }
  }

  const byLeaf = new Map<string, CatalogRecord[]>();
  for (const bucket of byVendor.values()) {
    for (const record of bucket.values()) {
      const leaf = normalizeModelId(leafOf(record.info.modelId));
      const bucketForLeaf = byLeaf.get(leaf);
      if (bucketForLeaf === undefined) byLeaf.set(leaf, [record]);
      else bucketForLeaf.push(record);
    }
  }

  return { byVendor, byLeaf, providerCount, modelCount };
};

const EMPTY_INDEX: CatalogIndex = {
  byVendor: new Map(),
  byLeaf: new Map(),
  providerCount: 0,
  modelCount: 0,
};

/** Vendor spellings a lookup may try: the key itself, its presets and aliases. */
const vendorKeyCandidates = (vendorKey: string | undefined): string[] => {
  const requested = normalizeModelId(vendorKey ?? "");
  if (requested === "") return [];
  const keys: string[] = [requested];
  const push = (value: string | undefined): void => {
    const key = normalizeModelId(value ?? "");
    if (key !== "" && !keys.includes(key)) keys.push(key);
  };
  for (const preset of PI_NATIVE_VENDOR_PRESETS) {
    const spellings = [preset.id, preset.vendorKey, ...(preset.aliases ?? [])].map(
      normalizeModelId,
    );
    if (!spellings.includes(requested)) continue;
    for (const spelling of spellings) push(spelling);
  }
  return keys;
};

/** The single record a leaf names, or nothing when the catalog contradicts itself. */
const unambiguousRecord = (
  records: readonly CatalogRecord[] | undefined,
  preferredVendors: readonly string[],
): CatalogRecord | undefined => {
  if (records === undefined || records.length === 0) return undefined;
  const distinct = new Set(records.map((record) => normalizeModelId(record.info.modelId)));
  if (distinct.size !== 1) return undefined;
  for (const vendor of preferredVendors) {
    const match = records.find(
      (record) => normalizeModelId(record.info.vendorKey ?? "") === vendor,
    );
    if (match !== undefined) return match;
  }
  return records[0];
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim() !== "") {
    // Only the name and message: a fetch cause can carry the request URL.
    return error.name === "Error" ? error.message : `${error.name}: ${error.message}`;
  }
  return "The models.dev catalog update failed.";
};

const readCache = async (
  cachePath: string,
): Promise<{ fetchedAt: string; data: PiNativeBundledModelsDev } | undefined> => {
  const raw: unknown = JSON.parse(await NodeFSP.readFile(cachePath, "utf8"));
  const record = asRecord(raw);
  const fetchedAt = trimmedText(record?.fetchedAt);
  if (record === undefined || fetchedAt === undefined) return undefined;
  const data = trimModelsDev(record.data);
  return Object.keys(data).length === 0 ? undefined : { fetchedAt, data };
};

const writeCache = async (cachePath: string, payload: string): Promise<void> => {
  await NodeFSP.mkdir(NodePath.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.tmp`;
  await NodeFSP.writeFile(temporaryPath, payload, "utf8");
  await NodeFSP.rename(temporaryPath, cachePath);
};

export function createModelsDevCatalog(deps: ModelsDevCatalogDeps = {}): ModelsDevCatalog {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const nowMs = deps.now ?? (() => Date.now());
  const cachePath =
    deps.stateDir === undefined ? undefined : NodePath.join(deps.stateDir, CACHE_FILE_NAME);

  let index: CatalogIndex = EMPTY_INDEX;
  let loaded = false;
  let source: ModelsDevCatalogStatus["source"] = "empty";
  let fetchedAt: string | undefined;
  let lastError: string | undefined;
  let loadPromise: Promise<boolean> | undefined;

  const getStatus = (): ModelsDevCatalogStatus => ({
    loaded,
    source,
    ...(fetchedAt === undefined ? {} : { fetchedAt }),
    providerCount: index.providerCount,
    modelCount: index.modelCount,
    ...(lastError === undefined ? {} : { lastError }),
  });

  const load = async (): Promise<boolean> => {
    if (cachePath !== undefined) {
      try {
        const cached = await readCache(cachePath);
        if (cached !== undefined) {
          index = buildIndex(cached.data);
          loaded = true;
          source = "remote";
          fetchedAt = cached.fetchedAt;
          return true;
        }
      } catch {
        // A missing or corrupt cache is not a failure: the bundled snapshot answers.
      }
    }
    index = buildIndex(bundledTrimmed());
    loaded = true;
    source = index.providerCount === 0 ? "empty" : "bundled";
    return true;
  };

  const ensureLoaded = (): Promise<boolean> => {
    if (loaded) return Promise.resolve(true);
    if (loadPromise === undefined) {
      loadPromise = load().finally(() => {
        loadPromise = undefined;
      });
    }
    return loadPromise;
  };

  const refresh = async (): Promise<ModelsDevCatalogRefreshResult> => {
    await ensureLoaded();
    try {
      const response = await fetchImpl(MODELS_DEV_API_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`models.dev catalog request failed (${response.status})`);
      }
      const trimmed = trimModelsDev(await response.json());
      const next = buildIndex(trimmed);
      if (next.providerCount === 0) {
        throw new Error("models.dev catalog published no usable providers.");
      }
      index = next;
      loaded = true;
      source = "remote";
      fetchedAt = new Date(nowMs()).toISOString();
      lastError = undefined;
      if (cachePath !== undefined) {
        const payload = JSON.stringify({ fetchedAt, data: trimmed });
        // The cache only speeds up the next start, so a write failure is not an error.
        await writeCache(cachePath, payload).catch(() => undefined);
      }
      return { status: getStatus(), updated: true };
    } catch (error) {
      // The loaded catalog stays intact: a failed update must not empty the picker.
      lastError = errorMessage(error);
      return { status: getStatus(), updated: false };
    }
  };

  const lookupLoaded = (
    modelId: string,
    vendorKey: string | undefined,
  ): PiNativeModelInfo | undefined => {
    const requested = normalizeModelId(modelId);
    if (requested === "") return undefined;
    const leaf = normalizeModelId(leafOf(requested));
    const vendors = vendorKeyCandidates(vendorKey);

    for (const vendor of vendors) {
      const bucket = index.byVendor.get(vendor);
      if (bucket === undefined) continue;
      const record = bucket.get(requested) ?? bucket.get(leaf);
      if (record !== undefined) return record.info;
    }

    const byLeaf =
      unambiguousRecord(index.byLeaf.get(leaf), vendors) ??
      unambiguousRecord(index.byLeaf.get(stripReleaseStamp(leaf)), vendors);
    return byLeaf?.info;
  };

  const lookupModel = async (
    modelId: string,
    vendorKey?: string | undefined,
  ): Promise<PiNativeModelInfo | undefined> => {
    await ensureLoaded();
    return lookupLoaded(modelId, vendorKey);
  };

  const enrichDiscoveredModels = async (
    discovered: readonly DiscoveredEndpointModel[],
    vendorKey?: string | undefined,
  ): Promise<PiNativeModelInfo[]> => {
    await ensureLoaded();
    const requestedVendor = vendorKey?.trim() ?? "";
    return discovered.map((model) => {
      const enriched = lookupLoaded(model.modelId, vendorKey);
      const rawDisplay = trimmedText(model.displayName);
      const endpointHasLabel =
        rawDisplay !== undefined && rawDisplay.toLowerCase() !== model.modelId.trim().toLowerCase();
      const displayName = endpointHasLabel
        ? rawDisplay
        : (trimmedText(enriched?.displayName) ?? rawDisplay ?? model.modelId);
      const recordVendor = requestedVendor === "" ? enriched?.vendorKey : requestedVendor;
      return {
        modelId: model.modelId,
        displayName: displayName ?? model.modelId,
        ...(recordVendor === undefined ? {} : { vendorKey: recordVendor }),
        ...(enriched?.family === undefined ? {} : { family: enriched.family }),
        ...(enriched?.description === undefined ? {} : { description: enriched.description }),
        reasoning: enriched?.reasoning ?? false,
        toolCall: enriched?.toolCall ?? true,
        attachment: enriched?.attachment ?? false,
        inputModalities: enriched?.inputModalities ?? ["text"],
        contextWindow:
          positiveInteger(model.contextWindow) ??
          positiveInteger(enriched?.contextWindow) ??
          CATALOG_DEFAULT_CONTEXT_WINDOW,
        maxTokens:
          positiveInteger(model.maxTokens) ??
          positiveInteger(enriched?.maxTokens) ??
          CATALOG_DEFAULT_MAX_TOKENS,
        ...(enriched?.supportedThinkingLevels === undefined
          ? {}
          : { supportedThinkingLevels: enriched.supportedThinkingLevels }),
        ...(enriched?.thinkingProtocol === undefined
          ? {}
          : { thinkingProtocol: enriched.thinkingProtocol }),
        ...(enriched?.defaultTemperature === undefined
          ? {}
          : { defaultTemperature: enriched.defaultTemperature }),
        catalogSource: enriched?.catalogSource ?? "discovered",
      };
    });
  };

  return { ensureLoaded, getStatus, refresh, lookupModel, enrichDiscoveredModels };
}

let defaultCatalog: ModelsDevCatalog | undefined;

/** Shared bundled catalog used by discovery when no configured catalog is passed. */
export function getDefaultModelsDevCatalog(): ModelsDevCatalog {
  defaultCatalog ??= createModelsDevCatalog();
  return defaultCatalog;
}
