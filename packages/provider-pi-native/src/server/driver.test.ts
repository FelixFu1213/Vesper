// @effect-diagnostics nodeBuiltinImport:off -- The workspace snapshot test writes a real skill folder.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { PiNativeSettings } from "../settings.ts";
import { PiNativeDriver } from "./driver.ts";

const decodeSettings = Schema.decodeSync(PiNativeSettings);

const testLayer = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
);

const instanceId = ProviderInstanceId.make("piNative");

const createDriver = (input: { readonly enabled: boolean; readonly apiKey: string }) =>
  PiNativeDriver.create({
    instanceId,
    displayName: undefined,
    environment: [],
    enabled: input.enabled,
    config: decodeSettings({ enabled: input.enabled, apiKey: input.apiKey }),
  });

const workspaceWithSkill = async (): Promise<string> => {
  const cwd = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-native-driver-")),
  );
  const folder = NodePath.join(cwd, ".agents", "skills", "review");
  await NodeFSP.mkdir(folder, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(folder, "SKILL.md"),
    "---\nname: Review\ndescription: Reviews changes\n---\n\nRead the diff first.\n",
    "utf8",
  );
  return cwd;
};

it.layer(testLayer)("PiNativeDriver workspace snapshot", (it) => {
  it.effect("publishes the workspace's skills for the `$` composer menu", () =>
    Effect.gen(function* () {
      const cwd = yield* Effect.promise(workspaceWithSkill);
      const instance = yield* createDriver({ enabled: true, apiKey: "sk-test" });

      const snapshot = yield* instance.snapshotForCwd!(cwd);

      const projectSkill = snapshot.skills.find((skill) => skill.name === "review");
      assert.isDefined(projectSkill);
      assert.equal(projectSkill?.displayName, "Review");
      assert.equal(projectSkill?.scope, "project");
      assert.equal(
        projectSkill?.path,
        NodePath.join(cwd, ".agents", "skills", "review", "SKILL.md"),
      );
    }),
  );

  it.effect("keeps the machine snapshot for a disabled instance", () =>
    Effect.gen(function* () {
      const cwd = yield* Effect.promise(workspaceWithSkill);
      const instance = yield* createDriver({ enabled: false, apiKey: "" });

      const snapshot = yield* instance.snapshotForCwd!(cwd);

      assert.deepEqual(snapshot.skills, []);
      assert.equal(snapshot.status, "disabled");
    }),
  );
});
