// A Terminal tab's panes: up to MAX_PANES shells, side by side ("row") or stacked ("column").
// Pure, so the rules are unit tested; TerminalView renders them.

export const MAX_PANES = 4;

export type Direction = "row" | "column";

export interface Pane {
  readonly id: string;
  /** The pane's session, once it has started one. */
  readonly terminalId?: string;
}

export interface TerminalLayout {
  readonly panes: readonly Pane[];
  readonly direction: Direction;
}

/** A tab's layout before it's split: one pane, named after the tab so it's stable unsaved. */
export function singlePane(id: string, terminalId?: string): TerminalLayout {
  return { panes: [terminalId === undefined ? { id } : { id, terminalId }], direction: "row" };
}

/**
 * Adds a pane after `after` and lays every pane out in `direction`. Unchanged when the tab is
 * full or `after` is gone.
 */
export function splitPane(
  layout: TerminalLayout,
  after: string,
  newId: string,
  direction: Direction,
): TerminalLayout {
  const index = layout.panes.findIndex((pane) => pane.id === after);
  if (index === -1 || layout.panes.length >= MAX_PANES) return layout;
  const panes = layout.panes.toSpliced(index + 1, 0, { id: newId });
  return { panes, direction };
}

/** Removes a pane; null when it was the last, as the tab then closes. */
export function closePane(layout: TerminalLayout, id: string): TerminalLayout | null {
  const panes = layout.panes.filter((pane) => pane.id !== id);
  if (panes.length === layout.panes.length) return layout;
  return panes.length === 0 ? null : { ...layout, panes };
}

/** The pane that takes focus when `id` closes: the next one, else the one before. */
export function neighborOf(layout: TerminalLayout, id: string): string | undefined {
  const index = layout.panes.findIndex((pane) => pane.id === id);
  if (index === -1) return undefined;
  return (layout.panes[index + 1] ?? layout.panes[index - 1])?.id;
}

export function setSession(layout: TerminalLayout, id: string, terminalId: string): TerminalLayout {
  if (!layout.panes.some((pane) => pane.id === id)) return layout;
  const panes = layout.panes.map((pane) => (pane.id === id ? { ...pane, terminalId } : pane));
  return { ...layout, panes };
}

/** A layout saved by an earlier run; drops malformed panes, undefined when none are left. */
export function validLayout(value: unknown): TerminalLayout | undefined {
  const layout = value as { panes?: unknown; direction?: unknown } | null;
  if (!Array.isArray(layout?.panes)) return undefined;
  const seen = new Set<string>();
  const panes = (layout.panes as Partial<Pane>[])
    .filter(
      (pane): pane is Pane =>
        typeof pane?.id === "string" &&
        !seen.has(pane.id) &&
        (pane.terminalId === undefined || typeof pane.terminalId === "string") &&
        !!seen.add(pane.id),
    )
    .slice(0, MAX_PANES)
    .map(({ id, terminalId }) => (terminalId === undefined ? { id } : { id, terminalId }));
  if (panes.length === 0) return undefined;
  return { panes, direction: layout.direction === "column" ? "column" : "row" };
}
