import { describe, expect, it } from "@effect/vitest";

import {
  normalizeModelList,
  probeProviderModels,
  PiNativeDiscoveryError,
  testProviderConnection,
} from "./modelDiscovery.ts";

const API_KEY = "sk-test-secret-value";

interface FetchCall {
  readonly url: string;
  readonly headers: Record<string, string>;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const redirect = (location: string, status = 307): Response =>
  new Response(null, { status, headers: { location } });

const recordingFetch = (respond: (url: string, call: number) => Response) => {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    return respond(url, calls.length - 1);
  };
  return { calls, fetchImpl };
};

const openAiModels = {
  data: [
    { id: "zeta-model", name: "Zeta", context_length: 32_000, max_output_tokens: 4_000 },
    { id: "alpha-model", context_window: 128_000 },
    { id: "alpha-model" },
    { name: "no id" },
  ],
};

describe("normalizeModelList", () => {
  it("reads the OpenAI data envelope, deduping and sorting rows", () => {
    expect(normalizeModelList("openai_models", openAiModels)).toEqual([
      { modelId: "alpha-model", displayName: "alpha-model", contextWindow: 128_000 },
      {
        modelId: "zeta-model",
        displayName: "Zeta",
        contextWindow: 32_000,
        maxTokens: 4_000,
      },
    ]);
  });

  it("reads a bare array and a models envelope", () => {
    expect(normalizeModelList("openai_models", [{ id: "solo" }])).toEqual([
      { modelId: "solo", displayName: "solo" },
    ]);
    expect(normalizeModelList("openai_models", { models: [{ slug: "zhipu-slug" }] })).toEqual([
      { modelId: "zhipu-slug", displayName: "zhipu-slug" },
    ]);
  });

  it("strips the Google models prefix and keeps its token limits", () => {
    expect(
      normalizeModelList("google_models", {
        models: [
          {
            name: "models/gemini-test",
            displayName: "Gemini Test",
            inputTokenLimit: 1_000_000,
            outputTokenLimit: 65_536,
          },
        ],
      }),
    ).toEqual([
      {
        modelId: "gemini-test",
        displayName: "Gemini Test",
        contextWindow: 1_000_000,
        maxTokens: 65_536,
      },
    ]);
  });

  it("ignores rows without an id and zero or fractional limits", () => {
    expect(
      normalizeModelList("openai_models", {
        data: [{ name: "no id" }, { id: "ok", context_window: 0, max_tokens: 1.5 }],
      }),
    ).toEqual([{ modelId: "ok", displayName: "ok" }]);
  });
});

