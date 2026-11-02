import { expect, test } from "vite-plus/test";

import {
  closePane,
  MAX_PANES,
  neighborOf,
  setSession,
  singlePane,
  splitPane,
  validLayout,
  type TerminalLayout,
} from "./layout.ts";

const ids = (layout: TerminalLayout | null) => layout?.panes.map((pane) => pane.id);

test("a split adds a pane after the one split, and sets every pane's direction", () => {
  let layout = splitPane(singlePane("a"), "a", "b", "row");
  expect(layout).toEqual({ panes: [{ id: "a" }, { id: "b" }], direction: "row" });
  layout = splitPane(layout, "a", "c", "column");
  expect(ids(layout)).toEqual(["a", "c", "b"]);
  expect(layout.direction).toBe("column");
});

test(`a tab holds ${MAX_PANES} panes at most, and a split of a gone pane does nothing`, () => {
  let layout = singlePane("p0");
  for (let n = 1; n < MAX_PANES; n++) layout = splitPane(layout, `p${n - 1}`, `p${n}`, "row");
  expect(layout.panes).toHaveLength(MAX_PANES);
  expect(splitPane(layout, "p0", "extra", "column")).toBe(layout);
  expect(splitPane(singlePane("a"), "gone", "b", "row")).toEqual(singlePane("a"));
});

test("closing a pane keeps the rest; closing the last leaves nothing", () => {
  const layout = splitPane(
    splitPane(singlePane("a", "pty-a"), "a", "b", "column"),
    "b",
    "c",
    "column",
  );
  expect(closePane(layout, "b")).toEqual({
    panes: [{ id: "a", terminalId: "pty-a" }, { id: "c" }],
    direction: "column",
  });
  expect(closePane(layout, "gone")).toBe(layout);
  expect(closePane(singlePane("a"), "a")).toBeNull();
});

test("focus moves to the next pane on close, else the one before", () => {
  const layout = splitPane(splitPane(singlePane("a"), "a", "b", "row"), "b", "c", "row");
  expect(neighborOf(layout, "a")).toBe("b");
  expect(neighborOf(layout, "b")).toBe("c");
  expect(neighborOf(layout, "c")).toBe("b");
  expect(neighborOf(singlePane("a"), "a")).toBeUndefined();
  expect(neighborOf(layout, "gone")).toBeUndefined();
});

test("a pane remembers its session", () => {
  const layout = splitPane(singlePane("a"), "a", "b", "row");
  expect(setSession(layout, "b", "pty-b").panes).toEqual([
    { id: "a" },
    { id: "b", terminalId: "pty-b" },
  ]);
  expect(setSession(layout, "gone", "pty")).toBe(layout);
});

test("saved layouts are validated", () => {
  expect(
    validLayout({
      panes: [
        { id: "a", terminalId: "pty-a", extra: true },
        { id: "a" },
        { id: 3 },
        { id: "b", terminalId: 4 },
        null,
        { id: "c" },
        { id: "d" },
        { id: "e" },
        { id: "f" },
      ],
      direction: "sideways",
    }),
  ).toEqual({
    panes: [{ id: "a", terminalId: "pty-a" }, { id: "c" }, { id: "d" }, { id: "e" }],
    direction: "row",
  });
  expect(validLayout({ panes: [{ id: "a" }], direction: "column" })?.direction).toBe("column");
  expect(validLayout({ panes: [] })).toBeUndefined();
  expect(validLayout(null)).toBeUndefined();
  expect(validLayout({ panes: "a" })).toBeUndefined();
});
