const TAG_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export interface HashlineFileLines {
  readonly lines: ReadonlyArray<string>;
  readonly eol: string;
  readonly trailingNewline: boolean;
}

export const splitFileLines = (content: string): HashlineFileLines => {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  if (content === "") return { lines: [], eol, trailingNewline: true };
  const normalized = eol === "\r\n" ? content.replaceAll("\r\n", "\n") : content;
  const parts = normalized.split("\n");
  const trailingNewline = parts.at(-1) === "";
  return {
    lines: trailingNewline ? parts.slice(0, -1) : parts,
    eol,
    trailingNewline,
  };
};

export const serializeLines = (
  lines: ReadonlyArray<string>,
  eol: string,
  trailingNewline: boolean,
): string => {
  if (lines.length === 0) return "";
  const body = lines.join(eol);
  return trailingNewline ? `${body}${eol}` : body;
};

const hash32 = (input: string, seed: number): number => {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

/** Two characters that change with the line, so a stale tag points at drift. */
export const computeLineTag = (line: string): string => {
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  const first = TAG_ALPHABET.charAt(hash32(normalized, 0) % TAG_ALPHABET.length);
  const second = TAG_ALPHABET.charAt(hash32(normalized, 0x9e3779b9) % TAG_ALPHABET.length);
  return `${first}${second}`;
};

const TAG_REF_PATTERN = /^(\d+):([0-9a-z]{2})(?:\|[\s\S]*)?$/u;

export const parseHashlineTag = (ref: string): { line: number; tag: string } | null => {
  const match = TAG_REF_PATTERN.exec(ref.trim());
  if (match === null) return null;
  const line = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isSafeInteger(line) || line < 0) return null;
  return { line, tag: match[2] ?? "" };
};

export const formatHashlineFile = (content: string, startLine = 1): string =>
  splitFileLines(content)
    .lines.map((line, index) => `${startLine + index}:${computeLineTag(line)}|${line}`)
    .join("\n");

export interface HashlinePutEdit {
  readonly op: "PUT";
  readonly start: string;
  readonly end?: string;
  readonly content: string;
}

export interface HashlineCutEdit {
  readonly op: "CUT";
  readonly start: string;
  readonly end?: string;
}

export interface HashlineInsertEdit {
  readonly op: "INS";
  readonly after: string;
  readonly content: string;
}

export type HashlineEdit = HashlinePutEdit | HashlineCutEdit | HashlineInsertEdit;

export type HashlineErrorCode =
  | "EDIT_TAG_MISMATCH"
  | "EDIT_TAG_UNKNOWN"
  | "EDIT_LINES_UNSEEN"
  | "EDIT_PARSE_FAILED"
  | "EDIT_RANGE_INVALID"
  | "EDIT_NO_CHANGE";

export interface HashlineApplyError {
  readonly code: HashlineErrorCode;
  readonly message: string;
  readonly line?: number;
}

export type HashlineApplyResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly error: HashlineApplyError };

/** The codes an agent can repair by re-reading the file and retrying. */
export const RECOVERABLE_HASHLINE_ERROR_CODES: ReadonlySet<HashlineErrorCode> = new Set([
  "EDIT_TAG_MISMATCH",
  "EDIT_TAG_UNKNOWN",
  "EDIT_LINES_UNSEEN",
]);

export const isRecoverableHashlineErrorCode = (code: string | undefined): boolean =>
  code !== undefined && RECOVERABLE_HASHLINE_ERROR_CODES.has(code as HashlineErrorCode);

export interface SeenLines {
  isSeen(line: number): boolean;
}

export const computeFileHash = (content: string): string => {
  const head = hash32(content, 0x85ebca6b).toString(16).padStart(8, "0");
  const tail = hash32(content, 0xc2b2ae35).toString(16).padStart(8, "0");
  return `${head}${tail}`;
};

interface SeenEntry {
  readonly ranges: Array<{ startLine: number; endLine: number }>;
  fileHash: string | undefined;
}

