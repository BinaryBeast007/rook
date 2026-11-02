import { readFile } from "node:fs/promises";
import * as NodePath from "node:path";

import type { ApprovalDecision, ChatSettings, ContextUsage } from "@rook/contracts";
import { afterEach, expect, test } from "vite-plus/test";

import { fakeBin, tempDir, testHost } from "../agents/testing/fakeBin.ts";
import {
  codexAccess,
  codexInput,
  codexModelOption,
  codexRuntime,
  codexToolUpdate,
  commandTitle,
  safeMessage,
} from "./codex.ts";
import type {
  ApprovalRequest,
  ChatRuntime,
  McpAccess,
  QuestionRequest,
  ReportedPart,
  SubagentEvent,
  ToolUpdate,
  TurnInput,
  TurnSink,
} from "./runtime.ts";

const runtimes: ChatRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

async function setup(extra: Record<string, string> = {}) {
  const dir = await tempDir();
  await fakeBin(dir, "codex", "codex-chat.mjs");
  const stateFile = NodePath.join(dir, "state.json");
  const host = testHost(dir, dir, { FAKE_STATE_FILE: stateFile, ...extra });
  const make = () => {
    const runtime = codexRuntime(host);
    runtimes.push(runtime);
    return runtime;
  };
  const requests = async (method: string) =>
    (
      JSON.parse(await readFile(stateFile, "utf8")) as {
        requests: { method: string; params: Record<string, unknown> }[];
      }
    ).requests
      .filter((request) => request.method === method)
      .map((request) => request.params);
  return { dir, host, runtime: make(), make, requests };
}

function recordingSink(answer: ApprovalDecision = "allow") {
  const events: { sessions: string[]; text: string; reasoning: string; models: string[] } = {
    sessions: [],
    text: "",
    reasoning: "",
    models: [],
  };
  const tools: ToolUpdate[] = [];
  const approvals: ApprovalRequest[] = [];
  const contexts: ContextUsage[] = [];
  const subagents: [string, SubagentEvent][] = [];
  const sink: TurnSink = {
    session: (id) => events.sessions.push(id),
    text: (delta) => (events.text += delta),
    reasoning: (delta) => (events.reasoning += delta),
    tool: (update) => tools.push(update),
    approve: async (request) => {
      approvals.push(request);
      return { decision: answer, feedback: null };
    },
    ask: async () => ({ declined: true, feedback: null }),
    reviewPlan: async () => ({ decision: "deny", feedback: null }),
    part: () => undefined,
    model: (id) => events.models.push(id),
    context: (usage) => contexts.push(usage),
    subagent: (id, event) => subagents.push([id, event]),
  };
  return { sink, events, tools, approvals, contexts, subagents };
}

/** One subagent transcript's events as short lines. */
function transcript(subagents: readonly [string, SubagentEvent][], id: string): string[] {
  return subagents
    .filter(([partId]) => partId === id)
    .map(([, event]) => {
      if (event.type === "started")
        return `started ${event.title} | ${event.prompt} | ${event.model}`;
      if (event.type === "ended") return `ended ${event.status} ${event.error}`;
      if (event.type === "tool") return `tool ${event.update.id} ${event.update.status}`;
      return `${event.type} ${event.delta}`;
    });
}

const settings: ChatSettings = {
  agentId: "codex",
  model: null,
  effort: null,
  fast: false,
  access: "ask",
};

const turn = (cwd: string, prompt: string, extra: Partial<TurnInput> = {}): TurnInput => ({
  chatId: "chat-1",
  cwd,
  sessionId: null,
  settings,
  prompt,
  images: [],
  history: null,
  ...extra,
});

const signal = () => AbortSignal.timeout(20_000);

test("codexAccess maps each access mode", () => {
  expect(codexAccess("ask", "/p")).toEqual({
    approvalPolicy: "untrusted",
    sandbox: "read-only",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    approvalsReviewer: "user",
  });
  expect(codexAccess("edit", "/p")).toMatchObject({
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/p"], networkAccess: false },
    approvalsReviewer: "user",
  });
  expect(codexAccess("auto", "/p")).toMatchObject({
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    approvalsReviewer: "auto_review",
  });
  expect(codexAccess("full", "/p")).toEqual({
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    sandboxPolicy: { type: "dangerFullAccess" },
    approvalsReviewer: "user",
  });
});

test("codexInput, codexModelOption, and safeMessage", () => {
  expect(
    codexInput({ prompt: "hi", images: [{ path: "/a.png", mediaType: "image/png" }] }),
  ).toEqual([
    { type: "text", text: "hi", text_elements: [] },
    { type: "localImage", path: "/a.png" },
  ]);
  expect(
    codexModelOption({
      id: "m",
      displayName: "",
      description: "",
      hidden: false,
      isDefault: false,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "medium",
      inputModalities: ["text"],
    }),
  ).toMatchObject({ name: "m", description: null, fast: false, images: false });
  expect(safeMessage("boom\n  at x")).toBe("boom");
  expect(safeMessage("")).toBe("Codex could not finish the reply.");
  expect(safeMessage("x".repeat(400))).toHaveLength(301);
});

test("commandTitle drops the shell Codex wraps commands in", () => {
  const ps = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content src/math.ts'`;
  expect(commandTitle(ps)).toBe("Get-Content src/math.ts");
  expect(commandTitle("/bin/bash -lc 'npm test'")).toBe("npm test");
  expect(commandTitle(ps, [{ command: "cat src/math.ts" }])).toBe("cat src/math.ts");
  expect(commandTitle("git status")).toBe("git status");
});

