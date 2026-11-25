import { isRecoverableEditErrorCode } from "./editEngine.ts";

export const MAX_STRIKES = 3;

export interface MutationFailureState {
  readonly strikes: number;
  readonly freeRetryUsed: boolean;
  readonly hardStop: boolean;
  readonly message: string;
}

interface RecoveryEntry {
  strikes: number;
  readonly graced: Set<string>;
}

export class MutationRecoveryTracker {
  readonly #entries = new Map<string, RecoveryEntry>();

  #entry(realPath: string): RecoveryEntry {
    const existing = this.#entries.get(realPath);
    if (existing !== undefined) return existing;
    const created: RecoveryEntry = { strikes: 0, graced: new Set() };
    this.#entries.set(realPath, created);
    return created;
  }

  recordFailure(realPath: string, errorCode?: string): MutationFailureState {
    const entry = this.#entry(realPath);
    const detail = errorCode === undefined ? "" : ` (${errorCode})`;

    if (isRecoverableEditErrorCode(errorCode) && !entry.graced.has(errorCode ?? "")) {
      entry.graced.add(errorCode ?? "");
      return {
        strikes: entry.strikes,
        freeRetryUsed: true,
        hardStop: false,
        message: `${realPath} failed a recoverable check${detail}. One free retry is available: re-read the file, then retry with the tags that read shows.`,
      };
    }

    entry.strikes = Math.min(entry.strikes + 1, MAX_STRIKES);
    const hardStop = entry.strikes >= MAX_STRIKES;
    return {
      strikes: entry.strikes,
      freeRetryUsed: entry.graced.size > 0,
      hardStop,
      message: hardStop
        ? `Stop mutating ${realPath}${detail}. ${MAX_STRIKES} failed mutations in a row: re-read the file, then ask the user how to proceed instead of retrying the same edit.`
        : `${realPath} failed mutation ${entry.strikes} of ${MAX_STRIKES}${detail}. Re-read the file before retrying.`,
    };
  }

  recordSuccess(realPath: string): void {
    this.#entries.delete(realPath);
  }

  peek(realPath: string): MutationFailureState | undefined {
    const entry = this.#entries.get(realPath);
    if (entry === undefined) return undefined;
    return {
      strikes: entry.strikes,
      freeRetryUsed: entry.graced.size > 0,
      hardStop: entry.strikes >= MAX_STRIKES,
      message: "",
    };
  }
}

export interface ShellPatchDetection {
  readonly isPatch: boolean;
  readonly reason?: string;
}

interface ShellToken {
  readonly value: string;
  readonly raw: string;
  readonly operator: boolean;
}

const openToken = (value: string): ShellToken => ({ value, raw: value, operator: true });

const TWO_CHAR_OPERATORS = new Set(["&&", "||", ">>", ">|", "&>", "<<", ";;", "|&"]);
const ONE_CHAR_OPERATORS = new Set(["|", ";", "&", ">", "<", "(", ")"]);

const tokenize = (code: string): ShellToken[] => {
  const tokens: Array<ShellToken> = [];
  let index = 0;

  while (index < code.length) {
    const char = code.charAt(index);
    if (char === " " || char === "\t" || char === "\r") {
      index++;
      continue;
    }
    if (char === "\n") {
      tokens.push(openToken("\n"));
      index++;
      continue;
    }
    const two = code.slice(index, index + 2);
    if (TWO_CHAR_OPERATORS.has(two)) {
      tokens.push(openToken(two));
      index += 2;
      continue;
    }
    if (ONE_CHAR_OPERATORS.has(char)) {
      tokens.push(openToken(char));
      index++;
      continue;
    }

    let value = "";
    let raw = "";
    while (index < code.length) {
      const current = code.charAt(index);
      if (current === "'" || current === '"') {
        const close = code.indexOf(current, index + 1);
        const end = close === -1 ? code.length : close;
        value += code.slice(index + 1, end);
        raw += code.slice(index, end + 1);
        index = end + 1;
        continue;
      }
      if (current === "\\") {
        const next = code.charAt(index + 1);
        if (next === "\n") {
          index += 2;
          continue;
        }
        if (next !== "") {
          value += next;
          raw += current + next;
          index += 2;
          continue;
        }
        index++;
        continue;
      }
      if (current === " " || current === "\t" || current === "\r" || current === "\n") break;
      if (current === ">" || current === "<") {
        // `2>`: the digits are a descriptor, not a command word.
        if (/^\d+$/u.test(value)) {
          const pair = code.slice(index, index + 2);
          const operator = pair === ">>" || pair === ">|" || pair === "<<" ? pair : current;
          index += operator.length;
          tokens.push(openToken(operator));
          value = "";
          raw = "";
          break;
        }
        break;
      }
      if (ONE_CHAR_OPERATORS.has(current)) break;
      value += current;
      raw += current;
      index++;
    }
    if (value !== "" || raw !== "") tokens.push({ value, raw, operator: false });
  }

  return tokens;
};

const readQuoted = (line: string, start: number): { value: string; next: number } => {
  const quote = line.charAt(start);
  if (quote !== "'" && quote !== '"') return { value: "", next: start };
  const close = line.indexOf(quote, start + 1);
  const end = close === -1 ? line.length : close;
  return { value: line.slice(start + 1, end), next: end + 1 };
};