export class SeenLinesTracker {
  readonly #entries = new Map<string, SeenEntry>();

  #entry(realPath: string): SeenEntry {
    const existing = this.#entries.get(realPath);
    if (existing !== undefined) return existing;
    const created: SeenEntry = { ranges: [], fileHash: undefined };
    this.#entries.set(realPath, created);
    return created;
  }

  recordRead(realPath: string, startLine: number, endLine: number, fileHash?: string): void {
    const entry = this.#entry(realPath);
    if (fileHash !== undefined) entry.fileHash = fileHash;
    if (endLine < startLine) return;
    entry.ranges.push({ startLine, endLine });
  }

  recordWrite(realPath: string, content: string): void {
    const entry = this.#entry(realPath);
    const lineCount = splitFileLines(content).lines.length;
    entry.ranges.length = 0;
    entry.ranges.push({ startLine: 1, endLine: Math.max(lineCount, 1) });
    entry.fileHash = computeFileHash(content);
  }

  hasSeenRange(realPath: string, startLine: number, endLine: number): boolean {
    const entry = this.#entries.get(realPath);
    if (entry === undefined || endLine < startLine) return false;
    return entry.ranges.some((range) => range.startLine <= startLine && range.endLine >= endLine);
  }

  clearPath(realPath: string): void {
    this.#entries.delete(realPath);
  }

  getFileHash(realPath: string): string | undefined {
    return this.#entries.get(realPath)?.fileHash;
  }
}

type ResolvedEdit =
  | {
      readonly kind: "replace";
      readonly start: number;
      readonly end: number;
      readonly content: string;
    }
  | { readonly kind: "insert"; readonly after: number; readonly content: string };

const failure = (code: HashlineErrorCode, message: string, line?: number): HashlineApplyResult => ({
  ok: false,
  error: { code, message, ...(line === undefined ? {} : { line }) },
});

const editContentLines = (content: string): ReadonlyArray<string> => splitFileLines(content).lines;

