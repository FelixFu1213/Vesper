import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  ProviderDriverKind,
  type ModelCapabilities,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
  type ServerProviderSkill,
  settingsSecretLiteral,
} from "@t3tools/contracts";
import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  bindingDefaultThinkingMenuLevels,
  sortThinkingLevels,
  type PiNativeModelBinding,
  type SessionThinkingLevel,
} from "../catalog/modelCatalog.ts";
import { matchNamedPreset } from "../catalog/presets.ts";
import type { PiNativeApiStyle, PiNativeSettings } from "../settings.ts";
import { PI_NATIVE_SLASH_COMMANDS } from "./commands.ts";

export const PI_NATIVE_DRIVER_KIND = ProviderDriverKind.make("piNative");

const PI_NATIVE_PRESENTATION = {
  displayName: "Pi Native",
  showInteractionModeToggle: true,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
  reportsContextWindow: true,
} as const;

const PI_NATIVE_DEFAULT_MODEL_SLUG = "default";

const EMPTY_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const AUTO_THINKING_LABEL = "Auto";

const THINKING_LEVEL_LABELS: Record<ModelThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = "medium";

const STANDARD_SERVICE_TIER = "default";

// OpenAI accepts these tiers on both its wire protocols; other OpenAI-compatible
// endpoints reject the field, so they advertise none.
const OPENAI_SERVICE_TIERS = [
  { id: STANDARD_SERVICE_TIER, label: "Standard" },
  { id: "flex", label: "Flex" },
  { id: "priority", label: "Priority" },
] as const;

class PiNativeModelDiscoveryError extends Schema.TaggedError<
  PiNativeModelDiscoveryError,
  { readonly brand: unique symbol }
>()("PiNativeModelDiscoveryError", { detail: Schema.String }) {}

export interface CheckPiNativeStatusOptions {
  /** Read `/models` from the configured endpoint for the catalog; off by default. */
  readonly fetchRemoteModels?: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly remoteModelsTimeoutMs?: number;
  /** Workspace skills to publish with the snapshot; the `$` menu reads them per cwd. */
  readonly skills?: ReadonlyArray<ServerProviderSkill>;
}

const thinkingDescriptor = (model: Model<Api>): ProviderOptionDescriptor | undefined => {
  const levels = getSupportedThinkingLevels(model);
  if (levels.length <= 1) return undefined;
  const defaultLevel = clampThinkingLevel(model, DEFAULT_THINKING_LEVEL);
  return {
    id: "thinking",
    label: "Thinking",
    type: "select",
    options: levels.map((level) => ({
      id: level,
      label: THINKING_LEVEL_LABELS[level],
      ...(level === defaultLevel ? { isDefault: true } : {}),
    })),
  };
};

const serviceTierDescriptor = (model: Model<Api>): ProviderOptionDescriptor | undefined => {
  if (model.provider !== "openai") return undefined;
  if (model.api !== "openai-responses" && model.api !== "openai-completions") return undefined;
  return {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    options: OPENAI_SERVICE_TIERS.map((tier) => ({
      id: tier.id,
      label: tier.label,
      ...(tier.id === STANDARD_SERVICE_TIER ? { isDefault: true } : {}),
    })),
    currentValue: STANDARD_SERVICE_TIER,
  };
};

const thinkingLevelLabel = (level: SessionThinkingLevel): string =>
  level === "omit" ? AUTO_THINKING_LABEL : THINKING_LEVEL_LABELS[level];

const bindingServiceTierDescriptor = (
  settings: PiNativeSettings,
): ProviderOptionDescriptor | undefined => {
  if (settings.apiStyle !== "openai-responses" && settings.apiStyle !== "openai-completions") {
    return undefined;
  }
  const preset = matchNamedPreset({
    vendorKey: settings.vendorKey,
    baseUrl: settings.baseUrl,
  });
  const openAiEndpoint =
    preset?.vendorKey === "openai" ||
    settings.baseUrl.includes("api.openai.com") ||
    (settings.baseUrl.trim() === "" && settings.vendorKey.trim() === "");
  if (!openAiEndpoint) return undefined;
  return {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    options: OPENAI_SERVICE_TIERS.map((tier) => ({
      id: tier.id,
      label: tier.label,
      ...(tier.id === STANDARD_SERVICE_TIER ? { isDefault: true } : {}),
    })),
    currentValue: STANDARD_SERVICE_TIER,
  };
};

/**
 * Capabilities for a saved binding: exactly the thinking ladder it enables plus
 * "Auto" (provider default), and a service tier only where OpenAI's wire
 * protocols accept one.
 */
