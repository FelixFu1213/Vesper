import { createStructuralBlockResolver, type BlockResolver } from "./blockResolver.ts";
import {
  computeFileTag,
  FILE_TAG_PATTERN,
  joinFileLines,
  parseSectionHeader,
  pathBasename,
  splitFileLines,
  type FileAnchorStore,
  type FileSnapshot,
} from "./fileAnchorTypes.ts";

const MAX_OPS_BYTES = 256 * 1024;
const MAX_OPS_PER_CALL = 200;
const MAX_IR_LINES = 100_000;
const MAX_REGISTER_LINES = 4096;
const MAX_REGISTER_BYTES = 1024 * 1024;
const MAX_NAMED_REGISTERS = 16;

const UNSEEN_REVEAL_LINES = 40;
const UNSEEN_REVEAL_CHARS = 512;
const DIFF_CELL_BUDGET = 1_000_000;
const HEAD_ANCHOR = 0;
const EOF_ANCHOR = -1;

export type EditErrorCode =
  | "INVALID_ARGUMENT"
  | "EDIT_TAG_REQUIRED"
  | "EDIT_LEGACY_MATCH_FAILED"
  | "EDIT_TAG_MISMATCH"
  | "EDIT_TAG_UNKNOWN"
  | "EDIT_LINES_UNSEEN"
  | "EDIT_PARSE_FAILED"
  | "EDIT_RANGE_INVALID"
  | "EDIT_BLOCK_UNRESOLVED"
  | "EDIT_REGISTER_EMPTY"
  | "EDIT_REGISTER_AMBIGUOUS"
  | "EDIT_REPAIR_AMBIGUOUS"
  | "EDIT_NO_CHANGE"
  | "EDIT_AMPLIFICATION_LIMIT";

/** Codes an honest retry answers: the live tag, or the lines the host refused to write blind. */
const RECOVERABLE_EDIT_ERROR_CODES: ReadonlySet<string> = new Set([
  "EDIT_TAG_MISMATCH",
  "EDIT_TAG_UNKNOWN",
  "EDIT_LINES_UNSEEN",
]);

export const isRecoverableEditErrorCode = (code: string | undefined): boolean =>
  code !== undefined && RECOVERABLE_EDIT_ERROR_CODES.has(code);

export interface UnseenLineReveal {
  readonly line: number;
  readonly text: string;
  readonly clipped: boolean;
}

export interface EditFailureExtras {
  readonly liveTag?: string;
  readonly expectedTag?: string;
  readonly anchors?: ReadonlyArray<number>;
  readonly unseenLines?: ReadonlyArray<UnseenLineReveal>;
  readonly unseenCount?: number;
  readonly revealTruncated?: boolean;
  readonly merged?: boolean;
}

export interface EditFailure {
  readonly ok: false;
  readonly code: EditErrorCode;
  readonly message: string;
  readonly extras?: EditFailureExtras;
}

export interface ResolvedBlockEcho {
  readonly anchorLine: number;
  readonly start: number;
  readonly end: number;
  readonly op: string;
}

export interface EditSuccess {
  readonly ok: true;
  /** LF-normalized text after the edit. */
  readonly text: string;
  readonly tag: string;
  readonly warnings: ReadonlyArray<string>;
  readonly ops: ReadonlyArray<string>;
  readonly blocks: ReadonlyArray<ResolvedBlockEcho>;
  readonly deleteFile: boolean;
  readonly movedTo?: string;
}

export type EditResult = EditSuccess | EditFailure;

/** Session-scoped named registers (§7.5), LRU bounded at 16. */
export class NamedRegisters {
  readonly #entries = new Map<string, ReadonlyArray<string>>();
  readonly #lru: Array<string> = [];

  put(name: string, lines: ReadonlyArray<string>): void {
    const at = this.#lru.indexOf(name);
    if (at !== -1) this.#lru.splice(at, 1);
    this.#lru.push(name);
    this.#entries.set(name, lines);
    while (this.#entries.size > MAX_NAMED_REGISTERS) {
      const cold = this.#lru.shift();
      if (cold === undefined) return;
      this.#entries.delete(cold);
    }
  }

  get(name: string): ReadonlyArray<string> | undefined {
    return this.#entries.get(name);
  }

  clear(): void {
    this.#entries.clear();
    this.#lru.length = 0;
  }
}

export interface EditSessionState {
  readonly store: FileAnchorStore;
  readonly registers: NamedRegisters;
}

type Locator =
  | { readonly kind: "range"; readonly start: number; readonly end: number }
  | { readonly kind: "block"; readonly line: number }
  | { readonly kind: "before"; readonly line: number }
  | { readonly kind: "after"; readonly line: number }
  | { readonly kind: "end" }
  | { readonly kind: "afterBlock"; readonly line: number };

interface PutOp {
  readonly op: "PUT";
  readonly locator: Locator;
  /** `null` for a colonless header, which must paste a register. */
  readonly body: ReadonlyArray<string> | null;
  readonly register: string | null;
}

interface CutOp {
  readonly op: "CUT";
  readonly locator: Locator;
  readonly register: string | null;
}

interface RemOp {
  readonly op: "REM";
}

interface MvOp {
  readonly op: "MV";
  readonly dest: string;
}

type ParsedOp = PutOp | CutOp | RemOp | MvOp;

export interface ParsedOps {
  readonly headerPath?: string;
  readonly headerTag?: string;
  readonly ops: ReadonlyArray<ParsedOp>;
}

const failure = (
  code: EditErrorCode,
  message: string,
  extras?: EditFailureExtras,
): EditFailure => ({ ok: false, code, message, ...(extras === undefined ? {} : { extras }) });

