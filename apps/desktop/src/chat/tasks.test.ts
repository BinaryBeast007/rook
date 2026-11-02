import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import type { AccessMode, ChatAgentId, ChatSettings } from "@rook/contracts";
import { afterEach, expect, test } from "vite-plus/test";

import { tempDir } from "../agents/testing/fakeBin.ts";
import { gitClient } from "./git.ts";
import { buildHandoff } from "./handoff.ts";
import { githubClient } from "./github.ts";
import { startMcpServer, type McpServer, type McpToolResult } from "./mcp.ts";
import { ChatRuntimeError, type ChatRuntime, type TurnInput, type TurnSink } from "./runtime.ts";
import { ChatService } from "./service.ts";
import { openChatStore } from "./store.ts";
import {
  CHILD_GUIDANCE,
  Delegation,
  MAX_RUNNING_CHILDREN,
  PARENT_GUIDANCE,
  RESULT_TASK_BYTES,
  RESULT_TOTAL_BYTES,
  taskResultsPrompt,
  type TaskView,
} from "./tasks.ts";

const settings = (access: AccessMode = "edit"): ChatSettings => ({
  agentId: "claude",
  model: null,
  effort: "high",
  fast: true,
  access,
});

let hasGit = true;
try {
  execFileSync("git", ["--version"]);
} catch {
  hasGit = false;
}

const servers: McpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** How a waiting turn ends: a tool row, then `text`; or the agent fails with `error`. */
interface End {
  readonly text?: string;
  readonly error?: string;
}

/** Every turn waits for its chat's gate (or Stop). Records every input. */
function gatedRuntime(
  agentId: ChatAgentId,
  inputs: TurnInput[],
  gates: Map<string, (end: End) => void>,
) {
  const runtime: ChatRuntime = {
    agentId,
    accessModes: ["ask", "edit", "auto", "full"],
    catalog: async () => ({
      agentId,
      accessModes: ["ask", "edit", "auto", "full"],
      error: null,
      models: [
        {
          id: "no-auto",
          name: "No auto",
          description: null,
          efforts: [],
          defaultEffort: null,
          fast: false,
          auto: false,
          images: false,
          isDefault: true,
          legacy: false,
        },
        {
          id: "auto-ok",
          name: "Auto",
          description: null,
          efforts: [],
          defaultEffort: null,
          fast: false,
          auto: true,
          images: false,
          isDefault: false,
          legacy: false,
        },
      ],
    }),
    run: async (input: TurnInput, sink: TurnSink, signal: AbortSignal) => {
      inputs.push(input);
      sink.text(`re: ${input.prompt}`);
      const end = await new Promise<End | null>((resolve) => {
        gates.set(input.chatId, resolve);
        signal.addEventListener("abort", () => resolve(null));
      });
      gates.delete(input.chatId);
      if (!end || signal.aborted) return;
      sink.tool({
        id: "t",
        tool: "edit",
        title: "Edit",
        detail: null,
        output: null,
        status: "done",
      });
      if (end.text) sink.text(end.text);
      if (end.error) throw new ChatRuntimeError(end.error);
    },
    dispose: () => undefined,
  };
  return runtime;
}

