import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, NodeId, PlanId, RunId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  projection: null as { readonly projection: unknown } | null,
  projectionListeners: new Set<() => void>(),
}));

vi.mock(import("~/state/entities"), async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await importOriginal()),
    useQuietThreadProjection: ((ref: unknown) => {
      const wrapped = useSyncExternalStore(
        (listener) => {
          state.projectionListeners.add(listener);
          return () => state.projectionListeners.delete(listener);
        },
        () => state.projection,
      );
      return ref === null ? null : wrapped;
    }) as never,
  };
});
vi.mock(import("~/state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: (() => true) as never,
  readEnvironmentScope: (() => true) as never,
}));

import { render } from "../../../test/render";
import type { PlanSurface } from "../../rightPanelStore";
import { PlanRightPanelView } from "./PlanRightPanelView";
import { resolveRuntimeModeOption } from "./runtimeModeConfig";

const environmentId = EnvironmentId.make("environment");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));
const planId = PlanId.make("plan-1");
const surface: PlanSurface = { id: `plan:${planId}`, kind: "plan", planId };
const planMarkdown = [
  "# Ship the plan",
  "",
  "First paragraph.",
  "",
  ...Array.from({ length: 24 }, (_, index) => `- Step ${index + 1}`),
].join("\n");

function setPlan(plan: { readonly status: string; readonly markdown?: string } | null) {
  state.projection =
    plan === null
      ? { projection: { plans: [] } }
      : {
          projection: {
            plans: [
              {
                id: planId,
                threadId: ThreadId.make("thread-1"),
                runId: RunId.make("run-1"),
                nodeId: NodeId.make("node-1"),
                kind: "proposed_plan",
                status: plan.status,
                markdown: plan.markdown ?? planMarkdown,
              },
            ],
          },
        };
  for (const listener of state.projectionListeners) listener();
}

const view = (
  input: {
    readonly approval?: Parameters<typeof PlanRightPanelView>[0]["approval"];
    readonly surface?: PlanSurface;
  } = {},
) => (
  <PlanRightPanelView
    surface={input.surface ?? surface}
    threadRef={threadRef}
    environmentId={environmentId}
    cwd={undefined}
    workspaceRoot="/workspace/project"
    approval={input.approval ?? null}
  />
);

it("renders the whole plan and its status badge", async () => {
  setPlan({ status: "completed" });
  await using screen = await render(view());

  await expect.element(screen.getByText("Approved", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Ship the plan" })).toBeVisible();
  await expect.element(screen.getByText("Step 24")).toBeVisible();
});

it("shows a pending approval badge for an active plan", async () => {
  setPlan({ status: "active" });
  await using screen = await render(view());

  await expect.element(screen.getByText("Pending approval", { exact: true })).toBeVisible();
});

it("explains when the plan is not in the thread", async () => {
  setPlan(null);
  await using screen = await render(view());

  await expect.element(screen.getByText("Plan not found in this thread.")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Copy plan" })).toBeDisabled();
});

it("copies and downloads the plan", async () => {
  setPlan({ status: "active" });
  await using screen = await render(view());
  using writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  using download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

  await screen.getByRole("button", { name: "Copy plan" }).click();
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(writeText.mock.calls[0]?.[0]).toBe(`${planMarkdown.trimEnd()}\n`);

  await screen.getByRole("button", { name: "Download plan as markdown" }).click();
  expect(download).toHaveBeenCalledTimes(1);
});

it("offers saving the plan to the workspace", async () => {
  setPlan({ status: "active" });
  await using screen = await render(view());

  await screen.getByRole("button", { name: "Save plan to workspace" }).click();

  await expect.element(page.getByText("Save plan to workspace", { exact: true })).toBeVisible();
  await expect.element(page.getByPlaceholder("ship-the-plan.md")).toHaveValue("ship-the-plan.md");
});

it("rejects and executes an active plan with the chosen permission mode", async () => {
  setPlan({ status: "active" });
  const onApprove = vi.fn();
  const onReject = vi.fn();
  const onApproveInNewThread = vi.fn();
  await using screen = await render(
    view({
      approval: {
        canApprove: true,
        isApproving: false,
        runtimeMode: "full-access",
        runtimeModeOptions: [
          resolveRuntimeModeOption("full-access"),
          resolveRuntimeModeOption("approval-required"),
        ],
        onApprove,
        onApproveInNewThread,
        onReject,
      },
    }),
  );

  await screen.getByRole("button", { name: "Reject" }).click();
  expect(onReject).toHaveBeenCalledTimes(1);

  await screen.getByRole("button", { name: "Execute · Full access" }).click();
  expect(onApprove).toHaveBeenLastCalledWith("full-access");

  await screen.getByRole("button", { name: "Choose how to execute" }).click();
  await page.getByRole("menuitemradio", { name: "Supervised" }).click();
  // Picking a permission mode in the split menu executes with it straight away.
  expect(onApprove).toHaveBeenLastCalledWith("approval-required");

  await screen.getByRole("button", { name: "Choose how to execute" }).click();
  await page.getByRole("menuitem", { name: "Execute in a new thread" }).click();
  expect(onApproveInNewThread).toHaveBeenLastCalledWith("approval-required");
});

it("hides the approval footer when the plan is not active", async () => {
  setPlan({ status: "completed" });
  await using screen = await render(
    view({
      approval: {
        canApprove: true,
        isApproving: false,
        runtimeMode: "full-access",
        runtimeModeOptions: [resolveRuntimeModeOption("full-access")],
        onApprove: () => {},
        onReject: () => {},
      },
    }),
  );

  await expect.element(screen.getByRole("button", { name: "Reject" })).not.toBeInTheDocument();
});
