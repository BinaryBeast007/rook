// The four side tools end to end, in the built app with a throwaway profile: a real git repo,
// a real shell, a real dev server, and the change watcher keeping them in sync. The tests run
// in order on one window and build on each other's tabs.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import type { RookBridge } from "@rook/contracts";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

declare global {
  interface Window {
    readonly rook: RookBridge;
  }
}

const desktopDir = NodePath.resolve(import.meta.dirname, "..");
// ROOK_E2E_APP runs the suite against a packaged or installed build: the path to its executable.
const packagedApp = process.env.ROOK_E2E_APP;
// Resolving `electron` downloads its binary on first use (racing between suites), so a
// packaged run skips it.
const electronPath =
  packagedApp ?? (createRequire(import.meta.url)("electron") as unknown as string);

let root: string;
let project: string;
let server: Server;
let port: number;
let app: ElectronApplication;
let page: Page;
let chatId: string;
/** The chat works in the project's own folder, so its tools belong to the project's workspace. */
let ref: string;
/** The shell's name, which titles Terminal tabs ("pwsh", "bash"). */
let shell: string;

const git = (...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "-c",
      "user.name=e2e",
      "-c",
      "user.email=e2e@rook.invalid",
      ...args,
    ],
    {
      cwd: project,
      encoding: "utf8",
    },
  );

// The panel's parts, by the names users (and screen readers) know them by.
const tabStrip = () => page.getByRole("group", { name: "Tabs" });
const tab = (name: string) => tabStrip().getByRole("button", { name, exact: true });
const tabNames = () => tabStrip().locator("button[aria-pressed]").allTextContents();
const activeTab = () => tabStrip().locator('button[aria-pressed="true"]').textContent();
const panel = () => page.locator("aside#tool-panel");
const separator = () => page.getByRole("separator", { name: "Resize tool panel" });
// The list (no tabs open) or the rail (collapsed), whichever shows.
const launcher = (name: string) =>
  page
    .getByRole("navigation", { name: "Chat tools" })
    .or(page.getByRole("group", { name: "Chat tools" }))
    .getByRole("button", { name, exact: true });

/** Picks a tool from the New tab menu, with the mouse or by its letter. */
async function newTab(name: string, key?: string) {
  // The side panel's, not the workspace tab strip's.
  await panel().getByRole("button", { name: "New tab" }).click();
  const menu = page.getByRole("menu", { name: "New tab" });
  await menu.waitFor();
  // The panel sits at the window's right edge; the menu must open inside the window.
  const overflow = await menu.evaluate((element) => ({
    right: element.getBoundingClientRect().right,
    width: window.innerWidth,
    scrolls: document.documentElement.scrollWidth > window.innerWidth,
  }));
  expect(overflow.right).toBeLessThanOrEqual(overflow.width);
  expect(overflow.scrolls).toBe(false);
  if (key) await page.keyboard.press(key);
  else await menu.getByRole("menuitem", { name, exact: true }).click();
  await menu.waitFor({ state: "detached" });
}

interface SavedTab {
  id: string;
  tool: string;
  terminal?: { panes: { id: string; terminalId?: string }[]; direction: string };
  title?: string;
}
interface SavedTabs {
  list: SavedTab[];
  active: string | null;
}
const saved = () =>
  page.evaluate(
    (id) => JSON.parse(localStorage.getItem(`rook:tool-tabs:${id}`) ?? "null") as SavedTabs | null,
    ref,
  );
/** Saved tabs of `tool`, each with `terminalId`: its first pane's session, if any. */
const savedOf = async (tool: string) =>
  (await saved())!.list
    .filter((item) => item.tool === tool)
    .map((item) => Object.assign(item, { terminalId: item.terminal?.panes[0]?.terminalId }));
const sessions = () =>
  page.evaluate(
    async (id) => (await window.rook.terminal.list(id)).map((item) => item.id).toSorted(),
    ref,
  );

const width = async () => (await panel().boundingBox())!.width;
const valueNow = async () => Number(await separator().getAttribute("aria-valuenow"));
const storedWidth = () =>
  page.evaluate(() => JSON.parse(localStorage.getItem("rook:tool-panel-width") ?? "null"));
