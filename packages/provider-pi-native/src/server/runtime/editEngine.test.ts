import { describe, expect, it } from "vite-plus/test";

import {
  applyEdit,
  applyLegacyTextEdit,
  legacyHashlineEditsToOps,
  NamedRegisters,
  parseOps,
  type EditFailure,
  type EditResult,
  type EditSessionState,
} from "./editEngine.ts";
import { computeFileTag } from "./fileAnchorTypes.ts";
import { FileSnapshotStore } from "./fileSnapshotStore.ts";

const file = "src/f.ts";
const canonical = "/ws/src/f.ts";

const staleTag = (text: string): string => (computeFileTag(text) === "0000" ? "0001" : "0000");

const makeSession = (): EditSessionState => ({
  store: new FileSnapshotStore(),
  registers: new NamedRegisters(),
});

const recordLines = (
  session: EditSessionState,
  text: string,
  lines: ReadonlyArray<number>,
): void => {
  session.store.record(canonical, text, new Set(lines));
};

interface ApplyOptions {
  readonly tag?: string;
  readonly session?: EditSessionState;
  readonly path?: string;
}

const applyOps = (text: string, ops: string, options: ApplyOptions = {}): EditResult =>
  applyEdit({
    path: options.path ?? file,
    canonicalPath: canonical,
    tag: options.tag ?? computeFileTag(text),
    ops,
    text,
    ...(options.session === undefined ? {} : { session: options.session }),
  });

const expectFailure = (result: EditResult): EditFailure => {
  if (result.ok) throw new Error("expected the edit to fail");
  return result;
};

const expectText = (result: EditResult): string => {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.text;
};

describe("parseOps", () => {
  it("parses range bodies, gap inserts, and an optional header", () => {
    const parsed = parseOps("[src/f.ts#AB12]\nPUT 2.=3:\n+new two\n+new three\nPUT >$:\n+tail\n");
    if (!("ops" in parsed)) throw new Error(parsed.message);
    expect(parsed.headerPath).toBe("src/f.ts");
    expect(parsed.headerTag).toBe("AB12");
    expect(parsed.ops).toHaveLength(2);
    expect(parsed.ops[0]).toMatchObject({
      op: "PUT",
      locator: { kind: "range", start: 2, end: 3 },
      body: ["new two", "new three"],
    });
    expect(parsed.ops[1]).toMatchObject({ op: "PUT", locator: { kind: "end" }, body: ["tail"] });
  });

  it("parses gaps, blocks, CUT, REM, MV, and register pastes", () => {
    const parsed = parseOps(
      "PUT <1:\n+a\nPUT >2:\n+b\nPUT 4*:\n+c\nPUT >5*:\n+d\nCUT 6.=7 @saved\nREM\n",
    );
    if (!("ops" in parsed)) throw new Error(parsed.message);
    expect(parsed.ops.map((op) => op.op)).toEqual(["PUT", "PUT", "PUT", "PUT", "CUT", "REM"]);
    expect(parseOps("MV moved.ts")).toMatchObject({ ops: [{ op: "MV", dest: "moved.ts" }] });
    expect(parseOps('MV "my file.ts"')).toMatchObject({
      ops: [{ op: "MV", dest: "my file.ts" }],
    });
    expect(parseOps("PUT <1 @saved")).toMatchObject({
      ops: [{ op: "PUT", locator: { kind: "before", line: 1 }, register: "saved", body: null }],
    });
  });

  it("names the concrete replacement form for every malformed shape", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["CUT 1.=1\n-old\n", "body or context row without a header"],
      ["PUT 1.=1:\n", "at least one + body row"],
      ["PUT 1.=1\n+x\n", "missing a trailing `:`"],
      ["@@ -1,2 +1,2 @@\n", "unified-diff hunk header"],
      ["### Heading\n", "unknown operation"],
      ["CUT 2.=2:\n", "CUT takes no body rows"],
      ["+orphan\n", "PUT N.=M:"],
      ["PUT 2:\n+x\n", "invalid locator"],
      ["PUT <1 @a:\n+x\n", "register paste takes no body rows"],
      ["", "ops is empty"],
    ];
    for (const [ops, expected] of cases) {
      const parsed = parseOps(ops);
      if ("ops" in parsed) throw new Error(`expected ${ops} to fail`);
      expect(parsed.code).toBe("EDIT_PARSE_FAILED");
      expect(parsed.message).toContain(expected);
    }
  });

  it("bounds the op count", () => {
    const ops = Array.from({ length: 201 }, () => "CUT 1.=1").join("\n");
    const parsed = parseOps(ops);
    if ("ops" in parsed) throw new Error("expected the op count to fail");
    expect(parsed.code).toBe("INVALID_ARGUMENT");
  });

  it("rejects a reversed range at parse time", () => {
    const parsed = parseOps("CUT 3.=1");
    if ("ops" in parsed) throw new Error("expected the range to fail");
    expect(parsed.code).toBe("EDIT_RANGE_INVALID");
  });
});

