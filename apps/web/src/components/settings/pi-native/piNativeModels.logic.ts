import { msg } from "gt-react";
import { m } from "../../../i18n/messages";
import {
  isSecretReference,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type CustomModelSetting,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import {
  PI_NATIVE_API_STYLES,
  PI_NATIVE_VENDOR_PRESETS,
  RESERVED_PROVIDER_HEADERS,
  modelMatchesFilter,
  normalizeBaseUrlInput,
  type ModelFilter,
  type PiNativeApiStyle,
  type PiNativeModelBinding,
  type PiNativeModelInfo,
  type PiNativeVendorPreset,
  type SessionThinkingLevel,
  type ThinkingLevel,
  type ThinkingProtocol,
} from "@t3tools/client-runtime/pi-native-catalog";

/** The driver kind whose services this workbench owns. */
export const PI_NATIVE_DRIVER_KIND = ProviderDriverKind.make("piNative");

const PI_NATIVE_CUSTOM_SERVICE_ID = "custom";
const PI_NATIVE_CUSTOM_VENDOR_KEY = "custom";
/** Aliases are persisted verbatim, so the cap counts code points, not UTF-16 units. */
const MODEL_ALIAS_MAX_CODE_POINTS = 60;

const DEFAULT_API_STYLE: PiNativeApiStyle = "openai-responses";
const API_STYLE_VALUES: ReadonlySet<string> = new Set(
  PI_NATIVE_API_STYLES.map((style) => style.value),
);
const THINKING_LEVEL_VALUES: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const THINKING_PROTOCOL_VALUES: ReadonlySet<string> = new Set(["legacy", "adaptive"]);
const LIMIT_SOURCE_VALUES: ReadonlySet<string> = new Set(["catalog", "user"]);
const RESERVED_HEADER_SET: ReadonlySet<string> = new Set(
  RESERVED_PROVIDER_HEADERS.map((name) => name.toLowerCase()),
);

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

const readText = (value: unknown): string => (typeof value === "string" ? value : "");
const readOptionalText = (value: unknown): string | undefined => {
  const text = readText(value).trim();
  return text === "" ? undefined : text;
};
const readBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;
const readOptionalBoolean = (value: unknown): boolean | null | undefined =>
  typeof value === "boolean" ? value : value === null ? null : undefined;
const readCount = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;

/** A stored wire style the client no longer knows falls back to the default. */
function readApiStyle(value: unknown): PiNativeApiStyle {
  return typeof value === "string" && API_STYLE_VALUES.has(value)
    ? (value as PiNativeApiStyle)
    : DEFAULT_API_STYLE;
}

function readThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === "string" && THINKING_LEVEL_VALUES.has(value)
    ? (value as ThinkingLevel)
    : undefined;
}

function readSessionThinkingLevel(value: unknown): SessionThinkingLevel | null {
  if (value === "omit") return "omit";
  return readThinkingLevel(value) ?? null;
}

function readThinkingProtocol(value: unknown): ThinkingProtocol | undefined {
  return typeof value === "string" && THINKING_PROTOCOL_VALUES.has(value)
    ? (value as ThinkingProtocol)
    : undefined;
}

function readLimitSource(value: unknown): "catalog" | "user" | undefined {
  return typeof value === "string" && LIMIT_SOURCE_VALUES.has(value)
    ? (value as "catalog" | "user")
    : undefined;
}

function readThinkingLevels(value: unknown): ThinkingLevel[] {
  if (!Array.isArray(value)) return [];
  const levels: ThinkingLevel[] = [];
  for (const entry of value) {
    const level = readThinkingLevel(entry);
    if (level !== undefined && !levels.includes(level)) levels.push(level);
  }
  return levels;
}

