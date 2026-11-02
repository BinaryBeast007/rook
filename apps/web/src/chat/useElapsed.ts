import { useLayoutEffect, type RefObject } from "react";

import { formatDuration } from "./timeline.ts";

// One interval drives every ticking label on screen.
const ticks = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Writes the time since `since` into `ref`'s element once a second, straight to the DOM so the
 * component around it doesn't re-render. Leave the element's children empty in JSX. With
 * `until`, it writes the time from `since` to `until` once and doesn't tick.
 */
export function useElapsed(
  ref: RefObject<HTMLElement | null>,
  since: number,
  until: number | null = null,
) {
  useLayoutEffect(() => {
    const tick = () => {
      if (ref.current) ref.current.textContent = formatDuration((until ?? Date.now()) - since);
    };
    tick();
    if (until !== null) return;
    ticks.add(tick);
    timer ??= setInterval(() => {
      for (const each of ticks) each();
    }, 1000);
    return () => {
      ticks.delete(tick);
      if (ticks.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, [ref, since, until]);
}
