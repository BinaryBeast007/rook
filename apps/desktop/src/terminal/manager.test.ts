// Real pseudo-terminals running the platform's default shell (PowerShell on Windows).
import { TerminalChannel, type TerminalEvent } from "@rook/contracts";
import type { IpcMainInvokeEvent } from "electron";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import { afterEach, expect, test } from "vite-plus/test";

import { tempDir } from "../agents/testing/fakeBin.ts";
import { ChatRuntimeError } from "../chat/runtime.ts";
import type { WorkspaceContext } from "../workspace/context.ts";
import { registerTerminalHandlers } from "./index.ts";
import { TerminalManager, type Shell } from "./manager.ts";

const isWindows = process.platform === "win32";
const SLOW = 30_000;
const SIZE = { cols: 200, rows: 30 };
// Cheap stand-in for a shell where the test doesn't need one.
const idle: () => Shell = () => ({
  file: process.execPath,
  args: ["-e", "setInterval(() => {}, 1000)"],
  title: "node",
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fakeContext() {
  const events: TerminalEvent[] = [];
  const chats = new Map<string, string>();
  const deleted: ((chatId: string) => void)[] = [];
  const context: WorkspaceContext = {
    cwd: (chatId) => {
      const cwd = typeof chatId === "string" ? chats.get(chatId) : undefined;
      if (!cwd) throw new ChatRuntimeError("That chat no longer exists.");
      return cwd;
    },
    env: () => process.env,
    send: (channel, payload) => {
      expect(channel).toBe(TerminalChannel.event);
      events.push(payload as TerminalEvent);
    },
    busy: () => false,
    onChatDeleted: (listener) => void deleted.push(listener),
  };
  // Output with escape sequences removed, as ConPTY repaints with them.
  const output = (id: string) =>
    events
      .flatMap((event) => (event.type === "data" && event.id === id ? [event.data] : []))
      .join("")
      // oxlint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[=>]/g, "");
  return { context, events, chats, deleted, output };
}

async function setup(options?: ConstructorParameters<typeof TerminalManager>[1]) {
  const fake = fakeContext();
  const cwd = await tempDir("rook-terminal-");
  fake.chats.set("chat-a", cwd);
  const manager = new TerminalManager(fake.context, options);
  cleanups.push(() => manager.dispose());
  return { ...fake, cwd, manager };
}

/** Polls `check` until it returns something truthy. */
function waitFor<T>(check: () => T | Promise<T>, ms = 20_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  const poll = async (): Promise<NonNullable<T>> => {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await new Promise((resolve) => setTimeout(resolve, 25));
    return poll();
  };
  return poll();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A command line that runs Node on `script` with `args`, in the default shell's syntax. */
function runNode(script: string, ...args: string[]): string {
  const quoted = [process.execPath, script, ...args].map((arg) => `'${arg}'`).join(" ");
  return `${isWindows ? "& " : ""}${quoted}\r`;
}

/** Starts a Node process that starts another, both idling; resolves with both pids. */
async function startTree(manager: TerminalManager, id: string, dir: string): Promise<number[]> {
  const script = NodePath.join(dir, "tree.cjs");
  const pidFile = NodePath.join(dir, "pids.txt");
  await writeFile(
    script,
    `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
require("node:fs").writeFileSync(process.argv[2], process.pid + " " + child.pid);
setInterval(() => {}, 1000);
`,
  );
  manager.write(id, runNode(script, pidFile));
  const pids = await waitFor(async () => {
    const text = await readFile(pidFile, "utf8").catch(() => "");
    return /^\d+ \d+$/.test(text) ? text.split(" ").map(Number) : null;
  });
  expect(pids.every(alive)).toBe(true);
  return pids;
}

const printCwd = isWindows ? "(Get-Location).Path" : "pwd";
const printMarker = isWindows ? `Write-Output ("mark" + "er-" + 42)` : `echo "mark""er-$((40+2))"`;
const printWidth = isWindows
  ? `Write-Output ("W=" + $Host.UI.RawUI.WindowSize.Width)`
  : `echo "W=$(stty size | cut -d' ' -f2)"`;

test(
  "runs commands in the chat's folder and echoes input",
  async () => {
    const { manager, cwd, output } = await setup();
    const info = manager.create("chat-a", SIZE);
    expect(info).toMatchObject({ chatId: "chat-a", cwd, exitCode: null });
    if (isWindows) expect(info.title).toMatch(/^(pwsh|powershell)$/);
    // Typed input comes back from the shell's line editor before it runs.
    manager.write(info.id, "echo rookroundtrip");
    await waitFor(() => output(info.id).includes("rookroundtrip"));
    manager.write(info.id, `\r${printCwd}\r${printMarker}\r`);
    await waitFor(() => output(info.id).includes("marker-42"));
    const text = output(info.id);
    // The shell prints the long path; TEMP can be an 8.3 short one (C:\Users\RUNNER~1 on CI).
    const shown = isWindows ? realpathSync.native(cwd).toLowerCase() : cwd;
    expect(isWindows ? text.toLowerCase() : text).toContain(shown);
  },
  SLOW,
);

test(
  "attach replays the kept output and ends at the last sent seq",
  async () => {
    const { manager, events, output } = await setup();
    const info = manager.create("chat-a", SIZE);
    manager.write(info.id, `${printMarker}\r`);
    await waitFor(() => output(info.id).includes("marker-42"));
    const attached = manager.attach(info.id);
    const sent = events.filter((event) => event.type === "data");
    expect(attached.seq).toBe(sent.at(-1)!.seq);
    expect(attached.buffer).toBe(sent.map((event) => event.data).join(""));
    expect(attached.info).toEqual(info);
    expect(manager.list("chat-a")).toEqual([info]);
    expect(manager.list("chat-b")).toEqual([]);
  },
  SLOW,
);

test(
  "resizes the terminal",
  async () => {
    const { manager, output } = await setup();
    const info = manager.create("chat-a", SIZE);
    await waitFor(() => output(info.id).length > 0);
    manager.resize(info.id, { cols: 123, rows: 31 });
    manager.resize(info.id, { cols: 123, rows: 31 });
    manager.write(info.id, `${printWidth}\r`);
    await waitFor(() => output(info.id).includes("W=123"));
    // Out-of-range sizes are clamped rather than rejected.
    expect(() => manager.resize(info.id, { cols: 100_000, rows: 0 })).not.toThrow();
  },
  SLOW,
);

test(
  "reports the exit code and keeps the session until killed",
  async () => {
    const { manager, events } = await setup();
    const info = manager.create("chat-a", SIZE);
    manager.write(info.id, "exit 3\r");
    await waitFor(() => events.some((event) => event.type === "exit"));
    expect(events.filter((event) => event.type === "exit")).toEqual([
      { type: "exit", id: info.id, exitCode: 3 },
    ]);
    expect(manager.list("chat-a")).toEqual([{ ...info, exitCode: 3 }]);
    // An exited session ignores input and resizes, but still replays.
    manager.write(info.id, "ignored\r");
    manager.resize(info.id, { cols: 80, rows: 24 });
    expect(manager.attach(info.id).info.exitCode).toBe(3);
    manager.kill(info.id);
    expect(events.at(-1)).toEqual({ type: "closed", id: info.id });
    expect(manager.list("chat-a")).toEqual([]);
    expect(() => manager.attach(info.id)).toThrow(ChatRuntimeError);
  },
  SLOW,
);

test(
  "kill ends the shell's whole process tree",
  async () => {
    const { manager, cwd, events } = await setup();
    const info = manager.create("chat-a", SIZE);
    const pids = await startTree(manager, info.id, cwd);
    manager.kill(info.id);
    expect(events.at(-1)).toEqual({ type: "closed", id: info.id });
    await waitFor(() => !pids.some(alive), 15_000);
  },
  SLOW,
);

test("enforces session limits", async () => {
  const { manager, chats, cwd } = await setup({ shell: idle, limits: { perChat: 2, total: 3 } });
  chats.set("chat-b", cwd);
  manager.create("chat-a", SIZE);
  manager.create("chat-a", SIZE);
  expect(() => manager.create("chat-a", SIZE)).toThrow(/up to 2 terminals/);
  manager.create("chat-b", SIZE);
  expect(() => manager.create("chat-b", SIZE)).toThrow(/up to 3 terminals at once/);
  manager.kill(manager.list("chat-a")[0]!.id);
  expect(() => manager.create("chat-b", SIZE)).not.toThrow();
});

test("validates everything the renderer sends", async () => {
  const { manager } = await setup({ shell: idle, limits: { write: 8 } });
  expect(() => manager.create("chat-x", SIZE)).toThrow(/no longer exists/);
  expect(() => manager.create(42, SIZE)).toThrow(ChatRuntimeError);
  for (const size of [null, undefined, 5, {}, { cols: "80", rows: 24 }, { cols: 80.5, rows: 24 }]) {
    expect(() => manager.create("chat-a", size)).toThrow(/Invalid terminal size/);
  }
  const info = manager.create("chat-a", { cols: -4, rows: 9999 });
  for (const id of [undefined, 42, "", "nope", { id: info.id }]) {
    if (typeof id !== "string") expect(() => manager.write(id, "x")).toThrow(/has closed/);
    // Input for a session that just closed is dropped.
    else expect(() => manager.write(id, "x")).not.toThrow();
    expect(() => manager.resize(id, SIZE)).toThrow(/has closed/);
    expect(() => manager.attach(id)).toThrow(/has closed/);
    expect(() => manager.kill(id)).toThrow(/has closed/);
  }
  expect(() => manager.write(info.id, 42)).toThrow(/Invalid terminal input/);
  expect(() => manager.write(info.id, "x".repeat(9))).toThrow(/too large/);
  expect(() => manager.write(info.id, "x".repeat(8))).not.toThrow();
  expect(() => manager.resize(info.id, { cols: 1, rows: Number.NaN })).toThrow(/Invalid/);
  expect(manager.list(42)).toEqual([]);
});

test("reports a shell that can't start", async () => {
  const { manager } = await setup({
    shell: () => ({
      file: NodePath.join(process.cwd(), "no-such-shell.exe"),
      args: [],
      title: "x",
    }),
  });
  // On Windows spawning fails outright; elsewhere the child exits once exec fails.
  try {
    const info = manager.create("chat-a", SIZE);
    expect(isWindows).toBe(false);
    await waitFor(() => manager.list("chat-a")[0]?.exitCode !== null && info);
  } catch (error) {
    expect(error).toBeInstanceOf(ChatRuntimeError);
    expect((error as Error).message).toMatch(/^Couldn't start x: /);
  }
});

test(
  "the IPC handlers kill a deleted chat's sessions and dispose of the rest",
  async () => {
    const { context, events, chats, deleted } = fakeContext();
    const cwd = await tempDir("rook-terminal-");
    chats.set("chat-a", cwd);
    chats.set("chat-b", cwd);
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const tool = registerTerminalHandlers(context, (channel, handler) => {
      handlers.set(channel, handler);
    });
    cleanups.push(() => tool.dispose());
    expect([...handlers.keys()].toSorted()).toEqual(
      Object.values(TerminalChannel)
        .filter((channel) => channel !== TerminalChannel.event)
        .toSorted(),
    );
    const call = (channel: string, ...args: unknown[]) =>
      handlers.get(channel)!({} as IpcMainInvokeEvent, ...args);

    const a = call(TerminalChannel.create, "chat-a", SIZE) as { id: string };
    const b = call(TerminalChannel.create, "chat-b", SIZE) as { id: string };
    const manager = { write: (id: string, data: string) => call(TerminalChannel.write, id, data) };
    const pids = await startTree(manager as TerminalManager, b.id, cwd);

    for (const listener of deleted) listener("chat-a");
    expect(events.at(-1)).toEqual({ type: "closed", id: a.id });
    expect(call(TerminalChannel.list, "chat-a")).toEqual([]);
    expect(call(TerminalChannel.list, "chat-b")).toHaveLength(1);

    const before = events.length;
    tool.dispose();
    expect(call(TerminalChannel.list, "chat-b")).toEqual([]);
    await waitFor(() => !pids.some(alive), 15_000);
    // Quitting sends nothing more: no "closed", and no late output from the dying shells.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events.slice(before)).toEqual([]);
  },
  SLOW,
);