const EDIT_OP_GUIDANCE =
  "use `PUT N.=M:` with `+TEXT` rows to replace, `CUT N.=M` to delete, or `PUT <N:` / `PUT >N:` to insert";

const parseLine = (raw: string): number | EditFailure => {
  if (raw === "" || !/^\d+$/u.test(raw) || raw.startsWith("0")) {
    return failure("EDIT_PARSE_FAILED", `line number must be a positive integer, got ${raw}`);
  }
  const line = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(line)) {
    return failure("EDIT_PARSE_FAILED", `line number out of range: ${raw}`);
  }
  return line;
};

const parseLocator = (raw: string): Locator | EditFailure => {
  if (raw === ">$") return { kind: "end" };
  if (raw.startsWith("<")) {
    const line = parseLine(raw.slice(1));
    return typeof line === "number" ? { kind: "before", line } : line;
  }
  if (raw.startsWith(">")) {
    const rest = raw.slice(1);
    if (rest.endsWith("*")) {
      const line = parseLine(rest.slice(0, -1));
      return typeof line === "number" ? { kind: "afterBlock", line } : line;
    }
    const line = parseLine(rest);
    return typeof line === "number" ? { kind: "after", line } : line;
  }
  if (raw.endsWith("*")) {
    const line = parseLine(raw.slice(0, -1));
    return typeof line === "number" ? { kind: "block", line } : line;
  }
  const parts = raw.split(".=");
  if (parts.length === 2) {
    const start = parseLine(parts[0] ?? "");
    if (typeof start !== "number") return start;
    const end = parseLine(parts[1] ?? "");
    if (typeof end !== "number") return end;
    if (start > end) {
      return failure("EDIT_RANGE_INVALID", `reversed range ${start}.=${end}`);
    }
    return { kind: "range", start, end };
  }
  return failure(
    "EDIT_PARSE_FAILED",
    `invalid locator ${raw}; expected N.=M, N*, <N, >N, >$, or >N*; ${EDIT_OP_GUIDANCE}`,
  );
};

const parseRegister = (raw: string): string | EditFailure => {
  const match = /^@([A-Za-z0-9_-]{1,32})$/u.exec(raw);
  if (match === null) {
    return failure("EDIT_PARSE_FAILED", `register must be @name with 1-32 letters, got ${raw}`);
  }
  return match[1] ?? "";
};

const parseHeader = (
  raw: string,
): { readonly op: ParsedOp; readonly colon: boolean } | EditFailure => {
  const line = raw.trimEnd();
  const colon = line.endsWith(":");
  const core = (colon ? line.slice(0, -1) : line).trimEnd();
  const tokens = core.split(/\s+/u).filter((token) => token !== "");
  const kind = tokens[0];
  if (kind === "PUT" || kind === "CUT") {
    const locatorRaw = tokens[1];
    if (locatorRaw === undefined) {
      return failure("EDIT_PARSE_FAILED", `${kind} requires a locator`);
    }
    const locator = parseLocator(locatorRaw);
    if (!("kind" in locator)) return locator;
    const registerRaw = tokens[2];
    const register = registerRaw === undefined ? null : parseRegister(registerRaw);
    if (register !== null && typeof register !== "string") return register;
    if (tokens[3] !== undefined) {
      return failure("EDIT_PARSE_FAILED", `unexpected token in ${kind} header: ${raw}`);
    }
    if (kind === "CUT") return { op: { op: "CUT", locator, register }, colon };
    return {
      op: { op: "PUT", locator, body: colon ? [] : null, register },
      colon,
    };
  }
  if (kind === "REM") {
    if (tokens.length > 1) return failure("EDIT_PARSE_FAILED", "REM takes no arguments");
    return { op: { op: "REM" }, colon };
  }
  if (kind === "MV") {
    const rest = core.slice(2).trim();
    if (rest === "") return failure("EDIT_PARSE_FAILED", "MV requires a dest path");
    const quoted =
      (rest.startsWith('"') && rest.endsWith('"')) || (rest.startsWith("'") && rest.endsWith("'"));
    const dest = quoted ? rest.slice(1, -1) : rest;
    if (dest === "") return failure("EDIT_PARSE_FAILED", "MV dest is empty");
    return { op: { op: "MV", dest }, colon };
  }
  if (kind === "@@") {
    return failure(
      "EDIT_PARSE_FAILED",
      `unified-diff hunk header is not valid Edit ops; ${EDIT_OP_GUIDANCE}`,
    );
  }
  return failure(
    "EDIT_PARSE_FAILED",
    `unknown operation ${kind ?? ""}; expected PUT, CUT, REM, or MV; ${EDIT_OP_GUIDANCE}`,
  );
};

