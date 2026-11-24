import { createFileRoute } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { PiNativeModelsPage } from "../components/settings/pi-native/PiNativeModelsPage";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

function SettingsModelsRoute() {
  const { environment, scope } = useSettingsScope();
  const gt = useGT();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? gt("Reconnect {label} to manage its Pi Native models.", { label: scope.label })
          : gt("Connect an environment to manage its Pi Native models.")}
      </p>
    );
  }
  return <PiNativeModelsPage environmentId={environment.environmentId} />;
}

export const Route = createFileRoute("/_chat/settings/models")({
  component: SettingsModelsRoute,
});
