// @effect-diagnostics nodeBuiltinImport:off -- The Skill tool reads the SKILL.md it was asked for.
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { obj, opt, str } from "@earendil-works/pi-schema";
import * as NodeFSP from "node:fs/promises";

import {
  isPathInside,
  MAX_SKILL_DOCUMENT_BYTES,
  parsePiNativeSkillDocument,
  type PiNativeSkillDef,
} from "./skillsDiscovery.ts";

/** Tool the model calls to pull a skill document into context on demand. */
export const SKILL_TOOL_NAME = "Skill";

const SKILL_PARAMS = obj({
  id: opt(str({ description: "Exact skill id from the skills catalog." })),
  name: opt(str({ description: "Skill name, used when no id is given." })),
});

export type SkillToolDetails =
  | {
      readonly loaded: true;
      readonly id: string;
      readonly name: string;
      readonly path: string;
      readonly scope: "project" | "user";
    }
  | {
      readonly loaded: false;
      readonly requested: string;
      readonly available: ReadonlyArray<string>;
    };

export type PiNativeSkillLoadResult =
  | { readonly ok: true; readonly skill: PiNativeSkillDef; readonly body: string }
  | { readonly ok: false; readonly message: string; readonly available: ReadonlyArray<string> };

const availableSkillIds = (skills: ReadonlyArray<PiNativeSkillDef>): ReadonlyArray<string> =>
  skills
    .filter((skill) => skill.enabled)
    .map((skill) => skill.id)
    .sort((left, right) => left.localeCompare(right));

const realPathOrUndefined = async (target: string): Promise<string | undefined> => {
  try {
    return await NodeFSP.realpath(target);
  } catch {
    return undefined;
  }
};

/** Re-reads one skill body, refusing anything that left its own folder. */
const readSkillBody = async (skill: PiNativeSkillDef): Promise<string | undefined> => {
  const rootDir = await realPathOrUndefined(skill.rootDir);
  const document = await realPathOrUndefined(skill.path);
  if (rootDir === undefined || document === undefined) return undefined;
  if (!isPathInside(rootDir, document)) return undefined;
  let stat: Awaited<ReturnType<typeof NodeFSP.stat>>;
  try {
    stat = await NodeFSP.stat(document);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size > MAX_SKILL_DOCUMENT_BYTES) return undefined;
  let contents: string;
  try {
    contents = await NodeFSP.readFile(document, "utf8");
  } catch {
    return undefined;
  }
  const body = parsePiNativeSkillDocument(contents)?.body.trim() ?? "";
  return body === "" ? undefined : body;
};

const byUnambiguousName = (
  skills: ReadonlyArray<PiNativeSkillDef>,
  wanted: string,
): PiNativeSkillDef | undefined => {
  const matches = skills.filter((skill) => skill.name.toLowerCase() === wanted.toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
};

/**
 * Resolves a requested skill and loads its instructions. The catalog arrives from the
 * session, so a skill added or removed mid-session is resolved against the live list.
 */
export const loadPiNativeSkill = async (
  skills: ReadonlyArray<PiNativeSkillDef>,
  requested: string,
): Promise<PiNativeSkillLoadResult> => {
  const wanted = requested.trim();
  const available = availableSkillIds(skills);
  if (wanted === "") {
    return { ok: false, message: "A skill id is required.", available };
  }
  const enabled = skills.filter((skill) => skill.enabled);
  const skill =
    enabled.find((candidate) => candidate.id === wanted) ??
    enabled.find((candidate) => candidate.id.toLowerCase() === wanted.toLowerCase()) ??
    byUnambiguousName(enabled, wanted);
  if (skill === undefined) {
    return { ok: false, message: `Unknown skill "${wanted}".`, available };
  }
  const body = await readSkillBody(skill);
  if (body === undefined) {
    return {
      ok: false,
      message: `Skill "${skill.id}" cannot be read from ${skill.path}.`,
      available,
    };
  }
  return { ok: true, skill, body };
};

/** The exact `<skill_content>` block the model sees, shared by the tool and `/skill:`. */
export const formatPiNativeSkillContent = (skill: PiNativeSkillDef, body: string): string =>
  `<skill_content id="${skill.id}" path="${skill.path}">\n${body}\n</skill_content>`;

const text = (value: string): { type: "text"; text: string } => ({ type: "text", text: value });

const availableLine = (available: ReadonlyArray<string>): string =>
  available.length === 0
    ? "No skills are installed for this workspace."
    : `Available skills: ${available.join(", ")}.`;

export const createSkillTool = (input: {
  readonly skills: () => ReadonlyArray<PiNativeSkillDef>;
}): AgentTool<typeof SKILL_PARAMS, SkillToolDetails> => ({
  name: SKILL_TOOL_NAME,
  label: SKILL_TOOL_NAME,
  description:
    "Load the instructions of one installed skill by its exact id. Use it when a task matches a skill listed in the skills catalog, then follow the returned instructions.",
  parameters: SKILL_PARAMS,
  execute: async (_toolCallId, params) => {
    const requested = params.id?.trim() || params.name?.trim() || "";
    const result = await loadPiNativeSkill(input.skills(), requested);
    if (!result.ok) {
      const failure: AgentToolResult<SkillToolDetails> = {
        content: [text(`${result.message}\n${availableLine(result.available)}`)],
        details: { loaded: false, requested, available: result.available },
        isError: true,
      };
      return failure;
    }
    const { skill, body } = result;
    return {
      content: [text(formatPiNativeSkillContent(skill, body))],
      details: {
        loaded: true,
        id: skill.id,
        name: skill.name,
        path: skill.path,
        scope: skill.scope,
      },
    };
  },
});
