/**
 * Token estimates shared by provider adapters and the context breakdown view. One rule
 * per character class plus a flat image budget keeps the breakdown and Pi Native's own
 * budget agreeing when a provider's real tokenizer is unavailable.
 */

/** Flat cost of one image block; providers bill an image as a fixed tile budget. */
export const IMAGE_TOKEN_ESTIMATE = 1_600;

const CJK_TOKENS_PER_CHARACTER = 1.5;
const LATIN_CHARACTERS_PER_TOKEN = 4;

const CJK_CHARACTER =
  /[\u2e80-\u2eff\u2f00-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3130-\u318f\u31a0-\u31bf\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u{20000}-\u{3ffff}]/u;

/** CJK, Kana, and Hangul characters tokenize far denser than Latin text. */
export function estimateCjkAwareTextTokens(text: string): number {
  if (text === "") return 0;
  let cjkCharacters = 0;
  let otherCharacters = 0;
  for (const character of text) {
    if (CJK_CHARACTER.test(character)) {
      cjkCharacters += 1;
    } else {
      otherCharacters += 1;
    }
  }
  return (
    Math.ceil(cjkCharacters * CJK_TOKENS_PER_CHARACTER) +
    Math.ceil(otherCharacters / LATIN_CHARACTERS_PER_TOKEN)
  );
}

/** The callable shape of one tool schema, as a request advertises it. */
export interface ContextToolSchema {
  readonly name: string;
  readonly description?: string | undefined;
  readonly parameters?: unknown;
}

/** What one advertised tool schema costs: name, description, and JSON parameters. */
export function estimateToolSchemaTokens(tool: ContextToolSchema): number {
  return (
    estimateCjkAwareTextTokens(tool.name) +
    (tool.description === undefined ? 0 : estimateCjkAwareTextTokens(tool.description)) +
    (tool.parameters === undefined ? 0 : estimateCjkAwareTextTokens(safeJson(tool.parameters)))
  );
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
