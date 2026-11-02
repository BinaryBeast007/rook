import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import type { ChatAgentId, ChatEvent, ChatMessage, ChatSettings, Question } from "@rook/contracts";
import { projectRef } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import { tempDir } from "../agents/testing/fakeBin.ts";
import { gitClient, parseGitStatus } from "./git.ts";

type GitClient = ReturnType<typeof gitClient>;
import { githubClient } from "./github.ts";
import type { ChatRuntime, SubagentEvent, TurnInput, TurnSink } from "./runtime.ts";
import { ChatRuntimeError } from "./runtime.ts";
import {
  buildPrompt,
  ChatService,
  chatTitle,
  checkAnswer,
  checkUpload,
  overlaps,
  parseSettings,
} from "./service.ts";
import { openChatStore } from "./store.ts";

const SETTINGS: ChatSettings = {
  agentId: "claude",
  model: null,
  effort: null,
  fast: false,
  access: "edit",
};

type Script = (input: TurnInput, sink: TurnSink, signal: AbortSignal) => Promise<void>;

/** A runtime whose turns run `script`; records every input. */
function fakeRuntime(script: Script, agentId: ChatAgentId = "claude") {
  const inputs: TurnInput[] = [];
  const runtime: ChatRuntime = {
    agentId,
    accessModes: ["ask", "edit", "auto", "full"],
    catalog: async () => ({
      agentId,
      accessModes: ["ask", "edit", "auto", "full"],
      error: null,
      models: [
        {
          id: "text-only",
          name: "Text",
          description: null,
          efforts: [],
          defaultEffort: null,
          fast: false,
          auto: false,
          images: false,
          isDefault: false,
          legacy: false,
        },
      ],
    }),
    run: (input, sink, signal) => {
      inputs.push(input);
      return script(input, sink, signal);
    },
    dispose: () => undefined,
  };
  return { runtime, inputs };
}

async function setup(script: Script, codexScript: Script = async () => undefined) {
  const dir = await tempDir("rook-chat-");
  const project = NodePath.join(dir, "project");
  await mkdir(project);
  const { runtime, inputs } = fakeRuntime(script);
  const codex = fakeRuntime(codexScript, "codex");
  const events: ChatEvent[] = [];
  const store = openChatStore(":memory:");
  const service = new ChatService({
    store,
    runtimes: [runtime, codex.runtime],
    git: gitClient(() => process.env),
    github: githubClient(() => process.env),
    dataDir: dir,
    emit: (event) => events.push(event),
    log: () => undefined,
  });
  const added = service.addProject(project);
  const chat = await service.create(added.id, SETTINGS, undefined);
  /** Resolves when the chat's turn has finished. */
  const idle = async () => {
    for (let i = 0; i < 200 && service.chats().some((c) => c.running); i++)
      // oxlint-disable-next-line no-await-in-loop -- polling a background turn
      await new Promise((resolve) => setTimeout(resolve, 10));
  };
  return {
    dir,
    project,
    service,
    store,
    chat,
    events,
    inputs,
    codexInputs: codex.inputs,
    idle,
    runtime,
  };
}

/** Polls until `ready` holds. */
async function until(ready: () => boolean) {
  for (let i = 0; i < 200 && !ready(); i++)
    // oxlint-disable-next-line no-await-in-loop -- polling background turns
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(ready()).toBe(true);
}

/** Polls for up to 10 s: turns that take git checkpoints are slower on a busy machine. */
async function settle(ready: () => boolean) {
  for (let i = 0; i < 1000 && !ready(); i++)
    // oxlint-disable-next-line no-await-in-loop -- polling background turns
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(ready()).toBe(true);
}

/**
 * Turns that write "re: <prompt>", then wait until `end()` lets the oldest one write "end" and
 * finish (or fail with `error`). Stop ends a turn too.
 */
function gated() {
  const gates: ((error?: Error) => void)[] = [];
  const script: Script = async (input, sink, signal) => {
    sink.text(`re: ${input.prompt}`);
    const error = await new Promise<Error | undefined>((resolve) => {
      gates.push(resolve);
      signal.addEventListener("abort", () => {
        if (gates.includes(resolve)) gates.splice(gates.indexOf(resolve), 1);
        resolve(undefined);
      });
    });
    if (error) throw error;
    if (!signal.aborted) sink.text(" end");
  };
  return { script, waiting: () => gates.length, end: (error?: Error) => gates.shift()?.(error) };
}

/** A message as `role status text`, for comparing timelines. */
const line = (m: ChatMessage) =>
  `${m.role} ${m.status} ${m.parts.map((p) => (p.kind === "text" ? p.text.trim() : p.kind)).join("|")}`.trim();

const bytes = (text: string) => new TextEncoder().encode(text);

test("chatTitle, parseSettings, checkUpload, buildPrompt", () => {
  expect(chatTitle("  Fix the login bug\nmore")).toBe("Fix the login bug");
  expect(chatTitle("a ".repeat(40)).endsWith("…")).toBe(true);
  const agents = new Set(["claude"]);
  expect(parseSettings(SETTINGS, agents)).toEqual(SETTINGS);
  expect(() => parseSettings({ ...SETTINGS, agentId: "other" }, agents)).toThrow(ChatRuntimeError);
  expect(() => parseSettings({ ...SETTINGS, model: "--dangerous arg" }, agents)).toThrow();
  expect(() => parseSettings({ ...SETTINGS, access: "root" }, agents)).toThrow();
  // Plan mode is optional: absent (older settings) and false both mean off.
  expect(parseSettings({ ...SETTINGS, plan: true }, agents)).toEqual({ ...SETTINGS, plan: true });
  expect(parseSettings({ ...SETTINGS, plan: false }, agents)).toEqual(SETTINGS);
  expect(() => parseSettings({ ...SETTINGS, plan: "yes" }, agents)).toThrow();
  expect(checkUpload({ name: "a.ts", mediaType: "", data: bytes("let a = 1") })).toEqual({
    kind: "text",
    text: "let a = 1",
  });
  expect(checkUpload({ name: "a.png", mediaType: "image/png", data: bytes("x") }).kind).toBe(
    "image",
  );
  expect(() =>
    checkUpload({ name: "a.bin", mediaType: "", data: new Uint8Array([0, 255, 1]) }),
  ).toThrow("not an image or a text file");
  expect(buildPrompt("Look", [{ name: "a.md", text: "```js\n```" }])).toBe(
    'Look\n\nAttached file "a.md":\n````\n```js\n```\n````',
  );
});

test("parseGitStatus", () => {
  const status = parseGitStatus(
    "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b src/a.ts\nu UU N... 100644 100644 100644 100644 a b c src/b.ts\n? new.txt\n",
  );
  expect(status).toEqual({
    isRepo: true,
    repo: null,
    branch: "main",
    ahead: 2,
    behind: 1,
    changed: 3,
    conflicts: 1,
    operation: null,
  });
  expect(parseGitStatus("# branch.head (detached)\n").branch).toBeNull();
});

