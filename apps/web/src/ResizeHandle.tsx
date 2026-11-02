import { useRef, type KeyboardEvent } from "react";

const KEYBOARD_STEP = 16;

interface ResizeHandleProps {
  /** id of the element being resized. */
  controls: string;
  /** aria-label, e.g. "Resize sidebar". */
  label: string;
  /** The element's width, or its height for a top or bottom edge. */
  width: number;
  min: number;
  max: number;
  /** Width a double-click resets to. */
  fallback: number;
  /** Which edge of the resized element the handle sits on. */
  edge: "right" | "left" | "top" | "bottom";
  resizing: boolean;
  /** Live width while dragging. */
  onPreview: (width: number) => void;
  /** Final width: drag end, keyboard, or reset. */
  onCommit: (width: number) => void;
}

/**
 * Window-splitter for an element's edge (WAI-ARIA separator pattern). Drag to
 * resize, double-click to reset, or focus it and use the arrow keys, Home, and
 * End. Sits centred on the border as an 8px hit area, so callers place it in a
 * relative wrapper at the boundary (its left edge, or its top for a top or bottom edge).
 */
export function ResizeHandle({
  controls,
  label,
  width,
  min,
  max,
  fallback,
  edge,
  resizing,
  onPreview,
  onCommit,
}: ResizeHandleProps) {
  const drag = useRef<{ startX: number; startWidth: number; width: number }>(null);
  // Moving toward the outside of the edge grows the element.
  const grow = edge === "right" || edge === "bottom" ? 1 : -1;
  // A top or bottom edge splits stacked panes, so it moves up and down.
  const rows = edge === "top" || edge === "bottom";
  const [back, forward] = rows ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];

  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? KEYBOARD_STEP * 4 : KEYBOARD_STEP;
    const next = {
      [back]: width - step * grow,
      [forward]: width + step * grow,
      Home: min,
      End: max,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onCommit(next);
  };

  return (
    <div
      role="separator"
      aria-orientation={rows ? "horizontal" : "vertical"}
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      title={`Drag to resize, double-click to reset to ${fallback}px`}
      data-resizing={resizing || undefined}
      className={`group app-region-no-drag absolute z-10 touch-none outline-none ${rows ? "inset-x-0 -top-1 h-2 cursor-row-resize" : "inset-y-0 -left-1 w-2 cursor-col-resize"}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startX: rows ? event.clientY : event.clientX, startWidth: width, width };
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        if (!state) return;
        state.width =
          state.startWidth + ((rows ? event.clientY : event.clientX) - state.startX) * grow;
        onPreview(state.width);
      }}
      // Fires after pointerup and on cancel, so it ends every drag exactly once.
      onLostPointerCapture={() => {
        const state = drag.current;
        if (!state) return;
        drag.current = null;
        onCommit(state.width);
      }}
      onDoubleClick={() => onCommit(fallback)}
      onKeyDown={onKeyDown}
    >
      <div
        className={`absolute transition-colors group-hover:bg-white/20 group-focus-visible:bg-white/40 group-data-resizing:bg-white/30 motion-reduce:transition-none ${rows ? "inset-x-0 bottom-1/2 h-px" : "inset-y-0 right-1/2 w-px"}`}
      />
      <div
        className={`absolute top-1/2 left-1/2 -translate-1/2 rounded-full ${rows ? "h-1 w-8" : "h-8 w-1"} bg-white/40 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-resizing:opacity-100 motion-reduce:transition-none`}
      />
    </div>
  );
}