/** One stored binding, or `undefined` when its wire id is missing. */
function readModelBinding(value: unknown): PiNativeModelBinding | undefined {
  const record = asRecord(value);
  const id = readText(record.id).trim();
  if (id === "") return undefined;
  const displayName = readOptionalText(record.displayName);
  const alias = readOptionalText(record.alias);
  const thinkingProtocol = readThinkingProtocol(record.thinkingProtocol);
  const contextWindowSource = readLimitSource(record.contextWindowSource);
  const maxTokensSource = readLimitSource(record.maxTokensSource);
  return {
    id,
    ...(displayName === undefined ? {} : { displayName }),
    ...(alias === undefined ? {} : { alias }),
    contextWindow: readCount(record.contextWindow, 0),
    ...(contextWindowSource === undefined ? {} : { contextWindowSource }),
    maxTokens: readCount(record.maxTokens, 0),
    ...(maxTokensSource === undefined ? {} : { maxTokensSource }),
    thinkingLevels: readThinkingLevels(record.thinkingLevels),
    defaultThinkingLevel: readSessionThinkingLevel(record.defaultThinkingLevel),
    ...(thinkingProtocol === undefined ? {} : { thinkingProtocol }),
    supportsReasoningEffort: readOptionalBoolean(record.supportsReasoningEffort),
    supportsImages: readOptionalBoolean(record.supportsImages),
    supportsDocuments: readOptionalBoolean(record.supportsDocuments),
    ...(typeof record.availableForSubagents === "boolean"
      ? { availableForSubagents: record.availableForSubagents }
      : {}),
  };
}

function readModelBindings(value: unknown): PiNativeModelBinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const binding = readModelBinding(entry);
    return binding === undefined ? [] : [binding];
  });
}

function readHeaders(value: unknown): Record<string, string> {
  const record = asRecord(value);
  const headers: Record<string, string> = {};
  for (const [name, raw] of Object.entries(record)) {
    if (typeof raw !== "string") continue;
    const trimmed = name.trim();
    if (trimmed === "") continue;
    headers[trimmed] = raw;
  }
  return headers;
}

function readCustomModels(value: unknown): CustomModelSetting[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return entry.trim() === "" ? [] : [entry];
    const record = asRecord(entry);
    if (readOptionalText(record.slug) === undefined) return [];
    return [entry as CustomModelSetting];
  });
}

function readSecret(value: unknown): SettingsSecretValue {
  if (isSecretReference(value)) return value;
  return readText(value);
}

/** One Pi Native service as the workbench and its dialog hold it. */
export interface PiNativeServiceConfig {
  readonly vendorKey: string;
  readonly apiStyle: PiNativeApiStyle;
  readonly baseUrl: string;
  readonly apiKey: SettingsSecretValue;
  readonly headers: Readonly<Record<string, string>>;
  readonly defaultModel: string;
  readonly modelBindings: ReadonlyArray<PiNativeModelBinding>;
  readonly sortOrder: number | undefined;
  readonly autoCompact: boolean;
  readonly infiniteRetry: boolean;
  readonly enableSubagents: boolean;
  readonly customModels: ReadonlyArray<CustomModelSetting>;
}

export interface PiNativeService extends PiNativeServiceConfig {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly displayName: string;
  readonly enabled: boolean;
}

/** Decode a stored `config` blob without trusting its shape. */
export function readPiNativeServiceConfig(config: unknown): PiNativeServiceConfig {
  const record = asRecord(config);
  const sortOrder =
    typeof record.sortOrder === "number" && Number.isFinite(record.sortOrder)
      ? record.sortOrder
      : undefined;
  return {
    vendorKey: readText(record.vendorKey).trim(),
    apiStyle: readApiStyle(record.apiStyle),
    baseUrl: readText(record.baseUrl).trim(),
    apiKey: readSecret(record.apiKey),
    headers: readHeaders(record.headers),
    defaultModel: readText(record.defaultModel).trim(),
    modelBindings: readModelBindings(record.modelBindings),
    sortOrder,
    autoCompact: readBoolean(record.autoCompact, true),
    infiniteRetry: readBoolean(record.infiniteRetry, false),
    enableSubagents: readBoolean(record.enableSubagents, true),
    customModels: readCustomModels(record.customModels),
  };
}

