// @effect-diagnostics nodeBuiltinImport:off -- Permission tests resolve real workspace and attachment roots.
import type { ProviderApprovalDecision, RuntimeMode } from "@t3tools/contracts";
import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  clampRuntimeMode,
  classifyShellCommand,
  classifyToolRisk,
  PermissionEngine,
  RUNTIME_MODE_ORDER,
  type PermissionDecision,
  type ToolApprovalRequest,
} from "./permissions.ts";
import { WorkspaceSandbox } from "./sandbox.ts";

interface EngineOptions {
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: "default" | "plan";
  readonly maxRuntimeMode?: RuntimeMode;
  readonly decisions?: ReadonlyArray<ProviderApprovalDecision>;
  readonly feedback?: string;
  readonly isMcpReadOnly?: (toolName: string) => boolean;
}

interface EngineHarness {
  readonly engine: PermissionEngine;
  readonly requests: Array<ToolApprovalRequest>;
  readonly evaluate: (
    toolName: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<PermissionDecision>;
}

const makeDirectories = async (): Promise<{
  workspace: string;
  outside: string;
  attachments: string;
}> => {
  const workspace = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-native-permissions-")),
  );
  const outside = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-native-permissions-outside-")),
  );
  const attachments = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-native-permissions-attach-")),
  );
  return { workspace, outside, attachments };
};

const withDirectories = async (
  body: (paths: { workspace: string; outside: string; attachments: string }) => Promise<void>,
): Promise<void> => {
  const paths = await makeDirectories();
  try {
    await body(paths);
  } finally {
    await Promise.all(
      Object.values(paths).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
    );
  }
};

const harness = (
  options: {
    readonly workspace: string;
    readonly attachments: string;
    readonly scratch?: string;
  } & EngineOptions,
): EngineHarness => {
  const requests: Array<ToolApprovalRequest> = [];
  const decisions = options.decisions === undefined ? [] : [...options.decisions];
  let index = 0;
  const policy: ProviderAdapterV2RuntimePolicy = {
    runtimeMode: options.runtimeMode ?? "approval-required",
    interactionMode: options.interactionMode ?? "default",
    cwd: options.workspace,
    ...(options.maxRuntimeMode === undefined ? {} : { maxRuntimeMode: options.maxRuntimeMode }),
  };
  const engine = new PermissionEngine({
    policy,
    sandbox: new WorkspaceSandbox({
      cwd: options.workspace,
      readOnlyRoots: [options.attachments],
      ...(options.scratch === undefined ? {} : { scratchRoots: [options.scratch] }),
    }),
    requestApproval: async (request) => {
      requests.push(request);
      const decision = decisions[index] ?? "decline";
      index++;
      return {
        decision,
        ...(options.feedback === undefined ? {} : { feedback: options.feedback }),
      };
    },
    ...(options.isMcpReadOnly === undefined ? {} : { isMcpReadOnly: options.isMcpReadOnly }),
    newRequestId: () => `request-${requests.length + 1}`,
  });
  return {
    engine,
    requests,
    evaluate: (toolName, args, signal) => engine.evaluate(toolName, args, signal),
  };
};

const inWorkspace = (workspace: string, name: string): string => NodePath.join(workspace, name);

describe("runtime mode clamping", () => {
  it("orders modes and clamps to the ceiling", () => {
    expect(RUNTIME_MODE_ORDER).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
    expect(clampRuntimeMode("full-access", "auto")).toBe("auto");
    expect(clampRuntimeMode("auto", "approval-required")).toBe("approval-required");
    expect(clampRuntimeMode("auto-accept-edits", "full-access")).toBe("auto-accept-edits");
    expect(clampRuntimeMode("auto", undefined)).toBe("auto");
  });

  it("enforces the ceiling even when the requested mode is higher", async () => {
    await withDirectories(async ({ workspace, attachments }) => {
      const test = harness({
        workspace,
        attachments,
        runtimeMode: "full-access",
        maxRuntimeMode: "auto",
        decisions: ["accept"],
      });
      expect(test.engine.effectiveRuntimeMode).toBe("auto");
      const decision = await test.evaluate("Write", { path: inWorkspace(workspace, "a.ts") });
      expect(decision.allowed).toBe(true);
      expect(test.requests).toHaveLength(0);
    });
  });
});

