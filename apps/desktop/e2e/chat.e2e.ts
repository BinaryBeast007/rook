// Chat interactions end to end, in the built app with a throwaway profile and the fake `claude`
// and `codex` CLIs (src/agents/testing/fixtures) first on PATH: an agent's question reaches the
// user and their answers reach the agent; plans, approvals, notices and Markdown render.
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import type { ChatSettings, RookBridge } from "@rook/contracts";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { fakeBin } from "../src/agents/testing/fakeBin.ts";

declare global {
  interface Window {
    readonly rook: RookBridge;
  }
}

const desktopDir = NodePath.resolve(import.meta.dirname, "..");
const packagedApp = process.env.ROOK_E2E_APP;
const electronPath =
  packagedApp ?? (createRequire(import.meta.url)("electron") as unknown as string);

let root: string;
let claudeLog: string;
let codexState: string;
let app: ElectronApplication;
let page: Page;
let projectId: string;
let project: string;
let chats = 0;

const SETTINGS: ChatSettings = {
  agentId: "claude",
  model: null,
  effort: null,
  fast: false,
  access: "ask",
};

/** Opens a new chat with `settings` and sends `prompt` from its composer. */
async function chat(prompt: string, settings: Partial<ChatSettings> = {}): Promise<string> {
  const title = `e2e ${++chats}: ${prompt}`;
  const chatId = await page.evaluate(
    async ([id, chosen, name]) => {
      const created = await window.rook.chat.create(id, chosen);
      await window.rook.chat.rename(created.id, name);
      return created.id;
    },
    [projectId, { ...SETTINGS, ...settings }, title] as const,
  );
  // Open it the way a user does: from the sidebar.
  await page.getByRole("button", { name: title }).first().click();
  // Open, its title shows in the header and its tab as well as the sidebar.
  await expect.poll(() => page.getByText(title, { exact: true }).count()).toBeGreaterThan(1);
  const box = page.getByRole("textbox", { name: /^Message / });
  await box.fill(prompt);
  await box.press("Enter");
  return chatId;
}

/** The control responses the fake `claude` got, by request id. */
async function claudeAnswer(requestId: string) {
  const lines = (await readFile(claudeLog, "utf8").catch(() => "")).split("\n").filter(Boolean);
  return lines
    .map((line) => JSON.parse(line) as { answer?: { request_id: string; response: unknown } })
    .find((entry) => entry.answer?.request_id === requestId)?.answer?.response as
    | Record<string, unknown>
    | undefined;
}

/** What the fake `codex` logged under `method`. */
async function codexLogged(method: string): Promise<unknown[]> {
  const state = JSON.parse((await readFile(codexState, "utf8").catch(() => "{}")) || "{}") as {
    requests?: { method: string; params: unknown }[];
  };
  return (state.requests ?? []).filter((entry) => entry.method === method).map((e) => e.params);
}

beforeAll(async () => {
  root = await mkdtemp(NodePath.join(tmpdir(), "rook-e2e-chat-"));
  const bin = NodePath.join(root, "bin");
  project = NodePath.join(root, "project");
  const profile = NodePath.join(root, "profile");
  await Promise.all([mkdir(bin), mkdir(project), mkdir(profile)]);
  await fakeBin(bin, "claude", "claude-chat.mjs");
  await fakeBin(bin, "codex", "codex-chat.mjs");
  claudeLog = NodePath.join(root, "claude.log");
  codexState = NodePath.join(root, "codex.json");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project });
  await writeFile(NodePath.join(project, "README.md"), "hello\n");
  await writeFile(
    NodePath.join(profile, "agent-access.json"),
    JSON.stringify({ onboardingCompleted: true, authenticated: {} }),
  );
  const env = { ...process.env } as Record<string, string>;
  delete env.ROOK_DEV_SERVER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  // The fakes come first, so the real CLIs on this machine are never run.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = `${bin}${NodePath.delimiter}${env[pathKey] ?? ""}`;
  Object.assign(env, { FAKE_LOG: claudeLog, FAKE_STATE_FILE: codexState });
  app = await electron.launch({
    executablePath: electronPath,
    args: [...(packagedApp ? [] : [desktopDir]), `--user-data-dir=${profile}`],
    env,
  });
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as never;
  }, project);
  page = await app.firstWindow();
  await page.waitForFunction(() => "rook" in window);
  // Through the sidebar: a project added over IPC alone never reaches a sidebar that has already loaded.
  const nav = page.getByRole("navigation", { name: "Projects" });
  await nav.getByRole("button", { name: "Add project" }).first().click();
  await nav.getByRole("button", { name: "project", exact: true }).waitFor();
  projectId = await page.evaluate(async () => (await window.rook.chat.projects())[0]!.id);
});