/** The chat row's width, and the chat's beside the panel. */
const row = () =>
  panel().evaluate((aside) => {
    const element = aside.parentElement!.parentElement!;
    return {
      row: element.clientWidth,
      chat: element.firstElementChild!.getBoundingClientRect().width,
    };
  });
const near = (actual: number, expected: number, slack: number) =>
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(slack);
/** The handle, the panel and storage all agree on `expected`. */
async function settled(expected: number) {
  await expect.poll(valueNow).toBe(expected);
  near(await width(), expected, 1);
  // Saving follows the commit, so it can land a moment later.
  await expect.poll(storedWidth).toBe(expected);
}

/** Tags an element, so `isTagged` later tells the same node from a remount. */
const tag = (selector: string) =>
  page.locator(selector).evaluate((node) => {
    (node as unknown as { e2eTag: boolean }).e2eTag = true;
  });
const isTagged = (selector: string) =>
  page.locator(selector).evaluate((node) => (node as unknown as { e2eTag?: boolean }).e2eTag);

/** Runs a script in the page of Browser tab `tabId`. */
const guest = (tabId: string, code: string) =>
  page.evaluate(
    ([id, source]) =>
      (
        document.querySelector(`#tool-tab-${id} webview`) as Element & {
          executeJavaScript(code: string): Promise<unknown>;
        }
      ).executeJavaScript(source),
    [tabId, code] as const,
  );

/** Types a command into the terminal of tab `tabId`. */
async function run(tabId: string, command: string) {
  const terminal = page.locator(`#tool-tab-${tabId} .xterm`);
  await terminal.waitFor();
  await terminal.click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}
const rows = (tabId: string) => page.locator(`#tool-tab-${tabId} .xterm-rows`).textContent();

/** Drags the resize handle by `dx`, checking it doesn't jump when the drag starts. */
async function drag(dx: number, check?: () => Promise<void>) {
  const box = (await separator().boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const start = await width();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - Math.sign(dx), y);
  near(await width(), start, 2);
  await page.mouse.move(x + dx, y, { steps: 10 });
  await check?.();
  await page.mouse.up();
}

beforeAll(async () => {
  if (!existsSync(NodePath.join(desktopDir, "dist-electron/main.js")))
    throw new Error("Build first: pnpm build");
  root = await mkdtemp(NodePath.join(tmpdir(), "rook-e2e-"));
  project = NodePath.join(root, "project");
  await mkdir(NodePath.join(project, "src"), { recursive: true });

  server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<title>E2E Preview</title><h1>Preview works</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;

  git("init", "-q", "-b", "main");
  await writeFile(NodePath.join(project, "README.md"), "hello\n");
  await writeFile(NodePath.join(project, "src/app.ts"), "export const answer = 42;\n");
  // The Browser tool reads port hints from package.json scripts.
  await writeFile(
    NodePath.join(project, "package.json"),
    JSON.stringify({ scripts: { dev: `vite --port ${port}` } }),
  );
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  await writeFile(NodePath.join(project, "README.md"), "hello\nchanged by e2e\n");
  await writeFile(NodePath.join(project, "notes.txt"), "untracked note\n");

  const profile = NodePath.join(root, "profile");
  await mkdir(profile);
  await writeFile(
    NodePath.join(profile, "agent-access.json"),
    JSON.stringify({ onboardingCompleted: true, authenticated: {} }),
  );
  const env = { ...process.env } as Record<string, string>;
  delete env.ROOK_DEV_SERVER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: electronPath,
    args: [...(packagedApp ? [] : [desktopDir]), `--user-data-dir=${profile}`],
    env,
  });
  // The folder picker is native UI; answer it with the test project.
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as never;
  }, project);
  page = await app.firstWindow();
  await page.waitForFunction(() => "rook" in window);
  [chatId, ref] = await page.evaluate(async () => {
    const added = await window.rook.chat.addProject();
    const chat = await window.rook.chat.create(added!.id, {
      agentId: "claude",
      model: null,
      effort: null,
      fast: false,
      access: "ask",
    });
    localStorage.setItem("rook:active-chat", JSON.stringify(chat.id));
    localStorage.setItem("rook:tool-panel-open", "true");
    return [chat.id, `project:${added!.id}`] as const;
  });
  await page.reload();
});