test("codexToolUpdate maps tool items", () => {
  const cwd = NodePath.resolve("/proj");
  const command = {
    type: "commandExecution",
    id: "c",
    command: "ls",
    status: "completed",
    aggregatedOutput: "x".repeat(5000),
    exitCode: 0,
  } as const;
  const mapped = codexToolUpdate(command, cwd, true);
  expect(mapped).toMatchObject({
    tool: "command",
    title: "Run `ls`",
    detail: "ls",
    status: "done",
  });
  // Long output keeps its end, after a note.
  expect(mapped?.output).toBe(`… earlier output not shown\n${"x".repeat(4000)}`);
  expect(mapped?.exitCode).toBe(0);
  expect(codexToolUpdate({ ...command, exitCode: 2 }, cwd, true)?.status).toBe("failed");
  expect(codexToolUpdate({ ...command, status: "declined" }, cwd, true)?.status).toBe("declined");
  expect(codexToolUpdate({ ...command, status: "inProgress" }, cwd, false)?.status).toBe("running");

  const edit = codexToolUpdate(
    {
      type: "fileChange",
      id: "f",
      changes: [
        { path: NodePath.join(cwd, "a.ts"), diff: "+a" },
        { path: NodePath.resolve("/elsewhere/b.ts"), diff: "+b" },
      ],
      status: "failed",
    },
    cwd,
    true,
  );
  expect(edit).toMatchObject({
    tool: "edit",
    title: "Edit 2 files",
    detail: `a.ts\n+a\n${NodePath.resolve("/elsewhere/b.ts")}\n+b`,
    status: "failed",
    files: [
      { path: "a.ts", additions: 1, deletions: 0 },
      { path: NodePath.resolve("/elsewhere/b.ts"), additions: 1, deletions: 0 },
    ],
  });
  // An added file's diff is its content; an update's headers and context don't count.
  const counted = codexToolUpdate(
    {
      type: "fileChange",
      id: "g",
      changes: [
        { path: NodePath.join(cwd, "new.ts"), diff: "-x\n+y\n", kind: { type: "add" } },
        {
          path: NodePath.join(cwd, "old.ts"),
          diff: "--- a/old.ts\n+++ b/old.ts\n@@ -1,2 +1,2 @@\n keep\n--- gone\n+++ came\n",
          kind: { type: "update", move_path: NodePath.join(cwd, "moved.ts") },
        },
        { path: NodePath.join(cwd, "gone.ts"), diff: "a\nb\n", kind: { type: "delete" } },
      ],
      status: "completed",
    },
    cwd,
    true,
  );
  expect(counted?.files).toEqual([
    { path: "new.ts", additions: 2, deletions: 0 },
    { path: "moved.ts", additions: 1, deletions: 1 },
    { path: "gone.ts", additions: 0, deletions: 2 },
  ]);

  expect(
    codexToolUpdate(
      {
        type: "mcpToolCall",
        id: "m",
        server: "docs",
        tool: "search",
        status: "completed",
        arguments: { q: 1 },
        result: { content: [{ type: "text", text: "found" }] },
        error: null,
      },
      cwd,
      true,
    ),
  ).toMatchObject({ tool: "mcp", title: "docs · search", output: "found", status: "done" });
  expect(
    codexToolUpdate({ type: "webSearch", id: "w", query: "vite", action: null }, cwd, false),
  ).toMatchObject({ tool: "web", title: 'Search the web for "vite"', status: "running" });
  expect(
    codexToolUpdate(
      {
        type: "dynamicToolCall",
        id: "d",
        tool: "lookup",
        status: "inProgress",
        arguments: null,
        contentItems: null,
      },
      cwd,
      false,
    ),
  ).toMatchObject({ tool: "other", title: "lookup", detail: null, status: "running" });
  expect(codexToolUpdate({ type: "agentMessage", id: "a" } as never, cwd, true)).toBeNull();
});

test("catalog reads every page of visible models", async () => {
  const { runtime, requests } = await setup();
  const catalog = await runtime.catalog(signal());
  expect(catalog).toMatchObject({ agentId: "codex", accessModes: ["ask", "edit", "auto", "full"] });
  expect(catalog.models).toEqual([
    {
      id: "gpt-fast",
      name: "GPT Fast",
      description: "Quick.",
      efforts: ["low", "high"],
      defaultEffort: "low",
      fast: true,
      auto: true,
      images: true,
      isDefault: true,
      legacy: false,
    },
    expect.objectContaining({ id: "gpt-plain", fast: false, images: false, legacy: false }),
  ]);
  expect((await requests("model/list")).map((params) => params.cursor)).toEqual([null, "page-2"]);

  const old = await setup({ FAKE_MODELS: "unsupported" });
  await expect(old.runtime.catalog(signal())).rejects.toThrow("Update Codex");
}, 30_000);

test("a first turn starts a thread and streams the reply", async () => {
  const { dir, runtime, requests } = await setup();
  const { sink, events, contexts } = recordingSink();
  await runtime.run(turn(dir, "hello"), sink, signal());
  // The report without a window is skipped.
  expect(contexts).toEqual([{ used: 1234, window: 258400 }]);
  expect(events).toEqual({
    sessions: ["thread-1"],
    text: "Hello there",
    reasoning: "Thinking",
    models: ["gpt-fast"],
  });
  expect(await requests("thread/start")).toEqual([
    {
      model: null,
      cwd: dir,
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      approvalsReviewer: "user",
      config: PLAN_CONFIG,
    },
  ]);
  expect(await requests("turn/start")).toEqual([
    {
      threadId: "thread-1",
      input: [{ type: "text", text: "hello", text_elements: [] }],
      model: null,
      effort: null,
      summary: "detailed",
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      approvalsReviewer: "user",
      serviceTierForTurn: "default",
    },
  ]);

  // The same process reuses the loaded thread.
  await runtime.run(turn(dir, "hello", { sessionId: "thread-1" }), recordingSink().sink, signal());
  expect(await requests("thread/resume")).toEqual([]);
  expect(await requests("initialize")).toHaveLength(1);
}, 30_000);

