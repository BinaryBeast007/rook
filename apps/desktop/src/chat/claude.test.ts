import { readFile, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import type { ApprovalDecision, ChatSettings, ContextUsage } from "@rook/contracts";
import { afterEach, expect, test } from "vite-plus/test";

import { fakeBin, tempDir, testHost } from "../agents/testing/fakeBin.ts";
import {
  claudeRuntime,
  contextUsed,
  contextWindow,
  parseModels,
  subagentOutput,
  subagentReport,
  toolDetail,
  toolFiles,
  toolKind,
  toolTitle,
  turnError,
} from "./claude.ts";
import {
  ChatRuntimeError,
  type ApprovalAnswer,
  type ApprovalRequest,
  type ChatRuntime,
  type QuestionRequest,
  type ReportedPart,
  type SubagentEvent,
  type ToolUpdate,
  type TurnSink,
} from "./runtime.ts";

const SETTINGS: ChatSettings = {
  agentId: "claude",
  model: null,
  effort: null,
  fast: false,
  access: "ask",
};

let runtimes: ChatRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes) runtime.dispose();
  runtimes = [];
});

async function setup() {
  const dir = await tempDir("rook-claude-chat-");
  await fakeBin(dir, "claude", "claude-chat.mjs");
  const logFile = NodePath.join(dir, "log.jsonl");
  await writeFile(logFile, "");
  const runtime = claudeRuntime(testHost(dir, dir, { FAKE_LOG: logFile }));
  runtimes.push(runtime);
  const log = async () =>
    (await readFile(logFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            pid?: number;
            args?: string[];
            token?: string | null;
            instructions?: string | null;
            answer?: unknown;
            prompt?: string | null;
            priority?: string | null;
            todoTools?: string | null;
          },
      );
  const spawns = async () => (await log()).filter((entry) => entry.args);
  const prompts = async () =>
    (await log()).filter((entry) => "prompt" in entry).map((entry) => entry.prompt);
  return { dir, runtime, log, spawns, prompts };
}

function recordingSink(decision: ApprovalDecision = "allow") {
  const sessions: string[] = [];
  const models: string[] = [];
  const tools: ToolUpdate[] = [];
  const approvals: string[] = [];
  const requests: ApprovalRequest[] = [];
  const contexts: ContextUsage[] = [];
  const subagents: [string, SubagentEvent][] = [];
  let text = "";
  let reasoning = "";
  const sink: TurnSink = {
    session: (id) => sessions.push(id),
    text: (delta) => {
      text += delta;
    },
    reasoning: (delta) => {
      reasoning += delta;
    },
    tool: (update) => tools.push(update),
    approve: async (request) => {
      approvals.push(request.title);
      requests.push(request);
      return { decision, feedback: null };
    },
    ask: async () => ({ declined: true, feedback: null }),
    reviewPlan: async () => ({ decision: "deny", feedback: null }),
    part: () => undefined,
    model: (id) => models.push(id),
    context: (usage) => contexts.push(usage),
    subagent: (id, event) => subagents.push([id, event]),
  };
  return {
    sink,
    sessions,
    models,
    tools,
    approvals,
    requests,
    contexts,
    subagents,
    text: () => text,
    reasoning: () => reasoning,
  };
}

