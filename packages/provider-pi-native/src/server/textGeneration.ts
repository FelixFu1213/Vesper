// @effect-diagnostics globalDate:off -- Message timestamps are request data; callers inject `now` in tests.
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  contentText,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { streamSimple as anthropicMessagesStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as googleGenerativeAiStreamSimple } from "@earendil-works/pi-ai/api/google-generative-ai";
import { streamSimple as openAiCompletionsStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as openAiResponsesStreamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import {
  TextGenerationError,
  type ModelSelection,
  settingsSecretLiteral,
} from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { PiNativeApiStyle, PiNativeSettings } from "../settings.ts";
import {
  resolvePiNativeModelBinding,
  withOpenCodeSessionHeader,
} from "./runtime/providerBinding.ts";
import { resolvePiNativeBuiltinModel } from "./status.ts";

const TEXT_GENERATION_TIMEOUT_MS = 180_000;

const PI_NATIVE_TEXT_GENERATION_SYSTEM_PROMPT =
  "You generate short machine-readable content for T3 Code. Reply with only the requested JSON object.";

const REASONING_LEVELS: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export interface PiNativeTextGenerationDeps {
  readonly now?: () => number;
  readonly streamFn?: StreamFn;
  readonly fetch?: typeof globalThis.fetch;
}

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/u, "");

interface TextGenerationModel {
  readonly model: Model<Api>;
  readonly reasoning: ThinkingLevel | undefined;
  readonly headers: Record<string, string | null> | undefined;
}

const textGenerationReasoning = (level: string | undefined): ThinkingLevel | undefined =>
  level === undefined || level === "off" ? undefined : (level as ThinkingLevel);

/**
 * Resolves the selection through the same binding the chat path uses, so
 * configured model rows, `opencode-go` routes and per-model wire APIs behave
 * identically for title/commit/PR generation.
 */
const resolvePiNativeTextGenerationModel = (
  settings: PiNativeSettings,
  modelSelection: ModelSelection,
): TextGenerationModel | undefined => {
  const resolved = resolvePiNativeModelBinding(settings, modelSelection);
  const requested =
    modelSelection.model === "default"
      ? settings.defaultModel.trim() !== ""
        ? settings.defaultModel.trim()
        : (settings.modelBindings[0]?.id ?? "")
      : modelSelection.model;
  const known =
    resolved.custom ||
    // OpenCode Go is a curated gateway: a model that is not in the built-in
    // catalogue yet is still addressable, exactly as it is in a chat turn.
    settings.apiStyle === "opencode-go" ||
    resolvePiNativeBuiltinModel(resolved.model.api as PiNativeApiStyle, requested) !== undefined;
  if (!known) return undefined;
  const headers = resolved.headers;
  return {
    // Text generation passes a configured base URL verbatim to the wire module,
    // so it keeps the user's trailing-slash trim instead of the chat path's
    // Anthropic canonicalization.
    model:
      settings.baseUrl === ""
        ? resolved.model
        : { ...resolved.model, baseUrl: stripTrailingSlashes(settings.baseUrl) },
    reasoning: textGenerationReasoning(resolved.thinkingLevel),
    headers: Object.keys(headers).length === 0 ? undefined : headers,
  };
};

const streamForApi = (api: string): StreamFn => {
  switch (api) {
    case "anthropic-messages":
      return (model, context, options) =>
        anthropicMessagesStreamSimple(model as Model<"anthropic-messages">, context, options);
    case "google-generative-ai":
      return (model, context, options) =>
        googleGenerativeAiStreamSimple(model as Model<"google-generative-ai">, context, options);
    case "openai-completions":
      return (model, context, options) =>
        openAiCompletionsStreamSimple(model as Model<"openai-completions">, context, options);
    case "openai-responses":
    default:
      return (model, context, options) =>
        openAiResponsesStreamSimple(model as Model<"openai-responses">, context, options);
  }
};

// Provider errors echo request bodies and keys, so only a leading HTTP status survives.
const providerFailureDetail = (errorMessage: string | undefined): string => {
  const status = errorMessage?.match(/(?:^|\D)([45]\d\d)(?:\D|$)/u)?.[1];
  return status === undefined
    ? "Pi Native could not generate text: the model provider reported an error."
    : `Pi Native could not generate text: the model provider returned HTTP ${status}.`;
};

