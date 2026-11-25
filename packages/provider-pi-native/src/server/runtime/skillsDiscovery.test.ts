// @effect-diagnostics nodeBuiltinImport:off -- Discovery tests build real SKILL.md folders.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  discoverPiNativeSkills,
  MAX_SKILL_DOCUMENT_BYTES,
  parsePiNativeSkillDocument,
  piNativeSkillsPromptSections,
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

const frontmatter = (fields: string, body = "Follow these steps."): string =>
  `---\n${fields}\n---\n\n${body}\n`;

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("parsePiNativeSkillDocument", () => {
  it("splits frontmatter fields from the instruction body", () => {
    const document = parsePiNativeSkillDocument(
      frontmatter(
        'name: "Release Notes"\ndescription: Writes release notes\nenabled: false\ndisable-model-invocation: true',
      ),
    );
    expect(document?.name).toBe("Release Notes");
    expect(document?.description).toBe("Writes release notes");
    expect(document?.enabled).toBe(false);
    expect(document?.disableModelInvocation).toBe(true);
    expect(document?.body.trim()).toBe("Follow these steps.");
  });

  it("keeps a document without frontmatter usable", () => {
    const document = parsePiNativeSkillDocument("Plain instructions.\n");
    expect(document).toEqual({
      enabled: true,
      disableModelInvocation: false,
      body: "Plain instructions.\n",
    });
  });
});

