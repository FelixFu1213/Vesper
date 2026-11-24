import { createAssistantMessageEventStream, isContextOverflow } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  ProviderResponse,
  SimpleStreamOptions,
  StopReason,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderFailureClass,
} from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";

const MAX_RATE_LIMIT_RETRIES = 10;
const MAX_TRANSIENT_RETRIES = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 180_000;
/** Each consecutive transport failure waits on the next rung, capped at the last one. */
export const TRANSIENT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];
const RATE_LIMIT_BASE_DELAY_MS = 2_000;
const RATE_LIMIT_MAX_DELAY_MS = 30_000;
const RATE_LIMIT_JITTER = 0.25;
/** Two consecutive transport failures are enough evidence of a wedged connection pool. */
const CONNECTION_FAILURES_BEFORE_RESET = 2;
const IDLE_TIMEOUT_MARKER = "pi-native-idle-timeout";

// The Effect diagnostics reject global `Date`/timers, so the defaults go through this seam.
const host = globalThis as unknown as {
  readonly Date: { now: () => number; parse: (value: string) => number };
  readonly Math: { random: () => number };
  readonly setTimeout: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
};

export type ProviderFailureCategory =
  | "aborted"
  | "rate_limit"
  | "usage_limit"
  | "authentication"
  | "model_unavailable"
  | "invalid_request"
  | "context_overflow"
  | "request_too_large"
  | "transient"
  | "unknown";

export interface ProviderFailureInput {
  readonly status?: number | null;
  readonly headers?: Readonly<Record<string, string>> | null;
  readonly message?: string | null;
  readonly aborted?: boolean;
  readonly contextOverflow?: boolean;
}

const BILLING_EXHAUSTION =
  /insufficient_quota|billing_hard_limit|credit balance is too low|exceeded your current quota|out of credits|spending limit/iu;

const CONTEXT_OVERFLOW_MESSAGE =
  /context (?:length|window)|maximum context|prompt is too long|too many tokens|exceeds (?:the )?model'?s? maximum|input token count exceeds|reduce the length of the messages|available context size|request_too_large/iu;

const TRANSPORT_FAILURE_MESSAGE =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_[A-Z_]+|STREAM_FAILED|fetch failed|socket hang up|network error|other side closed|connection (?:reset|refused|closed)/iu;

const OVERLOADED_MESSAGE = /overloaded|server is busy|temporarily unavailable|try again later/iu;

const TIMEOUT_MESSAGE = /\bETIMEDOUT\b|\btimed? ?out\b/iu;

const MAX_TOKENS_REJECTION =
  /(max_tokens|max_completion_tokens|max_output_tokens|maximum output tokens)/iu;
const MAX_TOKENS_LIMIT_HINT = /exceed|too (?:large|long|many)|greater than|maximum|allowed|limit/iu;
const MAX_TOKENS_VALUE =
  /(?:max_tokens|max_completion_tokens|max_output_tokens)[^\d]{0,48}(\d{1,9})/iu;

const TRANSIENT_STATUSES = new Set([500, 502, 503, 504, 529]);

const NUMERIC_HEADER = /^\s*(\d+(?:\.\d+)?)(ms|s|m|h)?\s*$/iu;
const DURATION_PART = /(\d+(?:\.\d+)?)(ms|s|m|h)/giu;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

function lowerCaseHeaders(
  headers: Readonly<Record<string, string>> | null | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (headers == null) return normalized;
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = value;
  }
  return normalized;
}

function parseDurationMs(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const simple = NUMERIC_HEADER.exec(trimmed);
  if (simple !== null) {
    const amount = Number(simple[1]);
    const unit = (simple[2] ?? "s").toLowerCase();
    return Number.isFinite(amount) ? Math.round(amount * (UNIT_MS[unit] ?? 1_000)) : null;
  }
  let total = 0;
  let matched = false;
  for (const part of trimmed.matchAll(DURATION_PART)) {
    matched = true;
    total += Number(part[1]) * (UNIT_MS[(part[2] ?? "s").toLowerCase()] ?? 1_000);
  }
  return matched && Number.isFinite(total) ? Math.round(total) : null;
}