test("a turn streams parts, saves the session, titles the chat and survives a reload", async () => {
  const { service, store, chat, events, inputs, idle, project } = await setup(async (_, sink) => {
    sink.session("session-1");
    sink.reasoning("Let me look");
    sink.text("Hello ");
    sink.tool({
      id: "t1",
      tool: "command",
      title: "Run `ls`",
      detail: "ls",
      output: null,
      status: "running",
    });
    sink.tool({
      id: "t1",
      tool: "command",
      title: "Run `ls`",
      detail: "ls",
      output: "a",
      status: "done",
    });
    sink.text("world");
  });
  await service.send(chat.id, { text: "List the files", attachments: [] });
  await idle();

  const [prompt, reply] = service.messages(chat.id);
  expect(prompt?.parts).toEqual([{ kind: "text", text: "List the files" }]);
  expect(reply?.status).toBe("done");
  expect(reply?.parts.map((p) => p.kind)).toEqual(["reasoning", "text", "tool", "text"]);
  expect(reply?.parts[2]).toMatchObject({ status: "done", output: "a" });
  expect(inputs[0]).toMatchObject({ cwd: project, sessionId: null, prompt: "List the files" });
  const summary = service.chats()[0]!;
  expect(summary).toMatchObject({ title: "List the files", started: true, running: false });
  expect(events.some((e) => e.type === "message" && e.message.status === "streaming")).toBe(true);
  expect(store.chat(chat.id)?.sessionId).toBe("session-1");

  // The next turn resumes the agent's session.
  await service.send(chat.id, { text: "Again", attachments: [] });
  await idle();
  expect(inputs[1]?.sessionId).toBe("session-1");
});

test("switching agents hands the conversation to a fresh session on the new agent", async () => {
  const { service, store, chat, idle, inputs, codexInputs, events } = await setup(
    async (_, sink) => {
      sink.session("claude-session");
      sink.context({ used: 100, window: 1000 });
      sink.text("Claude here");
    },
    async (_, sink) => {
      sink.session("codex-thread");
      sink.text("Codex here");
    },
  );
  // A chat with no history switches without a handoff.
  expect(service.updateSettings(chat.id, { ...SETTINGS, agentId: "codex" }).handoff).toBe(false);
  service.updateSettings(chat.id, SETTINGS);

  await service.send(chat.id, { text: "First", attachments: [] });
  await idle();
  expect(inputs[0]?.history).toBeNull();
  expect(service.chats()[0]).toMatchObject({ context: { used: 100, window: 1000 } });

  const switched = service.updateSettings(chat.id, { ...SETTINGS, agentId: "codex" });
  expect(switched).toMatchObject({ started: false, handoff: true, context: null });
  expect(store.chat(chat.id)?.sessionId).toBeNull();
  expect(events.at(-1)).toEqual({ type: "chat", chat: switched });

  await service.send(chat.id, { text: "Second", attachments: [] });
  await idle();
  expect(inputs).toHaveLength(1);
  expect(codexInputs[0]).toMatchObject({ sessionId: null, prompt: "Second" });
  expect(codexInputs[0]?.history).toContain("--- user ---\nFirst");
  expect(codexInputs[0]?.history).toContain("--- assistant (claude) ---\nClaude here");
  expect(codexInputs[0]?.history).not.toContain("Second");
  expect(service.chats()[0]).toMatchObject({ started: true, handoff: false });
  expect(service.messages(chat.id).at(-1)).toMatchObject({ agentId: "codex", status: "done" });
});

test("agents cannot switch while a reply runs; other settings wait for the next turn", async () => {
  const { service, chat, idle, inputs } = await setup(
    (_, __, signal) =>
      new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
  );
  await service.send(chat.id, { text: "go", attachments: [] });
  await until(() => inputs.length === 1); // After the turn's checkpoint.
  expect(() => service.updateSettings(chat.id, { ...SETTINGS, agentId: "codex" })).toThrow(
    "Wait for the reply to finish before switching agents.",
  );
  expect(service.updateSettings(chat.id, { ...SETTINGS, model: "opus" }).settings.model).toBe(
    "opus",
  );
  service.stop(chat.id);
  await idle();
  expect(inputs[0]?.settings.model).toBeNull();
  expect(service.chats()[0]).toMatchObject({ handoff: false, settings: { agentId: "claude" } });
});

test("context usage is saved and announced only when it changes", async () => {
  const { service, store, chat, idle, events } = await setup(async (_, sink) => {
    sink.context({ used: 10, window: 100 });
    sink.context({ used: 10, window: 100 });
    sink.context({ used: 20, window: 100 });
  });
  await service.send(chat.id, { text: "go", attachments: [] });
  await idle();
  const reported = events.flatMap((e) =>
    e.type === "chat" && e.chat.context ? [e.chat.context] : [],
  );
  // Then the end-of-turn summary repeats the latest.
  expect(reported).toEqual([
    { used: 10, window: 100 },
    { used: 20, window: 100 },
    { used: 20, window: 100 },
  ]);
  expect(store.chat(chat.id)?.context).toEqual({ used: 20, window: 100 });
});