/** Parse the spec 18 §7 patch language. */
export const parseOps = (source: string): ParsedOps | EditFailure => {
  if (Buffer.byteLength(source, "utf8") > MAX_OPS_BYTES) {
    return failure("INVALID_ARGUMENT", `ops payload exceeds ${MAX_OPS_BYTES} bytes`);
  }
  const lines = source.split("\n");
  if (source.endsWith("\n")) lines.pop();
  let index = 0;
  let headerPath: string | undefined;
  let headerTag: string | undefined;
  const header = parseSectionHeader(lines[0] ?? "");
  if (header !== undefined && lines.length > 0) {
    headerPath = header.path;
    headerTag = header.tag;
    index = 1;
  }

  const ops: Array<ParsedOp> = [];
  while (index < lines.length) {
    const raw = lines[index] ?? "";
    if (raw.trim() === "") {
      index++;
      continue;
    }
    if (raw.startsWith("+") || raw.startsWith("-")) {
      return failure(
        "EDIT_PARSE_FAILED",
        `body or context row without a header at op line ${index + 1}: ${raw}; put \`+TEXT\` rows after \`PUT N.=M:\`; a lone \`+\` writes a blank line`,
      );
    }
    const parsed = parseHeader(raw);
    if (!("op" in parsed)) return parsed;
    index++;
    if (parsed.op.op === "PUT" && parsed.colon) {
      if (parsed.op.register !== null) {
        return failure(
          "EDIT_PARSE_FAILED",
          "a register paste takes no body rows; drop the trailing colon",
        );
      }
      const body: Array<string> = [];
      while (index < lines.length) {
        const row = lines[index] ?? "";
        if (!row.startsWith("+")) break;
        body.push(row.slice(1));
        index++;
      }
      if (body.length === 0) {
        return failure(
          "EDIT_PARSE_FAILED",
          "PUT with a colon requires at least one + body row; use CUT to delete",
        );
      }
      ops.push({ ...parsed.op, body });
      continue;
    }
    if (parsed.op.op === "PUT" && parsed.op.register === null) {
      const next = lines.slice(index).find((row) => row.trim() !== "");
      if (next?.startsWith("+") === true) {
        return failure(
          "EDIT_PARSE_FAILED",
          `PUT header \`${raw}\` is missing a trailing \`:\` before + body rows; use \`${raw}:\``,
        );
      }
    } else if (parsed.colon) {
      return failure("EDIT_PARSE_FAILED", `${parsed.op.op} takes no body rows`);
    }
    ops.push(parsed.op);
  }

  if (ops.length === 0) {
    return failure("EDIT_PARSE_FAILED", "ops is empty; supply at least one PUT, CUT, REM, or MV");
  }
  if (ops.length > MAX_OPS_PER_CALL) {
    return failure("INVALID_ARGUMENT", `ops exceeds ${MAX_OPS_PER_CALL} operations`);
  }
  return {
    ops,
    ...(headerPath === undefined ? {} : { headerPath }),
    ...(headerTag === undefined ? {} : { headerTag }),
  };
};

interface ResolvedOp {
  readonly op: "PUT" | "CUT" | "REM" | "MV";
  readonly locator: Locator;
  readonly body: ReadonlyArray<string> | null;
  readonly register: string | null;
  readonly dest: string | null;
}

interface Plan {
  readonly inserts: Map<number, ReadonlyArray<string>>;
  readonly deletes: Set<number>;
  readonly anchors: Set<number>;
  rem: boolean;
  mv: string | undefined;
  readonly warnings: Array<string>;
}

const locatorEcho = (locator: Locator): string => {
  switch (locator.kind) {
    case "range":
      return `${locator.start}.=${locator.end}:`;
    case "block":
      return `${locator.line}*:`;
    case "before":
      return `<${locator.line}:`;
    case "after":
      return `>${locator.line}:`;
    case "end":
      return ">$:";
    case "afterBlock":
      return `>${locator.line}*:`;
  }
};

const echoParsedOp = (op: ParsedOp): string => {
  if (op.op === "REM") return "REM";
  if (op.op === "MV") return `MV ${op.dest}`;
  return `${op.op} ${locatorEcho(op.locator)}`;
};

const positionStable = (ops: ReadonlyArray<ParsedOp>): boolean =>
  ops.every((op) => {
    if (op.op === "PUT") {
      return (op.locator.kind === "before" && op.locator.line === 1) || op.locator.kind === "end";
    }
    return op.op === "REM" || op.op === "MV";
  });

const resolveBlocks = (
  ops: ReadonlyArray<ParsedOp>,
  baselineText: string,
  path: string,
  resolver: BlockResolver,
):
  | { readonly ops: ReadonlyArray<ResolvedOp>; readonly blocks: ReadonlyArray<ResolvedBlockEcho> }
  | EditFailure => {
  const resolved: Array<ResolvedOp> = [];
  const blocks: Array<ResolvedBlockEcho> = [];
  for (const op of ops) {
    if (op.op === "REM") {
      resolved.push({
        op: "REM",
        locator: { kind: "end" },
        body: null,
        register: null,
        dest: null,
      });
      continue;
    }
    if (op.op === "MV") {
      resolved.push({
        op: "MV",
        locator: { kind: "end" },
        body: null,
        register: null,
        dest: op.dest,
      });
      continue;
    }
    if (op.locator.kind !== "block" && op.locator.kind !== "afterBlock") {
      resolved.push({
        op: op.op,
        locator: op.locator,
        body: op.op === "PUT" ? op.body : null,
        register: op.register,
        dest: null,
      });
      continue;
    }
    const anchorLine = op.locator.line;
    const block = resolver.resolve(baselineText, path, anchorLine);
    if (block === null) {
      return failure(
        "EDIT_BLOCK_UNRESOLVED",
        `block locator on line ${anchorLine} could not be resolved for ${path}; use PUT ${anchorLine}.=${anchorLine}: or a concrete range instead`,
      );
    }
    blocks.push({
      anchorLine,
      start: block.start,
      end: block.end,
      op: `${op.op} ${locatorEcho(op.locator)}`,
    });
    const locator: Locator =
      op.locator.kind === "block"
        ? { kind: "range", start: block.start, end: block.end }
        : { kind: "after", line: block.end };
    resolved.push({
      op: op.op,
      locator,
      body: op.op === "PUT" ? op.body : null,
      register: op.register,
      dest: null,
    });
  }
  return { ops: resolved, blocks };
};

const captureLimitFailure = (lines: number): EditFailure | undefined => {
  if (lines > MAX_REGISTER_LINES) {
    return failure("INVALID_ARGUMENT", `CUT capture exceeds ${MAX_REGISTER_LINES} lines`);
  }
  return undefined;
};

