import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ProposedPlanCard } from "./ProposedPlanCard";

const environmentId = EnvironmentId.make("environment");
const planMarkdown = "# Ship the plan\n\nStep one.\n\nStep two.";
const longPlanMarkdown = [
  "# Long plan",
  "",
  ...Array.from({ length: 24 }, (_, index) => `- Step ${index + 1}`),
].join("\n");

const card = (input: {
  readonly planMarkdown?: string;
  readonly status?: "draft" | "active" | "completed" | "superseded";
  readonly onOpenInPanel?: () => void;
}) => (
  <ProposedPlanCard
    planMarkdown={input.planMarkdown ?? planMarkdown}
    {...(input.status === undefined ? {} : { status: input.status })}
    environmentId={environmentId}
    cwd={undefined}
    workspaceRoot={undefined}
    {...(input.onOpenInPanel === undefined ? {} : { onOpenInPanel: input.onOpenInPanel })}
  />
);

it("opens the plan in the right panel when the card body is clicked", async () => {
  const onOpenInPanel = vi.fn();
  await using screen = await render(card({ onOpenInPanel }));

  await screen.getByText("Step one.").click();

  expect(onOpenInPanel).toHaveBeenCalledTimes(1);
});

it("opens the plan once from its Open in panel button", async () => {
  const onOpenInPanel = vi.fn();
  await using screen = await render(card({ onOpenInPanel }));

  await screen.getByTestId("open-plan-panel-button").click();

  expect(onOpenInPanel).toHaveBeenCalledTimes(1);
});

it("expands a long plan inline without opening the panel", async () => {
  const onOpenInPanel = vi.fn();
  await using screen = await render(card({ planMarkdown: longPlanMarkdown, onOpenInPanel }));

  await screen.getByRole("button", { name: "Expand plan" }).click();

  await expect.element(screen.getByRole("button", { name: "Collapse plan" })).toBeVisible();
  await expect.element(screen.getByText("Step 24")).toBeVisible();
  expect(onOpenInPanel).not.toHaveBeenCalled();
});

it("shows the plan's status beside its title", async () => {
  await using screen = await render(card({ status: "completed" }));

  await expect.element(screen.getByText("Plan", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Approved", { exact: true })).toBeVisible();
});

it("does not make the card clickable without a panel to open", async () => {
  await using screen = await render(card({}));

  await screen.getByText("Step one.").click();

  await expect.element(screen.getByTestId("open-plan-panel-button")).not.toBeInTheDocument();
  await expect.element(screen.getByText("Plan", { exact: true })).toBeVisible();
});
