// Claude Code chats: drives the official `claude` CLI in print mode over stream-json, the same
// channel the Claude Agent SDK uses. The CLI keeps its own sign-in; Rook never sees credentials.
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as NodePath from "node:path";
import { createInterface } from "node:readline";

import type { AccessMode, FileChange, ModelOption, ToolStatus } from "@rook/contracts";

import type { AgentHost } from "../agents/driver.ts";
import { killTree, resolveCommand, spawnCommand, type Env } from "../agents/process.ts";
import {
  argsText,
  claudeReason,
  elicitationApproval,
  elicitationNotice,
  elicitationResponse,
  type Elicitation,
} from "./approvals.ts";
import { markLegacy } from "./models.ts";
import { claudeQuestions, claudeReply } from "./questions.ts";
import {
  claudeTodoCall,
  claudeTodoResult,
  exitPlanText,
  isClaudeTodoTool,
  refineMessage,
  todoItems,
  type ClaudeTask,
} from "./plans.ts";
import {
  CLAUDE_TURN,
  claudeCompactNotice,
  claudeRateLimitNotice,
  claudeRetryNotice,
  logUnknown,
  claudeCompactingNotice,
  claudeModeNotice,
  gaveUpNotice,
  recoveredNotice,
} from "./notices.ts";
import { claudeExitCode, tailOutput } from "./output.ts";
import {
  ChatRuntimeError,
  type ChatRuntime,
  type SubagentEvent,
  type ToolUpdate,
  type TurnInput,
  type TurnSink,
} from "./runtime.ts";

type Json = Record<string, unknown>;

const object = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const ACCESS_MODES: readonly AccessMode[] = ["ask", "edit", "auto", "full"];
const PERMISSION_MODES: Record<AccessMode, string> = {
  ask: "manual",
  edit: "acceptEdits",
  auto: "auto",
  full: "bypassPermissions",
};
// The mode a session continues in once its plan is accepted; `manual` is only a flag alias.
const SESSION_MODES: Record<AccessMode, string> = { ...PERMISSION_MODES, ask: "default" };
const STREAM_ARGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
];
// Rook's delegation tools. The token stays off the command line: the CLI expands
// ${ROOK_MCP_TOKEN} in headers from the env (verified live with 2.1.314).
const ROOK_TOOLS = "mcp__rook__delegate_task,mcp__rook__task_status,mcp__rook__task_cancel";
const MAX_TEXT = 4000;
const CATALOG_TIMEOUT_MS = 30_000;
// No overall turn timeout: turns can run for hours. Only total silence at the start is a hang.
const FIRST_OUTPUT_MS = 90_000;
const INTERRUPT_GRACE_MS = 5_000;
const IDLE_MS = 10 * 60_000;

const truncate = (text: string, max = MAX_TEXT) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

function oneLine(text: string, max = 80): string {
  const lines = text.trim().split("\n");
  const line = lines[0] ?? "";
  return line.length > max || lines.length > 1 ? `${line.slice(0, max)}…` : line;
}

const TOOL_KINDS: Record<string, string> = {
  Bash: "command",
  PowerShell: "command",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Write: "edit",
  Read: "read",
  Glob: "search",
  Grep: "search",
  WebFetch: "web",
  WebSearch: "web",
  Task: "agent",
  Agent: "agent",
  NotebookRead: "read",
  ToolSearch: "search",
  BashOutput: "command",
  KillShell: "command",
  KillBash: "command",
  ListMcpResourcesTool: "mcp",
  ReadMcpResourceTool: "mcp",
};

/** `system` subtypes Rook reads elsewhere or needs nothing from (no debug line for them). */
const KNOWN_SYSTEM = new Set([
  "init",
  "status",
  "task_started",
  "task_progress",
  "task_notification",
  "thinking_tokens",
  "commands_changed",
  "hook_started",
  "hook_progress",
  "hook_response",
]);

/** Tools whose title says all their input does; their JSON input would only be noise. */
const TITLE_ONLY = new Set([
  "NotebookRead",
  "ToolSearch",
  "BashOutput",
  "KillShell",
  "KillBash",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "EnterWorktree",
  "ExitWorktree",
]);

/** The icon kind for a Claude Code tool name. */
export function toolKind(name: string): string {
  return name.startsWith("mcp__") ? "mcp" : (TOOL_KINDS[name] ?? "other");
}

/** A path relative to the project when it is inside it, with forward slashes. */
function displayPath(cwd: string, path: string): string {
  const absolute = NodePath.resolve(cwd, path);
  const relative = NodePath.relative(cwd, absolute);
  const inside =
    relative &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative);
  return inside ? relative.replaceAll("\\", "/") : path;
}

