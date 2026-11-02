// Codex chats over the official `codex app-server` (newline JSON-RPC without "jsonrpc"). One
// shared process runs every chat's thread; notifications and approval requests carry a
// threadId, which routes them to the running turn. Codex keeps its own sign-in.
import * as NodePath from "node:path";

import type {
  AccessMode,
  AgentCatalog,
  FileChange,
  ModelOption,
  ToolStatus,
} from "@rook/contracts";

import type { AgentHost } from "../agents/driver.ts";
import { resolveCommand, spawnCommand } from "../agents/process.ts";
import { RpcClosedError, RpcError, RpcPeer } from "../agents/rpc.ts";
import {
  grantText,
  legacyCommand,
  codexDecision,
  codexOptions,
  elicitationApproval,
  elicitationNotice,
  elicitationResponse,
  legacyDecision,
  patchText,
  permissionsResponse,
  permissionsText,
  type Elicitation,
} from "./approvals.ts";
import { markLegacy } from "./models.ts";
import { codexAnswers, codexQuestions } from "./questions.ts";

import { codexTodoItems } from "./plans.ts";
import {
  codexErrorNotice,
  codexItemNotice,
  gaveUpNotice,
  isLimit,
  recoveredNotice,
  codexReroutedNotice,
  codexWarningNotice,
  compactionNotice,
  logUnknown,
  type CodexRateLimits,
  type Notice,
} from "./notices.ts";
import { appendOutput, MAX_OUTPUT, tailOutput, type OutputBuffer } from "./output.ts";
import {
  ChatRuntimeError,
  type ApprovalRequest,
  type ChatRuntime,
  type SubagentEvent,
  type ToolUpdate,
  type TurnInput,
  type TurnSink,
} from "./runtime.ts";

const IDLE_MS = 10 * 60_000;
const INTERRUPT_MS = 5_000;
const MAX_DETAIL = 4000;
/** How often a running command's streamed output is re-sent. */
const OUTPUT_MS = 150;
const ACCESS_MODES: readonly AccessMode[] = ["ask", "edit", "auto", "full"];

// The slices of the app-server protocol (codex-cli 0.162) Rook reads.
export interface CodexModel {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly hidden: boolean;
  readonly isDefault: boolean;
  readonly supportedReasoningEfforts: readonly { readonly reasoningEffort: string }[];
  readonly defaultReasoningEffort: string;
  readonly inputModalities: readonly string[];
  readonly serviceTiers?: readonly { readonly id: string; readonly name: string }[];
}

interface CodexTurn {
  readonly id: string;
  readonly status: "completed" | "interrupted" | "failed" | "inProgress";
  readonly error: { readonly message: string } | null;
}

interface ThreadResponse {
  readonly thread: { readonly id: string };
  readonly model: string;
}

type Status = "inProgress" | "completed" | "failed" | "declined";

/** Thread items that become tool parts; other types (messages, reasoning) map to nothing. */
export type CodexItem =
  | {
      readonly type: "commandExecution";
      readonly id: string;
      readonly command: string;
      /** Codex's own parse of the command, without the shell it runs in. */
      readonly commandActions?: readonly { readonly command: string }[] | null;
      readonly status: Status;
      readonly aggregatedOutput: string | null;
      readonly exitCode: number | null;
    }
  | {
      readonly type: "fileChange";
      readonly id: string;
      readonly changes: readonly {
        readonly path: string;
        readonly diff: string;
        /** An added or deleted file's `diff` is its content; an update's is a unified diff. */
        readonly kind?: {
          readonly type: "add" | "delete" | "update";
          readonly move_path?: string | null;
        };
      }[];
      readonly status: Status;
    }
  | {
      readonly type: "mcpToolCall";
      readonly id: string;
      readonly server: string;
      readonly tool: string;
      readonly status: Status;
      readonly arguments: unknown;
      readonly result: { readonly content: readonly unknown[] } | null;
      readonly error: { readonly message: string } | null;
    }
  | {
      readonly type: "dynamicToolCall";
      readonly id: string;
      readonly tool: string;
      readonly status: Status;
      readonly arguments: unknown;
      readonly contentItems: readonly { readonly text?: string }[] | null;
    }
  | {
      readonly type: "webSearch";
      readonly id: string;
      readonly query: string;
      readonly action: { readonly type: string; readonly url?: string | null } | null;
    }
  | {
      /** Codex's built-in subagents; receiverThreadIds fill in when a spawn completes. */
      readonly type: "collabAgentToolCall";
      readonly id: string;
      readonly tool: string;
      readonly status: Status | "interrupted";
      readonly receiverThreadIds: readonly string[];
      readonly prompt?: string | null;
      readonly model?: string | null;
    }
  | {
      /** Multi-agent v2: a child thread "started", or later "interacted" / "completed" / … */
      readonly type: "subAgentActivity";
      readonly id: string;
      readonly kind: string;
      readonly agentThreadId: string;
      readonly agentPath: string;
    }
  | { readonly type: "imageView"; readonly id: string; readonly path: string }
  | { readonly type: "sleep"; readonly id: string; readonly durationMs: number }
  | {
      readonly type: "imageGeneration";
      readonly id: string;
      readonly status: string;
      readonly revisedPrompt: string | null;
      readonly failure: { readonly type: string } | null;
      readonly savedPath?: string;
    }
  | {
      readonly type: "functionCallOutput";
      readonly id: string;
      readonly name: string;
      readonly namespace: string | null;
      readonly output: string | readonly { readonly type: string; readonly text?: string }[];
    }
  | {
      readonly type: "enteredReviewMode" | "exitedReviewMode";
      readonly id: string;
      readonly review: string;
    }
  | { readonly type: "contextCompaction"; readonly id: string }
  | { readonly type: "agentMessage"; readonly id: string; readonly text: string }
  /** A plan proposed in plan mode; its text streams through item/plan/delta. */
  | { readonly type: "plan"; readonly id: string; readonly text: string }
  | {
      readonly type: "userMessage";
      readonly id: string;
      readonly content: readonly { readonly text?: string }[];
    };

/** Collab tools that start a turn on their receivers. */
const RUNS_AGENT = new Set(["spawnAgent", "sendInput", "sendMessage", "followupTask"]);

const AGENT_ACTIONS: Record<string, string> = {
  spawnAgent: "Spawn agent",
  sendInput: "Message agent",
  sendMessage: "Message agent",
  followupTask: "Message agent",
  resumeAgent: "Resume agent",
  wait: "Wait for agents",
  closeAgent: "Close agent",
  interruptAgent: "Interrupt agent",
  listAgents: "List agents",
};