/** Whether a stored key can be reused without the user retyping it. */
export function hasStoredApiKey(apiKey: SettingsSecretValue | undefined): boolean {
  if (apiKey === undefined) return false;
  if (isSecretReference(apiKey)) return true;
  return apiKey.trim() !== "";
}

/**
 * Configured Pi Native services in sidebar order: explicit `sortOrder` first,
 * then the settings map's own key order for rows that never got one.
 */
export function listPiNativeServices(
  providerInstances: ProviderInstanceConfigMap | undefined,
): ReadonlyArray<PiNativeService> {
  const entries = Object.entries(providerInstances ?? {}) as Array<
    [string, ProviderInstanceConfig]
  >;
  const services: Array<PiNativeService & { readonly position: number }> = [];
  entries.forEach(([rawId, instance], position) => {
    if (instance.driver !== PI_NATIVE_DRIVER_KIND) return;
    const config = readPiNativeServiceConfig(instance.config);
    services.push({
      ...config,
      instanceId: ProviderInstanceId.make(rawId),
      instance,
      displayName: instance.displayName?.trim() ?? "",
      enabled: resolveProviderInstanceEnabled(instance),
      position,
    });
  });
  return services
    .slice()
    .sort((left, right) => {
      const order =
        (left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER);
      return order !== 0 ? order : left.position - right.position;
    })
    .map(({ position: _position, ...service }) => service);
}

/** The preset a stored service was created from, when it still matches one. */
export function presetForService(
  service: Pick<PiNativeServiceConfig, "vendorKey" | "baseUrl" | "apiStyle">,
  presets: ReadonlyArray<PiNativeVendorPreset> = PI_NATIVE_VENDOR_PRESETS,
): PiNativeVendorPreset | undefined {
  const vendorKey = service.vendorKey.trim().toLowerCase();
  if (vendorKey !== "") {
    const byKey = presets.filter(
      (preset) => preset.vendorKey === vendorKey || preset.id === vendorKey,
    );
    const byStyle = byKey.find((preset) => preset.apiStyle === service.apiStyle);
    if (byStyle !== undefined) return byStyle;
    if (byKey.length === 1) return byKey[0];
  }
  const baseUrl = normalizeBaseUrlInput(service.baseUrl, service.apiStyle).toLowerCase();
  if (baseUrl === "") return undefined;
  return presets.find(
    (preset) => normalizeBaseUrlInput(preset.baseUrl, preset.apiStyle).toLowerCase() === baseUrl,
  );
}

/** Service display label: the user's own name, else the matched preset, else the id. */
export function serviceDisplayLabel(
  service: Pick<PiNativeServiceConfig, "vendorKey" | "baseUrl" | "apiStyle"> & {
    readonly displayName?: string | undefined;
    readonly instanceId?: ProviderInstanceId | undefined;
  },
): string {
  const name = service.displayName?.trim() ?? "";
  if (name !== "") return name;
  const preset = presetForService(service);
  if (preset !== undefined) return preset.name;
  return service.instanceId === undefined ? m(msg("Pi Native")) : String(service.instanceId);
}

const slugForVendor = (value: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^[_-]+/u, "")
    .replace(/[_-]+$/u, "");
  return slug === "" ? PI_NATIVE_CUSTOM_SERVICE_ID : slug;
};

/** A fresh `piNative_*` instance id that no other provider instance uses yet. */
export function derivePiNativeInstanceId(
  vendorKey: string | undefined,
  existingIds: Iterable<string>,
): ProviderInstanceId {
  const taken = new Set(Array.from(existingIds, (id) => id));
  const base = `piNative_${slugForVendor(vendorKey ?? PI_NATIVE_CUSTOM_VENDOR_KEY)}`;
  if (!taken.has(base)) return ProviderInstanceId.make(base);
  let suffix = 2;
  while (taken.has(`${base}_${suffix}`)) suffix += 1;
  return ProviderInstanceId.make(`${base}_${suffix}`);
}

