import { estimateCjkAwareTextTokens } from "@t3tools/shared/contextTokens";
import type { Tool } from "effect/ai";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";
import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import { DeviceToolkit } from "./toolkits/device/tools.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import { HtmlToolkit } from "./toolkits/html/tools.ts";
import { IssuesToolkit } from "./toolkits/issues/tools.ts";
import { MessageToolkit } from "./toolkits/message/tools.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import { ThemeToolkit } from "./toolkits/theme/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { ToolSearchToolkit } from "./toolkits/toolSearch/tools.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";

export interface T3McpToolDescriptor {
  readonly name: string;
  readonly toolkit: string;
  readonly description: string;
  /** The compact schema the server advertises, serialized. */
  readonly schemaJson: string;
  readonly charCount: number;
  readonly byteCount: number;
  readonly estimatedTokens: number;
}

// Every toolkit `McpHttpServer.layerTools` registers, plus `tool_search`, which the
// transport adds outside that layer. Importing the toolkit declarations (not the server)
// keeps this reachable from a read-only query without starting an MCP transport.
const T3_MCP_TOOLKITS: ReadonlyArray<{
  readonly toolkit: string;
  readonly tools: Readonly<Record<string, Tool.Any>>;
}> = [
  { toolkit: "preview", tools: PreviewToolkit.tools },
  { toolkit: "orchestrator", tools: OrchestratorToolkit.tools },
  { toolkit: "thread", tools: ThreadToolkit.tools },
  { toolkit: "attachment", tools: AttachmentToolkit.tools },
  { toolkit: "project", tools: ProjectToolkit.tools },
  { toolkit: "environment", tools: EnvironmentToolkit.tools },
  { toolkit: "theme", tools: ThemeToolkit.tools },
  { toolkit: "previewControls", tools: PreviewControlsToolkit.tools },
  { toolkit: "worktree", tools: WorktreeToolkit.tools },
  { toolkit: "pullRequests", tools: PullRequestsToolkit.tools },
  { toolkit: "issues", tools: IssuesToolkit.tools },
  { toolkit: "device", tools: DeviceToolkit.tools },
  { toolkit: "html", tools: HtmlToolkit.tools },
  { toolkit: "message", tools: MessageToolkit.tools },
  { toolkit: "toolSearch", tools: ToolSearchToolkit.tools },
];

const utf8Bytes = (text: string): number => {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
};

let cachedCatalog: ReadonlyArray<T3McpToolDescriptor> | undefined;

/**
 * Every tool the T3 MCP server advertises, with the exact schema it advertises, so a
 * breakdown can price them without asking the transport. Cached: the declarations never
 * change while the process lives.
 */
export function listAdvertisedT3McpTools(): ReadonlyArray<T3McpToolDescriptor> {
  if (cachedCatalog !== undefined) return cachedCatalog;
  const descriptors: T3McpToolDescriptor[] = [];
  for (const { toolkit, tools } of T3_MCP_TOOLKITS) {
    for (const tool of Object.values(tools)) {
      const schemaJson = JSON.stringify(advertisedJsonSchema(tool));
      const description = tool.description ?? "";
      descriptors.push({
        name: tool.name,
        toolkit,
        description,
        schemaJson,
        charCount: schemaJson.length,
        byteCount: utf8Bytes(schemaJson),
        estimatedTokens:
          estimateCjkAwareTextTokens(tool.name) +
          estimateCjkAwareTextTokens(description) +
          estimateCjkAwareTextTokens(schemaJson),
      });
    }
  }
  descriptors.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  cachedCatalog = descriptors;
  return descriptors;
}