describe("probeProviderModels", () => {
  it("asks an OpenAI-compatible endpoint with a bearer token", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(openAiModels));
    const result = await probeProviderModels(
      {
        apiStyle: "openai-completions",
        baseUrl: "https://api.example.com/v1",
        apiKey: API_KEY,
        headers: { "X-Tenant": "acme", authorization: "Bearer ignored" },
      },
      fetchImpl,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.com/v1/models");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(calls[0]?.headers["x-tenant"]).toBe("acme");
    expect(result.effectiveBaseUrl).toBe("https://api.example.com/v1");
    expect(result.resolvedFrom).toBeUndefined();
    expect(result.discoveryStyle).toBe("openai_models");
    expect(result.models.map((model) => model.modelId)).toEqual(["alpha-model", "zeta-model"]);
    expect(result.models[0]?.catalogSource).toBe("discovered");
    expect(result.models[1]?.maxTokens).toBe(4_000);
  });

  it("asks Anthropic on /v1/models with its own auth headers", async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
      jsonResponse({ data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" }] }),
    );
    const result = await probeProviderModels(
      { apiStyle: "anthropic-messages", baseUrl: "https://api.anthropic.com", apiKey: API_KEY },
      fetchImpl,
    );
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/models");
    expect(calls[0]?.headers["x-api-key"]).toBe(API_KEY);
    expect(calls[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(result.discoveryStyle).toBe("anthropic_models");
    expect(result.models[0]?.displayName).toBe("Claude Sonnet 4.5");
  });

  it("asks Google with its key header and default base URL", async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
      jsonResponse({ models: [{ name: "models/gemini-test", displayName: "Gemini Test" }] }),
    );
    const result = await probeProviderModels(
      { apiStyle: "google-generative-ai", baseUrl: "", apiKey: API_KEY },
      fetchImpl,
    );
    expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(calls[0]?.headers["x-goog-api-key"]).toBe(API_KEY);
    expect(result.models[0]?.modelId).toBe("gemini-test");
  });

  it("sweeps to /v1 on the same origin when the typed base URL 404s", async () => {
    const { calls, fetchImpl } = recordingFetch((url, call) =>
      call === 0 ? jsonResponse({}, 404) : jsonResponse({ data: [{ id: "acme-chat" }] }),
    );
    const result = await probeProviderModels(
      { apiStyle: "openai-completions", baseUrl: "https://gateway.example.com/api" },
      fetchImpl,
    );
    expect(calls.map((call) => call.url)).toEqual([
      "https://gateway.example.com/api/models",
      "https://gateway.example.com/api/v1/models",
    ]);
    expect(result.effectiveBaseUrl).toBe("https://gateway.example.com/api/v1");
    expect(result.resolvedFrom).toBe("https://gateway.example.com/api");
  });

  it("fails fast on a refused credential and never echoes the key", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({}, 401));
    const error = await probeProviderModels(
      {
        apiStyle: "openai-completions",
        baseUrl: "https://gateway.example.com/api",
        apiKey: API_KEY,
      },
      fetchImpl,
    ).catch((cause: unknown) => cause);
    expect(calls).toHaveLength(1);
    expect(error).toBeInstanceOf(PiNativeDiscoveryError);
    expect((error as PiNativeDiscoveryError).reason).toBe("authentication_failed");
    expect((error as PiNativeDiscoveryError).message).toContain("HTTP 401");
    expect((error as PiNativeDiscoveryError).message).not.toContain(API_KEY);
  });

  it("refuses a pasted base URL with a query string", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(openAiModels));
    const error = await probeProviderModels(
      { apiStyle: "openai-completions", baseUrl: "https://api.example.com/v1?key=1" },
      fetchImpl,
    ).catch((cause: unknown) => cause);
    expect(calls).toHaveLength(0);
    expect((error as PiNativeDiscoveryError).reason).toBe("invalid_endpoint");
    expect((error as PiNativeDiscoveryError).message).toBe(
      "Remove the query string and fragment from the URL.",
    );
  });

  it("follows a same-origin redirect with its credential", async () => {
    const { calls, fetchImpl } = recordingFetch((_url, call) =>
      call === 0 ? redirect("/v1/models") : jsonResponse({ data: [{ id: "acme-chat" }] }),
    );
    const result = await probeProviderModels(
      {
        apiStyle: "openai-completions",
        baseUrl: "https://gateway.example.com",
        apiKey: API_KEY,
      },
      fetchImpl,
    );
    expect(calls[1]?.url).toBe("https://gateway.example.com/v1/models");
    expect(calls[1]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(result.models[0]?.modelId).toBe("acme-chat");
  });

  it("drops the credential when a redirect leaves the origin", async () => {
    const { calls, fetchImpl } = recordingFetch((_url, call) =>
      call === 0
        ? redirect("https://mirror.example.com/v1/models")
        : jsonResponse({ data: [{ id: "acme-chat" }] }),
    );
    await probeProviderModels(
      {
        apiStyle: "openai-completions",
        baseUrl: "https://gateway.example.com/v1",
        apiKey: API_KEY,
        headers: { "X-Tenant": "acme" },
      },
      fetchImpl,
    );
    expect(calls[1]?.url).toBe("https://mirror.example.com/v1/models");
    expect(calls[1]?.headers).toEqual({});
  });

  it("blocks a redirect to another scheme or to a credentialed URL", async () => {
    const blockedScheme = recordingFetch(() => redirect("file:///etc/passwd"));
    const schemeError = await probeProviderModels(
      { apiStyle: "openai-completions", baseUrl: "https://gateway.example.com/v1" },
      blockedScheme.fetchImpl,
    ).catch((cause: unknown) => cause);
    expect((schemeError as PiNativeDiscoveryError).message).toBe(
      "The endpoint redirected to an unsupported scheme.",
    );

    const credentialed = recordingFetch(() => redirect("https://user:pass@gateway.example.com/v1"));
    const credentialError = await probeProviderModels(
      { apiStyle: "openai-completions", baseUrl: "https://gateway.example.com/v1" },
      credentialed.fetchImpl,
    ).catch((cause: unknown) => cause);
    expect((credentialError as PiNativeDiscoveryError).message).toBe(
      "The endpoint redirected to a credentialed address.",
    );
  });

  it("treats a missing model list on Anthropic Messages as reachable", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({}, 404));
    const result = await probeProviderModels(
      { apiStyle: "anthropic-messages", baseUrl: "https://anthropic-proxy.example.com" },
      fetchImpl,
    );
    expect(result.models).toEqual([]);
    expect(result.skippedDiscovery).toBe(true);
    expect(result.warning).toBe(
      "This endpoint does not publish a /models list; add model IDs manually.",
    );
  });

  it("treats a missing model list on a token plan as reachable", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({}, 405));
    const result = await probeProviderModels(
      { apiStyle: "anthropic-messages", baseUrl: "", vendorKey: "stepfun-plan" },
      fetchImpl,
    );
    expect(calls[0]?.url).toBe("https://api.stepfun.com/step_plan/v1/models");
    expect(result.skippedDiscovery).toBe(true);
    expect(result.models).toEqual([]);
  });

  it("reports a missing model list on a plain OpenAI endpoint as a failure", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({}, 404));
    const error = await probeProviderModels(
      { apiStyle: "openai-completions", baseUrl: "https://gateway.example.com/v1" },
      fetchImpl,
    ).catch((cause: unknown) => cause);
    expect((error as PiNativeDiscoveryError).message).toBe(
      "The endpoint's model list request failed (HTTP 404).",
    );
  });

  it("falls back to the protocol default when settings name no endpoint", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(openAiModels));
    const result = await probeProviderModels(
      { apiStyle: "openai-responses", baseUrl: "", vendorKey: "custom" },
      fetchImpl,
    );
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(result.effectiveBaseUrl).toBe("https://api.openai.com/v1");
  });

  it("sends x-opencode-session on OpenCode Go probes unless the user supplies one", async () => {
    const generated = recordingFetch(() => jsonResponse(openAiModels));
    await probeProviderModels(
      {
        apiStyle: "opencode-go",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: API_KEY,
      },
      generated.fetchImpl,
    );
    expect(generated.calls[0]?.headers["x-opencode-session"]).toBeTruthy();

    const custom = recordingFetch(() => jsonResponse(openAiModels));
    await probeProviderModels(
      {
        apiStyle: "opencode-go",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: API_KEY,
        headers: { "X-OpenCode-Session": "custom-probe-session" },
      },
      custom.fetchImpl,
    );
    expect(custom.calls[0]?.headers["x-opencode-session"]).toBe("custom-probe-session");
  });
});

