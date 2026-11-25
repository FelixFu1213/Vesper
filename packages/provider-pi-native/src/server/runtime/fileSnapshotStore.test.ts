import { describe, expect, it } from "vite-plus/test";

import {
  computeFileTag,
  decodeNormalizedFile,
  encodeNormalizedFile,
  formatSectionHeader,
  joinFileLines,
  normalizeLineEndings,
  parseSectionHeader,
  splitFileLines,
  stripWriteMarkup,
} from "./fileAnchorTypes.ts";
import {
  FileSnapshotStore,
  MAX_PATHS_PER_SESSION,
  MAX_RETAINED_FILE_BYTES,
  MAX_VERSIONS_PER_PATH,
} from "./fileSnapshotStore.ts";

const file = "/ws/src/a.ts";
const seen = (lines: ReadonlyArray<number>): ReadonlySet<number> => new Set(lines);

describe("file anchors", () => {
  it("tags four uppercase hex digits from the whole normalized file", () => {
    const tag = computeFileTag("hello\n");
    expect(tag).toMatch(/^[0-9A-F]{4}$/u);
    expect(computeFileTag("hello\n")).toBe(tag);
    expect(computeFileTag("hello")).not.toBe(tag);
  });

  it("ignores trailing line whitespace, CRLF, and a BOM in the tag", () => {
    const tag = computeFileTag("a  \nb\t\n");
    expect(computeFileTag(normalizeLineEndings("a  \r\nb\t\r\n"))).toBe(tag);
    const decoded = decodeNormalizedFile(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi\n")]),
    );
    expect(decoded.bom).toBe(true);
    expect(computeFileTag(decoded.text)).toBe(computeFileTag("hi\n"));
  });

  it("decodes and re-encodes UTF-16 with its byte order and BOM", () => {
    const littleEndian = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi\n", "utf16le")]);
    const decoded = decodeNormalizedFile(littleEndian);
    expect(decoded).toMatchObject({ text: "hi\n", utf16: "le" });
    expect(encodeNormalizedFile(decoded)).toEqual(littleEndian);

    const bigEndian = Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      Buffer.from("hi\n", "utf16le").swap16(),
    ]);
    const bigDecoded = decodeNormalizedFile(bigEndian);
    expect(bigDecoded).toMatchObject({ text: "hi\n", utf16: "be" });
    expect(encodeNormalizedFile(bigDecoded)).toEqual(bigEndian);
  });

  it("restores the dominant line ending on write", () => {
    const crlf = decodeNormalizedFile(Buffer.from("a\r\nb\r\n"));
    expect(crlf).toMatchObject({ text: "a\nb\n", ending: "\r\n" });
    expect(encodeNormalizedFile({ ...crlf, text: "a\nc\n" })).toEqual(Buffer.from("a\r\nc\r\n"));
    expect(encodeNormalizedFile({ ...crlf, text: "a\nc" })).toEqual(Buffer.from("a\r\nc"));
  });

  it("splits and joins lines without losing the terminal newline", () => {
    expect(splitFileLines("")).toEqual([]);
    expect(splitFileLines("\n")).toEqual([""]);
    expect(splitFileLines("a\nb")).toEqual(["a", "b"]);
    expect(joinFileLines(["a", "b"], true)).toBe("a\nb\n");
    expect(joinFileLines(["a", "b"], false)).toBe("a\nb");
    expect(joinFileLines([], true)).toBe("\n");
  });

  it("round-trips a section header and strips pasted Read markup", () => {
    expect(formatSectionHeader("src/a.ts", "A1B2")).toBe("[src/a.ts#A1B2]");
    expect(parseSectionHeader("[src/a.ts#A1B2]")).toEqual({ path: "src/a.ts", tag: "A1B2" });
    expect(parseSectionHeader("[src/a.ts#a1b2]\r")).toEqual({ path: "src/a.ts", tag: "A1B2" });
    expect(parseSectionHeader("src/a.ts#A1B2")).toBeUndefined();
    expect(stripWriteMarkup("[src/a.ts#A1B2]\n1:alpha\n2:beta\n")).toBe("alpha\nbeta\n");
    expect(stripWriteMarkup("plain\ntext\n")).toBe("plain\ntext\n");
  });
});