afterAll(async () => {
  await app?.close();
  server?.close();
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

test("Changes lists, diffs and stages real git changes, and follows the disk", async () => {
  // No tabs yet: the open panel is the list of tools.
  await launcher("Changes").click();
  await expect.poll(tabNames).toEqual(["Changes"]);
  expect(await activeTab()).toBe("Changes");
  await panel().waitFor();

  await page.getByRole("button", { name: "Stage README.md" }).waitFor({ state: "attached" });
  await page.getByRole("button", { name: "Stage notes.txt" }).waitFor({ state: "attached" });

  await page
    .getByRole("button", { name: /notes\.txt/ })
    .first()
    .click();
  await expect
    .poll(() => page.getByRole("region", { name: /Diff of notes\.txt/ }).textContent())
    .toContain("untracked note");

  await page.getByRole("button", { name: "Stage README.md" }).click();
  await expect.poll(() => git("diff", "--cached", "--name-only")).toContain("README.md");
  await page.getByRole("button", { name: "Unstage README.md" }).waitFor({ state: "attached" });

  // Written behind the app's back: the watcher must bring it in.
  await writeFile(NodePath.join(project, "later.txt"), "x\n");
  await page.getByRole("button", { name: "Stage later.txt" }).waitFor({ state: "attached" });
});

test("Changes lists the branch's commits, expands one and opens a file's diff", async () => {
  // Committed behind the app's back: the moved HEAD must bring them in.
  git("add", "notes.txt");
  git("commit", "-q", "-m", "Add notes", "--", "notes.txt");
  git("add", "later.txt");
  git("commit", "-q", "-m", "Add later", "--", "later.txt");

  const commits = page.getByRole("list", { name: "Commits" });
  const commitRow = (subject: RegExp) => commits.getByRole("button", { name: subject });
  await commitRow(/Add later/).waitFor();
  await commitRow(/Add notes/).waitFor();
  await commitRow(/initial/).waitFor();
  // Newest first.
  expect(await commits.locator("button[aria-expanded]").allTextContents()).toEqual([
    expect.stringContaining("Add later"),
    expect.stringContaining("Add notes"),
    expect.stringContaining("initial"),
  ]);

  await commitRow(/Add notes/).click();
  await expect.poll(() => commitRow(/Add notes/).getAttribute("aria-expanded")).toBe("true");
  const short = git("rev-parse", "--short", "HEAD~1").trim();
  const file = page
    .getByRole("list", { name: `Files in ${short}` })
    .getByRole("button", { name: /notes\.txt/ });
  await file.click();
  const diff = page.getByRole("region", { name: "Diff of notes.txt" });
  await expect.poll(() => diff.textContent()).toContain("untracked note");
  expect(await diff.textContent()).toContain(short);
  // The working tree still has README.md staged; the commit diff doesn't disturb it.
  await page.getByRole("button", { name: "Unstage README.md" }).waitFor({ state: "attached" });
});

test("Commits switches branches, and the list follows HEAD", async () => {
  git("branch", "older", "HEAD~1");
  const section = page.getByRole("region", { name: "Commits" });
  const commits = section.getByRole("list", { name: "Commits" });
  const subjects = () => commits.locator("button[aria-expanded]").allTextContents();

  /** Picks `branch` from the header's branch menu, by typing its name and pressing Enter. */
  async function switchTo(branch: string) {
    await section.getByRole("button", { name: /Switch branch/ }).click();
    const menu = section.getByRole("dialog", { name: "Switch branch" });
    await menu.getByRole("option", { name: branch }).waitFor();
    // The menu opens inside the window, not past its edge.
    const box = (await menu.boundingBox())!;
    const viewport =
      page.viewportSize() ??
      (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await menu.getByRole("combobox", { name: "Search branches" }).fill(branch);
    await page.keyboard.press("Enter");
    await menu.waitFor({ state: "detached" });
    await expect.poll(() => git("branch", "--show-current").trim()).toBe(branch);
  }

  await switchTo("older");
  await expect.poll(async () => (await subjects())[0]).toContain("Add notes");
  expect((await subjects()).join("\n")).not.toContain("Add later");
  // Staged work comes along: git switch keeps changes it doesn't have to overwrite.
  await page.getByRole("button", { name: "Unstage README.md" }).waitFor({ state: "attached" });

  await switchTo("main");
  await expect.poll(async () => (await subjects())[0]).toContain("Add later");
});

test("Files browses, opens and searches the project", async () => {
  await newTab("Files");
  await expect.poll(tabNames).toEqual(["Changes", "Files"]);
  expect(await activeTab()).toBe("Files");

  const tree = page.getByRole("tree", { name: "Files" });
  await tree.getByRole("treeitem", { name: /src/ }).waitFor();
  await tree.getByRole("treeitem", { name: /README\.md/ }).click();
  await expect.poll(() => page.getByText("changed by e2e").count()).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Back to files" }).click();

  const search = page
    .getByRole("searchbox", { name: "Search files by name" })
    .or(page.getByRole("textbox", { name: "Search files by name" }));
  await search.fill("app");
  await expect
    .poll(() =>
      page
        .getByRole("listbox", { name: "Matching files" })
        .or(page.getByRole("list", { name: "Matching files" }))
        .textContent(),
    )
    .toContain("app.ts");

  // Nothing outside the chat's folder is reachable, whatever the renderer asks.
  const escapes = await page.evaluate(
    (id) =>
      Promise.all(
        ["../", "..\\..", "C:\\Windows\\win.ini", "/etc/passwd"].map((path) =>
          window.rook.files.read(id, path).then(
            () => false,
            () => true,
          ),
        ),
      ),
    chatId,
  );
  expect(escapes).toEqual([true, true, true, true]);
});

test("Changes and Files are one tab each; picking them again shows the open one", async () => {
  await newTab("Changes", "c");
  expect(await tabNames()).toEqual(["Changes", "Files"]);
  expect(await activeTab()).toBe("Changes");
  await newTab("Files", "f");
  expect(await tabNames()).toEqual(["Changes", "Files"]);
  expect(await activeTab()).toBe("Files");
  expect((await saved())!.list.map((item) => item.tool)).toEqual(["changes", "files"]);
  // Hidden, not remounted: Files kept its search.
  expect(await page.getByRole("searchbox", { name: "Search files by name" }).inputValue()).toBe(
    "app",
  );
});

test("Terminal runs commands in the project folder, and keeps its shell across tabs", async () => {
  await newTab("Terminal", "t");
  await expect.poll(async () => (await savedOf("terminal"))[0]?.terminalId).toBeTruthy();
  const [first] = await savedOf("terminal");
  shell = first!.title!;
  expect(await sessions()).toEqual([first!.terminalId]);
  await expect.poll(tabNames).toEqual(["Changes", "Files", shell]);
  expect(await activeTab()).toBe(shell);

  await run(first!.id, "echo from-terminal > made-by-shell.txt");
  await expect.poll(() => existsSync(NodePath.join(project, "made-by-shell.txt"))).toBe(true);
  const xterm = `#tool-tab-${first!.id} .xterm`;
  await tag(xterm);

  await tab("Changes").click();
  await page
    .getByRole("button", { name: "Stage made-by-shell.txt" })
    .waitFor({ state: "attached" });
  await tab("Files").click();
  expect(await page.locator(`#tool-tab-${first!.id}`).getAttribute("hidden")).not.toBeNull();

  // Back on the tab: the same terminal, not a new one, with its output.
  await tab(shell).click();
  expect(await isTagged(xterm)).toBe(true);
  expect(await rows(first!.id)).toContain("made-by-shell.txt");
  expect(await sessions()).toEqual([first!.terminalId]);
});

test("Each Terminal tab has its own shell session", async () => {
  await newTab("Terminal");
  await expect.poll(async () => (await savedOf("terminal"))[1]?.terminalId).toBeTruthy();
  const [first, second] = await savedOf("terminal");
  expect(second!.terminalId).not.toBe(first!.terminalId);
  expect(await sessions()).toEqual([first!.terminalId, second!.terminalId].toSorted());
  await expect.poll(tabNames).toEqual(["Changes", "Files", shell, `${shell} 2`]);
  expect(await activeTab()).toBe(`${shell} 2`);

  await run(second!.id, "echo second-shell-only");
  await expect.poll(() => rows(second!.id)).toContain("second-shell-only");
  expect(await rows(first!.id)).not.toContain("second-shell-only");
});

test("A Terminal tab splits into panes side by side or stacked, each with its own shell", async () => {
  const [first, second] = await savedOf("terminal");
  const panes = async () => (await savedOf("terminal"))[0]!.terminal!;
  const pane = (id: string) => page.locator(`#tool-tab-${first!.id} [data-pane="${id}"]`);
  const box = async (id: string) => (await pane(id).boundingBox())!;
  const paneRows = (id: string) => pane(id).locator(".xterm-rows").textContent();
  const started = async (count: number) => {
    await expect
      .poll(async () => (await panes()).panes.filter((p) => p.terminalId).length)
      .toBe(count);
    return (await panes()).panes;
  };
  const mac = process.platform === "darwin";
  await tab(shell).click();

  // From the pane's toolbar: a second shell beside the first, focused to type in.
  await pane(first!.id).hover();
  await pane(first!.id)
    .getByRole("button", { name: /^Split right/ })
    .click();
  const [, right] = await started(2);
  expect((await panes()).direction).toBe("row");
  expect(await sessions()).toEqual(
    [first!.terminalId, second!.terminalId, right!.terminalId].toSorted(),
  );
  near((await box(right!.id)).y, (await box(first!.id)).y, 1);
  expect((await box(right!.id)).x).toBeGreaterThan((await box(first!.id)).x);
  await pane(right!.id).locator(".xterm").waitFor();
  await page.keyboard.type("echo right-pane-only");
  await page.keyboard.press("Enter");
  await expect.poll(() => paneRows(right!.id)).toContain("right-pane-only");
  expect(await paneRows(first!.id)).not.toContain("right-pane-only");

  // From the keyboard: a stacked split after the focused pane lays every pane out stacked.
  await page.keyboard.press(mac ? "Meta+Shift+D" : "Alt+Shift+Minus");
  const [, , below] = await started(3);
  expect((await panes()).direction).toBe("column");
  expect((await panes()).panes.map((p) => p.id)).toEqual([first!.id, right!.id, below!.id]);
  near((await box(below!.id)).x, (await box(first!.id)).x, 1);
  expect((await box(below!.id)).y).toBeGreaterThan((await box(right!.id)).y);

  // Closing a pane ends its shell; the tab keeps its name and the rest.
  await pane(below!.id).locator(".xterm").waitFor();
  await page.keyboard.press(mac ? "Meta+Shift+W" : "Control+Shift+W");
  await expect.poll(async () => (await panes()).panes.length).toBe(2);
  await pane(right!.id).hover();
  await pane(right!.id)
    .getByRole("button", { name: /^Close pane/ })
    .click();
  await expect.poll(async () => (await panes()).panes.map((p) => p.id)).toEqual([first!.id]);
  await expect.poll(sessions).toEqual([first!.terminalId, second!.terminalId].toSorted());
  expect(await activeTab()).toBe(shell);
  expect(await paneRows(first!.id)).toContain("made-by-shell.txt");
});

test("Browser finds the dev server and previews it", async () => {
  await newTab("Browser", "b");
  await expect.poll(tabNames).toEqual(["Changes", "Files", shell, `${shell} 2`, "Browser"]);
  const [browser] = await savedOf("browser");
  await page.getByRole("button", { name: `localhost:${port}` }).click();
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const view = document.querySelector(`#tool-tab-${id} webview`) as
          | (Element & { getTitle(): string })
          | null;
        try {
          return view?.getTitle() ?? "";
        } catch {
          return "";
        }
      }, browser!.id),
    )
    .toBe("E2E Preview");
  // The guest page gets no Node or bridge access.
  expect(await guest(browser!.id, "[typeof require, typeof process, typeof window.rook]")).toEqual([
    "undefined",
    "undefined",
    "undefined",
  ]);
});

