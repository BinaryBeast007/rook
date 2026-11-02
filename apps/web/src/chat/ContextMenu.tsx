import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";

import { clampMenu, isMenuKey, type Point } from "./contextMenu.ts";
import { FOCUS } from "./Picker.tsx";
import { roveFocus } from "./roving.ts";

/** Where a keyboard-opened menu goes: just under its element. */
function below(element: HTMLElement): Point {
  const box = element.getBoundingClientRect();
  return { x: box.left, y: box.bottom + 4 };
}

export interface MenuItem {
  readonly label: string;
  readonly onSelect: () => void;
}

/**
 * A right-click menu for one element: spread `triggerProps` on it and render `menu` beside it
 * (not inside, so a pick does not also click it). Opens on right-click, the ContextMenu key or
 * Shift+F10; closes on Escape or Tab (focus returns to the element), a pick, a press outside,
 * or a scroll.
 */
export function useContextMenu(label: string, items: () => readonly MenuItem[]) {
  const [at, setAt] = useState<Point | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const openAt = (element: HTMLElement, point: Point) => {
    trigger.current = element;
    setAt(point);
  };
  const close = useCallback((refocus: boolean) => {
    setAt(null);
    if (refocus) trigger.current?.focus();
  }, []);
  return {
    triggerProps: {
      // Not a menu button: the trigger's own action opens the file; the menu is a context menu.
      "aria-keyshortcuts": "Shift+F10",
      "data-open": at === null ? undefined : "",
      onContextMenu: (event: MouseEvent<HTMLElement>) => {
        event.preventDefault();
        // A keyboard-opened context menu reports no pointer position.
        const fromKey = event.clientX === 0 && event.clientY === 0;
        openAt(
          event.currentTarget,
          fromKey ? below(event.currentTarget) : { x: event.clientX, y: event.clientY },
        );
      },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (!isMenuKey(event)) return;
        event.preventDefault();
        openAt(event.currentTarget, below(event.currentTarget));
      },
    },
    menu: at && <ContextMenu at={at} label={label} items={items()} onClose={close} />,
  };
}

function ContextMenu({
  at,
  label,
  items,
  onClose,
}: {
  at: Point;
  label: string;
  items: readonly MenuItem[];
  onClose: (refocus: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState(at);

  useLayoutEffect(() => {
    const menu = ref.current!;
    const box = menu.getBoundingClientRect();
    setPlace(clampMenu(at, box.width, box.height, { width: innerWidth, height: innerHeight }));
    menu.querySelector<HTMLElement>("[data-rove]")?.focus();
  }, [at]);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose(false);
    };
    // A fixed menu would drift from what it belongs to.
    const onScroll = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) onClose(false);
    };
    const onBlur = () => onClose(false);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ left: place.x, top: place.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        // Keys belong to the menu, not the chat behind it.
        event.stopPropagation();
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          onClose(true);
        } else roveFocus(event);
      }}
      className="fixed z-50 min-w-44 space-y-px rounded-xl border border-white/8 bg-raised p-1.5 shadow-2xl motion-safe:animate-dialog-in"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          data-rove
          onClick={() => {
            onClose(true);
            item.onSelect();
          }}
          className={`flex w-full rounded-md px-2.5 py-1.5 text-left text-sm text-neutral-200 transition-colors hover:bg-white/6 focus-visible:bg-white/6 motion-reduce:transition-none ${FOCUS}`}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
