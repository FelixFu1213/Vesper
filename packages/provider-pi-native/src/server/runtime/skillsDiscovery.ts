// @effect-diagnostics nodeBuiltinImport:off -- Skill discovery walks SKILL.md folders on the real filesystem.
import type { ServerProviderSkill } from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { SKILL_SECTION_PREFIX } from "./systemTranscript.ts";

/** One skill document cap, matching PI-Desktop's `MAX_SKILL_DOCUMENT_BYTES`. */
export const MAX_SKILL_DOCUMENT_BYTES = 128 * 1024;
/** Frontmatter is read before the body, so an oversized header is never parsed. */
const MAX_FRONTMATTER_BYTES = 64 * 1024;
const MAX_SKILL_ID_LENGTH = 64;

const PROJECT_SKILL_ROOTS = [".pi/skills", ".agents/skills", ".claude/skills"] as const;
const USER_SKILL_ROOTS = [".pi/agent/skills", ".agents/skills", ".claude/skills"] as const;

/** One installed skill, catalogued for the model and the `$` composer menu. */
export interface PiNativeSkillDef {
  /** The exact token `$<id>`, `/skill:<id>`, and the `Skill` tool use. */
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly path: string;
  /** Real path of the skill folder; every document read must stay inside it. */
  readonly rootDir: string;
  readonly scope: "project" | "user";
  readonly enabled: boolean;
  readonly disableModelInvocation: boolean;
}

export interface PiNativeSkillDiscovery {
  readonly skills: ReadonlyArray<PiNativeSkillDef>;
  readonly serverSkills: ReadonlyArray<ServerProviderSkill>;
}