const expandRegisters = (
  ops: ReadonlyArray<ResolvedOp>,
  baselineLines: ReadonlyArray<string>,
  session: EditSessionState | undefined,
): ReadonlyArray<ResolvedOp> | EditFailure => {
  const expanded: Array<ResolvedOp> = [];
  const anonymous: Array<ReadonlyArray<string>> = [];
  for (const op of ops) {
    if (op.op === "CUT") {
      let captured: ReadonlyArray<string> = [];
      if (op.locator.kind === "range") {
        const { start, end } = op.locator;
        if (start >= 1 && end <= baselineLines.length) {
          captured = baselineLines.slice(start - 1, end);
        }
      }
      const tooMany = captureLimitFailure(captured.length);
      if (tooMany !== undefined) return tooMany;
      const bytes = captured.reduce((total, line) => total + line.length + 1, 0);
      if (bytes > MAX_REGISTER_BYTES) {
        return failure("INVALID_ARGUMENT", `CUT capture exceeds ${MAX_REGISTER_BYTES} bytes`);
      }
      if (op.register !== null) {
        if (session === undefined) {
          return failure(
            "EDIT_REGISTER_EMPTY",
            `named register @${op.register} needs a session snapshot store`,
          );
        }
        session.registers.put(op.register, captured);
      } else {
        anonymous.push(captured);
      }
      expanded.push(op);
      continue;
    }
    if (op.op === "PUT" && op.body === null) {
      let pasted: ReadonlyArray<string> | undefined;
      if (op.register !== null) {
        pasted = session?.registers.get(op.register);
        if (pasted === undefined) {
          return failure(
            "EDIT_REGISTER_EMPTY",
            `register @${op.register} is empty; CUT into it first`,
          );
        }
      } else if (anonymous.length === 0) {
        return failure(
          "EDIT_REGISTER_EMPTY",
          "no anonymous capture to paste; run `CUT N.=M` first or name a register with `@name`",
        );
      } else if (anonymous.length > 1) {
        return failure(
          "EDIT_REGISTER_AMBIGUOUS",
          `${anonymous.length} anonymous captures are pending; name the capture you mean with \`CUT N.=M @name\` and paste that name`,
        );
      } else {
        pasted = anonymous[0] ?? [];
      }
      expanded.push({ ...op, body: pasted });
      continue;
    }
    expanded.push(op);
  }
  return expanded;
};

interface RepairedRange {
  readonly start: number;
  readonly end: number;
  readonly body: ReadonlyArray<string>;
  readonly note: string;
}

/** §8.4 boundary repair: restated outside rows and swallowed unchanged rows. */
const repairRange = (
  start: number,
  end: number,
  body: ReadonlyArray<string>,
  lines: ReadonlyArray<string>,
): { readonly repaired: RepairedRange } | EditFailure | undefined => {
  if (body.length < 2) return undefined;
  const first = body[0];
  const last = body.at(-1);
  const before = start >= 2 ? lines[start - 2] : undefined;
  const after = end < lines.length ? lines[end] : undefined;
  const candidates: Array<RepairedRange> = [];
  if (before !== undefined && first === before) {
    candidates.push({
      start,
      end,
      body: body.slice(1),
      note: `removed +${first} restating the row above the range`,
    });
  }
  if (after !== undefined && last === after) {
    candidates.push({
      start,
      end,
      body: body.slice(0, -1),
      note: `removed +${last} restating the row below the range`,
    });
  }
  if (end > start && first === lines[start - 1]) {
    candidates.push({
      start: start + 1,
      end,
      body: body.slice(1),
      note: `narrowed the range past its restated first row ${start}`,
    });
  }
  if (end > start && last === lines[end - 1]) {
    candidates.push({
      start,
      end: end - 1,
      body: body.slice(0, -1),
      note: `narrowed the range past its restated last row ${end}`,
    });
  }
  const unique = new Map<string, RepairedRange>();
  for (const candidate of candidates) {
    const result = [
      ...lines.slice(0, candidate.start - 1),
      ...candidate.body,
      ...lines.slice(candidate.end),
    ].join("\n");
    unique.set(result, candidate);
  }
  const chosen = [...unique.values()];
  if (chosen.length === 0) return undefined;
  if (chosen.length > 1) {
    return failure(
      "EDIT_REPAIR_AMBIGUOUS",
      `boundary repair for the range ${start}.=${end} has ${chosen.length} tied candidates; send the exact range and body rows you mean`,
    );
  }
  return { repaired: chosen[0] as RepairedRange };
};

