import { describe, expect, it } from "vite-plus/test";

import {
  applyHashlineEdits,
  buildSimpleDiff,
  computeFileHash,
  computeLineTag,
  formatHashlineFile,
  parseHashlineTag,
  RECOVERABLE_HASHLINE_ERROR_CODES,
  SeenLinesTracker,
  serializeLines,
  splitFileLines,
  type HashlineEdit,
} from "./hashline.ts";

const allSeen = { isSeen: () => true };

const tagged = (lineNumber: number, line: string): string =>
  `${lineNumber}:${computeLineTag(line)}`;

const linesOf = (content: string): ReadonlyArray<string> => splitFileLines(content).lines;

const apply = (
  content: string,
  edits: ReadonlyArray<HashlineEdit>,
  seen: { isSeen(line: number): boolean } = allSeen,
) => applyHashlineEdits(content, edits, seen);

const expectFailure = (result: ReturnType<typeof apply>): { code: string; message: string } => {
  if (result.ok) throw new Error("expected the edit to fail");
  return result.error;
};

describe("line tags", () => {
  it("returns two characters of the tag alphabet and ignores a trailing carriage return", () => {
    const tag = computeLineTag("const value = 1;");
    expect(tag).toMatch(/^[0-9a-z]{2}$/u);
    expect(computeLineTag("const value = 1;\r")).toBe(tag);
    expect(computeLineTag("const value = 1; ")).not.toBe(tag);
  });

  it("parses line:tag references and rejects everything else", () => {
    const tag = computeLineTag("hello");
    expect(parseHashlineTag(`12:${tag}`)).toEqual({ line: 12, tag });
    expect(parseHashlineTag(`12:${tag}|hello`)).toEqual({ line: 12, tag });
    expect(parseHashlineTag(`0:00`)).toEqual({ line: 0, tag: "00" });
    expect(parseHashlineTag("12")).toBeNull();
    expect(parseHashlineTag("line:12:ab")).toBeNull();
    expect(parseHashlineTag("12:ABC")).toBeNull();
  });

  it("formats lines with one-indexed numbers and an optional start line", () => {
    const content = "alpha\nbeta\n";
    const [alpha, beta] = linesOf(content);
    expect(formatHashlineFile(content)).toBe(
      `1:${computeLineTag(alpha ?? "")}|alpha\n2:${computeLineTag(beta ?? "")}|beta`,
    );
    expect(formatHashlineFile(content, 10).split("\n")[0]).toMatch(/^10:[0-9a-z]{2}\|alpha$/u);
  });

  it("keeps empty files and trailing newlines distinguishable", () => {
    expect(linesOf("")).toEqual([]);
    expect(linesOf("\n")).toEqual([""]);
    expect(linesOf("a\n\n")).toEqual(["a", ""]);
    expect(serializeLines(["a", ""], "\n", true)).toBe("a\n\n");
    expect(serializeLines(["a"], "\r\n", false)).toBe("a");
  });
});