const heredocDelimiters = (line: string): ReadonlyArray<string> => {
  const delimiters: Array<string> = [];
  let index = 0;
  while (index < line.length) {
    const char = line.charAt(index);
    if (char === "'" || char === '"') {
      index = readQuoted(line, index).next;
      continue;
    }
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "<" && line.charAt(index + 1) === "<") {
      let cursor = index + 2;
      if (line.charAt(cursor) === "-") cursor++;
      while (line.charAt(cursor) === " " || line.charAt(cursor) === "\t") cursor++;
      const quoted = readQuoted(line, cursor);
      if (quoted.value !== "") {
        delimiters.push(quoted.value);
        index = quoted.next;
        continue;
      }
      let end = cursor;
      while (end < line.length && !/[\s;|&<>()]/u.test(line.charAt(end))) end++;
      const word = line.slice(cursor, end);
      if (word !== "") delimiters.push(word);
      index = end;
      continue;
    }
    index++;
  }
  return delimiters;
};

const stripHeredocBodies = (command: string): string => {
  const lines = command.split("\n");
  const kept: Array<string> = [];
  const pending: Array<string> = [];
  for (const line of lines) {
    if (pending.length > 0) {
      const trimmed = line.replace(/^\t+/u, "").trimEnd();
      const at = pending.indexOf(trimmed);
      if (at !== -1) pending.splice(at, 1);
      continue;
    }
    kept.push(line);
    pending.push(...heredocDelimiters(line));
  }
  return kept.join("\n");
};

const REDIRECT_OPERATORS = new Set([">", ">>", ">|", "&>", "<", "<<"]);
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "time", "nohup", "nice", "xargs"]);
const INLINE_INTERPRETERS = new Set(["python", "python2", "python3", "node", "nodejs", "bun"]);
const INLINE_WRITE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bopen\s*\([^)]*['"](?:w|a|r\+|wb|ab)/u,
  /\bwriteFile(?:Sync)?\s*\(/u,
  /\bappendFile(?:Sync)?\s*\(/u,
  /\bcreateWriteStream\s*\(/u,
  /\bwrite_text\s*\(/u,
  /\bwrite_bytes\s*\(/u,
  /\bfs\.(?:write|append)/u,
  /\b(?:rmtree|remove|unlink)\s*\(/u,
];

const isNullDevice = (target: string): boolean =>
  target === "/dev/null" ||
  target === "/dev/stdout" ||
  target === "/dev/stderr" ||
  target.toUpperCase() === "NUL";

const isAssignment = (word: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word);

const programOf = (words: ReadonlyArray<string>): string | undefined => {
  let index = 0;
  let wrapped = false;
  while (index < words.length) {
    const word = words[index];
    if (word === undefined) return undefined;
    if (isAssignment(word)) {
      index++;
      continue;
    }
    if (WRAPPERS.has(word)) {
      wrapped = true;
      index++;
      continue;
    }
    if (wrapped && word.startsWith("-")) {
      index++;
      continue;
    }
    return word;
  }
  return undefined;
};

const writeReason = (words: ReadonlyArray<string>): string | undefined => {
  const program = programOf(words);
  if (program === undefined) return undefined;
  const programIndex = words.indexOf(program);
  const args = words.slice(programIndex + 1);

  if (program === "sed" || program === "gsed") {
    const inPlace = args.some((arg) => /^-[a-zA-Z]*i/u.test(arg) || arg === "--in-place");
    if (inPlace) return "sed rewrites files in place";
  }
  if (program === "perl") {
    const inPlace = args.some((arg) => /^-[a-zA-Z0-9]*i/u.test(arg) || arg === "--in-place");
    if (inPlace) return "perl rewrites files in place";
  }
  if (program === "tee") {
    const targets = args.filter((arg) => !arg.startsWith("-") && !isNullDevice(arg));
    if (targets.length > 0) return "tee writes files";
  }
  if (program === "patch") return "patch edits files";
  if (program === "git" && args[0] === "apply") return "git apply edits files";
  if (INLINE_INTERPRETERS.has(program)) {
    const inline = program.startsWith("python")
      ? args.includes("-c")
      : args.some((arg) => arg === "-e" || arg === "--eval" || arg === "-p");
    if (!inline) return undefined;
    const script = args.join(" ");
    if (INLINE_WRITE_PATTERNS.some((pattern) => pattern.test(script))) {
      return "an inline interpreter script writes files";
    }
  }
  return undefined;
};

export const detectShellFilePatch = (command: string): ShellPatchDetection => {
  const code = stripHeredocBodies(command);
  const tokens = tokenize(code);
  const words: Array<string> = [];
  let pendingRedirect: string | undefined;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (pendingRedirect !== undefined) {
      if (!token.operator && !isNullDevice(token.value)) {
        if (!token.value.startsWith("&")) {
          return { isPatch: true, reason: `\`${pendingRedirect} ${token.value}\` writes a file` };
        }
      }
      pendingRedirect = undefined;
      continue;
    }
    if (token.operator) {
      if (REDIRECT_OPERATORS.has(token.value)) {
        const next = tokens[index + 1];
        if (next?.value === "&") {
          index++;
          continue;
        }
        if (token.value === "<" || token.value === "<<") {
          index++;
          continue;
        }
        pendingRedirect = token.value;
        continue;
      }
      const reason = writeReason(words);
      if (reason !== undefined) return { isPatch: true, reason };
      words.length = 0;
      continue;
    }
    words.push(token.value);
  }

  const reason = writeReason(words);
  if (reason !== undefined) return { isPatch: true, reason };
  return { isPatch: false };
};
