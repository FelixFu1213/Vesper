import { describe, expect, it } from "@effect/vitest";

import {
  bindingDefaultThinkingMenuLevels,
  bindingForCustomModel,
  bindingFromModelInfo,
  bindingSupportsDocuments,
  bindingSupportsImages,
  CATALOG_DEFAULT_CONTEXT_WINDOW,
  CATALOG_DEFAULT_MAX_TOKENS,
  effectiveContextWindow,
  effectiveMaxTokens,
  formatTokenCount,
  modelMatchesFilter,
  type PiNativeModelInfo,
  recommendModelsForService,
  resolveBindingDefaultThinkingLevel,
  resolveBindingLimits,
  sanitizeProviderHeaders,
  sortThinkingLevels,
} from "./modelCatalog.ts";

const info = (overrides: Partial<PiNativeModelInfo> = {}): PiNativeModelInfo => ({
  modelId: "test-model",
  displayName: "Test Model",
  reasoning: true,
  toolCall: true,
  attachment: true,
  inputModalities: ["text", "image"],
  contextWindow: 200_000,
  maxTokens: 64_000,
  ...overrides,
});

describe("formatTokenCount", () => {
  it("renders compact limits", () => {
    expect(formatTokenCount(128_000)).toBe("128k");
    expect(formatTokenCount(8_192)).toBe("8.2k");
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(1_050_000)).toBe("1.05M");
    expect(formatTokenCount(200_000)).toBe("200k");
  });

  it("renders an em dash for an unpublished limit", () => {
    expect(formatTokenCount(0)).toBe("-");
    expect(formatTokenCount(undefined)).toBe("-");
  });
});

describe("thinking level helpers", () => {
  it("sorts canonically and dedupes", () => {
    expect(sortThinkingLevels(["high", "off", "medium", "high"])).toEqual([
      "off",
      "medium",
      "high",
    ]);
  });

  it("offers Auto only when the binding enables thinking", () => {
    expect(bindingDefaultThinkingMenuLevels([])).toEqual([]);
    expect(bindingDefaultThinkingMenuLevels(["high", "low"])).toEqual(["low", "high", "omit"]);
  });

  it("resolves a default against the enabled ladder", () => {
    expect(resolveBindingDefaultThinkingLevel(null, [])).toBeNull();
    expect(resolveBindingDefaultThinkingLevel(null, ["low", "high"])).toBe("low");
    expect(resolveBindingDefaultThinkingLevel(null, ["low", "medium"])).toBe("medium");
    expect(resolveBindingDefaultThinkingLevel("high", ["low"])).toBe("low");
    expect(resolveBindingDefaultThinkingLevel("omit", ["low"])).toBe("omit");
  });
});

describe("limit provenance", () => {
  it("keeps catalog and user ownership independent", () => {
    expect(effectiveContextWindow(200_000, 128_000, "catalog")).toBe(200_000);
    expect(effectiveContextWindow(200_000, 100_000, "user")).toBe(100_000);
    expect(effectiveContextWindow(undefined, 100_000, "user")).toBe(100_000);
    expect(effectiveMaxTokens(65_536, 8_192, "catalog")).toBe(65_536);
    expect(effectiveMaxTokens(65_536, 8_192, "user")).toBe(8_192);
  });

  it("resolves both limits and their provenance", () => {
    const resolved = resolveBindingLimits(
      { contextWindow: 200_000, maxTokens: 64_000, source: "catalog" },
      {
        contextWindow: 128_000,
        contextWindowSource: "catalog",
        maxTokens: 32_000,
        maxTokensSource: "user",
      },
    );
    expect(resolved.binding.contextWindow).toBe(200_000);
    expect(resolved.binding.contextWindowSource).toBe("catalog");
    expect(resolved.binding.maxTokens).toBe(32_000);
    expect(resolved.binding.maxTokensSource).toBe("user");
    expect(resolved.catalogConfig).toEqual({
      contextWindow: 200_000,
      maxTokens: 32_000,
      source: "catalog",
    });
  });

  it("never lets a generic lookup replace a saved limit", () => {
    const resolved = resolveBindingLimits(
      { contextWindow: 200_000, maxTokens: 64_000, source: "generic" },
      { contextWindow: 90_000, contextWindowSource: "catalog", maxTokens: 9_000 },
    );
    expect(resolved.binding.contextWindow).toBe(90_000);
    expect(resolved.binding.maxTokens).toBe(9_000);
  });
});

