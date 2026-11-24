import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import type { ProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenance";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PiNativeSettings } from "../settings.ts";
import { type PiNativeAdapterV2DriverEnv, PiNativeAdapterV2Driver } from "./adapter.ts";
import {
  buildInitialPiNativeProviderSnapshot,
  checkPiNativeProviderStatus,
  PI_NATIVE_DRIVER_KIND,
} from "./status.ts";
import { makePiNativeTextGeneration } from "./textGeneration.ts";

const decodePiNativeSettings = Schema.decodeSync(PiNativeSettings);

const PI_NATIVE_MAINTENANCE: ProviderMaintenanceCapabilities = {
  provider: PI_NATIVE_DRIVER_KIND,
  packageName: null,
  update: null,
};

export type PiNativeDriverEnv = PiNativeAdapterV2DriverEnv | ProviderHost.ProviderHost;

export const PiNativeDriver: ProviderDriver<PiNativeSettings, PiNativeDriverEnv> = {
  driverKind: PI_NATIVE_DRIVER_KIND,
  metadata: {
    displayName: "Pi Native",
    supportsMultipleInstances: true,
  },
  configSchema: PiNativeSettings,
  defaultConfig: (): PiNativeSettings => decodePiNativeSettings({}),
  create: Effect.fn("PiNativeDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: PI_NATIVE_DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: PI_NATIVE_DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies PiNativeSettings;
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PiNativeSettings>>({
      resolveMaintenance: () => Effect.succeed(PI_NATIVE_MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialPiNativeProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider: checkPiNativeProviderStatus(effectiveConfig).pipe(Effect.map(stampIdentity)),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: PI_NATIVE_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the Pi Native provider snapshot.",
            cause,
          }),
      ),
    );
    const orchestrationAdapter = yield* PiNativeAdapterV2Driver.create({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config: effectiveConfig,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: PI_NATIVE_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the Pi Native orchestration adapter.",
            cause,
          }),
      ),
    );
    const textGeneration = yield* makePiNativeTextGeneration(effectiveConfig);

    return {
      instanceId,
      driverKind: PI_NATIVE_DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