/** `Name Copy`, without stacking a second `Copy` on a name that already says it. */
export function copyServiceName(displayName: string): string {
  const name = displayName.trim();
  return name === "" ? m(msg("Copy")) : `${name} ${m(msg("Copy"))}`;
}

/** A copy carries everything but the credential, which belongs to the source row. */
export function copyServiceDraft(service: PiNativeServiceConfig): PiNativeServiceConfig {
  return { ...service, apiKey: "", sortOrder: undefined };
}

/** Keep a model alias inside the persisted budget, counted in code points. */
export function clampModelAlias(value: string): string {
  const codePoints = [...value];
  return codePoints.length <= MODEL_ALIAS_MAX_CODE_POINTS
    ? value
    : codePoints.slice(0, MODEL_ALIAS_MAX_CODE_POINTS).join("");
}

/** Move one entry of a list to another index, returning a new array. */
export function moveListEntry<T>(
  entries: ReadonlyArray<T>,
  from: number,
  to: number,
): ReadonlyArray<T> {
  if (from === to) return entries;
  const next = entries.slice();
  const [entry] = next.splice(from, 1);
  if (entry === undefined) return entries;
  next.splice(Math.min(Math.max(to, 0), next.length), 0, entry);
  return next;
}

/** Sort order values that match a new drag-and-drop arrangement, from zero. */
export function buildReorderSortUpdates(
  orderedInstanceIds: ReadonlyArray<ProviderInstanceId>,
): Readonly<Record<string, number>> {
  const updates: Record<string, number> = {};
  orderedInstanceIds.forEach((instanceId, index) => {
    updates[instanceId] = index;
  });
  return updates;
}

/**
 * The whole `providerInstances` map with Pi Native order rewritten. The
 * settings patch replaces this map, so non-Pi-Native rows ride along untouched.
 */
export function applySortOrderToProviderInstances(
  providerInstances: ProviderInstanceConfigMap | undefined,
  updates: Readonly<Record<string, number>>,
): ProviderInstanceConfigMap {
  const next: Record<string, ProviderInstanceConfig> = {};
  for (const [rawId, instance] of Object.entries(providerInstances ?? {}) as Array<
    [string, ProviderInstanceConfig]
  >) {
    const sortOrder = updates[rawId];
    if (sortOrder === undefined || instance.driver !== PI_NATIVE_DRIVER_KIND) {
      next[rawId] = instance;
      continue;
    }
    next[rawId] = {
      ...instance,
      config: { ...asRecord(instance.config), sortOrder },
    };
  }
  return next as ProviderInstanceConfigMap;
}

/** The config blob a save writes for one service. */
export function buildPiNativeConfig(input: {
  readonly enabled: boolean;
  readonly vendorKey: string;
  readonly apiStyle: PiNativeApiStyle;
  readonly baseUrl: string;
  readonly apiKey: SettingsSecretValue;
  readonly headers: Readonly<Record<string, string>>;
  readonly modelBindings: ReadonlyArray<PiNativeModelBinding>;
  readonly sortOrder: number | undefined;
  readonly autoCompact: boolean;
  readonly infiniteRetry: boolean;
  readonly enableSubagents: boolean;
  readonly customModels: ReadonlyArray<CustomModelSetting>;
}): PiNativeServiceConfig & { readonly enabled: boolean } {
  return {
    enabled: input.enabled,
    vendorKey: input.vendorKey.trim(),
    apiStyle: input.apiStyle,
    baseUrl: input.baseUrl.trim(),
    apiKey: input.apiKey,
    headers: input.headers,
    defaultModel: input.modelBindings[0]?.id ?? "",
    modelBindings: input.modelBindings,
    sortOrder: input.sortOrder,
    autoCompact: input.autoCompact,
    infiniteRetry: input.infiniteRetry,
    enableSubagents: input.enableSubagents,
    customModels: input.customModels,
  };
}