test("a fresh runtime resumes the thread, or starts over when it is gone", async () => {
  const { dir, runtime, make, requests } = await setup();
  await runtime.run(turn(dir, "hello"), recordingSink().sink, signal());
  runtime.dispose();

  const fast = {
    ...settings,
    model: "gpt-fast",
    effort: "high",
    fast: true,
    access: "auto",
  } as const;
  const resumed = recordingSink();
  await make().run(
    turn(dir, "hello", { sessionId: "thread-1", settings: fast, history: "ignored\n" }),
    resumed.sink,
    signal(),
  );
  expect(resumed.events.sessions).toEqual([]);
  expect(resumed.events.text).toBe("Hello there");
  expect(await requests("thread/resume")).toEqual([
    {
      threadId: "thread-1",
      model: "gpt-fast",
      cwd: dir,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
      config: PLAN_CONFIG,
      excludeTurns: true,
    },
  ]);
  expect((await requests("turn/start")).at(-1)).toMatchObject({
    model: "gpt-fast",
    effort: "high",
    approvalsReviewer: "auto_review",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [dir] },
    serviceTierForTurn: "priority",
  });

  const lost = recordingSink();
  const history = "earlier\n\nUser message:\n";
  await make().run(turn(dir, "hello", { sessionId: "thread-gone", history }), lost.sink, signal());
  expect(lost.events.sessions).toEqual(["thread-2"]);
  // Only the new thread is handed the earlier conversation; the resumed one already has it.
  expect((await requests("turn/start")).map((params) => params.input)).toEqual([
    [{ type: "text", text: "hello", text_elements: [] }],
    [{ type: "text", text: "hello", text_elements: [] }],
    [{ type: "text", text: `${history}hello`, text_elements: [] }],
  ]);
}, 30_000);

/** An McpAccess whose tokens are "token-1", "token-2", …; only the newest lives, until killed. */
function fakeMcp() {
  const issued: string[] = [];
  let killed = false;
  const mcp: McpAccess = {
    url: "http://127.0.0.1:9/mcp",
    credential: () => {
      killed = false;
      issued.push(`token-${issued.length + 1}`);
      return issued.at(-1)!;
    },
    live: (token) => !killed && token === issued.at(-1),
  };
  return { mcp, issued, kill: () => (killed = true) };
}

const PLAN_CONFIG = { "tools.update_plan.enabled": true };

const rookConfig = (token: string) => ({
  ...PLAN_CONFIG,
  "mcp_servers.rook": {
    url: "http://127.0.0.1:9/mcp",
    tool_timeout_sec: 300,
    http_headers: { Authorization: `Bearer ${token}` },
  },
});

test("Rook's MCP server and instructions reach the thread, with one token per load", async () => {
  const { dir, runtime, make, requests } = await setup();
  const { mcp, issued, kill } = fakeMcp();
  const rook = { mcp, instructions: "Delegate." };
  await runtime.run(turn(dir, "hello", rook), recordingSink().sink, signal());
  expect(await requests("thread/start")).toEqual([
    expect.objectContaining({ config: rookConfig("token-1"), developerInstructions: "Delegate." }),
  ]);

  // The loaded thread keeps its live token: no new credential, no resume.
  const again = { ...rook, sessionId: "thread-1" };
  await runtime.run(turn(dir, "hello", again), recordingSink().sink, signal());
  expect(issued).toEqual(["token-1"]);
  expect(await requests("thread/resume")).toEqual([]);

  // A dead token, then new instructions: unload the thread and resume it with a fresh token.
  kill();
  await runtime.run(turn(dir, "hello", again), recordingSink().sink, signal());
  await runtime.run(
    turn(dir, "hello", { ...again, instructions: "Delegate more." }),
    recordingSink().sink,
    signal(),
  );
  expect(issued).toEqual(["token-1", "token-2", "token-3"]);
  expect(await requests("thread/unsubscribe")).toEqual([
    { threadId: "thread-1" },
    { threadId: "thread-1" },
  ]);
  expect((await requests("thread/resume")).map((params) => params.config)).toEqual([
    rookConfig("token-2"),
    rookConfig("token-3"),
  ]);
  expect((await requests("thread/resume")).at(-1)).toMatchObject({
    developerInstructions: "Delegate more.",
  });

  // A new app-server resumes the thread with a fresh token.
  await make().run(turn(dir, "hello", again), recordingSink().sink, signal());
  expect(issued).toHaveLength(4);
  expect((await requests("thread/resume")).at(-1)).toMatchObject({
    config: rookConfig("token-4"),
    developerInstructions: "Delegate.",
  });
  expect(await requests("thread/unsubscribe")).toHaveLength(2);
}, 30_000);

test("Rook's own MCP tool calls are accepted; other elicitations are asked", async () => {
  const { dir, runtime, requests } = await setup();
  const asked = recordingSink("deny");
  await runtime.run(turn(dir, "elicit", { mcp: fakeMcp().mcp }), asked.sink, signal());
  expect(asked.approvals.map((request) => [request.tool, request.title])).toEqual([
    ["mcp", 'Allow the docs MCP server to run tool "delegate_task"?'],
    ["elicitation", "The rook MCP server asks to continue"],
  ]);
  const accept = { action: "accept", content: {}, _meta: null };
  const decline = { action: "decline", content: null, _meta: null };
  expect(await requests("elicitationAnswer")).toEqual([
    { serverName: "rook", ...accept },
    { serverName: "rook", ...accept }, // From a subagent's thread.
    { serverName: "docs", ...decline },
    { serverName: "rook", ...decline }, // Not a tool-call approval.
  ]);

  // Without Rook's server on the thread, a "rook" server is someone else's.
  await runtime.run(turn(dir, "elicit"), recordingSink("deny").sink, signal());
  expect((await requests("elicitationAnswer")).slice(4).map((answer) => answer.action)).toEqual([
    "decline",
    "decline",
    "decline",
    "decline",
  ]);
}, 30_000);