const bindingCapabilities = (
  settings: PiNativeSettings,
  binding: PiNativeModelBinding,
): ModelCapabilities => {
  const levels = sortThinkingLevels(binding.thinkingLevels);
  const menu = bindingDefaultThinkingMenuLevels(levels);
  const defaultLevel = binding.defaultThinkingLevel ?? levels[0] ?? null;
  const optionDescriptors: ProviderOptionDescriptor[] = [];
  if (menu.length > 0) {
    optionDescriptors.push({
      id: "thinking",
      label: "Thinking",
      type: "select",
      role: "reasoning",
      options: menu.map((level) => ({
        id: level,
        label: thinkingLevelLabel(level),
        ...(level === defaultLevel ? { isDefault: true } : {}),
      })),
    });
  }
  const serviceTier = bindingServiceTierDescriptor(settings);
  if (serviceTier !== undefined) optionDescriptors.push(serviceTier);
  return optionDescriptors.length === 0
    ? EMPTY_MODEL_CAPABILITIES
    : createModelCapabilities({ optionDescriptors });
};

const configuredBindingModels = (
  settings: PiNativeSettings,
): ReadonlyArray<ServerProviderModel> => {
  const defaultModel = settings.defaultModel.trim().toLowerCase();
  return settings.modelBindings.map((binding, index) => {
    const alias = binding.alias?.trim() ?? "";
    const displayName = binding.displayName?.trim() ?? "";
    return {
      slug: binding.id,
      name: alias !== "" ? alias : displayName !== "" ? displayName : binding.id,
      isCustom: false,
      isDefault: defaultModel !== "" ? binding.id.toLowerCase() === defaultModel : index === 0,
      capabilities: bindingCapabilities(settings, binding),
    };
  });
};

/** Custom models already covered by a binding are not offered twice. */
const uncoveredCustomModels = (settings: PiNativeSettings): PiNativeSettings["customModels"] => {
  const covered = new Set(
    settings.modelBindings.flatMap((binding) => [
      binding.id.trim().toLowerCase(),
      binding.alias?.trim().toLowerCase() ?? "",
    ]),
  );
  return settings.customModels.filter((entry) => {
    const slug = typeof entry === "string" ? entry : entry.slug;
    return !covered.has(slug.trim().toLowerCase());
  });
};

const modelCapabilities = (model: Model<Api>): ModelCapabilities => {
  const optionDescriptors = [thinkingDescriptor(model), serviceTierDescriptor(model)].filter(
    (descriptor): descriptor is ProviderOptionDescriptor => descriptor !== undefined,
  );
  return optionDescriptors.length === 0
    ? EMPTY_MODEL_CAPABILITIES
    : createModelCapabilities({ optionDescriptors });
};

const builtinModelsForApi = (apiStyle: PiNativeApiStyle): ReadonlyArray<Model<Api>> => {
  const models: Array<Model<Api>> = [];
  const seen = new Set<string>();
  for (const provider of getBuiltinProviders()) {
    for (const model of getBuiltinModels(provider)) {
      if (model.api !== apiStyle) continue;
      const slug = `${model.provider}/${model.id}`;
      if (seen.has(slug)) continue;
      seen.add(slug);
      models.push(model);
    }
  }
  return models;
};

const matchesModelReference = (model: Model<Api>, reference: string): boolean =>
  reference === `${model.provider}/${model.id}` || reference === model.id;

export const resolvePiNativeBuiltinModel = (
  apiStyle: PiNativeApiStyle,
  reference: string,
): Model<Api> | undefined => {
  const models = builtinModelsForApi(apiStyle);
  if (reference === "") return models[0];
  return models.find((model) => matchesModelReference(model, reference));
};

const builtinCatalog = (apiStyle: PiNativeApiStyle): ReadonlyArray<ServerProviderModel> =>
  builtinModelsForApi(apiStyle).map((model) => ({
    slug: `${model.provider}/${model.id}`,
    name: model.name,
    subProvider: model.provider,
    isCustom: false,
    capabilities: modelCapabilities(model),
  }));

const defaultModelEntry = (settings: PiNativeSettings): ServerProviderModel => {
  const resolved = resolvePiNativeBuiltinModel(settings.apiStyle, settings.defaultModel);
  return {
    slug: PI_NATIVE_DEFAULT_MODEL_SLUG,
    name: settings.defaultModel === "" ? "Default" : `Default (${settings.defaultModel})`,
    isCustom: false,
    isDefault: true,
    capabilities: resolved === undefined ? EMPTY_MODEL_CAPABILITIES : modelCapabilities(resolved),
  };
};

