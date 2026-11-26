import { describe, expect, it } from "vite-plus/test";

import {
  IMAGE_TOKEN_ESTIMATE,
  estimateCjkAwareTextTokens,
  estimateToolSchemaTokens,
  safeJson,
} from "./contextTokens.ts";

describe("estimateCjkAwareTextTokens", () => {
  it("charges latin text four characters per token", () => {
    expect(estimateCjkAwareTextTokens("")).toBe(0);
    expect(estimateCjkAwareTextTokens("abcd")).toBe(1);
    expect(estimateCjkAwareTextTokens("abcde")).toBe(2);
  });

  it("charges CJK characters denser than latin text", () => {
    expect(estimateCjkAwareTextTokens("你好")).toBe(3);
    expect(estimateCjkAwareTextTokens("你好ab")).toBe(4);
  });

  it("counts an emoji as one character outside the CJK ranges", () => {
    expect(estimateCjkAwareTextTokens("😀")).toBe(1);
  });
});

describe("estimateToolSchemaTokens", () => {
  it("sums the name, description, and JSON parameters", () => {
    expect(
      estimateToolSchemaTokens({
        name: "Read",
        description: "abcd",
        parameters: { type: "object" },
      }),
    ).toBe(
      estimateCjkAwareTextTokens("Read") + 1 + estimateCjkAwareTextTokens('{"type":"object"}'),
    );
  });

  it("omits a missing description and parameters", () => {
    expect(estimateToolSchemaTokens({ name: "abcd" })).toBe(1);
  });

  it("keeps an unserializable value at zero instead of throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(safeJson(cyclic)).toBe("");
    expect(estimateToolSchemaTokens({ name: "a", parameters: cyclic })).toBe(1);
  });
});

describe("IMAGE_TOKEN_ESTIMATE", () => {
  it("stays the flat per-image budget providers bill", () => {
    expect(IMAGE_TOKEN_ESTIMATE).toBe(1_600);
  });
});