test("command approvals round-trip the user's answer", async () => {
  const { dir, runtime, requests } = await setup();
  const allowed = recordingSink("allowSession");
  await runtime.run(turn(dir, "approve"), allowed.sink, signal());
  expect(allowed.approvals).toEqual([
    {
      id: "cmd-1:1",
      tool: "command",
      title: "Run `npm test`?",
      detail: "npm test",
      reason: "Runs the tests",
      toolId: "cmd-1",
      options: ["allow", "allowSession", "deny"],
    },
  ]);
  expect(allowed.tools.map((tool) => [tool.status, tool.output])).toEqual([
    ["running", null],
    ["failed", "ok"], // Exit code 1.
  ]);
  expect(allowed.events.text).toBe("ran");

  const denied = recordingSink("deny");
  await runtime.run(turn(dir, "approve"), denied.sink, signal());
  expect(denied.tools.at(-1)?.status).toBe("declined");
  expect(denied.events.text).toBe("skipped");
  expect((await requests("approvalAnswer")).map((params) => params.decision)).toEqual([
    "acceptForSession",
    "decline",
  ]);
}, 30_000);

test("requestUserInput reaches the user, and their answers or decline reach Codex", async () => {
  const { dir, runtime, requests } = await setup();
  const answered = recordingSink();
  const asked: QuestionRequest[] = [];
  await runtime.run(
    turn(dir, "question"),
    {
      ...answered.sink,
      ask: async (request) => {
        asked.push(request);
        return {
          answers: {
            colour: { selected: ["Blue"], text: "or teal" },
            name: { selected: [], text: "Rex" },
          },
        };
      },
    },
    signal(),
  );
  expect(asked).toHaveLength(1);
  expect(asked[0]!.questions.map((question) => [question.id, question.allowCustom])).toEqual([
    ["colour", true],
    ["name", true],
  ]);
  expect(answered.events.text).toBe("thanks");

  const declined = recordingSink();
  await runtime.run(
    turn(dir, "question"),
    { ...declined.sink, ask: async () => ({ declined: true, feedback: "Later" }) },
    signal(),
  );
  expect(await requests("questionAnswer")).toEqual([
    { answers: { colour: { answers: ["Blue", "or teal"] }, name: { answers: ["Rex"] } } },
    {
      answers: {
        colour: { answers: ["The user declined to answer: Later"] },
        name: { answers: ["The user declined to answer: Later"] },
      },
    },
  ]);
}, 30_000);

test("a subagent's approvals reach the user and their answer reaches Codex", async () => {
  const { dir, runtime, requests } = await setup();
  const { sink, approvals } = recordingSink("allow");
  await runtime.run(turn(dir, "subagent"), sink, signal());
  expect(approvals).toEqual([
    {
      id: "child-cmd:1",
      tool: "command",
      title: "Subagent · Run `npm test`?",
      detail: "npm test",
      reason: null,
      toolId: "child-cmd",
      options: ["allow", "allowSession", "deny"],
      subagent: "spawn-1",
    },
  ]);
  expect((await requests("approvalAnswer")).map((params) => params.decision)).toEqual(["accept"]);
}, 30_000);

test("a subagent's steps and final message fold into its agent part", async () => {
  const { dir, runtime } = await setup();
  const { sink, tools } = recordingSink("allow");
  await runtime.run(turn(dir, "subagent"), sink, signal());
  const spawn = {
    id: "spawn-1",
    tool: "agent",
    title: "Spawn agent: Check the tests",
    detail: "Check the tests\nthen report",
  };
  const wait = {
    id: "wait-1",
    tool: "agent",
    title: "Wait for agents",
    detail: null,
    output: null,
  };
  expect(tools).toEqual([
    { ...spawn, output: null, status: "running" }, // item/started
    { ...spawn, output: null, status: "running" }, // Spawned: runs until the child finishes.
    { ...spawn, output: null, status: "running" }, // The child's turn started.
    { ...spawn, output: "Run `npm test`", status: "running" },
    { ...spawn, output: "Run `npm test` (failed)", status: "running" }, // Exit code 1.
    { ...spawn, output: "Run `npm test` (failed)\n\nTests fail", status: "done" },
    { ...wait, status: "running" },
    { ...wait, status: "done" },
  ]);
}, 30_000);

test("a subagent's text and turn end do not reach the parent turn", async () => {
  const { dir, runtime } = await setup();
  const { sink, events } = recordingSink("allow");
  await runtime.run(turn(dir, "subagent"), sink, signal());
  // "done" comes after the child's turn/completed: the parent turn was still running.
  expect(events.text).toBe("done");
}, 30_000);

const lastPart = (tools: ToolUpdate[], id: string) => tools.findLast((tool) => tool.id === id);

