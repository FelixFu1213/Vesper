import { createContext } from "react";

import type { SplitPaneSide } from "../../splitThreadStore";

export interface SplitPaneContextValue {
  readonly splitOpen: boolean;
  readonly side: SplitPaneSide;
  readonly focused: boolean;
  readonly rightPanelPortalHost: HTMLElement | null;
  readonly workspaceLayoutElement: HTMLElement | null;
  readonly onFocusPane: () => void;
  readonly onCloseSplitPane: () => void;
  readonly onSwapSplitPanes: () => void;
}

export const SplitPaneContext = createContext<SplitPaneContextValue | null>(null);
