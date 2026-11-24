import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { SettingsSecretValue } from "./settingsSecretValue.ts";

/** Wire protocols a Pi Native endpoint can speak. Mirrors the provider vocabulary. */
export const PiNativeApiStyle = Schema.Literals([
  "openai-responses",
  "openai-completions",
  "anthropic-messages",
  "google-generative-ai",
  "opencode-go",
]);
export type PiNativeApiStyle = typeof PiNativeApiStyle.Type;

/** How a model-list probe asks a service what it serves. */
export const PiNativeDiscoveryStyle = Schema.Literals([
  "openai_models",
  "anthropic_models",
  "google_models",
]);
export type PiNativeDiscoveryStyle = typeof PiNativeDiscoveryStyle.Type;

export const PiNativeModelInputModality = Schema.Literals([
  "text",
  "image",
  "pdf",
  "audio",
  "video",
]);
export type PiNativeModelInputModality = typeof PiNativeModelInputModality.Type;

export const PiNativeThinkingLevel = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type PiNativeThinkingLevel = typeof PiNativeThinkingLevel.Type;

/** How an Anthropic-compatible endpoint expects effort to be expressed. */
export const PiNativeThinkingProtocol = Schema.Literals(["legacy", "adaptive"]);
export type PiNativeThinkingProtocol = typeof PiNativeThinkingProtocol.Type;

export const PiNativeCatalogSource = Schema.Literals(["models.dev", "pi-ai", "discovered"]);
export type PiNativeCatalogSource = typeof PiNativeCatalogSource.Type;

/** Published metadata for one model, before a user binds it. */
export const PiNativeModelInfo = Schema.Struct({
  modelId: TrimmedNonEmptyString,
  displayName: Schema.String,
  vendorKey: Schema.optional(TrimmedString),
  description: Schema.optional(Schema.String),
  family: Schema.optional(Schema.String),
  reasoning: Schema.Boolean,
  toolCall: Schema.Boolean,
  attachment: Schema.Boolean,
  inputModalities: Schema.Array(PiNativeModelInputModality),
  contextWindow: NonNegativeInt,
  maxTokens: NonNegativeInt,
  supportedThinkingLevels: Schema.optional(Schema.Array(PiNativeThinkingLevel)),
  thinkingProtocol: Schema.optional(PiNativeThinkingProtocol),
  reasoningOptions: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.String }))),
  defaultTemperature: Schema.optional(Schema.Number),
  catalogSource: Schema.optional(PiNativeCatalogSource),
});
export type PiNativeModelInfo = typeof PiNativeModelInfo.Type;

/** One model row a service's own model list reported, before enrichment. */
export const PiNativeDiscoveredModel = Schema.Struct({
  modelId: TrimmedNonEmptyString,
  displayName: Schema.String,
  contextWindow: Schema.optional(NonNegativeInt),
  maxTokens: Schema.optional(NonNegativeInt),
});
export type PiNativeDiscoveredModel = typeof PiNativeDiscoveredModel.Type;

/** State of the models.dev catalog the server keeps in memory. */
export const PiNativeCatalogStatus = Schema.Struct({
  loaded: Schema.Boolean,
  source: Schema.Literals(["bundled", "remote", "empty"]),
  fetchedAt: Schema.optional(Schema.String),
  providerCount: NonNegativeInt,
  modelCount: NonNegativeInt,
  lastError: Schema.optional(Schema.String),
});
export type PiNativeCatalogStatus = typeof PiNativeCatalogStatus.Type;

/**
 * One configured endpoint as the settings form holds it. `apiKey` may be a
 * literal, a secret reference, or redacted; `instanceId` lets the server read a
 * saved instance's key when the form sent nothing else.
 */
export const PiNativeEndpointInput = Schema.Struct({
  apiStyle: PiNativeApiStyle,
  baseUrl: Schema.optional(TrimmedString),
  apiKey: Schema.optional(SettingsSecretValue),
  clearSavedApiKey: Schema.optional(Schema.Boolean),
  instanceId: Schema.optional(ProviderInstanceId),
  vendorKey: Schema.optional(TrimmedString),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  discoveryStyle: Schema.optional(PiNativeDiscoveryStyle),
});
export type PiNativeEndpointInput = typeof PiNativeEndpointInput.Type;

export const PiNativeProbeModelsInput = PiNativeEndpointInput;
export type PiNativeProbeModelsInput = PiNativeEndpointInput;

export const PiNativeProbeModelsResult = Schema.Struct({
  models: Schema.Array(PiNativeModelInfo),
  rawModels: Schema.Array(PiNativeDiscoveredModel),
  effectiveBaseUrl: Schema.String,
  resolvedFrom: Schema.optional(Schema.String),
  discoveryStyle: PiNativeDiscoveryStyle,
  skippedDiscovery: Schema.optional(Schema.Boolean),
  warning: Schema.optional(Schema.String),
});
export type PiNativeProbeModelsResult = typeof PiNativeProbeModelsResult.Type;

export const PiNativeTestConnectionInput = PiNativeEndpointInput;
export type PiNativeTestConnectionInput = PiNativeEndpointInput;

export const PiNativeTestConnectionResult = Schema.Struct({
  ok: Schema.Boolean,
  latencyMs: NonNegativeInt,
  effectiveBaseUrl: Schema.String,
  modelCount: Schema.optional(NonNegativeInt),
  warning: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type PiNativeTestConnectionResult = typeof PiNativeTestConnectionResult.Type;

export const PiNativeCatalogStatusInput = Schema.Struct({});
export type PiNativeCatalogStatusInput = typeof PiNativeCatalogStatusInput.Type;

export const PiNativeRefreshCatalogResult = Schema.Struct({
  status: PiNativeCatalogStatus,
  updated: Schema.Boolean,
});
export type PiNativeRefreshCatalogResult = typeof PiNativeRefreshCatalogResult.Type;

export const PiNativeLookupModelInput = Schema.Struct({
  modelId: TrimmedNonEmptyString,
  vendorKey: Schema.optional(TrimmedString),
});
export type PiNativeLookupModelInput = typeof PiNativeLookupModelInput.Type;

export const PiNativeLookupModelResult = Schema.Struct({
  model: Schema.NullOr(PiNativeModelInfo),
});
export type PiNativeLookupModelResult = typeof PiNativeLookupModelResult.Type;

export const PiNativeCatalogOperationErrorReason = Schema.Literals([
  "catalog_unavailable",
  "invalid_endpoint",
  "probe_failed",
  "secret_unavailable",
]);
export type PiNativeCatalogOperationErrorReason = typeof PiNativeCatalogOperationErrorReason.Type;

export class PiNativeCatalogOperationError extends Schema.TaggedError<
  PiNativeCatalogOperationError,
  { readonly brand: unique symbol }
>()("PiNativeCatalogOperationError", {
  reason: PiNativeCatalogOperationErrorReason,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