describe("read-only tools", () => {
  it("auto-allows workspace reads in every mode without prompting", async () => {
    await withDirectories(async ({ workspace, attachments }) => {
      for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
        const test = harness({ workspace, attachments, runtimeMode });
        await expect(
          test.evaluate("Read", { path: inWorkspace(workspace, "a.ts") }),
        ).resolves.toMatchObject({
          allowed: true,
          risk: "read",
        });
        await expect(test.evaluate("TodoWrite", { steps: [] })).resolves.toMatchObject({
          allowed: true,
        });
        await expect(test.evaluate("TodoRead", {})).resolves.toMatchObject({
          allowed: true,
        });
        await expect(test.evaluate("Skill", { id: "review" })).resolves.toMatchObject({
          allowed: true,
          risk: "read",
        });
        expect(test.requests).toHaveLength(0);
      }
      const planMode = harness({ workspace, attachments, interactionMode: "plan" });
      await expect(planMode.evaluate("TodoRead", {})).resolves.toMatchObject({
        allowed: true,
      });
      expect(planMode.requests).toHaveLength(0);
    });
  });

  it("asks before reading outside the workspace unless the mode is full access", async () => {
    await withDirectories(async ({ workspace, attachments, outside }) => {
      const approval = harness({
        workspace,
        attachments,
        runtimeMode: "auto",
        decisions: ["accept"],
      });
      const asked = await approval.evaluate("Read", { path: NodePath.join(outside, "secret.txt") });
      expect(asked).toMatchObject({ allowed: true, risk: "external_read" });
      expect(approval.requests).toHaveLength(1);

      const full = harness({ workspace, attachments, runtimeMode: "full-access" });
      const free = await full.evaluate("Read", { path: NodePath.join(outside, "secret.txt") });
      expect(free.allowed).toBe(true);
      expect(full.requests).toHaveLength(0);
    });
  });
});

describe("approval-required", () => {
  it("asks for edits, shell commands, and external writes", async () => {
    await withDirectories(async ({ workspace, attachments, outside }) => {
      const test = harness({
        workspace,
        attachments,
        decisions: ["accept", "accept", "accept"],
      });
      await expect(
        test.evaluate("Write", { path: inWorkspace(workspace, "new.ts") }),
      ).resolves.toMatchObject({
        allowed: true,
        risk: "file_edit",
      });
      await expect(test.evaluate("Bash", { command: "ls -la" })).resolves.toMatchObject({
        risk: "safe_shell",
      });
      await expect(
        test.evaluate("Write", { path: NodePath.join(outside, "outside.ts") }),
      ).resolves.toMatchObject({ risk: "external_write" });
      expect(test.requests.map((request) => request.risk)).toEqual([
        "file_edit",
        "safe_shell",
        "external_write",
      ]);
    });
  });

  it("blocks with the user's feedback when declined", async () => {
    await withDirectories(async ({ workspace, attachments }) => {
      const test = harness({
        workspace,
        attachments,
        decisions: ["decline"],
        feedback: "Use the fixture instead.",
      });
      const decision = await test.evaluate("Write", { path: inWorkspace(workspace, "new.ts") });
      expect(decision.allowed).toBe(false);
      if (decision.allowed) throw new Error("expected a denial");
      expect(decision.reason).toContain("declined");
      expect(decision.reason).toContain("Use the fixture instead.");
      expect(decision.requestId).toBe("request-1");
    });
  });

  it("blocks on a cancelled approval", async () => {
    await withDirectories(async ({ workspace, attachments }) => {
      const test = harness({ workspace, attachments, decisions: ["cancel"] });
      const decision = await test.evaluate("Bash", { command: "rm -rf build" });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("cancelled");
    });
  });
});

