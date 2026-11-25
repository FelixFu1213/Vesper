import { describe, expect, it } from "@effect/vitest";
import type { ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PiNativeSettings } from "../settings.ts";
import {
  buildInitialPiNativeProviderSnapshot,
  checkPiNativeProviderStatus,
  resolvePiNativeBuiltinModel,
} from "./status.ts";

const decodeSettings = Schema.decodeSync(PiNativeSettings);

const settings = (overrides: Record<string, unknown> = {}): PiNativeSettings =>
  decodeSettings({ enabled: true, ...overrides });

const selectDescriptor = (model: ServerProviderModel | undefined, id: string) => {
  const descriptor = model?.capabilities?.optionDescriptors?.find(
    (candidate) => candidate.id === id,
  );
  return descriptor?.type === "select" ? descriptor : undefined;
};

const modelBySlug = (models: ReadonlyArray<ServerProviderModel>, slug: string) =>
  models.find((model) => model.slug === slug);

const countingFetch = (respond: () => Response) => {
  const calls: Array<{ url: string; headers: unknown }> = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: init?.headers });
    return respond();
  };
  return { calls, fetchImpl };
};

describe("Pi Native presentation", () => {
  it.effect("publishes every runtime mode and the interaction mode toggle", () =>
    Effect.gen(function* () {
      const draft = yield* checkPiNativeProviderStatus(settings({ apiKey: "sk-test" }));
      expect(draft.displayName).toBe("Pi Native");
      expect(draft.showInteractionModeToggle).toBe(true);
      expect(draft.reportsContextWindow).toBe(true);
      expect(draft.supportedRuntimeModes).toEqual([
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ]);
    }),
  );

  it.effect("reports a disabled instance without text generation", () =>
    Effect.gen(function* () {
      const draft = yield* checkPiNativeProviderStatus(
        settings({ enabled: false, apiKey: "sk-test" }),
      );
      expect(draft.enabled).toBe(false);
      expect(draft.installed).toBe(false);
      expect(draft.status).toBe("disabled");
      expect(draft.auth).toEqual({ status: "unknown" });
      expect(draft.supportsTextGeneration).toBe(false);
    }),
  );

  it.effect("is ready with an API key", () =>
    Effect.gen(function* () {
      const draft = yield* checkPiNativeProviderStatus(settings({ apiKey: "sk-test" }));
      expect(draft.installed).toBe(true);
      expect(draft.status).toBe("ready");
      expect(draft.auth).toEqual({ status: "authenticated", label: "API key" });
      expect(draft.supportsTextGeneration).toBe(true);
    }),
  );

  it.effect("accepts a custom endpoint without an API key", () =>
    Effect.gen(function* () {
      const draft = yield* checkPiNativeProviderStatus(
        settings({ baseUrl: "http://127.0.0.1:1234/v1" }),
      );
      expect(draft.status).toBe("ready");
      expect(draft.auth).toEqual({ status: "unknown" });
      expect(draft.message).toBe("Using custom endpoint without API key.");
      expect(draft.supportsTextGeneration).toBe(true);
    }),
  );

  it.effect("warns when no credential or endpoint is configured", () =>
    Effect.gen(function* () {
      const draft = yield* checkPiNativeProviderStatus(settings());
      expect(draft.status).toBe("warning");
      expect(draft.auth).toEqual({ status: "unauthenticated" });
      expect(draft.message).toBe("Set an API key or base URL in Pi Native settings.");
      expect(draft.supportsTextGeneration).toBe(false);
    }),
  );

  it.effect("publishes the workspace skills it was given", () =>
    Effect.gen(function* () {
      const draft = yield* checkPiNativeProviderStatus(settings({ apiKey: "sk-test" }), {
        skills: [
          {
            name: "review",
            displayName: "Review",
            path: "/tmp/app/.agents/skills/review/SKILL.md",
            scope: "project",
            enabled: true,
          },
        ],
      });
      expect(draft.skills.map((skill) => skill.name)).toEqual(["review"]);
    }),
  );

  it.effect("builds an initial snapshot without probing anything", () =>
    Effect.gen(function* () {
      const draft = yield* buildInitialPiNativeProviderSnapshot(settings());
      expect(draft.status).toBe("warning");
      expect(draft.supportsTextGeneration).toBe(false);
      expect(draft.models[0]?.slug).toBe("default");
    }),
  );

  it.effect("advertises the native slash commands on every snapshot", () =>
    Effect.gen(function* () {
      const draft = yield* buildInitialPiNativeProviderSnapshot(settings());
      expect(draft.slashCommands.map((command) => command.name)).toEqual([
        "goal",
        "compact",
        "review",
        "grill-me",
        "boost",
        "init",
      ]);
    }),
  );
});

