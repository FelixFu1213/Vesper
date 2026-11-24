// @effect-diagnostics nodeBuiltinImport:off -- The service caches its snapshot in a real state directory.
import { it } from "@effect/vitest";
import {
  PiNativeCatalogOperationError,
  ProviderDriverKind,
  ProviderInstanceId,
  type SecretReference,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import * as PiNativeCatalogService from "./PiNativeCatalogService.ts";

const INSTANCE = ProviderInstanceId.make("piNative-work");

const reference = (referencePath: string): SecretReference => ({
  provider: "keychain" as SecretReference["provider"],
  reference: referencePath,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

interface HarnessOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly stateDir: string;
  readonly secrets?: Readonly<Record<string, string>> | undefined;
  readonly savedApiKey?: unknown;
  readonly hasInstance?: boolean | undefined;
}

const harness = (options: HarnessOptions) => {
  const serviceLayer = Layer.effect(
    PiNativeCatalogService.PiNativeCatalogService,
    PiNativeCatalogService.make({ fetch: options.fetch }),
  ).pipe(
    Layer.provide(
      Layer.succeed(ServerConfig.ServerConfig, {
        stateDir: options.stateDir,
      } as ServerConfig.ServerConfig["Service"]),
    ),
    Layer.provide(
      ServerSettings.layerTest(
        options.hasInstance === true
          ? {
              providerInstances: {
                [INSTANCE]: {
                  driver: ProviderDriverKind.make("piNative"),
                  config: { vendorKey: "acme", apiKey: options.savedApiKey },
                },
              },
            }
          : {},
      ),
    ),
    Layer.provide(
      Layer.mock(SecretResolver.SecretResolver)({
        read: (references: ReadonlyArray<SecretReference>) =>
          Effect.succeed(
            references.map((entry) => options.secrets?.[entry.reference] ?? undefined),
          ),
      }),
    ),
  );
  return serviceLayer;
};

const withStateDir = <A, E, R>(
  use: (stateDir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-native-service-"))),
    use,
    (stateDir) => Effect.promise(() => NodeFSP.rm(stateDir, { recursive: true, force: true })),
  );

const endpoint = {
  apiStyle: "openai-completions",
  baseUrl: "https://api.acme.test/v1",
} as const;

it.effect("sends the literal key it was given", () =>
  withStateDir((stateDir) =>
    Effect.gen(function* () {
      const seen: Array<Record<string, string>> = [];
      const fetchImpl: typeof globalThis.fetch = (_input, init) => {
        seen.push({ ...(init?.headers as Record<string, string>) });
        return Promise.resolve(jsonResponse({ data: [{ id: "acme-chat" }] }));
      };
      const service = yield* PiNativeCatalogService.PiNativeCatalogService.pipe(
        Effect.provide(harness({ fetch: fetchImpl, stateDir })),
      );
      const result = yield* service.probeModels({ ...endpoint, apiKey: "sk-literal" });
      expect(seen[0]?.authorization).toBe("Bearer sk-literal");
      expect(result.models.map((model) => model.modelId)).toEqual(["acme-chat"]);
      expect(result.effectiveBaseUrl).toBe("https://api.acme.test/v1");
    }),
  ),
);

it.effect("reads a named secret and never returns it", () =>
  withStateDir((stateDir) =>
    Effect.gen(function* () {
      const seen: Array<Record<string, string>> = [];
      const fetchImpl: typeof globalThis.fetch = (_input, init) => {
        seen.push({ ...(init?.headers as Record<string, string>) });
        return Promise.resolve(jsonResponse({ data: [{ id: "acme-chat" }] }));
      };
      const service = yield* PiNativeCatalogService.PiNativeCatalogService.pipe(
        Effect.provide(
          harness({ fetch: fetchImpl, stateDir, secrets: { "acme/full": "sk-vault" } }),
        ),
      );
      const result = yield* service.probeModels({
        ...endpoint,
        apiKey: reference("acme/full"),
      });
      expect(seen[0]?.authorization).toBe("Bearer sk-vault");
      expect(JSON.stringify(result)).not.toContain("sk-vault");
    }),
  ),
);

it.effect("fails when the named secret cannot be read", () =>
  withStateDir((stateDir) =>
    Effect.gen(function* () {
      const service = yield* PiNativeCatalogService.PiNativeCatalogService.pipe(
        Effect.provide(harness({ fetch: () => Promise.resolve(jsonResponse({})), stateDir })),
      );
      const error = yield* Effect.flip(
        service.probeModels({ ...endpoint, apiKey: reference("acme/missing") }),
      );
      expect(error).toBeInstanceOf(PiNativeCatalogOperationError);
      expect(error.reason).toBe("secret_unavailable");
    }),
  ),
);

it.effect("reads the saved instance key when the form sent a redacted placeholder", () =>
  withStateDir((stateDir) =>
    Effect.gen(function* () {
      const seen: Array<Record<string, string>> = [];
      const fetchImpl: typeof globalThis.fetch = (_input, init) => {
        seen.push({ ...(init?.headers as Record<string, string>) });
        return Promise.resolve(jsonResponse({ data: [{ id: "acme-chat" }] }));
      };
      const service = yield* PiNativeCatalogService.PiNativeCatalogService.pipe(
        Effect.provide(
          harness({
            fetch: fetchImpl,
            stateDir,
            hasInstance: true,
            savedApiKey: reference("acme/saved"),
            secrets: { "acme/saved": "sk-saved" },
          }),
        ),
      );
      yield* service.testConnection({
        ...endpoint,
        apiKey: SECRET_REDACTED,
        instanceId: INSTANCE,
      });
      expect(seen[0]?.authorization).toBe("Bearer sk-saved");
    }),
  ),
);

it.effect("clears the saved key when the form asks for it", () =>
  withStateDir((stateDir) =>
    Effect.gen(function* () {
      const seen: Array<Record<string, string>> = [];
      const fetchImpl: typeof globalThis.fetch = (_input, init) => {
        seen.push({ ...(init?.headers as Record<string, string>) });
        return Promise.resolve(jsonResponse({ data: [{ id: "acme-chat" }] }));
      };
      const service = yield* PiNativeCatalogService.PiNativeCatalogService.pipe(
        Effect.provide(
          harness({
            fetch: fetchImpl,
            stateDir,
            hasInstance: true,
            savedApiKey: reference("acme/saved"),
            secrets: { "acme/saved": "sk-saved" },
          }),
        ),
      );
      yield* service.probeModels({
        ...endpoint,
        instanceId: INSTANCE,
        clearSavedApiKey: true,
      });
      expect(seen[0]?.authorization).toBeUndefined();
    }),
  ),
);

it.effect("reports a refused credential without echoing the key", () =>
  withStateDir((stateDir) =>
    Effect.gen(function* () {
      const service = yield* PiNativeCatalogService.PiNativeCatalogService.pipe(
        Effect.provide(harness({ fetch: () => Promise.resolve(jsonResponse({}, 401)), stateDir })),
      );
      const result = yield* service.testConnection({ ...endpoint, apiKey: "sk-refused" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("HTTP 401");
      expect(result.error).not.toContain("sk-refused");
    }),
  ),
);

it.effect("answers the bundled catalog status without network access", () =>
  withStateDir((stateDir) =>
    Effect.gen(function* () {
      const service = yield* PiNativeCatalogService.PiNativeCatalogService.pipe(
        Effect.provide(
          harness({
            fetch: () => Promise.reject(new Error("no network in this test")),
            stateDir,
          }),
        ),
      );
      const status = yield* service.catalogStatus();
      expect(status.loaded).toBe(true);
      expect(status.source).toBe("bundled");
      expect(status.providerCount).toBeGreaterThan(0);
    }),
  ),
);

it.effect("looks a published model up by id and vendor", () =>
  withStateDir((stateDir) =>
    Effect.gen(function* () {
      const service = yield* PiNativeCatalogService.PiNativeCatalogService.pipe(
        Effect.provide(harness({ fetch: () => Promise.resolve(jsonResponse({})), stateDir })),
      );
      const found = yield* service.lookupModel({
        modelId: "claude-sonnet-4-5",
        vendorKey: "anthropic",
      });
      expect(found.model?.contextWindow).toBe(200_000);
      const missing = yield* service.lookupModel({ modelId: "no-such-model-anywhere" });
      expect(missing.model).toBeNull();
    }),
  ),
);

it.effect("refreshes the catalog and reports an update", () =>
  withStateDir((stateDir) =>
    Effect.gen(function* () {
      const service = yield* PiNativeCatalogService.PiNativeCatalogService.pipe(
        Effect.provide(
          harness({
            fetch: () =>
              Promise.resolve(
                jsonResponse({
                  acme: {
                    id: "acme",
                    name: "Acme",
                    models: {
                      "acme-chat": { id: "acme-chat", name: "Acme Chat", tool_call: true },
                    },
                  },
                }),
              ),
            stateDir,
          }),
        ),
      );
      const refreshed = yield* service.refreshCatalog();
      expect(refreshed.updated).toBe(true);
      expect(refreshed.status.source).toBe("remote");
      expect(refreshed.status.providerCount).toBe(1);
    }),
  ),
);
