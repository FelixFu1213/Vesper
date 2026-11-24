import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelSelection } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import type { PiNativeSettings } from "../../settings.ts";
import {
  canonicalizeAnthropicBaseUrl,
  canonicalizeProviderBaseUrl,
  createProviderStreamFn,
  PI_NATIVE_LOCAL_API_KEY,
  providerAuthHeaders,
  ProviderHttpPool,
  resolvePiNativeModelBinding,
  type ProviderHttpDispatcher,
} from "./providerBinding.ts";

const BASE_SETTINGS: PiNativeSettings = {
  enabled: true,
  apiStyle: "openai-responses",
  baseUrl: "",
  apiKey: "",
  defaultModel: "",
  vendorKey: "",
  headers: {},
  modelBindings: [],
  autoCompact: true,
  infiniteRetry: false,
  enableSubagents: true,
  customModels: [],
};

function settings(overrides: Partial<PiNativeSettings>): PiNativeSettings {
  return { ...BASE_SETTINGS, ...overrides };
}

function selection(model: string, options?: ModelSelection["options"]): ModelSelection {
  return {
    instanceId: "pi-native",
    model,
    ...(options === undefined ? {} : { options }),
  } as unknown as ModelSelection;
}

const EMPTY_CONTEXT = { messages: [] } as unknown as TranscriptContext;

describe("resolvePiNativeModelBinding", () => {
  it("never sends the default sentinel and picks a sensible built-in per API style", () => {
    const responses = resolvePiNativeModelBinding(settings({}), selection("default"));
    assert.equal(responses.model.id, "gpt-5.4");
    assert.equal(responses.model.api, "openai-responses");
    assert.equal(responses.apiStyle, "openai-responses");

    const completions = resolvePiNativeModelBinding(
      settings({ apiStyle: "openai-completions" }),
      selection("default"),
    );
    assert.equal(completions.model.id, "gpt-4o");
    assert.equal(completions.model.api, "openai-completions");

    const anthropic = resolvePiNativeModelBinding(
      settings({ apiStyle: "anthropic-messages" }),
      selection("default"),
    );
    const anthropicFirst = getBuiltinModels("anthropic")[0];
    assert.equal(anthropic.model.id, anthropicFirst?.id);
    assert.equal(anthropic.model.api, "anthropic-messages");

    const google = resolvePiNativeModelBinding(
      settings({ apiStyle: "google-generative-ai" }),
      selection("default"),
    );
    assert.equal(google.model.id, getBuiltinModels("google")[0]?.id);
    assert.equal(google.model.api, "google-generative-ai");
  });

  it("honours a configured default model", () => {
    const binding = resolvePiNativeModelBinding(
      settings({ defaultModel: "anthropic/claude-haiku-4-5" }),
      selection("default"),
    );
    assert.equal(binding.provider, "anthropic");
    assert.equal(binding.model.id, "claude-haiku-4-5");
    assert.equal(binding.model.api, "openai-responses");
  });

  it("inherits catalog metadata for a bare built-in slug", () => {
    const binding = resolvePiNativeModelBinding(
      settings({ apiStyle: "anthropic-messages" }),
      selection("claude-haiku-4-5"),
    );
    const catalogModel = getBuiltinModels("anthropic").find(
      (model) => model.id === "claude-haiku-4-5",
    );

    assert.equal(binding.provider, "anthropic");
    assert.equal(binding.model.contextWindow, catalogModel?.contextWindow);
    assert.equal(binding.model.maxTokens, catalogModel?.maxTokens);
    assert.equal(binding.custom, false);
  });

  it("synthesizes a valid model for an unknown custom id", () => {
    const binding = resolvePiNativeModelBinding(
      settings({ customModels: [{ slug: "local/llama", name: "Local Llama" }] }),
      selection("local/llama"),
    );

    assert.equal(binding.custom, true);
    assert.equal(binding.provider, "local");
    assert.equal(binding.model.id, "llama");
    assert.equal(binding.model.name, "Local Llama");
    assert.equal(binding.model.contextWindow, 128_000);
    assert.equal(binding.model.maxTokens, 16_384);
    assert.equal(binding.model.reasoning, false);
    assert.equal(binding.model.api, "openai-responses");
  });

  it("applies and canonicalizes the base URL override", () => {
    const anthropic = resolvePiNativeModelBinding(
      settings({
        apiStyle: "anthropic-messages",
        baseUrl: "https://gateway.test/v1/messages",
        apiKey: "sk-test",
      }),
      selection("default"),
    );
    assert.equal(anthropic.model.baseUrl, "https://gateway.test");
    assert.equal(anthropic.baseUrl, "https://gateway.test");

    const openai = resolvePiNativeModelBinding(
      settings({ baseUrl: "http://localhost:8080/v1" }),
      selection("default"),
    );
    assert.equal(openai.model.baseUrl, "http://localhost:8080/v1");
  });

  it("reads thinking and service tier options", () => {
    const binding = resolvePiNativeModelBinding(
      settings({}),
      selection("gpt-5.4", [
        { id: "thinking", value: "medium" },
        { id: "serviceTier", value: "priority" },
      ]),
    );
    assert.equal(binding.thinkingLevel, "medium");
    assert.equal(binding.serviceTier, "priority");

    const standard = resolvePiNativeModelBinding(
      settings({}),
      selection("gpt-5.4", [{ id: "serviceTier", value: "default" }]),
    );
    assert.isUndefined(standard.serviceTier);

    const unknownLevel = resolvePiNativeModelBinding(
      settings({}),
      selection("gpt-5.4", [{ id: "thinking", value: "turbo" }]),
    );
    assert.isUndefined(unknownLevel.thinkingLevel);

    const nonReasoning = resolvePiNativeModelBinding(
      settings({ customModels: ["local/model"] }),
      selection("local/model", [{ id: "thinking", value: "high" }]),
    );
    assert.isUndefined(nonReasoning.thinkingLevel);
  });

  it("suppresses auth headers for keyless local endpoints", () => {
    assert.deepEqual(providerAuthHeaders(""), {
      authorization: null,
      "x-api-key": null,
    });
    assert.deepEqual(providerAuthHeaders("sk-1"), {});

    const keyless = resolvePiNativeModelBinding(
      settings({ baseUrl: "http://localhost:1234/v1" }),
      selection("default"),
    );
    assert.deepEqual(keyless.headers, { authorization: null, "x-api-key": null });
  });
});