/** One line for a tool call, e.g. "Run `npm test`" or "Edit src/app.ts". */
export function toolTitle(name: string, input: Json, cwd: string): string {
  const path = () =>
    displayPath(cwd, str(input.file_path) ?? str(input.notebook_path) ?? str(input.path) ?? "");
  const field = (key: string) => oneLine(str(input[key]) ?? "");
  switch (name) {
    case "Bash":
    case "PowerShell":
      return `Run \`${field("command")}\``;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `Edit ${path()}`;
    case "Write":
      return `Write ${path()}`;
    case "Read":
      return `Read ${path()}`;
    case "Glob":
    case "Grep":
      return `Search for ${field("pattern")}`;
    case "WebFetch":
      return `Fetch ${field("url")}`;
    case "WebSearch":
      return `Search the web for ${field("query")}`;
    case "Task":
    case "Agent":
      return field("description") || name;
    case "NotebookRead":
      return `Read ${path()}`;
    case "ToolSearch":
      return field("query") ? `Find tools for ${field("query")}` : "Find tools";
    case "Skill":
      return field("skill") ? `Use the ${field("skill")} skill` : "Use a skill";
    case "SlashCommand":
      return `Run ${field("command")}`;
    case "BashOutput":
      return "Read a background command's output";
    case "KillShell":
    case "KillBash":
      return "Stop a background command";
    case "ListMcpResourcesTool":
      return "List MCP resources";
    case "ReadMcpResourceTool":
      return field("uri") ? `Read ${field("uri")}` : "Read an MCP resource";
    case "EnterWorktree":
      return "Enter a worktree";
    case "ExitWorktree":
      return "Leave the worktree";
  }
  const [, server, tool] = name.split("__");
  if (name.startsWith("mcp__") && server && tool) return `${tool} (${server})`;
  // "CronCreate" reads as "Cron create".
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2");
  return words.charAt(0) + words.slice(1).toLowerCase();
}

/** An edit as `- old` / `+ new` lines, leaving out the lines it keeps at either end. */
function diff(edit: Json | null): string {
  const a = splitLines(str(edit?.old_string) ?? "");
  const b = splitLines(str(edit?.new_string) ?? "");
  const { start, end } = sharedEnds(a, b);
  const changed = (lines: readonly string[], prefix: string) =>
    lines.slice(start, lines.length - end).map((line) => prefix + line);
  return [...changed(a, "- "), ...changed(b, "+ ")].join("\n");
}

/** The command, a compact diff, or the arguments; truncated. */
export function toolDetail(name: string, input: Json): string | null {
  let text: string | null;
  if (name === "Bash" || name === "PowerShell") text = str(input.command);
  else if (name === "Edit") text = diff(input);
  else if (name === "MultiEdit") text = list(input.edits).map(object).map(diff).join("\n");
  else if (name === "Write") text = str(input.content);
  else if (name === "Task" || name === "Agent") text = str(input.prompt);
  else if (name === "Skill") text = str(input.args);
  else if (TITLE_ONLY.has(name)) text = null;
  else text = argsText(input);
  return text ? truncate(text) : null;
}

const splitLines = (text: string) => (text ? text.split("\n") : []);

/** How many lines `a` and `b` share at the start and, after those, at the end. */
function sharedEnds(a: readonly string[], b: readonly string[]) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a.at(-1 - end) === b.at(-1 - end))
    end++;
  return { start, end };
}

/** Lines removed and added going from `before` to `after`, not counting lines kept at either end. */
function lineDelta(before: unknown, after: unknown) {
  const a = splitLines(str(before) ?? "");
  const b = splitLines(str(after) ?? "");
  const { start, end } = sharedEnds(a, b);
  return { additions: b.length - start - end, deletions: a.length - start - end };
}

/**
 * The file an Edit, MultiEdit or Write call changes, with line counts from its input; undefined for
 * other tools. A Write's old content is unknown, so it counts additions only.
 */
export function toolFiles(name: string, input: Json, cwd: string): FileChange[] | undefined {
  const path = str(input.file_path);
  let counts: { additions: number; deletions: number };
  if (!path) return undefined;
  if (name === "Edit") counts = lineDelta(input.old_string, input.new_string);
  else if (name === "MultiEdit")
    counts = list(input.edits)
      .map(object)
      .map((edit) => lineDelta(edit?.old_string, edit?.new_string))
      .reduce(
        (sum, edit) => ({
          additions: sum.additions + edit.additions,
          deletions: sum.deletions + edit.deletions,
        }),
        { additions: 0, deletions: 0 },
      );
  else if (name === "Write") {
    const content = str(input.content) ?? "";
    // A final newline ends the last line; it doesn't start another.
    counts = { additions: splitLines(content.replace(/\n$/, "")).length, deletions: 0 };
  } else return undefined;
  return [{ path: displayPath(cwd, path).replaceAll("\\", "/"), ...counts }];
}

const RESULT_BLOCKS: Record<string, (block: Json) => string> = {
  text: (block) => str(block.text) ?? "",
  // ToolSearch loads tools by reference.
  tool_reference: (block) => str(block.tool_name) ?? "",
  // shortcut: images in results are named, not shown; show them once tool parts carry images.
  image: () => "[image]",
};

/** A tool result's text; `tail` keeps a command's last output rather than its first. */
/** A tool result's text, cut to its head (or `tail`) within `max`; 0 keeps it whole. */
function resultText(content: unknown, tail = false, max = MAX_TEXT): string | null {
  const text =
    typeof content === "string"
      ? content
      : list(content)
          .map(object)
          .map((block) => (block && RESULT_BLOCKS[str(block.type) ?? ""]?.(block)) ?? "")
          .filter(Boolean)
          .join("\n");
  if (!text || !max) return text || null;
  return tail ? tailOutput(text, max) : truncate(text, max);
}

/**
 * A subagent's report from its Task result, without the framing Claude Code wraps it in for the
 * parent: a `<tools-used-before-summary>` block, a preamble ending "The report follows:" with the
 * report indented under it, and an `agentId:` trailer.
 */
export function subagentReport(text: string | null): string | null {
  if (!text) return null;
  let report = text.replace(
    /<tools-used-before-summary>[\s\S]*?<\/tools-used-before-summary>/g,
    "",
  );
  const preamble = /^.*The report follows:.*\n/m.exec(report);
  if (preamble) report = report.slice(preamble.index + preamble[0].length).replace(/^ {2}/gm, "");
  return report.replace(/^agentId: [\s\S]*$/m, "").trim() || null;
}

