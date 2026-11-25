import { splitFileLines } from "./fileAnchorTypes.ts";

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
  const before = splitFileLines(oldContent);
  const after = splitFileLines(newContent);
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