describe("canonicalizeAnthropicBaseUrl", () => {
  it("strips the message path and the version prefix the SDK adds itself", () => {
    assert.equal(
      canonicalizeAnthropicBaseUrl("https://api.anthropic.com/v1/messages"),
      "https://api.anthropic.com",
    );
    assert.equal(canonicalizeAnthropicBaseUrl("https://x.test/messages"), "https://x.test");
    assert.equal(canonicalizeAnthropicBaseUrl("https://x.test/v1/"), "https://x.test");
    assert.equal(canonicalizeAnthropicBaseUrl("https://x.test/v1/v1/messages"), "https://x.test");
    assert.equal(canonicalizeAnthropicBaseUrl(" https://x.test/base "), "https://x.test/base");
  });

  it("only rewrites anthropic base URLs", () => {
    assert.equal(
      canonicalizeProviderBaseUrl("openai-responses", "https://x.test/v1/messages"),
      "https://x.test/v1/messages",
    );
  });
});

function errorStream(model: Model<string>, message: string) {
  const assistant: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: 1,
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "error", reason: "error", error: assistant });
  return stream;
}

async function errorEventMessages(
  stream: AsyncIterable<{ readonly type: string }>,
): Promise<string[]> {
  const messages: string[] = [];
  for await (const event of stream) {
    if (event.type === "error") {
      const error = (event as unknown as { readonly error: AssistantMessage }).error;
      messages.push(error.errorMessage ?? "");
    }
  }
  return messages;
}