test("a multi-agent v2 subagent is routed and shown like a spawned one", async () => {
  const { dir, runtime, requests } = await setup();
  const { sink, approvals, tools, events } = recordingSink("allow");
  await runtime.run(turn(dir, "subagent-v2"), sink, signal());
  expect(approvals.map((request) => request.title)).toEqual(["Subagent · Run `npm test`?"]);
  expect((await requests("approvalAnswer")).map((params) => params.decision)).toEqual(["accept"]);
  expect(lastPart(tools, "spawn-1")).toEqual({
    id: "spawn-1",
    tool: "agent",
    title: "Spawn agent: say_hello",
    detail: "Check the tests", // The prompt the child received.
    output: "Run `npm test` (failed)\n\nTests fail",
    status: "done",
  });
  // The "completed" activity is not a part of its own.
  expect(lastPart(tools, "activity-2")).toBeUndefined();
  expect(events.text).toBe("done");
}, 30_000);

test("a subagent's own subagents report to the parent turn", async () => {
  const { dir, runtime, requests } = await setup();
  const { sink, approvals, tools, events } = recordingSink("allow");
  await runtime.run(turn(dir, "subagent-nested"), sink, signal());
  expect(approvals.map((request) => request.title)).toEqual(["Subagent · Run `npm test`?"]);
  expect((await requests("approvalAnswer")).map((params) => params.decision)).toEqual(["accept"]);
  expect(lastPart(tools, "spawn-1")).toMatchObject({
    output: "Spawn agent: Check the tests\n\nRelayed",
    status: "done",
  });
  expect(lastPart(tools, "spawn-2")).toMatchObject({
    tool: "agent",
    output: "Run `npm test` (failed)\n\nTests fail",
    status: "done",
  });
  expect(events.text).toBe("done");
}, 30_000);

test("a subagent is known from thread/started, before its spawn completes", async () => {
  const { dir, runtime, requests } = await setup();
  const { sink, approvals, tools } = recordingSink("allow");
  await runtime.run(turn(dir, "subagent-early"), sink, signal());
  expect(approvals.map((request) => request.title)).toEqual(["Ada · Run `npm test`?"]);
  // Asked before its spawn completed, so before it had a part to point at.
  expect(approvals[0]?.subagent).toBeUndefined();
  expect((await requests("approvalAnswer")).map((params) => params.decision)).toEqual(["accept"]);
  expect(lastPart(tools, "spawn-1")).toMatchObject({
    output: "Run `npm test` (failed)\n\nTests fail",
    status: "done",
  });
}, 30_000);

test("a failed subagent shows its own error", async () => {
  const { dir, runtime } = await setup();
  const { sink, tools, events } = recordingSink("allow");
  await runtime.run(turn(dir, "subagent-fail"), sink, signal());
  expect(lastPart(tools, "spawn-1")).toMatchObject({
    output: "Run `npm test` (failed)\n\nChild exploded",
    status: "failed",
  });
  expect(events.text).toBe("done");
}, 30_000);

test("a long subagent keeps its latest steps and its final message", async () => {
  const { dir, runtime } = await setup();
  const { sink, tools } = recordingSink();
  await runtime.run(turn(dir, "subagent-long"), sink, signal());
  const output = lastPart(tools, "spawn-1")?.output ?? "";
  expect(output.length).toBeLessThanOrEqual(4000);
  expect(output).toMatch(/^… \d+ earlier steps\n/);
  expect(output).toMatch(/Run `echo step 299\.+`\nRun `npm test` \(failed\)\n\nTests fail$/);
  expect(output).not.toContain("echo step 0.");
}, 30_000);

test("a subagent approval pending when the parent stops is denied", async () => {
  const { dir, runtime, requests } = await setup();
  const abort = new AbortController();
  const asked: ApprovalRequest[] = [];
  const { sink } = recordingSink();
  // Like the chat service: an unanswered approval resolves "deny" once the turn stops.
  sink.approve = (request) => {
    asked.push(request);
    return new Promise((resolve) =>
      abort.signal.addEventListener("abort", () => resolve({ decision: "deny", feedback: null }), {
        once: true,
      }),
    );
  };
  const pending = runtime.run(turn(dir, "subagent-hang"), sink, abort.signal);
  await expect.poll(() => asked.length).toBe(1);
  abort.abort();
  await pending;
  // The second request comes after the parent turn ended: declined without asking.
  await expect
    .poll(async () => (await requests("approvalAnswer")).map((params) => params.decision))
    .toEqual(["decline", "decline"]);
  expect(asked).toHaveLength(1);
}, 30_000);

// The child's tail in every scenario that finishes it: a failing command, then its streamed answer.
const FINISHED = [
  "tool child-cmd running",
  "tool child-cmd failed",
  "text Tests ",
  "text fail",
  "ended completed null",
];

test("a subagent's own reasoning, tools and text reach its transcript once", async () => {
  const { dir, runtime } = await setup();
  const { sink, subagents } = recordingSink("allow");
  await runtime.run(turn(dir, "subagent"), sink, signal());
  expect(new Set(subagents.map(([id]) => id))).toEqual(new Set(["spawn-1"]));
  expect(transcript(subagents, "spawn-1")).toEqual([
    "started Check the tests | Check the tests\nthen report | null",
    "reasoning Hm",
    ...FINISHED, // The completed agentMessage does not repeat the streamed text.
  ]);
}, 30_000);

test("a v2 subagent's transcript waits for its prompt; an early one replays what it did", async () => {
  const v2 = recordingSink("allow");
  const first = await setup();
  await first.runtime.run(turn(first.dir, "subagent-v2"), v2.sink, signal());
  expect(transcript(v2.subagents, "spawn-1")).toEqual([
    "started say_hello | Check the tests | null",
    "reasoning Hm",
    ...FINISHED,
  ]);
  // No transcript for the "completed" activity.
  expect(transcript(v2.subagents, "activity-2")).toEqual([]);

  const early = recordingSink("allow");
  const { dir, runtime } = await setup();
  await runtime.run(turn(dir, "subagent-early"), early.sink, signal());
  expect(transcript(early.subagents, "spawn-1")).toEqual([
    "started Ada | Check the tests\nthen report | null",
    "reasoning Hm",
    ...FINISHED,
  ]);
}, 30_000);