/** The delay a provider asked for, if it sent one; used for both the wait and `resetAt`. */
export function readRetryAfterMs(
  headers: Readonly<Record<string, string>> | null | undefined,
  nowMs?: number,
): number | null {
  const normalized = lowerCaseHeaders(headers);
  const retryAfterMs = normalized["retry-after-ms"];
  if (retryAfterMs !== undefined) {
    // This header is always milliseconds, with or without a unit.
    const bare = Number(retryAfterMs.trim());
    if (Number.isFinite(bare) && bare >= 0) return Math.round(bare);
    const parsed = parseDurationMs(retryAfterMs);
    if (parsed !== null && parsed >= 0) return parsed;
  }
  const retryAfter = normalized["retry-after"];
  if (retryAfter !== undefined) {
    const parsed = parseDurationMs(retryAfter);
    if (parsed !== null && parsed >= 0) return parsed;
    const timestamp = host.Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - (nowMs ?? host.Date.now()));
  }
  for (const name of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
    const value = normalized[name];
    if (value === undefined) continue;
    const parsed = parseDurationMs(value);
    if (parsed !== null && parsed >= 0) return parsed;
  }
  return null;
}

function rateLimitDelayMs(attempt: number, random: () => number): number {
  const base = Math.min(RATE_LIMIT_MAX_DELAY_MS, RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1));
  return Math.round(base * (1 + random() * RATE_LIMIT_JITTER));
}

function transientDelayMs(consecutiveFailures: number): number {
  const index = Math.min(Math.max(0, consecutiveFailures - 1), TRANSIENT_BACKOFF_MS.length - 1);
  return TRANSIENT_BACKOFF_MS[index] ?? 8_000;
}

function failureClassFor(category: ProviderFailureCategory): OrchestrationV2ProviderFailureClass {
  switch (category) {
    case "rate_limit":
    case "usage_limit":
      return "usage_limit";
    case "authentication":
      return "permission_error";
    case "invalid_request":
    case "context_overflow":
    case "request_too_large":
      return "validation_error";
    case "transient":
      return "transport_error";
    case "model_unavailable":
    case "aborted":
      return "provider_error";
    case "unknown":
      return "unknown";
  }
}

function isRetryableCategory(category: ProviderFailureCategory): boolean | null {
  switch (category) {
    case "rate_limit":
    case "transient":
      return true;
    case "usage_limit":
    case "authentication":
    case "model_unavailable":
    case "invalid_request":
    case "context_overflow":
    case "request_too_large":
    case "aborted":
      return false;
    case "unknown":
      return null;
  }
}

export interface ProviderFailureAnalysis {
  readonly category: ProviderFailureCategory;
  readonly failure: OrchestrationV2ProviderFailure;
  /** Delay the provider asked for, when it sent one. */
  readonly retryAfterMs: number | null;
}

export function analyzeProviderFailure(
  input: ProviderFailureInput,
  nowMs = 0,
): ProviderFailureAnalysis {
  const message = input.message ?? "";
  const status = input.status ?? null;
  const retryAfterMs = readRetryAfterMs(input.headers, nowMs);
  const category = classifyCategory(input, message, status);
  const resetAtMs = retryAfterMs === null ? null : nowMs + retryAfterMs;
  const failure = makeProviderFailure({
    ...(message === "" ? {} : { message }),
    code: status === null ? null : `http_${status}`,
    class: failureClassFor(category),
    retryable: isRetryableCategory(category),
    ...(resetAtMs === null ? {} : { resetAt: DateTime.formatIso(DateTime.makeUnsafe(resetAtMs)) }),
  });
  return { category, failure, retryAfterMs };
}

function classifyCategory(
  input: ProviderFailureInput,
  message: string,
  status: number | null,
): ProviderFailureCategory {
  if (input.aborted === true) return "aborted";
  if (input.contextOverflow === true) return "context_overflow";
  if (BILLING_EXHAUSTION.test(message)) return "usage_limit";
  if (status === 429) return "rate_limit";
  if (CONTEXT_OVERFLOW_MESSAGE.test(message)) return "context_overflow";
  if (status === 401 || status === 403) return "authentication";
  if (status === 404) return "model_unavailable";
  if (status === 413) return "request_too_large";
  if (status !== null && TRANSIENT_STATUSES.has(status)) return "transient";
  if (OVERLOADED_MESSAGE.test(message)) return "transient";
  if (TRANSPORT_FAILURE_MESSAGE.test(message)) return "transient";
  if (TIMEOUT_MESSAGE.test(message)) return "transient";
  if (status === 400 || status === 422) return "invalid_request";
  return "unknown";
}

