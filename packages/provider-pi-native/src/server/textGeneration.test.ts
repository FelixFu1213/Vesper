import {
  contentText,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { PiNativeSettings } from "../settings.ts";
import { makePiNativeTextGeneration } from "./textGeneration.ts";

const decodeSettings = Schema.decodeSync(PiNativeSettings);

const instanceId = ProviderInstanceId.make("piNative");

const settings = (overrides: Record<string, unknown> = {}): PiNativeSettings =>
  decodeSettings({
    enabled: true,
    apiStyle: "anthropic-messages",
    apiKey: "sk-test",
    defaultModel: "claude-fable-5",
    ...overrides,
  });

const modelSelection = (
  model = "default",
  options?: ReadonlyArray<{ id: string; value: string }>,
) => createModelSelection(instanceId, model, options);

const titleInput = (model = "default", options?: ReadonlyArray<{ id: string; value: string }>) => ({
  cwd: "/repo",
  message: "Fix the login form",
  modelSelection: modelSelection(model, options),
});

const assistantMessage = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: '{"title":"Fix login form","needsRefinement":false}' }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-fable-5",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
  ...overrides,
});

const completedStream = (message: AssistantMessage): AssistantMessageEventStream => {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: "stop", message });
  return stream;
};

const failedStream = (
  message: AssistantMessage,
  reason: "error" | "aborted",
): AssistantMessageEventStream => {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  stream.push({ type: "error", reason, error: message });
  return stream;
};

interface StreamCall {
  readonly model: Model<Api>;
  readonly context: TranscriptContext;
  readonly options?: SimpleStreamOptions | undefined;
}

const captureStream = (createStream: () => AssistantMessageEventStream) => {
  const calls: Array<StreamCall> = [];
  const streamFn: StreamFn = (model, context, options) => {
    calls.push({ model, context, ...(options === undefined ? {} : { options }) });
    return createStream();
  };
  return { calls, streamFn };
};

