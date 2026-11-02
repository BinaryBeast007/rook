// The main area's workspaces end to end, in the built app with a throwaway profile: projects and
// their chats in the sidebar, worktree chats in their own workspace, the tab strip (chats and
// tools side by side), and the title bar's Git and Open in buttons against real repositories and
// a local bare remote. No network, no AI: every commit message is typed. The tests run in order
// on one window and build on each other's state.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import type { ChatSummary, RookBridge } from "@rook/contracts";
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from "playwright-core";
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
let alpha: string;
let beta: string;
let bare: string;
let gitEnv: NodeJS.ProcessEnv;
let app: ElectronApplication;
let page: Page;
/** The shell's name, which titles Terminal tabs ("pwsh", "bash"). */
let shell: string;

/** Git with the test's own config (identity, branch name, line endings), never the user's. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();

// The parts, by the names users (and screen readers) know them by.
const nav = () => page.getByRole("navigation", { name: "Projects" });
const projectRow = (name: string) => nav().getByRole("button", { name, exact: true });
const chatList = (project: string) => nav().getByRole("list", { name: `${project} chats` });
const chatRow = (project: string, title: string) =>
  chatList(project).getByRole("button", { name: new RegExp(`^${title}\\b`) });
const strip = (project: string) => page.getByRole("tablist", { name: `${project} tabs` });
const tab = (project: string, name: string) =>
  strip(project).getByRole("tab", { name, exact: true });
const tabNames = (project: string) => strip(project).getByRole("tab").allTextContents();
const activeTab = (project: string) =>
  strip(project).locator('[role="tab"][aria-selected="true"]').textContent();
const title = () => page.getByRole("main").getByRole("heading", { level: 1 }).textContent();
const notice = () => page.locator("main > [role=status]");
const gitMenu = () => page.getByRole("button", { name: "Git actions" });
/** The Git button's main part, beside its menu; its label follows the repository's state. */
const gitPrimary = () =>
  gitMenu().locator("xpath=ancestor::div[button[@aria-busy]][1]/button[@aria-busy]");

const chats = () => page.evaluate(() => window.rook.chat.chats());
const chatNamed = async (name: string) =>
  (await chats()).find((chat: ChatSummary) => chat.title === name)!;

interface SavedTab {
  id: string;
  tool: string;
  chatId?: string;
  terminal?: { panes: { id: string; terminalId?: string }[] };
  title?: string;
}
const savedTabs = (ref: string) =>
  page.evaluate(
    (key) =>
      (
        JSON.parse(localStorage.getItem("rook:workspace-tabs") ?? "{}") as Record<
          string,
          { list: SavedTab[]; active: string | null }
        >
      )[key] ?? null,
    ref,
  );
const activeRef = () =>
  page.evaluate(() => JSON.parse(localStorage.getItem("rook:active-workspace") ?? "null"));

/** Adds a project through the sidebar, answering the native folder picker with `dir`. */
async function addProject(dir: string) {
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as never;
  }, dir);
  await nav().getByRole("button", { name: "Add project" }).first().click();
  await projectRow(NodePath.basename(dir)).waitFor();
}

/** A row's hover actions: hover the row, then click the action. */
async function rowAction(row: ReturnType<Page["locator"]>, action: string) {
  await row.hover();
  await nav().getByRole("button", { name: action, exact: true }).click();
}

async function renameChat(project: string, from: string, to: string) {
  await rowAction(chatRow(project, from), `Rename ${from}`);
  const field = nav().getByRole("textbox", { name: "Chat title" });
  await field.fill(to);
  await field.press("Enter");
  await chatRow(project, to).waitFor();
}

/** Creates a chat from the project row's hover button and names it. */
async function newChat(project: string, name: string, worktree = false) {
  const before = (await chats()).length;
  await rowAction(
    projectRow(project),
    worktree ? `New chat in a new worktree of ${project}` : `New chat in ${project}`,
  );
  await expect.poll(async () => (await chats()).length).toBe(before + 1);
  await renameChat(project, "New chat", name);
  return chatNamed(name);
}

/** Picks from the workspace's New tab menu. */
async function newTab(project: string, item: string) {
  await strip(project).locator("xpath=..").getByRole("button", { name: "New tab" }).click();
  const menu = page.getByRole("menu", { name: "New tab" });
  await menu.getByRole("menuitem", { name: item, exact: true }).click();
  await menu.waitFor({ state: "detached" });
}

