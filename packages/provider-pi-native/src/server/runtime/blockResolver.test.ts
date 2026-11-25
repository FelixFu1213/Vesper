import { describe, expect, it } from "vite-plus/test";

import { createStructuralBlockResolver } from "./blockResolver.ts";

const resolver = createStructuralBlockResolver();

const resolve = (text: string, path: string, line: number) => resolver.resolve(text, path, line);

describe("structural block resolver", () => {
  it("resolves a TypeScript function body", () => {
    const text = "const a = 1;\nfunction f() {\n  return a;\n}\nconst b = 2;\n";
    expect(resolve(text, "src/f.ts", 2)).toEqual({ start: 2, end: 4 });
  });

  it("resolves the outermost multi-line construct that opens on the line", () => {
    const text = "const value = compute({\n  a: 1,\n});\n";
    expect(resolve(text, "src/f.ts", 1)).toEqual({ start: 1, end: 3 });
  });

  it("ignores braces inside strings and comments", () => {
    const text = 'const note = "}";\nfunction f() {\n  // }\n  return 1;\n}\n';
    expect(resolve(text, "src/f.ts", 2)).toEqual({ start: 2, end: 5 });
    expect(resolve(text, "src/f.ts", 1)).toBeNull();
  });

  it("resolves Rust, Go, and JSON blocks", () => {
    const rust = "fn main() {\n    body();\n}\n";
    expect(resolve(rust, "src/main.rs", 1)).toEqual({ start: 1, end: 3 });

    const go = "func main() {\n\tbody()\n}\n";
    expect(resolve(go, "main.go", 1)).toEqual({ start: 1, end: 3 });

    const json = '{\n  "a": 1\n}\n';
    expect(resolve(json, "config.json", 1)).toEqual({ start: 1, end: 3 });
  });

  it("declines a bare statement, a closing delimiter, and an unknown language", () => {
    const text = "const a = 1;\nfunction f() {\n  return a;\n}\n";
    expect(resolve(text, "src/f.ts", 1)).toBeNull();
    expect(resolve(text, "src/f.ts", 4)).toBeNull();
    expect(resolve(text, "notes.txt", 2)).toBeNull();
    expect(resolve(text, "src/f.ts", 9)).toBeNull();
  });

  it("resolves a Python definition and declines a decorator line", () => {
    const text = "@decorator\ndef f():\n    return 1\n\nx = 2\n";
    expect(resolve(text, "src/f.py", 2)).toEqual({ start: 2, end: 3 });
    expect(resolve(text, "src/f.py", 1)).toBeNull();
  });

  it("resolves a YAML mapping block", () => {
    const text = "root:\n  child: 1\nother: 2\n";
    expect(resolve(text, "config.yaml", 1)).toEqual({ start: 1, end: 2 });
  });

  it("treats a Markdown heading as a section opener", () => {
    const text = "# Title\n\n## Section\ntext\n## Next\nmore\n";
    expect(resolve(text, "notes.md", 3)).toEqual({ start: 3, end: 4 });
    expect(resolve(text, "notes.md", 1)).toEqual({ start: 1, end: 6 });
    expect(resolve(text, "notes.md", 2)).toBeNull();
  });

  it("resolves a CSS rule", () => {
    expect(resolve(".a {\n  color: red;\n}\n", "site.css", 1)).toEqual({ start: 1, end: 3 });
  });
});