export interface DiscoverPiNativeSkillsInput {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface PiNativeSkillDocument {
  readonly name?: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly disableModelInvocation: boolean;
  /** The document with its frontmatter removed. */
  readonly body: string;
}

const encoder = new TextEncoder();

const byteLength = (value: string): number => encoder.encode(value).length;

const compareUtf8 = (left: string, right: string): number => {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return a.length - b.length;
};

const statOrUndefined = async (target: string) => {
  try {
    return await NodeFSP.stat(target);
  } catch {
    return undefined;
  }
};

const realPathOrUndefined = async (target: string): Promise<string | undefined> => {
  try {
    return await NodeFSP.realpath(target);
  } catch {
    return undefined;
  }
};

/** True when `target` is a real path strictly below `root`. */
export const isPathInside = (root: string, target: string): boolean => {
  const relative = NodePath.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

const unquote = (value: string): string => value.trim().replace(/^["']|["']$/gu, "");

const isFalsy = (value: string): boolean =>
  ["false", "no", "off", "0"].includes(value.trim().toLowerCase());

const isTruthy = (value: string): boolean =>
  ["true", "yes", "on", "1"].includes(value.trim().toLowerCase());

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u;

/**
 * Splits a SKILL.md into its frontmatter fields and instruction body. The body never
 * keeps the header: the `Skill` tool hands the model instructions only.
 */
export function parsePiNativeSkillDocument(contents: string): PiNativeSkillDocument | undefined {
  const match = FRONTMATTER.exec(contents);
  if (match === null) {
    return { enabled: true, disableModelInvocation: false, body: contents };
  }
  if (byteLength(match[0]) > MAX_FRONTMATTER_BYTES) return undefined;
  let name: string | undefined;
  let description: string | undefined;
  let enabled = true;
  let disableModelInvocation = false;
  for (const line of (match[1] ?? "").split(/\r?\n/u)) {
    const field = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/u.exec(line.trim());
    if (field === null) continue;
    const key = (field[1] ?? "").toLowerCase();
    const value = unquote(field[2] ?? "");
    if (key === "name") {
      if (value !== "" && !/[\u0000-\u001f]/u.test(value)) name = value;
    } else if (key === "description") {
      if (value !== "") description = value;
    } else if (key === "enabled") {
      enabled = !isFalsy(value);
    } else if (key === "disable-model-invocation" || key === "disablemodelinvocation") {
      disableModelInvocation = isTruthy(value);
    }
  }
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    enabled,
    disableModelInvocation,
    body: contents.slice(match[0].length),
  };
}

/** A folder name becomes the `$`-menu token, so it must survive a `$id` mention. */
const skillIdFromFolder = (folderName: string): string | undefined => {
  const id = folderName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_SKILL_ID_LENGTH)
    .replace(/-+$/u, "");
  return /^[a-z0-9][a-z0-9-]*$/u.test(id) ? id : undefined;
};

interface SkillRoot {
  readonly directory: string;
  readonly scope: "project" | "user";
}

/**
 * Project roots are scanned from the workspace upwards, so the closest project wins;
 * the walk stops at the repository root or before HOME, then HOME's own roots follow.
 */
const skillRoots = async (cwd: string, home: string | undefined): Promise<SkillRoot[]> => {
  const roots: SkillRoot[] = [];
  for (let current = cwd; ;) {
    if (home !== undefined && current === home) break;
    for (const relative of PROJECT_SKILL_ROOTS) {
      roots.push({ directory: NodePath.join(current, relative), scope: "project" });
    }
    if ((await statOrUndefined(NodePath.join(current, ".git"))) !== undefined) break;
    const parent = NodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (home !== undefined) {
    for (const relative of USER_SKILL_ROOTS) {
      roots.push({ directory: NodePath.join(home, relative), scope: "user" });
    }
  }
  return roots;
};

const readSkillFolder = async (input: {
  readonly folder: string;
  readonly scope: "project" | "user";
}): Promise<PiNativeSkillDef | undefined> => {
  const id = skillIdFromFolder(NodePath.basename(input.folder));
  if (id === undefined) return undefined;
  const rootDir = await realPathOrUndefined(input.folder);
  if (rootDir === undefined) return undefined;
  const folder = await statOrUndefined(rootDir);
  if (folder?.isDirectory() !== true) return undefined;
  const documentPath = NodePath.join(input.folder, "SKILL.md");
  const documentReal = await realPathOrUndefined(documentPath);
  if (documentReal === undefined) return undefined;
  // A SKILL.md symlinked out of its folder would let a workspace skill read any file.
  if (!isPathInside(rootDir, documentReal)) return undefined;
  const documentStat = await statOrUndefined(documentReal);
  if (documentStat?.isFile() !== true) return undefined;
  if (documentStat.size > MAX_SKILL_DOCUMENT_BYTES) return undefined;
  let contents: string;
  try {
    contents = await NodeFSP.readFile(documentReal, "utf8");
  } catch {
    return undefined;
  }
  const document = parsePiNativeSkillDocument(contents);
  if (document === undefined) return undefined;
  return {
    id,
    name: document.name ?? NodePath.basename(input.folder),
    ...(document.description === undefined ? {} : { description: document.description }),
    path: documentPath,
    rootDir,
    scope: input.scope,
    enabled: document.enabled,
    disableModelInvocation: document.disableModelInvocation,
  };
};

const toServerSkill = (skill: PiNativeSkillDef): ServerProviderSkill => ({
  // The composer inserts `$<name>`, so it carries the id the runtime resolves.
  name: skill.id,
  displayName: skill.name,
  ...(skill.description === undefined ? {} : { description: skill.description }),
  path: skill.path,
  scope: skill.scope,
  enabled: skill.enabled,
  ...(skill.disableModelInvocation ? { userInvocationOnly: true } : {}),
});

/**
 * Every skill this workspace can load. Symlinked roots and folders are followed but
 * counted once by real path, and the closest root wins a name collision so a project
 * skill overrides the user skill it shadows.
 */
export const discoverPiNativeSkills = async (
  input: DiscoverPiNativeSkillsInput,
): Promise<PiNativeSkillDiscovery> => {
  const configuredHome = input.environment.HOME?.trim();
  const home =
    configuredHome === undefined || configuredHome === ""
      ? undefined
      : ((await realPathOrUndefined(configuredHome)) ?? configuredHome);
  const cwd = (await realPathOrUndefined(input.cwd)) ?? NodePath.resolve(input.cwd);
  const seenRoots = new Set<string>();
  const seenFolders = new Set<string>();
  const byId = new Map<string, PiNativeSkillDef>();
  for (const root of await skillRoots(cwd, home)) {
    const rootReal = await realPathOrUndefined(root.directory);
    if (rootReal === undefined || seenRoots.has(rootReal)) continue;
    seenRoots.add(rootReal);
    let entries: string[];
    try {
      entries = await NodeFSP.readdir(rootReal);
    } catch {
      continue;
    }
    for (const entry of entries.sort(compareUtf8)) {
      const skill = await readSkillFolder({
        folder: NodePath.join(rootReal, entry),
        scope: root.scope,
      });
      if (skill === undefined || seenFolders.has(skill.rootDir)) continue;
      seenFolders.add(skill.rootDir);
      if (byId.has(skill.id)) continue;
      byId.set(skill.id, skill);
    }
  }
  const skills = [...byId.values()].sort((left, right) => compareUtf8(left.id, right.id));
  return { skills, serverSkills: skills.map(toServerSkill) };
};

/** Stable fingerprint of the catalog, so a refresh that changed nothing is free. */
export const piNativeSkillsDigest = (skills: ReadonlyArray<PiNativeSkillDef>): string =>
  skills.length === 0
    ? ""
    : JSON.stringify(
        skills.map((skill) => [
          skill.id,
          skill.name,
          skill.description ?? "",
          skill.enabled,
          skill.disableModelInvocation,
          skill.path,
        ]),
      );

const SKILLS_HEADER = [
  "# Skills",
  "",
  "This workspace has taught you the following skills. Each entry is a set of instructions you can load with the `Skill` tool by passing its exact id. When a task matches a skill's description, load the skill first and follow it; do not guess at its content. Load each skill at most once per task.",
].join("\n");

const skillEntry = (skill: PiNativeSkillDef): string => {
  const description = skill.description?.trim();
  return `- \`${skill.id}\`: ${skill.name}${description ? ` (${description})` : ""}`;
};

/**
 * The catalog splits into one header section plus one section per skill, so adding,
 * editing, or revoking a single skill appends a minimal system delta instead of
 * invalidating the cached system prompt.
 */
export const piNativeSkillsPromptSections = (
  skills: ReadonlyArray<PiNativeSkillDef>,
): Record<string, string> => {
  const catalog = skills
    .filter((skill) => skill.enabled && !skill.disableModelInvocation)
    .sort((left, right) => compareUtf8(left.id, right.id));
  if (catalog.length === 0) return {};
  return Object.fromEntries([
    ["skills", SKILLS_HEADER],
    ...catalog.map((skill) => [`${SKILL_SECTION_PREFIX}${skill.id}`, skillEntry(skill)]),
  ]);
};
