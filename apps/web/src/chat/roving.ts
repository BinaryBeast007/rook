// Roving focus for the footer pickers' lists: one item is tabbable, the arrow keys move focus.
import type { KeyboardEvent } from "react";

/**
 * The index an arrow, Home or End key moves to in a list of `length` items, wrapping around;
 * null for any other key. `at` is -1 when no item has focus.
 */
export function stepIndex(key: string, at: number, length: number): number | null {
  if (length === 0) return null;
  switch (key) {
    case "ArrowDown":
      return (at + 1) % length;
    case "ArrowUp":
      return at <= 0 ? length - 1 : at - 1;
    case "Home":
      return 0;
    case "End":
      return length - 1;
    default:
      return null;
  }
}

/** Moves focus between the `[data-rove]` items inside the element that handles the key. */
export function roveFocus(event: KeyboardEvent<HTMLElement>): void {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-rove]")];
  const next = stepIndex(
    event.key,
    items.indexOf(document.activeElement as HTMLElement),
    items.length,
  );
  if (next === null) return;
  event.preventDefault();
  items[next]?.focus();
}