describe("session grants", () => {
  it("reuses acceptForSession for the same tool, scope, and path", async () => {
    await withDirectories(async ({ workspace, attachments }) => {
      const test = harness({ workspace, attachments, decisions: ["acceptForSession"] });
      const target = inWorkspace(workspace, "repeat.ts");
      expect((await test.evaluate("Write", { path: target })).allowed).toBe(true);
      expect((await test.evaluate("Write", { path: target })).allowed).toBe(true);
      expect(test.requests).toHaveLength(1);

      expect(
        (await test.evaluate("Write", { path: inWorkspace(workspace, "other.ts") })).allowed,
      ).toBe(false);
      expect(test.requests).toHaveLength(2);
    });
  });
});

describe("mode matrix", () => {
  it("auto-accept-edits allows workspace edits and read-only shell but asks for shell", async () => {
    await withDirectories(async ({ workspace, attachments, outside }) => {
      const test = harness({
        workspace,
        attachments,
        runtimeMode: "auto-accept-edits",
        decisions: ["accept", "accept"],
      });
      expect((await test.evaluate("Edit", { path: inWorkspace(workspace, "a.ts") })).allowed).toBe(
        true,
      );
      expect((await test.evaluate("Bash", { command: "git status" })).allowed).toBe(true);
      await expect(test.evaluate("Bash", { command: "npm test" })).resolves.toMatchObject({
        risk: "shell",
      });
      await expect(
        test.evaluate("Write", { path: NodePath.join(outside, "outside.ts") }),
      ).resolves.toMatchObject({ risk: "external_write" });
      expect(test.requests.map((request) => request.risk)).toEqual(["shell", "external_write"]);
    });
  });

  it("auto allows workspace shell but asks for destructive commands", async () => {
    await withDirectories(async ({ workspace, attachments }) => {
      const test = harness({
        workspace,
        attachments,
        runtimeMode: "auto",
        decisions: ["accept", "accept"],
      });
      expect((await test.evaluate("Bash", { command: "npm run build" })).allowed).toBe(true);
      expect(test.requests).toHaveLength(0);

      await expect(test.evaluate("Bash", { command: "rm -rf dist" })).resolves.toMatchObject({
        risk: "destructive_shell",
      });
      await expect(
        test.evaluate("Bash", { command: "git push --force origin main" }),
      ).resolves.toMatchObject({ risk: "destructive_shell" });
      expect(test.requests).toHaveLength(2);
    });
  });

  it("full access allows everything without prompting", async () => {
    await withDirectories(async ({ workspace, attachments, outside }) => {
      const test = harness({ workspace, attachments, runtimeMode: "full-access" });
      expect((await test.evaluate("Bash", { command: "rm -rf dist" })).allowed).toBe(true);
      expect(
        (await test.evaluate("Write", { path: NodePath.join(outside, "outside.ts") })).allowed,
      ).toBe(true);
      expect(test.requests).toHaveLength(0);
    });
  });
});

describe("plan mode", () => {
  it("allows read-only tools and denies mutations without prompting", async () => {
    await withDirectories(async ({ workspace, attachments }) => {
      const test = harness({
        workspace,
        attachments,
        interactionMode: "plan",
        decisions: ["accept"],
        isMcpReadOnly: (toolName) => toolName === "mcp__t3-code__list_threads",
      });
      expect((await test.evaluate("Read", { path: inWorkspace(workspace, "a.ts") })).allowed).toBe(
        true,
      );
      expect((await test.evaluate("Task", { prompt: "look around" })).allowed).toBe(true);
      expect((await test.evaluate("Skill", { id: "review" })).allowed).toBe(true);
      expect((await test.evaluate("mcp__t3-code__list_threads", {})).allowed).toBe(true);
      expect((await test.evaluate("ToolSearch", { query: "SubmitPlan" })).allowed).toBe(true);

      const write = await test.evaluate("Write", { path: inWorkspace(workspace, "a.ts") });
      expect(write.allowed).toBe(false);
      expect(write.reason).toContain("Plan mode is read-only");

      const bash = await test.evaluate("Bash", { command: "ls" });
      expect(bash.allowed).toBe(false);

      const mutatingMcp = await test.evaluate("mcp__t3-code__send_message", {});
      expect(mutatingMcp.allowed).toBe(false);

      expect(test.requests).toHaveLength(0);
    });
  });
});

