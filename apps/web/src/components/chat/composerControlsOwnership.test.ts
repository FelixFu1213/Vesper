import { describe, expect, it } from "vite-plus/test";

import { resolveComposerControlsOwnership } from "./composerControlsOwnership";

const base = {
  matchesDefault: true,
  collapsed: false,
  measuredHiddenBlockCount: 0,
};

describe("resolveComposerControlsOwnership", () => {
  it("hides the chip at the default and lets the model picker answer composer.mode", () => {
    const result = resolveComposerControlsOwnership(base);
    expect(result).toMatchObject({
      accessDisplay: "hidden",
      showModeBlock: false,
      hiddenBlockIds: [],
      pickerOwnsModeShortcut: true,
    });
  });

  it("shows a labelled chip that owns composer.mode when the mode differs", () => {
    const result = resolveComposerControlsOwnership({ ...base, matchesDefault: false });
    expect(result).toMatchObject({
      accessDisplay: "label",
      showModeBlock: true,
      pickerOwnsModeShortcut: false,
    });
  });

  it("gives an overflowed chip's Permissions to the overflow menu", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      matchesDefault: false,
      measuredHiddenBlockCount: 1,
    });
    expect(result.hiddenBlockIds).toEqual(["mode"]);
    expect(result.overflowShowsPermissions).toBe(true);
    expect(result.pickerOwnsModeShortcut).toBe(false);
  });

  it("shows the non-default chip as an icon in the compacted row", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      matchesDefault: false,
      collapsed: true,
    });
    expect(result.accessDisplay).toBe("icon");
  });

  it("keeps the mode block for the Plan toggle at the default", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      planModeUiEnabled: true,
    });
    expect(result.accessDisplay).toBe("hidden");
    expect(result.showModeBlock).toBe(true);
    expect(result.hiddenBlockIds).toEqual([]);
    expect(result.overflowShowsPermissions).toBe(false);
    expect(result.pickerOwnsModeShortcut).toBe(true);
  });

  it("does not move Permissions into an overflow the Plan toggle fills", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      matchesDefault: false,
      planModeUiEnabled: true,
      measuredHiddenBlockCount: 1,
    });
    expect(result.hiddenBlockIds).toEqual(["mode"]);
    // Permissions stay in the model picker, which now answers composer.mode.
    expect(result.overflowShowsPermissions).toBe(false);
    expect(result.pickerOwnsModeShortcut).toBe(true);
  });

  it("keeps the overflowed chip's Permissions when no Plan toggle exists", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      matchesDefault: false,
      planModeUiEnabled: false,
      measuredHiddenBlockCount: 1,
    });
    expect(result.overflowShowsPermissions).toBe(true);
    expect(result.hiddenBlockIds).toEqual(["mode"]);
  });
});