describe("discoverPiNativeSkills", () => {
  it("lists the closest project roots before user roots and lets a project skill win", async () => {
    const home = await tempRoot("pi-native-skills-home-");
    const workspace = NodePath.join(home, "projects", "app");
    await writeSkill(
      NodePath.join(workspace, ".claude", "skills", "review"),
      frontmatter("name: Review\ndescription: Project review"),
    );
    await writeSkill(
      NodePath.join(home, "projects", ".agents", "skills", "release"),
      frontmatter("name: Release"),
    );
    await writeSkill(
      NodePath.join(home, ".agents", "skills", "review"),
      frontmatter("name: Review\ndescription: User review"),
    );
    await writeSkill(NodePath.join(home, ".claude", "skills", "notes"), frontmatter("name: Notes"));

    const discovery = await discoverPiNativeSkills({
      cwd: workspace,
      environment: { HOME: home },
    });

    expect(discovery.skills.map((skill) => [skill.id, skill.scope])).toEqual([
      ["notes", "user"],
      ["release", "project"],
      ["review", "project"],
    ]);
    expect(discovery.skills.find((skill) => skill.id === "review")?.description).toBe(
      "Project review",
    );
    expect(discovery.serverSkills).toEqual([
      {
        name: "notes",
        displayName: "Notes",
        path: NodePath.join(home, ".claude", "skills", "notes", "SKILL.md"),
        scope: "user",
        enabled: true,
      },
      {
        name: "release",
        displayName: "Release",
        path: NodePath.join(home, "projects", ".agents", "skills", "release", "SKILL.md"),
        scope: "project",
        enabled: true,
      },
      {
        name: "review",
        displayName: "Review",
        description: "Project review",
        path: NodePath.join(workspace, ".claude", "skills", "review", "SKILL.md"),
        scope: "project",
        enabled: true,
      },
    ]);
  });

  it("counts a skill folder reached twice by real path once", async () => {
    const home = await tempRoot("pi-native-skills-home-");
    const workspace = NodePath.join(home, "app");
    const shared = NodePath.join(home, "shared-skills");
    await writeSkill(NodePath.join(shared, "shared"), frontmatter("name: Shared"));
    await NodeFSP.mkdir(NodePath.join(workspace, ".agents"), { recursive: true });
    await NodeFSP.symlink(shared, NodePath.join(workspace, ".agents", "skills"));
    await NodeFSP.mkdir(NodePath.join(home, ".pi", "agent"), { recursive: true });
    await NodeFSP.symlink(shared, NodePath.join(home, ".pi", "agent", "skills"));

    const discovery = await discoverPiNativeSkills({
      cwd: workspace,
      environment: { HOME: home },
    });

    expect(discovery.skills.map((skill) => skill.id)).toEqual(["shared"]);
  });

  it("skips a SKILL.md symlinked outside its own folder", async () => {
    const home = await tempRoot("pi-native-skills-home-");
    const workspace = NodePath.join(home, "app");
    const outside = await tempRoot("pi-native-skills-outside-");
    const escaped = NodePath.join(outside, "SKILL.md");
    await NodeFSP.writeFile(escaped, frontmatter("name: Leaked"), "utf8");
    const folder = NodePath.join(workspace, ".pi", "skills", "leaky");
    await NodeFSP.mkdir(folder, { recursive: true });
    await NodeFSP.symlink(escaped, NodePath.join(folder, "SKILL.md"));
    await writeSkill(NodePath.join(workspace, ".pi", "skills", "safe"), frontmatter("name: Safe"));

    const discovery = await discoverPiNativeSkills({
      cwd: workspace,
      environment: { HOME: home },
    });

    expect(discovery.skills.map((skill) => skill.id)).toEqual(["safe"]);
  });

  it("skips a document over the size cap and a folder without SKILL.md", async () => {
    const home = await tempRoot("pi-native-skills-home-");
    const workspace = NodePath.join(home, "app");
    const oversized = `${frontmatter("name: Huge")}${"x".repeat(MAX_SKILL_DOCUMENT_BYTES)}`;
    await writeSkill(NodePath.join(workspace, ".pi", "skills", "huge"), oversized);
    await NodeFSP.mkdir(NodePath.join(workspace, ".pi", "skills", "empty"), { recursive: true });

    const discovery = await discoverPiNativeSkills({
      cwd: workspace,
      environment: { HOME: home },
    });

    expect(discovery.skills).toEqual([]);
  });

  it("keeps disabled and user-invocation-only skills out of the model catalog", async () => {
    const home = await tempRoot("pi-native-skills-home-");
    const workspace = NodePath.join(home, "app");
    await writeSkill(
      NodePath.join(workspace, ".agents", "skills", "visible"),
      frontmatter("name: Visible\ndescription: Shown to the model"),
    );
    await writeSkill(
      NodePath.join(workspace, ".agents", "skills", "off"),
      frontmatter("name: Off\nenabled: false"),
    );
    await writeSkill(
      NodePath.join(workspace, ".agents", "skills", "manual"),
      frontmatter("name: Manual\ndisableModelInvocation: true"),
    );

    const discovery = await discoverPiNativeSkills({
      cwd: workspace,
      environment: { HOME: home },
    });

    expect(discovery.serverSkills.map((skill) => [skill.name, skill.enabled])).toEqual([
      ["manual", true],
      ["off", false],
      ["visible", true],
    ]);
    expect(
      discovery.serverSkills.find((skill) => skill.name === "manual")?.userInvocationOnly,
    ).toBe(true);
    expect(piNativeSkillsPromptSections(discovery.skills)).toEqual({
      skills: expect.stringContaining("# Skills"),
      "skill:visible": "- `visible`: Visible (Shown to the model)",
    });
  });

  it("stops walking at the repository root", async () => {
    const home = await tempRoot("pi-native-skills-home-");
    const repo = NodePath.join(home, "repo");
    const workspace = NodePath.join(repo, "packages", "app");
    await NodeFSP.mkdir(NodePath.join(repo, ".git"), { recursive: true });
    await writeSkill(NodePath.join(repo, ".pi", "skills", "repo"), frontmatter("name: Repo"));
    await writeSkill(NodePath.join(home, ".pi", "skills", "outside"), frontmatter("name: Outside"));

    const discovery = await discoverPiNativeSkills({
      cwd: workspace,
      environment: { HOME: home },
    });

    expect(discovery.skills.map((skill) => skill.id)).toEqual(["repo"]);
  });
});

describe("piNativeSkillsPromptSections", () => {
  it("returns no sections for an empty catalog", () => {
    expect(piNativeSkillsPromptSections([])).toEqual({});
  });

  it("orders one section per skill by id", async () => {
    const home = await tempRoot("pi-native-skills-home-");
    const workspace = NodePath.join(home, "app");
    await writeSkill(NodePath.join(workspace, ".agents", "skills", "beta"), frontmatter("name: B"));
    await writeSkill(
      NodePath.join(workspace, ".agents", "skills", "alpha"),
      frontmatter("name: A"),
    );

    const discovery = await discoverPiNativeSkills({
      cwd: workspace,
      environment: { HOME: home },
    });

    expect(Object.keys(piNativeSkillsPromptSections(discovery.skills))).toEqual([
      "skills",
      "skill:alpha",
      "skill:beta",
    ]);
  });
});