describe("Pi Native model catalog", () => {
  it.effect("prepends the default sentinel and lists built-in models for the API style", () =>
    Effect.gen(function* () {
      const draft = yield* checkPiNativeProviderStatus(
        settings({
          apiStyle: "anthropic-messages",
          apiKey: "sk-test",
          defaultModel: "claude-fable-5",
        }),
      );
      const models = draft.models;
      expect(models[0]).toMatchObject({
        slug: "default",
        name: "Default (claude-fable-5)",
        isDefault: true,
        isCustom: false,
      });
      expect(modelBySlug(models, "anthropic/claude-fable-5")).toMatchObject({
        name: "Claude Fable 5",
        subProvider: "anthropic",
        isCustom: false,
      });
      expect(models.every((model) => model.slug !== "openai/gpt-5")).toBe(true);
      expect(new Set(models.map((model) => model.slug)).size).toBe(models.length);
    }),
  );

  it.effect("describes thinking levels and OpenAI service tiers per model", () =>
    Effect.gen(function* () {
      const draft = yield* checkPiNativeProviderStatus(
        settings({ apiStyle: "openai-responses", apiKey: "sk-test", defaultModel: "gpt-5" }),
      );
      const defaultEntry = draft.models[0];
      const defaultThinking = selectDescriptor(defaultEntry, "thinking");
      expect(defaultThinking?.options.map((option) => option.id)).toEqual([
        "minimal",
        "low",
        "medium",
        "high",
      ]);
      expect(defaultThinking?.options.find((option) => option.isDefault)?.id).toBe("medium");

      const gpt5 = modelBySlug(draft.models, "openai/gpt-5");
      const serviceTier = selectDescriptor(gpt5, "serviceTier");
      expect(serviceTier?.options.map((option) => option.id)).toEqual([
        "default",
        "flex",
        "priority",
      ]);
      expect(serviceTier?.currentValue).toBe("default");
      expect(serviceTier?.options.find((option) => option.isDefault)?.id).toBe("default");

      const gpt4 = modelBySlug(draft.models, "openai/gpt-4");
      expect(selectDescriptor(gpt4, "thinking")).toBeUndefined();
      expect(selectDescriptor(gpt4, "serviceTier")).not.toBeUndefined();
    }),
  );

  it.effect("offers extended thinking levels only when the model maps them", () =>
    Effect.gen(function* () {
      const draft = yield* checkPiNativeProviderStatus(
        settings({
          apiStyle: "anthropic-messages",
          apiKey: "sk-test",
          defaultModel: "claude-fable-5",
        }),
      );
      const thinking = selectDescriptor(
        modelBySlug(draft.models, "anthropic/claude-fable-5"),
        "thinking",
      );
      expect(thinking?.options.map((option) => option.id)).toEqual([
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
      expect(
        selectDescriptor(modelBySlug(draft.models, "anthropic/claude-fable-5"), "serviceTier"),
      ).toBeUndefined();
    }),
  );

  it.effect("merges custom models into the catalog", () =>
    Effect.gen(function* () {
      const draft = yield* checkPiNativeProviderStatus(
        settings({
          apiStyle: "openai-completions",
          apiKey: "sk-test",
          customModels: ["my-turbo", { slug: "renamed", name: "Renamed Model" }],
        }),
      );
      expect(modelBySlug(draft.models, "my-turbo")).toMatchObject({
        name: "my-turbo",
        isCustom: true,
      });
      expect(modelBySlug(draft.models, "renamed")).toMatchObject({
        name: "Renamed Model",
        isCustom: true,
      });
    }),
  );

  it("resolves a built-in model by provider slug or bare id", () => {
    expect(resolvePiNativeBuiltinModel("anthropic-messages", "anthropic/claude-fable-5")?.id).toBe(
      "claude-fable-5",
    );
    expect(resolvePiNativeBuiltinModel("anthropic-messages", "claude-fable-5")?.id).toBe(
      "claude-fable-5",
    );
    expect(resolvePiNativeBuiltinModel("anthropic-messages", "missing-model")).toBeUndefined();
    expect(resolvePiNativeBuiltinModel("google-generative-ai", "")?.api).toBe(
      "google-generative-ai",
    );
  });
});

describe("Pi Native remote model discovery", () => {
  it.effect("reads /models only when asked, and only with a base URL", () =>
    Effect.gen(function* () {
      const remote = countingFetch(
        () =>
          new Response(
            JSON.stringify({
              data: [{ id: "remote-model", name: "Remote Model" }, { id: "gpt-5" }],
            }),
            { status: 200 },
          ),
      );
      const base = settings({
        apiStyle: "openai-responses",
        apiKey: "sk-test",
        baseUrl: "http://127.0.0.1:1234/v1/",
      });

      const withoutDiscovery = yield* checkPiNativeProviderStatus(base);
      expect(remote.calls).toHaveLength(0);
      expect(modelBySlug(withoutDiscovery.models, "remote-model")).toBeUndefined();

      const withDiscovery = yield* checkPiNativeProviderStatus(base, {
        fetchRemoteModels: true,
        fetch: remote.fetchImpl,
      });
      expect(remote.calls[0]?.url).toBe("http://127.0.0.1:1234/v1/models");
      expect(remote.calls[0]?.headers).toEqual({
        accept: "application/json",
        authorization: "Bearer sk-test",
      });
      expect(modelBySlug(withDiscovery.models, "remote-model")).toMatchObject({
        name: "Remote Model",
        isCustom: false,
      });
      expect(withDiscovery.status).toBe("ready");
      expect(withDiscovery.supportsTextGeneration).toBe(true);
    }),
  );

  it.effect("does not call the endpoint when no base URL is set", () =>
    Effect.gen(function* () {
      const remote = countingFetch(() => Response.json({ data: [] }));
      const draft = yield* checkPiNativeProviderStatus(settings({ apiKey: "sk-test" }), {
        fetchRemoteModels: true,
        fetch: remote.fetchImpl,
      });
      expect(remote.calls).toHaveLength(0);
      expect(draft.status).toBe("ready");
    }),
  );

  it.effect("keeps the static catalog when remote discovery fails", () =>
    Effect.gen(function* () {
      const failingFetch: typeof globalThis.fetch = async () => {
        throw new Error("offline");
      };
      const draft = yield* checkPiNativeProviderStatus(
        settings({
          apiStyle: "openai-responses",
          baseUrl: "http://127.0.0.1:1234/v1",
        }),
        { fetchRemoteModels: true, fetch: failingFetch },
      );
      expect(draft.status).toBe("ready");
      expect(modelBySlug(draft.models, "openai/gpt-5")).not.toBeUndefined();
      expect(modelBySlug(draft.models, "remote-model")).toBeUndefined();
    }),
  );

  it.effect("skips an unusable remote payload", () =>
    Effect.gen(function* () {
      const remote = countingFetch(() => Response.json({ models: ["not-an-openai-shape"] }));
      const draft = yield* checkPiNativeProviderStatus(
        settings({ apiStyle: "openai-responses", baseUrl: "http://127.0.0.1:1234/v1" }),
        { fetchRemoteModels: true, fetch: remote.fetchImpl },
      );
      expect(draft.models.every((model) => model.slug !== "not-an-openai-shape")).toBe(true);
      expect(draft.status).toBe("ready");
    }),
  );
});

describe("configured model bindings", () => {
  const boundSettings = () =>
    settings({
      apiKey: "sk-test",
      modelBindings: [
        {
          id: "claude-haiku-4-5",
          alias: "Fast",
          contextWindow: 200_000,
          maxTokens: 64_000,
          thinkingLevels: ["low", "high"],
          defaultThinkingLevel: "high",
        },
        {
          id: "gpt-5.4",
          displayName: "GPT 5.4",
          contextWindow: 400_000,
          maxTokens: 128_000,
          thinkingLevels: ["off", "medium", "high"],
          defaultThinkingLevel: "omit",
          availableForSubagents: true,
        },
      ],
      customModels: ["claude-haiku-4-5", "unbound/model"],
    });

  it.effect("publishes only the bindings in their configured order", () =>
    Effect.gen(function* () {
      const draft = yield* checkPiNativeProviderStatus(boundSettings());
      expect(draft.models.map((model) => model.slug)).toEqual([
        "claude-haiku-4-5",
        "gpt-5.4",
        "unbound/model",
      ]);
      expect(draft.models.some((model) => model.slug === "default")).toBe(false);
      expect(draft.models[0]?.isDefault).toBe(true);
      expect(draft.models[1]?.isDefault).toBe(false);
      expect(draft.models[0]?.name).toBe("Fast");
      expect(draft.models[1]?.name).toBe("GPT 5.4");
      expect(draft.models[2]?.isCustom).toBe(true);
    }),
  );

  it.effect("advertises exactly the binding thinking ladder plus Auto", () =>
    Effect.gen(function* () {
      const draft = yield* checkPiNativeProviderStatus(boundSettings());
      const thinking = selectDescriptor(draft.models[0], "thinking");
      expect(thinking?.options.map((option) => option.id)).toEqual(["low", "high", "omit"]);
      expect(thinking?.role).toBe("reasoning");
      expect(thinking?.options.find((option) => option.isDefault === true)?.id).toBe("high");

      const autoDefault = selectDescriptor(draft.models[1], "thinking");
      expect(autoDefault?.options.find((option) => option.isDefault === true)?.id).toBe("omit");
    }),
  );

  it.effect("honours an explicit default model", () =>
    Effect.gen(function* () {
      const draft = yield* checkPiNativeProviderStatus(
        decodeSettings({
          enabled: true,
          apiKey: "sk-test",
          defaultModel: "GPT-5.4",
          modelBindings: [
            {
              id: "claude-haiku-4-5",
              contextWindow: 200_000,
              maxTokens: 64_000,
              thinkingLevels: [],
              defaultThinkingLevel: null,
            },
            {
              id: "gpt-5.4",
              contextWindow: 400_000,
              maxTokens: 128_000,
              thinkingLevels: [],
              defaultThinkingLevel: null,
            },
          ],
        }),
      );
      expect(modelBySlug(draft.models, "gpt-5.4")?.isDefault).toBe(true);
      expect(modelBySlug(draft.models, "claude-haiku-4-5")?.isDefault).toBe(false);
    }),
  );
});
