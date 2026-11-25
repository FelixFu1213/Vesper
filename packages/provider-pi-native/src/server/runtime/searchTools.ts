// @effect-diagnostics nodeBuiltinImport:off -- Grep spawns rg and walks the workspace filesystem directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  isSensitivePath,
  loadWorkspaceIgnoreRules,
  rgIgnoreArgs,
  type WorkspaceIgnoreRules,
} from "./ignoreRules.ts";

const SEARCH_STDOUT_CAP_BYTES = 8 * 1024 * 1024;
const SEARCH_MAX_OUTPUT_BYTES = 128 * 1024;
const SEARCH_MAX_LINE_CHARS = 16_384;

export type SearchOutputMode = "content" | "filesWithMatches" | "count";

export const PATH_PARAM_ALIASES = { file_path: "path" } as const;
export const SEARCH_PARAM_ALIASES = {
  query: "pattern",
  glob: "include",
  output_mode: "outputMode",
  head_limit: "headLimit",
} as const;

export const canonicalizeToolParams = <T extends object>(
  params: T,
  aliases: Readonly<Record<string, string>>,
): T => {
  const normalized: Record<string, unknown> = Object.fromEntries(Object.entries(params));
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (normalized[canonical] === undefined && normalized[alias] !== undefined) {
      normalized[canonical] = normalized[alias];
    }
    delete normalized[alias];
  }
  return normalized as T;
};

export const normalizeOutputMode = (value: unknown): SearchOutputMode => {
  if (value === undefined) return "content";
  if (value === "content") return "content";
  if (value === "count") return "count";
  if (
    value === "filesWithMatches" ||
    value === "files_with_matches" ||
    value === "files-with-matches"
  ) {
    return "filesWithMatches";
  }
  throw new Error(`unknown outputMode: ${String(value)} (content | filesWithMatches | count)`);
};

export interface SearchFileAnchorSink {
  recordContentHits(input: {
    readonly path: string;
    readonly content: string;
    readonly lines: ReadonlyArray<number>;
  }): void;
}

export interface GrepHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly clipped: boolean;
}

export interface GrepFileResult {
  readonly path: string;
  readonly tag: string;
  readonly hits: ReadonlyArray<GrepHit>;
  readonly count: number;
}

export interface GrepSearchResult {
  readonly mode: SearchOutputMode;
  readonly files: ReadonlyArray<GrepFileResult>;
  readonly totalMatches: number;
  readonly truncated: boolean;
}

export interface GrepSearchOptions {
  readonly root: string;
  readonly ignoreRoot: string;
  readonly scoped: boolean;
  readonly pattern: string;
  readonly include?: string | undefined;
  readonly outputMode: SearchOutputMode;
  readonly caseInsensitive: boolean;
  readonly headLimit: number;
  readonly globalIgnoreFile?: string | null;
  readonly rgPath?: string | null;
  readonly stdoutCapBytes?: number;
  readonly anchorSink?: SearchFileAnchorSink;
}

export interface GlobSearchOptions {
  readonly root: string;
  readonly ignoreRoot: string;
  readonly scoped: boolean;
  readonly pattern: string;
  readonly limit: number;
  readonly globalIgnoreFile?: string | null;
}

export interface GlobSearchResult {
  readonly files: ReadonlyArray<string>;
  readonly truncated: boolean;
}

interface RawHit {
  readonly line: number;
  readonly text: string;
  readonly clipped: boolean;
}

interface RawSearchFile {
  readonly path: string;
  readonly mtimeMs: number;
  readonly hits: ReadonlyArray<RawHit>;
}

interface CandidateFile {
  readonly path: string;
  readonly mtimeMs: number;
}

const toPosix = (value: string): string => value.split(NodePath.sep).join("/");

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const globToRegExp = (pattern: string): RegExp => {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern.charAt(index);
    if (char === "*") {
      if (pattern.charAt(index + 1) === "*") {
        if (pattern.charAt(index + 2) === "/") {
          source += "(?:.*/)?";
          index += 3;
          continue;
        }
        source += ".*";
        index += 2;
        continue;
      }
      source += "[^/]*";
      index++;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index++;
      continue;
    }
    if (char === "{") {
      const close = pattern.indexOf("}", index);
      if (close !== -1) {
        const options = pattern
          .slice(index + 1, close)
          .split(",")
          .map((option) => escapeRegExp(option));
        source += `(?:${options.join("|")})`;
        index = close + 1;
        continue;
      }
    }
    source += escapeRegExp(char);
    index++;
  }
  return new RegExp(`^${source}$`, "u");
};