const turn = (
  prompt: string,
  settings: Partial<ChatSettings> = {},
  sessionId: string | null = null,
  history: string | null = null,
) => ({
  chatId: "chat-1",
  cwd: process.cwd(),
  sessionId,
  settings: { ...SETTINGS, ...settings },
  prompt,
  images: [],
  history,
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("toolKind and toolTitle describe common tools", () => {
  const cwd = NodePath.resolve("/repo");
  expect(toolKind("Bash")).toBe("command");
  expect(toolKind("MultiEdit")).toBe("edit");
  expect(toolKind("Grep")).toBe("search");
  expect(toolKind("mcp__github__search")).toBe("mcp");
  expect(toolKind("Task")).toBe("agent");
  expect(toolKind("Mystery")).toBe("other");
  expect(toolTitle("Bash", { command: "npm test" }, cwd)).toBe("Run `npm test`");
  expect(toolTitle("Bash", { command: "a\nb" }, cwd)).toBe("Run `a…`");
  expect(toolTitle("Edit", { file_path: NodePath.join(cwd, "src", "app.ts") }, cwd)).toBe(
    "Edit src/app.ts",
  );
  const outside = NodePath.resolve("/elsewhere/x.ts");
  expect(toolTitle("Read", { file_path: outside }, cwd)).toBe(`Read ${outside}`);
  expect(toolTitle("Grep", { pattern: "TODO" }, cwd)).toBe("Search for TODO");
  expect(toolTitle("mcp__github__search", {}, cwd)).toBe("search (github)");
  expect(toolDetail("Edit", { old_string: "a", new_string: "b\nc" })).toBe("- a\n+ b\n+ c");
  // Lines an edit keeps at either end stay out of its diff, as they do of its counts.
  expect(toolDetail("Edit", { old_string: "intro", new_string: "intro\n\nmore" })).toBe(
    "+ \n+ more",
  );
  expect(toolDetail("Read", {})).toBeNull();
  expect(toolDetail("Write", { content: "x".repeat(5000) })).toHaveLength(4001);
});

test("toolFiles counts an edit tool's lines from its input", () => {
  const cwd = NodePath.resolve("/repo");
  const file_path = NodePath.join(cwd, "src", "app.ts");
  const path = "src/app.ts";
  // Lines kept at either end of old_string and new_string don't count.
  const edit = {
    file_path,
    old_string: "keep\nold\nkeep\n",
    new_string: "keep\nnew\nmore\nkeep\n",
  };
  expect(toolFiles("Edit", edit, cwd)).toEqual([{ path, additions: 2, deletions: 1 }]);
  const edits = [
    { old_string: "a", new_string: "b" },
    { old_string: "x\ny", new_string: "" },
  ];
  expect(toolFiles("MultiEdit", { file_path, edits }, cwd)).toEqual([
    { path, additions: 1, deletions: 3 },
  ]);
  expect(toolFiles("Write", { file_path, content: "1\n2\n3\n" }, cwd)).toEqual([
    { path, additions: 3, deletions: 0 },
  ]);
  expect(toolFiles("Write", { file_path, content: "" }, cwd)).toEqual([
    { path, additions: 0, deletions: 0 },
  ]);
  const outside = NodePath.resolve("/elsewhere/x.ts");
  expect(toolFiles("Write", { file_path: outside, content: "x" }, cwd)?.[0]?.path).toBe(
    outside.replaceAll("\\", "/"),
  );
  expect(toolFiles("Read", { file_path }, cwd)).toBeUndefined();
  expect(toolFiles("Edit", {}, cwd)).toBeUndefined();
});

test("subagentOutput keeps the result and the newest steps when it overflows", () => {
  const steps = Array.from({ length: 200 }, (_, index) => `Read src/file-${index}.ts`);
  const result = "r".repeat(3000);
  const output = subagentOutput(steps, result)!;
  expect(output.length).toBeLessThanOrEqual(4000);
  expect(output.endsWith(`Read src/file-199.ts\n\n${result}`)).toBe(true);
  const [first, second] = output.split("\n");
  const dropped = Number(/^… (\d+) earlier steps$/.exec(first!)?.[1]);
  expect(second).toBe(`Read src/file-${dropped}.ts`);
  expect(subagentOutput(["a", "b"], "done")).toBe("a\nb\n\ndone");
  expect(subagentOutput(["a"], null)).toBe("a");
  expect(subagentOutput([], null)).toBeNull();
});

test("subagentReport drops the framing Claude Code wraps a Task result in", () => {
  const result = [
    "  <tools-used-before-summary>Glob</tools-used-before-summary>",
    "  ",
    "[Subagent hand-back] The text below is a subagent's final report. The report follows:",
    "  Files in `src`:",
    "  ",
    "  - math.ts",
    "agentId: a2cc18 (use SendMessage with to: 'a2cc18')",
  ].join("\n");
  expect(subagentReport(result)).toBe("Files in `src`:\n\n- math.ts");
  expect(subagentReport("Plain report.")).toBe("Plain report.");
  expect(subagentReport("<tools-used-before-summary>Glob</tools-used-before-summary>")).toBeNull();
  expect(subagentReport(null)).toBeNull();
});

test("turnError keeps short results and recognises sign-in failures", () => {
  expect(turnError("Not logged in · Please run /login")).toBe(
    "Sign in to Claude Code to continue.",
  );
  expect(turnError("Prompt is too long")).toBe("Prompt is too long");
  expect(turnError(undefined)).toBe("Claude Code stopped with an error.");
  expect(turnError("line\nline")).toBe("Claude Code stopped with an error.");
});

test("parseModels skips junk entries", () => {
  expect(parseModels({ models: [null, { displayName: "no id" }] })).toEqual([]);
  expect(parseModels(null)).toEqual([]);
});

test("context usage comes from main-thread assistant usage and the result's modelUsage", () => {
  const usage = {
    input_tokens: 3,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 100,
    output_tokens: 7,
  };
  expect(contextUsed({ model: "m", usage })).toBe(130);
  expect(contextUsed({ model: "<synthetic>", usage })).toBeNull();
  expect(contextUsed({ model: "m", usage: { input_tokens: 0, output_tokens: 4 } })).toBeNull();
  expect(contextUsed({ model: "m" })).toBeNull();
  const modelUsage = {
    "claude-haiku-5-5": { inputTokens: 900, contextWindow: 200000 },
    "claude-opus-5-5": { inputTokens: 10, cacheReadInputTokens: 5000, contextWindow: 1000000 },
  };
  expect(contextWindow(modelUsage, "claude-haiku-5-5")).toBe(200000);
  // Unknown main model: the entry that read the most.
  expect(contextWindow(modelUsage, "other")).toBe(1000000);
  expect(contextWindow({ m: { contextWindow: 0 } }, "m")).toBeNull();
  expect(contextWindow(undefined, null)).toBeNull();
});

test("catalog maps the CLI's models", async () => {
  const { runtime } = await setup();
  const catalog = await runtime.catalog(new AbortController().signal);
  expect(catalog.accessModes).toEqual(["ask", "edit", "auto", "full"]);
  expect(catalog.models).toEqual([
    {
      id: "default",
      name: "Default (recommended)",
      description: "Opus 5.5",
      efforts: ["low", "high"],
      defaultEffort: null,
      fast: true,
      auto: true,
      images: true,
      isDefault: true,
      legacy: false,
    },
    {
      id: "haiku",
      name: "Haiku",
      description: "Fast",
      efforts: [],
      defaultEffort: null,
      fast: false,
      auto: false,
      images: true,
      isDefault: false,
      legacy: false,
    },
  ]);
});

test("streams text once, saves a fresh session id, and reports the model", async () => {
  const { runtime, spawns } = await setup();
  const record = recordingSink();
  await runtime.run(turn("hello"), record.sink, new AbortController().signal);
  expect(record.text()).toBe("Hello");
  expect(record.models).toEqual(["claude-fake-1"]);
  expect(record.contexts).toEqual([{ used: 1115, window: 200000 }]);
  expect(record.sessions).toHaveLength(1);
  const [spawn] = await spawns();
  expect(spawn!.args).toContain("--session-id");
  expect(spawn!.args![spawn!.args!.indexOf("--session-id") + 1]).toBe(record.sessions[0]);
  expect(spawn!.args).toContain("manual");
  expect(spawn!.args).not.toContain("--model");
  expect(spawn!.args).not.toContain("--effort");
  expect(spawn!.args).not.toContain("--mcp-config");
  expect(spawn!.args).not.toContain("--allowedTools");
  expect(spawn!.args).not.toContain("--append-system-prompt-file");
  expect(spawn!.token).toBeNull();

  // Without partial messages the full assistant text still arrives.
  const whole = recordingSink();
  await runtime.run(
    turn("nostream", {}, record.sessions[0]),
    whole.sink,
    new AbortController().signal,
  );
  expect(whole.text()).toBe("Whole");
});

test("asks before a tool runs and passes the answer back", async () => {
  const { runtime, log } = await setup();
  const record = recordingSink("allowSession");
  await runtime.run(turn("tool"), record.sink, new AbortController().signal);
  expect(record.approvals).toEqual(["Run `npm test`"]);
  expect(record.tools.map((tool) => tool.status)).toEqual(["running", "done"]);
  expect(record.tools[1]).toMatchObject({
    tool: "command",
    detail: "npm test",
    output: "1 passed",
  });
  const answer = (await log()).find((entry) => entry.answer)?.answer;
  expect(answer).toEqual({
    subtype: "success",
    request_id: "perm-1",
    response: {
      behavior: "allow",
      updatedInput: { command: "npm test" },
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }],
    },
  });
});

