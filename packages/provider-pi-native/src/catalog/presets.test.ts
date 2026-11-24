import { describe, expect, it } from "@effect/vitest";

import {
  deepseekRequestCompat,
  discoveryStyleForApiStyle,
  discoveryStyleForService,
  getBaseUrlIssue,
  isDeepSeekReasoningReplay,
  isOfficialDeepSeekEndpoint,
  isOpenCodeGoModelAnthropic,
  isZhipuEndpoint,
  matchNamedPreset,
  normalizeBaseUrlInput,
  normalizeEndpointUrl,
  OPENCODE_GO_BASE_URL,
  PI_NATIVE_VENDOR_PRESETS,
  resolveEndpointDraft,
  zhipuRequestCompat,
} from "./presets.ts";

describe("vendor presets", () => {
  it("covers the first-class services with distinct accents", () => {
    const ids = PI_NATIVE_VENDOR_PRESETS.map((preset) => preset.id);
    for (const id of [
      "openai",
      "anthropic",
      "google",
      "openrouter",
      "deepseek",
      "zhipuai",
      "opencode-go",
      "stepfun-plan",
      "vercel",
    ]) {
      expect(ids).toContain(id);
    }
    const accents = new Set(PI_NATIVE_VENDOR_PRESETS.map((preset) => preset.accentColor));
    expect(accents.size).toBe(PI_NATIVE_VENDOR_PRESETS.length);
    for (const preset of PI_NATIVE_VENDOR_PRESETS) {
      expect(preset.accentColor).toMatch(/^#[0-9A-F]{6}$/u);
    }
  });
});

describe("endpoint normalization", () => {
  it("canonicalizes scheme, host and path", () => {
    expect(normalizeEndpointUrl(" HTTPS://API.OpenAI.com/v1/ ")).toBe("https://api.openai.com/v1");
    expect(normalizeEndpointUrl(undefined)).toBeUndefined();
  });

  it("strips a pasted operation suffix of the same family", () => {
    expect(normalizeBaseUrlInput("https://x.test/v1/chat/completions", "openai-completions")).toBe(
      "https://x.test/v1",
    );
    expect(normalizeBaseUrlInput("https://x.test/v1/responses/", "openai-responses")).toBe(
      "https://x.test/v1",
    );
    expect(normalizeBaseUrlInput("https://x.test/v1/messages", "anthropic-messages")).toBe(
      "https://x.test",
    );
  });

  it("never strips an operation belonging to another wire family", () => {
    expect(normalizeBaseUrlInput("https://x.test/v1/responses", "openai-completions")).toBe(
      "https://x.test/v1/responses",
    );
  });

  it("reports why a base URL cannot be used", () => {
    expect(getBaseUrlIssue("")).toBeUndefined();
    expect(getBaseUrlIssue("https://api.example.com/v1")).toBeUndefined();
    expect(getBaseUrlIssue("ftp://api.example.com")).toBe("Use an http or https URL.");
    expect(getBaseUrlIssue("https://user:secret@example.com")).toBe(
      "Remove credentials from the URL.",
    );
    expect(getBaseUrlIssue("https://example.com?key=1")).toBe(
      "Remove the query string and fragment from the URL.",
    );
  });
});

describe("resolveEndpointDraft", () => {
  it("detects the wire style from a pasted operation", () => {
    const draft = resolveEndpointDraft("https://gateway.test/v1/responses", "openai-completions");
    expect(draft.apiStyle).toBe("openai-responses");
    expect(draft.baseUrl).toBe("https://gateway.test/v1");
    expect(draft.autoDetected).toBe(true);
  });

  it("detects Google from a /v1beta base", () => {
    const draft = resolveEndpointDraft(
      "https://generativelanguage.googleapis.com/v1beta",
      "openai-completions",
    );
    expect(draft.apiStyle).toBe("google-generative-ai");
    expect(draft.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("uses a known preset host and reports it", () => {
    const draft = resolveEndpointDraft("https://api.deepseek.com/v1", "openai-responses");
    expect(draft.apiStyle).toBe("openai-completions");
    expect(draft.matchedPreset?.vendorKey).toBe("deepseek");
  });

  it("respects a locked style", () => {
    const draft = resolveEndpointDraft(
      "https://gateway.test/v1/responses",
      "openai-completions",
      true,
    );
    expect(draft.apiStyle).toBe("openai-completions");
    expect(draft.autoDetected).toBe(false);
    expect(draft.baseUrl).toBe("https://gateway.test/v1/responses");
  });
});

describe("matchNamedPreset", () => {
  it("matches by URL, vendor key and alias", () => {
    expect(matchNamedPreset({ baseUrl: "https://api.anthropic.com/v1/messages" })?.vendorKey).toBe(
      "anthropic",
    );
    expect(matchNamedPreset({ vendorKey: "zai" })?.id).toBe("zai");
    expect(matchNamedPreset({ vendorKey: "minimax-openai" })?.apiStyle).toBe("openai-completions");
    expect(matchNamedPreset({ apiStyle: "opencode-go" })?.baseUrl).toBe(OPENCODE_GO_BASE_URL);
  });

  it("prefers the coding-plan record on its own path", () => {
    expect(matchNamedPreset({ baseUrl: "https://api.z.ai/api/coding/paas/v4" })?.id).toBe(
      "zai-coding-plan",
    );
  });

  it("disambiguates presets that share one vendor by wire style", () => {
    expect(matchNamedPreset({ vendorKey: "minimax-cn" })?.id).toBe("minimax-cn");
    expect(matchNamedPreset({ vendorKey: "minimax-cn", apiStyle: "openai-completions" })?.id).toBe(
      "minimax-cn-openai",
    );
  });

  it("treats custom or unknown keys as unset", () => {
    expect(matchNamedPreset({ vendorKey: "custom" })).toBeUndefined();
    expect(matchNamedPreset({ vendorKey: "unknown-vendor" })).toBeUndefined();
  });
});

describe("discovery styles", () => {
  it("derives the probe style from the wire style", () => {
    expect(discoveryStyleForApiStyle("anthropic-messages")).toBe("anthropic_models");
    expect(discoveryStyleForApiStyle("google-generative-ai")).toBe("google_models");
    expect(discoveryStyleForApiStyle("opencode-go")).toBe("openai_models");
    expect(discoveryStyleForApiStyle("openai-completions")).toBe("openai_models");
  });

  it("honours a preset's documented override", () => {
    expect(
      discoveryStyleForService({
        vendorKey: "stepfun-plan",
        apiStyle: "anthropic-messages",
      }),
    ).toBe("openai_models");
    expect(discoveryStyleForService({ apiStyle: "anthropic-messages" })).toBe("anthropic_models");
  });
});

describe("compatibility detection", () => {
  it("flags Zhipu / Z.AI endpoints", () => {
    expect(isZhipuEndpoint({ vendorKey: "zhipuai" })).toBe(true);
    expect(isZhipuEndpoint({ baseUrl: "https://api.z.ai/api/paas/v4" })).toBe(true);
    expect(isZhipuEndpoint({ baseUrl: "https://api.openai.com/v1" })).toBe(false);
    expect(zhipuRequestCompat({ vendorKey: "zai" })).toEqual({
      thinkingFormat: "zai",
      zaiToolStream: true,
    });
  });

  it("detects the DeepSeek family from every signal", () => {
    expect(isDeepSeekReasoningReplay({ vendorKey: "deepseek" })).toBe(true);
    expect(isDeepSeekReasoningReplay({ modelId: "deepseek-v4-pro" })).toBe(true);
    expect(isDeepSeekReasoningReplay({ family: "deepseek-flash" })).toBe(true);
    expect(isDeepSeekReasoningReplay({ modelId: "gpt-4o" })).toBe(false);
  });

  it("keeps the empty replay only on official hosts", () => {
    expect(isOfficialDeepSeekEndpoint({ baseUrl: "https://api.deepseek.com" })).toBe(true);
    expect(isOfficialDeepSeekEndpoint({ baseUrl: "https://relay.test/deepseek" })).toBe(false);
    expect(
      deepseekRequestCompat({ baseUrl: "https://relay.test/deepseek", modelId: "deepseek-v4" }),
    ).toEqual({
      requiresReasoningContentOnAssistantMessages: true,
      supportsReasoningEffort: false,
      requiresNonEmptyReasoningReplay: true,
    });
    expect(
      deepseekRequestCompat({ baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4" }),
    ).toEqual({ requiresReasoningContentOnAssistantMessages: true });
  });
});

describe("isOpenCodeGoModelAnthropic", () => {
  it("routes Claude and MiniMax to Anthropic Messages", () => {
    expect(isOpenCodeGoModelAnthropic("claude-sonnet-5-5")).toBe(true);
    expect(isOpenCodeGoModelAnthropic("minimax-m3")).toBe(true);
    expect(isOpenCodeGoModelAnthropic("qwen3.8-max")).toBe(false);
    expect(isOpenCodeGoModelAnthropic("gpt-5.4")).toBe(false);
  });
});