describe("createProviderStreamFn", () => {
  it("prefers the injected override stream", async () => {
    const binding = resolvePiNativeModelBinding(settings({}), selection("default"));
    let called = 0;
    const override: StreamFn = (model) => {
      called += 1;
      return errorStream(model, "from override");
    };

    const streamFn = createProviderStreamFn({ binding, overrideStreamFn: override });
    const stream = await streamFn(binding.model, EMPTY_CONTEXT, { maxRetries: 3 });

    assert.equal(called, 1);
    assert.deepEqual(await errorEventMessages(stream), ["from override"]);
  });

  it("reports an unsupported API style as a stream error instead of throwing", async () => {
    const binding = resolvePiNativeModelBinding(settings({}), selection("default"));
    const streamFn = createProviderStreamFn({ binding, now: () => 7 });
    const unsupported = { ...binding.model, api: "mystery-api" } as Model<string>;
    const stream = await streamFn(unsupported, EMPTY_CONTEXT, undefined);

    assert.deepEqual(await errorEventMessages(stream), [
      "Pi Native does not support the mystery-api API style.",
    ]);
  });

  it("injects x-opencode-session from sessionId for OpenCode Go and OpenCode Zen endpoints", async () => {
    for (const config of [
      settings({ apiStyle: "opencode-go", defaultModel: "claude-haiku-5-5" }),
      settings({ apiStyle: "opencode-go", defaultModel: "qwen3.8-max" }),
      settings({
        apiStyle: "openai-completions",
        vendorKey: "opencode",
        baseUrl: "https://opencode.ai/zen/v1",
        defaultModel: "big-pickle",
      }),
    ]) {
      const resolved = resolvePiNativeModelBinding(config, selection("default"));
      let seen: SimpleStreamOptions | undefined;
      const streamFn = createProviderStreamFn({
        binding: resolved,
        sessionId: "thread-opencode-1",
        overrideStreamFn: (model, _context, options) => {
          seen = options;
          return errorStream(model, "ok");
        },
      });
      await streamFn(resolved.model, EMPTY_CONTEXT, { maxRetries: 1 });
      assert.equal(seen?.sessionId, "thread-opencode-1");
      assert.equal(seen?.headers?.["x-opencode-session"], "thread-opencode-1");
    }
  });

  it("falls back to a stable per-stream session id on OpenCode Go when sessionId is omitted", async () => {
    const resolved = resolvePiNativeModelBinding(
      settings({ apiStyle: "opencode-go", defaultModel: "qwen3.8-max" }),
      selection("default"),
    );
    const seen: Array<SimpleStreamOptions | undefined> = [];
    const streamFn = createProviderStreamFn({
      binding: resolved,
      overrideStreamFn: (model, _context, options) => {
        seen.push(options);
        return errorStream(model, "ok");
      },
    });
    await streamFn(resolved.model, EMPTY_CONTEXT, undefined);
    await streamFn(resolved.model, EMPTY_CONTEXT, undefined);
    const firstHeader = seen[0]?.headers?.["x-opencode-session"];
    const secondHeader = seen[1]?.headers?.["x-opencode-session"];
    assert.isString(firstHeader);
    assert.isAbove((firstHeader ?? "").length, 0);
    assert.equal(secondHeader, firstHeader);
    assert.equal(seen[0]?.sessionId, firstHeader);
  });

  it("preserves explicit X-OpenCode-Session headers and skips injection for non-OpenCode hosts", async () => {
    const customOpenCode = resolvePiNativeModelBinding(
      settings({
        apiStyle: "opencode-go",
        apiKey: "sk-test",
        defaultModel: "qwen3.8-max",
        headers: { "X-OpenCode-Session": "user-session" },
      }),
      selection("default"),
    );
    let customSeen: SimpleStreamOptions | undefined;
    const customStream = createProviderStreamFn({
      binding: customOpenCode,
      sessionId: "thread-ignored",
      overrideStreamFn: (model, _context, options) => {
        customSeen = options;
        return errorStream(model, "ok");
      },
    });
    await customStream(customOpenCode.model, EMPTY_CONTEXT, undefined);
    assert.deepEqual(customSeen?.headers, { "X-OpenCode-Session": "user-session" });

    const openai = resolvePiNativeModelBinding(
      settings({ apiKey: "sk-test" }),
      selection("default"),
    );
    let openaiSeen: SimpleStreamOptions | undefined;
    const openaiStream = createProviderStreamFn({
      binding: openai,
      sessionId: "thread-openai",
      overrideStreamFn: (model, _context, options) => {
        openaiSeen = options;
        return errorStream(model, "ok");
      },
    });
    await openaiStream(openai.model, EMPTY_CONTEXT, undefined);
    assert.equal(openaiSeen?.sessionId, "thread-openai");
    assert.isUndefined(openaiSeen?.headers?.["x-opencode-session"]);
  });
});