test("Browser keeps its page across switching tabs and collapsing the panel", async () => {
  const [browser] = await savedOf("browser");
  const id = browser!.id;
  const view = `#tool-tab-${id} webview`;
  const kept = async () => {
    expect(await isTagged(view)).toBe(true);
    expect(await guest(id, "[location.href, window.e2eKept]")).toEqual([
      `http://localhost:${port}/`,
      "yes",
    ]);
  };
  await tag(view);
  await guest(id, "window.e2eKept = 'yes'");

  await tab("Files").click();
  expect(await page.locator(view).isVisible()).toBe(false);
  await tab("Browser").click();
  await kept();

  // The rail stands in while collapsed, and picks a tool's open tab rather than adding one.
  await page.getByRole("button", { name: "Collapse panel" }).click();
  await expect.poll(() => panel().count()).toBe(0);
  expect(await page.locator(view).isVisible()).toBe(false);
  await launcher("Terminal").click();
  await panel().waitFor();
  expect(await activeTab()).toBe(shell);
  expect(await tabNames()).toHaveLength(5);

  await tab("Browser").click();
  await kept();
  await page.getByRole("button", { name: "Collapse panel" }).click();
  await page.getByRole("button", { name: "Expand panel" }).click();
  await panel().waitFor();
  expect(await activeTab()).toBe("Browser");
  await kept();
});