describe("applyEdit", () => {
  it("replaces a range and appends", () => {
    const result = applyOps("one\ntwo\nthree\n", "PUT 2.=2:\n+TWO\nPUT >$:\n+four");
    expect(expectText(result)).toBe("one\nTWO\nthree\nfour\n");
    expect(result.ok && result.tag).toBe(computeFileTag("one\nTWO\nthree\nfour\n"));
  });

  it("inserts before and after anchors", () => {
    expect(expectText(applyOps("b\nc\n", "PUT <1:\n+a\nPUT >2:\n+d"))).toBe("a\nb\nc\nd\n");
    expect(expectText(applyOps("b\nc\n", "PUT >$:\n+d"))).toBe("b\nc\nd\n");
  });

  it("deletes a range with CUT", () => {
    expect(expectText(applyOps("a\nb\nc\nd\n", "CUT 2.=3"))).toBe("a\nd\n");
  });

  it("resolves block locators and reports their spans", () => {
    const text = "if (x) {\n  a();\n}\nb();\n";
    const result = applyOps(text, "PUT >1*:\n+c();");
    expect(expectText(result)).toBe("if (x) {\n  a();\n}\nc();\nb();\n");
    expect(result.ok && result.blocks).toEqual([
      { anchorLine: 1, start: 1, end: 3, op: "PUT >1*:" },
    ]);
  });

  it("declines an unresolved block locator", () => {
    const failure = expectFailure(applyOps("const a = 1;\n", "PUT 1*:\n+x"));
    expect(failure.code).toBe("EDIT_BLOCK_UNRESOLVED");
    expect(failure.message).toContain("use PUT 1.=1:");
  });

  it("reports EDIT_NO_CHANGE for an identical apply", () => {
    expect(expectFailure(applyOps("same\n", "PUT 1.=1:\n+same")).code).toBe("EDIT_NO_CHANGE");
  });

  it("rejects overlapping ranges and duplicate insert gaps", () => {
    expect(expectFailure(applyOps("a\nb\nc\n", "PUT 1.=2:\n+x\nCUT 2.=3")).code).toBe(
      "EDIT_RANGE_INVALID",
    );
    expect(expectFailure(applyOps("a\nb\n", "PUT >1:\n+x\nPUT >1:\n+y")).code).toBe(
      "EDIT_RANGE_INVALID",
    );
  });

  it("requires a tag and a matching ops header", () => {
    expect(expectFailure(applyOps("a\n", "CUT 1.=1", { tag: "" })).code).toBe("EDIT_TAG_REQUIRED");
    expect(expectFailure(applyOps("a\n", "CUT 1.=1", { tag: "zzzz" })).code).toBe(
      "EDIT_TAG_REQUIRED",
    );
    const failure = expectFailure(applyOps("a\n", "[other.ts#ABCD]\nCUT 1.=1", { tag: "ABCD" }));
    expect(failure.code).toBe("INVALID_ARGUMENT");
  });

  it("applies a stale tag at the head or tail with a warning", () => {
    const text = "a\nb\n";
    const result = applyOps(text, "PUT >$:\n+c", { tag: staleTag(text) });
    expect(expectText(result)).toBe("a\nb\nc\n");
    expect(result.ok && result.warnings[0]).toContain("applied at the file head/tail");
  });

  it("rejects a tag this session never recorded", () => {
    const text = "a\nb\n";
    const failure = expectFailure(
      applyOps(text, "PUT 1.=1:\n+A", { tag: staleTag(text), session: makeSession() }),
    );
    expect(failure.code).toBe("EDIT_TAG_UNKNOWN");
    expect(failure.extras?.liveTag).toBe(computeFileTag(text));
  });

  it("recovers when every anchor moved by one consistent offset", () => {
    const session = makeSession();
    const original = "a\nb\nc\n";
    recordLines(session, original, [1, 2, 3]);
    const result = applyOps("zero\na\nb\nc\n", "PUT 2.=2:\n+B", {
      tag: computeFileTag(original),
      session,
    });
    expect(expectText(result)).toBe("zero\na\nB\nc\n");
    expect(result.ok && result.warnings.join("\n")).toContain("anchors moved by +1 line(s)");
  });

  it("rejects recovery when anchors moved by different offsets", () => {
    const session = makeSession();
    const original = "a\nb\nc\n";
    recordLines(session, original, [1, 2, 3]);
    const failure = expectFailure(
      applyOps("zero\na\nmid\nb\nc\n", "PUT 1.=2:\n+X\n+Y", {
        tag: computeFileTag(original),
        session,
      }),
    );
    expect(failure.code).toBe("EDIT_TAG_MISMATCH");
    expect(failure.extras?.anchors).toEqual([1, 2]);
  });

  it("reveals unseen anchors once and merges them when the reveal is complete", () => {
    const session = makeSession();
    const text = "a\nb\nc\nd\n";
    recordLines(session, text, [1, 2]);
    const first = expectFailure(applyOps(text, "PUT 4.=4:\n+D", { session }));
    expect(first.code).toBe("EDIT_LINES_UNSEEN");
    expect(first.extras).toMatchObject({ merged: true, unseenCount: 1 });
    expect(first.extras?.unseenLines).toEqual([{ line: 4, text: "d", clipped: false }]);

    const retried = applyOps(text, "PUT 4.=4:\n+D", { session });
    expect(expectText(retried)).toBe("a\nb\nc\nD\n");
  });

  it("does not merge a reveal truncated by the width cap", () => {
    const session = makeSession();
    const text = `${"z".repeat(600)}\nsecond\n`;
    recordLines(session, text, [2]);
    const failure = expectFailure(applyOps(text, "PUT 1.=1:\n+Z", { session }));
    expect(failure.code).toBe("EDIT_LINES_UNSEEN");
    expect(failure.extras).toMatchObject({ merged: false, revealTruncated: true });
    expect(failure.extras?.unseenLines?.[0]?.clipped).toBe(true);
  });

  it("captures a named register and pastes it in a later call", () => {
    const session = makeSession();
    const cut = applyOps("alpha\nbeta\n", "CUT 1.=1 @saved", { session });
    expect(expectText(cut)).toBe("beta\n");
    recordLines(session, "beta\n", [1]);
    const paste = applyOps("beta\n", "PUT <1 @saved", { session });
    expect(expectText(paste)).toBe("alpha\nbeta\n");
  });

  it("rejects an empty register and an ambiguous anonymous paste", () => {
    const session = makeSession();
    expect(expectFailure(applyOps("a\n", "PUT <1 @missing", { session })).code).toBe(
      "EDIT_REGISTER_EMPTY",
    );
    const ambiguous = expectFailure(
      applyOps("a\nb\nc\n", "CUT 1.=1\nCUT 3.=3\nPUT >2", { session }),
    );
    expect(ambiguous.code).toBe("EDIT_REGISTER_AMBIGUOUS");
  });

  it("moves and removes files", () => {
    const moved = applyOps("a\nb\n", "MV moved.ts");
    expect(moved.ok && moved.movedTo).toBe("moved.ts");
    expect(expectText(moved)).toBe("a\nb\n");

    const removed = applyOps("a\nb\n", "REM");
    expect(removed.ok && removed.deleteFile).toBe(true);

    expect(expectFailure(applyOps("a\n", "REM\nMV b.ts")).code).toBe("EDIT_RANGE_INVALID");
  });

  it("repairs a restated boundary row and warns", () => {
    const narrowed = applyOps("a\nb\nc\n", "PUT 2.=3:\n+B\n+c");
    expect(expectText(narrowed)).toBe("a\nB\nc\n");
    expect(narrowed.ok && narrowed.warnings[0]).toContain("narrowed the range");

    const echoed = applyOps("a\nb\nc\n", "PUT 2.=2:\n+a\n+X");
    expect(expectText(echoed)).toBe("a\nX\nc\n");
    expect(echoed.ok && echoed.warnings[0]).toContain("row above the range");
  });

  it("rejects tied boundary-repair candidates", () => {
    const failure = expectFailure(applyOps("dup\ndup\ndup\n", "PUT 2.=3:\n+dup\n+X"));
    expect(failure.code).toBe("EDIT_REPAIR_AMBIGUOUS");
  });

  it("bounds expanded IR lines", () => {
    const ops = `PUT 1.=1:\n${Array.from({ length: 100_001 }, () => "+").join("\n")}`;
    expect(expectFailure(applyOps("a\n", ops)).code).toBe("EDIT_AMPLIFICATION_LIMIT");
  });
});

