import { expect, test } from "vite-plus/test";

import {
  closeTab,
  cycleTab,
  NO_TABS,
  openChat,
  openTool,
  parseTabMap,
  parseTabs,
  pruneChats,
  revealTool,
  tabLabels,
  terminalLayout,
  updateTerminal,
  type Tabs,
} from "./tabs.ts";
import { setSession, singlePane, splitPane } from "../tools/terminal/layout.ts";

test("Browser and Terminal open a new tab each time; Changes and Files reuse theirs", () => {
  let tabs = openTool(NO_TABS, "browser", "b1");
  tabs = openTool(tabs, "browser", "b2");
  tabs = openTool(tabs, "changes", "c1");
  tabs = openTool(tabs, "terminal", "t1");
  tabs = openTool(tabs, "changes", "c2");
  expect(tabs.list.map((tab) => tab.id)).toEqual(["b1", "b2", "c1", "t1"]);
  expect(tabs.active).toBe("c1");
});

test("reuse shows an open tab of the tool instead of adding one", () => {
  const tabs = openTool(openTool(NO_TABS, "terminal", "t1"), "files", "f1");
  expect(openTool(tabs, "terminal", "t2", true)).toEqual({ list: tabs.list, active: "t1" });
  expect(openTool(tabs, "browser", "b1", true).active).toBe("b1");
});

test("closing the active tab activates the one that takes its place, else the last", () => {
  const tabs: Tabs = {
    list: ["a", "b", "c"].map((id) => ({ id, tool: "browser" })),
    active: "b",
  };
  expect(closeTab(tabs, "b").active).toBe("c");
  expect(closeTab({ ...tabs, active: "c" }, "c").active).toBe("b");
  expect(closeTab(tabs, "a")).toEqual({ list: tabs.list.slice(1), active: "b" });
  expect(closeTab({ list: [tabs.list[0]!], active: "a" }, "a")).toEqual(NO_TABS);
  expect(closeTab(tabs, "missing")).toBe(tabs);
});

test("saved tabs are validated", () => {
  const split = { panes: [{ id: "p1", terminalId: "pty-2" }, { id: "p2" }], direction: "column" };
  const saved = JSON.stringify({
    list: [
      { id: "t1", tool: "terminal", terminalId: "pty-1", title: "bash" },
      { id: "t2", tool: "terminal", terminal: split, title: "bash" },
      { id: "t3", tool: "terminal", terminal: { panes: [] }, terminalId: 7 },
      { id: "x", tool: "canvas" },
      { id: 4, tool: "files" },
      { id: "f1", tool: "files", title: 5 },
      null,
      { id: "b1", tool: "browser", terminal: split },
    ],
    active: "gone",
  });
  expect(parseTabs(saved)).toEqual({
    list: [
      // Saved before splits: its one session becomes its one pane.
      {
        id: "t1",
        tool: "terminal",
        terminal: { panes: [{ id: "t1", terminalId: "pty-1" }], direction: "row" },
        title: "bash",
      },
      { id: "t2", tool: "terminal", terminal: split, title: "bash" },
      { id: "t3", tool: "terminal" },
      { id: "b1", tool: "browser" },
    ],
    active: "b1",
  });
  expect(parseTabs("null")).toBeUndefined();
  expect(parseTabs('{"list":[]}')).toEqual(NO_TABS);
});

test("a Terminal tab's panes change in place, and its first session names it", () => {
  const tabs = openTool(openTool(NO_TABS, "terminal", "t1"), "files", "f1");
  expect(terminalLayout(tabs.list[0]!)).toEqual(singlePane("t1"));

  const named = updateTerminal(tabs, "t1", (layout) => setSession(layout, "t1", "pty-1"), "bash");
  expect(named.list[0]).toEqual({
    id: "t1",
    tool: "terminal",
    terminal: singlePane("t1", "pty-1"),
    title: "bash",
  });
  expect(named.active).toBe("f1");

  const split = updateTerminal(named, "t1", (layout) => splitPane(layout, "t1", "p2", "row"));
  expect(terminalLayout(split.list[0]!).panes.map((pane) => pane.id)).toEqual(["t1", "p2"]);
  expect(split.list[0]!.title).toBe("bash");
  expect(split.list[1]).toBe(named.list[1]);

  // Nothing changed: the same tabs, so nothing re-renders or saves.
  expect(updateTerminal(named, "t1", (layout) => layout, "bash")).toBe(named);
  expect(updateTerminal(named, "gone", () => singlePane("x"))).toBe(named);
});

test("tabs sharing a name are numbered", () => {
  const list = [
    { id: "1", tool: "terminal", title: "bash" },
    { id: "2", tool: "browser" },
    { id: "3", tool: "terminal", title: "bash" },
    { id: "4", tool: "terminal", title: "pwsh" },
  ] as const;
  const labels = tabLabels(list, (tab) => tab.title ?? tab.tool);
  expect([...labels.values()]).toEqual(["bash", "browser", "bash 2", "pwsh"]);
});

test("a chat opens one tab, and opening it again just shows it", () => {
  let tabs = openChat(NO_TABS, "chat-1", "a");
  tabs = openTool(tabs, "terminal", "t1");
  tabs = openChat(tabs, "chat-1", "b");
  expect(tabs.list.map((tab) => tab.id)).toEqual(["a", "t1"]);
  expect(tabs.active).toBe("a");
  expect(openChat(tabs, "chat-1", "c")).toBe(tabs);
  expect(openChat(tabs, "chat-2", "c").list.at(-1)).toEqual({
    id: "c",
    tool: "chat",
    chatId: "chat-2",
  });
});

test("deleted chats lose their tabs; other tabs stay put", () => {
  let tabs = openChat(NO_TABS, "keep", "a");
  tabs = openChat(tabs, "gone", "b");
  tabs = openTool(tabs, "browser", "c");
  tabs = { ...tabs, active: "b" };
  const pruned = pruneChats(tabs, (id) => id === "keep");
  expect(pruned.list.map((tab) => tab.id)).toEqual(["a", "c"]);
  expect(pruned.active).toBe("c");
  expect(pruneChats(pruned, () => true)).toBe(pruned);
});

test("cycling wraps around both ends", () => {
  const tabs: Tabs = { list: ["a", "b", "c"].map((id) => ({ id, tool: "files" })), active: "c" };
  expect(cycleTab(tabs, 1).active).toBe("a");
  expect(cycleTab({ ...tabs, active: "a" }, -1).active).toBe("c");
  expect(cycleTab(NO_TABS, 1)).toBe(NO_TABS);
});

test("saved tab maps drop malformed workspaces and chat tabs without a chat", () => {
  const raw = JSON.stringify({
    "project:p1": {
      list: [
        { id: "a", tool: "chat", chatId: "c1" },
        { id: "b", tool: "chat" },
        { id: "c", tool: "browser", chatId: "c1" },
      ],
      active: "b",
    },
    broken: { list: "nope" },
  });
  expect(parseTabMap(raw)).toEqual({
    "project:p1": { list: [{ id: "a", tool: "chat", chatId: "c1" }], active: "a" },
  });
  expect(parseTabMap("[]")).toBeUndefined();
});

test("a file opens in Files and a diff in Changes", () => {
  expect(revealTool({ kind: "file", path: "a.ts", line: 3 })).toBe("files");
  expect(revealTool({ kind: "worktree" })).toBe("changes");
  expect(revealTool({ kind: "range", from: "a", to: "b", label: "This turn" })).toBe("changes");
});
