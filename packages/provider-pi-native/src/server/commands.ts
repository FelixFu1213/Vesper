import type { ServerProviderSlashCommand } from "@t3tools/contracts";

/** Slash commands T3 maps onto first-class Pi Native behavior. */
export const PI_NATIVE_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  {
    name: "goal",
    description: "Run an autonomous goal until verified complete",
    input: { hint: "Objective, or pause, resume, clear" },
  },
  {
    name: "compact",
    description: "Compact conversation history into a summary",
    input: { hint: "Optional focus instructions" },
  },
  {
    name: "review",
    description: "Review uncommitted changes, a branch, or a specific target",
    input: { hint: "Optional branch, commit range, or path" },
  },
  {
    name: "grill-me",
    description: "Interview you one question at a time to converge on a design",
    input: { hint: "Optional topic or requirement" },
  },
  {
    name: "boost",
    description: "Deep thinking, structured planning, and rigorous verification",
    input: { hint: "Task to solve with extra rigor" },
  },
  {
    name: "init",
    description: "Inspect the repository and create or update AGENTS.md",
    input: { hint: "Optional focus or conventions" },
  },
];

export interface PiNativeCompactCommand {
  readonly instructions?: string;
}

/** Reads `/compact [instructions]`; messages with attachments are ordinary prompts. */
export function parsePiNativeCompactCommand(message: {
  readonly text: string;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
}): PiNativeCompactCommand | null {
  if ((message.attachments?.length ?? 0) > 0) return null;
  const match = /^\/compact(?:\s+([\s\S]*))?$/iu.exec(message.text.trim());
  if (match === null) return null;
  const instructions = (match[1] ?? "").trim();
  return instructions === "" ? {} : { instructions };
}

export type PiNativeWorkflowCommandName = "review" | "grill-me" | "boost" | "init";

export interface PiNativeWorkflowCommand {
  readonly command: PiNativeWorkflowCommandName;
  readonly argument: string;
  readonly promptText: string;
  readonly systemDirective: string;
  readonly boostThinking: boolean;
}

const WORKFLOW_COMMANDS: Record<
  PiNativeWorkflowCommandName,
  {
    readonly defaultPrompt: string;
    readonly argumentPrompt?: (argument: string) => string;
    readonly systemDirective: string;
    readonly boostThinking: boolean;
  }
> = {
  review: {
    defaultPrompt: "Review the current uncommitted changes and workspace state.",
    argumentPrompt: (argument) => `Review the following target and changes:\n${argument}`,
    systemDirective:
      '<workflow_command name="review">Perform a thorough, read-only code review (inspect git status/diff and read referenced files directly). Focus on bugs, regressions, edge cases, contract mismatches, and missing tests. Order findings by severity with concrete file/line references. Do not modify workspace files unless the user explicitly asks for fixes.</workflow_command>',
    boostThinking: false,
  },
  "grill-me": {
    defaultPrompt: "Let's work through requirements and design decisions for this task.",
    argumentPrompt: (argument) => argument,
    systemDirective:
      '<workflow_command name="grill-me">Explore the relevant codebase files first so you never ask questions answerable from code. Then interview the user one focused question at a time using asktool (always listing the recommended option first as "(Recommended)") walking systematically down the design tree until reaching a shared understanding before any implementation. Do not edit files during the interview.</workflow_command>',
    boostThinking: false,
  },
  boost: {
    defaultPrompt: "Analyze carefully, verify thoroughly, and proceed.",
    argumentPrompt: (argument) => argument,
    systemDirective:
      '<workflow_command name="boost">Deep-thinking mode: carefully inspect all relevant code and edge cases, evaluate trade-offs before editing, make clean non-duplicative changes, and run thorough verification (tests/typecheck/lint as applicable) before concluding.</workflow_command>',
    boostThinking: true,
  },
  init: {
    defaultPrompt:
      "Inspect this repository and create or update AGENTS.md with accurate contributor guidance.",
    argumentPrompt: (argument) => `Create or update AGENTS.md with emphasis on:\n${argument}`,
    systemDirective:
      '<workflow_command name="init">Inspect the repository structure, package scripts, tooling (build/test/lint/typecheck), architectural conventions, and any existing AGENTS.md or CLAUDE.md files. Then create or concisely update AGENTS.md at the repository root based only on directly verified facts from files and commands.</workflow_command>',
    boostThinking: false,
  },
};

/** Reads `/review`, `/grill-me`, `/boost`, and `/init` with their optional argument. */
export function parsePiNativeWorkflowCommand(text: string): PiNativeWorkflowCommand | null {
  const match = /^\/(review|grill-me|boost|init)(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (match === null) return null;
  const command = (match[1] ?? "").toLowerCase() as PiNativeWorkflowCommandName;
  const definition = WORKFLOW_COMMANDS[command];
  const argument = (match[2] ?? "").trim();
  return {
    command,
    argument,
    promptText:
      argument === ""
        ? definition.defaultPrompt
        : (definition.argumentPrompt?.(argument) ?? definition.defaultPrompt),
    systemDirective: definition.systemDirective,
    boostThinking: definition.boostThinking,
  };
}

export interface PiNativeSkillCommand {
  /** The exact id the composer's `$` menu and the `Skill` tool use. */
  readonly skillId: string;
  readonly args: string;
}

/** Reads an explicit `/skill:<id> [args]` invocation, the slash form of a `$<id>` mention. */
export function parsePiNativeSkillCommand(text: string): PiNativeSkillCommand | null {
  const match = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (match === null) return null;
  const skillId = (match[1] ?? "").trim();
  if (skillId === "") return null;
  return { skillId, args: (match[2] ?? "").trim() };
}

/**
 * `$<id>` tokens the composer inserted, resolved against the installed catalog so a
 * price such as `$5` or an unknown mention stays ordinary text.
 */
export function piNativeSkillMentions(
  text: string,
  skillIds: Iterable<string>,
): ReadonlyArray<string> {
  const installed = new Set(skillIds);
  const found: Array<string> = [];
  for (const match of text.matchAll(/\$([A-Za-z0-9][A-Za-z0-9_-]*)/gu)) {
    const id = match[1] ?? "";
    if (!installed.has(id) || found.includes(id)) continue;
    found.push(id);
  }
  return found;
}
