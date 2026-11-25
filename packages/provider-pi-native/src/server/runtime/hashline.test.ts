import { describe, expect, it } from "vite-plus/test";

import { buildSimpleDiff } from "./hashline.ts";

describe("buildSimpleDiff", () => {
  it("counts additions and deletions and emits unified hunks", () => {
    const diff = buildSimpleDiff("src/file.ts", "one\ntwo\nthree\n", "one\nTWO\nthree\nfour\n");
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(1);
    expect(diff.diffStr).toContain("--- a/src/file.ts");
    expect(diff.diffStr).toContain("+++ b/src/file.ts");
    expect(diff.diffStr).toContain("@@ -1,3 +1,4 @@");
    expect(diff.diffStr).toContain("-two");
    expect(diff.diffStr).toContain("+TWO");
    expect(diff.diffStr).toContain("+four");
  });

  it("reports nothing for identical content", () => {
    const diff = buildSimpleDiff("file.ts", "same\n", "same\n");
    expect(diff).toEqual({ diffStr: "", additions: 0, deletions: 0 });
  });

  it("describes a new file as additions only", () => {
    const diff = buildSimpleDiff("new.ts", "", "a\nb\n");
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(0);
    expect(diff.diffStr).toContain("@@ -0,0 +1,2 @@");
  });

  it("keeps distant changes in separate hunks", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
    const after = [...before];
    after[0] = "changed-1";
    after[19] = "changed-20";
    const diff = buildSimpleDiff("file.txt", `${before.join("\n")}\n`, `${after.join("\n")}\n`);
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(2);
    expect(diff.diffStr.match(/@@ /gu)?.length).toBe(2);
  });
});