/** The Git button rereads the repository on window focus. */
const refreshGit = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));
async function primaryBecomes(label: string) {
  await expect
    .poll(async () => {
      await refreshGit();
      return gitPrimary().textContent();
    })
    .toBe(label);
}
async function gitAction(item: string) {
  await gitMenu().click();
  await page
    .getByRole("menu", { name: "Git actions" })
    .getByRole("menuitem", { name: item, exact: true })
    .click();
}
/**
 * Git dialogs render inside the title bar's window-drag area. Playwright clicks skip the OS
 * hit test, so check what it would see: no control in the dialog may inherit the drag region,
 * or real clicks on Windows move the window instead of reaching Cancel, Commit or a <select>.
 */
async function expectClickable(dialog: Locator) {
  await dialog.waitFor();
  const dragging = await dialog.evaluate((node) =>
    [node, ...node.querySelectorAll("button, input, select, textarea")]
      .map((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"))
      .filter((region) => region === "drag"),
  );
  expect(dragging).toEqual([]);
}

const xterm = (tabId: string) => `#workspace-tab-${tabId} .xterm`;
const rows = (tabId: string) => page.locator(`#workspace-tab-${tabId} .xterm-rows`).textContent();
/** Tags an element, so `isTagged` later tells the same node from a remount. */
const tag = (selector: string) =>
  page.locator(selector).evaluate((node) => {
    (node as unknown as { e2eTag: boolean }).e2eTag = true;
  });
const isTagged = (selector: string) =>
  page.locator(selector).evaluate((node) => (node as unknown as { e2eTag?: boolean }).e2eTag);

beforeAll(async () => {
  if (!existsSync(NodePath.join(desktopDir, "dist-electron/main.js")))
    throw new Error("Build first: pnpm build");
  root = await mkdtemp(NodePath.join(tmpdir(), "rook-e2e-ws-"));
  alpha = NodePath.join(root, "alpha");
  beta = NodePath.join(root, "beta");
  bare = NodePath.join(root, "remote.git");
  await mkdir(alpha);
  await mkdir(beta);

  // The app's git and the test's share one config, isolated from the user's (hooks, signing).
  const gitConfig = NodePath.join(root, "gitconfig");
  await writeFile(
    gitConfig,
    "[user]\n\tname = e2e\n\temail = e2e@rook.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n",
  );
  gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };

  git(alpha, "init", "-q");
  await writeFile(NodePath.join(alpha, "README.md"), "alpha\n");
  git(alpha, "add", "-A");
  git(alpha, "commit", "-q", "-m", "initial");
  // beta stays a plain folder: the Git button offers to initialize it.

  const profile = NodePath.join(root, "profile");
  await mkdir(profile);
  await writeFile(
    NodePath.join(profile, "agent-access.json"),
    JSON.stringify({ onboardingCompleted: true, authenticated: {} }),
  );
  const env = { ...gitEnv } as Record<string, string>;
  delete env.ROOK_DEV_SERVER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: electronPath,
    args: [...(packagedApp ? [] : [desktopDir]), `--user-data-dir=${profile}`],
    env,
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => "rook" in window);
});

