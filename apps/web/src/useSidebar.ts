import { useCallback, useEffect } from "react";

import { desktop } from "./desktop.ts";
import { usePersistentState } from "./usePersistentState.ts";
import { useResizableWidth } from "./useResizableWidth.ts";

const isMac = desktop ? desktop.platform === "darwin" : /Mac/.test(navigator.platform);

export const SIDEBAR_SHORTCUT = isMac ? "⌘B" : "Ctrl+B";

/** Pixel bounds. Max leaves the main area 320px at the window's 720px minimum width. */
export const SIDEBAR_WIDTH = { min: 208, default: 256, max: 400 } as const;

/** Sidebar open state and width, both remembered across launches. */
export function useSidebar() {
  const [open, setOpen] = usePersistentState("rook:sidebar-open", true, (raw) => raw === "true");
  const width = useResizableWidth("rook:sidebar-width", SIDEBAR_WIDTH);

  const toggle = useCallback(() => setOpen((value) => !value), [setOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = isMac ? event.metaKey : event.ctrlKey;
      if (modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  return { open, toggle, ...width };
}