/** Approval policy, sandbox, and reviewer for each Rook access mode. */
export function codexAccess(access: AccessMode, cwd: string) {
  if (access === "ask") {
    // "untrusted": Codex asks before anything outside its trusted read-only commands.
    return {
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      approvalsReviewer: "user",
    } as const;
  }
  if (access === "full") {
    return {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      sandboxPolicy: { type: "dangerFullAccess" },
      approvalsReviewer: "user",
    } as const;
  }
  return {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    approvalsReviewer: access === "auto" ? "auto_review" : "user",
  } as const;
}

/** The model's fast service tier id, if it has one. */
export function fastTier(model: CodexModel): string | null {
  const tier = model.serviceTiers?.find(
    (candidate) => candidate.id === "priority" || candidate.name.toLowerCase() === "fast",
  );
  return tier?.id ?? null;
}

export function codexModelOption(model: CodexModel): ModelOption {
  return {
    id: model.id,
    name: model.displayName || model.id,
    description: model.description || null,
    efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
    defaultEffort: model.defaultReasoningEffort ?? null,
    fast: fastTier(model) !== null,
    auto: true,
    images: model.inputModalities.includes("image"),
    isDefault: model.isDefault,
    legacy: false, // Set across the whole catalog by markLegacy.
  };
}

export function codexInput(input: Pick<TurnInput, "prompt" | "images">) {
  return [
    ...(input.prompt ? [{ type: "text", text: input.prompt, text_elements: [] }] : []),
    ...input.images.map((image) => ({ type: "localImage", path: image.path })),
  ];
}

const truncate = (text: string | null | undefined) =>
  !text ? null : text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;

const json = (value: unknown) =>
  value === null || value === undefined ? null : truncate(JSON.stringify(value, null, 2));

/** Forward slashes, like the paths Claude Code's tool rows show. */
function relative(path: string, cwd: string): string {
  const rel = NodePath.relative(cwd, path);
  return rel && !rel.startsWith("..") && !NodePath.isAbsolute(rel)
    ? rel.replaceAll("\\", "/")
    : path;
}

// `"C:\…\powershell.exe" -Command '…'`, `bash -lc '…'` and similar wrappers Codex runs commands in.
const SHELL_WRAPPER =
  /^"?[^"\s]*?(?:powershell|pwsh|bash|zsh|sh|cmd)(?:\.exe)?"?\s+(?:-NoProfile\s+)?(?:-Command|-lc|-c|\/c)\s+(['"]?)([\s\S]+)\1$/i;

/** The command as the user would type it, for a tool row's title. */
export function commandTitle(
  command: string,
  actions?: readonly { command: string }[] | null,
): string {
  const parsed = actions?.map((action) => action.command).filter(Boolean);
  if (parsed?.length) return parsed.join(" && ");
  return SHELL_WRAPPER.exec(command.trim())?.[2] ?? command;
}

function toolStatus(status: Status): ToolStatus {
  if (status === "completed") return "done";
  if (status === "failed" || status === "declined") return status;
  return "running";
}

