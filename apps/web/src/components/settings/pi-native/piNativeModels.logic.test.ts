import { ProviderInstanceId, type ProviderInstanceConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applySortOrderToProviderInstances,
  buildPiNativeConfig,
  buildPiNativeInstance,
  buildReorderSortUpdates,
  clampModelAlias,
  copyServiceDraft,
  copyServiceName,
  createEmptyHeaderPair,
  derivePiNativeInstanceId,
  filterBindings,
  filterModelInfos,
  filterVendorPresets,
  hasBinding,
  hasStoredApiKey,
  headerNameIssue,
  listPiNativeServices,
  mergeLookupEnrichment,
  moveListEntry,
  pairsToRecord,
  readPiNativeServiceConfig,
  recordToPairs,
  serviceDisplayLabel,
  setVisibleBindings,
  toggleBinding,
  type PiNativeServiceConfig,
} from "./piNativeModels.logic";

const instance = (
  driver: string,
  config: Record<string, unknown> = {},
  overrides: Partial<ProviderInstanceConfig> = {},
): ProviderInstanceConfig => ({
  driver: driver as ProviderInstanceConfig["driver"],
  enabled: true,
  config,
  ...overrides,
});

const serviceConfig = (): PiNativeServiceConfig => readPiNativeServiceConfig({});

const modelInfo = (input: {
  modelId: string;
  displayName?: string;
  reasoning?: boolean;
  toolCall?: boolean;
  attachment?: boolean;
  modalities?: ReadonlyArray<string>;
}) => ({
  modelId: input.modelId,
  displayName: input.displayName ?? input.modelId,
  reasoning: input.reasoning ?? false,
  toolCall: input.toolCall ?? true,
  attachment: input.attachment ?? false,
  inputModalities: (input.modalities ?? ["text"]) as never,
  contextWindow: 128_000,
  maxTokens: 8_192,
});

describe("readPiNativeServiceConfig", () => {
  it("normalizes a stored blob without trusting it", () => {
    expect(
      readPiNativeServiceConfig({
        vendorKey: "deepseek",
        apiStyle: "not-a-style",
        baseUrl: "  https://api.deepseek.com  ",
        apiKey: "sk-live",
        headers: { "X-Trace": "1", bad: 2 },
        modelBindings: [{ id: "deepseek-chat" }, { id: "  " }],
        sortOrder: 3,
        autoCompact: false,
      }),
    ).toEqual({
      vendorKey: "deepseek",
      apiStyle: "openai-responses",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-live",
      headers: { "X-Trace": "1" },
      defaultModel: "",
      modelBindings: [
        {
          id: "deepseek-chat",
          contextWindow: 0,
          maxTokens: 0,
          thinkingLevels: [],
          defaultThinkingLevel: null,
          supportsReasoningEffort: undefined,
          supportsImages: undefined,
          supportsDocuments: undefined,
        },
      ],
      sortOrder: 3,
      autoCompact: false,
      infiniteRetry: false,
      enableSubagents: true,
      customModels: [],
    });
  });

  it("keeps a secret reference instead of flattening it to a literal", () => {
    const reference = { provider: "onepassword" as never, reference: "op://vault/key" };
    expect(readPiNativeServiceConfig({ apiKey: reference }).apiKey).toEqual(reference);
  });

  it("falls back to defaults for a missing config", () => {
    expect(readPiNativeServiceConfig(undefined)).toMatchObject({
      vendorKey: "",
      apiStyle: "openai-responses",
      baseUrl: "",
      apiKey: "",
      headers: {},
      modelBindings: [],
      sortOrder: undefined,
      autoCompact: true,
      infiniteRetry: false,
      enableSubagents: true,
    });
  });
});

