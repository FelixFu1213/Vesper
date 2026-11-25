// @effect-diagnostics nodeBuiltinImport:off -- The whole-file tag is one SHA-256 digest over normalized text.
import * as NodeCrypto from "node:crypto";

const UTF8_BOM: ReadonlyArray<number> = [0xef, 0xbb, 0xbf];
const UTF16_LE_BOM: ReadonlyArray<number> = [0xff, 0xfe];
const UTF16_BE_BOM: ReadonlyArray<number> = [0xfe, 0xff];

export const FILE_TAG_PATTERN = /^[0-9A-Fa-f]{4}$/u;

export type LineEnding = "\n" | "\r\n";
export type Utf16Order = "le" | "be";

export interface NormalizedFile {
  /** LF-normalized text with any BOM removed; trailing line whitespace kept. */
  readonly text: string;
  readonly ending: LineEnding;
  readonly bom: boolean;
  readonly utf16: Utf16Order | undefined;
}

const startsWith = (bytes: Uint8Array, prefix: ReadonlyArray<number>): boolean =>
  bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);

export const normalizeLineEndings = (text: string): string =>
  text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

export const detectLineEnding = (text: string): LineEnding => {
  let crlf = 0;
  let lf = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charAt(index) !== "\n") continue;
    if (text.charAt(index - 1) === "\r") crlf++;
    else lf++;
  }
  return crlf > lf ? "\r\n" : "\n";
};

const decodeUtf16 = (bytes: Uint8Array, order: Utf16Order): string => {
  const even = (bytes.length - 2) & ~1;
  const body = Buffer.from(bytes.subarray(2, 2 + Math.max(even, 0)));
  return (order === "le" ? body : body.swap16()).toString("utf16le");
};

export const decodeNormalizedFile = (bytes: Uint8Array): NormalizedFile => {
  const utf16 = startsWith(bytes, UTF16_LE_BOM)
    ? "le"
    : startsWith(bytes, UTF16_BE_BOM)
      ? "be"
      : undefined;
  if (utf16 !== undefined) {
    const text = decodeUtf16(bytes, utf16);
    return { text: normalizeLineEndings(text), ending: detectLineEnding(text), bom: false, utf16 };
  }
  const bom = startsWith(bytes, UTF8_BOM);
  const decoded = Buffer.from(bom ? bytes.subarray(3) : bytes).toString("utf8");
  return { text: normalizeLineEndings(decoded), ending: detectLineEnding(decoded), bom, utf16 };
};

export const encodeNormalizedFile = (file: NormalizedFile): Buffer => {
  const body = file.ending === "\r\n" ? file.text.replaceAll("\n", "\r\n") : file.text;
  if (file.utf16 !== undefined) {
    const head = Buffer.from(file.utf16 === "le" ? UTF16_LE_BOM : UTF16_BE_BOM);
    const units = Buffer.from(body, "utf16le");
    return Buffer.concat([head, file.utf16 === "le" ? units : units.swap16()]);
  }
  const encoded = Buffer.from(body, "utf8");
  return file.bom ? Buffer.concat([Buffer.from(UTF8_BOM), encoded]) : encoded;
};

export const splitFileLines = (text: string): ReadonlyArray<string> => {
  if (text === "") return [];
  const parts = text.split("\n");
  if (text.endsWith("\n")) parts.pop();
  return parts;
};

export const joinFileLines = (lines: ReadonlyArray<string>, trailingNewline: boolean): string => {
  if (lines.length === 0) return trailingNewline ? "\n" : "";
  const body = lines.join("\n");
  return trailingNewline ? `${body}\n` : body;
};

const rtrimHashLine = (line: string): string => line.replace(/[ \t\r]+$/u, "");

/** Hash input drops trailing line whitespace so CRLF and a trimming display agree. */
const hashInput = (text: string): string => text.split("\n").map(rtrimHashLine).join("\n");

export const computeFileTag = (text: string): string => {
  const digest = NodeCrypto.createHash("sha256").update(hashInput(text), "utf8").digest();
  const low = ((digest[30] ?? 0) << 8) | (digest[31] ?? 0);
  return low.toString(16).toUpperCase().padStart(4, "0");
};

export const formatSectionHeader = (path: string, tag: string): string => `[${path}#${tag}]`;

export const parseSectionHeader = (
  line: string,
): { readonly path: string; readonly tag: string } | undefined => {
  const match = /^\[(.*)#([0-9A-Fa-f]{4})\]$/u.exec(line.trimEnd());
  if (match === null) return undefined;
  return { path: match[1] ?? "", tag: (match[2] ?? "").toUpperCase() };
};

const stripLinePrefix = (line: string): string => {
  const colon = line.indexOf(":");
  if (colon <= 0) return line;
  const number = line.slice(0, colon);
  return /^\d+$/u.test(number) ? line.slice(colon + 1) : line;
};

/** Strip a pasted Read window (`[path#TAG]` plus `N:` prefixes) from Write content. */
export const stripWriteMarkup = (content: string): string => {
  const trailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (trailingNewline) lines.pop();
  if (lines.length === 0) return content;
  if (parseSectionHeader(lines[0] ?? "") === undefined) return content;
  const body = lines.slice(1).map(stripLinePrefix);
  return joinFileLines(body, trailingNewline);
};

export interface FileSnapshot {
  readonly text: string;
  readonly tag: string;
  /** `null` means provenance was never recorded, so anchors are not gated. */
  readonly seenLines: ReadonlySet<number> | null;
  /** False when the file exceeded the single-file retention bound. */
  readonly retained: boolean;
}

/** Per-session, in-memory record of tagged snapshots and the lines they displayed. */
export interface FileAnchorStore {
  record(filePath: string, text: string, seenLines: ReadonlySet<number> | null): string;
  latestMatchingText(filePath: string, text: string): FileSnapshot | undefined;
  lookupTag(filePath: string, tag: string): FileSnapshot | undefined;
  latestTag(filePath: string): string | undefined;
  mergeSeenLines(filePath: string, text: string, lines: Iterable<number>): void;
  invalidatePath(filePath: string): void;
  findUniqueBasenameTag(basename: string, tag: string, excludePath: string): string | undefined;
}

export const pathBasename = (target: string): string => {
  const parts = target.split(/[\\/]/u);
  return parts.at(-1) ?? target;
};