export function classifyProviderFailure(
  input: ProviderFailureInput,
  nowMs = 0,
): OrchestrationV2ProviderFailure {
  return analyzeProviderFailure(input, nowMs).failure;
}

export type ProviderRetryLifecycleStatus = "running" | "completed" | "failed" | "aborted";

export interface ProviderRetryLifecycleEvent {
  readonly status: ProviderRetryLifecycleStatus;
  readonly attempt: number;
  readonly maxAttempts: number | null;
  readonly delayMs: number | null;
  readonly failure: OrchestrationV2ProviderFailure;
}

export type ProviderRetrySleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface ProviderRetryOptions {
  readonly infiniteRetry?: boolean;
  readonly idleTimeoutMs?: number;
  readonly maxRateLimitRetries?: number;
  readonly maxTransientRetries?: number;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: ProviderRetrySleep;
  readonly scheduleTimer?: (ms: number, callback: () => void) => () => void;
  readonly onRetryEvent?: (event: ProviderRetryLifecycleEvent) => void;
  readonly onConnectionPoolReset?: () => void;
}

const defaultSleep: ProviderRetrySleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (isAborted(signal)) {
      resolve();
      return;
    }
    const onAbort = () => {
      host.clearTimeout(handle);
      resolve();
    };
    const handle = host.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const defaultScheduleTimer = (ms: number, callback: () => void): (() => void) => {
  const handle = host.setTimeout(callback, ms);
  return () => host.clearTimeout(handle);
};

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function terminalMessage(input: {
  readonly model: Model<Api>;
  readonly timestamp: number;
  readonly stopReason: Extract<StopReason, "error" | "aborted">;
  readonly errorMessage: string;
}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: input.model.api,
    provider: input.model.provider,
    model: input.model.id,
    usage: emptyUsage(),
    stopReason: input.stopReason,
    errorMessage: input.errorMessage,
    timestamp: input.timestamp,
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isVisibleEvent(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case "start":
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
      return false;
    default:
      return true;
  }
}

function messageFromThrown(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "Provider request failed.";
}

function statusFromThrown(cause: unknown): number | null {
  if (typeof cause !== "object" || cause === null) return null;
  const status = Reflect.get(cause, "status");
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

function headersFromThrown(cause: unknown): Readonly<Record<string, string>> | null {
  if (typeof cause !== "object" || cause === null) return null;
  const headers = Reflect.get(cause, "headers");
  if (typeof headers !== "object" || headers === null) return null;
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === "string") normalized[name] = value;
  }
  return Object.keys(normalized).length === 0 ? null : normalized;
}

/**
 * A provider that rejects `max_tokens` rejects the same value on every attempt, so the
 * one clamped retry replaces the retry budgets instead of spending them.
 */
function clampRejectedMaxTokens(input: {
  readonly message: string;
  readonly status: number | null;
  readonly maxTokens: number;
}): number | null {
  if (input.status !== 400 && input.status !== 422) return null;
  if (!MAX_TOKENS_REJECTION.test(input.message) || !MAX_TOKENS_LIMIT_HINT.test(input.message)) {
    return null;
  }
  const extracted = Number(MAX_TOKENS_VALUE.exec(input.message)?.[1]);
  if (Number.isFinite(extracted) && extracted > 0 && extracted < input.maxTokens) {
    return Math.floor(extracted);
  }
  return Math.max(1_024, Math.min(Math.floor(input.maxTokens / 2), 8_192));
}

export interface ProviderRetryStateSnapshot {
  readonly rateLimitRetries: number;
  readonly transientRetries: number;
  readonly consecutiveTransientFailures: number;
}

/**
 * Wraps a provider stream with the two independent retry budgets and the idle watchdog.
 * Events are relayed as they arrive, so an attempt that already produced output is never
 * restarted; its failure ends the turn instead.
 */