test("a denied tool is marked declined", async () => {
  const { runtime, log } = await setup();
  const record = recordingSink("deny");
  await runtime.run(turn("tool"), record.sink, new AbortController().signal);
  expect(record.tools.map((tool) => tool.status)).toEqual(["running", "declined", "declined"]);
  const answer = (await log()).find((entry) => entry.answer)?.answer as { response: unknown };
  expect(answer.response).toEqual({ behavior: "deny", message: "The user declined this action." });
});

test("AskUserQuestion goes to ask, and the answers reach the CLI keyed by question text", async () => {
  const { runtime, log } = await setup();
  const record = recordingSink();
  const asked: QuestionRequest[] = [];
  const sink: TurnSink = {
    ...record.sink,
    ask: async (request) => {
      asked.push(request);
      return {
        answers: {
          "Which colour?": { selected: ["Blue"], text: null },
          "Which fruits?": { selected: ["Apple", "Banana"], text: "and kiwi" },
        },
      };
    },
  };
  await runtime.run(turn("question"), sink, new AbortController().signal);
  expect(record.approvals).toEqual([]);
  expect(record.tools).toEqual([]);
  expect(asked).toHaveLength(1);
  expect(asked[0]!.id).toBe("ask-perm-1");
  expect(asked[0]!.questions.map((question) => question.id)).toEqual([
    "Which colour?",
    "Which fruits?",
  ]);
  const answer = (await log()).find((entry) => entry.answer)?.answer as {
    response: { behavior: string; updatedInput: { answers: unknown; questions: unknown[] } };
  };
  expect(answer.response.behavior).toBe("allow");
  expect(answer.response.updatedInput.questions).toHaveLength(2);
  expect(answer.response.updatedInput.answers).toEqual({
    "Which colour?": "Blue",
    "Which fruits?": "Apple, Banana, and kiwi",
  });
});