afterAll(async () => {
  await app?.close();
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

test("a Claude AskUserQuestion is answered in the panel and the answers reach the agent", async () => {
  await chat("question");
  const panel = page.getByRole("region", { name: "Colour" });
  await panel.waitFor();
  // Nothing answered for the user while they think.
  expect(await claudeAnswer("ask-perm-1")).toBeUndefined();
  await panel.getByRole("radio", { name: /Blue/ }).click();
  // A single pick moves on to the next question by itself.
  const fruits = page.getByRole("region", { name: "Fruits" });
  await fruits.waitFor();
  await fruits.getByRole("checkbox", { name: /Apple/ }).click();
  await fruits.getByRole("checkbox", { name: /Cherry/ }).click();
  await fruits.getByRole("button", { name: "Submit answers" }).click();
  await expect
    .poll(() => claudeAnswer("ask-perm-1"))
    .toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "Which colour?": "Blue", "Which fruits?": "Apple, Cherry" } },
    });
  await fruits.waitFor({ state: "detached" });
  // The reply keeps what was answered.
  await page.getByText(/Answered 2 questions/).waitFor();
});

test("a Codex requestUserInput is shown, not auto-answered, and its answers reach Codex", async () => {
  await chat("question", { agentId: "codex", access: "edit" });
  const panel = page.getByRole("region", { name: "Colour" });
  await panel.waitFor();
  expect(await codexLogged("questionAnswer")).toEqual([]);
  await panel.getByRole("radio", { name: /Blue/ }).click();
  const name = page.getByRole("region", { name: "Name" });
  await name.waitFor();
  await name.getByRole("textbox", { name: "Your answer" }).fill("Rex");
  await name.getByRole("button", { name: "Submit answers" }).click();
  await expect
    .poll(() => codexLogged("questionAnswer"))
    .toEqual([{ answers: { colour: { answers: ["Blue"] }, name: { answers: ["Rex"] } } }]);
});

test("a Claude plan shows as a card; Implement accepts it and turns plan mode off", async () => {
  const chatId = await chat("plan", { plan: true, access: "edit" });
  const implement = page.getByRole("button", { name: "Implement" });
  await implement.waitFor();
  await page.getByText("Add README.md").first().waitFor();
  await implement.click();
  await expect
    .poll(() => claudeAnswer("perm-plan"))
    .toMatchObject({
      behavior: "allow",
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
  await expect
    .poll(() =>
      page.evaluate(
        async (id) => (await window.rook.chat.chats()).find((c) => c.id === id)?.settings.plan,
        chatId,
      ),
    )
    .toBeFalsy();
});

test("an approval shows its reason, and a message typed in the composer declines it with feedback", async () => {
  await chat("requests");
  await page.getByText("Not in the allow list").waitFor();
  const box = page.getByRole("textbox", { name: /^Message / });
  await box.fill("Use the local docs instead");
  await box.press("Enter");
  await expect
    .poll(() => claudeAnswer("perm-9"))
    .toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("Use the local docs instead"),
    });
  // Next, the MCP server's link request; deny it from the card.
  await page.getByText("https://docs.example/login").waitFor();
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  // A form Rook can't show is declined, and the reply says so.
  await page.getByText(/Declined a request from the docs MCP server/).waitFor();
});

test("command exit codes and usage, retry and compaction notices show in the reply", async () => {
  await chat("notices");
  await page.getByText(/Usage limit reached/).waitFor();
  await page.getByText("Context compacted").first().waitFor({ state: "attached" });
  // The finished reply folds its work; the failed command keeps its exit code inside.
  const fold = page.getByRole("button", { name: /^Worked for/ });
  if (await fold.isVisible()) await fold.click();
  await page.getByRole("button", { name: /^Ran 1 command/ }).click();
  await page.getByText("exit 3").waitFor();
});