async function setup(
  options: { parent?: ChatSettings; worktree?: boolean; git?: boolean; timeoutMs?: number } = {},
) {
  const dir = await tempDir("rook-tasks-");
  const project = NodePath.join(dir, "project");
  await mkdir(project);
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8" });
  if (options.git) {
    sh("init", "-q", "-b", "main");
    await writeFile(NodePath.join(project, "a.txt"), "a");
    sh("add", ".");
    sh("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  }
  const inputs: TurnInput[] = [];
  const gates = new Map<string, (end: End) => void>();
  const file = NodePath.join(dir, "chats.db");
  const store = openChatStore(file);
  const git = gitClient(() => process.env);
  const service = new ChatService({
    store,
    runtimes: [gatedRuntime("claude", inputs, gates), gatedRuntime("codex", inputs, gates)],
    git,
    github: githubClient(() => process.env),
    dataDir: dir,
    emit: () => undefined,
    log: () => undefined,
  });
  const delegation = new Delegation({
    service,
    store,
    git,
    log: () => undefined,
    timeoutMs: options.timeoutMs,
    coalesceMs: 50,
  });
  const server = await startMcpServer(delegation, { log: () => undefined });
  servers.push(server);
  delegation.server = server;
  service.hooks = delegation;
  // Turns ended per chat: a turn's end may start the next one at once (queued task results).
  const ended = new Map<string, number>();
  const turnEnded = delegation.turnEnded.bind(delegation);
  delegation.turnEnded = (chatId, reply) => {
    ended.set(chatId, (ended.get(chatId) ?? 0) + 1);
    turnEnded(chatId, reply);
  };
  const { id: projectId } = service.addProject(project);
  const newChat = (s = options.parent ?? settings()) =>
    service.create(projectId, s, { worktree: options.worktree === true });
  const parent = await newChat();

  /** Starts a parent turn and waits until it is running. */
  const run = async (chatId: string, text = "go") => {
    await service.send(chatId, { text, attachments: [] });
    await until(() => inputs.some((i) => i.chatId === chatId && i.prompt === text));
  };
  const call = (name: string, args: unknown, chatId = parent.id) =>
    delegation.call({ chatId }, name, args);
  const delegate = async (args: object, chatId = parent.id) => {
    const result = await call("delegate_task", args, chatId);
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    return result.structuredContent as TaskView;
  };
  const inputOf = (chatId: string) => inputs.find((i) => i.chatId === chatId);
  const reply = (chatId: string) =>
    service.messages(chatId).findLast((m) => m.role === "assistant");
  /** Ends the chat's waiting turn and waits until it has ended. */
  const finish = async (chatId: string, end: End = { text: "Done." }) => {
    await until(() => gates.has(chatId));
    const before = ended.get(chatId) ?? 0;
    gates.get(chatId)!(end);
    await until(() => (ended.get(chatId) ?? 0) > before);
  };
  const task = (chatId: string) => store.chat(chatId)!.task!;
  /** The parent's queued task results. */
  const results = (chatId = parent.id) =>
    store
      .queued(chatId)
      .flatMap((m) => m.parts)
      .flatMap((p) => (p.kind === "taskResults" ? p.results : []));
  /**
   * Rook again on the same database, as after a crash: the first service's turns never end.
   * Reconciles unless told not to.
   */
  const restart = async (reconcile = true) => {
    const again = openChatStore(file);
    const turns: TurnInput[] = [];
    const service2 = new ChatService({
      store: again,
      runtimes: [gatedRuntime("claude", turns, new Map()), gatedRuntime("codex", turns, new Map())],
      git,
      github: githubClient(() => process.env),
      dataDir: dir,
      emit: () => undefined,
      log: () => undefined,
    });
    const delegation2 = new Delegation({ service: service2, store: again, git, coalesceMs: 50 });
    service2.hooks = delegation2;
    if (reconcile) await delegation2.reconcile();
    const queued = (chatId = parent.id) =>
      again
        .queued(chatId)
        .flatMap((m) => m.parts)
        .flatMap((p) => (p.kind === "taskResults" ? p.results : []));
    return { store: again, service: service2, delegation: delegation2, inputs: turns, queued };
  };
  return {
    restart,
    inputs,
    finish,
    task,
    results,
    dir,
    project,
    sh,
    store,
    service,
    delegation,
    server,
    parent,
    newChat,
    run,
    call,
    delegate,
    inputOf,
    reply,
    gates,
  };
}

async function until(ready: () => boolean) {
  for (let i = 0; i < 400 && !ready(); i++)
    // oxlint-disable-next-line no-await-in-loop -- polling background turns
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(ready()).toBe(true);
}

const code = (result: McpToolResult) =>
  result.isError ? (result.structuredContent as { error: string }).error : null;

/** A JSON-RPC call to the real MCP server with a chat's token. */
async function rpc(url: string, token: string, method: string, params: object) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return ((await response.json()) as { result: Record<string, unknown> }).result;
}

test("delegate_task over MCP starts a child that sees only its task, with a card in the parent", async () => {
  const { service, store, parent, run, inputOf, reply } = await setup();
  await run(parent.id);
  const parentInput = inputOf(parent.id)!;
  expect(parentInput.instructions).toBe(PARENT_GUIDANCE);
  const mcp = parentInput.mcp!;
  const token = mcp.credential();
  expect((await rpc(mcp.url, token, "tools/list", {})).tools).toHaveLength(3);
  const called = await rpc(mcp.url, token, "tools/call", {
    name: "delegate_task",
    arguments: { task: "Fix the flaky test in a.test.ts", title: "Fix flaky test" },
  });
  const view = called.structuredContent as TaskView;
  expect(view).toMatchObject({
    title: "Fix flaky test",
    status: "running",
    summary: null,
    agent: "claude",
    model: null,
    access: "edit",
    worktree: false,
    runningTasks: 1,
  });

  const child = store.chat(view.taskId)!;
  expect(child.lineage).toEqual({ parentChatId: parent.id, relationship: "task", depth: 1 });
  expect(child.settings).toEqual(settings()); // Same agent and model: effort and fast too.
  expect(child.worktreePath).toBeNull();
  expect(service.chats().find((c) => c.id === child.id)?.cwd).toBe(
    service.chats().find((c) => c.id === parent.id)?.cwd,
  );
  expect(child.task).toMatchObject({ status: "running", delivered: false });
  expect(child.task!.deadline).toBeGreaterThan(Date.now());

  // The card sits in the parent's live reply, which the task record points at.
  const live = reply(parent.id)!;
  expect(child.task!.parentMessageId).toBe(live.id);
  expect(live.parts.at(-1)).toEqual({
    kind: "tool",
    tool: "task",
    id: child.id,
    title: "Fix flaky test",
    detail: "Fix the flaky test in a.test.ts",
    output: null,
    status: "running",
  });

  // The child gets the task text alone: no parent history, no MCP, task guidance.
  await until(() => inputOf(child.id) !== undefined); // Its turn starts after a checkpoint.
  const childInput = inputOf(child.id)!;
  expect(childInput.prompt).toBe("Fix the flaky test in a.test.ts");
  expect(childInput.history).toBeNull();
  expect(childInput.mcp ?? null).toBeNull();
  expect(childInput.instructions).toBe(CHILD_GUIDANCE);
  expect(service.chats().find((c) => c.id === child.id)?.running).toBe(true);
});

test("delegation tools are hidden from task chats and refused there", async () => {
  const { delegation, parent, run, delegate, call } = await setup();
  expect(delegation.list({ chatId: parent.id }).map((t) => t.name)).toEqual([
    "delegate_task",
    "task_status",
    "task_cancel",
  ]);
  await run(parent.id);
  const { taskId } = await delegate({ task: "work" });
  expect(delegation.list({ chatId: taskId })).toEqual([]);
  expect(code(await call("delegate_task", { task: "more" }, taskId))).toBe("not_allowed");
});

test("arguments are checked strictly", async () => {
  const { parent, run, call } = await setup();
  await run(parent.id);
  for (const args of [
    null,
    {},
    { task: "" },
    { task: "  " },
    { task: "x", extra: 1 },
    { task: "x", agent: "gemini" },
    { task: "x", worktree: "yes" },
    { task: "x", title: "t".repeat(81) },
    { task: "x", model: "--dangerous arg" },
  ])
    // oxlint-disable-next-line no-await-in-loop -- one at a time
    expect(code(await call("delegate_task", args)), JSON.stringify(args)).toBe("invalid_request");
  expect(code(await call("task_status", { taskId: 1 }))).toBe("invalid_request");
});

test("a retry with the same clientRequestId returns the same task", async () => {
  const { store, parent, run, delegate } = await setup();
  await run(parent.id);
  const args = { task: "work", clientRequestId: "req-1" };
  const [a, b] = await Promise.all([delegate(args), delegate(args)]);
  const c = await delegate(args);
  expect(new Set([a.taskId, b.taskId, c.taskId]).size).toBe(1);
  expect(store.children(parent.id)).toHaveLength(1);
});

test("tasks start only during the parent's turn, and at most four run at once", async () => {
  const { parent, run, call, store } = await setup();
  expect(code(await call("delegate_task", { task: "work" }))).toBe("parent_not_active");
  await run(parent.id);
  // Calls in flight count too.
  const results = await Promise.all(
    Array.from({ length: MAX_RUNNING_CHILDREN + 1 }, (_, i) =>
      call("delegate_task", { task: `work ${i}` }),
    ),
  );
  expect(results.map(code).filter(Boolean)).toEqual(["limit_reached"]);
  expect(store.children(parent.id)).toHaveLength(MAX_RUNNING_CHILDREN);
});

test("access is never broader than the parent's; an inherited auto steps down to edit", async () => {
  const edit = await setup();
  await edit.run(edit.parent.id);
  expect(code(await edit.call("delegate_task", { task: "x", access: "full" }))).toBe(
    "access_escalation",
  );
  expect((await edit.delegate({ task: "x", access: "ask" })).access).toBe("ask");
  // Another agent: its default model, no effort or fast.
  const codex = await edit.delegate({ task: "x", agent: "codex" });
  expect(edit.store.chat(codex.taskId)!.settings).toEqual({
    agentId: "codex",
    model: null,
    effort: null,
    fast: false,
    access: "edit",
  });

  const auto = await setup({ parent: settings("auto") });
  await auto.run(auto.parent.id);
  // The default model can't run auto.
  expect((await auto.delegate({ task: "x" })).access).toBe("edit");
  expect((await auto.delegate({ task: "x", model: "auto-ok" })).access).toBe("auto");
  expect(code(await auto.call("delegate_task", { task: "x", access: "auto" }))).toBe(
    "invalid_request",
  );
  // A model override drops the parent's effort and fast.
  const other = await auto.delegate({ task: "x", model: "auto-ok" });
  expect(auto.store.chat(other.taskId)!.settings).toMatchObject({ effort: null, fast: false });
});

test("task_status sees only the caller's own tasks", async () => {
  const { parent, run, delegate, call, newChat } = await setup();
  const other = await newChat();
  await run(parent.id);
  await run(other.id, "other");
  const { taskId } = await delegate({ task: "work", title: "Mine" });
  const status = await call("task_status", { taskId });
  expect(status.structuredContent).toMatchObject({ taskId, title: "Mine", status: "running" });
  expect(JSON.parse(status.content[0]!.text)).toEqual(status.structuredContent);
  expect(code(await call("task_status", { taskId }, other.id))).toBe("task_not_found");
  expect(code(await call("task_cancel", { taskId }, other.id))).toBe("task_not_found");
  expect(code(await call("task_status", { taskId: "nope" }))).toBe("task_not_found");
});

test("task_cancel stops the child and marks its card, after the parent's turn ended", async () => {
  const { service, store, parent, run, delegate, call, finish, reply } = await setup();
  await run(parent.id);
  const { taskId } = await delegate({ task: "work", title: "Job" });
  const cardMessage = store.chat(taskId)!.task!.parentMessageId!;
  await finish(parent.id); // The parent's turn ends; the card stays in its saved reply.
  await until(() => !service.running(parent.id));

  const cancelled = await call("task_cancel", { taskId, reason: "not needed" });
  expect(cancelled.structuredContent).toMatchObject({ status: "cancelled", runningTasks: 0 });
  expect(service.running(taskId)).toBe(false);
  expect(store.chat(taskId)!.task).toMatchObject({ status: "cancelled", delivered: true });
  expect(reply(taskId)?.status).toBe("stopped");
  const saved = store.message(cardMessage)!;
  expect(saved.parts.find((p) => p.kind === "tool" && p.id === taskId)).toMatchObject({
    status: "declined",
    detail: "work",
  });
  expect(reply(parent.id)?.id).toBe(cardMessage);
});

test("deleting a parent cancels its running tasks and keeps them as top-level chats", async () => {
  const { service, store, parent, run, delegate, delegation } = await setup();
  await run(parent.id);
  const { taskId } = await delegate({ task: "work" });
  await service.delete(parent.id);
  const child = store.chat(taskId)!;
  expect(child.lineage).toBeNull();
  expect(child.depth).toBe(1);
  expect(child.task?.status).toBe("cancelled");
  expect(service.running(taskId)).toBe(false);
  expect(delegation.list({ chatId: taskId })).toEqual([]);
});

test.skipIf(!hasGit)("worktree tasks branch from the parent's folder HEAD", async () => {
  const { store, service, parent, run, delegate, dir } = await setup({ git: true, worktree: true });
  const parentCwd = store.chat(parent.id)!.worktreePath!;
  const inParent = (...args: string[]) =>
    execFileSync("git", args, { cwd: parentCwd, encoding: "utf8" }).trim();
  inParent("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "p");
  const head = inParent("rev-parse", "HEAD");
  await run(parent.id);

  // Shared: the parent's own worktree.
  const shared = await delegate({ task: "look" });
  expect(shared.worktree).toBe(false);
  expect(store.chat(shared.taskId)!.worktreePath).toBe(parentCwd);
  expect(store.chat(shared.taskId)!.task!.startHead).toBe(head);

  // Own worktree, from the parent's HEAD (not main's).
  const own = await delegate({ task: "build", worktree: true });
  expect(own.worktree).toBe(true);
  const ownCwd = store.chat(own.taskId)!.worktreePath!;
  expect(ownCwd.startsWith(NodePath.join(dir, "worktrees"))).toBe(true);
  const inOwn = (...args: string[]) =>
    execFileSync("git", args, { cwd: ownCwd, encoding: "utf8" }).trim();
  expect(inOwn("rev-parse", "HEAD")).toBe(head);
  expect(inOwn("branch", "--show-current")).toBe(`rook/chat-${own.taskId.slice(0, 8)}`);
  expect(store.chat(own.taskId)!.task!.dirtyAtStart).toEqual([]);
  expect(service.chats().find((c) => c.id === own.taskId)?.cwd).toBe(ownCwd);
});

test("a worktree task in a folder that is not a repository fails cleanly", async () => {
  const { parent, run, call, store } = await setup();
  await run(parent.id);
  expect(code(await call("delegate_task", { task: "x", worktree: true }))).toBe("worktree_failed");
  expect(store.children(parent.id)).toHaveLength(0);
});

// P5: finishing, delivering and cancelling tasks.

test("a finished task is delivered once and wakes the busy parent after its turn ends", async () => {
  const { service, store, parent, run, delegate, finish, task, results, inputs, reply } =
    await setup();
  await run(parent.id);
  const { taskId } = await delegate({ task: "work", title: "Job" });
  await finish(taskId, { text: "All fixed." });
  await until(() => task(taskId).status === "completed");
  expect(task(taskId)).toMatchObject({ summary: "All fixed.", error: null, delivered: true });
  expect(results()).toMatchObject([{ taskId, title: "Job", status: "completed" }]);
  const cardOf = () =>
    store
      .message(task(taskId).parentMessageId!)!
      .parts.find((p) => p.kind === "tool" && p.id === taskId);
  expect(cardOf()).toMatchObject({ status: "done", output: "All fixed." });

  // The parent is mid-turn: nothing is steered in; the results wait for its turn to end.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(inputs.filter((i) => i.chatId === parent.id)).toHaveLength(1);
  await finish(parent.id);
  await until(() => inputs.filter((i) => i.chatId === parent.id).length === 2);
  const prompt = inputs.findLast((i) => i.chatId === parent.id)!.prompt;
  expect(prompt.startsWith("<rook_task_results>")).toBe(true);
  expect(prompt).toContain("## Job");
  expect(prompt).toContain("All fixed.");
  expect(prompt).not.toContain("Still running");
  expect(results()).toEqual([]);

  // The user chatting with the finished child later doesn't finish it again.
  const finishedAt = task(taskId).finishedAt;
  await run(taskId, "and one more thing");
  await finish(taskId, { text: "Sure." });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(task(taskId)).toMatchObject({ summary: "All fixed.", finishedAt });
  expect(reply(taskId)?.parts.at(-1)).toEqual({ kind: "text", text: "Sure." });
  const deliveries = service.messages(parent.id).filter((m) => m.parts[0]?.kind === "taskResults");
  expect(deliveries).toHaveLength(1);
});

test("a failed task carries the agent's own error", async () => {
  const { parent, run, delegate, finish, task, results } = await setup();
  await run(parent.id);
  const { taskId } = await delegate({ task: "work" });
  await finish(taskId, { error: "Rate limited by the provider." });
  await until(() => task(taskId).status === "failed");
  expect(task(taskId).error).toBe("Rate limited by the provider.");
  expect(results()).toMatchObject([{ status: "failed", error: "Rate limited by the provider." }]);
});

test("cancelled by the parent is not delivered; stopped or deleted by the user is", async () => {
  const { service, store, parent, run, delegate, call, task, results } = await setup();
  await run(parent.id);
  const byParent = await delegate({ task: "a", title: "A" });
  await call("task_cancel", { taskId: byParent.taskId });
  expect(task(byParent.taskId).status).toBe("cancelled");
  expect(results()).toEqual([]);

  const stopped = await delegate({ task: "b", title: "B" });
  service.stop(stopped.taskId);
  await until(() => task(stopped.taskId).status === "cancelled");
  const deleted = await delegate({ task: "c", title: "C" });
  await service.delete(deleted.taskId);
  expect(store.chat(deleted.taskId)).toBeNull();
  expect(results().map((r) => [r.title, r.status])).toEqual([
    ["B", "cancelled"],
    ["C", "cancelled"],
  ]);
});

test("a task past its deadline times out and is delivered as timedOut", async () => {
  const { service, parent, run, delegate, task, results } = await setup({ timeoutMs: 60 });
  await run(parent.id);
  const { taskId } = await delegate({ task: "slow" });
  await until(() => task(taskId).status === "timedOut");
  expect(service.running(taskId)).toBe(false);
  expect(results()).toMatchObject([{ taskId, status: "timedOut" }]);
});

test("siblings finishing together reach the idle parent in one turn, naming those still running", async () => {
  const { parent, run, delegate, finish, inputs } = await setup();
  await run(parent.id);
  const a = await delegate({ task: "a", title: "Alpha" });
  const b = await delegate({ task: "b", title: "Beta" });
  await delegate({ task: "c", title: "Gamma" });
  await finish(parent.id);
  await Promise.all([finish(a.taskId), finish(b.taskId)]);
  await until(() => inputs.filter((i) => i.chatId === parent.id).length === 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const turns = inputs.filter((i) => i.chatId === parent.id);
  expect(turns).toHaveLength(2);
  expect(turns[1]!.prompt).toContain("## Alpha");
  expect(turns[1]!.prompt).toContain("## Beta");
  expect(turns[1]!.prompt).toContain(
    "Still running: Gamma; their results arrive automatically.\n</rook_task_results>",
  );
});

test("a stopped parent keeps its tasks and holds their results until Send now", async () => {
  const { service, store, parent, run, delegate, finish, task, inputs } = await setup();
  await run(parent.id);
  const { taskId } = await delegate({ task: "work" });
  service.stop(parent.id);
  await until(() => !service.running(parent.id));
  expect(service.running(taskId)).toBe(true);
  await finish(taskId);
  await until(() => task(taskId).status === "completed");
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(inputs.filter((i) => i.chatId === parent.id)).toHaveLength(1);
  const [queued] = store.queued(parent.id);
  await service.dequeue(parent.id, queued!.id, "send");
  await until(() => inputs.filter((i) => i.chatId === parent.id).length === 2);
  expect(inputs.at(-1)!.prompt).toContain("<rook_task_results>");
});

test("cancelling cascades to the task's own tasks first and drops their undelivered results", async () => {
  const { service, store, parent, run, delegate, call, finish, task, results } = await setup();
  await run(parent.id);
  const { taskId } = await delegate({ task: "lead" });
  // MAX_DEPTH keeps agents from nesting; the store and service don't, so build it directly.
  const child = store.chat(taskId)!;
  const nested = async (title: string) => {
    const grandchild = await service.createTask(child, child.settings, false, title, {
      ...child.task!,
      parentMessageId: null,
    });
    await service.send(grandchild.id, { text: title, attachments: [] });
    return grandchild.id;
  };
  const done = await nested("done");
  const running = await nested("running");
  await finish(done);
  await until(() => results(taskId).length === 1); // Queued in the busy child.
  const order: string[] = [];
  const finishTask = store.finishTask;
  store.finishTask = (id, ...rest) => (order.push(id), finishTask(id, ...rest));

  await call("task_cancel", { taskId });
  expect(order).toEqual([running, taskId]);
  expect(task(running).status).toBe("cancelled");
  expect(results(taskId)).toEqual([]);
  expect(results()).toEqual([]);
});

test("a task whose turn can't start fails and is delivered, not left running", async () => {
  const { service, store, parent, run, call, results } = await setup();
  await run(parent.id);
  service.send = () => Promise.reject(new ChatRuntimeError("The agent is not installed."));
  const view = (await call("delegate_task", { task: "work" })).structuredContent as TaskView;
  expect(view).toMatchObject({ status: "failed", error: "The agent is not installed." });
  expect(results()).toMatchObject([{ taskId: view.taskId, status: "failed" }]);
  const card = store
    .message(store.chat(view.taskId)!.task!.parentMessageId!)!
    .parts.find((p) => p.kind === "tool" && p.id === view.taskId);
  expect(card).toMatchObject({ status: "failed" });
});

test.skipIf(!hasGit)("a worktree task reports the files it changed", async () => {
  const { store, parent, run, delegate, finish, task } = await setup({ git: true });
  await run(parent.id);
  const { taskId } = await delegate({ task: "build", worktree: true });
  const cwd = store.chat(taskId)!.worktreePath!;
  await writeFile(NodePath.join(cwd, "new.txt"), "new");
  await writeFile(NodePath.join(cwd, "a.txt"), "changed");
  await finish(taskId);
  await until(() => task(taskId).status === "completed");
  expect(task(taskId).filesChanged).toEqual(["a.txt", "new.txt"]);
});

const bigResult = (i: number) => ({
  taskId: `t${i}`,
  title: `Task ${i}`,
  status: "completed" as const,
  summary: "é".repeat(5_000),
  filesChanged: ["a.ts"],
  error: null,
  finishedAt: 1,
});

test("the results prompt is capped per task and in total, and handoffs carry results", () => {
  const result = bigResult;
  const many = Array.from({ length: 8 }, (_, i) => result(i));
  const prompt = taskResultsPrompt(many, ["Other"]);
  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(RESULT_TOTAL_BYTES);
  expect(prompt).not.toContain("�");
  for (const block of prompt.split("\n## ").slice(1))
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(RESULT_TASK_BYTES);
  expect(prompt).toContain("Task 7"); // Named in the line for results that didn't fit.
  expect(prompt.endsWith("their results arrive automatically.\n</rook_task_results>")).toBe(true);

  const handoff = buildHandoff([
    {
      id: "m",
      chatId: "c",
      role: "user",
      parts: [{ kind: "taskResults", results: [{ ...result(1), summary: "Fixed it." }] }],
      attachments: [],
      status: "done",
      error: null,
      agentId: null,
      model: null,
      createdAt: 1,
    },
  ])!;
  expect(handoff).toContain("--- rook (delegated task results) ---");
  expect(handoff).toContain("[task result: Task 1 — completed]\nFiles changed: a.ts\nFixed it.");
});

// P7: a restart finishes the tasks Rook closed on and never runs anything unattended.

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a task running when Rook closed is interrupted, delivered, and its parent held until Send now", async () => {
  const { parent, run, delegate, restart } = await setup();
  await run(parent.id);
  const { taskId } = await delegate({ task: "work", title: "Job" });
  const after = await restart();

  expect(after.store.chat(taskId)!.task).toMatchObject({
    status: "interrupted",
    error: "Rook closed while this task was running.",
    delivered: true,
  });
  expect(after.queued()).toMatchObject([{ taskId, title: "Job", status: "interrupted" }]);
  const card = after.store
    .message(after.store.chat(taskId)!.task!.parentMessageId!)!
    .parts.find((p) => p.kind === "tool" && p.id === taskId);
  expect(card).toMatchObject({ status: "failed" });
  await pause(150);
  expect(after.inputs).toEqual([]); // Neither the parent nor the child runs unattended.
  expect(after.service.running(parent.id)).toBe(false);

  const [queued] = after.store.queued(parent.id);
  await after.service.dequeue(parent.id, queued!.id, "send");
  await until(() => after.inputs.length === 1);
  await pause(100);
  expect(after.inputs).toHaveLength(1);
  expect(after.inputs[0]!.chatId).toBe(parent.id);
  expect(after.inputs[0]!.prompt).toContain("<rook_task_results>");
  expect(after.inputs[0]!.prompt).toContain("## Job (task");
  expect(after.inputs[0]!.prompt).toContain("Rook closed while this task was running.");
});

test("a restart finishes a task from the last reply it saved: done or the agent's error", async () => {
  const { parent, run, delegate, restart, store, reply } = await setup();
  await run(parent.id);
  const done = await delegate({ task: "a" });
  const failed = await delegate({ task: "b" });
  // The turns ended and were saved, then Rook closed before finishing the tasks.
  await until(() => !!reply(done.taskId) && !!reply(failed.taskId));
  const doneReply = reply(done.taskId)!;
  store.saveMessage({ ...doneReply, parts: [{ kind: "text", text: "All done." }], status: "done" });
  const failedReply = reply(failed.taskId)!;
  store.saveMessage({ ...failedReply, status: "error", error: "Rate limited by the provider." });

  const after = await restart();
  expect(after.store.chat(done.taskId)!.task).toMatchObject({
    status: "completed",
    summary: "All done.",
    error: null,
  });
  expect(after.store.chat(failed.taskId)!.task).toMatchObject({
    status: "failed",
    error: "Rate limited by the provider.",
  });
  expect(after.queued().map((r) => r.status)).toEqual(["completed", "failed"]);
});

test("a restart finishes nested tasks deepest first", async () => {
  const { service, store, parent, run, delegate, restart } = await setup();
  await run(parent.id);
  const { taskId } = await delegate({ task: "lead" });
  const child = store.chat(taskId)!;
  const grandchild = await service.createTask(child, child.settings, false, "deep", {
    ...child.task!,
    parentMessageId: null,
  });
  const after = await restart(false);
  const order: string[] = [];
  const finishTask = after.store.finishTask;
  after.store.finishTask = (id, ...rest) => (order.push(id), finishTask(id, ...rest));
  await after.delegation.reconcile();
  expect(order).toEqual([grandchild.id, taskId]);
  expect(after.queued(taskId)).toMatchObject([{ taskId: grandchild.id, status: "interrupted" }]);
  expect(after.queued()).toMatchObject([{ taskId, status: "interrupted" }]);
});

test("a delegate_task retry after a restart returns the same task", async () => {
  const { parent, run, delegate, restart } = await setup();
  await run(parent.id);
  const first = await delegate({ task: "work", clientRequestId: "req-1" });
  const after = await restart();
  await after.service.send(parent.id, { text: "again", attachments: [] });
  const retry = await after.delegation.call({ chatId: parent.id }, "delegate_task", {
    task: "work",
    clientRequestId: "req-1",
  });
  expect(retry.structuredContent).toMatchObject({ taskId: first.taskId, status: "interrupted" });
  expect(after.store.children(parent.id)).toHaveLength(1);
});

test("reconciling again, or after another restart, never delivers twice", async () => {
  const { parent, run, delegate, restart } = await setup();
  await run(parent.id);
  const { taskId } = await delegate({ task: "work" });
  const first = await restart();
  await first.delegation.reconcile();
  expect(first.queued()).toHaveLength(1);

  // Rook closed again before the parent ran: the result is still queued, and held.
  const second = await restart();
  expect(second.queued()).toHaveLength(1);
  // Even a task left marked running finds its result already delivered.
  second.store.setTask(taskId, { ...second.store.chat(taskId)!.task!, status: "running" });
  await second.delegation.reconcile();
  expect(second.queued()).toHaveLength(1);
  await pause(150);
  expect(second.inputs).toEqual([]);
});
