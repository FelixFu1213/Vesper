import type { AgentTool } from "@earendil-works/pi-agent-core";
import { estimateToolSchemaTokens } from "@t3tools/shared/contextTokens";

import { CORE_TOOL_NAMES, DeferredToolRegistry } from "./deferredTools.ts";
import { NamedRegisters } from "./editEngine.ts";
import { FileSnapshotStore } from "./fileSnapshotStore.ts";
import { MutationRecoveryTracker } from "./mutationRecovery.ts";
import { PathMutex } from "./pathLock.ts";
import { WorkspaceSandbox } from "./sandbox.ts";
import { createPiNativeTools } from "./tools.ts";

export interface PiNativeBuiltinToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  /** Declared on every request rather than loaded through `ToolSearch`. */
  readonly core: boolean;
  readonly estimatedTokens: number;
}

/**
 * The built-in tool declarations a Pi Native request can advertise, built from the same
 * factory the runtime uses (plus `ToolSearch`), with dependencies that never execute
 * anything. Cached: the declarations are static per process.
 */
let cachedTools: ReadonlyArray<PiNativeBuiltinToolSchema> | undefined;

export function listPiNativeBuiltinToolSchemas(): ReadonlyArray<PiNativeBuiltinToolSchema> {
  if (cachedTools !== undefined) return cachedTools;
  const builtinTools: ReadonlyArray<AgentTool<any>> = createPiNativeTools({
    sandbox: new WorkspaceSandbox({ cwd: null }),
    anchors: new FileSnapshotStore(),
    registers: new NamedRegisters(),
    recovery: new MutationRecoveryTracker(),
    locks: new PathMutex(),
    requestUserInput: async () => ({}),
    onSubmitPlan: () => undefined,
    onTodoUpdate: () => undefined,
    onRequestCompaction: () => undefined,
    isPlanMode: () => false,
  });
  const registry = new DeferredToolRegistry();
  registry.setTools(builtinTools);
  const tools = registry.allDeclarations();
  cachedTools = tools
    .map((tool) => {
      const description = tool.description ?? "";
      return {
        name: tool.name,
        description,
        parameters: tool.parameters,
        core: CORE_TOOL_NAMES.has(tool.name),
        estimatedTokens: estimateToolSchemaTokens({
          name: tool.name,
          description,
          parameters: tool.parameters,
        }),
      };
    })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return cachedTools;
}