describe("attachments", () => {
  it("denies writes into attachment roots without prompting", async () => {
    await withDirectories(async ({ workspace, attachments }) => {
      const attachment = NodePath.join(attachments, "screenshot.png");
      await NodeFSP.writeFile(attachment, "fixture");
      const test = harness({ workspace, attachments, runtimeMode: "auto", decisions: ["accept"] });
      const decision = await test.evaluate("Write", { path: attachment });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("read-only");
      expect(test.requests).toHaveLength(0);
    });
  });
});

describe("session scratch", () => {
  it("auto-allows scratch writes without a prompt outside plan mode", async () => {
    await withDirectories(async ({ workspace, attachments, outside }) => {
      const target = NodePath.join(outside, "draft.ts");
      for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
        const test = harness({
          workspace,
          attachments,
          scratch: outside,
          runtimeMode,
          decisions: ["decline"],
        });
        for (const toolName of ["Write", "Edit"]) {
          const decision = await test.evaluate(toolName, { path: target });
          expect(decision.allowed).toBe(true);
          expect(decision.risk).toBe("file_edit");
        }
        expect(test.requests).toHaveLength(0);
      }
    });
  });

  it("still denies scratch writes in plan mode", async () => {
    await withDirectories(async ({ workspace, attachments, outside }) => {
      const test = harness({
        workspace,
        attachments,
        scratch: outside,
        interactionMode: "plan",
        runtimeMode: "full-access",
        decisions: ["accept"],
      });
      const decision = await test.evaluate("Write", { path: NodePath.join(outside, "draft.ts") });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("Plan mode is read-only");
      expect(test.requests).toHaveLength(0);
    });
  });

  it("keeps reads of scratch paths available in plan mode", async () => {
    await withDirectories(async ({ workspace, attachments, outside }) => {
      const test = harness({
        workspace,
        attachments,
        scratch: outside,
        interactionMode: "plan",
      });
      const decision = await test.evaluate("Read", { path: NodePath.join(outside, "draft.ts") });
      expect(decision.allowed).toBe(true);
      expect(decision.risk).toBe("read");
    });
  });
});

describe("MCP tools", () => {
  it("auto-allows read-only MCP tools with workspace targets and asks for mutating ones", async () => {
    await withDirectories(async ({ workspace, attachments, outside }) => {
      const test = harness({
        workspace,
        attachments,
        isMcpReadOnly: (toolName) => toolName === "mcp__t3-code__search",
        decisions: ["accept"],
      });
      const workspaceRead = await test.evaluate("mcp__t3-code__search", {
        path: inWorkspace(workspace, "src"),
      });
      expect(workspaceRead.allowed).toBe(true);
      expect(test.requests).toHaveLength(0);

      await expect(
        test.evaluate("mcp__t3-code__search", { path: NodePath.join(outside, "elsewhere") }),
      ).resolves.toMatchObject({ risk: "external_read" });

      await expect(
        test.evaluate("mcp__t3-code__create_issue", { title: "x" }),
      ).resolves.toMatchObject({
        risk: "mcp_write",
      });
      expect(test.requests).toHaveLength(2);
    });
  });

  it("treats unknown MCP tools as mutating", async () => {
    await withDirectories(async ({ workspace, attachments }) => {
      const test = harness({ workspace, attachments, decisions: ["decline"] });
      const decision = await test.evaluate("mcp__other__do_thing", {});
      expect(decision.allowed).toBe(false);
      expect(test.requests[0]?.risk).toBe("mcp_write");
    });
  });
});