test("a subagent's own subagent gets a sibling transcript", async () => {
  const { dir, runtime } = await setup();
  const { sink, subagents } = recordingSink("allow");
  await runtime.run(turn(dir, "subagent-nested"), sink, signal());
  expect(transcript(subagents, "spawn-1")).toEqual([
    "started Check the tests | Check the tests\nthen report | null",
    "reasoning Hm",
    "tool spawn-2 running",
    "tool spawn-2 done",
    "text Relayed", // Not streamed: the completed message carries it.
    "ended completed null",
  ]);
  expect(transcript(subagents, "spawn-2")).toEqual([
    "started Check the tests | Check the tests\nthen report | null",
    "reasoning Hm",
    ...FINISHED,
  ]);
}, 30_000);

test("a failed subagent's transcript ends failed; a stopped parent's ends cancelled", async () => {
  const failed = recordingSink("allow");
  const one = await setup();
  await one.runtime.run(turn(one.dir, "subagent-fail"), failed.sink, signal());
  expect(transcript(failed.subagents, "spawn-1").at(-1)).toBe("ended failed Child exploded");

  const { dir, runtime } = await setup();
  const abort = new AbortController();
  const stopped = recordingSink();
  stopped.sink.approve = () =>
    new Promise((resolve) =>
      abort.signal.addEventListener("abort", () => resolve({ decision: "deny", feedback: null }), {
        once: true,
      }),
    );
  const pending = runtime.run(turn(dir, "subagent-hang"), stopped.sink, abort.signal);
  await expect.poll(() => transcript(stopped.subagents, "spawn-1").length).toBe(3);
  abort.abort();
  await pending;
  expect(transcript(stopped.subagents, "spawn-1").at(-1)).toBe("ended cancelled null");
}, 30_000);

test("file changes become an edit part with project-relative paths", async () => {
  const { dir, runtime } = await setup();
  const { sink, tools } = recordingSink();
  await runtime.run(turn(dir, "edit"), sink, signal());
  expect(tools.at(-1)).toEqual({
    id: "patch-1",
    tool: "edit",
    title: "Edit src/a.ts",
    detail: "+x",
    output: null,
    status: "done",
    files: [{ path: "src/a.ts", additions: 1, deletions: 0 }],
  });
}, 30_000);

test("stopping interrupts the turn", async () => {
  const { dir, runtime, requests } = await setup();
  const abort = new AbortController();
  const pending = runtime.run(turn(dir, "hang"), recordingSink().sink, abort.signal);
  await expect.poll(async () => (await requests("turn/start")).length).toBe(1);
  abort.abort();
  await pending;
  expect(await requests("turn/interrupt")).toEqual([{ threadId: "thread-1", turnId: "turn-1" }]);

  // The process survives for the next turn.
  await runtime.run(turn(dir, "hello"), recordingSink().sink, signal());
  expect(await requests("initialize")).toHaveLength(1);
}, 30_000);

test("stopping ends the turn's running commands and its subagents', and only those", async () => {
  const { dir, runtime, requests } = await setup();
  const start = (chatId: string) => {
    const abort = new AbortController();
    const { sink, events } = recordingSink();
    const pending = runtime.run(turn(dir, "hang-command", { chatId }), sink, abort.signal);
    return { abort, events, pending };
  };
  // Two chats on the shared app-server, each running commands; only the first is stopped.
  const first = start("chat-1");
  await expect.poll(() => first.events.text).toBe("ready");
  const other = start("chat-2");
  await expect.poll(() => other.events.text).toBe("ready");
  first.abort.abort();
  await first.pending;
  // Found by item id (item/started had no processId). Not the finished command, not the
  // earlier turn's server, nothing of chat-2's thread-2.
  await expect
    .poll(() => requests("thread/backgroundTerminals/terminate"))
    .toEqual([
      { threadId: "thread-1", processId: "thread-1-proc-1" },
      { threadId: "thread-1-child", processId: "thread-1-child-proc-2" },
    ]);
  expect((await requests("thread/backgroundTerminals/list")).map((p) => p.threadId)).toEqual([
    "thread-1",
    "thread-1-child",
  ]);
  const { requests: sent } = JSON.parse(await readFile(NodePath.join(dir, "state.json"), "utf8"));
  const methods = (sent as { method: string }[]).map((request) => request.method);
  expect(methods.indexOf("thread/backgroundTerminals/list")).toBeGreaterThan(
    methods.indexOf("turn/interrupt"),
  );
  other.abort.abort();
  await other.pending;
}, 30_000);

test("steering adds the message to the running turn", async () => {
  const { dir, runtime, requests } = await setup();
  const { sink, events } = recordingSink();
  const steer = { prompt: "also this", images: [{ path: "/a.png", mediaType: "image/png" }] };
  const pending = runtime.run(turn(dir, "hang"), sink, signal());
  // False (and nothing sent) until the turn has an id.
  await expect.poll(() => runtime.steer!("chat-1", steer)).toBe(true);
  await pending;
  expect(await requests("turn/steer")).toEqual([
    { threadId: "thread-1", expectedTurnId: "turn-1", input: codexInput(steer) },
  ]);
  // The turn's later events reach the same sink.
  expect(events.text).toBe("Steered: also this");
}, 30_000);

test("steering returns false with no running turn", async () => {
  const { dir, runtime, requests } = await setup();
  const steer = { prompt: "hi", images: [] };
  expect(await runtime.steer!("chat-1", steer)).toBe(false);
  await runtime.run(turn(dir, "hello"), recordingSink().sink, signal());
  expect(await runtime.steer!("chat-1", steer)).toBe(false);
  expect(await requests("turn/steer")).toEqual([]);
}, 30_000);