const matchesGlob = (matcher: RegExp, pattern: string, relativePath: string): boolean => {
  const normalized = toPosix(relativePath);
  return matcher.test(pattern.includes("/") ? normalized : NodePath.basename(normalized));
};

const clipLine = (line: string): { readonly text: string; readonly clipped: boolean } => {
  const chars = [...line];
  if (chars.length <= SEARCH_MAX_LINE_CHARS) return { text: line, clipped: false };
  return { text: chars.slice(0, SEARCH_MAX_LINE_CHARS).join(""), clipped: true };
};

const mintFileTag = (content: string): string =>
  NodeCrypto.createHash("sha256").update(content).digest("hex").slice(0, 4).toUpperCase();

export const describeDirectoryReadHint = (target: string): string =>
  `Read requires a file, but ${target} is a directory; use Glob with path=${JSON.stringify(target)} and pattern="**/*" (activate Glob first if it is deferred).`;

const compilePattern = (pattern: string, caseInsensitive: boolean): RegExp =>
  new RegExp(pattern, caseInsensitive ? "iu" : "u");

const sortNewestFirst = <T extends { readonly path: string; readonly mtimeMs: number }>(
  files: ReadonlyArray<T>,
): ReadonlyArray<T> =>
  [...files].sort((left, right) =>
    right.mtimeMs === left.mtimeMs
      ? left.path.localeCompare(right.path)
      : right.mtimeMs - left.mtimeMs,
  );

const readCandidateContent = async (target: string): Promise<string | undefined> => {
  try {
    return await NodeFSP.readFile(target, "utf8");
  } catch {
    return undefined;
  }
};

const collectCandidateFiles = async (options: {
  readonly root: string;
  readonly rules: WorkspaceIgnoreRules;
  readonly include?: { readonly regex: RegExp; readonly pattern: string } | undefined;
}): Promise<ReadonlyArray<CandidateFile>> => {
  const stat = await NodeFSP.stat(options.root);
  if (stat.isFile()) {
    if (isSensitivePath(options.root)) return [];
    const include = options.include;
    if (
      include !== undefined &&
      !matchesGlob(include.regex, include.pattern, NodePath.basename(options.root))
    ) {
      return [];
    }
    return [{ path: options.root, mtimeMs: stat.mtimeMs }];
  }

  const candidates: Array<CandidateFile> = [];
  const stack: Array<string> = [options.root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = await NodeFSP.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = NodePath.join(current, entry.name);
      if (isSensitivePath(fullPath)) continue;
      const relativePath = NodePath.relative(options.root, fullPath);
      if (entry.isDirectory()) {
        if (!options.rules.isIgnored(relativePath, true)) stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (options.rules.isIgnored(relativePath, false)) continue;
      const include = options.include;
      if (include !== undefined && !matchesGlob(include.regex, include.pattern, relativePath)) {
        continue;
      }
      try {
        const fileStat = await NodeFSP.stat(fullPath);
        candidates.push({ path: fullPath, mtimeMs: fileStat.mtimeMs });
      } catch {
        continue;
      }
    }
  }
  return candidates;
};

const searchCandidate = async (options: {
  readonly candidate: CandidateFile;
  readonly regex: RegExp;
  readonly mode: SearchOutputMode;
  readonly headLimit: number;
}): Promise<RawSearchFile | undefined> => {
  const content = await readCandidateContent(options.candidate.path);
  if (content === undefined) return undefined;
  const bytes = Buffer.from(content, "utf8");
  if (bytes.subarray(0, 8000).includes(0)) return undefined;

  const hits: Array<RawHit> = [];
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    options.regex.lastIndex = 0;
    if (!options.regex.test(line)) continue;
    const clipped = clipLine(line);
    hits.push({ line: index + 1, text: clipped.text, clipped: clipped.clipped });
    if (options.mode === "filesWithMatches") break;
    if (options.mode === "content" && hits.length > options.headLimit) break;
  }
  if (hits.length === 0) return undefined;
  return { path: options.candidate.path, mtimeMs: options.candidate.mtimeMs, hits };
};