describe("applyHashlineEdits", () => {
  it("replaces one tagged line", () => {
    const content = "alpha\nbeta\ngamma\n";
    const result = apply(content, [{ op: "PUT", start: tagged(2, "beta"), content: "BETA" }]);
    expect(result).toEqual({ ok: true, content: "alpha\nBETA\ngamma\n" });
  });

  it("replaces an inclusive range and keeps CRLF endings", () => {
    const content = "alpha\r\nbeta\r\ngamma\r\n";
    const result = apply(content, [
      { op: "PUT", start: tagged(1, "alpha"), end: tagged(2, "beta"), content: "one\ntwo" },
    ]);
    expect(result).toEqual({ ok: true, content: "one\r\ntwo\r\ngamma\r\n" });
  });

  it("cuts a range", () => {
    const content = "alpha\nbeta\ngamma\n";
    const result = apply(content, [{ op: "CUT", start: tagged(2, "beta") }]);
    expect(result).toEqual({ ok: true, content: "alpha\ngamma\n" });
  });

  it("inserts at the top, in the middle, and after the last line", () => {
    const content = "alpha\nbeta\n";
    const top = apply(content, [{ op: "INS", after: "0", content: "first" }]);
    expect(top).toEqual({ ok: true, content: "first\nalpha\nbeta\n" });

    const topTagged = apply(content, [{ op: "INS", after: "0:00", content: "first" }]);
    expect(topTagged).toEqual({ ok: true, content: "first\nalpha\nbeta\n" });

    const middle = apply(content, [
      { op: "INS", after: tagged(1, "alpha"), content: "between\nlines" },
    ]);
    expect(middle).toEqual({ ok: true, content: "alpha\nbetween\nlines\nbeta\n" });

    const bottom = apply(content, [{ op: "INS", after: tagged(2, "beta"), content: "omega" }]);
    expect(bottom).toEqual({ ok: true, content: "alpha\nbeta\nomega\n" });
  });

  it("applies several edits at once from the bottom up", () => {
    const content = "one\ntwo\nthree\nfour\n";
    const result = apply(content, [
      { op: "PUT", start: tagged(2, "two"), content: "TWO" },
      { op: "CUT", start: tagged(4, "four") },
      { op: "INS", after: tagged(1, "one"), content: "one-and-a-half" },
    ]);
    expect(result).toEqual({
      ok: true,
      content: "one\none-and-a-half\nTWO\nthree\n",
    });
  });

  it("preserves a missing trailing newline", () => {
    const content = "alpha\nbeta";
    const result = apply(content, [{ op: "PUT", start: tagged(2, "beta"), content: "BETA" }]);
    expect(result).toEqual({ ok: true, content: "alpha\nBETA" });
  });

  it("reports a tag mismatch before touching the file", () => {
    const content = "alpha\nbeta\n";
    const error = expectFailure(apply(content, [{ op: "PUT", start: "2:zz", content: "BETA" }]));
    expect(error.code).toBe("EDIT_TAG_MISMATCH");
    expect(error.message).toContain("re-read the file");
  });

  it("reports unknown lines, unparsable references, and unseen lines", () => {
    const content = "alpha\n";
    expect(expectFailure(apply(content, [{ op: "CUT", start: tagged(9, "nope") }])).code).toBe(
      "EDIT_TAG_UNKNOWN",
    );
    expect(expectFailure(apply(content, [{ op: "CUT", start: "alpha" }])).code).toBe(
      "EDIT_PARSE_FAILED",
    );
    expect(
      expectFailure(
        apply(content, [{ op: "CUT", start: tagged(1, "alpha") }], { isSeen: () => false }),
      ).code,
    ).toBe("EDIT_LINES_UNSEEN");
  });

  it("rejects overlapping ranges, conflicting inserts, and reversed ranges", () => {
    const content = "one\ntwo\nthree\n";
    expect(
      expectFailure(
        apply(content, [
          { op: "PUT", start: tagged(1, "one"), end: tagged(2, "two"), content: "x" },
          { op: "CUT", start: tagged(2, "two"), end: tagged(3, "three") },
        ]),
      ).code,
    ).toBe("EDIT_RANGE_INVALID");

    expect(
      expectFailure(
        apply(content, [
          { op: "INS", after: tagged(2, "two"), content: "a" },
          { op: "INS", after: tagged(2, "two"), content: "b" },
        ]),
      ).code,
    ).toBe("EDIT_RANGE_INVALID");

    expect(
      expectFailure(
        apply(content, [{ op: "CUT", start: tagged(3, "three"), end: tagged(1, "one") }]),
      ).code,
    ).toBe("EDIT_RANGE_INVALID");
  });

  it("rejects an insert inside a replaced range", () => {
    const content = "one\ntwo\nthree\n";
    const error = expectFailure(
      apply(content, [
        { op: "PUT", start: tagged(2, "two"), end: tagged(3, "three"), content: "x" },
        { op: "INS", after: tagged(2, "two"), content: "y" },
      ]),
    );
    expect(error.code).toBe("EDIT_RANGE_INVALID");
    expect(error.message).toContain("inside replaced range");
  });

  it("reports EDIT_NO_CHANGE when the output equals the input", () => {
    const content = "alpha\nbeta\n";
    expect(apply(content, [])).toMatchObject({ ok: false, error: { code: "EDIT_NO_CHANGE" } });
    expect(
      expectFailure(apply(content, [{ op: "PUT", start: tagged(1, "alpha"), content: "alpha" }]))
        .code,
    ).toBe("EDIT_NO_CHANGE");
  });

  it("marks only the repairable codes recoverable", () => {
    expect([...RECOVERABLE_HASHLINE_ERROR_CODES].sort()).toEqual([
      "EDIT_LINES_UNSEEN",
      "EDIT_TAG_MISMATCH",
      "EDIT_TAG_UNKNOWN",
    ]);
  });
});

describe("SeenLinesTracker", () => {
  it("tracks read ranges, file hashes, writes, and cleared paths", () => {
    const tracker = new SeenLinesTracker();
    const file = "/workspace/file.ts";
    expect(tracker.hasSeenRange(file, 1, 1)).toBe(false);

    tracker.recordRead(file, 3, 6, "hash-a");
    expect(tracker.hasSeenRange(file, 3, 6)).toBe(true);
    expect(tracker.hasSeenRange(file, 2, 6)).toBe(false);
    expect(tracker.getFileHash(file)).toBe("hash-a");

    tracker.recordWrite(file, "a\nb\n");
    expect(tracker.hasSeenRange(file, 1, 2)).toBe(true);
    expect(tracker.hasSeenRange(file, 1, 3)).toBe(false);
    expect(tracker.getFileHash(file)).toBe(computeFileHash("a\nb\n"));

    tracker.clearPath(file);
    expect(tracker.hasSeenRange(file, 1, 1)).toBe(false);
    expect(tracker.getFileHash(file)).toBeUndefined();
  });
});

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