describe("FileSnapshotStore", () => {
  it("records a snapshot and reuses the tag for identical text", () => {
    const store = new FileSnapshotStore();
    const text = "a\nb\nc\n";
    expect(store.record(file, text, seen([1]))).toBe(computeFileTag(text));
    store.record(file, text, seen([2]));
    const snapshot = store.latestMatchingText(file, text);
    expect([...(snapshot?.seenLines ?? [])]).toEqual([1, 2]);
    expect(store.latestTag(file)).toBe(computeFileTag(text));
  });

  it("keeps distinct texts as separate versions", () => {
    const store = new FileSnapshotStore();
    store.record(file, "alpha\n", seen([1]));
    store.record(file, "beta\n", seen([1]));
    expect(store.lookupTag(file, computeFileTag("alpha\n"))).toBeDefined();
    expect(store.latestTag(file)).toBe(computeFileTag("beta\n"));
  });

  it("drops the oldest version past the per-path bound", () => {
    const store = new FileSnapshotStore();
    for (let index = 0; index <= MAX_VERSIONS_PER_PATH; index++) {
      store.record(file, `line-${index}\n`, seen([1]));
    }
    expect(store.lookupTag(file, computeFileTag("line-0\n"))).toBeUndefined();
    expect(store.latestTag(file)).toBe(computeFileTag(`line-${MAX_VERSIONS_PER_PATH}\n`));
  });

  it("evicts the coldest path past the per-session bound", () => {
    const store = new FileSnapshotStore();
    for (let index = 0; index <= MAX_PATHS_PER_SESSION; index++) {
      store.record(`/ws/file-${index}.ts`, `path ${index}\n`, seen([1]));
    }
    expect(store.latestTag("/ws/file-0.ts")).toBeUndefined();
    expect(store.latestTag(`/ws/file-${MAX_PATHS_PER_SESSION}.ts`)).toBeDefined();
  });

  it("evicts paths to stay under the retained-byte ceiling", () => {
    const store = new FileSnapshotStore();
    const chunk = "x".repeat(MAX_RETAINED_FILE_BYTES - 1);
    for (let index = 0; index < 5; index++) {
      store.record(`/ws/big-${index}.txt`, `${chunk}\n`, seen([1]));
    }
    expect(store.latestTag("/ws/big-0.txt")).toBeUndefined();
    expect(store.latestTag("/ws/big-4.txt")).toBeDefined();
  });

  it("tags a file above the single-file bound without retaining its text", () => {
    const store = new FileSnapshotStore();
    const text = `${"z".repeat(MAX_RETAINED_FILE_BYTES + 1)}\n`;
    const tag = store.record(file, text, seen([1]));
    expect(store.lookupTag(file, tag)?.retained).toBe(false);
    expect(store.latestMatchingText(file, text)).toBeUndefined();
  });

  it("invalidates a path and its retained bytes", () => {
    const store = new FileSnapshotStore();
    const text = "a\n";
    store.record(file, text, seen([1]));
    store.invalidatePath(file);
    expect(store.lookupTag(file, computeFileTag(text))).toBeUndefined();
  });

  it("merges revealed lines into the matching snapshot only", () => {
    const store = new FileSnapshotStore();
    store.record(file, "a\nb\n", seen([1]));
    store.mergeSeenLines(file, "a\nb\n", [2]);
    expect([...(store.latestMatchingText(file, "a\nb\n")?.seenLines ?? [])]).toEqual([1, 2]);
    store.mergeSeenLines(file, "other\n", [9]);
    expect([...(store.latestMatchingText(file, "a\nb\n")?.seenLines ?? [])]).toEqual([1, 2]);
  });

  it("recovers a unique basename-and-tag path and declines a tie", () => {
    const store = new FileSnapshotStore();
    const source = "/ws/src/main.ts";
    const other = "/ws/lib/main.ts";
    const tag = computeFileTag("a\n");
    store.record(source, "a\n", seen([1]));
    expect(store.findUniqueBasenameTag("main.ts", tag, "/ws/main.ts")).toBe(source);

    store.record(other, "a\n", seen([1]));
    expect(store.findUniqueBasenameTag("main.ts", tag, "/ws/main.ts")).toBeUndefined();
    expect(store.findUniqueBasenameTag("main.ts", tag, source)).toBe(other);
  });
});
