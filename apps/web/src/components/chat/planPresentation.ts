import type { OrchestrationV2PlanArtifact } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export type PlanStatusBadgeVariant = "warning" | "success" | "secondary" | "info";

/**
 * How a plan's status reads beside its title. The wording follows what the user must do with
 * it: an active plan waits for approval, a completed one was approved.
 */
export function planStatusBadge(
  status: OrchestrationV2PlanArtifact["status"],
  resolve: MessageResolver = m,
): { readonly variant: PlanStatusBadgeVariant; readonly label: string } {
  switch (status) {
    case "active":
      return { variant: "warning", label: resolve(msg("Pending approval")) };
    case "completed":
      return { variant: "success", label: resolve(msg("Approved")) };
    case "superseded":
      return { variant: "secondary", label: resolve(msg("Superseded")) };
    case "draft":
      return { variant: "info", label: resolve(msg("Draft")) };
  }
}
