// Delegation: the tools Rook's MCP server gives a chat's agent to hand work to separate agent
// chats (task chats), and the guidance that tells agents how to use them. A task chat is a child
// of the chat whose agent started it; its result goes back to that parent as a message from Rook.
import { randomUUID } from "node:crypto";

import type {
  AccessMode,
  ChatAgentId,
  ChatMessage,
  ChatSettings,
  MessagePart,
  TaskResult,
  TaskStatus,
  ToolStatus,
} from "@rook/contracts";

import type { gitClient } from "./git.ts";
import type { McpServer, McpTool, McpToolResult, McpTools } from "./mcp.ts";
import { ChatRuntimeError } from "./runtime.ts";
import { chatTitle, isSubagent, type ChatHooks, type ChatService } from "./service.ts";
import type { ChatRecord, ChatStore, TaskRecord } from "./store.ts";

/** Chats at this depth (task chats) get no delegation tools. */
export const MAX_DEPTH = 1;
export const MAX_RUNNING_CHILDREN = 4;
export const TASK_TIMEOUT_MS = 60 * 60_000;
export const TOKEN_IDLE_MS = 24 * 60 * 60_000;
export const TOKEN_MAX_MS = 7 * 24 * 60 * 60_000;
/** Sibling results finishing this close together reach the parent in one turn. */
export const DELIVERY_COALESCE_MS = 2_000;
export const RESULT_TASK_BYTES = 4_000;
export const RESULT_TOTAL_BYTES = 16_000;

const CARD_DETAIL_CHARS = 4_000;
const SUMMARY_CHARS = 4_000;
const INTERRUPTED = "Rook closed while this task was running.";

/** Why a task is being cancelled: its parent (task_cancel, deletion), the user, or its deadline. */
export type CancelReason = "parent" | "user" | "timeout";

const bytes = (text: string) => Buffer.byteLength(text);

/** `text` cut to at most `max` UTF-8 bytes, never inside a character. */
function cutBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  const cut = Buffer.from(text)
    .subarray(0, Math.max(0, max - 3))
    .toString("utf8");
  return `${cut.replace(/�$/, "")}…`;
}

/**
 * The prompt that hands finished tasks to the parent's agent: each task at most
 * RESULT_TASK_BYTES, the whole at most RESULT_TOTAL_BYTES. `running` titles the parent's tasks
 * still running.
 */
export function taskResultsPrompt(
  results: readonly TaskResult[],
  running: readonly string[],
): string {
  const head = "<rook_task_results>\nTasks you delegated have finished:";
  const tail = `${
    running.length
      ? `\nStill running: ${running.join(", ")}; their results arrive automatically.`
      : ""
  }\n</rook_task_results>`;
  let room = RESULT_TOTAL_BYTES - bytes(head) - bytes(tail) - 100; // 100: the omitted line
  const blocks: string[] = [];
  for (const [index, r] of results.entries()) {
    if (room < 200) {
      const left = results.slice(index).map((o) => o.title);
      blocks.push(cutBytes(`\n(Open their chats; too long to show here: ${left.join(", ")})`, 100));
      break;
    }
    const block = cutBytes(
      [
        `\n## ${r.title} (task ${r.taskId}): ${r.status}`,
        r.error && `Error: ${r.error}`,
        r.filesChanged.length && `Files changed: ${r.filesChanged.join(", ")}`,
        r.summary && `Summary:\n${r.summary}`,
      ]
        .filter(Boolean)
        .join("\n"),
      Math.min(RESULT_TASK_BYTES, room),
    );
    blocks.push(block);
    room -= bytes(block) + 1;
  }
  return cutBytes(`${head}\n${blocks.join("\n")}${tail}`, RESULT_TOTAL_BYTES);
}

/** A finished reply's summary: its text after its last non-text part, else all of its text. */
export function summaryOf(reply: ChatMessage | undefined): string | null {
  const parts = reply?.parts ?? [];
  // Rook's own `changes` part ends a reply; it doesn't divide the agent's text.
  const last = parts.findLastIndex((p) => p.kind !== "text" && p.kind !== "changes");
  const text = (from: number) =>
    parts
      .slice(from)
      .map((p) => (p.kind === "text" ? p.text : ""))
      .join("")
      .trim();
  const summary = text(last + 1) || text(0);
  return summary ? truncate(summary, SUMMARY_CHARS - 1) : null;
}