const searchInProcess = async (
  options: GrepSearchOptions,
  rules: WorkspaceIgnoreRules,
): Promise<ReadonlyArray<RawSearchFile>> => {
  const regex = compilePattern(options.pattern, options.caseInsensitive);
  const include =
    options.include === undefined
      ? undefined
      : { regex: globToRegExp(options.include), pattern: options.include };
  const candidates = sortNewestFirst(
    await collectCandidateFiles({
      root: options.root,
      rules,
      ...(include === undefined ? {} : { include }),
    }),
  );
  const files: Array<RawSearchFile> = [];
  for (const candidate of candidates) {
    const result = await searchCandidate({
      candidate,
      regex,
      mode: options.outputMode,
      headLimit: options.headLimit,
    });
    if (result !== undefined) files.push(result);
  }
  return files;
};

interface RgRun {
  readonly stdout: string;
  readonly code: number | null;
  readonly capped: boolean;
  readonly failed: boolean;
}

const runRg = (
  rgPath: string,
  args: ReadonlyArray<string>,
  cwd: string,
  stdoutCapBytes: number,
): Promise<RgRun> =>
  new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let received = 0;
    let capped = false;
    const finish = (code: number | null, failed: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ stdout, code, capped, failed });
    };

    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(rgPath, args, {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish(null, true);
      return;
    }
    child.on("error", () => finish(null, true));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (capped) return;
      received += chunk.length;
      if (received > stdoutCapBytes) {
        const keep = Math.max(0, chunk.length - (received - stdoutCapBytes));
        stdout += chunk.subarray(0, keep).toString("utf8");
        capped = true;
        child.kill("SIGKILL");
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.on("close", (code) => finish(code, false));
  });

const parseRgHits = (stdout: string, ignoreRoot: string): ReadonlyArray<RawSearchFile> => {
  const files = new Map<string, { mtimeMs: number; hits: Array<RawHit> }>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    if (record.type !== "match") continue;
    const data = record.data as Record<string, unknown> | undefined;
    if (data === undefined) continue;
    const pathRecord = data.path as Record<string, unknown> | undefined;
    const pathText = typeof pathRecord?.text === "string" ? pathRecord.text : "";
    if (pathText === "") continue;
    const resolved = NodePath.isAbsolute(pathText)
      ? pathText
      : NodePath.resolve(ignoreRoot, pathText);
    if (isSensitivePath(resolved)) continue;
    const lineRecord = data.lines as Record<string, unknown> | undefined;
    const rawText = typeof lineRecord?.text === "string" ? lineRecord.text : "";
    const text = rawText.replace(/\r?\n$/u, "").replace(/\r$/u, "");
    const clipped = clipLine(text);
    const lineNumber = typeof data.line_number === "number" ? data.line_number : 0;
    const existing = files.get(resolved);
    if (existing !== undefined) {
      existing.hits.push({ line: lineNumber, text: clipped.text, clipped: clipped.clipped });
      continue;
    }
    files.set(resolved, {
      mtimeMs: 0,
      hits: [{ line: lineNumber, text: clipped.text, clipped: clipped.clipped }],
    });
  }

  return [...files.entries()].map(([path, file]) => ({
    path,
    mtimeMs: file.mtimeMs,
    hits: file.hits,
  }));
};

const systemRgSearch = async (
  options: GrepSearchOptions,
  rules: WorkspaceIgnoreRules,
): Promise<
  { readonly files: ReadonlyArray<RawSearchFile>; readonly capped: boolean } | undefined
> => {
  if (options.rgPath === null) return undefined;
  const args = ["--json", "--no-config", "--hidden"];
  if (options.outputMode === "filesWithMatches") {
    args.push("--max-count", "1");
  } else if (options.outputMode === "content") {
    args.push("--max-count", String(options.headLimit + 1));
  }
  if (options.caseInsensitive) args.push("-i");
  if (options.scoped) args.push("--no-ignore");
  args.push(...rgIgnoreArgs(rules));
  if (options.include !== undefined) args.push("--glob", options.include);
  args.push("-e", options.pattern, "--", options.root);

  const run = await runRg(
    options.rgPath ?? "rg",
    args,
    options.ignoreRoot,
    options.stdoutCapBytes ?? SEARCH_STDOUT_CAP_BYTES,
  );
  if (run.failed) return undefined;
  if (!run.capped && run.code !== 0 && run.code !== 1) return undefined;

  const parsed = parseRgHits(run.stdout, options.ignoreRoot);
  const withTimes: Array<RawSearchFile> = [];
  for (const file of parsed) {
    try {
      const stat = await NodeFSP.stat(file.path);
      withTimes.push({ ...file, mtimeMs: stat.mtimeMs });
    } catch {
      continue;
    }
  }
  return { files: withTimes, capped: run.capped };
};