export const applyHashlineEdits = (
  content: string,
  edits: ReadonlyArray<HashlineEdit>,
  seen: SeenLines,
): HashlineApplyResult => {
  if (edits.length === 0) return failure("EDIT_NO_CHANGE", "No edits were provided.");
  const table = splitFileLines(content);
  const lineCount = table.lines.length;

  const anchor = (ref: string, context: string): number | HashlineApplyResult => {
    const parsed = parseHashlineTag(ref);
    if (parsed === null) {
      return failure(
        "EDIT_PARSE_FAILED",
        `${context} "${ref}" is not a line:tag reference like "12:ab".`,
      );
    }
    if (parsed.line < 1 || parsed.line > lineCount) {
      return failure(
        "EDIT_TAG_UNKNOWN",
        `${context} line ${parsed.line} does not exist; the file has ${lineCount} lines.`,
        parsed.line,
      );
    }
    const expected = computeLineTag(table.lines[parsed.line - 1] ?? "");
    if (expected !== parsed.tag) {
      return failure(
        "EDIT_TAG_MISMATCH",
        `${context} line ${parsed.line} reads tag ${expected}, not ${parsed.tag}; re-read the file and use the tag it shows.`,
        parsed.line,
      );
    }
    if (!seen.isSeen(parsed.line)) {
      return failure(
        "EDIT_LINES_UNSEEN",
        `${context} line ${parsed.line} was not read in this session; read the range before editing it.`,
        parsed.line,
      );
    }
    return parsed.line;
  };

  const resolved: Array<ResolvedEdit> = [];
  for (const edit of edits) {
    if (edit.op === "INS") {
      const trimmed = edit.after.trim();
      if (trimmed === "0") {
        resolved.push({ kind: "insert", after: 0, content: edit.content });
        continue;
      }
      const parsed = parseHashlineTag(trimmed);
      if (parsed === null) {
        return failure(
          "EDIT_PARSE_FAILED",
          `Insert anchor "${edit.after}" is not a line:tag reference like "12:ab" or "0".`,
        );
      }
      if (parsed.line === 0) {
        resolved.push({ kind: "insert", after: 0, content: edit.content });
        continue;
      }
      const line = anchor(edit.after, "Insert anchor");
      if (typeof line !== "number") return line;
      resolved.push({ kind: "insert", after: line, content: edit.content });
      continue;
    }

    const start = anchor(edit.start, edit.op === "PUT" ? "Start of PUT" : "Start of CUT");
    if (typeof start !== "number") return start;
    const end =
      edit.end === undefined
        ? start
        : anchor(edit.end, edit.op === "PUT" ? "End of PUT" : "End of CUT");
    if (typeof end !== "number") return end;
    if (end < start) {
      return failure("EDIT_RANGE_INVALID", `Range ${start}-${end} ends before it starts.`, start);
    }
    for (let line = start; line <= end; line++) {
      if (!seen.isSeen(line)) {
        return failure(
          "EDIT_LINES_UNSEEN",
          `Line ${line} was not read in this session; read the range ${start}-${end} first.`,
          line,
        );
      }
    }
    resolved.push({
      kind: "replace",
      start,
      end,
      content: edit.op === "PUT" ? edit.content : "",
    });
  }

  const replaces = resolved
    .filter((edit): edit is Extract<ResolvedEdit, { kind: "replace" }> => edit.kind === "replace")
    .sort((left, right) => left.start - right.start);
  for (let index = 1; index < replaces.length; index++) {
    const previous = replaces[index - 1];
    const current = replaces[index];
    if (previous === undefined || current === undefined) continue;
    if (current.start <= previous.end) {
      return failure(
        "EDIT_RANGE_INVALID",
        `Ranges ${previous.start}-${previous.end} and ${current.start}-${current.end} overlap.`,
        current.start,
      );
    }
  }

  const insertAnchors = new Set<number>();
  for (const edit of resolved) {
    if (edit.kind !== "insert") continue;
    if (insertAnchors.has(edit.after)) {
      return failure(
        "EDIT_RANGE_INVALID",
        `Two inserts target line ${edit.after}; combine them into one insert.`,
        edit.after,
      );
    }
    insertAnchors.add(edit.after);
    for (const range of replaces) {
      if (edit.after >= range.start && edit.after <= range.end) {
        return failure(
          "EDIT_RANGE_INVALID",
          `Insert after line ${edit.after} lands inside replaced range ${range.start}-${range.end}.`,
          edit.after,
        );
      }
    }
  }

  const lines = [...table.lines];
  const ordered = [...resolved].sort(
    (left, right) =>
      (right.kind === "replace" ? right.start : right.after) -
      (left.kind === "replace" ? left.start : left.after),
  );
  for (const edit of ordered) {
    if (edit.kind === "replace") {
      lines.splice(edit.start - 1, edit.end - edit.start + 1, ...editContentLines(edit.content));
    } else {
      lines.splice(edit.after, 0, ...editContentLines(edit.content));
    }
  }

  const next = serializeLines(lines, table.eol, table.trailingNewline);
  if (next === content) return failure("EDIT_NO_CHANGE", "The edits leave the file unchanged.");
  return { ok: true, content: next };
};

interface DiffOp {
  readonly kind: "equal" | "add" | "remove";
  readonly text: string;
}

const DIFF_CELL_BUDGET = 1_000_000;