/** What a save hands the settings mutation for one row. */
export function buildPiNativeInstance(input: {
  readonly enabled: boolean;
  readonly displayName: string;
  readonly accentColor: string | undefined;
  readonly config: PiNativeServiceConfig & { readonly enabled: boolean };
}): ProviderInstanceConfig {
  const displayName = input.displayName.trim();
  const accentColor = input.accentColor?.trim() ?? "";
  return {
    driver: PI_NATIVE_DRIVER_KIND,
    enabled: input.enabled,
    ...(displayName === "" ? {} : { displayName }),
    ...(accentColor === "" ? {} : { accentColor }),
    config: input.config,
  };
}

export interface HeaderPair {
  readonly key: string;
  readonly name: string;
  readonly value: string;
}

let headerPairSequence = 0;

/** A blank header row whose React key never collides with a previous one. */
export function createEmptyHeaderPair(): HeaderPair {
  headerPairSequence += 1;
  return { key: `header-${headerPairSequence}`, name: "", value: "" };
}

export function recordToPairs(record: Readonly<Record<string, string>>): HeaderPair[] {
  return Object.entries(record).map(([name, value]) => {
    headerPairSequence += 1;
    return { key: `header-${headerPairSequence}`, name, value };
  });
}

/** Header pairs to a record, dropping blank or reserved names. */
export function pairsToRecord(pairs: ReadonlyArray<HeaderPair>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const pair of pairs) {
    const name = pair.name.trim();
    if (name === "" || headerNameIssue(name) !== undefined) continue;
    record[name] = pair.value;
  }
  return record;
}

/** Why a header name cannot be saved, or `undefined` when it can. */
export function headerNameIssue(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "") return undefined;
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    return m(msg("Headers cannot span lines."));
  }
  if (/[^\t\x20-\x7e\x80-\xff]/u.test(trimmed)) {
    return m(msg("Use plain ASCII header names."));
  }
  if (RESERVED_HEADER_SET.has(trimmed.toLowerCase())) {
    return m(msg("Reserved by the transport."));
  }
  return undefined;
}

/** Named vendor presets matching a search query, in catalog order. */
export function filterVendorPresets(
  query: string,
  presets: ReadonlyArray<PiNativeVendorPreset> = PI_NATIVE_VENDOR_PRESETS,
): ReadonlyArray<PiNativeVendorPreset> {
  const needle = query.trim().toLowerCase();
  if (needle === "") return presets;
  return presets.filter((preset) =>
    [preset.name, preset.id, preset.vendorKey, ...(preset.aliases ?? [])].some((value) =>
      value.toLowerCase().includes(needle),
    ),
  );
}

/** Discovered models matching a query and every active capability filter. */
export function filterModelInfos(
  models: ReadonlyArray<PiNativeModelInfo>,
  query: string,
  filters: ReadonlyArray<ModelFilter>,
): ReadonlyArray<PiNativeModelInfo> {
  const needle = query.trim().toLowerCase();
  return models.filter((model) => {
    if (filters.length > 0 && !filters.every((filter) => modelMatchesFilter(model, filter))) {
      return false;
    }
    if (needle === "") return true;
    return (
      model.modelId.toLowerCase().includes(needle) ||
      model.displayName.toLowerCase().includes(needle)
    );
  });
}

const bindingSearchText = (binding: PiNativeModelBinding): string =>
  [binding.id, binding.alias ?? "", binding.displayName ?? ""].join(" ").toLowerCase();

/** Selected bindings matching a query over wire id, alias and display name. */
export function filterBindings(
  bindings: ReadonlyArray<PiNativeModelBinding>,
  query: string,
): ReadonlyArray<PiNativeModelBinding> {
  const needle = query.trim().toLowerCase();
  if (needle === "") return bindings;
  return bindings.filter((binding) => bindingSearchText(binding).includes(needle));
}

