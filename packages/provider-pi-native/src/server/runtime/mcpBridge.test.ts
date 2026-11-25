import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import { describe, expect, it } from "vite-plus/test";

import { connectMcpSession, mcpReadOnlyPredicate } from "./mcpBridge.ts";

interface JsonRpcBody {
  readonly jsonrpc: string;
  readonly id?: number;
  readonly method: string;
  readonly params?: unknown;
}

interface RecordedCall {
  readonly body: JsonRpcBody;
  readonly headers: Record<string, string>;
}

const config: McpProviderSessionConfig = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "session-1",
  providerInstanceId: ProviderInstanceId.make("piNative"),
  endpoint: "http://127.0.0.1:1/mcp",
  authorizationHeader: "Bearer fixture",
  browserToolsAvailable: true,
};

const jsonResponse = (
  id: number | undefined,
  result: unknown,
  options?: { readonly sessionId?: string },
): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(options?.sessionId === undefined ? {} : { "mcp-session-id": options.sessionId }),
    },
  });

const sseResponse = (id: number | undefined, result: unknown): Response =>
  new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const createFetch = (
  handler: (body: JsonRpcBody, headers: Record<string, string>) => Response | Promise<Response>,
): { readonly fetchImpl: typeof globalThis.fetch; readonly calls: Array<RecordedCall> } => {
  const calls: Array<RecordedCall> = [];
  const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as JsonRpcBody;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ body, headers });
    return handler(body, headers);
  };
  return { fetchImpl, calls };
};

