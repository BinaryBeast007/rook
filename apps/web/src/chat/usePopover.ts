import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/**
 * A disclosure popover: closes on Escape (focus returns to its button) or on a press outside.
 * Put `rootRef` and `onKeyDown` on the element that holds both the button and the panel.
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Escape belongs to the popover, not the composer or view behind it.
  const onKeyDown = (event: KeyboardEvent) => {
    if (open && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  return { open, setOpen, close, rootRef, triggerRef, onKeyDown };
}
