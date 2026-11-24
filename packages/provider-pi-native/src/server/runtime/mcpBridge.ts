import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, JsonValue, TextContent } from "@earendil-works/pi-ai";
import {
  MCP_TOOL_EXPOSURE_HEADER,
  type McpProviderSessionConfig,
} from "@t3tools/provider-core/server/mcpSession";

const DEFAULT_TIMEOUT_MS = 10_000;
const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_SERVER_NAME = "t3-code";
const DEFAULT_CLIENT_NAME = "t3-code-pi-native";
const DEFAULT_CLIENT_VERSION = "1.0.0";
const MAX_ERROR_BODY = 400;

type FetchLike = typeof globalThis.fetch;

export interface McpBridgeOptions {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly toolExposure?: "eager" | "deferred";
  readonly serverName?: string;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

export interface McpBridgeMetadata {
  readonly server: string;
  readonly mcpToolName: string;
  readonly readOnlyHint: boolean;
}

export interface McpToolCallDetails {
  readonly server: string;
  readonly tool: string;
  readonly mcpToolName: string;
  readonly readOnlyHint: boolean;
}

export type McpAgentTool = AgentTool<object, McpToolCallDetails>;

export interface McpConnectResult {
  readonly available: boolean;
  readonly tools: ReadonlyArray<McpAgentTool>;
  readonly metadata: ReadonlyMap<string, McpBridgeMetadata>;
  readonly sessionId?: string;
  readonly error?: string;
}

interface JsonRpcEnvelope {
  readonly result?: unknown;
  readonly error?: { readonly message?: string } | undefined;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const truncate = (text: string): string =>
  text.length <= MAX_ERROR_BODY ? text : `${text.slice(0, MAX_ERROR_BODY)}...`;

const parseEnvelope = (text: string, id: number): JsonRpcEnvelope => {
  const trimmed = text.trim();
  if (trimmed === "") return {};
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const match = parsed.find((item) => asRecord(item)?.id === id);
      return asRecord(match) ?? {};
    }
    return asRecord(parsed) ?? {};
  }
  for (const chunk of trimmed.split(/\r?\n\r?\n/u)) {
    const data = chunk
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (data === "") continue;
    const parsed: unknown = JSON.parse(data);
    const record = asRecord(parsed);
    if (record === undefined) continue;
    if (record.id === id || record.error !== undefined) return record;
  }
  return {};
};

interface McpTransport {
  readonly request: (method: string, params?: unknown) => Promise<unknown>;
  readonly notify: (method: string, params?: unknown) => Promise<void>;
  readonly sessionId: () => string | undefined;
}