const reasoningFromSelection = (modelSelection: ModelSelection): ThinkingLevel | undefined => {
  const value = getModelSelectionStringOptionValue(modelSelection, "thinking");
  return value !== undefined && REASONING_LEVELS.has(value) ? (value as ThinkingLevel) : undefined;
};

const runStream = async (
  streamFn: StreamFn,
  model: Model<Api>,
  context: ReturnType<typeof normalizeContext>,
  options: SimpleStreamOptions,
): Promise<AssistantMessage | undefined> => {
  const stream = await streamFn(model, context, options);
  let finalMessage: AssistantMessage | undefined;
  for await (const event of stream) {
    if (event.type === "done") finalMessage = event.message;
    else if (event.type === "error") finalMessage = event.error;
  }
  return finalMessage;
};

export const makePiNativeTextGeneration = Effect.fn("makePiNativeTextGeneration")(function (
  settings: PiNativeSettings,
  deps: PiNativeTextGenerationDeps = {},
) {
  const now = deps.now ?? (() => Date.now());

  const runJson: TextGenerationOperations.Runner = Effect.fn("PiNativeTextGeneration.runJson")(
    function* (request) {
      const { operation, modelSelection } = request;
      const resolved = resolvePiNativeTextGenerationModel(settings, modelSelection);
      if (resolved === undefined) {
        return yield* new TextGenerationError({
          operation,
          detail:
            modelSelection.model === "default"
              ? `Pi Native has no ${settings.apiStyle} model catalog entry. Set a default model in Pi Native settings.`
              : `Pi Native does not recognize the model '${modelSelection.model}' for ${settings.apiStyle}.`,
        });
      }
      const model = resolved.model;
      const reasoning = resolved.reasoning ?? reasoningFromSelection(modelSelection);
      const apiKey = settingsSecretLiteral(settings.apiKey);
      // @effect-diagnostics-next-line cryptoRandomUUIDInEffect:off -- Keeps R = never for callers while generating a single-request routing id.
      const sessionId = `pi-native-textgen-${globalThis.crypto.randomUUID()}`;
      const headers = withOpenCodeSessionHeader(resolved.headers ?? {}, {
        apiStyle: settings.apiStyle,
        provider: model.provider,
        vendorKey: settings.vendorKey,
        baseUrl: model.baseUrl,
        sessionId,
      });
      const options: SimpleStreamOptions = {
        maxRetries: 0,
        sessionId,
        ...(apiKey === "" ? {} : { apiKey }),
        // Google's adapter rejects a custom fetch, so it keeps the host implementation.
        ...(deps.fetch === undefined || model.api === "google-generative-ai"
          ? {}
          : { fetch: deps.fetch }),
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        ...(reasoning === undefined ? {} : { reasoning }),
      };
      // Text generation never touches workspace tools; the prompt is the whole transcript.
      const context = normalizeContext({
        systemPrompt: PI_NATIVE_TEXT_GENERATION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: request.prompt, timestamp: now() }],
        tools: [],
      });
      const streamFn = deps.streamFn ?? streamForApi(model.api);
      const finalMessage = yield* Effect.tryPromise({
        try: () => runStream(streamFn, model, context, options),
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail: "Pi Native could not reach the model provider.",
            cause,
          }),
      });
      if (finalMessage === undefined) {
        return yield* new TextGenerationError({
          operation,
          detail: "Pi Native returned no response.",
        });
      }
      if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
        return yield* new TextGenerationError({
          operation,
          detail: providerFailureDetail(finalMessage.errorMessage),
        });
      }
      const text = contentText(finalMessage.content).trim();
      if (text === "") {
        return yield* new TextGenerationError({
          operation,
          detail: "Pi Native returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "Pi Native", text);
    },
    (effect, request) =>
      effect.pipe(
        Effect.timeoutOption(TEXT_GENERATION_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: request.operation,
                  detail: "Pi Native request timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      ),
  );

  const textGeneration: ProviderTextGeneration = TextGenerationOperations.fromRunner(
    "PiNativeTextGeneration",
    TextGenerationOperations.withoutInvestigation("Pi Native", runJson),
  );
  return Effect.succeed(textGeneration);
});