interface FakeDispatcher extends ProviderHttpDispatcher {
  closed: boolean;
}

function fakeDispatchers() {
  const created: FakeDispatcher[] = [];
  let now = 0;
  const createDispatcher = (): ProviderHttpDispatcher => {
    const dispatcher: FakeDispatcher = {
      closed: false,
      close: () => {
        dispatcher.closed = true;
      },
    };
    created.push(dispatcher);
    return dispatcher;
  };
  return { created, createDispatcher, advance: (ms: number) => (now += ms), now: () => now };
}

describe("ProviderHttpPool", () => {
  it("throttles rebuilds to the minimum interval and closes the stale dispatcher", () => {
    const fake = fakeDispatchers();
    const pool = new ProviderHttpPool({
      now: fake.now,
      createDispatcher: fake.createDispatcher,
    });

    assert.equal(typeof pool.getFetch(), "function");
    assert.equal(fake.created.length, 1);

    fake.advance(1_000);
    assert.equal(pool.rebuild(), false);
    assert.equal(fake.created.length, 1);

    fake.advance(30_000);
    assert.equal(pool.rebuild(), true);
    assert.equal(fake.created.length, 2);
    assert.equal(fake.created[0]?.closed, true);
    assert.equal(fake.created[1]?.closed, false);

    assert.equal(pool.rebuild(true), true);
    assert.equal(fake.created.length, 3);

    pool.close();
    assert.equal(fake.created[2]?.closed, true);
    assert.equal(pool.rebuild(true), false);
    pool.close();
  });

  it("exposes the local API key constant for keyless endpoints", () => {
    assert.equal(PI_NATIVE_LOCAL_API_KEY, "pi-native-local");
  });
});

const compatOf = (model: Model<Api>): Record<string, unknown> =>
  (model.compat ?? {}) as Record<string, unknown>;

const binding = (overrides: Partial<PiNativeSettings["modelBindings"][number]>) => ({
  id: "claude-haiku-4-5",
  contextWindow: 250_000,
  contextWindowSource: "user" as const,
  maxTokens: 32_000,
  maxTokensSource: "user" as const,
  thinkingLevels: ["low", "high"] as const,
  defaultThinkingLevel: "high" as const,
  ...overrides,
});