export function createProviderRetryStreamFn(
  inner: StreamFn,
  options: ProviderRetryOptions = {},
): StreamFn {
  const environment: RunEnvironment = {
    now: options.now ?? (() => host.Date.now()),
    random: options.random ?? (() => host.Math.random()),
    sleep: options.sleep ?? defaultSleep,
    scheduleTimer: options.scheduleTimer ?? defaultScheduleTimer,
    idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    options,
  };
  return (model, context, streamOptions) => {
    const output = createAssistantMessageEventStream();
    const state: RetryState = {
      rateLimitBudget:
        options.infiniteRetry === true
          ? null
          : (options.maxRateLimitRetries ?? MAX_RATE_LIMIT_RETRIES),
      transientBudget:
        options.infiniteRetry === true
          ? null
          : (options.maxTransientRetries ?? MAX_TRANSIENT_RETRIES),
      rateLimitRetries: 0,
      transientRetries: 0,
      consecutiveTransientFailures: 0,
      maxTokens: streamOptions?.maxTokens ?? model.maxTokens,
      clampedMaxTokens: false,
      lastFailure: null,
      // A consumer must see one `start` per turn, even when an attempt is replaced.
      startRelayed: false,
    };
    runAttempts(output, inner, model, context, streamOptions, state, environment).catch((cause) => {
      const failure = analyzeProviderFailure({ message: messageFromThrown(cause) }).failure;
      output.push({
        type: "error",
        reason: "error",
        error: terminalMessage({
          model,
          timestamp: environment.now(),
          stopReason: "error",
          errorMessage: failure.message,
        }),
      });
    });
    return output;
  };
}

interface RetryState {
  readonly rateLimitBudget: number | null;
  readonly transientBudget: number | null;
  rateLimitRetries: number;
  transientRetries: number;
  consecutiveTransientFailures: number;
  maxTokens: number;
  clampedMaxTokens: boolean;
  lastFailure: OrchestrationV2ProviderFailure | null;
  startRelayed: boolean;
}

interface RunEnvironment {
  readonly now: () => number;
  readonly random: () => number;
  readonly sleep: ProviderRetrySleep;
  readonly scheduleTimer: (ms: number, callback: () => void) => () => void;
  readonly idleTimeoutMs: number;
  readonly options: ProviderRetryOptions;
}

function budgetFor(state: RetryState, category: ProviderFailureCategory): number | null {
  return category === "rate_limit" ? state.rateLimitBudget : state.transientBudget;
}

function retriesFor(state: RetryState, category: ProviderFailureCategory): number {
  return category === "rate_limit" ? state.rateLimitRetries : state.transientRetries;
}

function recordRetry(state: RetryState, category: ProviderFailureCategory): void {
  if (category === "rate_limit") {
    state.rateLimitRetries += 1;
  } else {
    state.transientRetries += 1;
  }
}

function attemptCount(state: RetryState): number {
  return state.rateLimitRetries + state.transientRetries + 1;
}

function emitEvent(environment: RunEnvironment, event: ProviderRetryLifecycleEvent): void {
  environment.options.onRetryEvent?.(event);
}

function abortOutput(
  output: AssistantMessageEventStream,
  model: Model<Api>,
  environment: RunEnvironment,
  state: RetryState,
): void {
  const failure = analyzeProviderFailure({ aborted: true }).failure;
  emitEvent(environment, {
    status: "aborted",
    attempt: attemptCount(state),
    maxAttempts: null,
    delayMs: null,
    failure,
  });
  output.push({
    type: "error",
    reason: "aborted",
    error: terminalMessage({
      model,
      timestamp: environment.now(),
      stopReason: "aborted",
      errorMessage: failure.message,
    }),
  });
}

function failOutput(
  output: AssistantMessageEventStream,
  model: Model<Api>,
  environment: RunEnvironment,
  state: RetryState,
  failure: OrchestrationV2ProviderFailure,
  maxAttempts: number | null,
): void {
  emitEvent(environment, {
    status: "failed",
    attempt: attemptCount(state),
    maxAttempts,
    delayMs: null,
    failure,
  });
  output.push({
    type: "error",
    reason: "error",
    error: terminalMessage({
      model,
      timestamp: environment.now(),
      stopReason: "error",
      errorMessage: failure.message,
    }),
  });
}

