import { PlanId, RunId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { LatestProposedPlanState } from "../../session-logic";
import { ComposerPlanApprovalBar } from "./ComposerPlanApprovalBar";
import type { RuntimeModeOption } from "./ComposerFooterControls";
import { resolveRuntimeModeOption } from "./runtimeModeConfig";

const plan: LatestProposedPlanState = {
  id: PlanId.make("plan-approval"),
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  runId: RunId.make("run-approval"),
  planMarkdown: "# Ship the plan\n\n- Step one\n- Step two",
  status: "active",
};

const fullAccess = resolveRuntimeModeOption("full-access");
const supervised = resolveRuntimeModeOption("approval-required");
const defaultOptions: ReadonlyArray<RuntimeModeOption> = [fullAccess, supervised];

const bar = (
  input: Partial<Parameters<typeof ComposerPlanApprovalBar>[0]> & {
    readonly runtimeModeOptions?: ReadonlyArray<RuntimeModeOption>;
  } = {},
) => (
  <ComposerPlanApprovalBar
    plan={plan}
    runtimeMode="full-access"
    runtimeModeOptions={input.runtimeModeOptions ?? defaultOptions}
    disabled={input.disabled ?? false}
    isApproving={input.isApproving ?? false}
    onOpenPlan={input.onOpenPlan ?? (() => {})}
    onReject={input.onReject ?? (() => {})}
    onApprove={input.onApprove ?? (() => {})}
    onApproveInNewThread={input.onApproveInNewThread ?? (() => {})}
  />
);

it("announces the plan is ready and names it", async () => {
  await using screen = await render(bar());

  await expect.element(screen.getByTestId("plan-approval-bar")).toBeVisible();
  await expect.element(screen.getByText("Plan ready", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Ship the plan", { exact: true })).toBeVisible();
});

it("opens the plan in the right panel", async () => {
  const onOpenPlan = vi.fn();
  await using screen = await render(bar({ onOpenPlan }));

  await screen.getByTestId("plan-approval-open-panel").click();
  expect(onOpenPlan).toHaveBeenCalledTimes(1);
});

it("rejects the plan", async () => {
  const onReject = vi.fn();
  await using screen = await render(bar({ onReject }));

  await screen.getByTestId("plan-approval-reject").click();
  expect(onReject).toHaveBeenCalledTimes(1);
});

it("executes with the selected permission mode", async () => {
  const onApprove = vi.fn();
  await using screen = await render(bar({ onApprove }));

  const approve = screen.getByTestId("plan-approval-approve");
  await expect.element(approve).toHaveTextContent("Execute · Full access");
  await approve.click();
  expect(onApprove).toHaveBeenCalledWith("full-access");
});

it("executes straight away when a permission mode is picked in the menu", async () => {
  const onApprove = vi.fn();
  await using screen = await render(bar({ onApprove }));

  await screen.getByTestId("plan-approval-mode-menu").click();
  await expect.element(page.getByText("Execute with permissions")).toBeVisible();
  await page.getByRole("menuitemradio", { name: "Supervised" }).click();

  expect(onApprove).toHaveBeenCalledWith("approval-required");
});

it("keeps a managed-policy denied mode disabled", async () => {
  const onApprove = vi.fn();
  await using screen = await render(
    bar({
      onApprove,
      runtimeModeOptions: [
        fullAccess,
        { ...supervised, disabledReason: "Organization limits threads to Full access." },
      ],
    }),
  );

  await screen.getByTestId("plan-approval-mode-menu").click();
  const denied = page.getByRole("menuitemradio", { name: "Supervised" });
  await expect.element(denied).toHaveAttribute("aria-disabled", "true");
  await denied.click({ force: true });
  expect(onApprove).not.toHaveBeenCalled();
});

it("starts the plan in a new thread with the selected mode", async () => {
  const onApproveInNewThread = vi.fn();
  await using screen = await render(bar({ onApproveInNewThread }));

  await screen.getByTestId("plan-approval-mode-menu").click();
  await page.getByRole("menuitem", { name: "Execute in a new thread" }).click();

  expect(onApproveInNewThread).toHaveBeenCalledWith("full-access");
});

it("shows a starting state and locks the actions while executing", async () => {
  await using screen = await render(bar({ isApproving: true }));

  await expect
    .element(screen.getByTestId("plan-approval-bar"))
    .toHaveAttribute("aria-busy", "true");
  await expect
    .element(screen.getByTestId("plan-approval-approve"))
    .toHaveTextContent("Starting...");
  await expect.element(screen.getByTestId("plan-approval-approve")).toBeDisabled();
  await expect.element(screen.getByTestId("plan-approval-reject")).toBeDisabled();
  await expect.element(screen.getByTestId("plan-approval-mode-menu")).toBeDisabled();
});

it("locks the actions when approval is unavailable", async () => {
  await using screen = await render(bar({ disabled: true }));

  await expect.element(screen.getByTestId("plan-approval-approve")).toBeDisabled();
  await expect.element(screen.getByTestId("plan-approval-reject")).toBeDisabled();
});