const lower = (
  ops: ReadonlyArray<ResolvedOp>,
  lineCount: number,
  baselineLines: ReadonlyArray<string>,
): Plan | EditFailure => {
  const plan: Plan = {
    inserts: new Map(),
    deletes: new Set(),
    anchors: new Set(),
    rem: false,
    mv: undefined,
    warnings: [],
  };
  const occupiedDeletes = new Set<number>();
  const occupiedInserts = new Set<number>();
  let irLines = 0;

  const bumpIr = (add: number): EditFailure | undefined => {
    irLines += add;
    return irLines > MAX_IR_LINES
      ? failure("EDIT_AMPLIFICATION_LIMIT", `lowering exceeded ${MAX_IR_LINES} IR lines`)
      : undefined;
  };

  const validateLine = (line: number): EditFailure | undefined => {
    if (lineCount === 0) {
      return line === 1
        ? undefined
        : failure("EDIT_RANGE_INVALID", `line ${line} is out of bounds in an empty file`);
    }
    if (line < 1 || line > lineCount) {
      return failure(
        "EDIT_RANGE_INVALID",
        `line ${line} is out of bounds (file has ${lineCount} lines)`,
      );
    }
    return undefined;
  };

  const claimRange = (start: number, end: number): EditFailure | undefined => {
    const startError = validateLine(start);
    if (startError !== undefined) return startError;
    const endError = validateLine(end);
    if (endError !== undefined) return endError;
    for (let line = start; line <= end; line++) {
      if (occupiedDeletes.has(line)) {
        return failure("EDIT_RANGE_INVALID", `overlapping or duplicate anchor on line ${line}`);
      }
      occupiedDeletes.add(line);
      plan.deletes.add(line);
      plan.anchors.add(line);
    }
    return undefined;
  };

  const claimInsert = (at: number): EditFailure | undefined => {
    if (occupiedInserts.has(at)) {
      return failure("EDIT_RANGE_INVALID", `two ops target the same insert gap (index ${at})`);
    }
    occupiedInserts.add(at);
    return undefined;
  };

  for (const op of ops) {
    if (op.op === "REM") {
      if (plan.rem) return failure("EDIT_RANGE_INVALID", "duplicate REM in one call");
      plan.rem = true;
      continue;
    }
    if (op.op === "MV") {
      if (plan.mv !== undefined) return failure("EDIT_RANGE_INVALID", "duplicate MV in one call");
      plan.mv = op.dest ?? undefined;
      continue;
    }
    if (op.op === "PUT") {
      const body = op.body ?? [];
      const bodyError = bumpIr(body.length);
      if (bodyError !== undefined) return bodyError;
      const locator = op.locator;
      if (locator.kind === "range") {
        const repaired = repairRange(locator.start, locator.end, body, baselineLines);
        if (repaired !== undefined && "ok" in repaired) return repaired;
        const start = repaired?.repaired.start ?? locator.start;
        const end = repaired?.repaired.end ?? locator.end;
        const repairedBody = repaired?.repaired.body ?? body;
        if (repaired !== undefined) plan.warnings.push(repaired.repaired.note);
        const rangeError = claimRange(start, end);
        if (rangeError !== undefined) return rangeError;
        const insertError = claimInsert(start - 1);
        if (insertError !== undefined) return insertError;
        plan.inserts.set(start - 1, repairedBody);
        continue;
      }
      if (locator.kind === "before") {
        const lineError = validateLine(locator.line);
        if (lineError !== undefined) return lineError;
        plan.anchors.add(locator.line === 1 ? HEAD_ANCHOR : locator.line);
        const insertError = claimInsert(locator.line - 1);
        if (insertError !== undefined) return insertError;
        plan.inserts.set(locator.line - 1, body);
        continue;
      }
      if (locator.kind === "after") {
        const lineError = validateLine(locator.line);
        if (lineError !== undefined) return lineError;
        plan.anchors.add(locator.line);
        const insertError = claimInsert(locator.line);
        if (insertError !== undefined) return insertError;
        plan.inserts.set(locator.line, body);
        continue;
      }
      if (locator.kind === "end") {
        plan.anchors.add(EOF_ANCHOR);
        const insertError = claimInsert(lineCount);
        if (insertError !== undefined) return insertError;
        plan.inserts.set(lineCount, body);
        continue;
      }
      return failure(
        "EDIT_BLOCK_UNRESOLVED",
        `block locator on line ${locator.line} was not resolved; use a concrete range instead`,
      );
    }
    // CUT
    if (op.locator.kind !== "range") {
      return failure("EDIT_PARSE_FAILED", "CUT requires a range (N.=M) or a block (N*)");
    }
    const cutError = bumpIr(op.locator.end - op.locator.start + 1);
    if (cutError !== undefined) return cutError;
    const rangeError = claimRange(op.locator.start, op.locator.end);
    if (rangeError !== undefined) return rangeError;
  }

  if (plan.rem && plan.mv !== undefined) {
    return failure("EDIT_RANGE_INVALID", "REM and MV cannot share one Edit call");
  }
  if (plan.rem && (plan.inserts.size > 0 || plan.deletes.size > 0)) {
    return failure("EDIT_RANGE_INVALID", "REM cannot combine with PUT or CUT");
  }
  return plan;
};

const applyPlan = (lines: ReadonlyArray<string>, plan: Plan): ReadonlyArray<string> => {
  const output: Array<string> = [];
  for (let index = 0; index < lines.length; index++) {
    const inserted = plan.inserts.get(index);
    if (inserted !== undefined) output.push(...inserted);
    if (!plan.deletes.has(index + 1)) output.push(lines[index] ?? "");
  }
  const tail = plan.inserts.get(lines.length);
  if (tail !== undefined) output.push(...tail);
  return output;
};

const clipReveal = (line: string): { readonly text: string; readonly clipped: boolean } => {
  const chars = [...line];
  if (chars.length <= UNSEEN_REVEAL_CHARS) return { text: line, clipped: false };
  return { text: chars.slice(0, UNSEEN_REVEAL_CHARS).join(""), clipped: true };
};

const checkProvenance = (
  liveLines: ReadonlyArray<string>,
  plan: Plan,
  snapshot: FileSnapshot | undefined,
): EditFailure | undefined => {
  const seen = snapshot?.seenLines;
  if (seen === null || seen === undefined) return undefined;
  const anchors = [...plan.anchors].filter((line) => line !== HEAD_ANCHOR && line !== EOF_ANCHOR);
  const unseen = anchors.filter((line) => !seen.has(line));
  if (unseen.length === 0) return undefined;
  const revealLines = unseen.slice(0, UNSEEN_REVEAL_LINES).map((line): UnseenLineReveal => {
    const clipped = clipReveal(liveLines[line - 1] ?? "");
    return { line, text: clipped.text, clipped: clipped.clipped };
  });
  const complete = unseen.length <= UNSEEN_REVEAL_LINES && revealLines.every((row) => !row.clipped);
  const extras: EditFailureExtras = {
    unseenLines: revealLines,
    unseenCount: unseen.length,
    revealTruncated: !complete,
    merged: complete,
  };
  return failure(
    "EDIT_LINES_UNSEEN",
    complete
      ? `anchors reference lines never displayed (${unseen.join(", ")}). The current content is inlined; retry the same tag unchanged`
      : `anchors reference ${unseen.length} unseen line(s); the reveal is truncated; re-read the range and retry`,
    extras,
  );
};