export const PARENT_GUIDANCE = `## Rook delegation
\`delegate_task\` (server "rook"; in Claude Code load it with ToolSearch \`select:mcp__rook__delegate_task,mcp__rook__task_status,mcp__rook__task_cancel\`) hands independent work to a separate agent chat, optionally in its own worktree. Use it for parallel or long work, another agent or model, or an isolated checkout. Don't use it for small edits or for work you need before your next step; use your native subagents for quick lookups inside this turn. The child sees only \`task\`. Results arrive later as a message from Rook. Do not poll with task_status, sleep or wait loops; end your turn when you have nothing else to do. Cancel tasks you no longer need. At most ${MAX_RUNNING_CHILDREN} run at once.`;

export const CHILD_GUIDANCE = `You are a delegated task started by another agent. Do the work yourself. Nobody answers questions mid-task, so make reasonable assumptions and state them. End with a short summary of what you did, the files you changed, and what remains.`;

/** Rook's system instructions for a chat's agent: task guidance first, then delegation. */
export function instructionsFor(chat: Pick<ChatRecord, "depth" | "task">): string | null {
  const parts = [chat.task && CHILD_GUIDANCE, chat.depth < MAX_DEPTH && PARENT_GUIDANCE];
  return parts.filter(Boolean).join("\n\n") || null;
}

interface Field {
  readonly type: "string" | "boolean";
  readonly enum?: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly description?: string;
}

interface InputSchema {
  readonly type: "object";
  readonly additionalProperties: false;
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, Field>>;
}

const TOOLS = [
  {
    name: "delegate_task",
    description:
      "Start a separate Rook agent chat on a self-contained task. Returns at once; its result arrives later as a message from Rook. Never poll.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["task"],
      properties: {
        task: {
          type: "string",
          minLength: 1,
          maxLength: 100_000,
          description:
            "Everything the child needs: paths, constraints, how to check. It never sees this conversation.",
        },
        title: { type: "string", maxLength: 80 },
        agent: { type: "string", enum: ["claude", "codex"], description: "Defaults to yours." },
        model: { type: "string", maxLength: 200 },
        access: {
          type: "string",
          enum: ["ask", "edit", "auto", "full"],
          description: "Defaults to yours; never broader.",
        },
        worktree: {
          type: "boolean",
          description: "Own git worktree and branch from your folder's HEAD.",
        },
        clientRequestId: {
          type: "string",
          maxLength: 100,
          description: "Same value on a retry returns the same task.",
        },
      },
    },
  },
  {
    name: "task_status",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["taskId"],
      properties: { taskId: { type: "string" } },
    },
  },
  {
    name: "task_cancel",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["taskId"],
      properties: { taskId: { type: "string" }, reason: { type: "string", maxLength: 500 } },
    },
  },
] as const satisfies readonly (McpTool & { inputSchema: InputSchema })[];

/** Checks tool arguments against the tool's schema. Returns what is wrong, or null. */
function invalid(schema: InputSchema, args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args))
    return "Arguments must be an object.";
  for (const key of schema.required) if (!(key in args)) return `${key} is required.`;
  for (const [key, value] of Object.entries(args)) {
    const field = schema.properties[key];
    if (!field) return `Unknown argument ${key}.`;
    if (typeof value !== field.type) return `${key} must be a ${field.type}.`;
    if (typeof value !== "string") continue;
    if (field.enum && !field.enum.includes(value))
      return `${key} must be one of ${field.enum.join(", ")}.`;
    if (value.length < (field.minLength ?? 0) || value.length > (field.maxLength ?? Infinity))
      return `${key} must be ${field.minLength ?? 0} to ${field.maxLength ?? "any number of"} characters.`;
  }
  return null;
}

interface DelegateInput {
  readonly task: string;
  readonly title?: string;
  readonly agent?: ChatAgentId;
  readonly model?: string;
  readonly access?: AccessMode;
  readonly worktree?: boolean;
  readonly clientRequestId?: string;
}