describe("saved model bindings", () => {
  it("resolves the default sentinel to the first binding and applies its limits", () => {
    const resolved = resolvePiNativeModelBinding(
      settings({ apiStyle: "anthropic-messages", modelBindings: [binding({})] }),
      selection("default"),
    );
    assert.equal(resolved.modelId, "claude-haiku-4-5");
    assert.equal(resolved.provider, "anthropic");
    assert.equal(resolved.model.contextWindow, 250_000);
    assert.equal(resolved.model.maxTokens, 32_000);
    assert.equal(resolved.modelBinding?.id, "claude-haiku-4-5");
    assert.equal(resolved.custom, true);
  });

  it("matches an alias and keeps the binding id as the wire model", () => {
    const resolved = resolvePiNativeModelBinding(
      settings({
        apiStyle: "anthropic-messages",
        modelBindings: [binding({ alias: "fast", displayName: "Haiku Fast" })],
      }),
      selection("fast"),
    );
    assert.equal(resolved.modelId, "claude-haiku-4-5");
    assert.equal(resolved.model.name, "Haiku Fast");
  });

  it("uses the binding default thinking level when the request names none", () => {
    const resolved = resolvePiNativeModelBinding(
      settings({ apiStyle: "anthropic-messages", modelBindings: [binding({})] }),
      selection("default"),
    );
    assert.equal(resolved.thinkingLevel, "high");
  });

  it("sends no reasoning override for omit or an explicit off", () => {
    const omit = resolvePiNativeModelBinding(
      settings({ apiStyle: "anthropic-messages", modelBindings: [binding({})] }),
      selection("default", [{ id: "thinking", value: "omit" }]),
    );
    assert.equal(omit.thinkingLevel, undefined);

    const off = resolvePiNativeModelBinding(
      settings({ apiStyle: "anthropic-messages", modelBindings: [binding({})] }),
      selection("default", [{ id: "thinking", value: "off" }]),
    );
    assert.equal(off.thinkingLevel, undefined);
  });

  it("enables reasoning on a custom binding that declares thinking levels", () => {
    const resolved = resolvePiNativeModelBinding(
      settings({
        apiStyle: "openai-completions",
        modelBindings: [
          binding({
            id: "local-reasoner",
            thinkingLevels: ["low"],
            defaultThinkingLevel: "low",
          }),
        ],
      }),
      selection("default"),
    );
    assert.equal(resolved.model.reasoning, true);
    assert.equal(resolved.thinkingLevel, "low");
  });

  it("derives image and document support from overrides before the catalog", () => {
    const resolved = resolvePiNativeModelBinding(
      settings({
        apiStyle: "anthropic-messages",
        modelBindings: [binding({ supportsImages: false, supportsDocuments: true })],
      }),
      selection("default"),
    );
    assert.equal(resolved.supportsImages, false);
    assert.equal(resolved.supportsDocuments, true);
  });

  it("routes OpenCode Go models per model wire API and default base URL", () => {
    const claude = resolvePiNativeModelBinding(
      settings({ apiStyle: "opencode-go", defaultModel: "claude-haiku-5-5" }),
      selection("default"),
    );
    assert.equal(claude.model.api, "anthropic-messages");
    assert.equal(claude.model.baseUrl, "https://opencode.ai/zen/go");
    assert.equal(claude.provider, "opencode-go");
    assert.equal(claude.apiStyle, "opencode-go");

    const qwen = resolvePiNativeModelBinding(
      settings({ apiStyle: "opencode-go", defaultModel: "qwen3.8-max" }),
      selection("default"),
    );
    assert.equal(qwen.model.api, "openai-completions");
    assert.equal(qwen.model.baseUrl, "https://opencode.ai/zen/go/v1");
  });

  it("merges sanitized user headers and keeps reserved names out", () => {
    const resolved = resolvePiNativeModelBinding(
      settings({
        apiKey: "sk-test",
        headers: { "X-Title": " T3 ", authorization: "Bearer evil", "X-Line": "a\r\nb" },
      }),
      selection("default"),
    );
    assert.deepEqual(resolved.headers, { "X-Title": "T3" });
  });

  it("applies Zhipu and DeepSeek completions compatibility", () => {
    const zhipu = resolvePiNativeModelBinding(
      settings({ apiStyle: "openai-completions", vendorKey: "zai", defaultModel: "glm-5.3" }),
      selection("default"),
    );
    assert.equal(compatOf(zhipu.model).thinkingFormat, "zai");

    const deepseek = resolvePiNativeModelBinding(
      settings({
        apiStyle: "openai-completions",
        vendorKey: "deepseek",
        defaultModel: "deepseek-v4-pro",
      }),
      selection("default"),
    );
    assert.equal(compatOf(deepseek.model).requiresReasoningContentOnAssistantMessages, true);
  });

  it("lets an explicit reasoning-effort override win over compat defaults", () => {
    const resolved = resolvePiNativeModelBinding(
      settings({
        apiStyle: "openai-completions",
        vendorKey: "zai",
        defaultModel: "glm-5.3",
        modelBindings: [binding({ id: "glm-5.3", supportsReasoningEffort: false })],
      }),
      selection("default"),
    );
    assert.equal(compatOf(resolved.model).supportsReasoningEffort, false);
  });

  it("applies an explicit Anthropic thinking protocol", () => {
    const adaptive = resolvePiNativeModelBinding(
      settings({
        apiStyle: "anthropic-messages",
        modelBindings: [binding({ thinkingProtocol: "adaptive" })],
      }),
      selection("default"),
    );
    assert.equal(compatOf(adaptive.model).forceAdaptiveThinking, true);
  });

  it("preserves slashed wire model ids and vendor key on multi-vendor relays", () => {
    const resolved = resolvePiNativeModelBinding(
      settings({
        apiStyle: "openai-completions",
        vendorKey: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        modelBindings: [binding({ id: "anthropic/claude-sonnet-4-6" })],
      }),
      selection("anthropic/claude-sonnet-4-6"),
    );
    assert.equal(resolved.modelId, "anthropic/claude-sonnet-4-6");
    assert.equal(resolved.model.id, "anthropic/claude-sonnet-4-6");
    assert.equal(resolved.provider, "openrouter");
  });
});