async function runAttempts(
  output: AssistantMessageEventStream,
  inner: StreamFn,
  model: Model<Api>,
  context: TranscriptContext,
  streamOptions: SimpleStreamOptions | undefined,
  state: RetryState,
  environment: RunEnvironment,
): Promise<void> {
  const callerSignal = streamOptions?.signal;
  for (;;) {
    if (isAborted(callerSignal)) {
      abortOutput(output, model, environment, state);
      return;
    }

    const outcome = await runAttempt({
      inner,
      model,
      context,
      streamOptions,
      output,
      state,
      environment,
      shouldRelayStart: !state.startRelayed,
      onStartRelayed: () => {
        state.startRelayed = true;
      },
    });
    if (outcome.kind === "completed") {
      if (state.lastFailure !== null) {
        emitEvent(environment, {
          status: "completed",
          attempt: attemptCount(state) - 1,
          maxAttempts: null,
          delayMs: null,
          failure: state.lastFailure,
        });
      }
      return;
    }

    const decision = decideRetry(outcome, state, environment);
    if (decision.kind === "terminal") {
      if (decision.status === "aborted") {
        abortOutput(output, model, environment, state);
      } else {
        failOutput(output, model, environment, state, decision.failure, decision.maxAttempts);
      }
      return;
    }
    if (decision.kind === "clamp") {
      state.maxTokens = decision.maxTokens;
      state.clampedMaxTokens = true;
      continue;
    }

    state.lastFailure = decision.failure;
    recordRetry(state, decision.category);
    if (decision.category === "transient" && outcome.status === null) {
      state.consecutiveTransientFailures += 1;
      if (state.consecutiveTransientFailures >= CONNECTION_FAILURES_BEFORE_RESET) {
        state.consecutiveTransientFailures = 0;
        environment.options.onConnectionPoolReset?.();
      }
    } else {
      state.consecutiveTransientFailures = 0;
    }
    emitEvent(environment, {
      status: "running",
      attempt: decision.attempt,
      maxAttempts: decision.maxAttempts,
      delayMs: decision.delayMs,
      failure: decision.failure,
    });
    await environment.sleep(decision.delayMs, callerSignal);
    if (isAborted(callerSignal)) {
      abortOutput(output, model, environment, state);
      return;
    }
  }
}

interface RetryDecisionTerminal {
  readonly kind: "terminal";
  readonly status: "failed" | "aborted";
  readonly failure: OrchestrationV2ProviderFailure;
  readonly maxAttempts: number | null;
}

interface RetryDecisionBackoff {
  readonly kind: "backoff";
  readonly category: Extract<ProviderFailureCategory, "rate_limit" | "transient">;
  readonly attempt: number;
  readonly delayMs: number;
  readonly maxAttempts: number | null;
  readonly failure: OrchestrationV2ProviderFailure;
}

interface RetryDecisionClamp {
  readonly kind: "clamp";
  readonly maxTokens: number;
}

type RetryDecision = RetryDecisionTerminal | RetryDecisionBackoff | RetryDecisionClamp;

function decideRetry(
  attempt: AttemptFailure,
  state: RetryState,
  environment: RunEnvironment,
): RetryDecision {
  if (attempt.idleTimedOut) {
    const idleFailure = analyzeProviderFailure(
      {
        message: `Provider stream timed out after ${environment.idleTimeoutMs} ms without a response.`,
      },
      environment.now(),
    );
    const budget = state.transientBudget;
    if (attempt.visibleOutput) {
      return {
        kind: "terminal",
        status: "failed",
        failure: idleFailure.failure,
        maxAttempts: null,
      };
    }
    if (budget !== null && state.transientRetries >= budget) {
      return {
        kind: "terminal",
        status: "failed",
        failure: idleFailure.failure,
        maxAttempts: budget,
      };
    }
    return {
      kind: "backoff",
      category: "transient",
      attempt: state.transientRetries + 1,
      delayMs: transientDelayMs(state.transientRetries + 1),
      maxAttempts: budget,
      failure: idleFailure.failure,
    };
  }

  const assistantMessage = attempt.assistantMessage;
  const contextOverflow =
    assistantMessage !== null
      ? isContextOverflow(assistantMessage)
      : CONTEXT_OVERFLOW_MESSAGE.test(attempt.message);
  const analysis = analyzeProviderFailure(
    {
      status: attempt.status,
      headers: attempt.headers,
      message: attempt.message,
      aborted: attempt.abortedByCaller,
      contextOverflow,
    },
    environment.now(),
  );

  if (analysis.category === "aborted" || assistantMessage?.stopReason === "aborted") {
    return { kind: "terminal", status: "aborted", failure: analysis.failure, maxAttempts: null };
  }

  const clamped =
    state.clampedMaxTokens || attempt.visibleOutput
      ? null
      : clampRejectedMaxTokens({
          message: attempt.message,
          status: attempt.status,
          maxTokens: state.maxTokens,
        });
  if (clamped !== null) {
    return { kind: "clamp", maxTokens: clamped };
  }

  const category = analysis.category;
  if (category === "rate_limit" || category === "transient") {
    if (attempt.visibleOutput) {
      return { kind: "terminal", status: "failed", failure: analysis.failure, maxAttempts: null };
    }
    const budget = budgetFor(state, category);
    const used = retriesFor(state, category);
    if (budget !== null && used >= budget) {
      return { kind: "terminal", status: "failed", failure: analysis.failure, maxAttempts: budget };
    }
    const delayMs =
      analysis.retryAfterMs ??
      (category === "rate_limit"
        ? rateLimitDelayMs(used + 1, environment.random)
        : transientDelayMs(used + 1));
    return {
      kind: "backoff",
      category,
      attempt: used + 1,
      delayMs,
      maxAttempts: budget,
      failure: analysis.failure,
    };
  }

  return {
    kind: "terminal",
    status: "failed",
    failure: analysis.failure,
    maxAttempts: null,
  };
}

