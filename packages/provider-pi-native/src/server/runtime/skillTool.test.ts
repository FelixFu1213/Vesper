// @effect-diagnostics nodeBuiltinImport:off -- The Skill tool is tested against real SKILL.md files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createSkillTool, loadPiNativeSkill, SKILL_TOOL_NAME } from "./skillTool.ts";
import {
  discoverPiNativeSkills,
  MAX_SKILL_DOCUMENT_BYTES,
  type PiNativeSkillDef,
} from "./skillsDiscovery.ts";

const tempRoots: Array<string> = [];

const tempRoot = async (prefix: string): Promise<string> => {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix)),
  );
  tempRoots.push(root);
  return root;
};

const writeSkill = async (folder: string, contents: string): Promise<void> => {
  await NodeFSP.mkdir(folder, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(folder, "SKILL.md"), contents, "utf8");
};

const catalog = async (
  skills: Record<string, string>,
): Promise<{ home: string; skills: ReadonlyArray<PiNativeSkillDef> }> => {
  const home = await tempRoot("pi-native-skill-tool-");
  const workspace = NodePath.join(home, "app");
  for (const [id, contents] of Object.entries(skills)) {
    await writeSkill(NodePath.join(workspace, ".agents", "skills", id), contents);
  }
  const discovery = await discoverPiNativeSkills({ cwd: workspace, environment: { HOME: home } });
  return { home, skills: discovery.skills };
};

const run = async (
  tool: ReturnType<typeof createSkillTool>,
  params: Record<string, string>,
): Promise<{ text: string; isError: boolean; details: unknown }> => {
  const result = await tool.execute("call-1", params);
  const [block] = result.content;
  return {
    text: block?.type === "text" ? block.text : "",
    isError: result.isError === true,
    details: result.details,
  };
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("createSkillTool", () => {
  it("loads one skill by id and strips its frontmatter", async () => {
    const { skills } = await catalog({
      review: "---\nname: Review\ndescription: Reviews changes\n---\n\nRead the diff first.\n",
    });
    const tool = createSkillTool({ skills: () => skills });

    expect(tool.name).toBe(SKILL_TOOL_NAME);
    const result = await run(tool, { id: "review" });

    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      `<skill_content id="review" path="${skills[0]?.path}">\nRead the diff first.\n</skill_content>`,
    );
    expect(result.details).toEqual({
      loaded: true,
      id: "review",
      name: "Review",
      path: skills[0]?.path,
      scope: "project",
    });
  });

  it("falls back to the skill name when no id is given", async () => {
    const { skills } = await catalog({ release: "---\nname: Release Notes\n---\n\nShip it.\n" });
    const tool = createSkillTool({ skills: () => skills });

    const result = await run(tool, { name: "Release Notes" });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Ship it.");
  });

  it("reports the available ids for an unknown or disabled skill", async () => {
    const { skills } = await catalog({
      review: "---\nname: Review\n---\n\nRead the diff.\n",
      hidden: "---\nname: Hidden\nenabled: false\n---\n\nNope.\n",
    });
    const tool = createSkillTool({ skills: () => skills });

    const unknown = await run(tool, { id: "missing" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('Unknown skill "missing".');
    expect(unknown.text).toContain("Available skills: review.");
    expect(unknown.details).toEqual({
      loaded: false,
      requested: "missing",
      available: ["review"],
    });

    const disabled = await run(tool, { id: "hidden" });
    expect(disabled.isError).toBe(true);
    expect(disabled.text).toContain("Available skills: review.");
  });

  it("refuses a SKILL.md that was symlinked out of its folder after discovery", async () => {
    const { skills } = await catalog({ leaky: "---\nname: Leaky\n---\n\nSafe body.\n" });
    const skill = skills[0];
    expect(skill).toBeDefined();
    const outside = await tempRoot("pi-native-skill-outside-");
    const escaped = NodePath.join(outside, "SKILL.md");
    await NodeFSP.writeFile(escaped, "---\nname: Escaped\n---\n\nSecret.\n", "utf8");
    await NodeFSP.rm(skill?.path ?? "");
    await NodeFSP.symlink(escaped, skill?.path ?? "");

    const tool = createSkillTool({ skills: () => skills });
    const result = await run(tool, { id: "leaky" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("cannot be read");
  });

  it("refuses a document that grew past the size cap", async () => {
    const { skills } = await catalog({ big: "---\nname: Big\n---\n\nSmall.\n" });
    const skill = skills[0];
    await NodeFSP.writeFile(skill?.path ?? "", "x".repeat(MAX_SKILL_DOCUMENT_BYTES + 1), "utf8");

    const loaded = await loadPiNativeSkill(skills, "big");

    expect(loaded.ok).toBe(false);
    expect(loaded.ok ? "" : loaded.message).toContain("cannot be read");
  });
});
