// @effect-diagnostics nodeBuiltinImport:off -- Prompt files live in the pi config directories on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { truncateUtf8 } from "./projectInstructions.ts";

const MAX_PROMPT_BYTES = 64 * 1024;
const DEFAULT_AGENT_DIR = NodePath.join(NodeOS.homedir(), ".pi", "agent");

/**
 * `SYSTEM.md` replaces the persona block only; the runtime's operational, tool,
 * and safety sections are always composed. `APPEND_SYSTEM.md` is appended after
 * the base prompt and before project instructions, so the user's own
 * `AGENTS.md` chain keeps the last word.
 */
export interface CustomSystemPrompt {
  /** Resolved `SYSTEM.md` content. */
  readonly replace?: string | undefined;
  /** Resolved `APPEND_SYSTEM.md` content. */
  readonly append?: string | undefined;
}

export interface LoadCustomSystemPromptInput {
  readonly workspaceRoot?: string | null | undefined;
  /** Overrides `~/.pi/agent`, where the global prompt files live. */
  readonly agentDir?: string | undefined;
}

/** Project before global; a whitespace-only file counts as absent. */
async function readFirst(
  directories: ReadonlyArray<string>,
  fileName: string,
): Promise<string | undefined> {
  for (const directory of directories) {
    try {
      const content = (await NodeFSP.readFile(NodePath.join(directory, fileName), "utf8")).trim();
      if (content !== "") return truncateUtf8(content, MAX_PROMPT_BYTES).text;
    } catch {
      // A missing or unreadable prompt file is an expected state; fall through.
    }
  }
  return undefined;
}

/** `SYSTEM.md` and `APPEND_SYSTEM.md` are discovered independently, each a single winner. */
export async function loadCustomSystemPrompt(
  input: LoadCustomSystemPromptInput,
): Promise<CustomSystemPrompt | undefined> {
  const project = input.workspaceRoot?.trim();
  const directories = [
    ...(project === undefined || project === "" ? [] : [NodePath.join(project, ".pi")]),
    input.agentDir ?? DEFAULT_AGENT_DIR,
  ];
  const replace = await readFirst(directories, "SYSTEM.md");
  const append = await readFirst(directories, "APPEND_SYSTEM.md");
  if (replace === undefined && append === undefined) return undefined;
  return {
    ...(replace === undefined ? {} : { replace }),
    ...(append === undefined ? {} : { append }),
  };
}
