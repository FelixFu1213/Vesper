import { ProviderDriverKind } from "@t3tools/contracts";
import { LockIcon, ShieldOffIcon } from "lucide-react";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";

const listId = "composer-suggestions";

const slashCommandItems: ComposerCommandItem[] = [
  {
    id: "slash:plan",
    type: "slash-command",
    command: "plan",
    label: "/plan",
    hint: "[task]",
    category: "mode",
    description: "Enter plan mode, or /plan <task> to plan immediately",
  },
  {
    id: "slash:diff",
    type: "slash-command",
    command: "diff",
    label: "/diff",
    category: "panel",
    description: "Toggle the diff panel for this thread",
  },
  {
    id: "provider-slash-command:codex:review",
    type: "provider-slash-command",
    provider: ProviderDriverKind.make("codex"),
    command: { name: "review", description: "Review the changes", input: { hint: "<files>" } },
    label: "/review",
    category: "workflow",
    description: "Review the changes",
  },
];

const permissionModeItems: ComposerCommandItem[] = [
  {
    id: "permission-mode:approval-required",
    type: "permission-mode",
    mode: "approval-required",
    icon: LockIcon,
    isCurrent: true,
    label: "Supervised",
    description: "Ask before commands and file changes.",
  },
  {
    id: "permission-mode:full-access",
    type: "permission-mode",
    mode: "full-access",
    icon: ShieldOffIcon,
    isCurrent: false,
    disabledReason: "Blocked by your administrator.",
    label: "Full access",
    description: "Allow commands and edits without prompts.",
  },
];

function MenuHarness(props: {
  items: ComposerCommandItem[];
  onSelect?: (item: ComposerCommandItem) => void;
}) {
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  return (
    <ComposerCommandMenu
      listId={listId}
      items={props.items}
      resolvedTheme="light"
      isLoading={false}
      triggerKind="slash-command"
      activeItemId={activeItemId}
      onHighlightedItemChange={setActiveItemId}
      onSelect={props.onSelect ?? (() => {})}
    />
  );
}

it("shows argument hints and slash command category badges", async () => {
  await using screen = await render(<MenuHarness items={slashCommandItems} />, { router: false }); // no routes involved

  await expect.element(screen.getByText("[task]")).toBeVisible();
  await expect.element(screen.getByText("<files>")).toBeVisible();
  await expect.element(screen.getByText("Mode")).toBeVisible();
  await expect.element(screen.getByText("Panel")).toBeVisible();
  await expect.element(screen.getByText("Workflow")).toBeVisible();
});

it("shows the inline permission modes with the current one marked", async () => {
  await using screen = await render(<MenuHarness items={permissionModeItems} />, {
    router: false,
  }); // no routes involved

  await expect.element(screen.getByText("Current")).toBeVisible();
  const disabledItem = screen
    .getByText("Full access")
    .element()
    .closest<HTMLElement>(`[data-composer-item-id]`);
  expect(disabledItem?.getAttribute("aria-disabled")).toBe("true");
  await expect.element(screen.getByText("Blocked by your administrator.")).toBeVisible();
});

it("selects an enabled permission mode but not a disabled one", async () => {
  const onSelect = vi.fn();
  const enabledMode = permissionModeItems[0]!;
  const disabledMode = permissionModeItems[1]!;
  await using screen = await render(
    <MenuHarness items={permissionModeItems} onSelect={onSelect} />,
    {
      router: false,
    },
  ); // no routes involved

  await userEvent.click(screen.getByText("Full access"));
  expect(onSelect).not.toHaveBeenCalled();

  await userEvent.click(screen.getByText("Supervised"));
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onSelect).toHaveBeenCalledWith(enabledMode);
  expect(onSelect).not.toHaveBeenCalledWith(disabledMode);
});
