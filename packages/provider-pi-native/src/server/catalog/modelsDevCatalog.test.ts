// @effect-diagnostics nodeBuiltinImport:off -- Catalog tests exercise the real cache file.
import { describe, expect, it } from "@effect/vitest";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  bindingFromModelInfo,
  CATALOG_DEFAULT_CONTEXT_WINDOW,
  CATALOG_DEFAULT_MAX_TOKENS,
} from "../../catalog/modelCatalog.ts";
import { createModelsDevCatalog } from "./modelsDevCatalog.ts";

const CACHE_FILE_NAME = "pi-native-models-dev-cache.json";

const withStateDir = async (body: (stateDir: string) => Promise<void>): Promise<void> => {
  const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-native-catalog-"));
  try {
    await body(stateDir);
  } finally {
    await NodeFSP.rm(stateDir, { recursive: true, force: true });
  }
};

const acmeVendor = {
  id: "acme",
  name: "Acme",
  models: {
    "acme-chat": {
      id: "acme-chat",
      name: "Acme Chat",
      family: "acme",
      reasoning: true,
      tool_call: true,
      attachment: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: 256_000, output: 32_000 },
    },
  },
};

const writeCache = async (stateDir: string, payload: unknown): Promise<void> => {
  await NodeFSP.writeFile(
    NodePath.join(stateDir, CACHE_FILE_NAME),
    JSON.stringify(payload),
    "utf8",
  );
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("models.dev catalog", () => {
  it("reports an empty status before the bundled snapshot is loaded", () => {
    const catalog = createModelsDevCatalog();
    expect(catalog.getStatus()).toEqual({
      loaded: false,
      source: "empty",
      providerCount: 0,
      modelCount: 0,
    });
  });

  it("loads the bundled snapshot without touching the network", async () => {
    const catalog = createModelsDevCatalog({
      fetch: () => Promise.reject(new Error("no network in this test")),
    });
    expect(await catalog.ensureLoaded()).toBe(true);
    const status = catalog.getStatus();
    expect(status.loaded).toBe(true);
    expect(status.source).toBe("bundled");
    expect(status.providerCount).toBeGreaterThan(0);
    expect(status.modelCount).toBeGreaterThan(0);
    expect(status.lastError).toBeUndefined();
  });

  it("maps a published record to model capabilities", async () => {
    const catalog = createModelsDevCatalog();
    const model = await catalog.lookupModel("claude-sonnet-4-5", "anthropic");
    expect(model?.displayName).toBe("Claude Sonnet 4.5 (latest)");
    expect(model?.reasoning).toBe(true);
    expect(model?.toolCall).toBe(true);
    expect(model?.attachment).toBe(true);
    expect(model?.inputModalities).toEqual(["text", "image", "pdf"]);
    expect(model?.contextWindow).toBe(200_000);
    expect(model?.maxTokens).toBe(64_000);
    expect(model?.thinkingProtocol).toBe("legacy");
    expect(model?.catalogSource).toBe("models.dev");
  });

  it("resolves a vendor through its preset aliases", async () => {
    const catalog = createModelsDevCatalog();
    const model = await catalog.lookupModel("qwen3.8-max", "dashscope");
    expect(model?.vendorKey).toBe("alibaba-cn");
    expect(model?.contextWindow).toBe(1_000_000);
  });

  it("resolves a route-prefixed id by its unique leaf", async () => {
    const catalog = createModelsDevCatalog();
    const model = await catalog.lookupModel("gateway/claude-sonnet-4-5");
    expect(model?.modelId).toBe("claude-sonnet-4-5");
  });

  it("enriches from pi-ai only where models.dev publishes nothing", async () => {
    const catalog = createModelsDevCatalog();
    const vertexModel = getBuiltinModels("google-vertex")[0];
    expect(vertexModel).toBeDefined();
    const enriched = await catalog.lookupModel(vertexModel!.id, "google-vertex");
    expect(enriched?.catalogSource).toBe("pi-ai");
    expect(enriched?.vendorKey).toBe("google-vertex");

    // The weight owner's own record outranks the resold copy.
    const published = await catalog.lookupModel("claude-opus-5", "anthropic");
    expect(published?.catalogSource).toBe("models.dev");
  });

  it("reads a cached snapshot and prefers it over the bundled one", async () => {
    await withStateDir(async (stateDir) => {
      await writeCache(stateDir, {
        fetchedAt: "2025-01-02T03:04:05.000Z",
        data: { acme: acmeVendor },
      });
      const catalog = createModelsDevCatalog({ stateDir });
      await catalog.ensureLoaded();
      const status = catalog.getStatus();
      expect(status.source).toBe("remote");
      expect(status.fetchedAt).toBe("2025-01-02T03:04:05.000Z");
      expect(status.providerCount).toBe(1);
      expect(status.modelCount).toBe(1);
      expect((await catalog.lookupModel("acme-chat", "acme"))?.contextWindow).toBe(256_000);
    });
  });

  it("falls back to the bundled snapshot when the cache is unusable", async () => {
    await withStateDir(async (stateDir) => {
      await NodeFSP.writeFile(NodePath.join(stateDir, CACHE_FILE_NAME), "{not json", "utf8");
      const catalog = createModelsDevCatalog({ stateDir });
      await catalog.ensureLoaded();
      expect(catalog.getStatus().source).toBe("bundled");
      expect(catalog.getStatus().providerCount).toBeGreaterThan(1);
    });
  });

  it("does not guess when two vendors publish different models under one leaf", async () => {
    await withStateDir(async (stateDir) => {
      await writeCache(stateDir, {
        fetchedAt: "2025-01-02T03:04:05.000Z",
        data: {
          acme: {
            id: "acme",
            name: "Acme",
            models: {
              "relay/foo-model": { id: "relay/foo-model", name: "Foo", tool_call: true },
            },
          },
          other: {
            id: "other",
            name: "Other",
            models: {
              "house/foo-model": { id: "house/foo-model", name: "Foo", tool_call: true },
            },
          },
        },
      });
      const catalog = createModelsDevCatalog({ stateDir });
      expect(await catalog.lookupModel("foo-model")).toBeUndefined();
    });
  });

  it("strips a release stamp only to reach one unambiguous record", async () => {
    await withStateDir(async (stateDir) => {
      await writeCache(stateDir, {
        fetchedAt: "2025-01-02T03:04:05.000Z",
        data: {
          acme: {
            id: "acme",
            name: "Acme",
            models: { "acme-chat": { id: "acme-chat", name: "Acme Chat", tool_call: true } },
          },
        },
      });
      const catalog = createModelsDevCatalog({ stateDir });
      const stamped = await catalog.lookupModel("acme-chat-20250102", "acme");
      expect(stamped?.modelId).toBe("acme-chat");
      const dated = await catalog.lookupModel("acme-chat-2025-01-02", "acme");
      expect(dated?.modelId).toBe("acme-chat");
    });
  });

  it("keeps the endpoint's reported limits over the catalog's own", async () => {
    const catalog = createModelsDevCatalog();
    const [model] = await catalog.enrichDiscoveredModels(
      [
        {
          modelId: "claude-sonnet-4-5",
          displayName: "Claude Sonnet 4.5",
          contextWindow: 32_768,
          maxTokens: 4_096,
        },
      ],
      "anthropic",
    );
    expect(model?.contextWindow).toBe(32_768);
    expect(model?.maxTokens).toBe(4_096);
    expect(model?.reasoning).toBe(true);
    expect(model?.inputModalities).toEqual(["text", "image", "pdf"]);
    expect(model?.catalogSource).toBe("models.dev");
  });

  it("seeds an uncatalogued model with generic text capabilities", async () => {
    const catalog = createModelsDevCatalog();
    const [model] = await catalog.enrichDiscoveredModels([
      { modelId: "local-llm", displayName: "Local LLM" },
    ]);
    expect(model).toEqual({
      modelId: "local-llm",
      displayName: "Local LLM",
      reasoning: false,
      toolCall: true,
      attachment: false,
      inputModalities: ["text"],
      contextWindow: CATALOG_DEFAULT_CONTEXT_WINDOW,
      maxTokens: CATALOG_DEFAULT_MAX_TOKENS,
      catalogSource: "discovered",
    });
  });

  it("replaces the catalog from a remote refresh and caches the snapshot", async () => {
    await withStateDir(async (stateDir) => {
      const catalog = createModelsDevCatalog({
        stateDir,
        fetch: () => Promise.resolve(jsonResponse({ acme: acmeVendor })),
        now: () => 0,
      });
      await catalog.ensureLoaded();
      const refreshed = await catalog.refresh();
      expect(refreshed.updated).toBe(true);
      expect(refreshed.status.source).toBe("remote");
      expect(refreshed.status.fetchedAt).toBe("1970-01-01T00:00:00.000Z");
      expect(refreshed.status.providerCount).toBe(1);
      expect(refreshed.status.lastError).toBeUndefined();

      const cached = createModelsDevCatalog({ stateDir });
      await cached.ensureLoaded();
      expect(cached.getStatus().source).toBe("remote");
      expect(cached.getStatus().fetchedAt).toBe("1970-01-01T00:00:00.000Z");
      expect((await cached.lookupModel("acme-chat", "acme"))?.maxTokens).toBe(32_000);
    });
  });

  it("keeps the loaded catalog when a refresh fails", async () => {
    const catalog = createModelsDevCatalog({
      fetch: () => Promise.resolve(new Response("nope", { status: 503 })),
    });
    await catalog.ensureLoaded();
    const before = catalog.getStatus();
    const refreshed = await catalog.refresh();
    expect(refreshed.updated).toBe(false);
    expect(refreshed.status.lastError).toBe("models.dev catalog request failed (503)");
    expect(refreshed.status.modelCount).toBe(before.modelCount);
    expect(refreshed.status.source).toBe("bundled");
    expect(await catalog.lookupModel("claude-sonnet-4-5", "anthropic")).toBeDefined();
  });

  it("reports a network failure without dropping the bundled records", async () => {
    const catalog = createModelsDevCatalog({
      fetch: () => Promise.reject(new Error("getaddrinfo ENOTFOUND models.dev")),
    });
    await catalog.ensureLoaded();
    const refreshed = await catalog.refresh();
    expect(refreshed.updated).toBe(false);
    expect(refreshed.status.lastError).toBe("getaddrinfo ENOTFOUND models.dev");
    expect(refreshed.status.loaded).toBe(true);
    expect(refreshed.status.providerCount).toBeGreaterThan(0);
  });

  it("refuses a remote payload with no usable providers", async () => {
    const catalog = createModelsDevCatalog({
      fetch: () => Promise.resolve(jsonResponse({ broken: { models: {} } })),
    });
    await catalog.ensureLoaded();
    const refreshed = await catalog.refresh();
    expect(refreshed.updated).toBe(false);
    expect(refreshed.status.lastError).toBe("models.dev catalog published no usable providers.");
    expect(refreshed.status.modelCount).toBeGreaterThan(0);
  });

  it("populates supported thinking levels for reasoning models and enriches echoed display names", async () => {
    const catalog = createModelsDevCatalog();
    const sonnet = await catalog.lookupModel("claude-sonnet-4-5", "anthropic");
    expect(sonnet?.reasoning).toBe(true);
    expect((sonnet?.supportedThinkingLevels?.length ?? 0) > 0).toBe(true);
    if (sonnet !== undefined) {
      expect(bindingFromModelInfo(sonnet).thinkingLevels.length).toBeGreaterThan(0);
    }

    const enriched = await catalog.enrichDiscoveredModels(
      [
        { modelId: "claude-sonnet-4-5", displayName: "claude-sonnet-4-5" },
        { modelId: "claude-sonnet-4-5", displayName: "Custom Endpoint Name" },
      ],
      "anthropic",
    );
    expect(enriched[0]?.displayName).toBe(sonnet?.displayName);
    expect(enriched[1]?.displayName).toBe("Custom Endpoint Name");
  });
});