test("a declined AskUserQuestion denies with the user's feedback", async () => {
  const { runtime, log } = await setup();
  const record = recordingSink();
  const sink: TurnSink = {
    ...record.sink,
    ask: async () => ({ declined: true, feedback: "Just pick one" }),
  };
  await runtime.run(turn("question"), sink, new AbortController().signal);
  const answer = (await log()).find((entry) => entry.answer)?.answer as { response: unknown };
  expect(answer.response).toEqual({
    behavior: "deny",
    message: "The user declined to answer your questions and said: Just pick one",
  });
});

test("folds a subagent's steps and result into its Task part", async () => {
  const { runtime } = await setup();
  const record = recordingSink();
  await runtime.run(turn("subagent"), record.sink, new AbortController().signal);
  expect(record.text()).toBe("Done");
  expect(record.reasoning()).toBe("");
  expect(record.approvals).toEqual(["Explore · Run `cat rook.json`"]);
  expect(record.requests[0]?.subagent).toBe("task-1");
  // Only the Task has a part; the subagent's tools fold into its output, in order.
  expect(new Set(record.tools.map((tool) => tool.id))).toEqual(new Set(["task-1"]));
  const running = record.tools.findLast((tool) => tool.status === "running");
  expect(running?.output).toBe("Search for config\nRun `cat rook.json`\nRead missing.txt (failed)");
  expect(record.tools.at(-1)).toEqual({
    id: "task-1",
    tool: "agent",
    title: "Find the config",
    detail: "Look for config files",
    output:
      "Search for config\nRun `cat rook.json`\nRead missing.txt (failed)\n\nConfig is in rook.json",
    status: "done",
  });

  const denied = recordingSink("deny");
  await (await setup()).runtime.run(turn("subagent"), denied.sink, new AbortController().signal);
  expect(denied.tools.at(-1)?.output).toContain("Run `cat rook.json` (declined)\n");
  expect(denied.subagents).toContainEqual([
    "task-1",
    { type: "tool", update: expect.objectContaining({ id: "sub-2", status: "declined" }) },
  ]);
});

test("a subagent's own text, reasoning and tools reach its transcript once, in order", async () => {
  const { runtime } = await setup();
  const record = recordingSink();
  await runtime.run(turn("subagent"), record.sink, new AbortController().signal);
  const events = record.subagents.map(([id, event]) => {
    expect(id).toBe("task-1");
    if (event.type === "tool") {
      const { update } = event;
      return `tool ${update.id} ${update.status} ${update.output ?? ""}`.trim();
    }
    if (event.type === "text" || event.type === "reasoning") return `${event.type} ${event.delta}`;
    return event.type === "ended" ? `ended ${event.status}` : `started ${event.title}`;
  });
  expect(events).toEqual([
    "started Find the config",
    "reasoning Looking",
    "text Searching",
    "tool sub-1 running",
    "tool sub-1 done rook.json",
    "tool sub-2 running",
    "tool sub-2 done {}",
    "tool sub-3 running",
    "tool sub-3 failed File does not exist.",
    "text Config is in rook.json",
    "ended completed",
  ]);
  expect(record.subagents[0]?.[1]).toEqual({
    type: "started",
    title: "Find the config",
    prompt: "Look for config files",
    model: null,
  });
  expect(record.subagents[3]?.[1]).toEqual({
    type: "tool",
    update: {
      id: "sub-1",
      tool: "search",
      title: "Search for config",
      detail: "pattern: config",
      output: null,
      status: "running",
    },
  });
  // The parent part comes first, so the transcript can be tied to it.
  expect(record.tools[0]?.id).toBe("task-1");
});