const loadContent = async (
  cache: Map<string, string | undefined>,
  target: string,
): Promise<string | undefined> => {
  const cached = cache.get(target);
  if (cached !== undefined || cache.has(target)) return cached;
  const content = await readCandidateContent(target);
  cache.set(target, content);
  return content;
};

const finishSearch = async (
  options: GrepSearchOptions,
  rawFiles: ReadonlyArray<RawSearchFile>,
  stdoutCapped = false,
): Promise<GrepSearchResult> => {
  const contentCache = new Map<string, string | undefined>();
  const sorted = sortNewestFirst(rawFiles);

  if (options.outputMode === "content") {
    const files: Array<GrepFileResult> = [];
    const totalAvailable = sorted.reduce((sum, file) => sum + file.hits.length, 0);
    let shown = 0;
    let bytes = 0;
    let truncated = stdoutCapped;
    for (const rawFile of sorted) {
      const content = await loadContent(contentCache, rawFile.path);
      const tag = content === undefined ? "" : mintFileTag(content);
      const hits: Array<GrepHit> = [];
      for (const rawHit of rawFile.hits) {
        if (shown >= options.headLimit) {
          truncated = true;
          break;
        }
        bytes += rawFile.path.length + rawHit.text.length + 48;
        if (bytes > SEARCH_MAX_OUTPUT_BYTES) {
          truncated = true;
          break;
        }
        hits.push({
          path: rawFile.path,
          line: rawHit.line,
          text: rawHit.text,
          clipped: rawHit.clipped,
        });
        shown++;
      }
      if (hits.length > 0) {
        files.push({ path: rawFile.path, tag, hits, count: hits.length });
        const unclipped = hits.filter((hit) => !hit.clipped).map((hit) => hit.line);
        if (unclipped.length > 0 && content !== undefined) {
          options.anchorSink?.recordContentHits({
            path: rawFile.path,
            content,
            lines: unclipped,
          });
        }
      }
      if (truncated) break;
    }
    if (shown < totalAvailable) truncated = true;
    return { mode: options.outputMode, files, totalMatches: shown, truncated };
  }

  const limited = sorted.slice(0, options.headLimit);
  const truncated = stdoutCapped || sorted.length > options.headLimit;
  const files: Array<GrepFileResult> = [];
  for (const rawFile of limited) {
    const content = await loadContent(contentCache, rawFile.path);
    files.push({
      path: rawFile.path,
      tag: content === undefined ? "" : mintFileTag(content),
      hits: rawFile.hits.map((hit) => ({
        path: rawFile.path,
        line: hit.line,
        text: hit.text,
        clipped: hit.clipped,
      })),
      count: rawFile.hits.length,
    });
  }
  const totalMatches =
    options.outputMode === "filesWithMatches"
      ? files.length
      : files.reduce((sum, file) => sum + file.count, 0);
  return { mode: options.outputMode, files, totalMatches, truncated };
};

export const searchFiles = async (options: GrepSearchOptions): Promise<GrepSearchResult> => {
  if (isSensitivePath(options.root)) {
    return { mode: options.outputMode, files: [], totalMatches: 0, truncated: false };
  }
  const rules = await loadWorkspaceIgnoreRules({
    ignoreRoot: options.ignoreRoot,
    scoped: options.scoped,
    ...(options.globalIgnoreFile === undefined
      ? {}
      : { globalIgnoreFile: options.globalIgnoreFile }),
  });
  const fromRg = await systemRgSearch(options, rules);
  const rawFiles = fromRg?.files ?? (await searchInProcess(options, rules));
  return finishSearch(options, rawFiles, fromRg?.capped ?? false);
};

export const globFiles = async (options: GlobSearchOptions): Promise<GlobSearchResult> => {
  if (isSensitivePath(options.root)) return { files: [], truncated: false };
  const rules = await loadWorkspaceIgnoreRules({
    ignoreRoot: options.ignoreRoot,
    scoped: options.scoped,
    ...(options.globalIgnoreFile === undefined
      ? {}
      : { globalIgnoreFile: options.globalIgnoreFile }),
  });
  const matcher = globToRegExp(options.pattern);
  const candidates = await collectCandidateFiles({
    root: options.root,
    rules,
    include: { regex: matcher, pattern: options.pattern },
  });
  const sorted = sortNewestFirst(candidates);
  return {
    files: sorted.slice(0, options.limit).map((candidate) => candidate.path),
    truncated: sorted.length > options.limit,
  };
};