describe("makePiNativeTextGeneration", () => {
  it.effect("generates a title from a tool-free transcript", () =>
    Effect.gen(function* () {
      const fake = captureStream(() => completedStream(assistantMessage()));
      const service = yield* makePiNativeTextGeneration(settings(), {
        streamFn: fake.streamFn,
        now: () => 42,
      });
      const result = yield* service.generateThreadTitle(titleInput());
      expect(result).toEqual({ title: "Fix login form" });

      const call = fake.calls[0];
      expect(call?.options?.maxRetries).toBe(0);
      expect(call?.options?.apiKey).toBe("sk-test");
      expect(call?.model.id).toBe("claude-fable-5");
      expect(call?.model.baseUrl).toBe("https://api.anthropic.com");
      const messages = call?.context.messages ?? [];
      expect(messages).toHaveLength(2);
      const system = messages[0];
      expect(system?.role).toBe("system");
      if (system?.role === "system") expect(system.toolsAdded).toBeUndefined();
      const user = messages[1];
      expect(user?.role).toBe("user");
      expect(user?.timestamp).toBe(42);
      expect(contentText(user?.content ?? [])).toContain("Fix the login form");
    }),
  );

  it.effect("uses the configured endpoint and thinking level", () =>
    Effect.gen(function* () {
      const fake = captureStream(() => completedStream(assistantMessage()));
      const service = yield* makePiNativeTextGeneration(
        settings({ baseUrl: "https://gateway.example/v1/" }),
        { streamFn: fake.streamFn },
      );
      yield* service.generateThreadTitle(
        titleInput("default", [{ id: "thinking", value: "high" }]),
      );
      const call = fake.calls[0];
      expect(call?.model.baseUrl).toBe("https://gateway.example/v1");
      expect(call?.options?.reasoning).toBe("high");
    }),
  );

  it.effect("ignores an off thinking level", () =>
    Effect.gen(function* () {
      const fake = captureStream(() => completedStream(assistantMessage()));
      const service = yield* makePiNativeTextGeneration(settings(), { streamFn: fake.streamFn });
      yield* service.generateThreadTitle(titleInput("default", [{ id: "thinking", value: "off" }]));
      expect(fake.calls[0]?.options?.reasoning).toBeUndefined();
    }),
  );

  it.effect("resolves a bare model id from the selected API style", () =>
    Effect.gen(function* () {
      const fake = captureStream(() => completedStream(assistantMessage()));
      const service = yield* makePiNativeTextGeneration(settings(), { streamFn: fake.streamFn });
      yield* service.generateThreadTitle(titleInput("claude-opus-4-5"));
      expect(fake.calls[0]?.model.id).toBe("claude-opus-4-5");
    }),
  );

  it.effect("fails an unknown model without calling the provider", () =>
    Effect.gen(function* () {
      const fake = captureStream(() => completedStream(assistantMessage()));
      const service = yield* makePiNativeTextGeneration(settings(), { streamFn: fake.streamFn });
      const error = yield* service
        .generateBranchName({
          cwd: "/repo",
          message: "Fix the login form",
          modelSelection: modelSelection("not/a-model"),
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("TextGenerationError");
      expect(error.detail).toContain("not/a-model");
      expect(fake.calls).toHaveLength(0);
    }),
  );

  it.effect("reports only the HTTP status of a provider failure", () =>
    Effect.gen(function* () {
      const failed = assistantMessage({
        stopReason: "error",
        errorMessage: "401 Unauthorized: invalid key sk-live-secret",
      });
      const fake = captureStream(() => failedStream(failed, "error"));
      const service = yield* makePiNativeTextGeneration(settings(), { streamFn: fake.streamFn });
      const error = yield* service.generateThreadTitle(titleInput()).pipe(Effect.flip);
      expect(error.detail).toBe(
        "Pi Native could not generate text: the model provider returned HTTP 401.",
      );
      expect(error.detail).not.toContain("sk-live-secret");
    }),
  );

  it.effect("keeps a provider error without a status generic", () =>
    Effect.gen(function* () {
      const failed = assistantMessage({
        stopReason: "error",
        errorMessage: "invalid api key sk-live-secret",
      });
      const fake = captureStream(() => failedStream(failed, "error"));
      const service = yield* makePiNativeTextGeneration(settings(), { streamFn: fake.streamFn });
      const error = yield* service.generateThreadTitle(titleInput()).pipe(Effect.flip);
      expect(error.detail).toBe(
        "Pi Native could not generate text: the model provider reported an error.",
      );
      expect(error.detail).not.toContain("sk-live-secret");
    }),
  );

  it.effect("fails an aborted provider response", () =>
    Effect.gen(function* () {
      const failed = assistantMessage({ stopReason: "aborted", errorMessage: "stopped" });
      const fake = captureStream(() => failedStream(failed, "aborted"));
      const service = yield* makePiNativeTextGeneration(settings(), { streamFn: fake.streamFn });
      const error = yield* service.generateThreadTitle(titleInput()).pipe(Effect.flip);
      expect(error.detail).toBe(
        "Pi Native could not generate text: the model provider reported an error.",
      );
    }),
  );

  it.effect("fails empty output", () =>
    Effect.gen(function* () {
      const fake = captureStream(() =>
        completedStream(assistantMessage({ content: [{ type: "text", text: "   " }] })),
      );
      const service = yield* makePiNativeTextGeneration(settings(), { streamFn: fake.streamFn });
      const error = yield* service.generateThreadTitle(titleInput()).pipe(Effect.flip);
      expect(error.detail).toBe("Pi Native returned empty output.");
    }),
  );

  it.effect("fails output that is not the requested JSON shape", () =>
    Effect.gen(function* () {
      const fake = captureStream(() =>
        completedStream(assistantMessage({ content: [{ type: "text", text: "just a title" }] })),
      );
      const service = yield* makePiNativeTextGeneration(settings(), { streamFn: fake.streamFn });
      const error = yield* service.generateThreadTitle(titleInput()).pipe(Effect.flip);
      expect(error.detail).toBe("Pi Native returned invalid structured output.");
    }),
  );

  it.effect("refuses the investigation a review guide needs", () =>
    Effect.gen(function* () {
      const fake = captureStream(() => completedStream(assistantMessage()));
      const service = yield* makePiNativeTextGeneration(settings(), { streamFn: fake.streamFn });
      const error = yield* service
        .generateReviewGuide({
          cwd: "/repo",
          number: 7,
          title: "Add login",
          description: "Adds a login form.",
          baseBranch: "main",
          baseCommit: "abc123",
          settledReview: "Looks good.",
          modelSelection: modelSelection(),
        })
        .pipe(Effect.flip);
      expect(error.detail).toContain("cannot investigate a checkout read-only");
      expect(fake.calls).toHaveLength(0);
    }),
  );

  it.effect("never passes a custom fetch to the Google adapter", () =>
    Effect.gen(function* () {
      const fetchCalls: Array<string> = [];
      const fetchImpl: typeof globalThis.fetch = async (input) => {
        fetchCalls.push(String(input));
        return Response.json({});
      };
      const fake = captureStream(() =>
        completedStream(
          assistantMessage({
            api: "google-generative-ai",
            provider: "google",
            model: "gemini-2.5-flash",
          }),
        ),
      );
      const service = yield* makePiNativeTextGeneration(
        settings({ apiStyle: "google-generative-ai", defaultModel: "gemini-2.5-flash" }),
        { streamFn: fake.streamFn, fetch: fetchImpl },
      );
      yield* service.generateThreadTitle(titleInput());
      expect(fake.calls[0]?.model.id).toBe("gemini-2.5-flash");
      expect(fake.calls[0]?.options?.fetch).toBeUndefined();
      expect(fetchCalls).toEqual([]);
    }),
  );

  it.effect("passes a custom fetch to an OpenAI-compatible adapter", () =>
    Effect.gen(function* () {
      const fetchImpl: typeof globalThis.fetch = async () => Response.json({});
      const fake = captureStream(() => completedStream(assistantMessage()));
      const service = yield* makePiNativeTextGeneration(
        settings({ apiStyle: "openai-responses", defaultModel: "gpt-5" }),
        { streamFn: fake.streamFn, fetch: fetchImpl },
      );
      yield* service.generateThreadTitle(titleInput());
      expect(fake.calls[0]?.options?.fetch).toBe(fetchImpl);
    }),
  );

  it.effect("times out a provider that never answers", () =>
    Effect.gen(function* () {
      const stalled: StreamFn = () => new Promise<AssistantMessageEventStream>(() => {});
      const service = yield* makePiNativeTextGeneration(settings(), { streamFn: stalled });
      const fiber = yield* service
        .generateThreadTitle(titleInput())
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("181 seconds");
      const error = yield* Fiber.join(fiber);
      expect(error.detail).toBe("Pi Native request timed out.");
    }),
  );
});

describe("makePiNativeTextGeneration with configured bindings", () => {
  it.effect("resolves a saved binding and its default thinking level", () =>
    Effect.gen(function* () {
      const fake = captureStream(() => completedStream(assistantMessage()));
      const service = yield* makePiNativeTextGeneration(
        settings({
          defaultModel: "",
          modelBindings: [
            {
              id: "local-reasoner",
              displayName: "Local Reasoner",
              contextWindow: 200_000,
              maxTokens: 64_000,
              thinkingLevels: ["low", "high"],
              defaultThinkingLevel: "high",
            },
          ],
        }),
        { streamFn: fake.streamFn },
      );
      yield* service.generateThreadTitle(titleInput());
      const call = fake.calls[0];
      expect(call?.model.id).toBe("local-reasoner");
      expect(call?.options?.reasoning).toBe("high");
    }),
  );

  it.effect("forwards sanitized user headers", () =>
    Effect.gen(function* () {
      const fake = captureStream(() => completedStream(assistantMessage()));
      const service = yield* makePiNativeTextGeneration(
        settings({ headers: { "X-Title": "T3 Code", authorization: "Bearer evil" } }),
        { streamFn: fake.streamFn },
      );
      yield* service.generateThreadTitle(titleInput());
      expect(fake.calls[0]?.options?.headers).toEqual({ "X-Title": "T3 Code" });
    }),
  );

  it.effect("routes OpenCode Go text generation per model wire API", () =>
    Effect.gen(function* () {
      const fake = captureStream(() => completedStream(assistantMessage()));
      const service = yield* makePiNativeTextGeneration(
        settings({ apiStyle: "opencode-go", defaultModel: "qwen3.8-max" }),
        { streamFn: fake.streamFn },
      );
      yield* service.generateThreadTitle(titleInput());
      const call = fake.calls[0];
      expect(call?.model.api).toBe("openai-completions");
      expect(call?.model.baseUrl).toBe("https://opencode.ai/zen/go/v1");
      expect(typeof call?.options?.sessionId).toBe("string");
      expect(call?.options?.sessionId?.length).toBeGreaterThan(0);
      expect(call?.options?.headers?.["x-opencode-session"]).toBe(call?.options?.sessionId);
    }),
  );
});