test("a subagent's report that only reaches the Task result ends its transcript, unframed", async () => {
  const { runtime } = await setup();
  const record = recordingSink();
  await runtime.run(turn("subagent-quiet"), record.sink, new AbortController().signal);
  expect(record.subagents.map(([, event]) => event.type)).toEqual([
    "started",
    "tool",
    "tool",
    "text",
    "ended",
  ]);
  expect(record.subagents[3]?.[1]).toEqual({ type: "text", delta: "Files: math.ts" });
  const part = record.tools.findLast((tool) => tool.id === "task-1");
  expect(part?.output).toBe("Search for *\n\nFiles: math.ts");
});

test("a subagent still running when the turn stops ends cancelled", async () => {
  const { runtime } = await setup();
  const record = recordingSink();
  const controller = new AbortController();
  const running = runtime.run(turn("subagent-hang"), record.sink, controller.signal);
  await expect.poll(() => record.subagents.length).toBe(2);
  controller.abort();
  await running;
  expect(record.subagents.map(([, event]) => event)).toEqual([
    { type: "started", title: "Wait", prompt: "Wait here", model: null },
    { type: "text", delta: "Waiting" },
    { type: "ended", status: "cancelled", error: null },
  ]);
  expect(record.text()).toBe("");
});

test("stopping interrupts the turn, resolves, and ends the process", async () => {
  const { runtime, spawns } = await setup();
  const record = recordingSink();
  const controller = new AbortController();
  const running = runtime.run(turn("hang"), record.sink, controller.signal);
  await expect.poll(record.text).toBe("Working");
  controller.abort();
  await running;
  const [spawn] = await spawns();
  await expect.poll(() => alive(spawn!.pid!)).toBe(false);
});

test("a steered message joins the running turn", async () => {
  const { runtime, log } = await setup();
  const steer = (prompt: string) => runtime.steer!("chat-1", { prompt, images: [] });
  expect(await steer("hello")).toBe(false); // No process yet.
  const record = recordingSink();
  const running = runtime.run(turn("steerable"), record.sink, new AbortController().signal);
  await expect.poll(record.text).toBe("Working");
  expect(await steer("hello")).toBe(true);
  // The interim result (aborted_streaming) does not end the turn; the steer's reply joins it.
  await running;
  expect(record.text()).toBe("WorkingHello");
  expect((await log()).find((entry) => entry.prompt === "hello")?.priority).toBe("now");
  expect(await steer("hello")).toBe(false); // Idle between turns.

  // The CLI had already finished when it read the steer: its "completed" result is interim too.
  const late = recordingSink();
  const again = runtime.run(turn("steerable"), late.sink, new AbortController().signal);
  await expect.poll(late.text).toBe("Working");
  expect(await steer("late")).toBe(true);
  await again;
  expect(late.text()).toBe("WorkingHello");
});

test("an error result before the steer's echo still fails the turn", async () => {
  const { runtime } = await setup();
  const running = runtime.run(
    turn("steerable"),
    recordingSink().sink,
    new AbortController().signal,
  );
  const settled = expect(running).rejects.toThrow(new ChatRuntimeError("API Error: 529"));
  await expect.poll(() => runtime.steer!("chat-1", { prompt: "steerfail", images: [] })).toBe(true);
  await settled;
});

test("stopping a steered turn interrupts it and ends the process", async () => {
  const { runtime, spawns } = await setup();
  const record = recordingSink();
  const controller = new AbortController();
  const running = runtime.run(turn("steerable"), record.sink, controller.signal);
  await expect.poll(record.text).toBe("Working");
  expect(await runtime.steer!("chat-1", { prompt: "hang", images: [] })).toBe(true);
  await expect.poll(record.text).toBe("WorkingWorking");
  controller.abort();
  await running;
  expect(await runtime.steer!("chat-1", { prompt: "hello", images: [] })).toBe(false);
  const [spawn] = await spawns();
  await expect.poll(() => alive(spawn!.pid!)).toBe(false);
});

