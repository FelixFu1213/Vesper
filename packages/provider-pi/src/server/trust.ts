import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { piHome, resolvePiAgentDir } from "./usage.ts";

const trustWriteLock = Semaphore.makeUnsafe(1);
const TrustMapJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeTrustMap = Schema.decodeUnknownEffect(TrustMapJson);
const encodeTrustMap = Schema.encodeUnknownEffect(TrustMapJson);

function hasPiNoApproveArg(launchArgs: ReadonlyArray<string>): boolean {
  return launchArgs.some((arg) => arg === "--no-approve" || arg === "-na");
}

/**
 * Resolves the closest explicit trust decision for `cwd` or any ancestor directory in `trustMap`.
 * Returns `true` / `false` if found, or `undefined` if neither `cwd` nor any parent has a boolean entry.
 */
function resolveExistingTrustDecision(
  trustMap: Readonly<Record<string, unknown>>,
  cwd: string,
  path: Path.Path,
): boolean | undefined {
  let current = cwd;
  while (true) {
    const entry = trustMap[current];
    if (typeof entry === "boolean") {
      return entry;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * Ensures `cwd` is trusted in Pi's `trust.json` before launching Pi in RPC mode,
 * unless `--no-approve` / `-na` is configured or an existing entry explicitly sets `false`.
 */
export const ensurePiProjectTrusted = Effect.fn("PiTrust.ensurePiProjectTrusted")(
  function* (input: {
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly launchArgs: ReadonlyArray<string>;
    readonly hostHome?: string;
    readonly platform?: NodeJS.Platform;
  }): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
    if (hasPiNoApproveArg(input.launchArgs)) {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolvedCwd = path.resolve(input.cwd);
    const launchHome = piHome(
      input.environment,
      input.hostHome ?? HostProcess.HomeDirectory.defaultValue(),
      input.platform ?? HostProcess.Platform.defaultValue(),
    );
    const agentDir = resolvePiAgentDir(input.environment, launchHome, path);
    const trustPath = path.join(agentDir, "trust.json");

    yield* trustWriteLock
      .withPermits(1)(
        Effect.gen(function* () {
          const exists = yield* fs.exists(trustPath);
          let trustMap: Record<string, unknown> = {};
          if (exists) {
            const raw = yield* fs.readFileString(trustPath);
            const trimmed = raw.trim();
            if (trimmed.length > 0) {
              trustMap = { ...(yield* decodeTrustMap(trimmed)) };
            }
          }

          const existingDecision = resolveExistingTrustDecision(trustMap, resolvedCwd, path);
          if (existingDecision !== undefined) {
            return;
          }

          trustMap[resolvedCwd] = true;
          const encoded = yield* encodeTrustMap(trustMap);
          yield* fs.makeDirectory(agentDir, { recursive: true });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const stagingDir = yield* fs.makeTempDirectoryScoped({ directory: agentDir });
              const staging = path.join(stagingDir, "trust.json");
              yield* fs.writeFileString(staging, `${encoded}\n`);
              yield* fs.rename(staging, trustPath).pipe(Effect.retry({ times: 3 }));
            }),
          );
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to auto-trust Pi project directory.", {
            cwd: resolvedCwd,
            trustPath,
            cause,
          }),
        ),
      );
  },
);
