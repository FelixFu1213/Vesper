import { describe, expect, it } from "vite-plus/test";

import {
  buildPlanImplementationPrompt,
  buildPlanImplementationThreadTitle,
  PLAN_IMPLEMENTATION_PROMPT_PREFIX,
} from "./proposedPlan";

describe("buildPlanImplementationPrompt", () => {
  it("prefixes the plan and trims surrounding whitespace", () => {
    expect(buildPlanImplementationPrompt("\n## Add login\n\n- step one\n")).toBe(
      `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}## Add login\n\n- step one`,
    );
  });

  it("keeps the plan's internal layout", () => {
    const plan = "# Plan\n\n1. First\n2. Second";
    expect(buildPlanImplementationPrompt(plan)).toBe(`${PLAN_IMPLEMENTATION_PROMPT_PREFIX}${plan}`);
  });
});

describe("buildPlanImplementationThreadTitle", () => {
  it("names the thread after the plan's heading", () => {
    expect(buildPlanImplementationThreadTitle("# Add token refresh\n\nSteps")).toBe(
      "Implement Add token refresh",
    );
  });

  it("falls back when the plan has no heading", () => {
    expect(buildPlanImplementationThreadTitle("Just some steps")).toBe("Implement plan");
    expect(buildPlanImplementationThreadTitle("   ")).toBe("Implement plan");
  });
});
