import {
  isSecretReference,
  PiNativeCatalogOperationError,
  type PiNativeCatalogOperationErrorReason,
  type PiNativeCatalogStatus,
  type PiNativeEndpointInput,
  type PiNativeLookupModelInput,
  type PiNativeLookupModelResult,
  type PiNativeProbeModelsInput,
  type PiNativeProbeModelsResult,
  type PiNativeRefreshCatalogResult,
  type PiNativeTestConnectionInput,
  type PiNativeTestConnectionResult,
  type SecretReference,
} from "@t3tools/contracts";
import {
  createModelsDevCatalog,
  PiNativeDiscoveryError,
  probeProviderModels,
  testProviderConnection,
} from "@t3tools/provider-pi-native/server";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";

/**
 * Endpoint and catalog work for the Pi Native settings form: it reads the
 * saved credential, probes a model list and answers catalog lookups. No value
 * it returns or message it raises ever carries a resolved secret.
 */
export class PiNativeCatalogService extends Context.Service<
  PiNativeCatalogService,
  {
    readonly probeModels: (
      input: PiNativeProbeModelsInput,
    ) => Effect.Effect<PiNativeProbeModelsResult, PiNativeCatalogOperationError>;
    readonly testConnection: (
      input: PiNativeTestConnectionInput,
    ) => Effect.Effect<PiNativeTestConnectionResult, PiNativeCatalogOperationError>;
    readonly catalogStatus: () => Effect.Effect<
      PiNativeCatalogStatus,
      PiNativeCatalogOperationError
    >;
    readonly refreshCatalog: () => Effect.Effect<
      PiNativeRefreshCatalogResult,
      PiNativeCatalogOperationError
    >;
    readonly lookupModel: (
      input: PiNativeLookupModelInput,
    ) => Effect.Effect<PiNativeLookupModelResult, PiNativeCatalogOperationError>;
  }
>()("t3/piNative/PiNativeCatalogService") {}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const unusableSecret = (): PiNativeCatalogOperationError =>
  new PiNativeCatalogOperationError({
    reason: "secret_unavailable",
    message:
      "Could not read the saved API key from its secret provider. Unlock or fix it in Settings, then try again.",
  });

const isPiNativeDiscoveryError = Schema.is(PiNativeDiscoveryError);

const operationError = (error: unknown): PiNativeCatalogOperationError => {
  if (isPiNativeDiscoveryError(error)) {
    const reason: PiNativeCatalogOperationErrorReason =
      error.reason === "invalid_endpoint" ? "invalid_endpoint" : "probe_failed";
    return new PiNativeCatalogOperationError({ reason, message: error.message, cause: error });
  }
  return new PiNativeCatalogOperationError({
    reason: "probe_failed",
    message: "The endpoint could not be reached.",
    cause: error,
  });
};

export interface PiNativeCatalogServiceOptions {
  /** HTTP client seam for tests; production uses the process fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export const make = Effect.fn("PiNativeCatalogService.make")(function* (
  options: PiNativeCatalogServiceOptions = {},
) {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const catalog = createModelsDevCatalog({
    stateDir: config.stateDir,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  const readSecret = Effect.fn("PiNativeCatalogService.readSecret")(function* (
    reference: SecretReference,
  ) {
    const [value] = yield* secrets.read([reference]);
    const trimmed = value?.trim() ?? "";
    if (trimmed === "") return yield* unusableSecret();
    return trimmed;
  });

  /**
   * The literal key a probe may send: an explicit one, the reference it names,
   * or the saved instance's own key. A redacted placeholder is never a key.
   */
  const resolveApiKey = Effect.fn("PiNativeCatalogService.resolveApiKey")(function* (
    input: PiNativeEndpointInput,
  ) {
    if (input.clearSavedApiKey === true) return "";
    const provided = input.apiKey;
    if (typeof provided === "string") {
      const literal = provided.trim();
      if (literal !== "" && literal !== SECRET_REDACTED) return literal;
    }
    if (isSecretReference(provided)) return yield* readSecret(provided);
    if (input.instanceId === undefined) return "";
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        () =>
          new PiNativeCatalogOperationError({
            reason: "catalog_unavailable",
            message: "Couldn't read this environment's settings.",
          }),
      ),
    );
    const saved = asRecord(settings.providerInstances[input.instanceId]?.config)?.apiKey;
    if (isSecretReference(saved)) return yield* readSecret(saved);
    if (typeof saved === "string" && saved.trim() !== SECRET_REDACTED) return saved.trim();
    return "";
  });

  const endpointInput = (
    input: PiNativeEndpointInput,
    apiKey: string,
  ): Parameters<typeof probeProviderModels>[0] => ({
    apiStyle: input.apiStyle,
    baseUrl: input.baseUrl ?? "",
    apiKey,
    vendorKey: input.vendorKey,
    headers: input.headers,
    discoveryStyle: input.discoveryStyle,
  });

  const probeModels = Effect.fn("PiNativeCatalogService.probeModels")(function* (
    input: PiNativeProbeModelsInput,
  ) {
    const apiKey = yield* resolveApiKey(input);
    return yield* Effect.tryPromise({
      try: () => probeProviderModels(endpointInput(input, apiKey), options.fetch, catalog),
      catch: operationError,
    });
  });

  const testConnection = Effect.fn("PiNativeCatalogService.testConnection")(function* (
    input: PiNativeTestConnectionInput,
  ) {
    const apiKey = yield* resolveApiKey(input);
    return yield* Effect.tryPromise({
      try: () => testProviderConnection(endpointInput(input, apiKey), options.fetch, catalog),
      catch: operationError,
    });
  });

  const ensureLoaded = Effect.tryPromise({
    try: () => catalog.ensureLoaded(),
    catch: operationError,
  });

  const catalogStatus = Effect.fn("PiNativeCatalogService.catalogStatus")(function* () {
    yield* ensureLoaded;
    return catalog.getStatus();
  });

  const refreshCatalog = Effect.fn("PiNativeCatalogService.refreshCatalog")(function* () {
    return yield* Effect.tryPromise({
      try: () => catalog.refresh(),
      catch: operationError,
    });
  });

  const lookupModel = Effect.fn("PiNativeCatalogService.lookupModel")(function* (
    input: PiNativeLookupModelInput,
  ) {
    yield* ensureLoaded;
    const model = yield* Effect.tryPromise({
      try: () => catalog.lookupModel(input.modelId, input.vendorKey),
      catch: operationError,
    });
    return { model: model ?? null };
  });

  return PiNativeCatalogService.of({
    probeModels,
    testConnection,
    catalogStatus,
    refreshCatalog,
    lookupModel,
  });
});

export const layer = Layer.effect(PiNativeCatalogService, make());