describe("edge cases", () => {
  it("denies relative paths without a workspace folder", async () => {
    const requests: Array<ToolApprovalRequest> = [];
    const engine = new PermissionEngine({
      policy: { runtimeMode: "auto", interactionMode: "default", cwd: null },
      sandbox: new WorkspaceSandbox({ cwd: null }),
      requestApproval: async (request) => {
        requests.push(request);
        return { decision: "accept" };
      },
    });
    const decision = await engine.evaluate("Read", { path: "relative.ts" });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("no workspace folder");
    expect(requests).toHaveLength(0);
  });

  it("does not prompt when the signal is already aborted", async () => {
    await withDirectories(async ({ workspace, attachments }) => {
      const test = harness({ workspace, attachments, decisions: ["accept"] });
      const controller = new AbortController();
      controller.abort();
      const decision = await test.evaluate(
        "Write",
        { path: inWorkspace(workspace, "a.ts") },
        controller.signal,
      );
      expect(decision.allowed).toBe(false);
      expect(test.requests).toHaveLength(0);
    });
  });

  it("reports a failing approval callback as a denial", async () => {
    await withDirectories(async ({ workspace }) => {
      const engine = new PermissionEngine({
        policy: { runtimeMode: "approval-required", interactionMode: "default", cwd: workspace },
        sandbox: new WorkspaceSandbox({ cwd: workspace }),
        requestApproval: async () => {
          throw new Error("transport closed");
        },
      });
      const decision = await engine.evaluate("Bash", { command: "npm test" });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("transport closed");
    });
  });
});

describe("risk helpers", () => {
  it("classifies shell commands", () => {
    expect(classifyShellCommand("git status")).toBe("safe_shell");
    expect(classifyShellCommand("rg needle src")).toBe("safe_shell");
    expect(classifyShellCommand("git diff HEAD~1")).toBe("safe_shell");
    expect(classifyShellCommand("cat file | head -20")).toBe("safe_shell");
    expect(classifyShellCommand("npm run build")).toBe("shell");
    expect(classifyShellCommand("git push origin main")).toBe("shell");
    expect(classifyShellCommand("git commit -m x")).toBe("shell");
    expect(classifyShellCommand("echo hi > out.txt")).toBe("shell");
    expect(classifyShellCommand("rm -rf build")).toBe("destructive_shell");
    expect(classifyShellCommand("git reset --hard HEAD~1")).toBe("destructive_shell");
    expect(classifyShellCommand("git clean -fd")).toBe("destructive_shell");
    expect(classifyShellCommand("dd if=/dev/zero of=disk.img")).toBe("destructive_shell");
    expect(classifyShellCommand("mkfs.ext4 /dev/sda1")).toBe("destructive_shell");
    expect(classifyShellCommand("sudo ls")).toBe("destructive_shell");
    expect(classifyShellCommand("chmod -R 777 .")).toBe("destructive_shell");
    expect(classifyShellCommand(":(){ :|:& };:")).toBe("destructive_shell");
  });

  it("classifies tool risks from the sandbox classification", () => {
    const workspaceFile = {
      rawPath: "a.ts",
      resolvedPath: "/workspace/a.ts",
      access: "write" as const,
      classification: "workspace" as const,
      denied: false,
    };
    const externalFile = {
      ...workspaceFile,
      resolvedPath: "/outside/a.ts",
      classification: "external" as const,
    };
    expect(classifyToolRisk("Write", { path: "a.ts" }, workspaceFile)).toBe("file_edit");
    expect(classifyToolRisk("Edit", { path: "a.ts" }, externalFile)).toBe("external_write");
    expect(classifyToolRisk("Read", { path: "a.ts" }, externalFile)).toBe("external_read");
    expect(classifyToolRisk("Bash", { command: "ls" }, undefined)).toBe("safe_shell");
    expect(classifyToolRisk("Bash", { command: "rm -rf /" }, undefined)).toBe("destructive_shell");
    expect(classifyToolRisk("mcp__t3-code__act", {}, undefined, { mcpReadOnly: true })).toBe(
      "read",
    );
    expect(classifyToolRisk("mcp__t3-code__act", {}, undefined, { mcpReadOnly: false })).toBe(
      "mcp_write",
    );
  });
});