describe("listPiNativeServices", () => {
  it("keeps only Pi Native rows, ordered by sortOrder then key order", () => {
    const services = listPiNativeServices({
      [ProviderInstanceId.make("codex")]: instance("codex"),
      [ProviderInstanceId.make("piNative_b")]: instance("piNative", { sortOrder: 1 }),
      [ProviderInstanceId.make("piNative_a")]: instance("piNative", { sortOrder: 0 }),
      [ProviderInstanceId.make("piNative_c")]: instance("piNative", {}),
      [ProviderInstanceId.make("piNative_d")]: instance("piNative", {}),
    });
    expect(services.map((service) => String(service.instanceId))).toEqual([
      "piNative_a",
      "piNative_b",
      "piNative_c",
      "piNative_d",
    ]);
  });

  it("reads enabled state through the shared resolver", () => {
    const [service] = listPiNativeServices({
      [ProviderInstanceId.make("piNative_x")]: instance("piNative", {}, { enabled: false }),
    });
    expect(service?.enabled).toBe(false);
  });
});

describe("derivePiNativeInstanceId", () => {
  it("slugs the vendor key", () => {
    expect(String(derivePiNativeInstanceId("moonshotai-cn", []))).toBe("piNative_moonshotai-cn");
    expect(String(derivePiNativeInstanceId(undefined, []))).toBe("piNative_custom");
  });

  it("suffixes around ids that are already taken", () => {
    expect(String(derivePiNativeInstanceId("openai", ["piNative_openai"]))).toBe(
      "piNative_openai_2",
    );
    expect(
      String(derivePiNativeInstanceId("openai", ["piNative_openai", "piNative_openai_2"])),
    ).toBe("piNative_openai_3");
  });

  it("never returns an id that starts with a digit", () => {
    expect(String(derivePiNativeInstanceId("2048-labs", []))).toBe("piNative_2048-labs");
  });
});

describe("copyServiceDraft", () => {
  it("renames and strips the credential", () => {
    const draft = copyServiceDraft({
      ...serviceConfig(),
      vendorKey: "openai",
      apiKey: "sk-live",
      sortOrder: 4,
      modelBindings: [
        {
          id: "gpt-5",
          contextWindow: 400_000,
          maxTokens: 32_768,
          thinkingLevels: ["medium"],
          defaultThinkingLevel: "medium",
        },
      ],
    });
    expect(draft.apiKey).toBe("");
    expect(draft.sortOrder).toBeUndefined();
    expect(draft.modelBindings).toHaveLength(1);
    expect(copyServiceName("OpenAI")).toBe("OpenAI Copy");
    expect(copyServiceName("   ")).toBe("Copy");
  });
});