/** Lines a Codex file change adds and removes, from its diff without headers. */
function changeCounts(change: {
  readonly diff: string;
  readonly kind?: { readonly type: string };
}) {
  const { diff } = change;
  if (change.kind?.type === "add" || change.kind?.type === "delete") {
    const count = diff ? diff.replace(/\n$/, "").split("\n").length : 0;
    return change.kind.type === "add"
      ? { additions: count, deletions: 0 }
      : { additions: 0, deletions: count };
  }
  // File headers come before the first hunk; without hunks, skip `+++`/`---` header lines.
  const hunks = diff.search(/^@@/m);
  let additions = 0;
  let deletions = 0;
  for (const line of (hunks >= 0 ? diff.slice(hunks) : diff).split("\n")) {
    if (hunks < 0 && /^(?:\+\+\+|---) /.test(line)) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/** The tool part for a thread item, or null for items that are not tools. */
export function codexToolUpdate(
  item: CodexItem,
  cwd: string,
  completed: boolean,
): ToolUpdate | null {
  const base = { id: item.id, detail: null, output: null };
  switch (item.type) {
    case "commandExecution":
      return {
        ...base,
        tool: "command",
        title: `Run \`${commandTitle(item.command, item.commandActions)}\``,
        detail: truncate(item.command),
        output: item.aggregatedOutput ? tailOutput(item.aggregatedOutput) : null,
        // On Windows Codex runs commands in PowerShell, which reports 1 for any failure.
        exitCode: item.exitCode,
        status:
          item.status === "completed" && item.exitCode !== null && item.exitCode !== 0
            ? "failed"
            : toolStatus(item.status),
      };
    case "fileChange": {
      const files = item.changes.map((change) => relative(change.path, cwd));
      return {
        ...base,
        tool: "edit",
        title: files.length === 1 ? `Edit ${files[0]}` : `Edit ${files.length} files`,
        detail: truncate(
          item.changes
            .map((change, i) => (files.length > 1 ? `${files[i]}\n${change.diff}` : change.diff))
            .join("\n"),
        ),
        status: toolStatus(item.status),
        files: item.changes.map((change): FileChange => ({
          path: relative(change.kind?.move_path ?? change.path, cwd),
          ...changeCounts(change),
        })),
      };
    }
    case "mcpToolCall": {
      const text = item.result?.content
        .map((part) => (part as { text?: unknown }).text)
        .filter((part) => typeof part === "string")
        .join("\n");
      return {
        ...base,
        tool: "mcp",
        title: `${item.server} · ${item.tool}`,
        detail: json(item.arguments),
        output: truncate(item.error?.message ?? text),
        status: toolStatus(item.status),
      };
    }
    case "dynamicToolCall":
      return {
        ...base,
        tool: "other",
        title: item.tool,
        detail: json(item.arguments),
        output: truncate(item.contentItems?.map((part) => part.text ?? "").join("\n")),
        status: toolStatus(item.status),
      };
    case "webSearch": {
      const url = item.action?.url;
      return {
        ...base,
        tool: "web",
        title: url
          ? `Open ${url}`
          : item.query
            ? `Search the web for "${item.query}"`
            : "Search the web",
        status: completed ? "done" : "running",
      };
    }
    case "collabAgentToolCall": {
      const action = AGENT_ACTIONS[item.tool] ?? "Use agents";
      const brief = item.prompt?.trim().split("\n")[0];
      return {
        ...base,
        tool: "agent",
        title:
          item.tool === "spawnAgent" && brief
            ? `${action}: ${brief.length > 60 ? `${brief.slice(0, 60)}…` : brief}`
            : action,
        detail: truncate(item.prompt),
        status: item.status === "interrupted" ? "failed" : toolStatus(item.status),
      };
    }
    case "subAgentActivity": {
      // Only "started" is a call; the others report on the child, which its own part shows.
      if (item.kind !== "started") return null;
      const name = item.agentPath.split("/").at(-1);
      return {
        ...base,
        tool: "agent",
        title: name ? `Spawn agent: ${name}` : "Spawn agent",
        status: completed ? "done" : "running",
      };
    }
    case "imageView":
      return {
        ...base,
        tool: "read",
        title: `View ${relative(item.path, cwd)}`,
        status: completed ? "done" : "running",
      };
    case "sleep":
      return {
        ...base,
        tool: "other",
        title: `Wait ${Math.max(1, Math.round(item.durationMs / 1000))}s`,
        status: completed ? "done" : "running",
      };
    case "imageGeneration": {
      const failed = item.failure !== null || item.status === "failed";
      return {
        ...base,
        tool: "other",
        title: "Generate an image",
        detail: truncate(item.revisedPrompt),
        output:
          item.failure?.type === "usageLimitExceeded"
            ? "Usage limit reached."
            : item.savedPath
              ? relative(item.savedPath, cwd)
              : null,
        status: failed ? "failed" : completed ? "done" : "running",
      };
    }
    case "functionCallOutput":
      return {
        ...base,
        tool: "other",
        title: item.namespace ? `${item.namespace} · ${item.name}` : item.name,
        output: truncate(
          typeof item.output === "string"
            ? item.output
            : item.output.map((part) => part.text ?? "").join("\n"),
        ),
        status: "done",
      };
    default:
      return null;
  }
}

/** Items shown elsewhere (messages, reasoning, plans) or internal (a hook's injected prompt). */
const NOT_TOOLS = new Set([
  "agentMessage",
  "userMessage",
  "reasoning",
  "plan",
  "hookPrompt",
  "subAgentActivity",
]);

/** First line of an agent error, capped, so it is short and safe to show. */
export function safeMessage(message: string | null | undefined): string {
  const line = message?.trim().split("\n")[0]?.trim();
  if (!line) return "Codex could not finish the reply.";
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

function runtimeError(error: unknown): ChatRuntimeError {
  if (error instanceof ChatRuntimeError) return error;
  if (error instanceof RpcClosedError) return new ChatRuntimeError("Codex stopped unexpectedly.");
  if (error instanceof RpcError) return new ChatRuntimeError(safeMessage(error.message));
  return new ChatRuntimeError("Codex did not respond.");
}

const missingThread = (error: unknown) =>
  error instanceof RpcError &&
  /no rollout found|thread not found|invalid session id/i.test(error.message);

interface ActiveTurn {
  readonly sink: TurnSink;
  readonly cwd: string;
  /** Its thread was given Rook's MCP server, so Rook's own tool calls need no prompt. */
  readonly rook: boolean;
  /** Its running commands and its subagents': item id to thread id. */
  readonly commands: Map<string, string>;
  id: string | null;
  /** The last non-retried `error` notification, for when the turn fails without one. */
  error: string | null;
  /** Its plan items' text so far, by item id. */
  readonly plans: Map<string, string>;
  /** Retries since Codex last made progress. */
  retries: number;
  /** Running commands' streamed output, by item id. */
  readonly outputs: Map<string, LiveOutput>;
  readonly finish: (error?: Error) => void;
}

interface LiveOutput {
  readonly update: ToolUpdate;
  readonly buffer: OutputBuffer;
  timer: NodeJS.Timeout | null;
}

/** A subagent thread. Its steps and final message fold into the agent part that started it. */
interface Subagent {
  /** The top-level turn: the subagent's approvals and part go to its sink. */
  readonly turn: ActiveTurn;
  /** Null while only its thread/started has named it. */
  part: ToolUpdate | null;
  nickname: string | null;
  /** One line per step, by item id. */
  readonly steps: Map<string, string>;
  reply: string | null;
  error: string | null;
  status: ToolStatus;
  /**
   * Its own transcript (SubagentEvent): "pending" until its part and prompt are known, holding
   * what it did meanwhile in `early`; "closed" once ended, or when another agent has the part.
   */
  transcript: "pending" | "open" | "closed";
  readonly early: SubagentEvent[];
  /** What it was asked; undefined until known. */
  prompt: string | null | undefined;
  model: string | null;
  /** Its agentMessage items that streamed as deltas, so their completed text is not repeated. */
  readonly streamed: Set<string>;
}

interface Loaded {
  readonly model: string;
  /** The MCP token the thread's config carries; the registry only knows its hash. */
  readonly token: string | null;
  readonly instructions: string | null;
}

interface Server {
  readonly peer: RpcPeer;
  /** Running turns by threadId. */
  readonly turns: Map<string, ActiveTurn>;
  /** Subagents of running turns, by their own threadId. */
  readonly agents: Map<string, Subagent>;
  /** Threads this process has started or resumed: their model, and what Rook gave them. */
  readonly loaded: Map<string, Loaded>;
  exited: boolean;
}

/** Step lines, then the final message in full; when the steps overflow, the oldest go. */
function agentOutput(steps: readonly string[], end: string | null): string | null {
  const tail = truncate(end);
  const room = MAX_DETAIL - (tail ? tail.length + 2 : 0);
  let lines = steps.join("\n");
  if (lines.length > room) {
    let start = steps.length;
    let used = 30; // The "earlier steps" line.
    while (start > 0 && used + steps[start - 1]!.length + 1 <= room)
      used += steps[--start]!.length + 1;
    lines = [`… ${start} earlier steps`, ...steps.slice(start)].join("\n");
  }
  return [lines, tail].filter(Boolean).join("\n\n") || null;
}

function showAgent(agent: Subagent): void {
  if (!agent.part) return;
  const end =
    agent.status === "running" ? "" : [agent.reply, agent.error].filter(Boolean).join("\n\n");
  agent.turn.sink.tool({
    ...agent.part,
    output: agentOutput([...agent.steps.values()], end),
    status: agent.status,
  });
}

/** Sends the subagent's own activity to its transcript, holding it until the transcript opens. */
function report(agent: Subagent, event: SubagentEvent): void {
  if (agent.transcript === "pending") {
    agent.early.push(event);
    // An agent that ends before its prompt is known opens without one.
    if (event.type === "ended") openTranscript(agent, true);
    return;
  }
  if (agent.transcript === "closed" || !agent.part) return;
  // shortcut: a finished subagent that is messaged again runs on in its part only; its
  // transcript has ended. Reopen it if that matters.
  if (event.type === "ended") agent.transcript = "closed";
  agent.turn.sink.subagent?.(agent.part.id, event);
}

/** Opens the transcript once the part and prompt are known (or `force`), then sends `early`. */
function openTranscript(agent: Subagent, force = false): void {
  if (agent.transcript !== "pending" || !agent.part || (agent.prompt === undefined && !force))
    return;
  agent.transcript = "open";
  agent.turn.sink.subagent?.(agent.part.id, {
    type: "started",
    title: agent.nickname ?? agent.part.title.replace(/^Spawn agent: /, ""),
    prompt: agent.prompt ?? null,
    model: agent.model,
  });
  for (const event of agent.early.splice(0)) report(agent, event);
}

const reportReasoning = (agent: Subagent, { delta }: { delta: string }) =>
  report(agent, { type: "reasoning", delta });

/** A plan item as a plan part; Codex only proposes it, so the user answers with a message. */
function showPlan(turn: ActiveTurn, id: string, text: string): void {
  turn.plans.set(id, text);
  if (text) turn.sink.part({ kind: "plan", id, text });
}

/** Codex is making progress again: its retry notice becomes "Reconnected". */
function recovered(turn: ActiveTurn): void {
  if (!turn.retries) return;
  turn.sink.part(recoveredNotice(turn.id ?? "", turn.retries));
  turn.retries = 0;
}

/** Routes app-server notifications and requests to the turn running on their thread. */
function listen(server: Server, nextApproval: () => number): void {
  /** The account's latest rate limits, for a usage-limit notice's reset time. */
  let limits: CodexRateLimits | null = null;
  /** Thread-less warnings that came while no turn ran; the next turn shows them. */
  const pending: Notice[] = [];
  const broadcast = (notice: Notice | null) => {
    if (!notice) return;
    if (!server.turns.size) return void (pending.length < 5 && pending.push(notice));
    for (const turn of server.turns.values()) turn.sink.part(notice);
  };
  // A subagent's thread only reaches `child`: its text and turn end are not the parent's.
  const route = <T>(
    method: string,
    handle: (turn: ActiveTurn, params: T) => void,
    child?: (agent: Subagent, params: T) => void,
  ) =>
    server.peer.onNotification(method, (params) => {
      const threadId = (params as { threadId: string }).threadId;
      const turn = server.turns.get(threadId);
      if (turn) return handle(turn, params as T);
      const agent = server.agents.get(threadId);
      if (agent) child?.(agent, params as T);
    });
  const register = (id: string, turn: ActiveTurn): Subagent => {
    const agent: Subagent = {
      turn,
      part: null,
      nickname: null,
      steps: new Map(),
      reply: null,
      error: null,
      status: "running",
      transcript: "pending",
      early: [],
      prompt: undefined,
      model: null,
      streamed: new Set(),
    };
    server.agents.set(id, agent);
    return agent;
  };
  /** Makes the threads a completed item started or ran subagents of `turn`, shown in its part. */
  const adopt = (turn: ActiveTurn, item: CodexItem, update: ToolUpdate): boolean => {
    const ids =
      item.type === "subAgentActivity" && item.kind === "started"
        ? [item.agentThreadId]
        : item.type === "collabAgentToolCall" && RUNS_AGENT.has(item.tool)
          ? item.receiverThreadIds
          : [];
    let adopted = false;
    for (const id of ids) {
      const agent = server.agents.get(id) ?? register(id, turn);
      if (agent.part) continue;
      agent.part = update;
      // One transcript per part: a call that ran several agents gives it to the first.
      if (adopted) agent.transcript = "closed";
      else if (item.type === "collabAgentToolCall") {
        agent.prompt = item.prompt ?? agent.prompt ?? null;
        agent.model = item.model ?? null;
      }
      // Multi-agent v2 calls carry no prompt: the transcript waits for the child's message.
      openTranscript(agent, agent.status !== "running");
      adopted = true;
      showAgent(agent);
    }
    return adopted;
  };
  type ItemParams = { readonly threadId: string; readonly item: CodexItem };
  /** Keeps `turn.commands` to the commands still running, so a stop can end them. */
  const track = (turn: ActiveTurn, { threadId, item }: ItemParams, completed: boolean) => {
    if (item.type !== "commandExecution") return;
    // In Ask mode item/started has no processId, so stopCommands finds the process by item id.
    if (completed) turn.commands.delete(item.id);
    else turn.commands.set(item.id, threadId);
  };
  const showItem = (completed: boolean) => (turn: ActiveTurn, params: ItemParams) => {
    track(turn, params, completed);
    recovered(turn);
    const { item } = params;
    if (item.type === "plan") return showPlan(turn, item.id, item.text);
    let update = codexToolUpdate(item, turn.cwd, completed);
    const notice = codexItemNotice(item, turn.id ?? "", completed);
    if (notice) turn.sink.part(notice);
    else if (!update && !NOT_TOOLS.has(item.type)) logUnknown("Codex", `item ${item.type}`);
    if (item.type === "commandExecution" && update) {
      const live = turn.outputs.get(item.id);
      if (completed) {
        if (live?.timer) clearTimeout(live.timer);
        turn.outputs.delete(item.id);
        // aggregatedOutput is the whole output; the stream is only a fallback without it.
        if (live?.buffer.text && update.output === null)
          update = { ...update, output: tailOutput(live.buffer.text, MAX_OUTPUT, live.buffer.cut) };
      } else if (!live)
        turn.outputs.set(item.id, { update, buffer: { text: "", cut: false }, timer: null });
    }
    if (update && !(completed && adopt(turn, item, update))) turn.sink.tool(update);
  };
  /** A subagent's item: a line in its part, its prompt, or (its last message) its final message. */
  const showStep = (completed: boolean) => (agent: Subagent, params: ItemParams) => {
    track(agent.turn, params, completed);
    const { item } = params;
    if (item.type === "agentMessage") {
      if (completed) agent.reply = item.text;
      if (completed && item.text && !agent.streamed.has(item.id))
        report(agent, { type: "text", delta: item.text });
      return;
    }
    if (item.type === "userMessage") {
      if (!completed) return;
      const text = item.content
        .map((part) => part.text)
        .filter(Boolean)
        .join("\n");
      if (agent.prompt === undefined) {
        agent.prompt = text || null;
        openTranscript(agent);
      }
      // Multi-agent v2 calls carry no prompt; the child's message is it.
      if (!agent.part || agent.part.detail) return;
      agent.part = { ...agent.part, detail: truncate(text) };
      return showAgent(agent);
    }
    const update = codexToolUpdate(item, agent.turn.cwd, completed);
    if (!update) return;
    const failed = update.status === "failed" || update.status === "declined";
    agent.steps.set(item.id, failed ? `${update.title} (${update.status})` : update.title);
    showAgent(agent);
    report(agent, { type: "tool", update });
    // Its own subagents report to the same turn, each in its own part.
    if (completed) adopt(agent.turn, item, update);
  };
  // The 0.162 Thread names its parent, so a subagent may be known before its spawn completes.
  server.peer.onNotification("thread/started", (params) => {
    const { thread } = params as {
      thread: { id: string; parentThreadId?: string | null; agentNickname?: string | null };
    };
    const parent = thread.parentThreadId;
    const turn = parent && (server.turns.get(parent) ?? server.agents.get(parent)?.turn);
    if (!turn) return;
    const agent = server.agents.get(thread.id) ?? register(thread.id, turn);
    agent.nickname = thread.agentNickname ?? null;
  });
  route<{ turn: CodexTurn }>(
    "turn/started",
    (turn, params) => {
      turn.id = params.turn.id;
      for (const notice of pending.splice(0)) turn.sink.part(notice);
    },
    // A message to a finished subagent runs it again.
    (agent) => {
      agent.status = "running";
      agent.error = null;
      showAgent(agent);
    },
  );
  route<{ delta: string; itemId: string }>(
    "item/agentMessage/delta",
    (turn, { delta }) => {
      recovered(turn);
      turn.sink.text(delta);
    },
    (agent, { delta, itemId }) => {
      agent.streamed.add(itemId);
      report(agent, { type: "text", delta });
    },
  );
  route<{ delta: string }>(
    "item/reasoning/summaryTextDelta",
    (turn, { delta }) => turn.sink.reasoning(delta),
    reportReasoning,
  );
  route<{ delta: string }>(
    "item/reasoning/textDelta",
    (turn, { delta }) => turn.sink.reasoning(delta),
    reportReasoning,
  );
  route<{ summaryIndex: number }>(
    "item/reasoning/summaryPartAdded",
    (turn, params) => {
      if (params.summaryIndex > 0) turn.sink.reasoning("\n\n");
    },
    (agent, params) => {
      if (params.summaryIndex > 0) reportReasoning(agent, { delta: "\n\n" });
    },
  );
  route<{ itemId: string; delta: string }>("item/plan/delta", (turn, { itemId, delta }) =>
    showPlan(turn, itemId, (turn.plans.get(itemId) ?? "") + delta),
  );
  route<{ turnId: string; plan: readonly { step: string; status: string }[] }>(
    "turn/plan/updated",
    (turn, params) =>
      turn.sink.part({
        kind: "todo",
        id: `${params.turnId}-todo`,
        items: codexTodoItems(params.plan),
      }),
  );
  route("item/started", showItem(false), showStep(false));
  route("item/completed", showItem(true), showStep(true));
  route<{ delta: string; itemId: string }>("item/commandExecution/outputDelta", (turn, params) => {
    const live = turn.outputs.get(params.itemId);
    if (!live) return;
    appendOutput(live.buffer, params.delta);
    live.timer ??= setTimeout(() => {
      live.timer = null;
      const { text, cut } = live.buffer;
      turn.sink.tool({ ...live.update, output: tailOutput(text, MAX_OUTPUT, cut) });
    }, OUTPUT_MS);
  });
  route<{ toModel: string }>("model/rerouted", (turn, params) => {
    turn.sink.model(params.toModel);
    const notice = codexReroutedNotice(params);
    if (notice) turn.sink.part(notice);
  });
  route<{ turnId: string }>("thread/compacted", (turn, params) =>
    turn.sink.part(compactionNotice(params.turnId, true)),
  );
  route<Record<string, unknown>>("guardianWarning", (turn, params) => {
    const notice = codexWarningNotice("guardianWarning", params);
    if (notice) turn.sink.part(notice);
  });
  // `warning` names its thread when it has one; configWarning and deprecationNotice never do.
  server.peer.onNotification("warning", (raw) => {
    const params = raw as { threadId: string | null };
    const notice = codexWarningNotice("warning", params);
    if (!params.threadId) return broadcast(notice);
    const turn = server.turns.get(params.threadId) ?? server.agents.get(params.threadId)?.turn;
    if (turn && notice) turn.sink.part(notice);
  });
  for (const method of ["configWarning", "deprecationNotice"])
    server.peer.onNotification(method, (raw) =>
      broadcast(codexWarningNotice(method, raw as Record<string, unknown>)),
    );
  server.peer.onNotification("account/rateLimits/updated", (raw) => {
    // Updates are sparse: a missing window keeps what was seen before.
    const next = (raw as { rateLimits: CodexRateLimits }).rateLimits;
    limits = {
      ...limits,
      ...Object.fromEntries(Object.entries(next).filter(([, value]) => value != null)),
    } as CodexRateLimits;
  });
  route<{
    tokenUsage: { last: { totalTokens: number }; modelContextWindow: number | null };
  }>("thread/tokenUsage/updated", (turn, { tokenUsage }) => {
    const window = tokenUsage.modelContextWindow;
    if (window && window > 0) turn.sink.context({ used: tokenUsage.last.totalTokens, window });
  });
  route<{
    error: { message: string; codexErrorInfo?: unknown; additionalDetails?: string | null };
    willRetry: boolean;
    turnId: string;
  }>(
    "error",
    (turn, params) => {
      // An error can come before turn/started; the retry notice and its recovery share this id.
      turn.id ??= params.turnId;
      if (!params.willRetry && turn.id === params.turnId) turn.error = params.error.message;
      // A rate limit has its own notice; only other retries count toward "Reconnected".
      if (params.willRetry && !isLimit(params.error.codexErrorInfo)) turn.retries++;
      const notice = codexErrorNotice(
        params.error,
        params.willRetry,
        params.turnId,
        turn.retries,
        limits,
      );
      if (notice) turn.sink.part(notice);
    },
    (agent, params) => {
      if (!params.willRetry) agent.error = params.error.message;
    },
  );
  route<{ turn: CodexTurn }>(
    "turn/completed",
    (turn, params) => {
      if (turn.retries) {
        const done = params.turn.status === "failed" ? gaveUpNotice : recoveredNotice;
        turn.sink.part(done(turn.id ?? params.turn.id, turn.retries));
        turn.retries = 0;
      }
      if (params.turn.status !== "failed") return turn.finish();
      turn.finish(new ChatRuntimeError(safeMessage(params.turn.error?.message ?? turn.error)));
    },
    (agent, params) => {
      agent.status = params.turn.status === "completed" ? "done" : "failed";
      agent.error =
        params.turn.status === "failed"
          ? safeMessage(params.turn.error?.message ?? agent.error)
          : null;
      showAgent(agent);
      const { status } = params.turn;
      report(agent, {
        type: "ended",
        status: status === "completed" || status === "failed" ? status : "cancelled",
        error: agent.error,
      });
    },
  );

  type ApprovalParams = {
    readonly threadId: string;
    readonly turnId?: string;
    readonly itemId: string;
    readonly approvalId?: string | null;
    readonly command?: string | null;
    readonly commandActions?: readonly { readonly command: string }[] | null;
    readonly reason?: string | null;
    readonly availableDecisions?: readonly unknown[] | null;
    readonly networkApprovalContext?: { readonly host: string } | null;
    readonly grantRoot?: string | null;
  };
  const turnOf = (threadId: string) =>
    server.turns.get(threadId) ?? server.agents.get(threadId)?.turn;
  /** Asks the user on the turn running `threadId`; null when no turn runs there. */
  const ask = async (threadId: string, request: Omit<ApprovalRequest, "id">, id: string) => {
    const agent = server.agents.get(threadId);
    const turn = turnOf(threadId);
    if (!turn) return null;
    return turn.sink.approve({
      id,
      ...request,
      title: agent ? `${agent.nickname ?? "Subagent"} · ${request.title}` : request.title,
      // Null while only its thread/started has named it.
      ...(agent?.part && { subagent: agent.part.id }),
    });
  };
  /**
   * A v2 decline has no message, so the user's feedback follows as a steer, once Codex has the
   * decline (a later macrotask than the response).
   */
  const steerFeedback = (
    params: { readonly threadId: string; readonly turnId?: string | null },
    feedback: string | null,
  ) => {
    if (!feedback || !params.turnId) return;
    const input = codexInput({
      prompt: `The user declined that. Their instruction: ${feedback}`,
      images: [],
    });
    setImmediate(() => {
      server.peer
        .request(
          "turn/steer",
          { threadId: params.threadId, expectedTurnId: params.turnId, input },
          60_000,
        )
        .catch(() => undefined);
    });
  };
  const askV2 = async (params: ApprovalParams, request: Omit<ApprovalRequest, "id">) => {
    const answer = await ask(
      params.threadId,
      {
        ...request,
        toolId: params.itemId,
        // A folder-wide write grant is always spelled out, whatever reason the agent gives.
        reason:
          [params.reason, grantText(params.grantRoot)].filter(Boolean).join(" ") ||
          request.reason ||
          null,
      },
      `${params.itemId}:${params.approvalId ?? nextApproval()}`,
    );
    if (!answer) return { decision: "decline" };
    if (answer.decision === "deny") steerFeedback(params, answer.feedback);
    return { decision: codexDecision(answer.decision) };
  };
  server.peer.onRequest("item/commandExecution/requestApproval", (raw) => {
    const params = raw as ApprovalParams;
    const command = params.command
      ? commandTitle(params.command, params.commandActions)
      : "a command";
    const host = params.networkApprovalContext?.host;
    return askV2(params, {
      tool: host ? "network" : "command",
      title: `Run \`${command.length > 120 ? `${command.slice(0, 120)}…` : command}\`?`,
      detail: truncate(params.command),
      reason: host ? `It needs network access to ${host}.` : null,
      options: codexOptions(params.availableDecisions),
    });
  });
  server.peer.onRequest("item/fileChange/requestApproval", (raw) => {
    const params = raw as ApprovalParams;
    return askV2(params, {
      tool: "edit",
      title: "Apply file changes?",
      detail: null,
      reason: null,
      options: ["allow", "allowSession", "deny"],
    });
  });
  server.peer.onRequest("item/permissions/requestApproval", async (raw) => {
    const params = raw as ApprovalParams & { readonly permissions: unknown };
    const answer = await ask(
      params.threadId,
      {
        tool: "permissions",
        title: "Grant more permissions for this turn?",
        detail: permissionsText(params.permissions),
        reason: params.reason ?? null,
        toolId: params.itemId,
        options: ["allow", "deny"],
      },
      `${params.itemId}:${nextApproval()}`,
    );
    if (answer?.decision === "deny") steerFeedback(params, answer.feedback);
    return permissionsResponse(params.permissions, answer?.decision ?? "deny");
  });

  // Legacy requests, from older app-servers: their denial carries the user's feedback.
  type LegacyParams = {
    readonly conversationId: string;
    readonly callId: string;
    readonly approvalId?: string | null;
    readonly reason: string | null;
    readonly grantRoot?: string | null;
  };
  const askLegacy = async (params: LegacyParams, request: Omit<ApprovalRequest, "id">) => {
    const answer = await ask(
      params.conversationId,
      {
        ...request,
        toolId: params.callId,
        reason: [params.reason, grantText(params.grantRoot)].filter(Boolean).join(" ") || null,
      },
      `${params.callId}:${params.approvalId ?? nextApproval()}`,
    );
    return legacyDecision(answer ?? { decision: "deny", feedback: null });
  };
  server.peer.onRequest("execCommandApproval", (raw) => {
    const params = raw as LegacyParams & { readonly command: readonly string[] };
    const command = commandTitle(legacyCommand(params.command ?? []));
    return askLegacy(params, {
      tool: "command",
      title: `Run \`${command.length > 120 ? `${command.slice(0, 120)}…` : command}\`?`,
      detail: truncate(command),
      options: ["allow", "allowSession", "deny"],
    });
  });
  server.peer.onRequest("applyPatchApproval", (raw) => {
    const params = raw as LegacyParams & { readonly fileChanges: unknown };
    return askLegacy(params, {
      tool: "edit",
      title: "Apply file changes?",
      detail: patchText(params.fileChanges),
      options: ["allow", "allowSession", "deny"],
    });
  });
  server.peer.onRequest("item/tool/requestUserInput", async (raw) => {
    const params = raw as { threadId: string; itemId: string } & Record<string, unknown>;
    const questions = codexQuestions(params);
    const agent = server.agents.get(params.threadId);
    const turn = server.turns.get(params.threadId) ?? agent?.turn;
    const declined = { declined: true as const, feedback: null };
    // Rook has no masked input and would save the answer in the transcript: secrets stay out of chat.
    const secret = (params.questions as { isSecret?: unknown }[] | undefined)?.some(
      (question) => question?.isSecret === true,
    );
    const reply = secret
      ? {
          declined: true as const,
          feedback: "Rook can't take secret answers in chat. Ask the user to enter it themselves.",
        }
      : turn && questions.length
        ? await turn.sink
            .ask({
              id: `${params.itemId}:${nextApproval()}`,
              questions,
              ...(agent?.part && { subagent: agent.part.id }),
            })
            .catch(() => declined)
        : declined;
    return codexAnswers(questions, reply);
  });
  // Codex asks before an MCP tool call; Rook's own server checks the chat's token and scope itself.
  server.peer.onRequest("mcpServer/elicitation/request", async (raw) => {
    const params = raw as {
      threadId: string;
      serverName: string;
      mode: string;
      message?: string;
      url?: string;
      requestedSchema?: unknown;
      turnId?: string;
      _meta?: { codex_approval_kind?: unknown } | null;
    };
    const turn = server.turns.get(params.threadId) ?? server.agents.get(params.threadId)?.turn;
    const accept =
      turn?.rook === true &&
      params.serverName === "rook" &&
      params.mode === "form" &&
      params["_meta"]?.codex_approval_kind === "mcp_tool_call";
    if (accept) return { action: "accept", content: {}, _meta: null };
    const declined = { action: "decline", content: null, _meta: null };
    const elicitation: Elicitation = {
      server: params.serverName,
      mode: params.mode,
      message: params.message ?? "",
      url: params.url ?? null,
      schema: params.requestedSchema,
      meta: params["_meta"],
    };
    const request = elicitationApproval(elicitation);
    if (!request) {
      turn?.sink.part({
        kind: "notice",
        id: `elicitation:${nextApproval()}`,
        ...elicitationNotice(elicitation),
      });
      return declined;
    }
    const answer = await ask(params.threadId, request, `elicitation:${nextApproval()}`);
    if (answer?.decision === "deny") steerFeedback(params, answer.feedback);
    return { ...declined, ...elicitationResponse(elicitation, answer?.decision ?? "deny") };
  });
}

/**
 * Ends the commands a stopped turn left running: Codex 0.162.1 interrupts the turn but not its
 * commands. Only background terminals whose item is in `commands` (item id to thread id).
 */
async function stopCommands(peer: RpcPeer, commands: ReadonlyMap<string, string>): Promise<void> {
  type Page = { data: { itemId: string; processId: string }[]; nextCursor: string | null };
  const threads = new Set(commands.values());
  await Promise.all(
    [...threads].map(async (threadId) => {
      let cursor: string | null = null;
      do {
        // oxlint-disable-next-line no-await-in-loop -- each page needs the previous cursor
        const page: Page = await peer.request(
          "thread/backgroundTerminals/list",
          { threadId, cursor },
          INTERRUPT_MS,
        );
        for (const terminal of page.data)
          if (commands.get(terminal.itemId) === threadId)
            void peer
              .request(
                "thread/backgroundTerminals/terminate",
                { threadId, processId: terminal.processId },
                INTERRUPT_MS,
              )
              .catch(() => undefined);
        cursor = page.nextCursor;
      } while (cursor);
    }),
  ).catch(() => undefined);
}

export function codexRuntime(host: AgentHost): ChatRuntime {
  let current: Promise<Server> | null = null;
  let idle: NodeJS.Timeout | null = null;
  let models: Promise<CodexModel[]> | null = null;
  let approvals = 0;
  /** Catalog reads and turns using the shared process right now. */
  let users = 0;
  /** Running turns by chatId, for steering. */
  const chats = new Map<string, { peer: RpcPeer; threadId: string; turn: ActiveTurn }>();
  /** Threads whose last turn ran in plan mode, so the next one is sent back to default. */
  const planThreads = new Set<string>();

  async function start(): Promise<Server> {
    const file = resolveCommand("codex", host.env);
    if (!file) throw new ChatRuntimeError("Codex is not installed.");
    const child = spawnCommand(file, ["app-server"], {
      env: { ...host.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Rook" },
    });
    const server: Server = {
      peer: new RpcPeer(child, { jsonrpc: false }),
      turns: new Map(),
      agents: new Map(),
      loaded: new Map(),
      exited: false,
    };
    listen(server, () => ++approvals);
    void server.peer.closed.then(() => {
      server.exited = true;
      const error = new ChatRuntimeError("Codex stopped unexpectedly.");
      for (const turn of server.turns.values()) turn.finish(error);
    });
    try {
      await server.peer.request(
        "initialize",
        {
          clientInfo: { name: "rook", title: "Rook", version: "1" },
          capabilities: { experimentalApi: true },
        },
        30_000,
      );
    } catch {
      server.peer.close();
      throw new ChatRuntimeError("Codex could not start.");
    }
    server.peer.notify("initialized");
    return server;
  }

  /** The shared app-server, started on first use and again after it exits. */
  async function acquire(): Promise<Server> {
    if (idle) clearTimeout(idle);
    idle = null;
    const pending = (current ??= start());
    try {
      const shared = await pending;
      if (!shared.exited) {
        users++;
        return shared;
      }
    } catch (error) {
      if (current === pending) current = null;
      throw error;
    }
    if (current === pending) current = null;
    return acquire();
  }

  /** Closes the app-server once nothing has used it for a while. */
  function release(shared: Server): void {
    if (--users > 0) return;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      if (users === 0) shared.peer.close();
    }, IDLE_MS);
    idle.unref();
  }

  async function listModels(shared: Server, signal: AbortSignal): Promise<CodexModel[]> {
    const all: CodexModel[] = [];
    let cursor: string | null = null;
    do {
      signal.throwIfAborted();
      // oxlint-disable-next-line no-await-in-loop -- each page needs the previous cursor
      const page: { data: CodexModel[]; nextCursor: string | null } = await shared.peer.request(
        "model/list",
        { cursor, includeHidden: false },
        30_000,
      );
      all.push(...page.data.filter((model) => !model.hidden));
      cursor = page.nextCursor;
    } while (cursor);
    return all;
  }

  /** The model's fast tier id from the catalog (read once if no catalog is cached). */
  async function fastTierFor(shared: Server, model: string | null): Promise<string | null> {
    models ??= listModels(shared, AbortSignal.timeout(30_000));
    const list = await models.catch(() => {
      models = null;
      return [];
    });
    const found = list.find((candidate) => (model ? candidate.id === model : candidate.isDefault));
    return found ? fastTier(found) : null;
  }

  /** The thread for this turn; `fresh` when it was just started and so has no earlier context. */
  async function openThread(
    shared: Server,
    input: TurnInput,
    sink: TurnSink,
  ): Promise<{ threadId: string; fresh: boolean }> {
    const access = codexAccess(input.settings.access, input.cwd);
    const settings = {
      model: input.settings.model,
      cwd: input.cwd,
      approvalPolicy: access.approvalPolicy,
      sandbox: access.sandbox,
      approvalsReviewer: access.approvalsReviewer,
    };
    const id = input.sessionId;
    const { mcp = null, instructions = null } = input;
    const loaded = id ? shared.loaded.get(id) : undefined;
    // A loaded thread keeps its config until its token dies or Rook's setup for it changes.
    if (
      id &&
      loaded &&
      loaded.instructions === instructions &&
      (mcp ? loaded.token !== null && mcp.live(loaded.token) : loaded.token === null)
    )
      return { threadId: id, fresh: false };
    if (id && loaded) {
      // Resuming a loaded thread only rejoins it (0.162.1 keeps its old config); unloading it
      // first makes the resume below load it again with the new config.
      shared.loaded.delete(id);
      await shared.peer
        .request("thread/unsubscribe", { threadId: id }, 60_000)
        .catch(() => undefined);
    }
    // credential() revokes the chat's previous token, so it runs once per start or resume.
    const token = mcp?.credential() ?? null;
    const extra = {
      config: {
        // Turns report their task list through turn/plan/updated.
        "tools.update_plan.enabled": true,
        ...(mcp && token
          ? {
              "mcp_servers.rook": {
                url: mcp.url,
                tool_timeout_sec: 300,
                http_headers: { Authorization: `Bearer ${token}` },
              },
            }
          : {}),
      },
      ...(instructions ? { developerInstructions: instructions } : {}),
    };
    const remember = (threadId: string, model: string) =>
      shared.loaded.set(threadId, { model, token, instructions });
    if (id) {
      try {
        const resumed = await shared.peer.request<ThreadResponse>(
          "thread/resume",
          { threadId: id, ...settings, ...extra, excludeTurns: true },
          60_000,
        );
        remember(id, resumed.model);
        return { threadId: id, fresh: false };
      } catch (error) {
        if (!missingThread(error)) throw error;
        console.warn(`Codex thread ${id} is gone; starting a new one with the chat history.`);
      }
    }
    const started = await shared.peer.request<ThreadResponse>(
      "thread/start",
      { ...settings, ...extra },
      60_000,
    );
    remember(started.thread.id, started.model);
    sink.session(started.thread.id);
    return { threadId: started.thread.id, fresh: true };
  }

  async function runTurn(
    shared: Server,
    input: TurnInput,
    sink: TurnSink,
    signal: AbortSignal,
  ): Promise<void> {
    const { threadId, fresh } = await openThread(shared, input, sink);
    if (signal.aborted) return;
    const { settings } = input;
    const model = settings.model ?? shared.loaded.get(threadId)?.model;
    if (model) sink.model(model);
    // "default" also clears a fast tier an earlier turn or the user's config chose.
    const tier = (settings.fast && (await fastTierFor(shared, settings.model))) || "default";
    const access = codexAccess(settings.access, input.cwd);

    let finish!: (error?: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      finish = (error) => (error ? reject(error) : resolve());
    });
    const turn: ActiveTurn = {
      sink,
      cwd: input.cwd,
      rook: Boolean(input.mcp),
      commands: new Map(),
      id: null,
      error: null,
      plans: new Map(),
      retries: 0,
      outputs: new Map(),
      finish,
    };
    let interrupted = false;
    const interrupt = () => {
      if (interrupted || !turn.id) return;
      interrupted = true;
      void shared.peer
        .request("turn/interrupt", { threadId, turnId: turn.id }, INTERRUPT_MS)
        .catch(() => undefined)
        .then(() => stopCommands(shared.peer, new Map(turn.commands)));
    };
    const onAbort = () => {
      // A stopped turn resolves even if Codex never confirms; the shared process stays up.
      setTimeout(() => finish(), INTERRUPT_MS).unref();
      interrupt();
    };
    shared.turns.set(threadId, turn);
    chats.set(input.chatId, { peer: shared.peer, threadId, turn });
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await shared.peer.request<{ turn: CodexTurn }>(
        "turn/start",
        {
          threadId,
          // A new thread starts empty: hand it the earlier conversation.
          input: codexInput({
            prompt: fresh && input.history ? input.history + input.prompt : input.prompt,
            images: input.images,
          }),
          model: settings.model,
          effort: settings.effort,
          summary: "detailed",
          approvalPolicy: access.approvalPolicy,
          sandboxPolicy: access.sandboxPolicy,
          approvalsReviewer: access.approvalsReviewer,
          serviceTierForTurn: tier,
          // Only in plan mode, and on the turn that leaves it: a collaboration mode takes precedence
          // over the thread's own settings, so ordinary turns keep them. Null instructions keep the
          // mode's built-in ones; Rook's own stay on the thread (developerInstructions).
          ...(model &&
            (settings.plan || planThreads.has(threadId)) && {
              collaborationMode: {
                mode: settings.plan ? "plan" : "default",
                settings: {
                  model,
                  reasoning_effort: settings.effort,
                  developer_instructions: null,
                },
              },
            }),
        },
        60_000,
      );
      if (settings.plan) planThreads.add(threadId);
      else planThreads.delete(threadId);
      turn.id ??= response.turn.id;
      if (signal.aborted) interrupt();
      await done;
    } finally {
      signal.removeEventListener("abort", onAbort);
      for (const live of turn.outputs.values()) if (live.timer) clearTimeout(live.timer);
      if (shared.turns.get(threadId) === turn) shared.turns.delete(threadId);
      if (chats.get(input.chatId)?.turn === turn) chats.delete(input.chatId);
      for (const [id, agent] of shared.agents) {
        if (agent.turn !== turn) continue;
        // Rook stops listening: one still running is never heard from again.
        report(agent, { type: "ended", status: "cancelled", error: null });
        shared.agents.delete(id);
      }
    }
  }

  return {
    agentId: "codex",
    accessModes: ACCESS_MODES,

    async catalog(signal): Promise<Omit<AgentCatalog, "steering">> {
      const shared = await acquire();
      try {
        models = listModels(shared, signal);
        return {
          agentId: "codex",
          models: markLegacy((await models).map(codexModelOption)),
          accessModes: ACCESS_MODES,
          error: null,
        };
      } catch (error) {
        models = null;
        if (error instanceof RpcError && error.code === -32601)
          throw new ChatRuntimeError("Update Codex to chat with it in Rook.");
        if (error instanceof RpcError && /auth|log ?in|sign ?in/i.test(error.message))
          throw new ChatRuntimeError("Sign in to Codex to chat with it in Rook.");
        throw new ChatRuntimeError("Could not read Codex's models.");
      } finally {
        release(shared);
      }
    },

    async run(input, sink, signal) {
      if (signal.aborted) return;
      const shared = await acquire();
      try {
        await runTurn(shared, input, sink, signal);
      } catch (error) {
        // Once the user stops, whatever ends the turn counts as stopped.
        if (!signal.aborted) throw runtimeError(error);
      } finally {
        release(shared);
      }
    },

    async steer(chatId, input) {
      const running = chats.get(chatId);
      if (!running?.turn.id) return false;
      try {
        // The input joins the running turn; its events keep flowing to the same sink.
        await running.peer.request(
          "turn/steer",
          { threadId: running.threadId, expectedTurnId: running.turn.id, input: codexInput(input) },
          60_000,
        );
        return true;
      } catch (error) {
        // Rejected (the turn ended or cannot be steered) or closed: the caller queues it instead.
        if (error instanceof RpcError || error instanceof RpcClosedError) return false;
        throw runtimeError(error);
      }
    },

    dispose() {
      if (idle) clearTimeout(idle);
      idle = null;
      void current?.then((shared) => shared.peer.close()).catch(() => undefined);
      current = null;
    },
  };
}
