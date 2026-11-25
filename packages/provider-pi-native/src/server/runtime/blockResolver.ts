/**
 * Zero-dependency structural block resolution for `N*` and `>N*`. Any language
 * outside the supported set declines; a declined block op is a clean rejection,
 * never an approximate span.
 */
export interface ResolvedBlock {
  /** 1-indexed inclusive first line. */
  readonly start: number;
  /** 1-indexed inclusive last line. */
  readonly end: number;
}

export interface BlockResolver {
  resolve(text: string, path: string, line: number): ResolvedBlock | null;
}

type BlockFamily = "brace" | "indent" | "markdown";

const BRACE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "rs",
  "go",
  "json",
  "jsonc",
  "css",
  "scss",
  "less",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "hxx",
  "java",
  "cs",
  "kt",
  "kts",
  "swift",
  "scala",
  "php",
]);

const INDENT_EXTENSIONS: ReadonlySet<string> = new Set(["py", "pyi", "pyw", "yaml", "yml"]);
const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(["md", "markdown", "mdx"]);

const familyOf = (path: string): BlockFamily | undefined => {
  const match = /\.([A-Za-z0-9]+)$/u.exec(path);
  const extension = match?.[1]?.toLowerCase();
  if (extension === undefined) return undefined;
  if (BRACE_EXTENSIONS.has(extension)) return "brace";
  if (INDENT_EXTENSIONS.has(extension)) return "indent";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  return undefined;
};

const indentWidth = (line: string): number => {
  let width = 0;
  for (const char of line) {
    if (char === " ") width++;
    else if (char === "\t") width += 4;
    else break;
  }
  return width;
};

const isBlankOrComment = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("//");
};

interface Opener {
  readonly char: string;
  readonly line: number;
  matchLine: number | undefined;
}

const CLOSERS: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };

const scanBraceOpeners = (text: string): ReadonlyArray<Opener> => {
  const openers: Array<Opener> = [];
  const stack: Array<Opener> = [];
  let line = 1;
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "\n") {
      line++;
      index++;
      continue;
    }
    if (char === "/" && text.charAt(index + 1) === "/") {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (char === "/" && text.charAt(index + 1) === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (let cursor = index; cursor < stop; cursor++) {
        if (text.charAt(cursor) === "\n") line++;
      }
      index = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      index++;
      while (index < text.length) {
        const current = text.charAt(index);
        if (current === "\\") {
          index += 2;
          continue;
        }
        if (current === "\n") {
          line++;
          if (char !== "`") break;
          index++;
          continue;
        }
        index++;
        if (current === char) break;
      }
      continue;
    }
    if (char === "{" || char === "(" || char === "[") {
      stack.push({ char, line, matchLine: undefined });
      index++;
      continue;
    }
    const expected = CLOSERS[char];
    if (expected !== undefined) {
      while (stack.length > 0) {
        const opener = stack.pop();
        if (opener === undefined) break;
        if (opener.char === expected) {
          opener.matchLine = line;
          openers.push(opener);
          break;
        }
      }
    }
    index++;
  }
  return openers;
};

const resolveBraceBlock = (
  text: string,
  lines: ReadonlyArray<string>,
  line: number,
): ResolvedBlock | null => {
  const openers = scanBraceOpeners(text).filter(
    (opener) => opener.line === line && (opener.matchLine ?? 0) > line,
  );
  const opener = openers.reduce<Opener | undefined>(
    (best, candidate) =>
      best === undefined || (candidate.matchLine ?? 0) > (best.matchLine ?? 0) ? candidate : best,
    undefined,
  );
  const end = opener?.matchLine;
  if (end === undefined) return null;
  if (end > lines.length) return null;
  return { start: line, end };
};

const nextContentLine = (lines: ReadonlyArray<string>, from: number): number | undefined => {
  for (let index = from; index < lines.length; index++) {
    if ((lines[index] ?? "").trim() !== "") return index;
  }
  return undefined;
};

const resolveIndentBlock = (lines: ReadonlyArray<string>, line: number): ResolvedBlock | null => {
  const opener = lines[line - 1];
  if (opener === undefined || isBlankOrComment(opener)) return null;
  const base = indentWidth(opener);
  const first = nextContentLine(lines, line);
  if (first === undefined || indentWidth(lines[first] ?? "") <= base) return null;
  let end = line;
  for (let index = line; index < lines.length; index++) {
    const current = lines[index] ?? "";
    if (current.trim() === "") continue;
    if (indentWidth(current) <= base) break;
    end = index + 1;
  }
  return end > line ? { start: line, end } : null;
};

const HEADING = /^(#{1,6})\s/u;

const resolveMarkdownBlock = (lines: ReadonlyArray<string>, line: number): ResolvedBlock | null => {
  const opener = HEADING.exec(lines[line - 1] ?? "");
  if (opener === null) return null;
  const level = (opener[1] ?? "").length;
  let end = lines.length;
  for (let index = line; index < lines.length; index++) {
    const heading = HEADING.exec(lines[index] ?? "");
    if (heading === null) continue;
    if ((heading[1] ?? "").length <= level) {
      end = index;
      break;
    }
  }
  return end > line ? { start: line, end } : null;
};

export const createStructuralBlockResolver = (): BlockResolver => ({
  resolve: (text, path, line) => {
    const family = familyOf(path);
    if (family === undefined) return null;
    const lines = text.split("\n");
    if (text.endsWith("\n")) lines.pop();
    if (line < 1 || line > lines.length) return null;
    if (family === "markdown") return resolveMarkdownBlock(lines, line);
    if (family === "indent") return resolveIndentBlock(lines, line);
    return resolveBraceBlock(text, lines, line);
  },
});
