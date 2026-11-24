import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { PiNativeSettings } from "./settings.ts";

export const piNativeClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("piNative"),
  label: "Pi Native",
  featured: true,
  badgeLabel: "Built-in",
  settingsSchema: PiNativeSettings,
  icon: {
    viewBox: "0 0 48 48",
    fill: { light: "#0F0F0F", dark: "#F5F5F5" },
    paths: [
      {
        d: "M24 4 41.32 14V34L24 44 6.68 34V14ZM24 12.6 14.4 18.1V29.9L24 35.4 33.6 29.9V18.1Z",
        fillRule: "evenodd",
      },
      { d: "M17 19H31V22H17Z" },
      { d: "M19 22H22V31H19Z" },
      { d: "M26 22H29V31H26Z" },
    ],
  },
});
