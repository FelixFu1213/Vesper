// @effect-diagnostics globalDate:off -- Scripted turns carry the timestamp the caller injected.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  JsonObject,
  Model,
  StopReason,
  TranscriptContext,
  Usage,
} from "@earendil-works/pi-ai";

export { makePiNativeAdapterV2 } from "./server/adapter.ts";
export { PI_NATIVE_DRIVER_KIND } from "./server/status.ts";
export type { PiNativeAdapterV2Options, PiNativeAdapterV2DriverEnv } from "./server/adapter.ts";

export interface ScriptedToolCall {
  readonly name: string;
  readonly arguments: JsonObject;
  readonly id?: string;
}

export interface ScriptedTurn {
  readonly text?: string;
  readonly reasoning?: string;
  readonly toolCalls?: ReadonlyArray<ScriptedToolCall>;
  readonly error?: { readonly message: string; readonly stopReason?: "error" | "aborted" };
  readonly stopReason?: StopReason;
  readonly usage?: Partial<Usage>;
}

export interface ScriptedCall {
  readonly index: number;
  readonly model: Model<Api>;
  readonly context: TranscriptContext;
}

export type ScriptedStep =
  | ScriptedTurn
  | ((call: ScriptedCall) => ScriptedTurn | Promise<ScriptedTurn>);

export type ScriptedStreamFn = ((
  model: Model<Api>,
  context: TranscriptContext,
  options?: unknown,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>) & {
  readonly calls: ScriptedCall[];
};

export const scriptedTextResponse = (
  text: string,
  options: Omit<ScriptedTurn, "text"> = {},
): ScriptedTurn => ({
  ...options,
  text,
});

export const scriptedToolCallResponse = (
  toolCalls: ReadonlyArray<ScriptedToolCall>,
  options: Omit<ScriptedTurn, "toolCalls"> = {},
): ScriptedTurn => ({ ...options, toolCalls, stopReason: options.stopReason ?? "toolUse" });

export const scriptedErrorResponse = (
  message: string,
  options: Omit<ScriptedTurn, "error"> & { readonly stopReason?: "error" | "aborted" } = {},
): ScriptedTurn => ({
  ...options,
  error: { message, stopReason: options.stopReason ?? "error" },
});

const baseUsage = (override: Partial<Usage> | undefined): Usage => {
  const usage: Usage = {
    input: 1_000,
    output: 100,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1_100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...override,
  };
  return {
    ...usage,
    totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, ...override?.cost },
  };
};

/** Renders one scripted turn as the event protocol a provider would emit. */
export function renderScriptedTurn(
  model: Model<Api>,
  turn: ScriptedTurn,
  timestamp: number,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  pushScriptedTurn(stream, model, turn, timestamp);
  return stream;
}

/** Pushes one scripted turn into a stream the test already handed to the runtime. */
export function pushScriptedTurn(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  turn: ScriptedTurn,
  timestamp: number,
): void {
  const content: AssistantMessage["content"] = [];
  const partial = (): AssistantMessage => ({
    role: "assistant",
    content: [...content],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: baseUsage(turn.usage),
    stopReason: "stop",
    timestamp,
  });

  if (turn.error !== undefined) {
    const reason = turn.error.stopReason ?? "error";
    stream.push({
      type: "error",
      reason,
      error: {
        ...partial(),
        stopReason: reason,
        errorMessage: turn.error.message,
      },
    });
    return;
  }

  stream.push({ type: "start", partial: partial() });
  if (turn.reasoning !== undefined && turn.reasoning !== "") {
    stream.push({ type: "thinking_start", contentIndex: content.length, partial: partial() });
    content.push({ type: "thinking", thinking: turn.reasoning });
    stream.push({
      type: "thinking_delta",
      contentIndex: 0,
      delta: turn.reasoning,
      partial: partial(),
    });
    stream.push({
      type: "thinking_end",
      contentIndex: 0,
      content: turn.reasoning,
      partial: partial(),
    });
  }
  if (turn.text !== undefined && turn.text !== "") {
    const index = content.length;
    stream.push({ type: "text_start", contentIndex: index, partial: partial() });
    content.push({ type: "text", text: turn.text });
    stream.push({ type: "text_delta", contentIndex: index, delta: turn.text, partial: partial() });
    stream.push({
      type: "text_end",
      contentIndex: index,
      content: turn.text,
      partial: partial(),
    });
  }
  for (const [offset, call] of (turn.toolCalls ?? []).entries()) {
    const index = content.length;
    stream.push({ type: "toolcall_start", contentIndex: index, partial: partial() });
    const toolCall = {
      type: "toolCall" as const,
      id: call.id ?? `call-${offset + 1}`,
      name: call.name,
      arguments: call.arguments,
    };
    content.push(toolCall);
    stream.push({
      type: "toolcall_end",
      contentIndex: index,
      toolCall,
      partial: partial(),
    });
  }

  const message: AssistantMessage = {
    ...partial(),
    stopReason: turn.stopReason ?? (turn.toolCalls === undefined ? "stop" : "toolUse"),
  };
  stream.push({
    type: "done",
    reason:
      message.stopReason === "length" ||
      message.stopReason === "toolUse" ||
      message.stopReason === "deferred"
        ? message.stopReason
        : "stop",
    message,
  });
}

const noMoreResponses = (): ScriptedTurn => ({
  error: { message: "The scripted provider has no more responses." },
});

/**
 * A deterministic provider stream: each assistant request consumes the next scripted
 * turn, and every request it served is kept in `calls` for assertions.
 */
export function createScriptedStreamFn(
  steps: ReadonlyArray<ScriptedStep>,
  options: { readonly now?: () => number } = {},
): ScriptedStreamFn {
  const now = options.now ?? (() => 0);
  const calls: ScriptedCall[] = [];
  let index = 0;
  const stream = async (
    model: Model<Api>,
    context: TranscriptContext,
  ): Promise<AssistantMessageEventStream> => {
    const callIndex = index++;
    const call: ScriptedCall = { index: callIndex, model, context };
    calls.push(call);
    const step = steps[callIndex];
    const turn =
      step === undefined ? noMoreResponses() : typeof step === "function" ? await step(call) : step;
    return renderScriptedTurn(model, turn, now());
  };
  return Object.assign(stream as ScriptedStreamFn, { calls });
}