const computeOps = (before: ReadonlyArray<string>, after: ReadonlyArray<string>): DiffOp[] => {
  if (before.length * after.length > DIFF_CELL_BUDGET) {
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
      prefix++;
    }
    let suffix = 0;
    while (
      suffix < before.length - prefix &&
      suffix < after.length - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) {
      suffix++;
    }
    const ops: DiffOp[] = [];
    for (const text of before.slice(0, prefix)) ops.push({ kind: "equal", text });
    for (const text of before.slice(prefix, before.length - suffix)) {
      ops.push({ kind: "remove", text });
    }
    for (const text of after.slice(prefix, after.length - suffix)) ops.push({ kind: "add", text });
    for (const text of before.slice(before.length - suffix)) ops.push({ kind: "equal", text });
    return ops;
  }

  const rows = before.length + 1;
  const columns = after.length + 1;
  const table = new Int32Array(rows * columns);
  for (let left = before.length - 1; left >= 0; left--) {
    for (let right = after.length - 1; right >= 0; right--) {
      table[left * columns + right] =
        before[left] === after[right]
          ? (table[(left + 1) * columns + right + 1] ?? 0) + 1
          : Math.max(
              table[(left + 1) * columns + right] ?? 0,
              table[left * columns + right + 1] ?? 0,
            );
    }
  }

  const ops: DiffOp[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    const current = before[left];
    if (current === after[right]) {
      ops.push({ kind: "equal", text: current ?? "" });
      left++;
      right++;
    } else if (
      (table[(left + 1) * columns + right] ?? 0) >= (table[left * columns + right + 1] ?? 0)
    ) {
      ops.push({ kind: "remove", text: current ?? "" });
      left++;
    } else {
      ops.push({ kind: "add", text: after[right] ?? "" });
      right++;
    }
  }
  while (left < before.length) {
    ops.push({ kind: "remove", text: before[left] ?? "" });
    left++;
  }
  while (right < after.length) {
    ops.push({ kind: "add", text: after[right] ?? "" });
    right++;
  }
  return ops;
};

interface DiffRow {
  readonly op: DiffOp;
  readonly oldLine: number;
  readonly newLine: number;
}

const CONTEXT_LINES = 3;

export interface SimpleDiff {
  readonly diffStr: string;
  readonly additions: number;
  readonly deletions: number;
}

export const buildSimpleDiff = (
  filePath: string,
  oldContent: string,
  newContent: string,
): SimpleDiff => {
  const before = splitFileLines(oldContent).lines;
  const after = splitFileLines(newContent).lines;
  const ops = computeOps(before, after);
  const additions = ops.filter((op) => op.kind === "add").length;
  const deletions = ops.filter((op) => op.kind === "remove").length;
  if (additions === 0 && deletions === 0) return { diffStr: "", additions, deletions };

  const rows: Array<DiffRow> = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    rows.push({ op, oldLine, newLine });
    if (op.kind !== "add") oldLine++;
    if (op.kind !== "remove") newLine++;
  }

  const changed: Array<number> = [];
  rows.forEach((row, index) => {
    if (row.op.kind !== "equal") changed.push(index);
  });

  const hunks: Array<{ from: number; to: number }> = [];
  for (const index of changed) {
    const from = Math.max(index - CONTEXT_LINES, 0);
    const to = Math.min(index + CONTEXT_LINES, rows.length - 1);
    const last = hunks.at(-1);
    if (last !== undefined && from <= last.to + 1) {
      last.to = Math.max(last.to, to);
    } else {
      hunks.push({ from, to });
    }
  }

  const output: Array<string> = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (const hunk of hunks) {
    const slice = rows.slice(hunk.from, hunk.to + 1);
    if (slice.length === 0) continue;
    const oldCount = slice.filter((row) => row.op.kind !== "add").length;
    const newCount = slice.filter((row) => row.op.kind !== "remove").length;
    const first = slice[0];
    if (first === undefined) continue;
    const oldStart = oldCount === 0 ? first.oldLine - 1 : first.oldLine;
    const newStart = newCount === 0 ? first.newLine - 1 : first.newLine;
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const row of slice) {
      const marker = row.op.kind === "add" ? "+" : row.op.kind === "remove" ? "-" : " ";
      output.push(`${marker}${row.op.text}`);
    }
  }

  return { diffStr: output.join("\n"), additions, deletions };
};