const mapUnchangedLines = (
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
): Map<number, number> => {
  const map = new Map<number, number>();
  const rows = before.length + 1;
  const columns = after.length + 1;
  if (rows * columns > DIFF_CELL_BUDGET) {
    let prefix = 0;
    while (prefix < before.length && before[prefix] === after[prefix]) {
      map.set(prefix + 1, prefix + 1);
      prefix++;
    }
    return map;
  }
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
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      map.set(left + 1, right + 1);
      left++;
      right++;
    } else if (
      (table[(left + 1) * columns + right] ?? 0) >= (table[left * columns + right + 1] ?? 0)
    ) {
      left++;
    } else {
      right++;
    }
  }
  return map;
};

const countLine = (lines: ReadonlyArray<string>, text: string): number => {
  let count = 0;
  for (const line of lines) if (line === text) count++;
  return count;
};

const planRecovery = (
  plan: Plan,
  snapshotLines: ReadonlyArray<string>,
  liveLines: ReadonlyArray<string>,
): { readonly offset: number } | EditFailure => {
  const map = mapUnchangedLines(snapshotLines, liveLines);
  const anchors = [...plan.anchors]
    .filter((line) => line !== HEAD_ANCHOR && line !== EOF_ANCHOR)
    .sort((left, right) => left - right);
  const offsets = new Set<number>();
  for (const anchor of anchors) {
    const mapped = map.get(anchor);
    if (mapped === undefined) {
      return failure(
        "EDIT_TAG_MISMATCH",
        `line ${anchor} changed since the tagged snapshot; drift recovery declined`,
      );
    }
    const offset = mapped - anchor;
    offsets.add(offset);
    const text = snapshotLines[anchor - 1] ?? "";
    const unique = countLine(snapshotLines, text) === 1 && countLine(liveLines, text) === 1;
    const neighbours = [anchor - 1, anchor + 1].filter(
      (line) =>
        line >= 1 &&
        line <= snapshotLines.length &&
        line <= liveLines.length &&
        !plan.anchors.has(line),
    );
    const shifted = neighbours.filter((line) => map.get(line) === line + offset);
    if (unique) {
      if (shifted.length === 0) {
        return failure(
          "EDIT_TAG_MISMATCH",
          `line ${anchor} has no unchanged neighbour at the same offset; recovery declined`,
        );
      }
    } else if (shifted.length < 2) {
      return failure(
        "EDIT_TAG_MISMATCH",
        `line ${anchor} is duplicated and needs both neighbours unchanged to recover; recovery declined`,
      );
    }
  }
  if (offsets.size > 1) {
    return failure(
      "EDIT_TAG_MISMATCH",
      "anchors moved by different offsets; recovery declined because it cannot prove one unchanged region",
    );
  }
  return { offset: [...offsets][0] ?? 0 };
};

const shiftLocator = (locator: Locator, offset: number): Locator => {
  switch (locator.kind) {
    case "range":
      return { kind: "range", start: locator.start + offset, end: locator.end + offset };
    case "before":
      return { kind: "before", line: locator.line + offset };
    case "after":
      return { kind: "after", line: locator.line + offset };
    default:
      return locator;
  }
};

const shiftedOps = (ops: ReadonlyArray<ResolvedOp>, offset: number): ReadonlyArray<ResolvedOp> =>
  ops.map((op) => ({ ...op, locator: shiftLocator(op.locator, offset) }));

const anchorsAround = (liveLines: ReadonlyArray<string>, plan: Plan): ReadonlyArray<string> =>
  [...plan.anchors]
    .filter((line) => line !== HEAD_ANCHOR && line !== EOF_ANCHOR)
    .sort((left, right) => left - right)
    .map((line) => `${line}: ${liveLines[line - 1] ?? ""}`);

export interface EditEngineRequest {
  /** The path as the model spelled it, used for the optional ops header. */
  readonly path: string;
  readonly canonicalPath: string;
  readonly tag: string;
  readonly ops: string;
  /** Live file text, already LF-normalized with any BOM removed. */
  readonly text: string;
  readonly session?: EditSessionState;
  readonly resolver?: BlockResolver;
}