describe("reorder helpers", () => {
  it("moves an entry and rewrites every sort order", () => {
    expect(moveListEntry(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(
      buildReorderSortUpdates([
        ProviderInstanceId.make("piNative_c"),
        ProviderInstanceId.make("piNative_a"),
        ProviderInstanceId.make("piNative_b"),
      ]),
    ).toEqual({ piNative_c: 0, piNative_a: 1, piNative_b: 2 });
  });

  it("patches sortOrder on Pi Native rows only and leaves the rest untouched", () => {
    const codex = instance("codex");
    const next = applySortOrderToProviderInstances(
      {
        [ProviderInstanceId.make("codex")]: codex,
        [ProviderInstanceId.make("piNative_a")]: instance("piNative", {
          apiStyle: "openai-completions",
        }),
      },
      { piNative_a: 7 },
    );
    expect(next[ProviderInstanceId.make("codex")]).toBe(codex);
    expect(next[ProviderInstanceId.make("piNative_a")]?.config).toEqual({
      apiStyle: "openai-completions",
      sortOrder: 7,
    });
  });
});

describe("serviceDisplayLabel", () => {
  it("prefers the row name, then the matched preset, then the id", () => {
    expect(
      serviceDisplayLabel({
        vendorKey: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiStyle: "openai-responses",
        displayName: "Work OpenAI",
      }),
    ).toBe("Work OpenAI");
    expect(
      serviceDisplayLabel({
        vendorKey: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiStyle: "openai-responses",
      }),
    ).toBe("OpenAI");
    expect(
      serviceDisplayLabel({
        vendorKey: "custom",
        baseUrl: "http://localhost:1234",
        apiStyle: "openai-completions",
        instanceId: ProviderInstanceId.make("piNative_custom"),
      }),
    ).toBe("piNative_custom");
  });
});

describe("clampModelAlias", () => {
  it("counts code points so an emoji is never split", () => {
    const long = "😀".repeat(70);
    expect([...clampModelAlias(long)]).toHaveLength(60);
    expect(clampModelAlias("short")).toBe("short");
  });
});

describe("headers", () => {
  it("round-trips pairs, dropping reserved and broken names", () => {
    const pairs = [
      ...recordToPairs({ "X-Trace-Id": "abc", Authorization: "nope" }),
      { key: "manual", name: "Bad\nName", value: "x" },
      { key: "blank", name: "  ", value: "y" },
    ];
    expect(pairsToRecord(pairs)).toEqual({ "X-Trace-Id": "abc" });
    expect(headerNameIssue("Authorization")).toBe("Reserved by the transport.");
    expect(headerNameIssue("X-Ok")).toBeUndefined();
  });

  it("gives every blank header row its own key", () => {
    const keys = Array.from({ length: 4 }, () => createEmptyHeaderPair().key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(pairsToRecord([createEmptyHeaderPair()])).toEqual({});
  });
});

describe("filters", () => {
  const models = [
    modelInfo({ modelId: "gpt-5", displayName: "GPT-5", reasoning: true }),
    modelInfo({ modelId: "gpt-5-mini", displayName: "GPT-5 mini", modalities: ["text", "image"] }),
    modelInfo({ modelId: "whisper-1", displayName: "Whisper", toolCall: false }),
  ];

  it("matches the query across id and display name", () => {
    expect(filterModelInfos(models, "mini", []).map((model) => model.modelId)).toEqual([
      "gpt-5-mini",
    ]);
  });

  it("requires every capability filter", () => {
    expect(filterModelInfos(models, "", ["reasoning"]).map((model) => model.modelId)).toEqual([
      "gpt-5",
    ]);
    expect(filterModelInfos(models, "", ["vision"]).map((model) => model.modelId)).toEqual([
      "gpt-5-mini",
    ]);
  });

  it("matches vendor presets by alias", () => {
    expect(filterVendorPresets("gemini").map((preset) => preset.id)).toEqual(["google"]);
    expect(filterVendorPresets("  ")).toHaveLength(filterVendorPresets("").length);
  });
});

describe("model selection", () => {
  const binding = (id: string, alias?: string) => ({
    id,
    ...(alias === undefined ? {} : { alias }),
    contextWindow: 128_000,
    maxTokens: 8_192,
    thinkingLevels: [],
    defaultThinkingLevel: null,
  });

  it("adds then removes a model, and recognizes existing ids case-insensitively", () => {
    const added = toggleBinding([], binding("GPT-5"));
    expect(hasBinding(added, "gpt-5")).toBe(true);
    expect(toggleBinding(added, binding("gpt-5"))).toEqual([]);
  });

  it("selects and clears only the visible models", () => {
    const selected = setVisibleBindings([binding("kept")], [binding("a"), binding("b")], true);
    expect(selected.map((entry) => entry.id)).toEqual(["kept", "a", "b"]);
    expect(setVisibleBindings(selected, [binding("a")], false).map((entry) => entry.id)).toEqual([
      "kept",
      "b",
    ]);
  });

  it("filters selected bindings by alias", () => {
    expect(filterBindings([binding("gpt-5", "flagship")], "flag").map((entry) => entry.id)).toEqual(
      ["gpt-5"],
    );
  });
});

describe("mergeLookupEnrichment", () => {
  const pending = {
    id: "my-model",
    contextWindow: 128_000,
    contextWindowSource: "catalog" as const,
    maxTokens: 8_192,
    maxTokensSource: "catalog" as const,
    thinkingLevels: [],
    defaultThinkingLevel: null,
    supportsImages: null,
    supportsDocuments: null,
  };
  const enriched = {
    id: "my-model",
    displayName: "My Model",
    contextWindow: 200_000,
    contextWindowSource: "catalog" as const,
    maxTokens: 32_768,
    maxTokensSource: "catalog" as const,
    thinkingLevels: ["low", "medium"] as const,
    defaultThinkingLevel: "medium" as const,
    thinkingProtocol: "adaptive" as const,
    supportsImages: true,
    supportsDocuments: true,
  };

  it("fills a catalog-seeded binding, including its thinking ladder", () => {
    expect(
      mergeLookupEnrichment(pending, { ...enriched, thinkingLevels: [...enriched.thinkingLevels] }),
    ).toMatchObject({
      id: "my-model",
      displayName: "My Model",
      contextWindow: 200_000,
      maxTokens: 32_768,
      thinkingLevels: ["low", "medium"],
      defaultThinkingLevel: "medium",
      thinkingProtocol: "adaptive",
    });
  });

  it("keeps edits the user made while the lookup was in flight", () => {
    const edited = {
      ...pending,
      alias: "fast one",
      displayName: "My Model",
      contextWindow: 64_000,
      contextWindowSource: "user" as const,
      maxTokensSource: "user" as const,
      supportsReasoningEffort: null,
      supportsImages: false,
      availableForSubagents: true,
      thinkingLevels: ["high"] as const,
      defaultThinkingLevel: "omit" as const,
    };
    expect(
      mergeLookupEnrichment(edited, { ...enriched, thinkingLevels: [...enriched.thinkingLevels] }),
    ).toMatchObject({
      alias: "fast one",
      contextWindow: 64_000,
      maxTokens: 8_192,
      supportsReasoningEffort: null,
      supportsImages: false,
      // An explicit "follow the catalog" override is a choice the lookup must not replace.
      supportsDocuments: null,
      availableForSubagents: true,
      thinkingLevels: ["high"],
      defaultThinkingLevel: "omit",
    });
  });

  it("adopts the catalog name over a bare id", () => {
    expect(
      mergeLookupEnrichment({ ...pending, displayName: "my-model" }, enriched).displayName,
    ).toBe("My Model");
  });

  it("fills capability overrides that were never set", () => {
    const bare = {
      id: "my-model",
      contextWindow: 128_000,
      maxTokens: 8_192,
      thinkingLevels: [] as const,
      defaultThinkingLevel: null,
    };
    expect(mergeLookupEnrichment(bare, enriched)).toMatchObject({
      supportsImages: true,
      supportsDocuments: true,
      contextWindowSource: "catalog",
    });
  });
});

describe("hasStoredApiKey", () => {
  it("knows when a stored key exists", () => {
    expect(hasStoredApiKey(" abc ")).toBe(true);
    expect(hasStoredApiKey("")).toBe(false);
    expect(hasStoredApiKey({ provider: "onepassword" as never, reference: "op://vault/key" })).toBe(
      true,
    );
  });
});

describe("buildPiNativeInstance", () => {
  it("writes the first binding as the default model", () => {
    const built = buildPiNativeInstance({
      enabled: true,
      displayName: " Work ",
      accentColor: "#ffffff",
      config: {
        ...buildPiNativeConfig({
          enabled: true,
          vendorKey: "openai",
          apiStyle: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-live",
          headers: {},
          sortOrder: undefined,
          autoCompact: true,
          infiniteRetry: false,
          enableSubagents: true,
          customModels: [],
          modelBindings: [
            {
              id: "gpt-5",
              contextWindow: 400_000,
              maxTokens: 32_768,
              thinkingLevels: [],
              defaultThinkingLevel: null,
            },
          ],
        }),
      },
    });
    expect(built).toMatchObject({
      driver: "piNative",
      enabled: true,
      displayName: "Work",
      accentColor: "#ffffff",
    });
    expect(built.config).toMatchObject({ defaultModel: "gpt-5" });
  });
});