test("failures reject with safe messages", async () => {
  const { runtime } = await setup();
  const signal = new AbortController().signal;
  await expect(runtime.run(turn("fail"), recordingSink().sink, signal)).rejects.toThrow(
    new ChatRuntimeError("Sign in to Claude Code to continue."),
  );
  await expect(runtime.run(turn("boom"), recordingSink().sink, signal)).rejects.toThrow(
    "Claude Code stopped with an error.",
  );
  await expect(runtime.run(turn("exit"), recordingSink().sink, signal)).rejects.toThrow(
    "Claude Code stopped unexpectedly.",
  );
  // Unsupported control requests get an error reply instead of hanging.
  await runtime.run(turn("unsupported"), recordingSink().sink, signal);
});

test("reuses the process until spawn settings change, then resumes", async () => {
  const { runtime, spawns } = await setup();
  const signal = new AbortController().signal;
  const first = recordingSink();
  await runtime.run(turn("hello"), first.sink, signal);
  const session = first.sessions[0]!;
  await runtime.run(turn("hello", {}, session), recordingSink().sink, signal);
  expect(await spawns()).toHaveLength(1);

  const settings = { model: "opus", effort: "high", fast: true, access: "edit" } as const;
  await runtime.run(turn("hello", settings, session), recordingSink().sink, signal);
  const all = await spawns();
  expect(all).toHaveLength(2);
  expect(alive(all[0]!.pid!)).toBe(false);
  const args = all[1]!.args!;
  const value = (name: string) => args[args.indexOf(name) + 1];
  expect(value("--resume")).toBe(session);
  expect(args).not.toContain("--session-id");
  expect(value("--model")).toBe("opus");
  expect(value("--effort")).toBe("high");
  expect(value("--permission-mode")).toBe("acceptEdits");
  expect(JSON.parse(value("--settings")!)).toEqual({ showThinkingSummaries: true, fastMode: true });
});

/** A fake McpAccess: tokens tok-1, tok-2, …; each credential() revokes the one before. */
function fakeMcp() {
  let issued = 0;
  return {
    url: "http://127.0.0.1:9/mcp",
    credential: () => `tok-${++issued}`,
    live: (token: string) => token === `tok-${issued}`,
    issued: () => issued,
    revoke: () => void issued++,
  };
}

test("passes Rook's MCP server, its token, and the instructions to the CLI", async () => {
  const { runtime, spawns } = await setup();
  const mcp = fakeMcp();
  // Several lines: a .cmd shim would cut them off on the command line.
  const instructions = '## Rook delegation\nUse "delegate_task" at 50% or more.\n';
  await runtime.run(
    { ...turn("hello"), mcp, instructions },
    recordingSink().sink,
    new AbortController().signal,
  );
  const [spawn] = await spawns();
  const args = spawn!.args!;
  const value = (name: string) => args[args.indexOf(name) + 1];
  expect(JSON.parse(value("--mcp-config")!)).toEqual({
    mcpServers: {
      rook: {
        type: "http",
        url: mcp.url,
        headers: { Authorization: "Bearer ${ROOK_MCP_TOKEN}" },
      },
    },
  });
  expect(value("--allowedTools")).toBe(
    "mcp__rook__delegate_task,mcp__rook__task_status,mcp__rook__task_cancel",
  );
  expect(spawn!.instructions).toBe(instructions);
  expect(spawn!.token).toBe("tok-1");
  expect(args.join(" ")).not.toContain("tok-1"); // Only in the env.
});

test("a live token reuses the process; a dead one or new instructions respawn with --resume", async () => {
  const { runtime, spawns } = await setup();
  const signal = new AbortController().signal;
  const mcp = fakeMcp();
  const first = recordingSink();
  await runtime.run({ ...turn("hello"), mcp, instructions: "a" }, first.sink, signal);
  const session = first.sessions[0]!;
  const next = (instructions: string) => ({ ...turn("hello", {}, session), mcp, instructions });

  await runtime.run(next("a"), recordingSink().sink, signal);
  expect(await spawns()).toHaveLength(1);
  expect(mcp.issued()).toBe(1); // No credential() per turn.

  mcp.revoke();
  await runtime.run(next("a"), recordingSink().sink, signal);
  let all = await spawns();
  expect(all).toHaveLength(2);
  expect(mcp.issued()).toBe(3); // The revoke, then one fresh credential().
  expect(all[1]!.token).toBe("tok-3");
  expect(all[1]!.args![all[1]!.args!.indexOf("--resume") + 1]).toBe(session);
  expect(alive(all[0]!.pid!)).toBe(false);

  await runtime.run(next("b"), recordingSink().sink, signal);
  all = await spawns();
  expect(all).toHaveLength(3);
  expect(all[2]!.instructions).toBe("b");
  expect(all[2]!.args).toContain("--resume");
});

