import { assert, describe, it } from "@effect/vitest";

import { projectMemoryPrompt } from "./projectMemoryPrompt.ts";

describe("projectMemoryPrompt", () => {
  it("omits blank memory and trims saved content", () => {
    assert.isUndefined(projectMemoryPrompt("  \n\t"));
    assert.include(projectMemoryPrompt("  Keep the API stable.  "), "Keep the API stable.");
  });

  it("marks memory as user-provided context", () => {
    const prompt = projectMemoryPrompt("Use the staging database.");
    assert.include(prompt, "# Project memory");
    assert.include(prompt, "user-provided context");
    assert.include(prompt, "Use the staging database.");
  });
});