test("steering returns false when Codex rejects it", async () => {
  const { dir, runtime, requests } = await setup({ FAKE_STEER: "reject" });
  const abort = new AbortController();
  const pending = runtime.run(turn(dir, "hang"), recordingSink().sink, abort.signal);
  const results: boolean[] = [];
  // Steer until one reaches Codex; every attempt, the rejected one included, returns false.
  await expect
    .poll(async () => {
      results.push(await runtime.steer!("chat-1", { prompt: "x", images: [] }));
      return (await requests("turn/steer")).length;
    })
    .toBe(1);
  expect(results.every((steered) => !steered)).toBe(true);
  abort.abort();
  await pending;
}, 30_000);

test("a failed turn rejects with a short, safe message", async () => {
  const { dir, runtime } = await setup();
  await expect(runtime.run(turn(dir, "fail"), recordingSink().sink, signal())).rejects.toThrow(
    /^Upstream exploded$/,
  );
}, 30_000);

test("the app-server dying mid-turn rejects, and the next turn restarts it", async () => {
  const { dir, runtime, requests } = await setup();
  await expect(runtime.run(turn(dir, "die"), recordingSink().sink, signal())).rejects.toThrow(
    "Codex stopped unexpectedly.",
  );
  await runtime.run(turn(dir, "hello"), recordingSink().sink, signal());
  expect(await requests("initialize")).toHaveLength(2);
}, 30_000);

test("a missing codex is reported", async () => {
  const runtime = codexRuntime(testHost(await tempDir(), await tempDir()));
  runtimes.push(runtime);
  await expect(runtime.run(turn("/", "hi"), recordingSink().sink, signal())).rejects.toThrow(
    "Codex is not installed.",
  );
});