export type TaskErrorCode =
  | "invalid_request"
  | "not_allowed"
  | "parent_not_active"
  | "limit_reached"
  | "access_escalation"
  | "task_not_found"
  | "agent_unavailable"
  | "worktree_failed";

class TaskError extends Error {
  readonly code: TaskErrorCode;
  constructor(code: TaskErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** What every tool returns about a task. */
export interface TaskView {
  readonly taskId: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly summary: string | null;
  readonly filesChanged: readonly string[];
  readonly error: string | null;
  readonly agent: ChatAgentId;
  readonly model: string | null;
  readonly access: AccessMode;
  /** The task has its own worktree. */
  readonly worktree: boolean;
  /** The parent's tasks running now. */
  readonly runningTasks: number;
}

const RANK: Readonly<Record<AccessMode, number>> = { ask: 0, edit: 1, auto: 2, full: 3 };

const CARD_STATUS: Readonly<Record<TaskStatus, ToolStatus>> = {
  running: "running",
  completed: "done",
  cancelled: "declined",
  failed: "failed",
  timedOut: "failed",
  interrupted: "failed",
};

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const textOf = (message: ChatMessage | undefined) =>
  message?.parts.map((p) => (p.kind === "text" ? p.text : "")).join("") ?? "";

export interface DelegationOptions {
  readonly service: ChatService;
  readonly store: ChatStore;
  readonly git: ReturnType<typeof gitClient>;
  readonly log?: (message: string, error?: unknown) => void;
  /** Test seams: TASK_TIMEOUT_MS and DELIVERY_COALESCE_MS. */
  readonly timeoutMs?: number | undefined;
  readonly coalesceMs?: number | undefined;
}

export class Delegation implements McpTools, ChatHooks {
  /** Set once the MCP server listens; chats get no MCP access until then. */
  server: McpServer | null = null;
  /** delegate_task calls still creating their task, by parent id + "\n" + request id. */
  private readonly pending = new Map<string, Promise<McpToolResult>>();
  /** Why each task being cancelled is, by child chat id. */
  private readonly cancelling = new Map<string, CancelReason>();
  /** Tasks being finalized, so a turn's end and a cancel never finalize one twice. */
  private readonly finalizing = new Map<string, Promise<void>>();
  /** Each running task's deadline timer. */
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly options: DelegationOptions;

  constructor(options: DelegationOptions) {
    this.options = options;
  }

  private log(message: string, error: unknown) {
    (this.options.log ?? console.error)(`[tasks] ${message}`, error);
  }

  private get store() {
    return this.options.store;
  }

  private get service() {
    return this.options.service;
  }

  // ChatHooks

  extras(chat: ChatRecord) {
    return {
      mcp: (chat.depth < MAX_DEPTH && this.server?.access(chat.id)) || null,
      // Without the server there is nothing to delegate with.
      instructions: this.server ? instructionsFor(chat) : chat.task && CHILD_GUIDANCE,
    };
  }

  /**
   * At startup, before any turn: finishes every task Rook closed on, deepest first, from its
   * child's last reply, and delivers it to a held parent. Children are never resumed; no token or
   * timer outlives Rook, so nothing is re-armed.
   */
  async reconcile(): Promise<void> {
    // Subagent chats are not tasks: the service marks them interrupted itself.
    for (const child of this.store.runningTasks().filter((c) => !isSubagent(c)))
      // oxlint-disable-next-line no-await-in-loop -- deepest first, one at a time
      await this.finalize(child.id, undefined, undefined, true);
  }

  /** A task's turn ended: its result goes to the parent (later turns find it finished). */
  turnEnded(chatId: string, reply: ChatMessage): void {
    this.finalize(chatId, reply).catch((error: unknown) => this.log("finalize failed", error));
  }

  resultsPrompt(chatId: string, results: readonly TaskResult[]): string {
    const running = this.store
      .children(chatId)
      .filter((c) => c.task?.status === "running" && !isSubagent(c));
    return taskResultsPrompt(
      results,
      running.map((c) => c.title),
    );
  }

  /**
   * A deleted chat's token goes. Its running tasks are cancelled for good (the child chats stay,
   * top level); a deleted task is cancelled by the user and delivered before its row goes.
   */
  async stopping(chatId: string, _why: "delete"): Promise<void> {
    this.server?.revoke(chatId);
    await Promise.all(this.store.children(chatId).map((child) => this.cancel(child.id, "parent")));
    await this.cancel(chatId, "user");
  }

  // McpTools

  list(scope: { chatId: string }): McpTool[] {
    const chat = this.store.chat(scope.chatId);
    return chat && chat.depth < MAX_DEPTH ? TOOLS.map((tool) => ({ ...tool })) : [];
  }

  async call(scope: { chatId: string }, name: string, args: unknown): Promise<McpToolResult> {
    try {
      const chat = this.store.chat(scope.chatId);
      if (!chat || chat.depth >= MAX_DEPTH)
        throw new TaskError("not_allowed", "Task chats cannot start tasks of their own.");
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) throw new TaskError("invalid_request", `There is no tool named ${name}.`);
      const problem = invalid(tool.inputSchema, args);
      if (problem) throw new TaskError("invalid_request", problem);
      const input = args as Record<string, string>;
      if (name === "delegate_task") return await this.delegate(chat, args as DelegateInput);
      const child = this.child(chat, input.taskId!);
      if (name === "task_cancel") await this.cancel(child.id, "parent");
      return result(this.view(chat, this.store.chat(child.id) ?? child));
    } catch (error) {
      if (!(error instanceof TaskError)) throw error;
      const body = { error: error.code, message: error.message };
      return {
        content: [{ type: "text", text: JSON.stringify(body) }],
        structuredContent: body,
        isError: true,
      };
    }
  }

  /** One of `parent`'s own tasks; any other chat is not found. */
  private child(parent: ChatRecord, taskId: string): ChatRecord {
    const child = this.store.chat(taskId);
    if (!child?.task || child.lineage?.parentChatId !== parent.id || isSubagent(child))
      throw new TaskError("task_not_found", "You have no task with that id.");
    return child;
  }

  private delegate(parent: ChatRecord, input: DelegateInput): Promise<McpToolResult> {
    if (!input.task.trim()) throw new TaskError("invalid_request", "task is empty.");
    if (!this.service.running(parent.id))
      throw new TaskError("parent_not_active", "Tasks can only start during your turn.");
    // A retry while the first call still runs gets its answer; a later one finds the stored task.
    const key = `${parent.id}\n${input.clientRequestId ?? randomUUID()}`;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const done = input.clientRequestId
      ? this.store.taskByRequest(parent.id, input.clientRequestId)
      : null;
    if (done) return Promise.resolve(result(this.view(parent, done)));
    const starting = [...this.pending.keys()].filter((k) => k.startsWith(`${parent.id}\n`));
    if (this.runningTasks(parent.id) + starting.length >= MAX_RUNNING_CHILDREN)
      throw new TaskError(
        "limit_reached",
        `${MAX_RUNNING_CHILDREN} tasks are running already. Wait for one to finish or cancel one.`,
      );
    const call = this.start(parent, input).finally(() => this.pending.delete(key));
    this.pending.set(key, call);
    return call;
  }

  private async start(parent: ChatRecord, input: DelegateInput): Promise<McpToolResult> {
    const settings = await this.settings(parent, input);
    const snapshot = await this.options.git.snapshot(this.service.workspaceCwd(parent.id));
    const task: TaskRecord = {
      status: "running",
      summary: null,
      filesChanged: [],
      error: null,
      finishedAt: null,
      clientRequestId: input.clientRequestId ?? null,
      parentMessageId: null,
      startHead: snapshot.head,
      dirtyAtStart: input.worktree ? [] : snapshot.dirty,
      deadline: Date.now() + (this.options.timeoutMs ?? TASK_TIMEOUT_MS),
      delivered: false,
    };
    const title = input.title?.trim().replace(/\s+/g, " ") || chatTitle(input.task);
    // The awaits above give the parent's turn time to end.
    if (!this.service.running(parent.id))
      throw new TaskError("parent_not_active", "Tasks can only start during your turn.");
    let child: ChatRecord;
    try {
      child = await this.service.createTask(parent, settings, !!input.worktree, title, task);
    } catch (error) {
      if (!(error instanceof ChatRuntimeError)) throw error;
      throw new TaskError(input.worktree ? "worktree_failed" : "invalid_request", error.message);
    }
    const parentMessageId = this.service.card(parent.id, card(child, input.task));
    this.store.setTask(child.id, { ...task, parentMessageId });
    this.arm(child.id, task.deadline);
    try {
      await this.service.send(child.id, { text: input.task, attachments: [] });
    } catch (error) {
      // Never left running: the parent hears it failed.
      if (!(error instanceof ChatRuntimeError)) this.log("task did not start", error);
      const reason = error instanceof ChatRuntimeError ? error.message : "The task did not start.";
      await this.finalize(child.id, undefined, reason);
    }
    return result(this.view(parent, this.store.chat(child.id) ?? child));
  }

  /** Cancels the task with "timeout" at its deadline. */
  arm(childId: string, deadline: number): void {
    clearTimeout(this.timers.get(childId));
    const timer = setTimeout(
      () => {
        this.timers.delete(childId);
        this.cancel(childId, "timeout").catch((error: unknown) =>
          this.log("timeout failed", error),
        );
      },
      Math.max(0, deadline - Date.now()),
    );
    timer.unref();
    this.timers.set(childId, timer);
  }

  /**
   * The task's settings: agent and model as asked, else the parent's (the model only for the
   * same agent; effort and fast only when the model is the parent's too). Access is never broader
   * than the parent's; an inherited `auto` the model can't run becomes `edit`.
   */
  private async settings(parent: ChatRecord, input: DelegateInput): Promise<ChatSettings> {
    const own = parent.settings;
    const agentId = input.agent ?? own.agentId;
    const same = agentId === own.agentId;
    const catalog = await this.service.catalog(agentId).catch(() => null);
    if (!catalog || (catalog.error && !same))
      throw new TaskError("agent_unavailable", catalog?.error ?? `Rook cannot run ${agentId}.`);
    if (input.access && RANK[input.access] > RANK[own.access])
      throw new TaskError(
        "access_escalation",
        `Your access is ${own.access}; a task cannot have ${input.access}.`,
      );
    const model = input.model ?? (same ? own.model : null);
    const inherits = same && input.model === undefined;
    let access = input.access ?? own.access;
    if (access === "auto") {
      const option =
        catalog.models.find((m) => m.id === model) ??
        (model === null ? catalog.models.find((m) => m.isDefault) : undefined);
      if (!option?.auto && input.access)
        throw new TaskError("invalid_request", "That model cannot run with auto access.");
      if (!option?.auto) access = "edit";
    }
    try {
      return this.service.checkSettings({
        agentId,
        model,
        effort: inherits ? own.effort : null,
        fast: inherits && own.fast,
        access,
      });
    } catch (error) {
      if (!(error instanceof ChatRuntimeError)) throw error;
      throw new TaskError("invalid_request", error.message);
    }
  }

  /**
   * Cancels a running task and resolves once it is finalized: its own running tasks first
   * (deepest first), then its undelivered results, then its turn. Cancelled by the parent, it is
   * never delivered back; by the user it is delivered as cancelled, by its deadline as timedOut.
   */
  async cancel(childId: string, by: CancelReason): Promise<void> {
    const chat = this.store.chat(childId);
    // A subagent ends with its parent's turn; it is never cancelled or delivered as a task.
    if (chat?.task?.status !== "running" || isSubagent(chat) || this.cancelling.has(childId))
      return this.finalizing.get(childId);
    this.cancelling.set(childId, by);
    clearTimeout(this.timers.get(childId));
    for (const grandchild of this.store.children(childId))
      // oxlint-disable-next-line no-await-in-loop -- deepest first, one at a time
      await this.cancel(grandchild.id, "parent");
    for (const messageId of this.store.dropTaskDeliveries(childId))
      this.service.emit({ type: "messageDeleted", chatId: childId, messageId });
    // A running turn's end finalizes it (turnEnded); an idle task is finalized here.
    if (this.service.running(childId)) await this.service.abort(childId);
    await (this.finalizing.get(childId) ?? this.finalize(childId));
    this.cancelling.delete(childId);
  }

  /**
   * Finishes a running task from how its turn ended (`reply`, else its last reply), unless its
   * own tasks still run. Status comes from a cancel's reason, else the reply. Delivers the result
   * to the parent's queue, updates the card, and wakes the parent after DELIVERY_COALESCE_MS, so
   * siblings finishing together arrive in one turn. `failure` marks it failed with that error.
   * `restarted` (reconcile): a reply that didn't end is `interrupted`, and the parent is held
   * rather than woken.
   */
  finalize(
    childId: string,
    reply?: ChatMessage,
    failure?: string,
    restarted = false,
  ): Promise<void> {
    const inflight = this.finalizing.get(childId);
    if (inflight) return inflight;
    const child = this.store.chat(childId);
    const task = child?.task;
    if (!child || isSubagent(child) || task?.status !== "running" || this.runningTasks(childId) > 0)
      return Promise.resolve();
    const done = (async () => {
      const last = reply ?? this.store.messages(childId).findLast((m) => m.role === "assistant");
      const by = this.cancelling.get(childId);
      const status: TaskStatus =
        by === "timeout"
          ? "timedOut"
          : by
            ? "cancelled"
            : failure !== undefined || last?.status === "error"
              ? "failed"
              : last?.status === "done"
                ? "completed"
                : restarted
                  ? "interrupted"
                  : "cancelled";
      const filesChanged = await Promise.resolve()
        .then(() =>
          this.options.git.changedFiles(
            this.service.workspaceCwd(childId),
            task.startHead,
            task.dirtyAtStart,
          ),
        )
        .catch(() => []);
      const finished: TaskRecord = {
        ...task,
        status,
        summary: summaryOf(last),
        filesChanged,
        error:
          status === "failed"
            ? (failure ?? last?.error ?? null)
            : status === "interrupted"
              ? INTERRUPTED
              : null,
        finishedAt: Date.now(),
      };
      const parentId = child.lineage?.parentChatId;
      const delivery =
        parentId && by !== "parent"
          ? {
              messageId: randomUUID(),
              result: {
                taskId: child.id,
                title: child.title,
                status,
                summary: finished.summary,
                filesChanged,
                error: finished.error,
                finishedAt: finished.finishedAt,
              },
            }
          : null;
      const message = this.store.finishTask(childId, finished, delivery);
      this.service.emitChat(childId);
      if (!parentId) return;
      const prompt = this.store.messages(childId).find((m) => m.role === "user");
      this.service.card(
        parentId,
        card({ ...child, task: finished }, textOf(prompt)),
        task.parentMessageId,
      );
      if (!message) return;
      this.service.emit({ type: "message", message });
      // D2: nothing runs unattended after a restart; Send now starts the parent.
      if (restarted) this.service.hold(parentId);
      else this.service.drainSoon(parentId, this.options.coalesceMs ?? DELIVERY_COALESCE_MS);
    })().finally(() => {
      clearTimeout(this.timers.get(childId));
      this.timers.delete(childId);
      this.cancelling.delete(childId);
      this.finalizing.delete(childId);
    });
    this.finalizing.set(childId, done);
    return done;
  }

  private runningTasks(parentId: string): number {
    return this.store
      .children(parentId)
      .filter((c) => c.task?.status === "running" && !isSubagent(c)).length;
  }

  private view(parent: ChatRecord, child: ChatRecord): TaskView {
    const task = child.task!;
    return {
      taskId: child.id,
      title: child.title,
      status: task.status,
      summary: task.summary,
      filesChanged: task.filesChanged,
      error: task.error,
      agent: child.settings.agentId,
      model: child.settings.model,
      access: child.settings.access,
      worktree: child.worktreePath !== null && child.worktreePath !== parent.worktreePath,
      runningTasks: this.runningTasks(parent.id),
    };
  }
}

/** The task card in the parent's reply. */
function card(child: ChatRecord, prompt: string): Extract<MessagePart, { kind: "tool" }> {
  return {
    kind: "tool",
    tool: "task",
    id: child.id,
    title: child.title,
    detail: truncate(prompt, CARD_DETAIL_CHARS),
    output: child.task?.summary ?? null,
    status: CARD_STATUS[child.task?.status ?? "running"],
  };
}

const result = (view: TaskView): McpToolResult => ({
  content: [{ type: "text", text: JSON.stringify(view) }],
  structuredContent: view,
});