test("approvals wait for the user, and a stop releases them", async () => {
  const answers: string[] = [];
  const { service, chat, idle } = await setup(async (_, sink, signal) => {
    answers.push(
      (await sink.approve({ id: "a1", title: "Run rm?", detail: null, options: ["allow", "deny"] }))
        .decision,
    );
    answers.push(
      (
        await sink.approve({
          id: "a2",
          title: "Again?",
          detail: null,
          options: ["allow", "deny"],
          subagent: "t1",
        })
      ).decision,
    );
    if (!signal.aborted) sink.text("unreachable");
  });
  await service.send(chat.id, { text: "go", attachments: [] });
  await until(() => service.chats()[0]?.waiting?.approvalId === "a1");
  service.answer(chat.id, "a1", { kind: "decision", decision: "allow" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(() => service.answer(chat.id, "a1", { kind: "decision", decision: "allow" })).toThrow(
    "already ended",
  );
  // A subagent's approval names it, so the parent's row for that subagent can show it waiting.
  await until(() => service.chats()[0]?.waiting?.subagent === "t1");
  service.stop(chat.id);
  await idle();
  expect(answers).toEqual(["allow", "deny"]);
  const reply = service.messages(chat.id)[1]!;
  expect(reply.status).toBe("stopped");
  // Answered approvals keep the decision; the one cut off by the stop expires unanswered.
  expect(reply.parts).toMatchObject([
    { kind: "approval", id: "a1", decision: "allow" },
    { kind: "approval", id: "a2", decision: null },
  ]);
});

const QUESTIONS: Question[] = [
  {
    id: "q1",
    header: "Colour",
    question: "Which colour?",
    options: [
      { label: "Red", description: null },
      { label: "Blue", description: "Calm" },
    ],
    multiSelect: false,
    allowCustom: true,
  },
  {
    id: "q2",
    header: null,
    question: "Which fruits?",
    options: [
      { label: "Apple", description: null },
      { label: "Pear", description: null },
    ],
    multiSelect: true,
    allowCustom: false,
  },
];

test("checkAnswer keeps answers to the request's own questions and options", () => {
  const question = { kind: "question", id: "r", questions: QUESTIONS, answers: null } as const;
  const good = {
    kind: "answers",
    answers: {
      q1: { selected: [], text: "  Green  " },
      q2: { selected: ["Apple", "Pear"], text: null },
    },
  };
  expect(checkAnswer(question, good)).toEqual({
    kind: "answers",
    answers: {
      q1: { selected: [], text: "Green" },
      q2: { selected: ["Apple", "Pear"], text: null },
    },
  });
  const bad = (answers: unknown) => () => checkAnswer(question, { kind: "answers", answers });
  const q2 = { selected: ["Apple"], text: null };
  expect(bad({ q2 })).toThrow("Answer every question"); // q1 missing
  expect(bad({ q1: { selected: ["Purple"], text: null }, q2 })).toThrow(); // not an option
  expect(bad({ q1: { selected: ["Red", "Blue"], text: null }, q2 })).toThrow(); // single-select
  expect(bad({ q1: { selected: ["Red"] }, q2: { selected: [], text: "Fig" } })).toThrow(); // no custom
  expect(bad({ q1: { selected: ["Red", "Red"] }, q2 })).toThrow(); // duplicate
  expect(bad({ q1: { selected: [], text: "x".repeat(20_001) }, q2 })).toThrow("too long");
  expect(checkAnswer(question, { kind: "decline", feedback: " later " })).toEqual({
    kind: "decline",
    feedback: "later",
  });
  expect(() => checkAnswer(question, { kind: "decision", decision: "allow" })).toThrow();

  const approval = {
    kind: "approval",
    id: "a",
    title: "Run?",
    detail: null,
    options: ["allow", "deny"],
    decision: null,
  } as const;
  expect(checkAnswer(approval, { kind: "decision", decision: "deny" })).toEqual({
    kind: "decision",
    decision: "deny",
  });
  // Only the options the agent offered.
  expect(() => checkAnswer(approval, { kind: "decision", decision: "allowSession" })).toThrow();
  expect(() => checkAnswer(approval, { kind: "answers", answers: {} })).toThrow();
  const plan = { kind: "plan", id: "p", text: "# Plan", decision: null } as const;
  expect(checkAnswer(plan, { kind: "decision", decision: "allow" }).kind).toBe("decision");
  expect(() => checkAnswer(plan, { kind: "decision", decision: "allowSession" })).toThrow();
});

test("questions, plans and declines with feedback reach the runtime and stay on the reply", async () => {
  const heard: unknown[] = [];
  const { service, chat, idle } = await setup(async (_, sink) => {
    sink.part({ kind: "notice", id: "n1", level: "warning", text: "Retrying (1/3)", detail: null });
    heard.push(await sink.ask({ id: "q", questions: QUESTIONS }));
    sink.part({ kind: "notice", id: "n1", level: "info", text: "Recovered", detail: null });
    heard.push(await sink.reviewPlan({ id: "p", text: "# Plan\n\n1. Do it" }));
    heard.push(
      await sink.approve({ id: "a", title: "Run rm?", detail: null, options: ["allow", "deny"] }),
    );
    sink.text("done");
  });
  await service.send(chat.id, { text: "go", attachments: [] });
  await until(() => service.chats()[0]?.waiting?.kind === "question");
  expect(service.chats()[0]?.waiting).toEqual({
    approvalId: "q",
    kind: "question",
    title: "Which colour?",
  });
  // An agent waiting on a question can't take a steer, and a wrong answer leaves it waiting.
  expect(() =>
    service.answer(chat.id, "q", { kind: "answers", answers: { q1: { selected: ["Red"] } } }),
  ).toThrow("Answer every question");
  const answers = {
    q1: { selected: ["Blue"], text: null },
    q2: { selected: ["Pear"], text: null },
  };
  service.answer(chat.id, "q", { kind: "answers", answers });
  await until(() => service.chats()[0]?.waiting?.kind === "plan");
  service.answer(chat.id, "p", { kind: "decline", feedback: "Also cover Windows" });
  await until(() => service.chats()[0]?.waiting?.kind === "approval");
  service.answer(chat.id, "a", { kind: "decline", feedback: "Use git clean" });
  await idle();
  expect(heard).toEqual([
    { answers },
    { decision: "deny", feedback: "Also cover Windows" },
    { decision: "deny", feedback: "Use git clean" },
  ]);
  const reply = service.messages(chat.id)[1]!;
  expect(reply.parts).toMatchObject([
    // The retry notice was replaced in place.
    { kind: "notice", id: "n1", level: "info", text: "Recovered" },
    { kind: "question", id: "q", answers },
    { kind: "plan", id: "p", decision: "deny", feedback: "Also cover Windows" },
    { kind: "approval", id: "a", decision: "deny", feedback: "Use git clean" },
    { kind: "text", text: "done" },
  ]);
  expect(service.chats()[0]?.waiting).toBeNull();
});

test("a stop declines a waiting question, which stays unanswered", async () => {
  const heard: unknown[] = [];
  const { service, chat, idle } = await setup(async (_, sink) => {
    heard.push(await sink.ask({ id: "q", questions: QUESTIONS }));
  });
  await service.send(chat.id, { text: "go", attachments: [] });
  await until(() => service.chats()[0]?.waiting !== null);
  service.stop(chat.id);
  await idle();
  expect(heard).toEqual([{ declined: true, feedback: null }]);
  expect(service.messages(chat.id)[1]!.parts).toMatchObject([{ kind: "question", answers: null }]);
  expect(service.messages(chat.id)[1]!.parts[0]).not.toHaveProperty("declined");
});

test("failures, retry, and history that was streaming when Rook quit", async () => {
  let fail = true;
  const { service, chat, idle, events, dir, inputs } = await setup(async (_, sink) => {
    sink.text("partial");
    if (fail) throw new ChatRuntimeError("Sign in to Claude Code to continue.");
    sink.text(" done");
  });
  await service.send(chat.id, { text: "hi", attachments: [] });
  await idle();
  const failed = service.messages(chat.id)[1]!;
  expect(failed).toMatchObject({ status: "error", error: "Sign in to Claude Code to continue." });

  fail = false;
  await service.retry(chat.id);
  await idle();
  // The retried prompt and the failed reply are not earlier conversation.
  expect(inputs[1]?.history).toBeNull();
  const messages = service.messages(chat.id);
  expect(messages).toHaveLength(2);
  expect(messages[1]?.parts).toEqual([{ kind: "text", text: "partial done" }]);
  expect(events).toContainEqual({ type: "messageDeleted", chatId: chat.id, messageId: failed.id });

  // A reply saved mid-stream is marked stopped when the database opens again.
  const file = NodePath.join(dir, "history.db");
  const disk = openChatStore(file);
  const project = disk.addProject("p", "p", dir);
  disk.createChat("c", project.id, "t", SETTINGS);
  disk.saveMessage({ ...messages[1]!, chatId: "c", id: "m", status: "streaming" });
  disk.close();
  const reopened = openChatStore(file);
  expect(reopened.messages("c")[0]?.status).toBe("stopped");
  reopened.close();
});

test("attachments are validated, saved, and passed to the agent", async () => {
  const { service, chat, idle, inputs } = await setup(async () => undefined);
  const text = {
    name: "notes.md",
    mediaType: "text/markdown",
    data: new TextEncoder().encode("# Hi"),
  };
  await service.send(chat.id, { text: "Read this", attachments: [text] });
  await idle();
  expect(inputs[0]?.prompt).toBe('Read this\n\nAttached file "notes.md":\n```\n# Hi\n```');
  const [prompt] = service.messages(chat.id);
  expect(prompt?.attachments[0]).toMatchObject({ name: "notes.md", kind: "text", size: 4 });
  expect(
    new TextDecoder().decode(await service.attachment(chat.id, prompt!.attachments[0]!.id)),
  ).toBe("# Hi");

  // The catalog says this model takes no images.
  service.updateSettings(chat.id, { ...SETTINGS, model: "text-only" });
  const image = { name: "a.png", mediaType: "image/png", data: new Uint8Array([1, 2]) };
  await expect(service.send(chat.id, { text: "", attachments: [image] })).rejects.toThrow(
    "does not accept images",
  );
});

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

test.skipIf(!hasGit)("worktree chats get their own folder and branch", async () => {
  const { service, project, dir } = await setup(async () => undefined);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  await writeFile(NodePath.join(project, "a.txt"), "a");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");

  const projectId = service.projects()[0]!.id;
  const chat = await service.create(projectId, SETTINGS, { worktree: true });
  expect(chat.worktree).toBe(true);
  expect(chat.cwd.startsWith(NodePath.join(dir, "worktrees"))).toBe(true);
  expect(existsSync(NodePath.join(chat.cwd, "a.txt"))).toBe(true);
  expect((await service.gitStatus(chat.id)).branch).toBe(`rook/chat-${chat.id.slice(0, 8)}`);
  // The project folder stays on its own branch.
  expect(git("branch", "--show-current").trim()).toBe("main");
  await expect(service.gitSwitch(chat.id, "--orphan")).rejects.toThrow("no local branch");

  // A worktree with uncommitted work is kept; a clean one is removed.
  await writeFile(NodePath.join(chat.cwd, "b.txt"), "b");
  expect(await service.delete(chat.id)).toEqual({ keptWorktree: chat.cwd });
  const clean = await service.create(projectId, SETTINGS, { worktree: true });
  expect(await service.delete(clean.id)).toEqual({ keptWorktree: null });
  expect(existsSync(clean.cwd)).toBe(false);

  // A second chat can join a worktree; it stays until the last chat in it goes.
  const host = await service.create(projectId, SETTINGS, { worktree: true });
  const guest = await service.create(projectId, SETTINGS, { joinChat: host.id });
  expect(guest.cwd).toBe(host.cwd);
  expect(await service.delete(host.id)).toEqual({ keptWorktree: null });
  expect(existsSync(guest.cwd)).toBe(true);
  expect(service.workspaceCwd(guest.id)).toBe(guest.cwd);
  expect(await service.delete(guest.id)).toEqual({ keptWorktree: null });
  expect(existsSync(guest.cwd)).toBe(false);
  await expect(service.create(projectId, SETTINGS, { joinChat: "missing" })).rejects.toThrow();
});

test.skipIf(!hasGit)(
  "a turn's final reply lists what it changed",
  async () => {
    let resume: (() => void) | null = null;
    const { service, project, chat, runtime, store } = await setup(async (input, sink) => {
      sink.text("editing");
      if (input.prompt === "quiet") return;
      await writeFile(NodePath.join(input.cwd, "a.txt"), "a\nb\n");
      await new Promise<void>((resolve) => (resume = resolve));
      sink.text("done");
    });
    const idle = () => settle(() => !service.chats().some((c) => c.running));
    runtime.steer = async () => true;
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: project, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    await writeFile(NodePath.join(project, "a.txt"), "a\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    const prefix = `refs/rook/checkpoints/${chat.id}/`;
    const refs = () =>
      git("for-each-ref", "--format=%(refname)", "refs/rook/checkpoints/")
        .split("\n")
        .filter(Boolean);
    const sha = (ordinal: number) => git("rev-parse", `${prefix}${ordinal}`).trim();

    await service.send(chat.id, { text: "edit", attachments: [] });
    await settle(() => resume !== null);
    await service.send(chat.id, { text: "also", attachments: [], mode: "steer" });
    resume!();
    await idle();
    const [, first, , last] = store.messages(chat.id);
    // The steer split the reply: only the final half gets the changes, both get finishedAt.
    expect(first!.parts.map((p) => p.kind)).toEqual(["text"]);
    expect(first!.finishedAt).toBeGreaterThanOrEqual(first!.createdAt);
    expect(last!.finishedAt).toBeGreaterThanOrEqual(last!.createdAt);
    const changes = last!.parts.at(-1);
    expect(changes).toMatchObject({
      kind: "changes",
      files: [{ path: "a.txt", additions: 1, deletions: 0 }],
      truncated: false,
    });
    // The first turn captured its baseline 0, then its end 1.
    expect(refs()).toEqual([`${prefix}0`, `${prefix}1`]);
    expect(changes).toMatchObject({ from: sha(0), to: sha(1) });
    // The user's branch and index are untouched.
    expect(git("status", "--porcelain=v1")).toBe(" M a.txt\n");
    expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");

    // The next turn starts from turn 1's end snapshot, so an edit made in between shows up in it.
    await writeFile(NodePath.join(project, "between.txt"), "x\n");
    await service.send(chat.id, { text: "quiet", attachments: [] });
    await idle();
    expect(store.messages(chat.id).at(-1)!.parts.at(-1)).toMatchObject({
      kind: "changes",
      from: sha(1),
      to: sha(2),
      files: [{ path: "between.txt", additions: 1, deletions: 0 }],
    });
    expect(refs()).toEqual([`${prefix}0`, `${prefix}1`, `${prefix}2`]);

    // A turn that changes nothing gets no part.
    await service.send(chat.id, { text: "quiet", attachments: [] });
    await idle();
    const quiet = store.messages(chat.id).at(-1)!;
    expect(quiet.parts.map((p) => p.kind)).toEqual(["text"]);
    expect(refs()).toHaveLength(4);

    // Deleting the chat leaves its snapshots in the repository.
    await service.delete(chat.id);
    expect(refs()).toHaveLength(4);
  },
  30_000,
);

test("a project ref names the project's own folder", async () => {
  const { service, project } = await setup(async () => undefined);
  const projectId = service.projects()[0]!.id;
  expect(service.workspaceCwd(projectRef(projectId))).toBe(project);
  expect(() => service.workspaceCwd(projectRef("gone"))).toThrow("no longer in Rook");
  expect((await service.gitStatus(projectRef(projectId))).isRepo).toBe(false);
});

test("worktrees need a git repository", async () => {
  const { service } = await setup(async () => undefined);
  await expect(
    service.create(service.projects()[0]!.id, SETTINGS, { worktree: true }),
  ).rejects.toThrow(hasGit ? "not a git repository" : "Git is not installed");
});

test.skipIf(!hasGit)("branches never switch under a running turn in the same folder", async () => {
  const { service, project, chat, idle } = await setup(
    (_, __, signal) =>
      new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
  );
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  git("branch", "other");
  // Another chat in the same project folder, idle itself.
  const sibling = await service.create(service.projects()[0]!.id, SETTINGS, undefined);

  await service.send(chat.id, { text: "go", attachments: [] });
  expect(() => service.gitSwitch(sibling.id, "other")).toThrow(
    "Wait for the running turn to finish",
  );
  service.stop(chat.id);
  await idle();
  expect((await service.gitSwitch(sibling.id, "other")).branch).toBe("other");
});

test("messages sent while a turn runs queue, then run one turn each, in order", async () => {
  const gate = gated();
  const { service, chat, inputs, events, idle } = await setup(gate.script);
  await service.send(chat.id, { text: "one", attachments: [] });
  await until(() => gate.waiting() === 1);
  await service.send(chat.id, { text: "two", attachments: [] });
  await service.send(chat.id, { text: "three", attachments: [], mode: "queue" });
  expect(service.messages(chat.id).map(line)).toEqual([
    "user done one",
    "assistant streaming re: one",
    "user queued two",
    "user queued three",
  ]);

  gate.end();
  await until(() => inputs.length === 2 && gate.waiting() === 1);
  expect(inputs[1]?.prompt).toBe("two");
  // The earlier conversation leaves out what is still queued.
  expect(inputs[1]?.history).toContain("one");
  expect(inputs[1]?.history).not.toContain("three");
  gate.end();
  await until(() => inputs.length === 3 && gate.waiting() === 1);
  expect(inputs[2]?.prompt).toBe("three");
  gate.end();
  await idle();

  const timeline = service.messages(chat.id).map(line);
  expect(timeline).toEqual([
    "user done one",
    "assistant done re: one end",
    "user done two",
    "assistant done re: two end",
    "user done three",
    "assistant done re: three end",
  ]);
  // The renderer, replaying the events, ends up in the same order.
  let shown: ChatMessage[] = [];
  for (const event of events)
    if (event.type === "messageDeleted") shown = shown.filter((m) => m.id !== event.messageId);
    else if (event.type === "message") {
      const index = shown.findIndex((m) => m.id === event.message.id);
      if (index < 0) shown.push(event.message);
      else shown[index] = event.message;
    }
  expect(shown.map(line)).toEqual(timeline);
});

test("Stop keeps the queue but holds it until Send now", async () => {
  const gate = gated();
  const { service, chat, inputs, idle } = await setup(gate.script);
  await service.send(chat.id, { text: "one", attachments: [] });
  await until(() => gate.waiting() === 1);
  await service.send(chat.id, { text: "two", attachments: [] });
  service.stop(chat.id);
  await idle();
  service.drainSoon(chat.id, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(inputs).toHaveLength(1);
  const two = service.messages(chat.id).at(-1)!;
  expect(line(two)).toBe("user queued two");

  await service.dequeue(chat.id, two.id, "send");
  await until(() => gate.waiting() === 1);
  expect(inputs[1]?.prompt).toBe("two");
  // Send now while a turn runs leaves it queued for after the turn.
  await service.send(chat.id, { text: "three", attachments: [] });
  await service.dequeue(chat.id, service.messages(chat.id).at(-1)!.id, "send");
  expect(inputs).toHaveLength(2);
  gate.end();
  await until(() => inputs.length === 3 && gate.waiting() === 1);
  gate.end();
  await idle();
  expect(service.messages(chat.id).map(line)).toEqual([
    "user done one",
    "assistant stopped re: one",
    "user done two",
    "assistant done re: two end",
    "user done three",
    "assistant done re: three end",
  ]);
});

test("an error holds the queue, and retry runs the last prompt that was sent", async () => {
  const gate = gated();
  const { service, chat, inputs, idle } = await setup(gate.script);
  await service.send(chat.id, { text: "one", attachments: [] });
  await until(() => gate.waiting() === 1);
  await service.send(chat.id, { text: "two", attachments: [] });
  gate.end(new ChatRuntimeError("boom"));
  await idle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(inputs).toHaveLength(1);
  expect(service.messages(chat.id).map(line)).toEqual([
    "user done one",
    "assistant error re: one",
    "user queued two",
  ]);

  // A retry that fails again holds the queue again.
  await service.retry(chat.id);
  await until(() => gate.waiting() === 1);
  expect(inputs[1]?.prompt).toBe("one");
  gate.end(new ChatRuntimeError("boom"));
  await idle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(inputs).toHaveLength(2);
  expect(service.messages(chat.id).map(line)).toEqual([
    "user done one",
    "user queued two",
    "assistant error re: one",
  ]);

  // A retry that succeeds releases it.
  await service.retry(chat.id);
  await until(() => gate.waiting() === 1);
  expect(inputs[2]?.prompt).toBe("one");
  gate.end();
  await until(() => inputs.length === 4 && gate.waiting() === 1);
  expect(inputs[3]?.prompt).toBe("two");
  gate.end();
  await idle();
  expect(service.messages(chat.id).map(line)).toEqual([
    "user done one",
    "assistant done re: one end",
    "user done two",
    "assistant done re: two end",
  ]);
});

test("dequeue removes a queued message with its files, and rejects anything not queued", async () => {
  const gate = gated();
  const { service, chat, events, dir, idle } = await setup(gate.script);
  const other = await service.create(service.projects()[0]!.id, SETTINGS, undefined);
  await service.send(chat.id, { text: "one", attachments: [] });
  await until(() => gate.waiting() === 1);
  const file = { name: "a.md", mediaType: "text/markdown", data: bytes("# a") };
  await service.send(chat.id, { text: "two", attachments: [file] });
  const [sent, , queued] = service.messages(chat.id);
  const saved = NodePath.join(dir, "attachments", chat.id, `${queued!.attachments[0]!.id}.md`);
  expect(existsSync(saved)).toBe(true);
  const invalid = [
    [other.id, queued!.id, "send"],
    [chat.id, queued!.id, "later"],
    [chat.id, "missing", "remove"],
    [chat.id, sent!.id, "remove"],
  ];
  await Promise.all(
    invalid.map(([chatId, messageId, action]) =>
      expect(service.dequeue(chatId, messageId, action)).rejects.toThrow(
        "That message is no longer queued.",
      ),
    ),
  );

  await service.dequeue(chat.id, queued!.id, "remove");
  expect(existsSync(saved)).toBe(false);
  expect(events).toContainEqual({ type: "messageDeleted", chatId: chat.id, messageId: queued!.id });
  await expect(service.dequeue(chat.id, queued!.id, "remove")).rejects.toThrow("no longer queued");
  gate.end();
  await idle();
  expect(service.messages(chat.id).map(line)).toEqual([
    "user done one",
    "assistant done re: one end",
  ]);
});

test("a steered message lands between the two halves of the running turn's reply", async () => {
  const gate = gated();
  const { service, chat, inputs, runtime, idle } = await setup(gate.script);
  const steered: [string, string][] = [];
  runtime.steer = async (chatId, input) => {
    steered.push([chatId, input.prompt]);
    return true;
  };
  await service.send(chat.id, { text: "one", attachments: [] });
  await until(() => gate.waiting() === 1);
  await service.send(chat.id, { text: "also this", attachments: [], mode: "steer" });
  expect(steered).toEqual([[chat.id, "also this"]]);
  gate.end();
  await idle();
  expect(inputs).toHaveLength(1);
  expect(service.messages(chat.id).map(line)).toEqual([
    "user done one",
    "assistant done re: one",
    "user done also this",
    "assistant done end",
  ]);
});

test("steering falls back to the queue when the agent can't take the message", async () => {
  const gate = gated();
  const { service, chat, inputs, runtime, idle } = await setup(gate.script);
  let calls = 0;
  runtime.steer = async () => {
    calls++;
    if (calls === 2) throw new Error("pipe closed");
    return false;
  };
  await service.send(chat.id, { text: "one", attachments: [] });
  await until(() => gate.waiting() === 1);
  await service.send(chat.id, { text: "two", attachments: [], mode: "steer" });
  await service.send(chat.id, { text: "three", attachments: [], mode: "steer" });
  expect(calls).toBe(2);
  expect(service.messages(chat.id).map(line)).toEqual([
    "user done one",
    "assistant streaming re: one",
    "user queued two",
    "user queued three",
  ]);
  gate.end();
  await until(() => inputs.length === 2 && gate.waiting() === 1);
  expect(inputs[1]?.prompt).toBe("two");
  gate.end();
  await until(() => inputs.length === 3 && gate.waiting() === 1);
  gate.end();
  await idle();
});

test("an open approval blocks steering and shows as waiting until answered", async () => {
  const { service, chat, runtime, events, inputs, idle } = await setup(async (input, sink) => {
    if (input.prompt === "go")
      await sink.approve({ id: "a1", title: "Run rm?", detail: null, options: ["allow", "deny"] });
  });
  let calls = 0;
  runtime.steer = async () => {
    calls++;
    return true;
  };
  await service.send(chat.id, { text: "go", attachments: [] });
  await until(() => service.chats()[0]?.waiting !== null);
  expect(service.chats()[0]?.waiting).toEqual({
    approvalId: "a1",
    kind: "approval",
    title: "Run rm?",
  });
  expect(events.at(-1)).toMatchObject({ type: "chat", chat: { waiting: { approvalId: "a1" } } });

  await service.send(chat.id, { text: "next", attachments: [], mode: "steer" });
  expect(calls).toBe(0);
  service.answer(chat.id, "a1", { kind: "decision", decision: "allow" });
  expect(events.at(-1)).toMatchObject({ type: "chat", chat: { waiting: null } });
  await until(() => inputs.length === 2);
  await idle();
  expect(inputs[1]?.prompt).toBe("next");
});

test("a restart leaves queued messages held until the user sends one on", async () => {
  const { store, chat, runtime, inputs, dir } = await setup(async () => undefined);
  store.saveMessage({
    id: "q1",
    chatId: chat.id,
    role: "user",
    parts: [{ kind: "text", text: "later" }],
    attachments: [],
    status: "queued",
    error: null,
    agentId: null,
    model: null,
    createdAt: 1,
  });
  const restarted = new ChatService({
    store,
    runtimes: [runtime],
    git: gitClient(() => process.env),
    github: githubClient(() => process.env),
    dataDir: dir,
    emit: () => undefined,
    log: () => undefined,
  });
  restarted.drainSoon(chat.id, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(inputs).toHaveLength(0);
  await restarted.dequeue(chat.id, "q1", "send");
  await until(() => inputs.length === 1 && !restarted.chats()[0]?.running);
  expect(inputs[0]?.prompt).toBe("later");
});

test("queued task results go before queued prompts", async () => {
  const gate = gated();
  const { service, store, chat, inputs, idle } = await setup(gate.script);
  await service.send(chat.id, { text: "one", attachments: [] });
  await until(() => gate.waiting() === 1);
  await service.send(chat.id, { text: "two", attachments: [] });
  const result = {
    taskId: "t",
    title: "Task",
    status: "completed" as const,
    summary: "ok",
    filesChanged: [],
    error: null,
    finishedAt: 1,
  };
  store.saveMessage({
    id: "results",
    chatId: chat.id,
    role: "user",
    parts: [{ kind: "taskResults", results: [result] }],
    attachments: [],
    status: "queued",
    error: null,
    agentId: null,
    model: null,
    createdAt: 1,
  });
  gate.end();
  await idle();
  // Without delegation (no hooks) the results can't be put into words: that turn fails and holds.
  expect(inputs).toHaveLength(1);
  expect(service.messages(chat.id).map(line)).toEqual([
    "user done one",
    "assistant done re: one end",
    "user queued two",
    "user done taskResults",
    "assistant error",
  ]);
});

/**
 * A turn whose agent part "agent-1" runs a native subagent: its transcript streams, then the part
 * is updated again (without chatId, as runtimes do) and the subagent ends. Prompt "hang" waits for
 * Stop first, "fail" fails it.
 */
const subagentTurn: Script = async (input, sink, signal) => {
  const part = {
    id: "agent-1",
    tool: "agent",
    title: "Find the config",
    detail: "Look for config",
    output: null,
    status: "running" as const,
  };
  const report = (event: SubagentEvent) => sink.subagent?.("agent-1", event);
  sink.tool(part);
  report({ type: "started", title: "Find the config", prompt: "Look for config", model: "sub-1" });
  report({ type: "reasoning", delta: "Hm" });
  report({ type: "text", delta: "Searching" });
  const step = { id: "s1", tool: "search", title: "Search", detail: null, output: null };
  report({ type: "tool", update: { ...step, status: "running" } });
  report({ type: "tool", update: { ...step, output: "rook.json", status: "done" } });
  report({ type: "text", delta: "It is in " });
  report({ type: "text", delta: "rook.json" });
  if (input.prompt === "hang")
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  sink.tool({ ...part, output: "Search\n\nIt is in rook.json", status: "done" });
  report(
    input.prompt === "fail"
      ? { type: "ended", status: "failed", error: "Boom" }
      : { type: "ended", status: signal.aborted ? "cancelled" : "completed", error: null },
  );
  sink.text("Done");
};

test("a native subagent's transcript streams into a read-only child chat", async () => {
  const { service, store, chat, idle, events } = await setup(subagentTurn);
  await service.send(chat.id, { text: "hang", attachments: [] });
  await until(() => store.children(chat.id).length === 1);
  const child = store.children(chat.id)[0]!;
  expect(child.lineage).toEqual({ parentChatId: chat.id, relationship: "subagent", depth: 1 });
  expect(child.settings).toEqual(SETTINGS);
  expect(child.title).toBe("Find the config");
  expect(service.chats().find((c) => c.id === child.id)?.cwd).toBe(chat.cwd);
  expect(child.task?.status).toBe("running");
  // Mid-turn: the streaming reply holds everything so far, and the parent's part links to it.
  expect(service.messages(child.id).map(line)).toEqual([
    "user done Look for config",
    "assistant streaming reasoning|Searching|tool|It is in rook.json",
  ]);
  const agentPart = () =>
    service
      .messages(chat.id)
      .flatMap((m) => m.parts)
      .find((p) => p.kind === "tool" && p.id === "agent-1");
  expect(agentPart()).toMatchObject({ chatId: child.id });

  // Read-only, except that it can be deleted.
  const readOnly = "A subagent's chat is read-only.";
  await expect(service.send(child.id, { text: "hi", attachments: [] })).rejects.toThrow(readOnly);
  await expect(service.retry(child.id)).rejects.toThrow(readOnly);
  await expect(service.dequeue(child.id, "m", "send")).rejects.toThrow(readOnly);
  expect(() => service.updateSettings(child.id, SETTINGS)).toThrow(readOnly);
  expect(() => service.rename(child.id, "New")).toThrow(readOnly);
  expect(() => service.stop(child.id)).toThrow(readOnly);
  expect(() => service.answer(child.id, "a", { kind: "decision", decision: "allow" })).toThrow(
    readOnly,
  );

  service.stop(chat.id);
  await idle();
  const [, reply] = service.messages(child.id);
  expect(reply).toMatchObject({ status: "stopped", model: "sub-1", agentId: "claude" });
  expect(reply?.finishedAt).toEqual(expect.any(Number));
  const task = store.chat(child.id)?.task;
  expect(task).toMatchObject({ status: "cancelled", summary: "It is in rook.json", error: null });
  expect(task?.finishedAt).toEqual(expect.any(Number));
  // The runtime's later update of the part kept the link.
  expect(agentPart()).toMatchObject({ chatId: child.id, output: "Search\n\nIt is in rook.json" });
  const summaries = events.flatMap((e) => (e.type === "chat" && e.chat.id === child.id ? [e] : []));
  expect(summaries.at(-1)?.chat.task?.status).toBe("cancelled");

  // Deleting the parent deletes its subagents' chats too.
  await service.delete(chat.id);
  expect(store.chat(child.id)).toBeNull();
  expect(events).toContainEqual({ type: "chatDeleted", chatId: child.id });
});

test("a subagent that completes or fails sets its chat's task and reply", async () => {
  const { service, store, chat, idle } = await setup(subagentTurn);
  await service.send(chat.id, { text: "go", attachments: [] });
  await idle();
  await service.send(chat.id, { text: "fail", attachments: [] });
  await idle();
  const [done, failed] = store.children(chat.id);
  expect(done?.task).toMatchObject({ status: "completed", summary: "It is in rook.json" });
  expect(service.messages(done!.id).at(-1)?.status).toBe("done");
  expect(failed?.task).toMatchObject({ status: "failed", error: "Boom" });
  expect(service.messages(failed!.id).at(-1)).toMatchObject({ status: "error", error: "Boom" });
  // Each turn's part links to its own subagent's chat.
  const links = service
    .messages(chat.id)
    .flatMap((m) => m.parts)
    .flatMap((p) => (p.kind === "tool" && p.chatId ? [p.chatId] : []));
  expect(links).toEqual([done!.id, failed!.id]);
  // Its own chat can be deleted; the parent stays.
  await service.delete(done!.id);
  expect(store.chat(done!.id)).toBeNull();
  expect(store.chat(chat.id)).not.toBeNull();
});

test("a restart marks a running subagent interrupted, leaving delegated tasks alone", async () => {
  const { store, chat, runtime, dir } = await setup(async () => undefined);
  const task = {
    status: "running" as const,
    summary: null,
    filesChanged: [],
    error: null,
    finishedAt: null,
    clientRequestId: null,
    parentMessageId: null,
    startHead: null,
    dirtyAtStart: [],
    deadline: 0,
    delivered: true,
  };
  const lineage = (relationship: "task" | "subagent") => ({
    parentChatId: chat.id,
    relationship,
    depth: 1,
  });
  store.createChat("sub", chat.projectId, "Sub", SETTINGS, null, lineage("subagent"), task);
  store.createChat("task", chat.projectId, "Task", SETTINGS, null, lineage("task"), task);
  store.saveMessage({
    id: "r",
    chatId: "sub",
    role: "assistant",
    parts: [{ kind: "text", text: "Half done" }],
    attachments: [],
    status: "stopped",
    error: null,
    agentId: "claude",
    model: null,
    createdAt: 1,
  });
  // oxlint-disable-next-line no-new -- the constructor does the work
  new ChatService({
    store,
    runtimes: [runtime],
    git: gitClient(() => process.env),
    github: githubClient(() => process.env),
    dataDir: dir,
    emit: () => undefined,
    log: () => undefined,
  });
  expect(store.chat("sub")?.task).toMatchObject({
    status: "interrupted",
    summary: "Half done",
    error: "Rook closed while this subagent was running.",
  });
  // Delegation's reconcile finishes tasks; nothing reaches the parent from a subagent.
  expect(store.chat("task")?.task?.status).toBe("running");
  expect(store.queued(chat.id)).toEqual([]);
});

test.skipIf(!hasGit)("a subagent chat never keeps or removes its parent's worktree", async () => {
  const { service, store, project } = await setup(subagentTurn);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const parent = await service.create(service.projects()[0]!.id, SETTINGS, { worktree: true });
  await service.send(parent.id, { text: "go", attachments: [] });
  await until(() => !service.running(parent.id));
  await service.send(parent.id, { text: "go", attachments: [] });
  await until(() => !service.running(parent.id));
  const [first, second] = store.children(parent.id);
  expect(first?.worktreePath).toBe(parent.cwd);
  // Deleting one leaves the worktree to its parent.
  expect(await service.delete(first!.id)).toEqual({ keptWorktree: null });
  expect(existsSync(parent.cwd)).toBe(true);
  // The other doesn't keep it alive: deleting the parent removes both and the worktree.
  expect(await service.delete(parent.id)).toEqual({ keptWorktree: null });
  expect(store.chat(second!.id)).toBeNull();
  expect(existsSync(parent.cwd)).toBe(false);
});

test("rewind removes a message and what follows, and restarts the session", async () => {
  const gate = gated();
  const { service, store, chat, events, dir, idle } = await setup(gate.script);
  await service.send(chat.id, { text: "one", attachments: [] });
  await until(() => gate.waiting() === 1);
  gate.end();
  await idle();
  const notes = { name: "a.md", mediaType: "text/markdown", data: bytes("notes") };
  await service.send(chat.id, { text: "two", attachments: [notes] });
  await until(() => gate.waiting() === 1);
  const [, firstReply, two] = store.messages(chat.id);
  const saved = NodePath.join(dir, "attachments", chat.id, `${two!.attachments[0]!.id}.md`);
  expect(existsSync(saved)).toBe(true);
  await expect(service.rewind(chat.id, two!.id, { revertFiles: false })).rejects.toThrow(
    "Wait for the reply",
  );
  await service.send(chat.id, { text: "three", attachments: [] });
  service.stop(chat.id); // Holds the queued "three".
  await idle();
  const reply = store
    .messages(chat.id)
    .find((m) => m.role === "assistant" && m.id !== firstReply!.id);
  const three = store.queued(chat.id)[0]!;
  store.setSession(chat.id, "s1");

  const invalid = "no longer in the chat";
  await expect(service.rewind(chat.id, firstReply!.id, { revertFiles: false })).rejects.toThrow(
    invalid,
  );
  await expect(service.rewind(chat.id, three.id, { revertFiles: false })).rejects.toThrow(invalid);
  await expect(service.rewind(chat.id, "gone", { revertFiles: false })).rejects.toThrow(invalid);
  await expect(service.rewind(chat.id, two!.id, {})).rejects.toThrow("not valid");
  store.createChat("sub", chat.projectId, "Sub", SETTINGS, null, {
    parentChatId: chat.id,
    relationship: "subagent",
    depth: 1,
  });
  await expect(service.rewind("sub", two!.id, { revertFiles: false })).rejects.toThrow("read-only");

  events.length = 0;
  expect(await service.rewind(chat.id, two!.id, { revertFiles: true })).toEqual({ text: "two" });
  expect(service.messages(chat.id).map(line)).toEqual([
    "user done one",
    "assistant done re: one end",
    "user queued three",
  ]);
  expect(events.filter((e) => e.type === "messageDeleted").map((e) => e.messageId)).toEqual([
    two!.id,
    reply!.id,
  ]);
  expect(existsSync(saved)).toBe(false);
  // The next turn starts a new session, handed the history that is left.
  expect(store.chat(chat.id)).toMatchObject({ sessionId: null, handoff: true, context: null });
  expect(events.at(-1)).toMatchObject({ type: "chat", chat: { handoff: true, started: false } });
});

test.skipIf(!hasGit)(
  "rewind can revert the files of every removed turn",
  async () => {
    const { service, project, chat, store } = await setup(async (input, sink) => {
      sink.text("ok");
      if (input.prompt !== "quiet")
        await writeFile(NodePath.join(input.cwd, `${input.prompt}.txt`), "x\n");
    });
    const idle = () => settle(() => !service.chats().some((c) => c.running));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: project, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    await writeFile(NodePath.join(project, "a.txt"), "a\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    for (const text of ["kept", "quiet", "one", "two"]) {
      // oxlint-disable-next-line no-await-in-loop -- turns run one after another
      await service.send(chat.id, { text, attachments: [] });
      // oxlint-disable-next-line no-await-in-loop
      await idle();
    }
    // From "quiet", whose own turn changed nothing: back to before "one".
    const quiet = store
      .messages(chat.id)
      .find((m) => m.parts[0]?.kind === "text" && m.parts[0].text === "quiet")!;
    expect(await service.rewind(chat.id, quiet.id, { revertFiles: true })).toEqual({
      text: "quiet",
    });
    expect(existsSync(NodePath.join(project, "kept.txt"))).toBe(true);
    expect(existsSync(NodePath.join(project, "one.txt"))).toBe(false);
    expect(existsSync(NodePath.join(project, "two.txt"))).toBe(false);
    expect(git("for-each-ref", "--format=%(refname)", "refs/rook/rewind/").trim()).toBe(
      `refs/rook/rewind/${chat.id}/1`,
    );
    // The next turn's changes start from the reverted folder.
    await service.send(chat.id, { text: "three", attachments: [] });
    await idle();
    expect(store.messages(chat.id).at(-1)!.parts.at(-1)).toMatchObject({
      kind: "changes",
      files: [{ path: "three.txt", additions: 1, deletions: 0 }],
    });

    // While files revert, nothing can start in that chat or folder, nor a second rewind.
    const { git: client } = (service as unknown as { options: { git: GitClient } }).options;
    const restore = client.restore;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    client.restore = async (...args) => {
      await gate;
      return restore(...args);
    };
    const three = store.messages(chat.id).findLast((m) => m.role === "user")!;
    const rewinding = service.rewind(chat.id, three.id, { revertFiles: true });
    await expect(service.send(chat.id, { text: "now", attachments: [] })).rejects.toThrow(
      "Wait for the rewind",
    );
    await expect(service.rewind(chat.id, three.id, { revertFiles: false })).rejects.toThrow(
      "already rewinding",
    );
    expect(service.busy(NodePath.join(project, "sub"))).toBe(true);
    release();
    expect(await rewinding).toEqual({ text: "three" });
    expect(existsSync(NodePath.join(project, "three.txt"))).toBe(false);
    expect(service.busy(project)).toBe(false);
  },
  30_000,
);

test("overlaps: the same folder or one inside the other share files", () => {
  const root = NodePath.resolve("/repo");
  expect(overlaps(root, root)).toBe(true);
  expect(overlaps(root, NodePath.join(root, "sub"))).toBe(true);
  expect(overlaps(NodePath.join(root, "sub"), root)).toBe(true);
  expect(overlaps(root, `${root}2`)).toBe(false);
});
