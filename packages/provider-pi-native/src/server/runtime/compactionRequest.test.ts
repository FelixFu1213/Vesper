import type { Api, Model } from "@earendil-works/pi-ai";
import { assert, describe, it } from "@effect/vitest";

import {
  compactionRequestOptions,
  SUMMARY_CONVERSATION_APIS,
  withSummaryPromptCacheKey,
} from "./compactionRequest.ts";

const modelFor = (api: string): Pick<Model<Api>, "api"> => ({ api: api as Api });

describe("compactionRequestOptions", () => {
  it("carries the session id and never continues the conversation thread", () => {
    const options = compactionRequestOptions({
      sessionId: "session-1",
      model: modelFor("anthropic-messages"),
    });

    assert.equal(options.sessionId, "session-1");
    assert.isTrue(options.disableContinuation);
    assert.equal(options.maxRetries, 0);
  });

  it("keeps the caller's own options", () => {
    const options = compactionRequestOptions({
      sessionId: "session-1",
      model: modelFor("openai-completions"),
      options: { maxRetries: 3, cacheRetention: "none" },
    });

    assert.equal(options.maxRetries, 0);
    assert.equal(options.cacheRetention, "none");
    assert.isUndefined(options.onPayload);
  });

  it("restores the conversation key a Responses summary would otherwise lose", async () => {
    const options = compactionRequestOptions({
      sessionId: "session-1",
      model: modelFor("openai-responses"),
    });

    const payload = await options.onPayload?.(
      { model: "gpt-5.4" },
      modelFor("openai-responses") as Model<Api>,
    );
    assert.deepEqual(payload, { model: "gpt-5.4", prompt_cache_key: "session-1" });
  });

  it("leaves a payload that already carries a key alone", async () => {
    const existing = { prompt_cache_key: "adapter-key" };
    const options = compactionRequestOptions({
      sessionId: "session-1",
      model: modelFor("openai-responses"),
      options: { onPayload: () => existing },
    });

    assert.equal(
      await options.onPayload?.({}, modelFor("openai-responses") as Model<Api>),
      existing,
    );
  });
});

describe("withSummaryPromptCacheKey", () => {
  it("only keys the two Responses-shaped conversation APIs", () => {
    assert.deepEqual([...SUMMARY_CONVERSATION_APIS].sort(), [
      "openai-codex-responses",
      "openai-responses",
    ]);

    const unkeyed = { model: "claude" };
    assert.equal(
      withSummaryPromptCacheKey({ payload: unkeyed, api: "anthropic-messages", sessionId: "s" }),
      unkeyed,
    );
  });

  it("ignores a payload that is not a request body", () => {
    assert.isNull(
      withSummaryPromptCacheKey({ payload: null, api: "openai-responses", sessionId: "s" }),
    );
    assert.equal(
      withSummaryPromptCacheKey({ payload: "body", api: "openai-responses", sessionId: "s" }),
      "body",
    );
  });
});
