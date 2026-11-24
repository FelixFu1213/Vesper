// Shared with the client settings form; keep schema code browser-safe.
import {
  CustomModelSetting,
  makeProviderSettingsSchema,
  secretSetting,
  SettingsSecretValue,
  TrimmedNonEmptyString,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ModelLimitSource,
  PiNativeApiStyle,
  SessionThinkingLevel,
  ThinkingLevel,
  ThinkingProtocol,
} from "./catalog/modelCatalog.ts";

export { PiNativeApiStyle };

const PI_NATIVE_API_STYLES = [
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "openai-completions", label: "OpenAI Chat Completions" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-generative-ai", label: "Google Gemini" },
  { value: "opencode-go", label: "OpenCode Go" },
] as const;

/**
 * One model bound to this provider instance. Limits carry their provenance so a
 * later catalog correction can reach a `catalog` value without overwriting a
 * user-entered one.
 */
export const PiNativeModelBinding = Schema.Struct({
  id: TrimmedNonEmptyString,
  displayName: Schema.optionalKey(TrimmedString),
  alias: Schema.optionalKey(TrimmedString),
  contextWindow: Schema.Number,
  contextWindowSource: Schema.optionalKey(ModelLimitSource),
  maxTokens: Schema.Number,
  maxTokensSource: Schema.optionalKey(ModelLimitSource),
  thinkingLevels: Schema.Array(ThinkingLevel).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  defaultThinkingLevel: SessionThinkingLevel.pipe(
    Schema.NullOr,
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  thinkingProtocol: Schema.optionalKey(ThinkingProtocol),
  supportsReasoningEffort: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  supportsImages: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  supportsDocuments: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  availableForSubagents: Schema.optionalKey(Schema.Boolean),
});
export type PiNativeModelBinding = typeof PiNativeModelBinding.Type;

export const PiNativeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    apiStyle: PiNativeApiStyle.pipe(
      Schema.withDecodingDefault(Effect.succeed("openai-responses" as const)),
      Schema.annotateKey({
        title: "API style",
        description: "Wire protocol used when talking to the configured endpoint.",
        providerSettingsForm: {
          control: "select",
          options: PI_NATIVE_API_STYLES,
        },
      }),
    ),
    baseUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Base URL",
        description: "Optional custom API endpoint base URL.",
        providerSettingsForm: { placeholder: "Provider default", clearWhenEmpty: "omit" },
      }),
    ),
    apiKey: SettingsSecretValue.pipe(
      secretSetting,
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API key",
        description: "Stored separately on the host.",
        providerSettingsForm: {
          control: "password",
          placeholder: "Optional for local endpoints",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    defaultModel: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Default model",
        description: "Model ID used when the thread selects Default.",
        providerSettingsForm: { placeholder: "Automatic", clearWhenEmpty: "omit" },
      }),
    ),
    vendorKey: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    headers: Schema.Record(Schema.String, Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed({})),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    sortOrder: Schema.optionalKey(Schema.Number).pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    modelBindings: Schema.Array(PiNativeModelBinding).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    autoCompact: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "Auto-compact",
        description: "Compact conversation context before reaching the model context limit.",
        providerSettingsForm: { control: "switch" },
      }),
    ),
    infiniteRetry: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({
        title: "Infinite retry",
        description: "Keep retrying transient provider and rate-limit failures until stopped.",
        providerSettingsForm: { control: "switch" },
      }),
    ),
    enableSubagents: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "Enable subagents",
        description: "Allow the agent to spawn in-process background delegate tasks.",
        providerSettingsForm: { control: "switch" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: [
      "apiStyle",
      "baseUrl",
      "apiKey",
      "defaultModel",
      "autoCompact",
      "infiniteRetry",
      "enableSubagents",
    ],
  },
);
export type PiNativeSettings = typeof PiNativeSettings.Type;