describe("testProviderConnection", () => {
  it("reports a reachable endpoint with its model count", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(openAiModels));
    const result = await testProviderConnection(
      { apiStyle: "openai-completions", baseUrl: "https://api.example.com/v1", apiKey: API_KEY },
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    expect(result.modelCount).toBe(2);
    expect(result.effectiveBaseUrl).toBe("https://api.example.com/v1");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
    expect(result.warning).toBeUndefined();
  });

  it("reports a refused credential without leaking it", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({}, 403));
    const result = await testProviderConnection(
      { apiStyle: "openai-completions", baseUrl: "https://api.example.com/v1", apiKey: API_KEY },
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("HTTP 403");
    expect(result.error).not.toContain(API_KEY);
  });

  it("passes a skipped model list through as a warning", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({}, 404));
    const result = await testProviderConnection(
      { apiStyle: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    expect(result.modelCount).toBe(0);
    expect(result.warning).toContain("does not publish a /models list");
  });

  it("reports an unreachable host as a plain failure", async () => {
    const fetchImpl: typeof globalThis.fetch = () => Promise.reject(new TypeError("fetch failed"));
    const result = await testProviderConnection(
      { apiStyle: "openai-completions", baseUrl: "https://offline.example.com/v1" },
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("The endpoint could not be reached.");
  });

  it("treats an HTTP 200 empty model list as a warning instead of an error", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ data: [] }));
    const probed = await probeProviderModels(
      { apiStyle: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1" },
      fetchImpl,
    );
    expect(probed.models).toEqual([]);
    expect(probed.warning).toContain("returned no models");

    const tested = await testProviderConnection(
      { apiStyle: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1" },
      fetchImpl,
    );
    expect(tested.ok).toBe(true);
    expect(tested.modelCount).toBe(0);
    expect(tested.warning).toContain("returned no models");
  });
});