describe("legacy compatibility", () => {
  it("lowers old_string replacements to the line-anchored engine", () => {
    const result = applyLegacyTextEdit({
      path: file,
      canonicalPath: canonical,
      text: "one\ntwo\nthree\n",
      oldText: "two",
      newText: "TWO",
    });
    expect(expectText(result)).toBe("one\nTWO\nthree\n");
  });

  it("keeps text before and after a partial-line match", () => {
    const result = applyLegacyTextEdit({
      path: file,
      canonicalPath: canonical,
      text: "const value = 1;\n",
      oldText: "value = 1",
      newText: "value = 2",
    });
    expect(expectText(result)).toBe("const value = 2;\n");
  });

  it("rejects a missing, multiple, identical, or terminal-newline-only match", () => {
    const base = {
      path: file,
      canonicalPath: canonical,
      text: "same\nsame\n",
    };
    const unique = {
      path: file,
      canonicalPath: canonical,
      text: "same\ntwo\n",
    };
    expect(
      expectFailure(applyLegacyTextEdit({ ...base, oldText: "absent", newText: "x" })).code,
    ).toBe("EDIT_LEGACY_MATCH_FAILED");
    expect(
      expectFailure(applyLegacyTextEdit({ ...base, oldText: "same", newText: "x" })).message,
    ).toContain("appears 2 times");
    expect(
      expectFailure(applyLegacyTextEdit({ ...unique, oldText: "two", newText: "two" })).code,
    ).toBe("EDIT_NO_CHANGE");
    expect(
      expectFailure(
        applyLegacyTextEdit({
          path: file,
          canonicalPath: canonical,
          text: "same\nsame",
          oldText: "same\nsame",
          newText: "same\nsame\n",
        }),
      ).code,
    ).toBe("EDIT_NO_CHANGE");
  });

  it("still runs the provenance gate on a legacy replacement", () => {
    const session = makeSession();
    const text = "one\ntwo\nthree\n";
    recordLines(session, text, [1, 3]);
    const failure = expectFailure(
      applyLegacyTextEdit({
        path: file,
        canonicalPath: canonical,
        text,
        oldText: "two",
        newText: "TWO",
        session,
      }),
    );
    expect(failure.code).toBe("EDIT_LINES_UNSEEN");
  });

  it("lowers legacy edits[] to ops", () => {
    expect(legacyHashlineEditsToOps([{ op: "PUT", start: "2:ab", content: "B" }])).toEqual({
      ops: "PUT 2.=2:\n+B",
    });
    expect(legacyHashlineEditsToOps([{ op: "CUT", start: "2:ab", end: "3:cd" }])).toEqual({
      ops: "CUT 2.=3",
    });
    expect(legacyHashlineEditsToOps([{ op: "INS", after: "0", content: "a\nb" }])).toEqual({
      ops: "PUT <1:\n+a\n+b",
    });
    const invalid = legacyHashlineEditsToOps([{ op: "CUT", start: "nope" }]);
    expect("ok" in invalid && invalid.code).toBe("EDIT_PARSE_FAILED");
  });
});