/**
 * A subagent's step lines, then its result. The result (already truncated) is always kept;
 * steps that do not fit the rest of MAX_TEXT give way oldest first.
 */
export function subagentOutput(steps: readonly string[], result: string | null): string | null {
  // 30 leaves room for the "… N earlier steps" line.
  let room = MAX_TEXT - 30 - (result ? result.length + 2 : 0);
  let kept = steps.length;
  while (kept > 0 && steps[kept - 1]!.length + 1 <= room) room -= steps[--kept]!.length + 1;
  const dropped = kept;
  const lines = steps.slice(kept);
  if (dropped) lines.unshift(`… ${dropped} earlier step${dropped === 1 ? "" : "s"}`);
  return [lines.join("\n"), result].filter(Boolean).join("\n\n") || null;
}

/** A message safe to show for a failed `result`. */
export function turnError(result: unknown): string {
  const text = str(result)?.trim();
  if (text && /not logged in|\/login|invalid api key/i.test(text))
    return "Sign in to Claude Code to continue.";
  return text && text.length <= 300 && !text.includes("\n")
    ? text
    : "Claude Code stopped with an error.";
}

/** Maps the `initialize` control response's models to Rook's catalog. */
export function parseModels(payload: unknown): ModelOption[] {
  const models = list(object(payload)?.models).flatMap((entry): ModelOption[] => {
    const model = object(entry);
    const id = str(model?.value);
    if (!model || !id) return [];
    return [
      {
        id,
        name: str(model.displayName) ?? id,
        description: str(model.description),
        efforts: list(model.supportedEffortLevels).filter((e) => typeof e === "string"),
        defaultEffort: null, // The CLI does not report one.
        fast: model.supportsFastMode === true,
        auto: model.supportsAutoMode === true,
        images: true,
        isDefault: id === "default",
        legacy: false,
      },
    ];
  });
  return markLegacy(models);
}

/**
 * The context window from a `result` message's `modelUsage`: the main model's entry, else the
 * entry that read the most input (subagents and helpers use smaller models).
 */
export function contextWindow(modelUsage: unknown, model: string | null): number | null {
  const entries = Object.entries(object(modelUsage) ?? {}).map(([id, usage]) => {
    const entry = object(usage) ?? {};
    const tokens = ["inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"]
      .map((key) => Number(entry[key]) || 0)
      .reduce((a, b) => a + b, 0);
    return { id, tokens, window: Number(entry.contextWindow) || 0 };
  });
  const found =
    entries.find((entry) => entry.id === model) ??
    entries.toSorted((a, b) => b.tokens - a.tokens)[0];
  return found && found.window > 0 ? found.window : null;
}

/** Tokens a main-thread `assistant` message occupies, or null for a synthetic or empty report. */
export function contextUsed(message: Json | null): number | null {
  const usage = object(message?.usage);
  if (!usage || message?.model === "<synthetic>") return null;
  const count = (key: string) => Number(usage[key]) || 0;
  const input =
    count("input_tokens") + count("cache_creation_input_tokens") + count("cache_read_input_tokens");
  return input > 0 ? input + count("output_tokens") : null;
}

/** Reads every JSON line from a child's stdout; other lines are noise. */
function onJsonLines(child: ChildProcess, handler: (message: Json) => void): void {
  createInterface({ input: child.stdout! }).on("line", (line) => {
    let message: Json | null;
    try {
      message = object(JSON.parse(line));
    } catch {
      return;
    }
    if (message) handler(message);
  });
}

const sendLine = (child: ChildProcess, message: Json) => {
  if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
};

/** Asks a bare CLI for its models over the control channel. No model turn runs. */
function readModels(file: string, env: Env, signal: AbortSignal): Promise<unknown> {
  // Home, not a project: a project's own hooks and settings must not run here.
  const child = spawnCommand(file, STREAM_ARGS, { env, cwd: homedir() });
  const stop = AbortSignal.any([signal, AbortSignal.timeout(CATALOG_TIMEOUT_MS)]);
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const onStop = () => reject(new Error("Stopped waiting for Claude Code."));
  if (stop.aborted) onStop();
  stop.addEventListener("abort", onStop, { once: true });
  child.once("error", reject);
  child.once("close", () => reject(new Error("Claude Code exited before listing models.")));
  child.stdin?.on("error", () => undefined); // The child may exit before reading.
  onJsonLines(child, (message) => {
    const response = message.type === "control_response" ? object(message.response) : null;
    if (response?.request_id !== "rook-initialize") return;
    if (response.subtype !== "success") reject(new Error(String(response.error)));
    else resolve(response.response);
  });
  sendLine(child, {
    type: "control_request",
    request_id: "rook-initialize",
    request: { subtype: "initialize" },
  });
  return promise.finally(() => {
    stop.removeEventListener("abort", onStop);
    killTree(child);
  });
}

/** One CLI process kept alive between turns of a chat. */
interface Live {
  readonly child: ChildProcess;
  /** Everything the process was spawned with; a change needs a new process. */
  readonly key: string;
  /** The MCP token handed to this process; null without Rook's MCP server. */
  readonly token: string | null;
  /** Null until the CLI confirms the session in its init message. */
  sessionId: string | null;
  /** The CLI sent its init message, so the session opened. */
  initialized: boolean;
  stderr: string;
  dead: boolean;
  readonly exited: Promise<void>;
  idle?: NodeJS.Timeout;
  /** The running turn's handler. */
  onMessage?: ((message: Json) => void) | undefined;
  /** Sends a user message into the running turn. */
  steer?: ((content: Json[]) => void) | undefined;
}

