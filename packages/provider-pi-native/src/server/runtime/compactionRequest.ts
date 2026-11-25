import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";

/**
 * The summary request is issued outside the turn's `prepareRequest` path, so it
 * carries the session's own provider headers and session id explicitly. It must
 * not continue or replace the conversation's server-side thread, so continuation
 * is disabled for it.
 */
export interface CompactionRequestInput {
  readonly sessionId: string;
  readonly model: Pick<Model<Api>, "api">;
  readonly options?: SimpleStreamOptions | undefined;
}

/**
 * The two wire APIs that key a conversation by `prompt_cache_key`. The Responses
 * adapters attach it only while the caller keeps some cache retention, and a
 * summary asks for none, so it restores the conversation identity by hand.
 */
export const SUMMARY_CONVERSATION_APIS: ReadonlySet<string> = new Set([
  "openai-responses",
  "openai-codex-responses",
]);

/**
 * Restore the conversation key on a summary payload. Only an absent key is added,
 * so an adapter that already sent one — or a caller's `onPayload` that returned its
 * own object — is left byte-identical.
 */
export function withSummaryPromptCacheKey(input: {
  readonly payload: unknown;
  readonly api: string;
  readonly sessionId: string;
}): unknown {
  if (!SUMMARY_CONVERSATION_APIS.has(input.api)) return input.payload;
  if (typeof input.payload !== "object" || input.payload === null) return input.payload;
  if (Array.isArray(input.payload)) return input.payload;
  const body = input.payload as Record<string, unknown>;
  if (body.prompt_cache_key !== undefined && body.prompt_cache_key !== null) {
    return input.payload;
  }
  const key = clampOpenAIPromptCacheKey(input.sessionId);
  if (key === undefined || key === "") return input.payload;
  return { ...body, prompt_cache_key: key };
}

/** Request options for the compaction summary call. */
export function compactionRequestOptions(input: CompactionRequestInput): SimpleStreamOptions {
  const { options } = input;
  const keyed = !SUMMARY_CONVERSATION_APIS.has(input.model.api)
    ? undefined
    : async (payload: unknown, requestModel: Model<Api>) => {
        const replacement = await options?.onPayload?.(payload, requestModel);
        const base = replacement === undefined ? payload : replacement;
        const next = withSummaryPromptCacheKey({
          payload: base,
          api: requestModel.api,
          sessionId: input.sessionId,
        });
        return next === base ? replacement : next;
      };
  return {
    ...options,
    maxRetries: 0,
    sessionId: input.sessionId,
    disableContinuation: true,
    ...(keyed === undefined ? {} : { onPayload: keyed }),
  };
}