test("Markdown replies render tables, nested lists and highlighted code", async () => {
  await chat("markdown");
  const table = page.getByRole("table");
  await table.waitFor();
  expect(await table.getByRole("columnheader").allTextContents()).toEqual(["Tool", "Status"]);
  await table.locator("em", { hasText: "lint" }).waitFor();
  await table.locator("del", { hasText: "old" }).waitFor();
  await page.locator("ul ul li", { hasText: "inner" }).waitFor();
  // Highlighting arrives after the plain text: coloured token spans inside the code block.
  await expect
    .poll(() => page.locator("pre code span[style*='color']").count(), { timeout: 30_000 })
    .toBeGreaterThan(0);
});

test("find in chat highlights matches, steps through them, and closes with Escape", async () => {
  await chat("markdown");
  await page.getByRole("table").waitFor();
  await page.getByRole("textbox", { name: /^Message / }).press("Control+f");
  const find = page.getByRole("textbox", { name: "Find in chat" });
  await find.fill("o");
  const status = page.getByRole("search", { name: "Find in chat" }).locator("[aria-live]");
  await expect.poll(() => status.textContent()).toMatch(/^1 of \d+$/);
  await find.press("Enter");
  await expect.poll(() => status.textContent()).toMatch(/^2 of \d+$/);
  expect(await page.evaluate(() => CSS.highlights.has("chat-find-current"))).toBe(true);
  await find.fill("no such text anywhere");
  await expect.poll(() => status.textContent()).toBe("No matches");
  await find.press("Escape");
  await find.waitFor({ state: "detached" });
  expect(await page.evaluate(() => CSS.highlights.size)).toBe(0);
});

test("a long chat renders its latest messages and shows earlier ones on request", async () => {
  const chatId = await chat("hello");
  const idle = () =>
    page.evaluate(
      async (id) => !(await window.rook.chat.chats()).find((c) => c.id === id)?.running,
      chatId,
    );
  await expect.poll(idle).toBe(true);
  // 21 turns: 42 messages, two more than a page.
  for (let turn = 1; turn < 21; turn++) {
    // oxlint-disable-next-line no-await-in-loop -- turns run one after another
    await page.evaluate(
      (id) => window.rook.chat.send(id, { text: "hello", attachments: [] }),
      chatId,
    );
    // oxlint-disable-next-line no-await-in-loop -- each turn must end before the next
    await expect.poll(idle).toBe(true);
  }
  const earlier = page.getByRole("button", { name: "Show 2 earlier messages" });
  await earlier.waitFor();
  const log = page.getByRole("log", { name: "Conversation" });
  const users = () => log.locator(":scope > div.group.items-end").count();
  expect(await users()).toBe(20);
  await earlier.click();
  await earlier.waitFor({ state: "detached" });
  expect(await users()).toBe(21);
});

test("Edit from here rewinds the chat, reverts the turn's files, and refills the composer", async () => {
  const chatId = await chat("write-file");
  const notes = NodePath.join(project, "notes.md");
  const exists = () =>
    access(notes).then(
      () => true,
      () => false,
    );
  await expect.poll(exists).toBe(true);
  // The turn ends with its changes card, so there is something to revert.
  await page.getByText(/1 file changed/).waitFor();
  const prompt = page
    .getByRole("log", { name: "Conversation" })
    .getByText("write-file", { exact: true });
  await prompt.hover();
  await page.getByRole("button", { name: "Edit from here" }).last().click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Revert files too" }).click();
  await dialog.waitFor({ state: "detached" });
  await expect.poll(exists).toBe(false);
  await prompt.waitFor({ state: "detached" });
  expect(await page.getByRole("textbox", { name: /^Message / }).inputValue()).toBe("write-file");
  const left = await page.evaluate(
    async (id) => (await window.rook.chat.messages(id)).length,
    chatId,
  );
  expect(left).toBe(0);
  // The next turn starts fresh, handed what came before.
  expect(
    await page.evaluate(
      async (id) => (await window.rook.chat.chats()).find((c) => c.id === id)?.started,
      chatId,
    ),
  ).toBe(false);
});