test("Browser menu screenshots, copies the URL, and clears preview cookies", async () => {
  const [browser] = await savedOf("browser");
  const body = page.getByRole("region", { name: "Browser", exact: true });
  const menu = async (item: string) => {
    await body.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: item }).click();
  };
  // Note: this overwrites the real system clipboard while the test runs.
  await app.evaluate(({ clipboard }) => clipboard.clear());

  await menu("Take screenshot");
  await page.getByText("Screenshot copied").waitFor();
  expect(await app.evaluate(({ clipboard }) => clipboard.has("image/png"))).toBe(true);

  await menu("Copy current URL");
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe(`http://localhost:${port}/`);

  await guest(browser!.id, "document.cookie = 'e2e=1; max-age=3600'");
  expect(await guest(browser!.id, "document.cookie")).toBe("e2e=1");
  await menu("Clear cookies");
  await page.getByText("Cookies cleared").waitFor();
  expect(await guest(browser!.id, "document.cookie")).toBe("");

  // The renderer can't point capture at the app's own window, or clear arbitrary data.
  const ownId = await app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.id,
  );
  const refusals = await page.evaluate(
    (id) =>
      Promise.all(
        [window.rook.preview.capture(id), window.rook.preview.clear("all" as "cache")].map((call) =>
          call.then(
            () => "allowed",
            (error: unknown) => String(error),
          ),
        ),
      ),
    ownId,
  );
  expect(refusals[0]).toContain("There's no page to capture.");
  expect(refusals[1]).toContain("Only cookies or the cache can be cleared.");
});

