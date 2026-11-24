import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { assert, describe, it } from "@effect/vitest";

import {
  analyzeProviderFailure,
  classifyProviderFailure,
  createProviderRetryStreamFn,
  readRetryAfterMs,
  TRANSIENT_BACKOFF_MS,
  type ProviderRetryLifecycleEvent,
  type ProviderRetryOptions,
} from "./providerRetry.ts";

const MODEL: Model<Api> = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  reasoning: true,
  contextWindow: 272_000,
  maxTokens: 128_000,
};

const CONTEXT = { messages: [] } as unknown as TranscriptContext;

function usage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistantMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: usage(),
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

function startEvent(): AssistantMessageEvent {
  return { type: "start", partial: assistantMessage({ stopReason: "pending" }) };
}

function textDelta(delta: string): AssistantMessageEvent {
  return {
    type: "text_delta",
    contentIndex: 0,
    delta,
    partial: assistantMessage({ content: [{ type: "text", text: delta }] }),
  };
}

function doneEvent(): AssistantMessageEvent {
  return {
    type: "done",
    reason: "stop",
    message: assistantMessage({ content: [{ type: "text", text: "ok" }] }),
  };
}

function errorEvent(input: {
  readonly message: string;
  readonly stopReason?: "error" | "aborted";
}): AssistantMessageEvent {
  return {
    type: "error",
    reason: input.stopReason ?? "error",
    error: assistantMessage({
      stopReason: input.stopReason ?? "error",
      errorMessage: input.message,
    }),
  };
}

function streamOf(events: readonly AssistantMessageEvent[]): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  for (const event of events) stream.push(event);
  return stream;
}

interface RecordedCall {
  readonly options: SimpleStreamOptions | undefined;
}

type Step = (options: SimpleStreamOptions | undefined) => AssistantMessageEventStream;

function scripted(steps: readonly Step[]): { fn: StreamFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn: StreamFn = (_model, _context, options) => {
    calls.push({ options });
    const index = Math.min(calls.length - 1, steps.length - 1);
    const step = steps[index];
    if (step === undefined) throw new Error("scripted stream ran out of steps");
    return step(options);
  };
  return { fn, calls };
}

function failStep(input: {
  readonly message: string;
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly stopReason?: "error" | "aborted";
  readonly partialText?: string;
}): Step {
  return (options) => {
    if (input.status !== undefined) {
      void options?.onResponse?.({ status: input.status, headers: input.headers ?? {} }, MODEL);
    }
    const events: AssistantMessageEvent[] = [];
    if (input.partialText !== undefined) {
      events.push(startEvent(), textDelta(input.partialText));
    }
    events.push(
      errorEvent({
        message: input.message,
        ...(input.stopReason === undefined ? {} : { stopReason: input.stopReason }),
      }),
    );
    return streamOf(events);
  };
}

function successStep(): Step {
  return () => streamOf([startEvent(), textDelta("ok"), doneEvent()]);
}