test("a new session gets the earlier conversation; a resumed one does not", async () => {
  const { runtime, prompts } = await setup();
  const signal = new AbortController().signal;
  const history = "[Context handoff from Rook] earlier\n\nUser message:\n";
  const first = recordingSink();
  await runtime.run(turn("hello", {}, null, history), first.sink, signal);
  expect(first.text()).toBe("Hello");
  await runtime.run(turn("hello", {}, first.sessions[0], history), recordingSink().sink, signal);
  expect(await prompts()).toEqual([`${history}hello`, "hello"]);
});

test("a session the CLI no longer has starts over once with the history", async () => {
  const { runtime, spawns, prompts } = await setup();
  const record = recordingSink();
  const history = "earlier\n\nUser message:\n";
  await runtime.run(
    turn("hello", {}, "gone-1", history),
    record.sink,
    new AbortController().signal,
  );
  expect(record.text()).toBe("Hello");
  const [resume, fresh] = await spawns();
  expect(resume!.args).toContain("--resume");
  expect(fresh!.args).toContain("--session-id");
  expect(record.sessions).toEqual([fresh!.args![fresh!.args!.indexOf("--session-id") + 1]]);
  expect(await prompts()).toEqual([`${history}hello`]);
});

test("reports a missing CLI", async () => {
  const dir = await tempDir("rook-claude-chat-");
  const runtime = claudeRuntime(testHost(dir, dir));
  await expect(
    runtime.run(turn("hello"), recordingSink().sink, new AbortController().signal),
  ).rejects.toThrow("Claude Code is not installed.");
  await expect(runtime.catalog(new AbortController().signal)).rejects.toThrow(
    "Claude Code is not installed.",
  );
});

/** A sink that answers plans with `answer` and keeps the plan, todo and notice parts. */
function planSink(answer: ApprovalAnswer) {
  const record = recordingSink();
  const plans: { id: string; text: string }[] = [];
  const parts: ReportedPart[] = [];
  const sink: TurnSink = {
    ...record.sink,
    reviewPlan: async (plan) => {
      plans.push(plan);
      return answer;
    },
    part: (part) => parts.push(part),
  };
  return { ...record, sink, plans, parts };
}

test("plan mode runs the CLI in plan mode; toggling it respawns with --resume", async () => {
  const { runtime, spawns } = await setup();
  const signal = new AbortController().signal;
  await runtime.run(turn("hello", { plan: true }), recordingSink().sink, signal);
  const [first] = await spawns();
  const sessionId = first!.args![first!.args!.indexOf("--session-id") + 1]!;
  expect(first!.args![first!.args!.indexOf("--permission-mode") + 1]).toBe("plan");
  expect(first!.args).not.toContain("--allow-dangerously-skip-permissions");

  await runtime.run(turn("hello", {}, sessionId), recordingSink().sink, signal);
  await runtime.run(
    turn("hello", { plan: true, access: "full" }, sessionId),
    recordingSink().sink,
    signal,
  );
  const [, off, full] = await spawns();
  expect(off!.args![off!.args!.indexOf("--permission-mode") + 1]).toBe("manual");
  expect(off!.args).toContain("--resume");
  expect(full!.args![full!.args!.indexOf("--permission-mode") + 1]).toBe("plan");
  // An accepted plan may switch this session to bypassPermissions.
  expect(full!.args).toContain("--allow-dangerously-skip-permissions");
});

test("ExitPlanMode is reviewed as a plan: allow continues in the access mode, deny refines", async () => {
  const { runtime, log } = await setup();
  const signal = new AbortController().signal;
  const accepted = planSink({ decision: "allow", feedback: null });
  await runtime.run(turn("plan", { plan: true, access: "edit" }), accepted.sink, signal);
  expect(accepted.plans).toEqual([{ id: "perm-plan", text: "# Plan\n\n1. Add README.md" }]);
  // No approval card and no tool row for it.
  expect(accepted.approvals).toEqual([]);
  expect(accepted.tools).toEqual([]);

  const refined = planSink({ decision: "deny", feedback: "Also add a LICENSE" });
  await runtime.run(turn("plan", { plan: true, access: "ask" }), refined.sink, signal);
  const answers = (await log()).filter((entry) => entry.answer).map((entry) => entry.answer);
  expect(answers).toEqual([
    {
      subtype: "success",
      request_id: "perm-plan",
      response: {
        behavior: "allow",
        updatedInput: {
          plan: "# Plan\n\n1. Add README.md",
          planFilePath: "/home/.claude/plans/p.md",
        },
        updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
      },
    },
    {
      subtype: "success",
      request_id: "perm-plan",
      response: { behavior: "deny", message: expect.stringContaining("Also add a LICENSE") },
    },
  ]);
});