test("Reloading restores the tabs, and Terminal tabs reattach to their shells", async () => {
  const names = await tabNames();
  const before = await sessions();
  const [first] = await savedOf("terminal");
  const [browser] = await savedOf("browser");

  await page.reload();
  await page.waitForFunction(() => "rook" in window);
  await expect.poll(tabNames).toEqual(names);
  expect(await activeTab()).toBe("Browser");
  // Bodies mount when first shown: only the active one so far.
  expect(await page.locator('[role="region"][id^="tool-tab-"]').count()).toBe(1);
  await expect
    .poll(() => guest(browser!.id, "location.href").catch(() => ""))
    .toBe(`http://localhost:${port}/`);

  await tab(shell).click();
  // shortcut: on Linux and macOS the replayed history garbles once the pane's width has changed
  // during the session: Rook replays raw output, and bash/zsh redraws assume the width at the
  // time (Windows' ConPTY redraws itself). There, only the reattached prompt is checked. Check
  // the text everywhere once the main process keeps a rendered screen (@xterm/headless).
  const kept = process.platform === "win32" ? "made-by-shell.txt" : "project";
  await expect.poll(() => rows(first!.id)).toContain(kept);
  expect(await sessions()).toEqual(before);
  expect((await savedOf("terminal")).map((item) => item.terminalId).toSorted()).toEqual(before);
});