const resolveBaseline = (
  request: EditEngineRequest,
  parsed: ParsedOps,
  liveTag: string,
  liveLines: ReadonlyArray<string>,
):
  | {
      readonly drift: boolean;
      readonly stable: boolean;
      readonly baselineText: string;
      readonly baselineLines: ReadonlyArray<string>;
      readonly snapshot: FileSnapshot | undefined;
    }
  | EditFailure => {
  const expected = request.tag.toUpperCase();
  if (liveTag === expected) {
    return {
      drift: false,
      stable: false,
      baselineText: request.text,
      baselineLines: liveLines,
      snapshot: request.session?.store.latestMatchingText(request.canonicalPath, request.text),
    };
  }
  if (positionStable(parsed.ops)) {
    return {
      drift: true,
      stable: true,
      baselineText: request.text,
      baselineLines: liveLines,
      snapshot: undefined,
    };
  }
  const store = request.session?.store;
  if (store === undefined) {
    return failure(
      "EDIT_TAG_MISMATCH",
      `tag ${expected} does not hash the live file (live tag ${liveTag}); Read ${request.path} and retry with the live tag`,
      { liveTag, expectedTag: expected },
    );
  }
  const snapshot = store.lookupTag(request.canonicalPath, expected);
  if (snapshot === undefined) {
    return failure(
      "EDIT_TAG_UNKNOWN",
      `tag ${expected} is well-formed but this session never recorded it for ${request.path}; Read the file and retry with the live tag ${liveTag}`,
      { liveTag, expectedTag: expected },
    );
  }
  if (!snapshot.retained) {
    return failure(
      "EDIT_TAG_UNKNOWN",
      `tag ${expected} names a file too large to retain; Read ${request.path} again and retry with the live tag ${liveTag}`,
      { liveTag, expectedTag: expected },
    );
  }
  let snapshotText = snapshot.text;
  const eol = snapshotText.includes("\r\n") ? "\r\n" : "\n";
  if (eol === "\r\n") snapshotText = snapshotText.replaceAll("\r\n", "\n");
  return {
    drift: true,
    stable: false,
    baselineText: snapshotText,
    baselineLines: splitFileLines(snapshotText),
    snapshot,
  };
};

/** Apply one `Edit` call through the line-anchored contract (spec 18 §8–§10). */
export const applyEdit = (request: EditEngineRequest): EditResult => {
  if (!FILE_TAG_PATTERN.test(request.tag)) {
    return failure(
      "EDIT_TAG_REQUIRED",
      "tag must be 4 hexadecimal digits from the latest Read, Grep, Write, or Edit result",
    );
  }
  const expected = request.tag.toUpperCase();
  const parsed = parseOps(request.ops);
  if (!("ops" in parsed)) return parsed;
  if (parsed.headerPath !== undefined || parsed.headerTag !== undefined) {
    if (parsed.headerPath !== request.path || parsed.headerTag !== expected) {
      return failure(
        "INVALID_ARGUMENT",
        `ops header [${parsed.headerPath ?? ""}#${parsed.headerTag ?? ""}] disagrees with path=${request.path} tag=${expected}`,
      );
    }
  }

  const liveTag = computeFileTag(request.text);
  const liveLines = splitFileLines(request.text);
  const baseline = resolveBaseline(request, parsed, liveTag, liveLines);
  if (!("drift" in baseline)) return baseline;
  const resolver = request.resolver ?? createStructuralBlockResolver();
  const blocks = resolveBlocks(parsed.ops, baseline.baselineText, request.path, resolver);
  if ("ok" in blocks) return blocks;
  const expanded = expandRegisters(blocks.ops, baseline.baselineLines, request.session);
  if ("ok" in expanded) return expanded;

  let plan = lower(expanded, baseline.baselineLines.length, baseline.baselineLines);
  if ("ok" in plan) return plan;

  const warnings = [...plan.warnings];
  let opsToApply: ReadonlyArray<ResolvedOp> = expanded;
  let lines = liveLines;
  let echoBlocks = blocks.blocks;
  if (baseline.drift) {
    if (baseline.stable) {
      warnings.push(`stale tag ${expected} applied at the file head/tail; live tag is ${liveTag}`);
      echoBlocks = [];
    } else {
      const recovery = planRecovery(plan, baseline.baselineLines, liveLines);
      if ("ok" in recovery) {
        return failure(
          "EDIT_TAG_MISMATCH",
          `${recovery.message}; Read ${request.path} and retry with the live tag ${liveTag}. Current content at the anchors:\n${anchorsAround(liveLines, plan).join("\n")}`,
          {
            liveTag,
            expectedTag: expected,
            anchors: [...plan.anchors].filter(
              (line) => line !== HEAD_ANCHOR && line !== EOF_ANCHOR,
            ),
          },
        );
      }
      const head = request.session?.store.latestTag(request.canonicalPath) === expected;
      warnings.push(
        head
          ? "the file changed outside this session; recovered against the unchanged lines"
          : `tag ${expected} names an older version of ${request.path}; recovered against the unchanged lines`,
      );
      if (recovery.offset !== 0) {
        warnings.push(
          `anchors moved by ${recovery.offset > 0 ? "+" : ""}${recovery.offset} line(s) before applying`,
        );
      }
      opsToApply = shiftedOps(expanded, recovery.offset);
      const relowered = lower(opsToApply, liveLines.length, liveLines);
      if ("ok" in relowered) {
        return failure(
          "EDIT_TAG_MISMATCH",
          `${relowered.message}; Read ${request.path} and retry with the live tag ${liveTag}`,
          { liveTag, expectedTag: expected },
        );
      }
      plan = relowered;
      warnings.push(...relowered.warnings);
      echoBlocks = [];
    }
  } else {
    const provenance = checkProvenance(liveLines, plan, baseline.snapshot);
    if (provenance !== undefined) {
      const merged = provenance.extras?.merged === true;
      if (merged && request.session !== undefined && baseline.snapshot !== undefined) {
        request.session.store.mergeSeenLines(
          request.canonicalPath,
          request.text,
          (provenance.extras?.unseenLines ?? []).map((row) => row.line),
        );
      }
      return provenance;
    }
  }

  if (plan.rem) {
    return {
      ok: true,
      text: request.text,
      tag: expected,
      warnings,
      ops: parsed.ops.map(echoParsedOp),
      blocks: echoBlocks,
      deleteFile: true,
    };
  }

  const nextLines = applyPlan(lines, plan);
  const trailingNewline = request.text.endsWith("\n");
  const nextText =
    lines.length === 0
      ? joinFileLines(nextLines, nextLines.length > 0)
      : joinFileLines(nextLines, trailingNewline);
  if (nextText === request.text && plan.mv === undefined) {
    return failure(
      "EDIT_NO_CHANGE",
      "apply produced identical text; widen or shrink the range so it names changed lines only",
    );
  }

  return {
    ok: true,
    text: nextText,
    tag: computeFileTag(nextText),
    warnings,
    ops: parsed.ops.map(echoParsedOp),
    blocks: echoBlocks,
    deleteFile: false,
    ...(plan.mv === undefined ? {} : { movedTo: plan.mv }),
  };
};