test("task tools build one todo part per turn, not tool rows", async () => {
  const { runtime, log } = await setup();
  const record = planSink({ decision: "deny", feedback: null });
  await runtime.run(turn("todos"), record.sink, new AbortController().signal);
  expect(record.tools).toEqual([]);
  expect(new Set(record.parts.map((part) => part.id)).size).toBe(1);
  expect(record.parts.at(-1)).toMatchObject({
    kind: "todo",
    items: [
      { text: "Read", status: "completed" },
      { text: "Write", status: "pending" },
    ],
  });
  expect((await log()).find((entry) => "todoTools" in entry)).toEqual({ todoTools: "1" });
});

test("approvals carry their kind, tool part and reason; MCP elicitations are asked or declined with a notice", async () => {
  const { runtime, log } = await setup();
  const record = recordingSink("allow");
  const notices: ReportedPart[] = [];
  await runtime.run(
    turn("requests"),
    { ...record.sink, part: (part) => notices.push(part) },
    new AbortController().signal,
  );
  expect(record.requests).toEqual([
    {
      id: "perm-9",
      title: "search (docs)",
      detail: "query: rook\nlimit: 5",
      options: ["allow", "allowSession", "deny"],
      tool: "mcp",
      reason: "Not in the allow list",
      toolId: "tool-9",
    },
    {
      id: "eli-1",
      tool: "link",
      title: "The docs MCP server asks you to open a link",
      detail: "https://docs.example/login",
      reason: "Sign in to docs",
      options: ["allow", "deny"],
    },
  ]);
  // The form needs an email Rook can't ask for: declined, and the user is told.
  expect(notices).toEqual([
    {
      kind: "notice",
      id: "elicitation:eli-2",
      level: "warning",
      text: "Declined a request from the docs MCP server: it needs input Rook can't show yet.",
      detail: "Your email?",
    },
  ]);
  const answers = (await log()).filter((entry) => entry.answer).map((entry) => entry.answer);
  expect(answers.map((answer) => (answer as { response: unknown }).response)).toEqual([
    { behavior: "allow", updatedInput: { query: "rook", limit: 5 } },
    { action: "accept" },
    { action: "decline" },
  ]);
});

test("reports exit codes, readable tool rows, and usage, retry and compaction notices", async () => {
  const { runtime } = await setup();
  const record = recordingSink();
  const parts: ReportedPart[] = [];
  const sink: TurnSink = { ...record.sink, part: (part) => parts.push(part) };
  await runtime.run(turn("notices"), sink, new AbortController().signal);
  const final = (id: string) => record.tools.findLast((tool) => tool.id === id);
  expect(final("bash-1")).toMatchObject({ status: "failed", exitCode: 3 });
  expect(final("skill-1")).toMatchObject({
    tool: "other",
    title: "Use the pdf skill",
    detail: "a.pdf",
    output: "Launching skill: pdf",
  });
  expect(parts.map((part) => [part.id, part.kind === "notice" && part.text])).toEqual([
    ["usage:five_hour", "Usage limit reached. Resets at 2026-11-02T08:53:25.000Z."],
    ["retry:turn", "Retrying (1/10) in 2s…"],
    ["retry:turn", "Reconnected after 1 retry"],
    ["compact:turn", "Context compacted"],
  ]);
}, 30_000);

test("common tools get readable titles, kinds and details", () => {
  const cwd = process.cwd();
  expect(toolTitle("ToolSearch", { query: "select:Read" }, cwd)).toBe("Find tools for select:Read");
  expect(toolKind("ToolSearch")).toBe("search");
  expect(toolDetail("ToolSearch", { query: "x", max_results: 5 })).toBeNull();
  expect(toolTitle("NotebookRead", { notebook_path: "a.ipynb" }, cwd)).toBe("Read a.ipynb");
  expect(toolKind("NotebookRead")).toBe("read");
  expect(toolTitle("KillShell", { shell_id: "1" }, cwd)).toBe("Stop a background command");
  expect(toolKind("BashOutput")).toBe("command");
  expect(toolTitle("ReadMcpResourceTool", { server: "s", uri: "x://y" }, cwd)).toBe("Read x://y");
  expect(toolKind("ReadMcpResourceTool")).toBe("mcp");
  // Unknown tools read as words, not identifiers.
  expect(toolTitle("CronCreate", {}, cwd)).toBe("Cron create");
  expect(toolTitle("Bogus", {}, cwd)).toBe("Bogus");
});