test("a secret question is declined without showing it, so the answer never lands in chat", async () => {
  const { dir, runtime, requests } = await setup();
  const asked: QuestionRequest[] = [];
  const { sink } = recordingSink();
  await runtime.run(
    turn(dir, "secret-question"),
    { ...sink, ask: async (request) => (asked.push(request), { declined: true, feedback: null }) },
    signal(),
  );
  expect(asked).toEqual([]);
  const [answer] = (await requests("questionAnswer")) as {
    answers: Record<string, { answers: string[] }>;
  }[];
  expect(answer!.answers.colour!.answers[0]).toMatch(/can't take secret answers/);
});

test("plan mode reaches turn/start; task lists and plans become todo and plan parts", async () => {
  const { dir, runtime, requests } = await setup();
  const parts: ReportedPart[] = [];
  const { sink, tools } = recordingSink();
  const planned = { ...settings, model: "gpt-plain", effort: "medium", plan: true };
  await runtime.run(
    turn(dir, "plan", { settings: planned }),
    { ...sink, part: (part) => parts.push(part) },
    signal(),
  );
  expect((await requests("turn/start")).at(-1)).toMatchObject({
    collaborationMode: {
      mode: "plan",
      settings: { model: "gpt-plain", reasoning_effort: "medium", developer_instructions: null },
    },
  });
  expect(tools).toEqual([]);
  expect(parts).toEqual([
    {
      kind: "todo",
      id: "turn-1-todo",
      items: [
        { text: "Read the code", status: "inProgress" },
        { text: "Write the plan", status: "pending" },
      ],
    },
    {
      kind: "todo",
      id: "turn-1-todo",
      items: [
        { text: "Read the code", status: "completed" },
        { text: "Write the plan", status: "pending" },
      ],
    },
    // The empty item/started is skipped; the plan streams, then its completed text wins.
    { kind: "plan", id: "turn-1-plan", text: "## Plan" },
    { kind: "plan", id: "turn-1-plan", text: "## Plan\n\n1. Do it" },
    { kind: "plan", id: "turn-1-plan", text: "## Plan\n\n1. Do it\n" },
  ]);
}, 30_000);

test("legacy, permission and elicitation requests reach the user; a decline carries feedback", async () => {
  const { dir, runtime, requests } = await setup();
  const asked: ApprovalRequest[] = [];
  const notices: ReportedPart[] = [];
  const declining: TurnSink = {
    ...recordingSink().sink,
    approve: async (request) => {
      asked.push(request);
      return { decision: "deny", feedback: "use pnpm" };
    },
    part: (part) => notices.push(part),
  };
  await runtime.run(turn(dir, "requests"), declining, signal());
  expect(asked.map(({ id: _id, ...request }) => request)).toEqual([
    {
      tool: "command",
      title: "Run `npm install`?",
      detail: "npm install",
      options: ["allow", "allowSession", "deny"],
      toolId: "call-1",
      reason: "Installs packages",
    },
    {
      tool: "edit",
      title: "Apply file changes?",
      detail: "diff --git a/a.txt b/a.txt\n@@ -0,0 +1,1 @@ a.txt\n+hi",
      options: ["allow", "allowSession", "deny"],
      toolId: "call-2",
      reason: null,
    },
    {
      tool: "permissions",
      title: "Grant more permissions for this turn?",
      detail: "Network access",
      reason: "Needs the network",
      toolId: "perm-1",
      options: ["allow", "deny"],
    },
    {
      tool: "command",
      title: "Run `npm test`?",
      detail: "npm test",
      reason: null,
      toolId: "cmd-2",
      // Only what Codex offers; "allow and remember the rule" has no Rook option.
      options: ["allow", "deny"],
    },
    {
      tool: "link",
      title: "The docs MCP server asks you to open a link",
      detail: "https://docs.example/login",
      reason: "Sign in to docs",
      options: ["allow", "deny"],
    },
  ]);
  expect(notices.map((part) => part.kind === "notice" && part.detail)).toEqual(["Your email?"]);
  const rejection = { denied: { rejection: "The user declined this action and said: use pnpm" } };
  expect(await requests("execCommandApproval:answer")).toEqual([{ decision: rejection }]);
  expect(await requests("applyPatchApproval:answer")).toEqual([{ decision: rejection }]);
  expect(await requests("item/permissions/requestApproval:answer")).toEqual([
    { permissions: {}, scope: "turn" },
  ]);
  expect(await requests("item/commandExecution/requestApproval:answer")).toEqual([
    { decision: "decline" },
  ]);
  expect(await requests("mcpServer/elicitation/request:answer")).toEqual([
    { action: "decline", content: null, _meta: null },
    { action: "decline", content: null, _meta: null },
  ]);
  // A v2 decline has no message field: the feedback follows as a steer on the same turn.
  expect(
    (await requests("turn/steer")).map((params) => [
      params.expectedTurnId,
      (params.input as { text: string }[])[0]?.text,
    ]),
  ).toEqual([
    ["turn-1", "The user declined that. Their instruction: use pnpm"],
    ["turn-1", "The user declined that. Their instruction: use pnpm"],
    // The declined link request: its feedback follows too.
    ["turn-1", "The user declined that. Their instruction: use pnpm"],
  ]);

  // Allowed, they grant what was asked.
  await runtime.run(turn(dir, "requests"), recordingSink("allow").sink, signal());
  expect((await requests("execCommandApproval:answer")).at(-1)).toEqual({ decision: "approved" });
  expect((await requests("item/permissions/requestApproval:answer")).at(-1)).toEqual({
    permissions: { network: { enabled: true } },
    scope: "turn",
  });
  expect((await requests("mcpServer/elicitation/request:answer")).slice(-2)).toEqual([
    { action: "accept", content: null, _meta: null },
    { action: "decline", content: null, _meta: null },
  ]);
}, 30_000);

test("collaborationMode goes out only in plan mode and on the turn that leaves it", async () => {
  const { dir, runtime, requests } = await setup();
  const base = { ...settings, model: "gpt-plain" };
  let sessionId: string | null = null;
  const run = async (plan: boolean) => {
    const { sink, events } = recordingSink();
    await runtime.run(
      turn(dir, "hello", { settings: { ...base, plan }, sessionId }),
      sink,
      signal(),
    );
    sessionId ??= events.sessions[0] ?? null;
  };
  await run(false);
  await run(true);
  await run(false);
  await run(false);
  const modes = (await requests("turn/start")).map(
    (params) => (params.collaborationMode as { mode: string } | undefined)?.mode ?? null,
  );
  expect(modes).toEqual([null, "plan", "default", null]);
});

test("command output streams, exit codes arrive, and retries, warnings and other items show", async () => {
  const { dir, runtime } = await setup();
  const recorded = recordingSink();
  const parts: ReportedPart[] = [];
  const sink: TurnSink = { ...recorded.sink, part: (part) => parts.push(part) };
  await runtime.run(turn(dir, "output"), sink, signal());

  const command = recorded.tools.filter((tool) => tool.id === "cmd-out");
  // Started, then the throttled stream (both deltas in one update), then the completed item.
  expect(command.map((tool) => tool.output)).toEqual([
    null,
    "\u001b[32mok\u001b[0m 1\nok 2\n",
    "ok 1\nok 2\nfail 3\n",
  ]);
  expect(command.at(-1)).toMatchObject({ status: "failed", exitCode: 2 });
  expect(recorded.tools.find((tool) => tool.id === "img-1")).toMatchObject({
    tool: "read",
    title: "View shot.png",
    status: "done",
  });
  expect(parts.map((part) => [part.id, part.kind === "notice" && part.text])).toEqual([
    ["retry:turn-1", "Retrying (1)…"],
    ["retry:turn-1", "Retrying (2)…"],
    ["warning:Sandbox is off", "Sandbox is off"],
    ["warning:Unknown key in config.toml", "Unknown key in config.toml"],
    ["retry:turn-1", "Reconnected after 2 retries"],
    ["compact:turn-1", "Context compacted"],
  ]);
}, 30_000);

test("codexToolUpdate shows items it once dropped", () => {
  const cwd = NodePath.resolve("/proj");
  expect(codexToolUpdate({ type: "sleep", id: "s", durationMs: 4600 }, cwd, false)).toMatchObject({
    tool: "other",
    title: "Wait 5s",
    status: "running",
  });
  const image = {
    type: "imageGeneration",
    id: "g",
    status: "completed",
    revisedPrompt: "A red fox",
    failure: null,
    savedPath: NodePath.join(cwd, "fox.png"),
  } as const;
  expect(codexToolUpdate(image, cwd, true)).toMatchObject({
    title: "Generate an image",
    detail: "A red fox",
    output: "fox.png",
    status: "done",
  });
  expect(
    codexToolUpdate({ ...image, failure: { type: "usageLimitExceeded" } }, cwd, true),
  ).toMatchObject({ output: "Usage limit reached.", status: "failed" });
  expect(
    codexToolUpdate(
      {
        type: "functionCallOutput",
        id: "f",
        name: "lookup",
        namespace: "docs",
        output: [{ type: "input_text", text: "found" }],
      },
      cwd,
      true,
    ),
  ).toMatchObject({ title: "docs · lookup", output: "found", status: "done" });
  expect(codexToolUpdate({ type: "contextCompaction", id: "c" }, cwd, true)).toBeNull();
});