const TOOLS = [
  {
    name: "list_threads",
    description: "List threads",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "send_message",
    description: "Send a message",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
  { name: "bad name", description: "invalid", inputSchema: {} },
  { name: "list_threads", description: "duplicate", inputSchema: {} },
];

const sessionHandler =
  (options?: { readonly toolsList?: Response }) =>
  (body: JsonRpcBody): Response => {
    if (body.method === "initialize") {
      return jsonResponse(body.id, { protocolVersion: "2025-06-18" }, { sessionId: "session-42" });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (body.method === "tools/list") {
      return options?.toolsList ?? jsonResponse(body.id, { tools: TOOLS });
    }
    if (body.method === "tools/call") {
      return jsonResponse(body.id, {
        content: [
          { type: "text", text: "called" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
        structuredContent: { ok: true },
      });
    }
    return new Response("unknown method", { status: 404 });
  };

describe("connectMcpSession", () => {
  it("initializes, lists tools, and forwards the T3 headers", async () => {
    const { fetchImpl, calls } = createFetch(sessionHandler());
    const result = await connectMcpSession(config, { fetch: fetchImpl });

    expect(result.available).toBe(true);
    expect(result.sessionId).toBe("session-42");
    expect(result.error).toBeUndefined();
    expect(calls.map((call) => call.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);

    const [initialize, initialized, list] = calls;
    expect(initialize?.headers.authorization).toBe("Bearer fixture");
    expect(initialize?.headers["content-type"]).toBe("application/json");
    expect(initialize?.headers.accept).toBe("application/json, text/event-stream");
    expect(initialize?.headers["t3-tool-exposure"]).toBe("eager");
    expect(initialize?.headers["mcp-session-id"]).toBeUndefined();
    expect(initialized?.body.id).toBeUndefined();
    expect(list?.headers["mcp-session-id"]).toBe("session-42");

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "mcp__t3-code__list_threads",
      "mcp__t3-code__send_message",
    ]);
    expect(result.metadata.get("mcp__t3-code__list_threads")).toEqual({
      server: "t3-code",
      mcpToolName: "list_threads",
      readOnlyHint: true,
    });
    expect(result.metadata.get("mcp__t3-code__send_message")?.readOnlyHint).toBe(false);

    const isReadOnly = mcpReadOnlyPredicate(result.metadata);
    expect(isReadOnly("mcp__t3-code__list_threads")).toBe(true);
    expect(isReadOnly("mcp__t3-code__send_message")).toBe(false);
    expect(isReadOnly("mcp__unknown__missing")).toBe(false);
  });

  it("honors the configured exposure header and server name", async () => {
    const { fetchImpl, calls } = createFetch(sessionHandler());
    const result = await connectMcpSession(config, {
      fetch: fetchImpl,
      toolExposure: "deferred",
      serverName: "t3-code-eager",
    });
    expect(calls[0]?.headers["t3-tool-exposure"]).toBe("deferred");
    expect(result.tools[0]?.name).toBe("mcp__t3-code-eager__list_threads");
  });

  it("hides the raw search tool when the session is deferred", async () => {
    const { fetchImpl } = createFetch((body) => {
      if (body.method === "initialize") return jsonResponse(body.id, {});
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return jsonResponse(body.id, {
        tools: [{ name: "tool_search", description: "Search tools", inputSchema: {} }, TOOLS[0]],
      });
    });
    const result = await connectMcpSession(config, { fetch: fetchImpl, toolExposure: "deferred" });
    expect(result.tools.map((tool) => tool.name)).toEqual(["mcp__t3-code__list_threads"]);
  });

  it("refreshes declarations after the server announces a tool list change", async () => {
    let listed = 1;
    const { fetchImpl, calls } = createFetch((body) => {
      if (body.method === "initialize") return jsonResponse(body.id, {});
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") {
        const searchTool = { name: "tool_search", description: "Search tools", inputSchema: {} };
        const tools =
          listed === 1
            ? [searchTool, TOOLS[0]]
            : [
                searchTool,
                TOOLS[0],
                {
                  name: "t3_thread_list",
                  description: "List T3 threads",
                  inputSchema: { type: "object", properties: {} },
                  annotations: { readOnlyHint: true },
                },
              ];
        listed += 1;
        return jsonResponse(body.id, { tools });
      }
      // The search result and the list_changed notification share one SSE response.
      return new Response(
        [
          `data: ${JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/tools/list_changed",
          })}`,
          "",
          `data: ${JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { structuredContent: { tools: [{ name: "t3_thread_list" }] } },
          })}`,
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const result = await connectMcpSession(config, { fetch: fetchImpl, toolExposure: "deferred" });

    const names = await result.searchTools("thread");
    expect(names).toEqual(["mcp__t3-code__t3_thread_list"]);
    expect(calls.at(-2)?.body.method).toBe("tools/call");
    expect(calls.at(-2)?.body.params).toEqual({
      name: "tool_search",
      arguments: { query: "thread" },
    });
    expect(calls.at(-1)?.body.method).toBe("tools/list");

    const refreshed = await result.refreshTools();
    expect(refreshed.map((tool) => tool.name)).toContain("mcp__t3-code__t3_thread_list");
    // Loading clears the notification flag so repeated refreshes reuse the cache.
    await result.refreshTools();
    expect(calls.filter((call) => call.body.method === "tools/list")).toHaveLength(2);
    expect(result.metadata.get("mcp__t3-code__t3_thread_list")?.readOnlyHint).toBe(true);
    const isReadOnly = mcpReadOnlyPredicate(result.metadata);
    expect(isReadOnly("mcp__t3-code__t3_thread_list")).toBe(true);
  });

  it("skips or catches remote search errors and reloads missing tools without notifications", async () => {
    const plain = createFetch(sessionHandler());
    const plainResult = await connectMcpSession(config, {
      fetch: plain.fetchImpl,
      toolExposure: "deferred",
    });
    await expect(plainResult.searchTools("threads")).resolves.toEqual([]);
    expect(plain.calls.some((call) => call.body.method === "tools/call")).toBe(false);

    let listCount = 0;
    const remote = createFetch((body) => {
      if (body.method === "initialize") return jsonResponse(body.id, {});
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") {
        listCount += 1;
        const tools =
          listCount === 1
            ? [{ name: "tool_search", description: "Search tools", inputSchema: {} }, TOOLS[0]]
            : [TOOLS[0], TOOLS[1]];
        return jsonResponse(body.id, { tools });
      }
      if (
        (body.params as { readonly arguments?: { readonly query?: string } })?.arguments?.query ===
        "boom"
      ) {
        return new Response("down", { status: 503 });
      }
      return jsonResponse(body.id, { structuredContent: { tools: [{ name: "send_message" }] } });
    });
    const remoteResult = await connectMcpSession(config, {
      fetch: remote.fetchImpl,
      toolExposure: "deferred",
    });
    await expect(remoteResult.searchTools("boom")).resolves.toEqual([]);
    await expect(remoteResult.searchTools("send")).resolves.toEqual(["mcp__t3-code__send_message"]);
    expect(remoteResult.tools.map((tool) => tool.name)).toContain("mcp__t3-code__send_message");
  });

  it("does not search when the session is eager", async () => {
    const { fetchImpl, calls } = createFetch(sessionHandler());
    const result = await connectMcpSession(config, { fetch: fetchImpl });
    await expect(result.searchTools("thread")).resolves.toEqual([]);
    expect(calls.some((call) => call.body.method === "tools/call")).toBe(false);
  });

  it("calls a remote tool and extracts text, image, and structured content", async () => {
    const { fetchImpl, calls } = createFetch(sessionHandler());
    const result = await connectMcpSession(config, { fetch: fetchImpl });
    const tool = result.tools[0];
    if (tool === undefined) throw new Error("expected the MCP tool to be exposed");

    const called = await tool.execute("call-1", { path: "src/index.ts" });
    const call = calls.at(-1);
    expect(call?.body.method).toBe("tools/call");
    expect(call?.body.params).toEqual({
      name: "list_threads",
      arguments: { path: "src/index.ts" },
    });
    expect(called.content).toEqual([
      { type: "text", text: "called" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ]);
    expect(called.structuredContent).toEqual({ ok: true });
    expect(called.isError).toBeUndefined();
    expect(called.details).toMatchObject({
      server: "t3-code",
      mcpToolName: "list_threads",
      readOnlyHint: true,
    });
  });

  it("parses server-sent event responses", async () => {
    const { fetchImpl } = createFetch((body) => {
      if (body.method === "initialize") return jsonResponse(body.id, {});
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return sseResponse(body.id, { tools: [TOOLS[0]] });
    });
    const result = await connectMcpSession(config, { fetch: fetchImpl });
    expect(result.available).toBe(true);
    expect(result.tools).toHaveLength(1);
  });

  it("reports an error result instead of throwing", async () => {
    const { fetchImpl } = createFetch((body) => {
      if (body.method === "initialize") return jsonResponse(body.id, {});
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { message: "boom" } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const result = await connectMcpSession(config, { fetch: fetchImpl });
    expect(result.available).toBe(false);
    expect(result.tools).toEqual([]);
    expect(result.metadata.size).toBe(0);
    expect(result.error).toContain("boom");
  });

  it("reports HTTP failures instead of throwing", async () => {
    const { fetchImpl } = createFetch(() => new Response("nope", { status: 503 }));
    const result = await connectMcpSession(config, { fetch: fetchImpl });
    expect(result.available).toBe(false);
    expect(result.error).toContain("503");
  });

  it("reports unreachable servers instead of throwing", async () => {
    const fetchImpl: typeof globalThis.fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const result = await connectMcpSession(config, { fetch: fetchImpl });
    expect(result.available).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("reports malformed JSON instead of throwing", async () => {
    const { fetchImpl } = createFetch(
      () =>
        new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const result = await connectMcpSession(config, { fetch: fetchImpl });
    expect(result.available).toBe(false);
    expect(result.tools).toEqual([]);
  });

  it("stops waiting when a request exceeds the timeout", async () => {
    const fetchImpl: typeof globalThis.fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("request aborted"));
        });
      });
    const result = await connectMcpSession(config, { fetch: fetchImpl, timeoutMs: 5 });
    expect(result.available).toBe(false);
    expect(result.error).toContain("aborted");
  });

  it("marks MCP tool failures as errors when the transport rejects", async () => {
    const { fetchImpl } = createFetch((body) => {
      if (body.method === "initialize") return jsonResponse(body.id, {});
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") return jsonResponse(body.id, { tools: [TOOLS[0]] });
      return new Response("exploded", { status: 500 });
    });
    const result = await connectMcpSession(config, { fetch: fetchImpl });
    const tool = result.tools[0];
    if (tool === undefined) throw new Error("expected the MCP tool to be exposed");
    await expect(tool.execute("call-2", {})).rejects.toThrow("500");
  });
});
