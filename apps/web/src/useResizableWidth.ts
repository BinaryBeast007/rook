import { useCallback, useState } from "react";

import { usePersistentState } from "./usePersistentState.ts";

/**
 * Rounds and clamps to [min, max]. `cap` is an extra measured upper limit (e.g.
 * the room left beside other content); it never pushes the width below min.
 */
export function clampWidth(
  width: number,
  bounds: { min: number; max: number },
  cap?: number,
): number {
  return Math.round(Math.max(bounds.min, Math.min(bounds.max, cap ?? Infinity, width)));
}

/**
 * A width remembered across launches under `key`. During a drag the width lives
 * in a draft so storage is written once, when the drag ends. `cap` is read at
 * preview and commit time.
 */
export function useResizableWidth(
  key: string,
  bounds: { min: number; default: number; max: number },
  cap?: () => number,
) {
  const { min, max } = bounds;
  const [width, setWidth] = usePersistentState(key, bounds.default, (raw) => {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampWidth(parsed, { min, max }) : undefined;
  });
  const [draftWidth, setDraftWidth] = useState<number>();

  const previewWidth = useCallback(
    (next: number) => setDraftWidth(clampWidth(next, { min, max }, cap?.())),
    [min, max, cap],
  );
  const commitWidth = useCallback(
    (next: number) => {
      setWidth(clampWidth(next, { min, max }, cap?.()));
      setDraftWidth(undefined);
    },
    [min, max, cap, setWidth],
  );

  return {
    width: draftWidth ?? width,
    resizing: draftWidth !== undefined,
    previewWidth,
    commitWidth,
  };
}