export interface LegacyTextEditRequest {
  readonly path: string;
  readonly canonicalPath: string;
  readonly text: string;
  readonly oldText: string;
  readonly newText: string;
  readonly session?: EditSessionState;
}

/** Lower an `old_string`/`new_string` call to the same line-anchored engine (§11). */
export const applyLegacyTextEdit = (request: LegacyTextEditRequest): EditResult => {
  if (request.oldText === "") {
    return failure(
      "EDIT_LEGACY_MATCH_FAILED",
      "old_string must not be empty; use Write to create or replace a whole file",
    );
  }
  const occurrences = request.text.split(request.oldText).length - 1;
  if (occurrences === 0) {
    return failure(
      "EDIT_LEGACY_MATCH_FAILED",
      `old_string does not appear in ${request.path}. Read the file and copy the text exactly, or use ops with the file tag.`,
    );
  }
  if (occurrences > 1) {
    return failure(
      "EDIT_LEGACY_MATCH_FAILED",
      `old_string appears ${occurrences} times in ${request.path}. Include more surrounding text so it is unique, or use ops with the file tag.`,
    );
  }
  const at = request.text.indexOf(request.oldText);
  const nextText =
    request.text.slice(0, at) + request.newText + request.text.slice(at + request.oldText.length);
  const beforeLines = splitFileLines(request.text);
  const afterLines = splitFileLines(nextText);
  let prefix = 0;
  while (prefix < beforeLines.length && beforeLines[prefix] === afterLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const oldChanged = beforeLines.slice(prefix, beforeLines.length - suffix);
  const newChanged = afterLines.slice(prefix, afterLines.length - suffix);
  if (oldChanged.length === 0 && newChanged.length === 0) {
    return failure(
      "EDIT_NO_CHANGE",
      "the replacement leaves the file unchanged; line-anchored edits preserve the terminal newline",
    );
  }
  const locator =
    oldChanged.length === 0
      ? prefix === 0
        ? "<1"
        : prefix >= beforeLines.length
          ? ">$"
          : `>${prefix}`
      : `${prefix + 1}.=${prefix + oldChanged.length}`;
  const header = newChanged.length === 0 ? `CUT ${locator}` : `PUT ${locator}:`;
  const body = newChanged.map((line) => `+${line}`);
  const ops = [header, ...body].join("\n");
  return applyEdit({
    path: request.path,
    canonicalPath: request.canonicalPath,
    tag: computeFileTag(request.text),
    ops,
    text: request.text,
    ...(request.session === undefined ? {} : { session: request.session }),
  });
};

export interface LegacyHashlineEdit {
  readonly op: "PUT" | "CUT" | "INS";
  readonly start?: string;
  readonly end?: string;
  readonly after?: string;
  readonly content?: string;
}

const legacyLine = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const match = /^(\d+)(?::[0-9a-z]{2})?(?:\|[\s\S]*)?$/u.exec(raw.trim());
  if (match === null) return undefined;
  const line = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(line) && line >= 1 ? line : undefined;
};

/** Lower the pre-DSL `edits[]` shape to ops so one engine owns every write (§11). */
export const legacyHashlineEditsToOps = (
  edits: ReadonlyArray<LegacyHashlineEdit>,
): { readonly ops: string } | EditFailure => {
  const blocks: Array<string> = [];
  for (const edit of edits) {
    const contentRows = splitFileLines(edit.content ?? "");
    if (edit.op === "INS") {
      const after = edit.after?.trim() === "0" ? 0 : legacyLine(edit.after);
      if (after === undefined) {
        return failure(
          "EDIT_PARSE_FAILED",
          `insert anchor ${edit.after ?? ""} is not a line number`,
        );
      }
      if (contentRows.length === 0) continue;
      const header = after === 0 ? "PUT <1:" : `PUT >${after}:`;
      blocks.push(`${header}\n${contentRows.map((row) => `+${row}`).join("\n")}`);
      continue;
    }
    const start = legacyLine(edit.start);
    if (start === undefined) {
      return failure("EDIT_PARSE_FAILED", `edit anchor ${edit.start ?? ""} is not a line number`);
    }
    const end = edit.end === undefined ? start : legacyLine(edit.end);
    if (end === undefined) {
      return failure("EDIT_PARSE_FAILED", `edit anchor ${edit.end ?? ""} is not a line number`);
    }
    if (edit.op === "CUT" || contentRows.length === 0) {
      blocks.push(`CUT ${start}.=${end}`);
      continue;
    }
    blocks.push(`PUT ${start}.=${end}:\n${contentRows.map((row) => `+${row}`).join("\n")}`);
  }
  if (blocks.length === 0) {
    return failure("EDIT_NO_CHANGE", "the edits leave the file unchanged");
  }
  return { ops: blocks.join("\n") };
};

/** §9.2 path recovery: a mistyped path rebinds only when basename and tag are unique. */
export const findRecoveredPath = (
  store: FileAnchorStore,
  requestedPath: string,
  canonicalPath: string,
  tag: string,
): string | undefined =>
  store.findUniqueBasenameTag(pathBasename(requestedPath), tag, canonicalPath);