const createTransport = (
  config: McpProviderSessionConfig,
  options: McpBridgeOptions,
): McpTransport => {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const exposure = options.toolExposure ?? "eager";
  let sessionId: string | undefined;
  let nextId = 1;

  const headers = (): Record<string, string> => ({
    authorization: config.authorizationHeader,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    [MCP_TOOL_EXPOSURE_HEADER]: exposure,
    ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
  });

  const send = async (payload: unknown): Promise<Response> => {
    const response = await doFetch(config.endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const nextSession = response.headers.get("mcp-session-id");
    if (nextSession !== null && nextSession !== "") sessionId = nextSession;
    return response;
  };

  const request = async (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId++;
    const response = await send({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`MCP ${method} failed with HTTP ${response.status}: ${truncate(text)}`);
    }
    const envelope = parseEnvelope(text, id);
    if (envelope.error !== undefined) {
      throw new Error(envelope.error.message ?? `MCP ${method} returned an error`);
    }
    return envelope.result;
  };

  const notify = async (method: string, params?: unknown): Promise<void> => {
    const response = await send({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
    if (!response.ok) {
      throw new Error(`MCP ${method} failed with HTTP ${response.status}`);
    }
    await response.text();
  };

  return { request, notify, sessionId: () => sessionId };
};

const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

const readOnlyHint = (annotations: unknown): boolean => {
  const record = asRecord(annotations);
  if (record === undefined) return false;
  return record.readOnlyHint === true || record.readonly === true;
};

const toContent = (value: unknown): Array<TextContent | ImageContent> => {
  if (!Array.isArray(value)) return [];
  const content: Array<TextContent | ImageContent> = [];
  for (const block of value) {
    const record = asRecord(block);
    if (record === undefined) {
      content.push({ type: "text", text: JSON.stringify(block) });
      continue;
    }
    if (record.type === "text" && typeof record.text === "string") {
      content.push({ type: "text", text: record.text });
      continue;
    }
    if (record.type === "image" && typeof record.data === "string") {
      content.push({
        type: "image",
        data: record.data,
        mimeType: typeof record.mimeType === "string" ? record.mimeType : "image/png",
      });
      continue;
    }
    content.push({ type: "text", text: JSON.stringify(block) });
  }
  return content;
};

const createTool = (
  server: string,
  tool: Record<string, unknown>,
  transport: McpTransport,
): McpAgentTool | undefined => {
  const mcpToolName = tool.name;
  if (typeof mcpToolName !== "string" || !TOOL_NAME_PATTERN.test(mcpToolName)) return undefined;
  const readOnly = readOnlyHint(tool.annotations);
  const inputSchema = asRecord(tool.inputSchema);
  const details: McpToolCallDetails = {
    server,
    tool: mcpToolName,
    mcpToolName,
    readOnlyHint: readOnly,
  };
  return {
    name: `mcp__${server}__${mcpToolName}`,
    label: mcpToolName,
    description:
      typeof tool.description === "string" ? tool.description : `MCP tool ${mcpToolName}`,
    parameters: inputSchema ?? { type: "object", properties: {} },
    execute: async (_toolCallId, params) => {
      const args = asRecord(params) ?? {};
      const result = asRecord(
        await transport.request("tools/call", {
          name: mcpToolName,
          arguments: args,
        }),
      );
      const content = toContent(result?.content);
      const isError = result?.isError === true;
      const fallback: TextContent = {
        type: "text",
        text: isError ? "The MCP tool reported an error." : "The MCP tool returned no content.",
      };
      const structured = result?.structuredContent;
      return {
        content: content.length === 0 ? [fallback] : content,
        details,
        ...(structured === undefined ? {} : { structuredContent: structured as JsonValue }),
        ...(isError ? { isError: true } : {}),
      };
    },
  };
};

/** Answers `isMcpReadOnly` for the permission engine from the bridge's metadata. */
export const mcpReadOnlyPredicate =
  (metadata: ReadonlyMap<string, McpBridgeMetadata>): ((toolName: string) => boolean) =>
  (toolName) =>
    metadata.get(toolName)?.readOnlyHint === true;

/** Connects the T3 MCP endpoint; a missing server only removes tools, it never fails a turn. */
export const connectMcpSession = async (
  config: McpProviderSessionConfig,
  options?: McpBridgeOptions,
): Promise<McpConnectResult> => {
  const server = options?.serverName ?? DEFAULT_SERVER_NAME;
  let transport: McpTransport | undefined;
  try {
    transport = createTransport(config, options ?? {});
    await transport.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: options?.clientName ?? DEFAULT_CLIENT_NAME,
        version: options?.clientVersion ?? DEFAULT_CLIENT_VERSION,
      },
    });
    await transport.notify("notifications/initialized");
    const listed = asRecord(await transport.request("tools/list"));
    const remoteTools = Array.isArray(listed?.tools) ? listed.tools : [];

    const tools: Array<McpAgentTool> = [];
    const metadata = new Map<string, McpBridgeMetadata>();
    for (const entry of remoteTools) {
      const record = asRecord(entry);
      if (record === undefined) continue;
      const tool = createTool(server, record, transport);
      if (tool === undefined) continue;
      if (metadata.has(tool.name)) continue;
      tools.push(tool);
      metadata.set(tool.name, {
        server,
        mcpToolName: String(record.name),
        readOnlyHint: readOnlyHint(record.annotations),
      });
    }

    const sessionId = transport.sessionId();
    return {
      available: true,
      tools,
      metadata,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  } catch (error) {
    const sessionId = transport?.sessionId();
    return {
      available: false,
      tools: [],
      metadata: new Map(),
      error: describe(error),
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  }
};