interface AttemptFailure {
  readonly message: string;
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string>> | null;
  readonly assistantMessage: AssistantMessage | null;
  readonly abortedByCaller: boolean;
  readonly idleTimedOut: boolean;
  readonly visibleOutput: boolean;
}

type AttemptOutcome =
  | { readonly kind: "completed" }
  | ({ readonly kind: "failed" } & AttemptFailure);

interface RunAttemptInput {
  readonly inner: StreamFn;
  readonly model: Model<Api>;
  readonly context: TranscriptContext;
  readonly streamOptions: SimpleStreamOptions | undefined;
  readonly output: AssistantMessageEventStream;
  readonly state: RetryState;
  readonly environment: RunEnvironment;
  readonly shouldRelayStart: boolean;
  readonly onStartRelayed: () => void;
}

async function runAttempt(input: RunAttemptInput): Promise<AttemptOutcome> {
  const { inner, model, context, output, state, environment } = input;
  const callerSignal = input.streamOptions?.signal;
  const controller = new AbortController();
  let idleTimedOut = false;
  let capturedStatus: number | null = null;
  let capturedHeaders: Readonly<Record<string, string>> | null = null;
  let visibleOutput = false;
  let terminalEvent: "done" | "error" | null = null;
  let errorMessage: AssistantMessage | null = null;
  let timerCancel: (() => void) | undefined;

  const onCallerAbort = () => controller.abort();
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  const disarmWatchdog = () => {
    timerCancel?.();
    timerCancel = undefined;
  };
  const armWatchdog = () => {
    disarmWatchdog();
    timerCancel = environment.scheduleTimer(environment.idleTimeoutMs, () => {
      timerCancel = undefined;
      idleTimedOut = true;
      controller.abort(IDLE_TIMEOUT_MARKER);
    });
  };
  armWatchdog();

  const attemptOptions: SimpleStreamOptions = {
    ...input.streamOptions,
    signal: controller.signal,
    maxRetries: 0,
    maxTokens: state.maxTokens,
    onResponse: (response: ProviderResponse) => {
      capturedStatus = response.status;
      capturedHeaders = response.headers;
      return input.streamOptions?.onResponse?.(response, model);
    },
  };

  try {
    const stream = await inner(model, context, attemptOptions);
    for await (const event of stream) {
      // A terminal event is held back: an error may still be retried, and relaying it
      // would end the output stream before the retry decision.
      if (event.type === "error") {
        terminalEvent = "error";
        errorMessage = event.error;
        break;
      }
      const duplicateStart = event.type === "start" && !input.shouldRelayStart;
      if (event.type === "start") input.onStartRelayed();
      if (!duplicateStart) output.push(event);
      if (isVisibleEvent(event)) visibleOutput = true;
      if (event.type === "done") {
        terminalEvent = "done";
        break;
      }
      armWatchdog();
    }
    if (terminalEvent === "done") return { kind: "completed" };
    return {
      kind: "failed",
      message:
        errorMessage?.errorMessage ??
        (terminalEvent === "error"
          ? "Provider stream failed."
          : "Provider stream ended without a response."),
      status: capturedStatus,
      headers: capturedHeaders,
      assistantMessage: errorMessage,
      abortedByCaller: isAborted(callerSignal),
      idleTimedOut,
      visibleOutput,
    };
  } catch (cause) {
    return {
      kind: "failed",
      message: messageFromThrown(cause),
      status: capturedStatus ?? statusFromThrown(cause),
      headers: capturedHeaders ?? headersFromThrown(cause),
      assistantMessage: null,
      abortedByCaller: isAborted(callerSignal),
      idleTimedOut,
      visibleOutput,
    };
  } finally {
    disarmWatchdog();
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
