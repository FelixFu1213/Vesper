import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ensurePiProjectTrusted } from "./trust.ts";

describe("ensurePiProjectTrusted", () => {
  it.effect("creates trust.json and trusts cwd on first launch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempHome = yield* fs.makeTempDirectoryScoped();
      const projectDir = path.join(tempHome, "workspace", "repo");

      yield* ensurePiProjectTrusted({
        cwd: projectDir,
        environment: { HOME: tempHome },
        launchArgs: [],
        hostHome: tempHome,
        platform: "linux",
      });

      const trustPath = path.join(tempHome, ".pi", "agent", "trust.json");
      const content = JSON.parse(yield* fs.readFileString(trustPath)) as Record<string, boolean>;
      assert.deepEqual(content, { [path.resolve(projectDir)]: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("respects PI_CODING_AGENT_DIR with tilde expansion", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempHome = yield* fs.makeTempDirectoryScoped();
      const projectDir = path.join(tempHome, "worktree");

      yield* ensurePiProjectTrusted({
        cwd: projectDir,
        environment: { HOME: tempHome, PI_CODING_AGENT_DIR: "~/custom-pi" },
        launchArgs: [],
        hostHome: tempHome,
        platform: "linux",
      });

      const trustPath = path.join(tempHome, "custom-pi", "trust.json");
      const content = JSON.parse(yield* fs.readFileString(trustPath)) as Record<string, boolean>;
      assert.deepEqual(content, { [path.resolve(projectDir)]: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["--no-approve", "-na"] as const)(
    "skips auto-trust when %s is configured",
    (flag) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempHome = yield* fs.makeTempDirectoryScoped();
        const projectDir = path.join(tempHome, "workspace");

        yield* ensurePiProjectTrusted({
          cwd: projectDir,
          environment: { HOME: tempHome },
          launchArgs: [flag],
          hostHome: tempHome,
          platform: "linux",
        });

        const trustPath = path.join(tempHome, ".pi", "agent", "trust.json");
        assert.isFalse(yield* fs.exists(trustPath));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("respects explicit false on cwd or ancestor and preserves existing true parent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempHome = yield* fs.makeTempDirectoryScoped();
      const agentDir = path.join(tempHome, ".pi", "agent");
      const trustPath = path.join(agentDir, "trust.json");
      const blockedParent = path.join(tempHome, "untrusted");
      const blockedChild = path.join(blockedParent, "sub");
      const trustedParent = path.join(tempHome, "trusted");
      const trustedChild = path.join(trustedParent, "wt-1");

      yield* fs.makeDirectory(agentDir, { recursive: true });
      const initial = {
        [path.resolve(blockedParent)]: false,
        [path.resolve(trustedParent)]: true,
      };
      yield* fs.writeFileString(trustPath, `${JSON.stringify(initial, null, 2)}\n`);

      yield* ensurePiProjectTrusted({
        cwd: blockedChild,
        environment: { HOME: tempHome },
        launchArgs: [],
        hostHome: tempHome,
        platform: "linux",
      });
      yield* ensurePiProjectTrusted({
        cwd: trustedChild,
        environment: { HOME: tempHome },
        launchArgs: [],
        hostHome: tempHome,
        platform: "linux",
      });

      const content = JSON.parse(yield* fs.readFileString(trustPath)) as Record<string, boolean>;
      assert.deepEqual(content, initial);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("serializes concurrent auto-trust writes without losing entries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempHome = yield* fs.makeTempDirectoryScoped();
      const worktrees = [
        path.join(tempHome, "wt-1"),
        path.join(tempHome, "wt-2"),
        path.join(tempHome, "wt-3"),
      ];

      yield* Effect.forEach(
        worktrees,
        (cwd) =>
          ensurePiProjectTrusted({
            cwd,
            environment: { HOME: tempHome },
            launchArgs: [],
            hostHome: tempHome,
            platform: "linux",
          }),
        { concurrency: "unbounded" },
      );

      const trustPath = path.join(tempHome, ".pi", "agent", "trust.json");
      const content = JSON.parse(yield* fs.readFileString(trustPath)) as Record<string, boolean>;
      assert.deepEqual(content, {
        [path.resolve(worktrees[0]!)]: true,
        [path.resolve(worktrees[1]!)]: true,
        [path.resolve(worktrees[2]!)]: true,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