test("Dragging the panel's edge resizes it, within the chat's room", async () => {
  // Over the Browser, whose page would swallow the pointer without capture.
  await tab("Browser").click();
  await separator().dblclick();
  await expect.poll(valueNow).toBe(448);
  near(await width(), 448, 1);
  expect(await storedWidth()).toBe(448);

  const { row: rowWidth } = await row();
  const cap = Math.min(1200, rowWidth - 320);
  const grown = Math.min(448 + 200, cap);
  await drag(-200, async () => {
    near(await width(), grown, 4);
    near(await valueNow(), grown, 4);
    // Saved once, when the drag ends.
    expect(await storedWidth()).toBe(448);
  });
  near(await width(), grown, 4);
  await expect.poll(storedWidth).toBe(await valueNow());

  // Shrinking drags the pointer across the Browser's page; the handle keeps it.
  const start = await valueNow();
  await drag(150);
  near(await width(), start - 150, 4);
  near(await valueNow(), start - 150, 4);
  await expect.poll(storedWidth).toBe(await valueNow());

  // As far left as it goes: the chat keeps its room.
  const box = (await separator().boundingBox())!;
  await drag(-box.x + 5);
  const after = await row();
  expect(await valueNow()).toBe(cap);
  near(await width(), cap, 2);
  expect(after.chat).toBeGreaterThanOrEqual(318);
  await expect.poll(storedWidth).toBe(cap);
});

test("The resize handle works from the keyboard, and double-click resets it", async () => {
  const { row: rowWidth } = await row();
  const cap = Math.min(1200, rowWidth - 320);
  await separator().dblclick();
  await settled(448);

  await separator().focus();
  // Steps start from the narrowest width: on a small screen (CI's), 448 can already be the cap.
  await page.keyboard.press("Home");
  await settled(288);
  await page.keyboard.press("ArrowLeft");
  await settled(304);
  await page.keyboard.press("ArrowRight");
  await settled(288);
  // End is 1200, held to what leaves the chat its room.
  await page.keyboard.press("End");
  await settled(cap);

  await separator().dblclick();
  await settled(448);
});

test("Closing tabs activates the neighbor, kills Terminal sessions, and ends at the list", async () => {
  const [first, second] = await savedOf("terminal");
  const [browser] = await savedOf("browser");

  // The active tab's place goes to the tab after it.
  await tab(`${shell} 2`).click();
  await page.getByRole("button", { name: `Close ${shell} 2`, exact: true }).click();
  await expect.poll(tabNames).toEqual(["Changes", "Files", shell, "Browser"]);
  expect(await activeTab()).toBe("Browser");
  await expect.poll(sessions).toEqual([first!.terminalId]);
  expect(await page.locator(`#tool-tab-${second!.id}`).count()).toBe(0);

  // Delete on a tab closes it.
  await tab("Files").click();
  await tab("Files").press("Delete");
  await expect.poll(tabNames).toEqual(["Changes", shell, "Browser"]);
  expect(await activeTab()).toBe(shell);

  // Middle-click closes a tab without changing the active one; the page it kept is dropped.
  await tab("Browser").click({ button: "middle" });
  await expect.poll(tabNames).toEqual(["Changes", shell]);
  expect(await activeTab()).toBe(shell);
  expect(
    await page.evaluate(([chat, id]) => localStorage.getItem(`rook:browser-url:${chat}:${id}`), [
      ref,
      browser!.id,
    ] as const),
  ).toBeNull();

  // The last tab has no tab after it: the one before takes over.
  await page.getByRole("button", { name: `Close ${shell}`, exact: true }).click();
  await expect.poll(tabNames).toEqual(["Changes"]);
  expect(await activeTab()).toBe("Changes");
  await expect.poll(sessions).toEqual([]);

  await page.getByRole("button", { name: "Close Changes", exact: true }).click();
  await expect.poll(() => panel().count()).toBe(0);
  expect((await saved())!.list).toEqual([]);

  // The list again, which opens new tabs.
  await launcher("Terminal").click();
  await expect.poll(async () => (await savedOf("terminal"))[0]?.terminalId).toBeTruthy();
  expect(await tabNames()).toEqual([shell]);
  const [fresh] = await savedOf("terminal");
  expect(fresh!.terminalId).not.toBe(first!.terminalId);
  expect(await sessions()).toEqual([fresh!.terminalId]);
});