describe("binding helpers", () => {
  it("seeds a binding from published metadata", () => {
    const binding = bindingFromModelInfo(
      info({ supportedThinkingLevels: ["high", "low"], thinkingProtocol: "adaptive" }),
    );
    expect(binding.id).toBe("test-model");
    expect(binding.contextWindow).toBe(200_000);
    expect(binding.maxTokens).toBe(64_000);
    expect(binding.contextWindowSource).toBe("catalog");
    expect(binding.thinkingLevels).toEqual(["low", "high"]);
    expect(binding.defaultThinkingLevel).toBe("low");
    expect(binding.thinkingProtocol).toBe("adaptive");
  });

  it("seeds defaults for an unpublished custom id", () => {
    const binding = bindingForCustomModel("local/llama");
    expect(binding.contextWindow).toBe(CATALOG_DEFAULT_CONTEXT_WINDOW);
    expect(binding.maxTokens).toBe(CATALOG_DEFAULT_MAX_TOKENS);
    expect(binding.thinkingLevels).toEqual([]);
    expect(binding.defaultThinkingLevel).toBeNull();
  });

  it("keeps the typed id when the catalog publishes a differently cased record", () => {
    const binding = bindingForCustomModel("My-Model", info({ modelId: "my-model" }));
    expect(binding.id).toBe("My-Model");
  });

  it("follows a boolean override before the published capability", () => {
    expect(bindingSupportsImages({ supportsImages: false }, info())).toBe(false);
    expect(bindingSupportsImages({ supportsImages: null }, info())).toBe(true);
    expect(bindingSupportsDocuments(null, info({ inputModalities: ["text", "pdf"] }))).toBe(true);
    expect(bindingSupportsDocuments({ supportsDocuments: false }, info())).toBe(false);
  });
});

describe("modelMatchesFilter", () => {
  it("reads reasoning, vision, tools, attachments and pdf", () => {
    const model = info({ reasoning: false, supportedThinkingLevels: ["low"] });
    expect(modelMatchesFilter(model, "reasoning")).toBe(true);
    expect(modelMatchesFilter(model, "vision")).toBe(true);
    expect(modelMatchesFilter(model, "tools")).toBe(true);
    expect(modelMatchesFilter(model, "attachments")).toBe(true);
    expect(modelMatchesFilter(model, "pdf")).toBe(false);
    expect(modelMatchesFilter(info({ inputModalities: ["text", "pdf"] }), "pdf")).toBe(true);
  });
});

describe("recommendModelsForService", () => {
  it("picks a flagship and a fast sibling", () => {
    const models = [
      info({ modelId: "flagship-pro", displayName: "Flagship Pro" }),
      info({ modelId: "flagship-mini", displayName: "Flagship Mini", contextWindow: 128_000 }),
      info({ modelId: "text-embedding", displayName: "Embed", toolCall: false }),
    ];
    const recommended = recommendModelsForService(models, "test");
    expect(recommended.map((binding) => binding.id)).toEqual(["flagship-pro", "flagship-mini"]);
    expect(recommended.length).toBeLessThanOrEqual(3);
  });

  it("never drops every model when the catalog looks unfamiliar", () => {
    const recommended = recommendModelsForService([info({ modelId: "mystery" })]);
    expect(recommended.map((binding) => binding.id)).toEqual(["mystery"]);
  });
});

describe("sanitizeProviderHeaders", () => {
  it("trims values and drops reserved header names", () => {
    const headers = sanitizeProviderHeaders({
      " X-Custom ": "  value  ",
      Authorization: "Bearer secret",
      "x-api-key": "secret",
      "X-Line": "a\r\nb",
      empty: "",
    });
    expect(headers).toEqual({ "X-Custom": "value", empty: "" });
  });
});