async function userContent(input: Pick<TurnInput, "prompt" | "images">): Promise<Json[]> {
  const images = await Promise.all(
    input.images.map(async (image) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mediaType,
        data: (await readFile(image.path)).toString("base64"),
      },
    })),
  );
  return [...(input.prompt ? [{ type: "text", text: input.prompt }] : []), ...images];
}

let interrupts = 0;

export function claudeRuntime(host: AgentHost): ChatRuntime {
  const lives = new Map<string, Live>();
  // Each chat's task list: the CLI keeps it for the session, across turns and processes.
  const todos = new Map<string, { tasks: readonly ClaudeTask[] }>();

  async function spawnLive(file: string, input: TurnInput, key: string): Promise<Live> {
    const { model, effort, fast, access, plan } = input.settings;
    const args = [
      ...STREAM_ARGS,
      "--include-partial-messages",
      "--permission-prompt-tool",
      "stdio",
      // Echoes each user message as the CLI starts on it; runTurn uses that to place steers.
      "--replay-user-messages",
      "--permission-mode",
      plan ? "plan" : PERMISSION_MODES[access],
      // An accepted plan switches the session to full access, which the CLI allows only then.
      ...(plan && access === "full" ? ["--allow-dangerously-skip-permissions"] : []),
      // Newer models hide thinking unless summaries are on.
      "--settings",
      JSON.stringify(
        fast ? { showThinkingSummaries: true, fastMode: true } : { showThinkingSummaries: true },
      ),
    ];
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    // Rook picks a fresh id, but saves it only once the CLI reports it in init: a CLI that dies
    // before creating the session must not leave an id behind that can never be resumed.
    // `--session-id` fails for an id that exists, so later processes always resume.
    args.push(input.sessionId ? "--resume" : "--session-id", input.sessionId ?? randomUUID());
    if (input.instructions) {
      // A file, not --append-system-prompt: cmd.exe (npm's .cmd shim) cuts a command line at its
      // first newline. One file per chat, and a chat has one process at a time.
      // shortcut: files of deleted chats stay behind (a few KB each); prune them if that matters.
      const dir = NodePath.join(host.dataDir, "claude-instructions");
      const path = NodePath.join(dir, `${input.chatId}.md`);
      await mkdir(dir, { recursive: true });
      await writeFile(path, input.instructions);
      args.push("--append-system-prompt-file", path);
    }
    // Issued only here, since credential() revokes the chat's previous token.
    const token = input.mcp?.credential() ?? null;
    if (input.mcp) {
      const headers = { Authorization: "Bearer ${ROOK_MCP_TOKEN}" };
      const rook = { type: "http", url: input.mcp.url, headers };
      args.push("--mcp-config", JSON.stringify({ mcpServers: { rook } }));
      args.push("--allowedTools", ROOK_TOOLS);
    }

    // The task tools feed the reply's todo part.
    const env = {
      ...host.env,
      CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
      ...(token ? { ROOK_MCP_TOKEN: token } : {}),
    };
    const child = spawnCommand(file, args, { env, cwd: input.cwd });
    const { promise: exited, resolve: onExit } = Promise.withResolvers<void>();
    const live: Live = {
      child,
      key,
      token,
      sessionId: input.sessionId,
      initialized: false,
      stderr: "",
      dead: false,
      exited,
    };
    const die = () => {
      live.dead = true;
      clearTimeout(live.idle);
      if (lives.get(input.chatId) === live) lives.delete(input.chatId);
      onExit();
    };
    child.once("exit", die);
    child.once("error", die);
    child.stdin?.on("error", () => undefined); // The child may exit before reading.
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      live.stderr = (live.stderr + chunk).slice(-4000);
    });
    onJsonLines(child, (message) => {
      if (live.onMessage) return live.onMessage(message);
      // Nothing may wait on Rook between turns.
      if (message.type === "control_request") sendLine(child, controlError(message.request_id));
    });
    return live;
  }

  async function acquire(file: string, input: TurnInput): Promise<Live> {
    const { model, effort, fast, access, plan = false } = input.settings;
    const { mcp, instructions } = input;
    const key = JSON.stringify([
      input.cwd,
      model,
      effort,
      fast,
      access,
      plan,
      mcp?.url,
      instructions,
    ]);
    const current = lives.get(input.chatId);
    if (
      current &&
      !current.dead &&
      current.key === key &&
      current.sessionId === input.sessionId &&
      // A revoked or expired token respawns with --resume and a fresh one (D1).
      (current.token === null || mcp?.live(current.token))
    )
      return current;
    // Resuming a session another process still holds would fork it.
    if (current) await close(current);
    const live = await spawnLive(file, input, key);
    lives.set(input.chatId, live);
    return live;
  }

  async function close(live: Live): Promise<void> {
    clearTimeout(live.idle);
    for (const [chatId, entry] of lives) if (entry === live) lives.delete(chatId);
    killTree(live.child);
    await live.exited;
  }

  return {
    agentId: "claude",
    accessModes: ACCESS_MODES,

    async catalog(signal) {
      const file = resolveCommand("claude", host.env);
      if (!file) throw new ChatRuntimeError("Claude Code is not installed.");
      try {
        const models = parseModels(await readModels(file, host.env, signal));
        return { agentId: "claude", models, accessModes: ACCESS_MODES, error: null };
      } catch {
        throw new ChatRuntimeError("Could not read Claude Code's models.");
      }
    },

    async run(input, sink, signal) {
      const file = resolveCommand("claude", host.env);
      if (!file) throw new ChatRuntimeError("Claude Code is not installed.");
      // A session the CLI no longer has (deleted, or from another machine) starts over once, with
      // the earlier conversation handed to the new one.
      if (!(await turn(file, input, sink, signal)))
        await turn(file, { ...input, sessionId: null }, sink, signal);
    },

    async steer(chatId, input) {
      const take = lives.get(chatId)?.steer;
      if (!take) return false;
      const content = await userContent(input);
      // The turn may have ended, or another begun, while the images were read.
      if (lives.get(chatId)?.steer !== take) return false;
      take(content);
      return true;
    },

    dispose() {
      for (const live of lives.values()) void close(live);
    },
  };

  /** Runs one turn; false when the CLI could not resume `input.sessionId` because it is gone. */
  async function turn(
    file: string,
    input: TurnInput,
    sink: TurnSink,
    signal: AbortSignal,
  ): Promise<boolean> {
    // A new session starts empty: hand it the earlier conversation.
    const prompt = !input.sessionId && input.history ? input.history + input.prompt : input.prompt;
    const content = await userContent({ prompt, images: input.images });
    if (signal.aborted) return true;
    const live = await acquire(file, input);
    clearTimeout(live.idle);
    if (!input.sessionId) todos.delete(input.chatId);
    const todo = todos.get(input.chatId) ?? { tasks: [] };
    todos.set(input.chatId, todo);
    let clean = false;
    try {
      await runTurn(live, input, content, sink, signal, todo);
      clean = !signal.aborted;
    } catch (error) {
      if (input.sessionId && !live.initialized && !signal.aborted) {
        // The CLI reports a failed `result` just before it exits, and exit can come before the
        // last of stderr.
        await Promise.race([live.exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
        if (live.dead && !live.child.stderr?.closed)
          await once(live.child.stderr!, "close", { signal: AbortSignal.timeout(1_000) }).catch(
            () => undefined,
          );
        if (/No conversation found|session.*not found/i.test(live.stderr)) return false;
      }
      throw error;
    } finally {
      // shortcut: any stop or failure respawns with --resume next turn; cheap, and never
      // reuses a process left in an unknown state.
      if (clean && !live.dead) {
        live.idle = setTimeout(() => void close(live), IDLE_MS);
        live.idle.unref();
      } else await close(live);
    }
    return true;
  }
}

/** What the agent hears when the user declines, with what they want instead if they said. */
export function declineMessage(feedback: string | null): string {
  return feedback
    ? `The user declined this action and said: ${feedback}`
    : "The user declined this action.";
}

function controlError(requestId: unknown): Json {
  return {
    type: "control_response",
    response: { subtype: "error", request_id: requestId, error: "Unsupported" },
  };
}

/** A Task tool's subagent: its type (e.g. "Explore") and the tool calls it made. */
interface Subagent {
  type: string | null;
  readonly steps: { readonly id: string; readonly title: string; status: ToolStatus }[];
  result: string | null;
  /** Its own tool calls (nested subagents' left out), as its transcript shows them. */
  readonly tools: Map<string, ToolUpdate>;
  /** The id of the message its stream events belong to. */
  messageId: string;
  /** Its transcript got "ended"; nothing more goes to it. */
  ended: boolean;
  /** Its transcript ends in text, so it already shows the subagent's answer. */
  answered: boolean;
}

/** Sends one user turn and maps the CLI's events to the sink until its `result`. */
function runTurn(
  live: Live,
  input: TurnInput,
  content: Json[],
  sink: TurnSink,
  signal: AbortSignal,
  todo: { tasks: readonly ClaudeTask[] },
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const tools = new Map<string, ToolUpdate>();
  // Subagents by their top-level Task tool id. Their tools fold into that part's output.
  const subagents = new Map<string, Subagent>();
  // A subagent's tool ids and agent ids, nested ones included, to their top-level Task tool id.
  const owners = new Map<string, string>();
  // Messages whose text already streamed as deltas; their `assistant` copy must not repeat it.
  const streamed = new Set<string>();
  let messageId = "";
  let modelReported = false;
  // The main thread's latest usage; the window arrives only with the `result`.
  let used: number | null = null;
  let mainModel: string | null = null;
  let settled = false;
  /** API retries since the CLI last streamed. */
  let retries = 0;
  /** The mode an accepted plan asked to continue in, until the CLI reports the one it took. */
  let askedMode: string | null = null;
  let grace: NodeJS.Timeout | undefined;
  const write = (message: Json) => sendLine(live.child, message);
  // Steered messages the CLI has not started on yet. Any `result` before their echo is interim:
  // the CLI ends the cut-off part (seen: terminal_reason aborted_streaming, aborted_tools,
  // stop_hook_prevented), then answers the steer in the same stream.
  const steers = new Set<string>();
  live.steer = (steered) => {
    const uuid = randomUUID();
    steers.add(uuid);
    write({
      type: "user",
      message: { role: "user", content: steered },
      parent_tool_use_id: null,
      session_id: "",
      priority: "now",
      uuid,
    });
  };

  const firstOutput = setTimeout(
    () => reject(new ChatRuntimeError("Claude Code did not respond. Try again.")),
    FIRST_OUTPUT_MS,
  );
  const onAbort = () => {
    live.steer = undefined;
    write({
      type: "control_request",
      request_id: `rook-interrupt-${++interrupts}`,
      request: { subtype: "interrupt" },
    });
    grace = setTimeout(resolve, INTERRUPT_GRACE_MS);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  void live.exited.then(() => {
    if (settled || signal.aborted) return resolve();
    console.error(
      `Claude Code exited mid-turn (code ${live.child.exitCode}):`,
      live.stderr.slice(-2000),
    );
    reject(new ChatRuntimeError("Claude Code stopped unexpectedly."));
  });

  const setTool = (update: ToolUpdate) => {
    tools.set(update.id, update);
    sink.tool(update);
  };
  const ownerOf = (id: string) => (subagents.has(id) ? id : owners.get(id));
  /** Re-sends a Task part with one line per subagent step, then the Task's result. */
  const showSubagent = (taskId: string, status?: ToolStatus) => {
    const subagent = subagents.get(taskId);
    const tool = tools.get(taskId);
    if (!subagent || !tool) return;
    const steps = subagent.steps.map((step) =>
      step.status === "failed" || step.status === "declined"
        ? `${step.title} (${step.status})`
        : step.title,
    );
    const output = subagentOutput(steps, subagent.result);
    setTool({ ...tool, output, status: status ?? tool.status });
  };
  /** The subagent step for a tool id, with its Task's id. */
  const stepOf = (id: string) => {
    const taskId = owners.get(id);
    const step = taskId ? subagents.get(taskId)?.steps.find((entry) => entry.id === id) : null;
    return taskId && step ? { taskId, step } : null;
  };
  /** Sends a subagent's own activity to its transcript, until it has ended. */
  const report = (taskId: string, event: SubagentEvent) => {
    const subagent = subagents.get(taskId);
    if (!subagent || subagent.ended) return;
    if (event.type === "ended") subagent.ended = true;
    if (event.type === "text") subagent.answered = true;
    if (event.type === "tool") subagent.answered = false;
    sink.subagent?.(taskId, event);
  };
  const reportTool = (taskId: string, update: ToolUpdate) => {
    subagents.get(taskId)?.tools.set(update.id, update);
    report(taskId, { type: "tool", update });
  };
  const reportModel = (model: string | null) => {
    if (!model || model === "<synthetic>" || modelReported) return;
    modelReported = true;
    sink.model(model);
  };
  // Plan and todo tool calls: they show as the plan card and the todo row, not as tool rows.
  const planCalls = new Set<string>();
  const todoId = `todo-${randomUUID()}`;
  const showTodo = () => sink.part({ kind: "todo", id: todoId, items: todoItems(todo.tasks) });
  /** Takes a top-level plan or todo tool call; false for any other tool. */
  const planCall = (id: string, name: string, toolInput: Json) => {
    if (name !== "ExitPlanMode" && !isClaudeTodoTool(name)) return false;
    if (planCalls.has(id)) return true;
    planCalls.add(id);
    const tasks = claudeTodoCall(todo.tasks, id, name, toolInput);
    if (tasks !== todo.tasks) {
      todo.tasks = tasks;
      showTodo();
    }
    return true;
  };
  const reportSession = (id: string | null) => {
    if (!id || id === live.sessionId) return;
    live.sessionId = id;
    sink.session(id);
  };

  /** Deltas of the main thread, or (`parentId`) of a subagent's own messages, to its transcript. */
  function onStream(event: Json | null, parentId: string | null) {
    const subagent = parentId ? subagents.get(parentId) : null;
    if (parentId && !subagent) return; // A nested subagent's: its text stays out.
    if (event?.type === "message_start") {
      const id = str(object(event.message)?.id) ?? "";
      if (subagent) subagent.messageId = id;
      else messageId = id;
    }
    const delta = event?.type === "content_block_delta" ? object(event.delta) : null;
    const text = delta?.type === "text_delta" ? str(delta.text) : null;
    const thinking = delta?.type === "thinking_delta" ? str(delta.thinking) : null;
    if (!text && !thinking) return;
    streamed.add(subagent ? subagent.messageId : messageId);
    if (parentId)
      report(
        parentId,
        text ? { type: "text", delta: text } : { type: "reasoning", delta: thinking! },
      );
    else if (text) sink.text(text);
    else sink.reasoning(thinking!);
  }

  function onAssistant(message: Json | null) {
    reportModel(str(message?.model));
    const tokens = contextUsed(message);
    if (tokens !== null) {
      used = tokens;
      mainModel = str(message?.model);
    }
    const fresh = !streamed.has(str(message?.id) ?? "");
    for (const block of list(message?.content).map(object)) {
      if (block?.type === "tool_use") {
        const id = str(block.id);
        const name = str(block.name) ?? "tool";
        // Its question part shows it; a tool row would only repeat the questions as JSON.
        if (!id || tools.has(id) || name === "AskUserQuestion") continue;
        const toolInput = object(block.input) ?? {};
        if (planCall(id, name, toolInput)) continue;
        const type = str(toolInput.subagent_type);
        const agent = toolKind(name) === "agent";
        if (agent)
          subagents.set(id, {
            type,
            steps: [],
            result: null,
            tools: new Map(),
            messageId: "",
            ended: false,
            answered: false,
          });
        const files = toolFiles(name, toolInput, input.cwd);
        setTool({
          id,
          tool: toolKind(name),
          title: toolTitle(name, toolInput, input.cwd),
          detail: toolDetail(name, toolInput),
          output: null,
          status: "running",
          ...(files && { files }),
        });
        if (agent)
          report(id, {
            type: "started",
            title: str(toolInput.description)
              ? toolTitle(name, toolInput, input.cwd)
              : (type ?? "Subagent"),
            prompt: str(toolInput.prompt),
            model: str(toolInput.model),
          });
      } else if (fresh && block?.type === "text" && str(block.text)) sink.text(str(block.text)!);
      else if (fresh && block?.type === "thinking" && str(block.thinking))
        sink.reasoning(str(block.thinking)!);
    }
  }

  function onToolResults(message: Json | null) {
    for (const block of list(message?.content).map(object)) {
      const callId = block?.type === "tool_result" ? (str(block.tool_use_id) ?? "") : "";
      if (planCalls.has(callId)) {
        const tasks = claudeTodoResult(todo.tasks, callId, resultText(block?.content));
        if (tasks !== todo.tasks) {
          todo.tasks = tasks;
          showTodo();
        }
        continue;
      }
      const tool = block?.type === "tool_result" ? tools.get(str(block.tool_use_id) ?? "") : null;
      if (!block || !tool) continue;
      const status =
        tool.status === "declined" ? "declined" : block.is_error === true ? "failed" : "done";
      const subagent = subagents.get(tool.id);
      if (!subagent) {
        const command = tool.tool === "command";
        const output = resultText(block.content, command);
        // From the whole result: cutting long output to its tail can drop the exit code line.
        const exitCode =
          command && status === "failed"
            ? claudeExitCode(resultText(block.content, false, 0))
            : null;
        setTool({ ...tool, output, status, ...(command && { exitCode }) });
      } else {
        subagent.result = subagentReport(resultText(block.content));
        showSubagent(tool.id, status);
        // The CLI may hand the subagent's final report only to the parent, inside this result.
        if (status === "done" && subagent.result && !subagent.answered)
          report(tool.id, { type: "text", delta: subagent.result });
        report(tool.id, {
          type: "ended",
          status: status === "done" ? "completed" : status === "failed" ? "failed" : "cancelled",
          error: status === "failed" ? subagent.result : null,
        });
      }
    }
  }

  /**
   * Folds a subagent's tool calls and results into its Task part. Its own messages also go to its
   * transcript; a nested subagent's only fold in.
   */
  function onSubagent(parentId: string, message: Json | null) {
    const taskId = ownerOf(parentId);
    const subagent = taskId ? subagents.get(taskId) : null;
    if (!taskId || !subagent) return;
    const own = taskId === parentId;
    // Text that streamed as deltas is not repeated.
    const fresh = own && message?.role === "assistant" && !streamed.has(str(message.id) ?? "");
    for (const block of list(message?.content).map(object)) {
      const id = str(block?.id) ?? "";
      if (block?.type === "tool_use" && id && !owners.has(id)) {
        owners.set(id, taskId);
        const name = str(block.name) ?? "tool";
        const toolInput = object(block.input) ?? {};
        const title = toolTitle(name, toolInput, input.cwd);
        subagent.steps.push({ id, title, status: "running" });
        showSubagent(taskId);
        const detail = toolDetail(name, toolInput);
        const tool = toolKind(name);
        if (own) reportTool(taskId, { id, tool, title, detail, output: null, status: "running" });
      } else if (fresh && block?.type === "text" && str(block.text))
        report(taskId, { type: "text", delta: str(block.text)! });
      else if (fresh && block?.type === "thinking" && str(block.thinking))
        report(taskId, { type: "reasoning", delta: str(block.thinking)! });
      const found = block?.type === "tool_result" ? stepOf(str(block.tool_use_id) ?? "") : null;
      if (!found) continue;
      if (found.step.status !== "declined")
        found.step.status = block?.is_error === true ? "failed" : "done";
      showSubagent(found.taskId);
      const call = subagent.tools.get(found.step.id);
      const output = resultText(block?.content);
      if (call) reportTool(taskId, { ...call, output, status: found.step.status });
    }
  }

  async function onControl(message: Json) {
    const requestId = message.request_id;
    const request = object(message.request);
    if (request?.subtype === "elicitation") return onElicitation(requestId, request);
    if (request?.subtype !== "can_use_tool") return write(controlError(requestId));
    const name = str(request.tool_name) ?? "tool";
    const toolInput = object(request.input) ?? {};
    if (name === "ExitPlanMode") return onPlan(requestId, toolInput);
    const toolUseId = str(request.tool_use_id) ?? "";
    // `agent_id` is set when the call comes from inside a subagent.
    const agentId = str(request.agent_id);
    const taskId = owners.get(agentId ?? "") ?? owners.get(toolUseId);
    const from = agentId || taskId ? `${subagents.get(taskId ?? "")?.type ?? "Subagent"} · ` : "";
    if (name === "AskUserQuestion") {
      const questions = claudeQuestions(toolInput);
      const declined = {
        declined: true as const,
        feedback: "There were no questions Rook could show.",
      };
      // Nothing to show means nothing to answer: never leave the agent waiting on an empty panel.
      const reply = !questions.length
        ? declined
        : await sink
            .ask({ id: String(requestId), questions, ...(taskId && { subagent: taskId }) })
            .catch(() => ({ declined: true as const, feedback: null }));
      const response = claudeReply(toolInput, questions, reply);
      return write({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response },
      });
    }
    const { decision, feedback } = await sink
      .approve({
        id: String(requestId),
        title: from + toolTitle(name, toolInput, input.cwd),
        detail: toolDetail(name, toolInput),
        options: ["allow", "allowSession", "deny"],
        tool: toolKind(name),
        reason: claudeReason(request),
        ...(toolUseId && { toolId: toolUseId }),
        ...(taskId && { subagent: taskId }),
      })
      .catch(() => ({ decision: "deny" as const, feedback: null }));
    const suggestions = list(request.permission_suggestions);
    const response =
      decision === "deny"
        ? { behavior: "deny", message: declineMessage(feedback) }
        : {
            behavior: "allow",
            updatedInput: toolInput,
            ...(decision === "allowSession" && suggestions.length
              ? { updatedPermissions: suggestions }
              : {}),
          };
    write({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
    if (decision !== "deny" || settled) return;
    const tool = tools.get(toolUseId);
    const step = stepOf(toolUseId);
    if (tool) setTool({ ...tool, status: "declined" });
    else if (step) {
      step.step.status = "declined";
      showSubagent(step.taskId);
      const call = subagents.get(step.taskId)?.tools.get(toolUseId);
      if (call) reportTool(step.taskId, { ...call, status: "declined" });
    }
  }

  /** Shows the plan and answers the CLI: go ahead in the user's access mode, or revise. */
  async function onPlan(requestId: unknown, toolInput: Json) {
    const { decision, feedback } = await sink
      .reviewPlan({ id: String(requestId), text: exitPlanText(toolInput) })
      .catch(() => ({ decision: "deny" as const, feedback: null }));
    const mode = SESSION_MODES[input.settings.access];
    const response =
      decision === "deny"
        ? { behavior: "deny", message: refineMessage(feedback) }
        : {
            behavior: "allow",
            updatedInput: toolInput,
            updatedPermissions: [{ type: "setMode", mode, destination: "session" }],
          };
    if (decision !== "deny") askedMode = mode;
    write({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
  }

  /**
   * An MCP server asks for input: a link to open or a form with nothing to fill in becomes an
   * approval; anything else is declined, with a notice saying so.
   */
  async function onElicitation(requestId: unknown, request: Json) {
    const elicitation: Elicitation = {
      server: str(request.mcp_server_name) ?? "MCP",
      mode: str(request.mode) ?? "form",
      message: str(request.message) ?? "",
      url: str(request.url),
      schema: request.requested_schema,
      meta: null,
    };
    const ask = elicitationApproval(elicitation);
    if (!ask)
      sink.part({
        kind: "notice",
        id: `elicitation:${String(requestId)}`,
        ...elicitationNotice(elicitation),
      });
    const { decision } = ask
      ? await sink
          .approve({ id: String(requestId), ...ask })
          .catch(() => ({ decision: "deny" as const }))
      : { decision: "deny" as const };
    write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: elicitationResponse(elicitation, decision),
      },
    });
  }

  live.onMessage = (message) => {
    clearTimeout(firstOutput);
    // Subagent traffic belongs to its Task tool, not the reply.
    const parentId = str(message.parent_tool_use_id);
    switch (message.type) {
      case "system": {
        // Ties a subagent's agent id, which its approvals carry, to its Task.
        const taskId = ownerOf(str(message.tool_use_id) ?? "");
        if (message.subtype === "task_started" && taskId && str(message.task_id)) {
          owners.set(str(message.task_id)!, taskId);
          const subagent = subagents.get(taskId)!;
          subagent.type ??= str(message.subagent_type);
        }
        if (message.subtype === "api_retry") {
          retries++;
          return sink.part(claudeRetryNotice(message));
        }
        if (message.subtype === "compact_boundary") return sink.part(claudeCompactNotice(message));
        if (message.subtype === "status" && message.status === "compacting")
          return sink.part(claudeCompactingNotice());
        const reported = str(message.permissionMode);
        if (message.subtype === "status" && askedMode && reported) {
          if (reported !== askedMode) sink.part(claudeModeNotice(askedMode, reported));
          askedMode = null;
        }
        if (!KNOWN_SYSTEM.has(str(message.subtype) ?? ""))
          logUnknown("Claude Code", `system ${str(message.subtype)}`);
        if (message.subtype !== "init") return;
        live.initialized = true;
        reportSession(str(message.session_id));
        return reportModel(str(message.model));
      }
      case "stream_event":
        if (retries && !parentId) {
          sink.part(recoveredNotice(CLAUDE_TURN, retries));
          retries = 0;
        }
        return onStream(object(message.event), parentId);
      case "rate_limit_event": {
        const notice = claudeRateLimitNotice(object(message.rate_limit_info));
        return notice ? sink.part(notice) : undefined;
      }
      case "assistant":
      case "user":
        // The CLI's echo of a user message: it has started on that message.
        if (message.isReplay === true) return void steers.delete(str(message.uuid) ?? "");
        if (parentId) return onSubagent(parentId, object(message.message));
        return message.type === "assistant"
          ? onAssistant(object(message.message))
          : onToolResults(object(message.message));
      case "control_request":
        return void onControl(message);
      case "result": {
        reportSession(str(message.session_id));
        const window = contextWindow(message.modelUsage, mainModel);
        if (used !== null && window) sink.context({ used, window });
        if (signal.aborted) return resolve();
        const failed = message.subtype !== "success" || message.is_error === true;
        // A retry notice still up when the turn ends must not keep saying it retries.
        if (retries) sink.part((failed ? gaveUpNotice : recoveredNotice)(CLAUDE_TURN, retries));
        retries = 0;
        if (failed) return reject(new ChatRuntimeError(turnError(message.result)));
        // Every interim result seen was a success; an error still ends the turn above.
        return steers.size ? undefined : resolve();
      }
      case "control_response": // The CLI's echo of Rook's answers.
        return;
      default:
        logUnknown("Claude Code", `message ${str(message.type)}`);
    }
  };

  write({
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: "",
  });
  return promise.finally(() => {
    settled = true;
    live.onMessage = undefined;
    live.steer = undefined;
    clearTimeout(firstOutput);
    clearTimeout(grace);
    signal.removeEventListener("abort", onAbort);
    // Subagents still running when the turn ends are never heard from again.
    for (const id of subagents.keys())
      report(id, { type: "ended", status: "cancelled", error: null });
  });
}