afterAll(async () => {
  await app?.close();
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

test("Projects list their chats beneath them; a worktree chat opens its own workspace", async () => {
  await addProject(alpha);
  // Adding a project opens its workspace, empty.
  await strip("alpha").waitFor({ state: "attached" });
  expect(await tabNames("alpha")).toEqual([]);
  await Promise.all(
    ["New chat", "Diff", "Browser", "Terminal"].map((action) =>
      page
        .getByRole("main")
        // The empty state's buttons, which show their shortcut (the side panel's don't).
        .getByRole("button", { name: new RegExp(`^${action}\\s*(Ctrl\\+|⌘)Shift\\+`) })
        .waitFor(),
    ),
  );
  await addProject(beta);
  await strip("beta").waitFor({ state: "attached" });

  const alphaOne = await newChat("alpha", "Alpha one");
  const betaOne = await newChat("beta", "Beta one");
  expect(alphaOne.projectId).not.toBe(betaOne.projectId);
  expect(
    await chatList("alpha")
      .getByRole("button", { name: /^Beta one/ })
      .count(),
  ).toBe(0);
  expect(
    await chatList("beta")
      .getByRole("button", { name: /^Alpha one/ })
      .count(),
  ).toBe(0);
  await chatRow("alpha", "Alpha one").waitFor();
  await chatRow("beta", "Beta one").waitFor();
  // Each chat opened as a tab in its own project's workspace.
  expect(await tabNames("beta")).toEqual(["Beta one"]);
  expect(await activeRef()).toBe(`project:${betaOne.projectId}`);

  const tree = await newChat("alpha", "Alpha tree", true);
  expect(tree.worktree).toBe(true);
  expect(NodePath.resolve(tree.cwd)).not.toBe(NodePath.resolve(alpha));
  expect(existsSync(NodePath.join(tree.cwd, "README.md"))).toBe(true);
  // A checkout of alpha's repository, not a copy.
  expect(git(tree.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")).toMatch(
    /alpha\/\.git$/,
  );
  // Marked as a worktree in the sidebar, and its workspace is its own: its ref, its one tab.
  expect(await chatRow("alpha", "Alpha tree").textContent()).toContain("(worktree)");
  expect(await activeRef()).toBe(tree.id);
  expect(await tabNames("alpha worktree")).toEqual(["Alpha tree"]);
  expect(await page.getByRole("tablist").count()).toBe(1);

  // The project row opens the project's own folder, whose tabs don't include the worktree chat.
  await projectRow("alpha").click();
  await expect.poll(activeRef).toBe(`project:${alphaOne.projectId}`);
  await expect.poll(() => tabNames("alpha")).toEqual(["Alpha one"]);
  // Back to the worktree's workspace from its chat.
  await chatRow("alpha", "Alpha tree").click();
  await expect.poll(activeRef).toBe(tree.id);
  expect(await tabNames("alpha worktree")).toEqual(["Alpha tree"]);
  expect(await title()).toBe("Alpha tree");
});

test("Tabs hold chats and tools; switching keeps a terminal's session", async () => {
  const alphaOne = await chatNamed("Alpha one");
  const ref = `project:${alphaOne.projectId}`;
  await chatRow("alpha", "Alpha one").click();
  await expect.poll(activeRef).toBe(ref);
  expect(await activeTab("alpha")).toBe("Alpha one");
  expect(await chatRow("alpha", "Alpha one").getAttribute("aria-current")).toBe("page");

  await newTab("alpha", "Terminal");
  await expect
    .poll(
      async () =>
        (await savedTabs(ref))?.list.find((t) => t.tool === "terminal")?.terminal?.panes[0]
          ?.terminalId,
    )
    .toBeTruthy();
  const terminal = (await savedTabs(ref))!.list.find((t) => t.tool === "terminal")!;
  shell = terminal.title!;
  await expect.poll(() => tabNames("alpha")).toEqual(["Alpha one", shell]);
  expect(await activeTab("alpha")).toBe(shell);
  // Its shell runs in the project's folder.
  await page.locator(xterm(terminal.id)).click();
  await page.keyboard.type("echo kept-in-terminal > from-tab.txt");
  await page.keyboard.press("Enter");
  await expect.poll(() => existsSync(NodePath.join(alpha, "from-tab.txt"))).toBe(true);
  await tag(xterm(terminal.id));

  await newTab("alpha", "Diff");
  await expect.poll(() => tabNames("alpha")).toEqual(["Alpha one", shell, "Changes"]);
  expect(await activeTab("alpha")).toBe("Changes");
  await page.getByRole("button", { name: "Stage from-tab.txt" }).waitFor({ state: "attached" });

  // Away and back: the same terminal, not a new one, with its output.
  await tab("alpha", "Alpha one").click();
  expect(await page.locator(`#workspace-tab-${terminal.id}`).getAttribute("hidden")).not.toBeNull();
  await tab("alpha", shell).click();
  expect(await isTagged(xterm(terminal.id))).toBe(true);
  expect(await rows(terminal.id)).toContain("from-tab.txt");
  expect(await page.evaluate(async (id) => (await window.rook.terminal.list(id)).length, ref)).toBe(
    1,
  );

  // The shortcut picks the open Diff tab rather than adding one; Ctrl+Tab cycles, wrapping.
  await tab("alpha", shell).focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+G" : "Control+Shift+G");
  await expect.poll(() => activeTab("alpha")).toBe("Changes");
  expect(await tabNames("alpha")).toHaveLength(3);
  await page.keyboard.press("Control+Tab");
  await expect.poll(() => activeTab("alpha")).toBe("Alpha one");

  // Selecting a chat that's already open activates its tab; no second one.
  await tab("alpha", shell).click();
  await chatRow("alpha", "Alpha one").click();
  await expect.poll(() => activeTab("alpha")).toBe("Alpha one");
  expect(await tabNames("alpha")).toEqual(["Alpha one", shell, "Changes"]);
});

test("Reloading restores the workspace, its tabs and the active tab", async () => {
  const alphaOne = await chatNamed("Alpha one");
  const ref = `project:${alphaOne.projectId}`;
  await tab("alpha", shell).click();
  const before = await savedTabs(ref);

  await page.reload();
  await page.waitForFunction(() => "rook" in window);
  await expect.poll(() => tabNames("alpha")).toEqual(["Alpha one", shell, "Changes"]);
  expect(await activeTab("alpha")).toBe(shell);
  expect(await activeRef()).toBe(ref);
  expect(await savedTabs(ref)).toEqual(before);
  const terminal = before!.list.find((t) => t.tool === "terminal")!;
  await expect.poll(() => rows(terminal.id)).toContain("from-tab.txt");
});

test("Closing the active tab activates the one after it, else the one before", async () => {
  const alphaOne = await chatNamed("Alpha one");
  const ref = `project:${alphaOne.projectId}`;
  await tab("alpha", shell).click();
  await strip("alpha")
    .getByRole("button", { name: `Close ${shell}`, exact: true })
    .click();
  await expect.poll(() => tabNames("alpha")).toEqual(["Alpha one", "Changes"]);
  expect(await activeTab("alpha")).toBe("Changes");
  await expect
    .poll(() => page.evaluate(async (id) => (await window.rook.terminal.list(id)).length, ref))
    .toBe(0);

  await strip("alpha").getByRole("button", { name: "Close Changes", exact: true }).click();
  await expect.poll(() => tabNames("alpha")).toEqual(["Alpha one"]);
  expect(await activeTab("alpha")).toBe("Alpha one");
});

test("Renaming a chat in the sidebar renames its tab and the title; deleting closes it", async () => {
  await renameChat("alpha", "Alpha one", "Alpha renamed");
  await expect.poll(() => tabNames("alpha")).toEqual(["Alpha renamed"]);
  await expect.poll(title).toBe("Alpha renamed");

  await rowAction(chatRow("alpha", "Alpha renamed"), "Delete Alpha renamed");
  await nav()
    .getByRole("group", { name: "Delete “Alpha renamed”?" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect.poll(() => chatRow("alpha", "Alpha renamed").count()).toBe(0);
  await expect.poll(() => tabNames("alpha")).toEqual([]);
  expect((await chats()).some((chat) => chat.title === "Alpha renamed")).toBe(false);
  // The worktree chat is untouched.
  await chatRow("alpha", "Alpha tree").waitFor();
});

test("Git: initialize, then commit only what's staged", async () => {
  await projectRow("beta").click();
  await strip("beta").waitFor({ state: "attached" });
  await primaryBecomes("Initialize Git");
  await gitPrimary().click();
  await expect.poll(() => notice().textContent()).toContain("Initialized a Git repository");
  expect(existsSync(NodePath.join(beta, ".git"))).toBe(true);

  await writeFile(NodePath.join(beta, "staged.txt"), "staged\n");
  await writeFile(NodePath.join(beta, "unstaged.txt"), "not staged\n");
  await primaryBecomes("Commit");
  // Stage one file through the Diff tab, leaving the other.
  await newTab("beta", "Diff");
  await page.getByRole("button", { name: "Stage staged.txt" }).click();
  await expect.poll(() => git(beta, "diff", "--cached", "--name-only")).toBe("staged.txt");
  // The tab has caught up too (git answers the app after the index changes).
  await page.getByRole("button", { name: "Unstage staged.txt" }).waitFor();

  await gitAction("Commit…");
  const dialog = page.getByRole("dialog", { name: "Commit changes" });
  await expectClickable(dialog);
  await dialog.getByRole("textbox", { name: "Message" }).fill("Add the staged file");
  await dialog.getByRole("radio", { name: "Staged only (1)" }).check();
  await dialog.getByRole("button", { name: "Commit", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await expect.poll(() => notice().textContent()).toMatch(/Committed [0-9a-f]{7}/);

  expect(git(beta, "log", "-1", "--pretty=%s")).toBe("Add the staged file");
  expect(git(beta, "show", "--name-only", "--pretty=format:", "HEAD")).toBe("staged.txt");
  expect(git(beta, "status", "--porcelain")).toBe("?? unstaged.txt");

  // The rest, again with a typed message.
  await gitAction("Commit…");
  await dialog.getByRole("textbox", { name: "Message" }).fill("Add the other file");
  await dialog.getByRole("button", { name: "Commit", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  expect(git(beta, "log", "--pretty=%s")).toBe("Add the other file\nAdd the staged file");
  expect(git(beta, "status", "--porcelain")).toBe("");
  // Committed, with no remote: publishing is next.
  await primaryBecomes("Publish");
});

test("Git: dialogs take real clicks, Cancel closes them, and a dialog closed mid-run still reports", async () => {
  // Publish: clickable, and Cancel closes it without publishing.
  await gitPrimary().click();
  const publish = page.getByRole("dialog", { name: "Publish to GitHub" });
  await expectClickable(publish);
  await publish.getByRole("button", { name: "Cancel" }).click();
  await publish.waitFor({ state: "detached" });
  expect(git(beta, "remote")).toBe("");

  // A slow pre-commit hook that refuses, so the commit is still running when the dialog closes.
  const hooks = NodePath.join(root, "hooks");
  await mkdir(hooks, { recursive: true });
  await writeFile(
    NodePath.join(hooks, "pre-commit"),
    "#!/bin/sh\nsleep 3\necho 'e2e hook refused the commit' >&2\nexit 1\n",
    { mode: 0o755 },
  );
  git(beta, "config", "core.hooksPath", hooks);
  await writeFile(NodePath.join(beta, "refused.txt"), "refused\n");
  try {
    await primaryBecomes("Commit");
    await gitAction("Commit…");
    const dialog = page.getByRole("dialog", { name: "Commit changes" });
    await dialog.getByRole("textbox", { name: "Message" }).fill("Refused by the hook");
    await dialog.getByRole("button", { name: "Commit", exact: true }).click();
    // Busy: no second submission, and the first Escape is held back...
    await expect.poll(() => dialog.getByRole("button", { name: "Cancel" }).isDisabled()).toBe(true);
    expect(await dialog.getByRole("button", { name: "Commit", exact: true }).isDisabled()).toBe(
      true,
    );
    await page.keyboard.press("Escape");
    expect(await dialog.isVisible()).toBe(true);
    // ...but a user's second one isn't (Chromium's close-watcher escape hatch), so the dialog
    // closes mid-run. CDP keys count as activation and never trip it, so close it as it would.
    await dialog.evaluate((node) => (node as HTMLDialogElement).close());
    await dialog.waitFor({ state: "detached" });
    // The failure it can no longer show lands in the notice, and the button recovers.
    await expect.poll(() => notice().textContent()).toContain("e2e hook refused the commit");
    await expect.poll(() => gitPrimary().getAttribute("aria-busy")).toBe("false");
    expect(git(beta, "log", "-1", "--pretty=%s")).toBe("Add the other file");
    await notice().getByRole("button", { name: "Dismiss" }).click();
  } finally {
    git(beta, "config", "--unset", "core.hooksPath");
    git(beta, "reset", "-q");
    await rm(NodePath.join(beta, "refused.txt"), { force: true });
  }
  await primaryBecomes("Publish");
});

test("Git: push to a plain remote, pull it back, and explain a rejected push", async () => {
  git(root, "init", "-q", "--bare", bare);
  git(beta, "remote", "add", "origin", bare);
  // Not GitHub: Push, and no pull request.
  await primaryBecomes("Push");
  await gitMenu().click();
  const menu = page.getByRole("menu", { name: "Git actions" });
  const createPr = menu.getByRole("menuitem", { name: "Create PR…" });
  expect(await createPr.getAttribute("aria-disabled")).toBe("true");
  expect(await createPr.getAttribute("aria-description")).toBe("The remote isn't on GitHub.");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });

  // main is the default branch, so the push asks first; Cancel leaves it unpushed.
  await gitPrimary().click();
  const confirm = page.getByRole("dialog", { name: "Push to main?" });
  await expectClickable(confirm);
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await confirm.waitFor({ state: "detached" });
  expect(git(bare, "branch", "--list")).toBe("");
  await gitPrimary().click();
  await confirm.getByRole("button", { name: "Push to main" }).click();
  await expect.poll(() => notice().textContent()).toContain("Pushed to origin/main");
  expect(git(bare, "rev-parse", "refs/heads/main")).toBe(git(beta, "rev-parse", "HEAD"));
  expect(git(beta, "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/main");
  await expect
    .poll(async () => {
      await refreshGit();
      return gitPrimary().getAttribute("title");
    })
    .toBe("Everything is committed and pushed.");

  // Someone else pushes; once fetched, Pull is offered and fast-forwards.
  const other = NodePath.join(root, "other");
  git(root, "clone", "-q", bare, other);
  await writeFile(NodePath.join(other, "theirs.txt"), "theirs\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "Their change");
  git(other, "push", "-q");
  // The app fetches in the background at most once a minute; fetch now rather than wait.
  git(beta, "fetch", "-q");
  await primaryBecomes("Pull");
  await gitPrimary().click();
  await expect.poll(() => notice().textContent()).toContain("Pulled 1 commit");
  expect(git(beta, "rev-parse", "HEAD")).toBe(git(bare, "rev-parse", "refs/heads/main"));
  expect(existsSync(NodePath.join(beta, "theirs.txt"))).toBe(true);

  // Both sides move on, unfetched: the push is rejected, in words a user can act on.
  await writeFile(NodePath.join(beta, "mine.txt"), "mine\n");
  git(beta, "add", "-A");
  git(beta, "commit", "-q", "-m", "My change");
  git(other, "pull", "-q");
  await writeFile(NodePath.join(other, "theirs2.txt"), "theirs again\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "Their second change");
  git(other, "push", "-q");
  await primaryBecomes("Push");
  await gitPrimary().click();
  await page
    .getByRole("dialog", { name: "Push to main?" })
    .getByRole("button", { name: "Push to main" })
    .click();
  await expect
    .poll(() => notice().textContent())
    .toContain("The remote has commits this branch doesn't have. Pull first, then push again.");
  // Nothing was overwritten on the remote.
  expect(git(bare, "log", "-1", "--pretty=%s", "main")).toBe("Their second change");
  await notice().getByRole("button", { name: "Dismiss" }).click();
  // The rejection fetched, so the button now knows both sides moved on.
  await primaryBecomes("Pull");
  expect(await gitPrimary().getAttribute("aria-disabled")).toBe("true");
});

test("Open in lists the file manager, and refuses unknown apps and folders", async () => {
  const apps = await page.evaluate(() => window.rook.open.apps());
  const fileManager =
    process.platform === "win32" ? "Explorer" : process.platform === "darwin" ? "Finder" : "Files";
  // Apps also carry their system icon, whose bytes vary by machine.
  expect(apps).toContainEqual(expect.objectContaining({ id: "explorer", name: fileManager }));
  const first = apps[0]!;
  await page.getByRole("button", { name: `Open in ${first.name}`, exact: true }).waitFor();
  // The menu lists every app found; nothing is launched here.
  await page.getByRole("button", { name: "Open in…" }).click();
  const menu = page.getByRole("menu", { name: "Open in…" });
  await menu.getByRole("menuitemradio", { name: fileManager }).waitFor();
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });

  const betaOne = await chatNamed("Beta one");
  const refusals = await page.evaluate(
    (ref) =>
      Promise.all(
        [
          window.rook.open.open(ref, "notepad" as "explorer"),
          window.rook.open.open("project:no-such-project", "explorer"),
        ].map((call) =>
          call.then(
            () => "allowed",
            (error: unknown) => String(error),
          ),
        ),
      ),
    `project:${betaOne.projectId}`,
  );
  expect(refusals[0]).toContain("Rook can't open that app.");
  expect(refusals[1]).not.toBe("allowed");
});