/**
 * Merge a late catalog lookup into a binding the user may have edited meanwhile.
 * Only fields still carrying their catalog-seeded value are adopted, so an alias,
 * a pinned limit or an explicit capability override survives the async round trip.
 */
export function mergeLookupEnrichment(
  current: PiNativeModelBinding,
  enriched: PiNativeModelBinding,
): PiNativeModelBinding {
  const currentName = current.displayName?.trim() ?? "";
  const keepDisplayName = currentName !== "" && currentName !== current.id;
  const adoptThinking = current.thinkingLevels.length === 0;
  const adoptDefaultThinking = current.defaultThinkingLevel === null;
  return {
    ...current,
    id: current.id,
    ...(keepDisplayName || enriched.displayName === undefined
      ? {}
      : { displayName: enriched.displayName }),
    ...(current.contextWindowSource === "user"
      ? {}
      : {
          contextWindow: enriched.contextWindow,
          ...(enriched.contextWindowSource === undefined
            ? {}
            : { contextWindowSource: enriched.contextWindowSource }),
        }),
    ...(current.maxTokensSource === "user"
      ? {}
      : {
          maxTokens: enriched.maxTokens,
          ...(enriched.maxTokensSource === undefined
            ? {}
            : { maxTokensSource: enriched.maxTokensSource }),
        }),
    ...(adoptThinking
      ? {
          thinkingLevels: enriched.thinkingLevels,
          ...(adoptDefaultThinking ? { defaultThinkingLevel: enriched.defaultThinkingLevel } : {}),
          ...(current.thinkingProtocol !== undefined || enriched.thinkingProtocol === undefined
            ? {}
            : { thinkingProtocol: enriched.thinkingProtocol }),
        }
      : {}),
    ...(current.supportsReasoningEffort == null && enriched.supportsReasoningEffort !== undefined
      ? { supportsReasoningEffort: enriched.supportsReasoningEffort }
      : {}),
    ...(current.supportsImages == null && enriched.supportsImages !== undefined
      ? { supportsImages: enriched.supportsImages }
      : {}),
    ...(current.supportsDocuments == null && enriched.supportsDocuments !== undefined
      ? { supportsDocuments: enriched.supportsDocuments }
      : {}),
  };
}

/** Whether a binding for this wire id is already selected. */
export function hasBinding(
  bindings: ReadonlyArray<PiNativeModelBinding>,
  modelId: string,
): boolean {
  const wanted = modelId.trim().toLowerCase();
  return bindings.some((binding) => binding.id.toLowerCase() === wanted);
}

/** Add or remove one discovered model, keeping the current order. */
export function toggleBinding(
  bindings: ReadonlyArray<PiNativeModelBinding>,
  binding: PiNativeModelBinding,
): ReadonlyArray<PiNativeModelBinding> {
  if (hasBinding(bindings, binding.id)) {
    const wanted = binding.id.trim().toLowerCase();
    return bindings.filter((entry) => entry.id.toLowerCase() !== wanted);
  }
  return [...bindings, binding];
}

/** Select or clear every listed model in one step, preserving existing overrides. */
export function setVisibleBindings(
  bindings: ReadonlyArray<PiNativeModelBinding>,
  visible: ReadonlyArray<PiNativeModelBinding>,
  select: boolean,
): ReadonlyArray<PiNativeModelBinding> {
  const visibleIds = new Set(visible.map((entry) => entry.id.toLowerCase()));
  if (!select) return bindings.filter((entry) => !visibleIds.has(entry.id.toLowerCase()));
  const chosen = new Set(bindings.map((entry) => entry.id.toLowerCase()));
  const additions = visible.filter((entry) => !chosen.has(entry.id.toLowerCase()));
  return additions.length === 0 ? bindings : [...bindings, ...additions];
}