function throwingStep(message: string, status?: number): Step {
  return () => {
    const error = new Error(message) as Error & { status?: number };
    if (status !== undefined) error.status = status;
    throw error;
  };
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

interface Harness {
  readonly retryEvents: ProviderRetryLifecycleEvent[];
  readonly sleeps: number[];
  readonly poolResets: () => number;
  readonly options: ProviderRetryOptions;
}

function harness(overrides: Partial<ProviderRetryOptions> = {}): Harness {
  const retryEvents: ProviderRetryLifecycleEvent[] = [];
  const sleeps: number[] = [];
  let poolResets = 0;
  return {
    retryEvents,
    sleeps,
    poolResets: () => poolResets,
    options: {
      now: () => 1_000,
      random: () => 0,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      scheduleTimer: () => () => undefined,
      onRetryEvent: (event) => retryEvents.push(event),
      onConnectionPoolReset: () => {
        poolResets += 1;
      },
      ...overrides,
    },
  };
}

describe("classifyProviderFailure", () => {
  it("maps rate limits and quota exhaustion to usage limits", () => {
    const rate = analyzeProviderFailure(
      { status: 429, headers: { "retry-after": "4" }, message: "Rate limit reached" },
      1_000,
    );
    assert.equal(rate.category, "rate_limit");
    assert.equal(rate.failure.class, "usage_limit");
    assert.equal(rate.failure.retryable, true);
    assert.equal(rate.retryAfterMs, 4_000);
    assert.equal(rate.failure.resetAt, "1970-01-01T00:00:05.000Z");

    const exhausted = classifyProviderFailure({
      status: 429,
      message: "You exceeded your current quota: insufficient_quota",
    });
    assert.equal(exhausted.class, "usage_limit");
    assert.equal(exhausted.retryable, false);
    assert.isUndefined(exhausted.resetAt);
  });

  it("maps terminal HTTP failures without retrying", () => {
    assert.equal(classifyProviderFailure({ status: 401 }).class, "permission_error");
    assert.equal(classifyProviderFailure({ status: 403 }).retryable, false);
    assert.equal(classifyProviderFailure({ status: 404 }).class, "provider_error");
    assert.equal(classifyProviderFailure({ status: 400 }).class, "validation_error");
  });

  it("marks 5xx and transport failures as retryable", () => {
    const server = classifyProviderFailure({ status: 503 });
    assert.equal(server.class, "transport_error");
    assert.equal(server.retryable, true);

    assert.equal(classifyProviderFailure({ message: "socket hang up" }).class, "transport_error");
    assert.equal(classifyProviderFailure({ message: "fetch failed" }).class, "transport_error");
    assert.equal(classifyProviderFailure({ message: "ECONNRESET" }).class, "transport_error");
  });

  it("classifies context overflow so the session runtime can compact instead", () => {
    const analysis = analyzeProviderFailure({
      status: 400,
      message: "prompt is too long: 200000 tokens > 128000 maximum",
    });
    assert.equal(analysis.category, "context_overflow");
    assert.equal(analysis.failure.retryable, false);
  });

  it("reads provider reset headers in every supported format", () => {
    assert.equal(readRetryAfterMs({ "retry-after-ms": "250" }), 250);
    assert.equal(readRetryAfterMs({ "Retry-After": "2" }), 2_000);
    assert.equal(readRetryAfterMs({ "retry-after": "1.5s" }), 1_500);
    assert.equal(readRetryAfterMs({ "x-ratelimit-reset-requests": "1m30s" }), 90_000);
    assert.equal(readRetryAfterMs({ "x-ratelimit-reset-tokens": "6m0s" }), 360_000);
    assert.isNull(readRetryAfterMs({}));
    assert.isNull(readRetryAfterMs(undefined));
  });
});

describe("createProviderRetryStreamFn", () => {
  it("returns the first successful attempt without retry events", async () => {
    const fake = scripted([successStep()]);
    const test = harness();
    const streamFn = createProviderRetryStreamFn(fake.fn, test.options);

    const events = await collect(await streamFn(MODEL, CONTEXT, undefined));

    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "text_delta", "done"],
    );
    assert.deepEqual(test.retryEvents, []);
    assert.deepEqual(test.sleeps, []);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]?.options?.maxRetries, 0);
  });

  it("waits for the provider's retry-after before retrying a 429", async () => {
    const fake = scripted([
      failStep({
        status: 429,
        headers: { "retry-after": "3" },
        message: "Rate limit reached",
      }),
      successStep(),
    ]);
    const test = harness();
    const streamFn = createProviderRetryStreamFn(fake.fn, test.options);

    const events = await collect(await streamFn(MODEL, CONTEXT, undefined));

    assert.deepEqual(test.sleeps, [3_000]);
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(
      test.retryEvents.map((event) => ({
        status: event.status,
        attempt: event.attempt,
        delayMs: event.delayMs,
        failureClass: event.failure.class,
      })),
      [
        { status: "running", attempt: 1, delayMs: 3_000, failureClass: "usage_limit" },
        { status: "completed", attempt: 1, delayMs: null, failureClass: "usage_limit" },
      ],
    );
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(test.retryEvents[0]?.failure.resetAt, "1970-01-01T00:00:04.000Z");
  });

  it("stops immediately on billing exhaustion", async () => {
    const fake = scripted([
      failStep({
        status: 429,
        message: "You exceeded your current quota: insufficient_quota",
      }),
    ]);
    const test = harness();
    const streamFn = createProviderRetryStreamFn(fake.fn, test.options);

    const events = await collect(await streamFn(MODEL, CONTEXT, undefined));

    assert.deepEqual(test.sleeps, []);
    assert.equal(fake.calls.length, 1);
    assert.equal(test.retryEvents.at(-1)?.status, "failed");
    assert.equal(test.retryEvents.at(-1)?.failure.class, "usage_limit");
    assert.equal(events.at(-1)?.type, "error");
  });

  it("leaves context overflow to the session runtime instead of retrying", async () => {
    const fake = scripted([
      failStep({
        status: 400,
        message: "prompt is too long: 200000 tokens > 128000 maximum",
      }),
      successStep(),
    ]);
    const test = harness();
    const streamFn = createProviderRetryStreamFn(fake.fn, test.options);

    const events = await collect(await streamFn(MODEL, CONTEXT, undefined));

    assert.equal(fake.calls.length, 1);
    assert.deepEqual(test.sleeps, []);
    assert.equal(test.retryEvents.at(-1)?.status, "failed");
    assert.equal(test.retryEvents.at(-1)?.failure.class, "validation_error");
    assert.equal(events.at(-1)?.type, "error");
  });

  it("backs off on the deterministic transient schedule", async () => {
    const fake = scripted([
      throwingStep("socket hang up"),
      throwingStep("socket hang up"),
      throwingStep("socket hang up"),
      throwingStep("socket hang up"),
      throwingStep("socket hang up"),
    ]);
    const test = harness({ maxTransientRetries: 4 });
    const streamFn = createProviderRetryStreamFn(fake.fn, test.options);

    const events = await collect(await streamFn(MODEL, CONTEXT, undefined));

    assert.deepEqual(test.sleeps, [...TRANSIENT_BACKOFF_MS]);
    assert.equal(fake.calls.length, 5);
    assert.equal(test.poolResets(), 2);
    assert.deepEqual(
      test.retryEvents.map((event) => event.status),
      ["running", "running", "running", "running", "failed"],
    );
    assert.equal(test.retryEvents.at(-1)?.failure.class, "transport_error");
    assert.equal(test.retryEvents.at(-1)?.maxAttempts, 4);
    assert.equal(events.at(-1)?.type, "error");
  });

  it("honours the transient budget", async () => {
    const fake = scripted([
      throwingStep("fetch failed"),
      throwingStep("fetch failed"),
      successStep(),
    ]);
    const test = harness({ maxTransientRetries: 1 });
    const streamFn = createProviderRetryStreamFn(fake.fn, test.options);

    const events = await collect(await streamFn(MODEL, CONTEXT, undefined));

    assert.deepEqual(test.sleeps, [1_000]);
    assert.equal(fake.calls.length, 2);
    assert.equal(test.retryEvents.at(-1)?.status, "failed");
    assert.equal(test.retryEvents.at(-1)?.maxAttempts, 1);
    assert.equal(events.at(-1)?.type, "error");
  });

  it("keeps retrying when infinite retry is on", async () => {
    const fake = scripted([
      failStep({ status: 503, message: "overloaded" }),
      failStep({ status: 503, message: "overloaded" }),
      successStep(),
    ]);
    const test = harness({ infiniteRetry: true, maxTransientRetries: 1 });
    const streamFn = createProviderRetryStreamFn(fake.fn, test.options);

    await collect(await streamFn(MODEL, CONTEXT, undefined));

    assert.equal(fake.calls.length, 3);
    const running = test.retryEvents.filter((event) => event.status === "running");
    assert.equal(running.length, 2);
    assert.isNull(running[0]?.maxAttempts ?? null);
  });

  it("relays a single start when a started attempt is replaced", async () => {
    const fake = scripted([
      () => streamOf([startEvent(), errorEvent({ message: "socket hang up" })]),
      successStep(),
    ]);
    const test = harness({ maxTransientRetries: 1 });
    const streamFn = createProviderRetryStreamFn(fake.fn, test.options);

    const events = await collect(await streamFn(MODEL, CONTEXT, undefined));

    assert.equal(fake.calls.length, 2);
    assert.equal(events.filter((event) => event.type === "start").length, 1);
    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "text_delta", "done"],
    );
    assert.deepEqual(test.sleeps, [1_000]);
  });

  it("never restarts an attempt that already streamed output", async () => {
    const fake = scripted([
      failStep({ status: 500, message: "internal error", partialText: "partial answer" }),
      successStep(),
    ]);
    const test = harness();
    const streamFn = createProviderRetryStreamFn(fake.fn, test.options);

    const events = await collect(await streamFn(MODEL, CONTEXT, undefined));

    assert.equal(fake.calls.length, 1);
    assert.deepEqual(test.sleeps, []);
    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "text_delta", "error"],
    );
    assert.equal(test.retryEvents.at(-1)?.status, "failed");
  });

  it("clamps a rejected max_tokens once without spending a retry budget", async () => {
    const fake = scripted([
      failStep({
        status: 400,
        message: "max_tokens: 20000 is greater than the maximum allowed value",
      }),
      successStep(),
    ]);
    const test = harness();
    const streamFn = createProviderRetryStreamFn(fake.fn, test.options);

    const events = await collect(await streamFn(MODEL, CONTEXT, { maxTokens: 32_000 }));

    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[0]?.options?.maxTokens, 32_000);
    assert.equal(fake.calls[1]?.options?.maxTokens, 20_000);
    assert.deepEqual(test.sleeps, []);
    assert.equal(events.at(-1)?.type, "done");
  });

  it("terminates on the second max_tokens rejection instead of looping", async () => {
    const fake = scripted([
      failStep({ status: 400, message: "max_output_tokens exceeds the maximum" }),
      failStep({ status: 400, message: "max_output_tokens exceeds the maximum" }),
      successStep(),
    ]);
    const test = harness();
    const streamFn = createProviderRetryStreamFn(fake.fn, test.options);

    const events = await collect(await streamFn(MODEL, CONTEXT, undefined));

    assert.equal(fake.calls.length, 2);
    assert.deepEqual(test.sleeps, []);
    assert.equal(events.at(-1)?.type, "error");
    assert.equal(test.retryEvents.at(-1)?.failure.class, "validation_error");
  });

  it("maps caller aborts to a terminal aborted message", async () => {
    const fake = scripted([successStep()]);
    const test = harness();
    const streamFn = createProviderRetryStreamFn(fake.fn, test.options);
    const controller = new AbortController();
    controller.abort();

    const events = await collect(await streamFn(MODEL, CONTEXT, { signal: controller.signal }));

    assert.equal(fake.calls.length, 0);
    assert.deepEqual(test.sleeps, []);
    assert.equal(events.at(-1)?.type, "error");
    const error = events.at(-1);
    assert.equal(error?.type === "error" ? error.error.stopReason : undefined, "aborted");
    assert.equal(test.retryEvents.at(-1)?.status, "aborted");
  });

  it("stops waiting when the caller aborts during backoff", async () => {
    const fake = scripted([throwingStep("ECONNRESET"), successStep()]);
    const controller = new AbortController();
    const test = harness({
      sleep: async (ms: number) => {
        test.sleeps.push(ms);
        controller.abort();
      },
    });
    const streamFn = createProviderRetryStreamFn(fake.fn, test.options);

    const events = await collect(await streamFn(MODEL, CONTEXT, { signal: controller.signal }));

    assert.equal(fake.calls.length, 1);
    assert.deepEqual(test.sleeps, [1_000]);
    assert.equal(events.at(-1)?.type, "error");
    assert.equal(test.retryEvents.at(-1)?.status, "aborted");
  });

  it("retries an idle stream through the transient budget", async () => {
    const timers: Array<{ readonly ms: number; readonly fire: () => void; cancelled: boolean }> =
      [];
    let cancelled = 0;
    const idleStep: Step = () => {
      const stream = createAssistantMessageEventStream();
      stream.push(startEvent());
      // Fire the watchdog the wrapper armed before calling this step.
      timers.at(-1)?.fire();
      stream.push(errorEvent({ message: "aborted", stopReason: "aborted" }));
      return stream;
    };
    const fake = scripted([idleStep, successStep()]);
    const test = harness({
      idleTimeoutMs: 123_456,
      scheduleTimer: (ms, callback) => {
        const entry = { ms, fire: callback, cancelled: false };
        timers.push(entry);
        return () => {
          if (entry.cancelled) return;
          entry.cancelled = true;
          cancelled += 1;
        };
      },
    });
    const streamFn = createProviderRetryStreamFn(fake.fn, test.options);

    const events = await collect(await streamFn(MODEL, CONTEXT, undefined));

    assert.equal(fake.calls.length, 2);
    assert.deepEqual(test.sleeps, [1_000]);
    assert.equal(timers[0]?.ms, 123_456);
    assert.isAtLeast(cancelled, 1);
    assert.equal(test.retryEvents[0]?.status, "running");
    assert.equal(test.retryEvents[0]?.failure.class, "transport_error");
    assert.equal(events.at(-1)?.type, "done");
  });
});