const dedupeModels = (
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> => {
  const seen = new Set<string>();
  const result: Array<ServerProviderModel> = [];
  for (const model of models) {
    if (seen.has(model.slug)) continue;
    seen.add(model.slug);
    result.push(model);
  }
  return result;
};

const piNativeModels = (
  settings: PiNativeSettings,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> => {
  if (settings.modelBindings.length > 0) {
    // A configured model list is authoritative: no "default" row and no
    // built-in catalogue, so the picker shows exactly what the user bound.
    return providerModelsFromSettings(
      dedupeModels(configuredBindingModels(settings)),
      uncoveredCustomModels(settings),
      EMPTY_MODEL_CAPABILITIES,
    );
  }
  return providerModelsFromSettings(
    dedupeModels([
      defaultModelEntry(settings),
      ...builtinCatalog(settings.apiStyle),
      ...discovered,
    ]),
    settings.customModels,
    EMPTY_MODEL_CAPABILITIES,
  );
};

const recordField = (input: unknown, key: string): unknown =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined;

const remoteModelsFromPayload = (payload: unknown): ReadonlyArray<ServerProviderModel> => {
  const data = recordField(payload, "data");
  if (!Array.isArray(data)) return [];
  const models: Array<ServerProviderModel> = [];
  const seen = new Set<string>();
  for (const entry of data) {
    const id = recordField(entry, "id");
    if (typeof id !== "string") continue;
    const slug = id.trim();
    if (slug === "" || seen.has(slug)) continue;
    seen.add(slug);
    const name = recordField(entry, "name");
    models.push({
      slug,
      name: typeof name === "string" && name.trim() !== "" ? name.trim() : slug,
      isCustom: false,
      capabilities: EMPTY_MODEL_CAPABILITIES,
    });
  }
  return models;
};

const isPiNativeModelDiscoveryError = Schema.is(PiNativeModelDiscoveryError);

const discoverRemoteModels = Effect.fn("PiNativeStatus.discoverRemoteModels")(function* (
  settings: PiNativeSettings,
  options: CheckPiNativeStatusOptions,
) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.remoteModelsTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${settings.baseUrl.replace(/\/+$/u, "")}/models`;
  const apiKey = settingsSecretLiteral(settings.apiKey);
  const payload = yield* Effect.tryPromise({
    try: async () => {
      const response = await fetchImpl(url, {
        method: "GET",
        headers:
          apiKey === ""
            ? { accept: "application/json" }
            : { accept: "application/json", authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new PiNativeModelDiscoveryError({ detail: `HTTP ${response.status}` });
      }
      return (await response.json()) as unknown;
    },
    catch: (cause) =>
      isPiNativeModelDiscoveryError(cause)
        ? cause
        : new PiNativeModelDiscoveryError({ detail: "Pi Native model discovery failed." }),
  });
  return remoteModelsFromPayload(payload);
});

const snapshot = (
  settings: PiNativeSettings,
  checkedAt: string,
  probe: Parameters<typeof buildServerProvider>[0]["probe"],
  supportsTextGeneration: boolean,
  discovered: ReadonlyArray<ServerProviderModel> = [],
  skills: ReadonlyArray<ServerProviderSkill> = [],
): ServerProviderDraft => ({
  ...buildServerProvider({
    driver: PI_NATIVE_DRIVER_KIND,
    presentation: PI_NATIVE_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: piNativeModels(settings, discovered),
    slashCommands: PI_NATIVE_SLASH_COMMANDS,
    skills,
    probe,
  }),
  supportsTextGeneration,
});

export const buildInitialPiNativeProviderSnapshot = (
  settings: PiNativeSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    snapshot(
      settings,
      DateTime.formatIso(now),
      {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Pi Native availability..."
          : "Pi Native is disabled in Vesper settings.",
      },
      false,
    ),
  );

const discoverRemoteModelsForCheck = (
  settings: PiNativeSettings,
  options: CheckPiNativeStatusOptions,
): Effect.Effect<ReadonlyArray<ServerProviderModel>> => {
  if (options.fetchRemoteModels !== true || settings.baseUrl === "") {
    return Effect.succeed([]);
  }
  const timeoutMs = options.remoteModelsTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  return discoverRemoteModels(settings, options).pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.map(
      Option.match({
        onNone: (): ReadonlyArray<ServerProviderModel> => [],
        onSome: (models) => models,
      }),
    ),
    Effect.orElseSucceed((): ReadonlyArray<ServerProviderModel> => []),
  );
};

export const checkPiNativeProviderStatus = Effect.fn("checkPiNativeProviderStatus")(function* (
  settings: PiNativeSettings,
  options: CheckPiNativeStatusOptions = {},
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const skills = options.skills ?? [];
  if (!settings.enabled) {
    return snapshot(
      settings,
      checkedAt,
      {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi Native is disabled in Vesper settings.",
      },
      false,
      [],
      skills,
    );
  }
  const discovered = yield* discoverRemoteModelsForCheck(settings, options);
  if (settings.apiKey !== "") {
    return snapshot(
      settings,
      checkedAt,
      {
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated", label: "API key" },
      },
      true,
      discovered,
      skills,
    );
  }
  if (settings.baseUrl !== "") {
    return snapshot(
      settings,
      checkedAt,
      {
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "unknown" },
        message: "Using custom endpoint without API key.",
      },
      true,
      discovered,
      skills,
    );
  }
  return snapshot(
    settings,
    checkedAt,
    {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unauthenticated" },
      message: "Set an API key or base URL in Pi Native settings.",
    },
    false,
    discovered,
    skills,
  );
});
