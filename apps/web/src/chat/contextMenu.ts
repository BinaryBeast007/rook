// Where a context menu opens and which keys open it.

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The ContextMenu key or Shift+F10: the keyboard's right-click. */
export function isMenuKey(event: { readonly key: string; readonly shiftKey: boolean }): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

/** The top-left corner that keeps a `width`×`height` menu opened at `at` inside the viewport. */
export function clampMenu(
  at: Point,
  width: number,
  height: number,
  viewport: { readonly width: number; readonly height: number },
  margin = 8,
): Point {
  const fit = (start: number, size: number, limit: number) =>
    Math.max(margin, Math.min(start, limit - size - margin));
  return { x: fit(at.x, width, viewport.width), y: fit(at.y, height, viewport.height) };
}
