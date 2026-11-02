// Chats end to end: validates what the renderer asks for, saves history, runs turns through each
// agent's runtime, assembles the streaming reply, routes approvals, and pushes ChatEvents.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import {
  ATTACHMENT_LIMITS,
  type AccessMode,
  type AgentCatalog,
  type ApprovalDecision,
  type Attachment,
  type AttachmentUpload,
  type ChatAgentId,
  type ChatEvent,
  type ChatMessage,
  type ChatSettings,
  type ChatSummary,
  type MessagePart,
  type Project,
  type QuestionAnswer,
  type RequestAnswer,
  type SendInput,
  type TaskResult,
  projectIdOf,
} from "@rook/contracts";

import type { gitClient } from "./git.ts";
import type { githubClient } from "./github.ts";
import { buildHandoff } from "./handoff.ts";
import {
  ChatRuntimeError,
  type ApprovalAnswer,
  type ChatRuntime,
  type McpAccess,
  type QuestionReply,
  type SubagentEvent,
  type TurnImage,
  type TurnSink,
} from "./runtime.ts";
import type { ChatRecord, ChatStore, TaskRecord } from "./store.ts";
import { summaryOf } from "./tasks.ts";

// Streaming replies reach the renderer this often, and the database at most this often.
const EMIT_MS = 60;
const SAVE_MS = 1_000;
const CATALOG_TTL_MS = 10 * 60_000;
const ACCESS_MODES: ReadonlySet<unknown> = new Set(["ask", "edit", "auto", "full"]);
const SUBAGENT_INTERRUPTED = "Rook closed while this subagent was running.";
const MAX_ANSWER = 20_000;

/** A chat holding a native subagent's transcript: read-only, and never a delegated task. */
export const isSubagent = (chat: Pick<ChatRecord, "lineage">) =>
  chat.lineage?.relationship === "subagent";

/** A request part the agent waits on. */
type RequestPart = Extract<MessagePart, { kind: "approval" | "question" | "plan" }>;

const isRequest = (part: MessagePart): part is RequestPart =>
  part.kind === "approval" || part.kind === "question" || part.kind === "plan";

/** Trimmed text from the renderer within the answer limit; null when empty. */
function answerText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > MAX_ANSWER)
    throw new ChatRuntimeError("That answer is too long.");
  return value.trim() || null;
}

/**
 * Checks an answer from the renderer against the request it answers and returns it cleaned up:
 * picked options are the question's own, and every question is answered.
 */
export function checkAnswer(part: RequestPart, answer: unknown): RequestAnswer {
  const { kind, decision, answers, feedback } = (answer ?? {}) as Record<string, unknown>;
  if (kind === "decline") return { kind, feedback: answerText(feedback) };
  if (part.kind === "approval" && kind === "decision") {
    if (!part.options.includes(decision as ApprovalDecision))
      throw new ChatRuntimeError("Choose allow or deny.");
    return { kind, decision: decision as ApprovalDecision };
  }
  if (part.kind === "plan" && kind === "decision" && (decision === "allow" || decision === "deny"))
    return { kind, decision };
  if (part.kind !== "question" || kind !== "answers" || typeof answers !== "object" || !answers)
    throw new ChatRuntimeError("That answer does not fit this request.");
  const cleaned: Record<string, QuestionAnswer> = {};
  for (const question of part.questions) {
    const given = (answers as Record<string, unknown>)[question.id] as
      | Record<string, unknown>
      | undefined;
    const selected: unknown[] = Array.isArray(given?.selected) ? given.selected : [];
    const labels = new Set(question.options.map((option) => option.label));
    const text = answerText(given?.text);
    if (
      selected.some((label) => typeof label !== "string" || !labels.has(label)) ||
      new Set(selected).size !== selected.length ||
      (selected.length > 1 && !question.multiSelect) ||
      (text !== null && !question.allowCustom) ||
      (selected.length === 0 && text === null)
    )
      throw new ChatRuntimeError("Answer every question first.");
    cleaned[question.id] = { selected: selected as string[], text };
  }
  return { kind, answers: cleaned };
}

/** An approval's or plan's answer as the runtime takes it. */
const approval = (answer: RequestAnswer): ApprovalAnswer =>
  answer.kind === "decision"
    ? { decision: answer.decision, feedback: null }
    : { decision: "deny", feedback: answer.kind === "decline" ? answer.feedback : null };

/** A folder as the disk compares it: Windows and macOS disks ignore case by default. */
const norm = (path: string) => {
  const resolved = NodePath.resolve(path);
  return process.platform === "linux" ? resolved : resolved.toLowerCase();
};

/** Whether two folders share files: the same folder, or one inside the other. */
export function overlaps(a: string, b: string): boolean {
  const [x, y] = [norm(a), norm(b)];
  return x === y || x.startsWith(y + NodePath.sep) || y.startsWith(x + NodePath.sep);
}

/** A chat title from its first prompt: the first line, cut at a word near 48 characters. */
export function chatTitle(prompt: string): string {
  const line = prompt.trim().split("\n")[0]!.replace(/\s+/g, " ");
  if (line.length <= 48) return line || "New chat";
  const cut = line.slice(0, 48);
  const space = cut.lastIndexOf(" ");
  return `${space > 24 ? cut.slice(0, space) : cut}…`;
}

/** Settings come from the renderer: every field is checked before it reaches an agent's argv. */
const fail = (): never => {
  throw new ChatRuntimeError("Those chat settings are not valid.");
};

export function parseSettings(value: unknown, agents: ReadonlySet<string>): ChatSettings {
  if (typeof value !== "object" || value === null) return fail();
  const { agentId, model, effort, fast, access, plan } = value as Record<string, unknown>;
  if (typeof agentId !== "string" || !agents.has(agentId)) return fail();
  if (model !== null && (typeof model !== "string" || !/^[\w.:/@[\]-]{1,200}$/.test(model)))
    return fail();
  if (effort !== null && (typeof effort !== "string" || !/^[a-z0-9_-]{1,40}$/.test(effort)))
    return fail();
  if (typeof fast !== "boolean" || !ACCESS_MODES.has(access)) return fail();
  if (plan !== undefined && typeof plan !== "boolean") return fail();
  return {
    agentId: agentId as ChatAgentId,
    model,
    effort,
    fast,
    access: access as AccessMode,
    // Absent means off, as on settings saved before plan mode.
    ...(plan === true && { plan }),
  };
}

const isImage = (mediaType: string) =>
  (ATTACHMENT_LIMITS.imageTypes as readonly string[]).includes(mediaType);

/** Checks one upload and decides its kind. Text must be valid UTF-8 without NUL bytes. */
export function checkUpload(upload: AttachmentUpload): { kind: Attachment["kind"]; text?: string } {
  const { name, mediaType, data } = upload as Partial<AttachmentUpload>;
  if (typeof name !== "string" || !name || name.length > 255 || typeof mediaType !== "string")
    throw new ChatRuntimeError("An attachment is missing its name.");
  if (!(data instanceof Uint8Array)) throw new ChatRuntimeError(`${name} could not be read.`);
  if (isImage(mediaType)) {
    if (data.byteLength > ATTACHMENT_LIMITS.imageBytes)
      throw new ChatRuntimeError(`${name} is larger than 10 MB.`);
    return { kind: "image" };
  }
  if (data.byteLength > ATTACHMENT_LIMITS.textBytes)
    throw new ChatRuntimeError(`${name} is larger than 512 KB.`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    text = "\0";
  }
  if (text.includes("\0")) throw new ChatRuntimeError(`${name} is not an image or a text file.`);
  return { kind: "text", text };
}

/** The prompt the agent sees: the user's text, then each text attachment in a fence. */
export function buildPrompt(text: string, files: readonly { name: string; text: string }[]) {
  const blocks = files.map(({ name, text: body }) => {
    const fence = "`".repeat(
      Math.max(3, ...[...body.matchAll(/`{3,}/g)].map((m) => m[0].length + 1)),
    );
    return `Attached file "${name}":\n${fence}\n${body}\n${fence}`;
  });
  return [text, ...blocks].filter(Boolean).join("\n\n");
}

const extension = (name: string) => {
  const ext = NodePath.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
};

/** A short, git-safe branch slug from a title. */
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30) || "chat";

/** Builds an assistant reply from a runtime's events, in the order they arrive. */
class Reply {
  parts: MessagePart[] = [];
  model: string | null;

  constructor(model: string | null) {
    this.model = model;
  }

  append(kind: "text" | "reasoning", delta: string): void {
    const last = this.parts.at(-1);
    if (last?.kind === kind) this.parts[this.parts.length - 1] = { kind, text: last.text + delta };
    else this.parts.push({ kind, text: delta });
  }

  /** Replaces the part of this kind with this id, or adds it at the end. */
  upsert(part: Extract<MessagePart, { id: string }>): void {
    const index = this.parts.findIndex(
      (p) => p.kind === part.kind && "id" in p && p.id === part.id,
    );
    const old = this.parts[index];
    // A runtime's update doesn't know the subagent chat Rook made for an agent part.
    if (old?.kind === "tool" && old.chatId && part.kind === "tool")
      this.parts[index] = { chatId: old.chatId, ...part };
    else if (index >= 0) this.parts[index] = part;
    else this.parts.push(part);
  }
}

/** A subagent chat's streaming reply, filled from its parent's turn. */
interface Transcript {
  readonly chatId: string;
  readonly reply: Reply;
  /** Emits soon, and saves at most every SAVE_MS, like a turn's reply. */
  readonly changed: () => void;
  readonly flush: (save: boolean) => void;
  /** Saves and emits the reply as finished. */
  readonly end: (status: ChatMessage["status"], error: string | null) => ChatMessage;
}

interface Run {
  readonly controller: AbortController;
  /**
   * Approvals, questions and plans waiting for the user, by part id. Resolving one hands the
   * answer to the agent.
   */
  readonly requests: Map<string, (answer: RequestAnswer) => void>;
  /** Records the user's answer on the request's part. */
  readonly decide: (requestId: string, answer: RequestAnswer) => void;
  readonly reply: Reply;
  /** The id of the reply being written now; a steered message moves it on. */
  readonly replyId: () => string;
  readonly flush: (save: boolean) => void;
  /**
   * Saves the reply so far as done, runs `between` (which places the steered message), and opens
   * a new reply for the rest of the turn.
   */
  readonly split: (between: () => void) => void;
  /** Called once the turn has fully ended and its reply is saved. */
  done?: () => void;
}

export interface ChatServiceOptions {
  readonly store: ChatStore;
  readonly runtimes: readonly ChatRuntime[];
  readonly git: ReturnType<typeof gitClient>;
  readonly github: ReturnType<typeof githubClient>;
  /** Rook's data directory; attachments and worktrees live under it. */
  readonly dataDir: string;
  readonly emit: (event: ChatEvent) => void;
  readonly log: (message: string, error?: unknown) => void;
}

/** How delegation (tasks.ts) plugs into turns. */
export interface ChatHooks {
  /** Rook's MCP server and system instructions for the chat's next turn. */
  extras(chat: ChatRecord): { mcp: McpAccess | null; instructions: string | null };
  /** After every turn, once its final reply is saved. */
  turnEnded(chatId: string, reply: ChatMessage): void;
  /** Before a chat is deleted, while its turn may still run. */
  stopping(chatId: string, why: "delete"): Promise<void>;
  /** The prompt that hands finished tasks to the chat's agent. */
  resultsPrompt(chatId: string, results: readonly TaskResult[]): string;
}

export class ChatService {
  hooks: ChatHooks | null = null;
  private readonly runs = new Map<string, Run>();
  /** Chats whose queue waits for the user: after Stop, an error, or a restart. */
  private readonly held = new Set<string>();
  /** Queued messages being steered into a running turn; drain and dequeue leave them alone. */
  private readonly steering = new Set<string>();
  /** Chats being rewound, with the folder whose files the rewind may revert. */
  private readonly rewinding = new Map<string, string>();
  private readonly catalogs = new Map<string, { at: number; value: Promise<AgentCatalog> }>();
  /** Running subagents' transcripts, by parent chat id + "\n" + agent part id. */
  private readonly transcripts = new Map<string, Transcript>();
  private readonly runtimes: Map<string, ChatRuntime>;
  private readonly agents: ReadonlySet<string>;
  private readonly options: ChatServiceOptions;

  constructor(options: ChatServiceOptions) {
    this.options = options;
    this.runtimes = new Map(options.runtimes.map((runtime) => [runtime.agentId, runtime]));
    this.agents = new Set(this.runtimes.keys());
    for (const chat of options.store.chats()) {
      // Nothing starts unattended after a restart: the user sends queued messages on.
      if (options.store.queued(chat.id).length) this.held.add(chat.id);
      // Its parent's turn ended with Rook (the store marked its reply stopped); nothing resumes it.
      if (isSubagent(chat) && chat.task?.status === "running") {
        const last = options.store.messages(chat.id).findLast((m) => m.role === "assistant");
        options.store.setTask(chat.id, {
          ...chat.task,
          status: "interrupted",
          summary: summaryOf(last),
          error: SUBAGENT_INTERRUPTED,
          finishedAt: Date.now(),
        });
      }
    }
  }

  private get store() {
    return this.options.store;
  }

  private summary(chat: ChatRecord): ChatSummary {
    const project = this.store.project(chat.projectId);
    const run = this.runs.get(chat.id);
    const requestId = run?.requests.keys().next().value;
    const request = run?.reply.parts.find((p) => isRequest(p) && p.id === requestId);
    const task = chat.task;
    return {
      id: chat.id,
      projectId: chat.projectId,
      title: chat.title,
      settings: chat.settings,
      cwd: chat.worktreePath ?? project?.path ?? "",
      worktree: chat.worktreePath !== null,
      started: chat.sessionId !== null,
      handoff: chat.handoff,
      context: chat.context,
      running: this.runs.has(chat.id),
      lineage: chat.lineage,
      task: task && {
        status: task.status,
        summary: task.summary,
        filesChanged: task.filesChanged,
        error: task.error,
        finishedAt: task.finishedAt,
      },
      waiting:
        request && isRequest(request)
          ? {
              approvalId: request.id,
              kind: request.kind,
              title:
                request.kind === "approval"
                  ? request.title
                  : request.kind === "plan"
                    ? "Review the plan"
                    : (request.questions[0]?.question.trim().split("\n")[0] ?? "Answer a question"),
              ...(request.kind !== "plan" && request.subagent && { subagent: request.subagent }),
            }
          : null,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    };
  }

  private chat(id: unknown): ChatRecord {
    const chat = typeof id === "string" ? this.store.chat(id) : null;
    if (!chat) throw new ChatRuntimeError("That chat no longer exists.");
    return chat;
  }

  /** A chat the user may change: any but a subagent's, which only its parent's turn writes. */
  private writable(id: unknown): ChatRecord {
    const chat = this.chat(id);
    if (isSubagent(chat)) throw new ChatRuntimeError("A subagent's chat is read-only.");
    return chat;
  }

  private project(id: unknown): Project {
    const project = typeof id === "string" ? this.store.project(id) : null;
    if (!project) throw new ChatRuntimeError("That project is no longer in Rook.");
    return project;
  }

  private cwd(chat: ChatRecord): string {
    return chat.worktreePath ?? this.project(chat.projectId).path;
  }

  emitChat(id: string): void {
    const chat = this.store.chat(id);
    if (chat) this.options.emit({ type: "chat", chat: this.summary(chat) });
  }

  emit(event: ChatEvent): void {
    this.options.emit(event);
  }

  private attachmentDir(chatId: string): string {
    return NodePath.join(this.options.dataDir, "attachments", chatId);
  }

  // Projects

  projects(): Project[] {
    return this.store.projects();
  }

  /** `path` comes from the native folder picker, never from the renderer. */
  addProject(path: string): Project {
    return this.store.addProject(randomUUID(), NodePath.basename(path) || path, path);
  }

  async removeProject(projectId: string): Promise<void> {
    const project = this.project(projectId);
    for (const chat of this.store.chats().filter((c) => c.projectId === project.id))
      // oxlint-disable-next-line no-await-in-loop -- one git worktree removal at a time
      await this.delete(chat.id);
    this.store.removeProject(project.id);
    this.options.emit({ type: "projectRemoved", projectId: project.id });
  }

  // Chats

  chats(): ChatSummary[] {
    return this.store.chats().map((chat) => this.summary(chat));
  }

  async create(projectId: unknown, settings: unknown, options: unknown): Promise<ChatSummary> {
    const project = this.project(projectId);
    const parsed = this.checkAccess(parseSettings(settings, this.agents));
    const id = randomUUID();
    const { worktree, joinChat } = (options ?? {}) as { worktree?: unknown; joinChat?: unknown };
    let worktreePath: string | null = null;
    if (joinChat !== undefined) {
      // Shares another chat's worktree, so several chats can work in one checkout.
      const host = this.chat(joinChat);
      if (host.projectId !== project.id || !host.worktreePath)
        throw new ChatRuntimeError("That chat has no worktree of this project to join.");
      worktreePath = host.worktreePath;
    } else if (worktree === true) {
      worktreePath = await this.addWorktree(project, id, project.path);
    }
    const chat = this.store.createChat(id, project.id, "New chat", parsed, worktreePath);
    const summary = this.summary(chat);
    this.options.emit({ type: "chat", chat: summary });
    return summary;
  }

  /** A new worktree for chat `id`, on its own branch from the current HEAD of the folder `from`. */
  private async addWorktree(project: Project, id: string, from: string): Promise<string> {
    const path = NodePath.join(
      this.options.dataDir,
      "worktrees",
      `${slug(project.name)}-${project.id.slice(0, 8)}`,
      id.slice(0, 8),
    );
    await mkdir(NodePath.dirname(path), { recursive: true });
    await this.options.git.addWorktree(from, path, `rook/chat-${id.slice(0, 8)}`);
    return path;
  }

  /**
   * A task chat of `parent`: in a new worktree from the parent's folder HEAD, or in the parent's
   * own folder (its worktree, if it has one). `settings` must have passed checkSettings.
   */
  async createTask(
    parent: ChatRecord,
    settings: ChatSettings,
    worktree: boolean,
    title: string,
    task: TaskRecord,
  ): Promise<ChatRecord> {
    const project = this.project(parent.projectId);
    const id = randomUUID();
    const worktreePath = worktree
      ? await this.addWorktree(project, id, this.cwd(parent))
      : parent.worktreePath;
    const lineage = {
      parentChatId: parent.id,
      relationship: "task" as const,
      depth: parent.depth + 1,
    };
    const chat = this.store.createChat(
      id,
      project.id,
      title,
      settings,
      worktreePath,
      lineage,
      task,
    );
    this.emitChat(chat.id);
    return chat;
  }

  /**
   * Adds or replaces a tool part (a task card) in the parent's live reply, or in its saved reply
   * `messageId` once that is no longer being written. Returns the id of the message holding it.
   */
  card(
    parentChatId: string,
    part: Extract<MessagePart, { kind: "tool" }>,
    messageId?: string | null,
  ): string | null {
    const run = this.runs.get(parentChatId);
    if (run && (!messageId || messageId === run.replyId())) {
      run.reply.upsert(part);
      run.flush(true);
      return run.replyId();
    }
    const message = messageId ? this.store.message(messageId) : null;
    if (message?.chatId !== parentChatId) return null;
    const index = message.parts.findIndex((p) => p.kind === "tool" && p.id === part.id);
    const parts =
      index >= 0 ? message.parts.map((p, i) => (i === index ? part : p)) : [...message.parts, part];
    const updated: ChatMessage = { ...message, parts };
    this.save(updated);
    this.options.emit({ type: "message", message: updated });
    return message.id;
  }

  /** Checks settings as create() does: agent, model and effort, and the agent's access modes. */
  checkSettings(settings: unknown): ChatSettings {
    return this.checkAccess(parseSettings(settings, this.agents));
  }

  /** Whether a turn is running in the chat. */
  running(chatId: string): boolean {
    return this.runs.has(chatId);
  }

  /** Keeps the chat's queue waiting for the user (Send now or a new message). */
  hold(chatId: string): void {
    this.held.add(chatId);
  }

  rename(chatId: unknown, title: unknown): void {
    const chat = this.writable(chatId);
    const clean = typeof title === "string" ? title.trim().replace(/\s+/g, " ") : "";
    if (!clean || clean.length > 200) throw new ChatRuntimeError("Give the chat a shorter name.");
    this.store.renameChat(chat.id, clean);
    this.emitChat(chat.id);
  }

  async delete(chatId: unknown): Promise<{ keptWorktree: string | null }> {
    const chat = this.chat(chatId);
    await this.hooks?.stopping(chat.id, "delete");
    await this.abort(chat.id);
    const children = this.store.children(chat.id);
    // Its subagents' chats only hold transcripts of its turns, so they go with it.
    for (const child of children.filter(isSubagent))
      // oxlint-disable-next-line no-await-in-loop -- one at a time, like removeProject
      await this.delete(child.id);
    this.store.deleteChat(chat.id); // Its messages, queued ones too, go with it.
    this.held.delete(chat.id);
    // Its turn snapshot refs stay in the repository.
    await rm(this.attachmentDir(chat.id), { recursive: true, force: true });
    this.options.emit({ type: "chatDeleted", chatId: chat.id });
    for (const child of children) this.emitChat(child.id); // Now top-level chats.
    // A subagent chat only names its parent's folder: it never keeps or removes a worktree.
    if (!chat.worktreePath || isSubagent(chat)) return { keptWorktree: null };
    // Another chat still works there.
    if (
      this.store
        .chats()
        .some((other) => other.worktreePath === chat.worktreePath && !isSubagent(other))
    )
      return { keptWorktree: null };
    const project = this.store.project(chat.projectId);
    const removed =
      project && (await this.options.git.removeWorktree(project.path, chat.worktreePath));
    return { keptWorktree: removed ? null : chat.worktreePath };
  }

  private checkAccess(settings: ChatSettings): ChatSettings {
    const runtime = this.runtimes.get(settings.agentId)!;
    if (!runtime.accessModes.includes(settings.access))
      throw new ChatRuntimeError(`${runtime.agentId} does not support that access mode.`);
    return settings;
  }

  updateSettings(chatId: unknown, settings: unknown): ChatSummary {
    const chat = this.writable(chatId);
    const parsed = this.checkAccess(parseSettings(settings, this.agents));
    // A session cannot move to another agent: the new one starts its own, handed the history.
    const handoff =
      parsed.agentId !== chat.settings.agentId &&
      (chat.sessionId !== null || this.store.messages(chat.id).length > 0);
    if (handoff && this.runs.has(chat.id))
      throw new ChatRuntimeError("Wait for the reply to finish before switching agents.");
    this.store.setSettings(chat.id, parsed);
    if (handoff) {
      this.store.setSession(chat.id, null);
      this.store.setContext(chat.id, null);
      this.store.setHandoff(chat.id, true);
    }
    const summary = this.summary(this.chat(chat.id));
    this.options.emit({ type: "chat", chat: summary });
    return summary;
  }

  messages(chatId: unknown): ChatMessage[] {
    const chat = this.chat(chatId);
    // A streaming reply is saved only every second; save the latest copy first.
    this.runs.get(chat.id)?.flush(true);
    for (const transcript of this.transcripts.values())
      if (transcript.chatId === chat.id) transcript.flush(true);
    return this.store.messages(chat.id);
  }

  async attachment(chatId: unknown, attachmentId: unknown): Promise<Uint8Array> {
    const chat = this.chat(chatId);
    const found = this.store
      .messages(chat.id)
      .flatMap((message) => message.attachments)
      .find((a) => a.id === attachmentId);
    if (!found) throw new ChatRuntimeError("That attachment is gone.");
    const file = NodePath.join(this.attachmentDir(chat.id), found.id + extension(found.name));
    return new Uint8Array(await readFile(file));
  }

  // Catalogs

  catalog(agentId: unknown, refresh = false): Promise<AgentCatalog> {
    const runtime = typeof agentId === "string" ? this.runtimes.get(agentId) : undefined;
    if (!runtime) return Promise.reject(new ChatRuntimeError("Rook cannot chat with that agent."));
    const cached = this.catalogs.get(runtime.agentId);
    if (cached && !refresh && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value;
    const value = runtime
      .catalog(AbortSignal.timeout(45_000))
      .then((catalog): AgentCatalog => ({ ...catalog, steering: !!runtime.steer }))
      .catch((error: unknown): AgentCatalog => {
        this.catalogs.delete(runtime.agentId); // Try again next time.
        if (!(error instanceof ChatRuntimeError)) this.options.log("catalog failed", error);
        return {
          agentId: runtime.agentId,
          models: [],
          accessModes: runtime.accessModes,
          error: error instanceof ChatRuntimeError ? error.message : "Could not read the models.",
          steering: !!runtime.steer,
        };
      });
    this.catalogs.set(runtime.agentId, { at: Date.now(), value });
    return value;
  }

  // Turns

  async send(chatId: unknown, input: unknown): Promise<void> {
    const chat = this.writable(chatId);
    this.notRewinding(chat);
    const { text, attachments, mode } = (input ?? {}) as Partial<SendInput>;
    if (
      typeof text !== "string" ||
      text.length > 200_000 ||
      !Array.isArray(attachments) ||
      (mode !== undefined && mode !== "queue" && mode !== "steer")
    )
      throw new ChatRuntimeError("That message could not be sent.");
    if (attachments.length > ATTACHMENT_LIMITS.maxFiles)
      throw new ChatRuntimeError(`Attach at most ${ATTACHMENT_LIMITS.maxFiles} files.`);
    const checked = attachments.map((upload) => Object.assign(checkUpload(upload), { upload }));
    if (!text.trim() && checked.length === 0) throw new ChatRuntimeError("Write a message first.");
    if (checked.some((file) => file.kind === "image") && !(await this.acceptsImages(chat.settings)))
      throw new ChatRuntimeError("This model does not accept images.");

    const dir = this.attachmentDir(chat.id);
    const saved: Attachment[] = [];
    if (checked.length) await mkdir(dir, { recursive: true });
    for (const file of checked) {
      const id = randomUUID();
      const { name, mediaType, data } = file.upload;
      // oxlint-disable-next-line no-await-in-loop -- a handful of files, saved in order
      await writeFile(NodePath.join(dir, id + extension(name)), data);
      saved.push({ id, name, kind: file.kind, mediaType, size: data.byteLength });
    }

    // Checked after the awaits above: the turn may have ended meanwhile.
    const run = this.runs.get(chat.id);
    const firstPrompt = !this.store.messages(chat.id).some((m) => m.role === "user");
    const prompt: ChatMessage = {
      id: randomUUID(),
      chatId: chat.id,
      role: "user",
      parts: text.trim() ? [{ kind: "text", text: text.trim() }] : [],
      attachments: saved,
      status: run ? "queued" : "done",
      error: null,
      agentId: null,
      model: null,
      createdAt: Date.now(),
    };
    this.store.saveMessage(prompt);
    this.options.emit({ type: "message", message: prompt });
    this.held.delete(chat.id);
    if (run) {
      if (mode === "steer") await this.steer(chat, run, prompt);
      return;
    }
    if (firstPrompt && chat.title === "New chat")
      this.store.renameChat(chat.id, chatTitle(text || saved[0]?.name || "New chat"));
    this.start(chat, prompt);
  }

  /** Adds a queued message to the running turn when the agent can take it; else it stays queued. */
  private async steer(chat: ChatRecord, run: Run, message: ChatMessage): Promise<void> {
    const runtime = this.runtimes.get(chat.settings.agentId)!;
    // An agent waiting on an approval or a question is not reading messages.
    if (!runtime.steer || run.requests.size) return;
    this.steering.add(message.id);
    let steered = false;
    try {
      steered = await runtime.steer(chat.id, await this.turnInput(chat, message));
    } catch (error) {
      if (!(error instanceof ChatRuntimeError)) this.options.log("steer failed", error);
    } finally {
      this.steering.delete(message.id);
    }
    if (steered && this.runs.get(chat.id) === run) run.split(() => this.markSent(message));
    else if (steered) this.markSent(message); // It reached the agent as that turn ended.
    // The turn may have ended while it steered, skipping this message.
    this.drain(chat.id);
  }

  async retry(chatId: unknown): Promise<void> {
    const chat = this.writable(chatId);
    this.notRewinding(chat);
    if (this.runs.has(chat.id)) throw new ChatRuntimeError("Wait for the reply to finish first.");
    const messages = this.store.messages(chat.id).filter((m) => m.status !== "queued");
    const last = messages.at(-1);
    const prompt = messages.findLast((m) => m.role === "user");
    if (!prompt) throw new ChatRuntimeError("There is nothing to retry.");
    this.held.delete(chat.id); // The user resumes the chat; the queue follows a good turn.
    if (last?.role === "assistant") {
      this.store.deleteMessage(last.id);
      this.options.emit({ type: "messageDeleted", chatId: chat.id, messageId: last.id });
    }
    this.start(chat, prompt);
  }

  /**
   * Removes a sent user message and everything after it, optionally reverting the folder to before
   * the first removed turn that changed files, and returns its text for the composer.
   */
  async rewind(chatId: unknown, messageId: unknown, options: unknown): Promise<{ text: string }> {
    const chat = this.writable(chatId);
    const revertFiles = (options as { revertFiles?: unknown } | null)?.revertFiles;
    if (typeof revertFiles !== "boolean") throw new ChatRuntimeError("That rewind is not valid.");
    if (this.rewinding.has(chat.id)) throw new ChatRuntimeError("That chat is already rewinding.");
    const removed = this.rewindPoint(chat, messageId);
    const from = revertFiles
      ? removed.flatMap((m) => m.parts).find((p) => p.kind === "changes")?.from
      : undefined;
    const cwd = this.cwd(chat);
    if (from && this.busy(cwd))
      throw new ChatRuntimeError("Wait for the running turn to finish before reverting files.");
    // From here no turn of this chat (or, while files revert, of this folder) can start.
    this.rewinding.set(chat.id, from ? cwd : "");
    try {
      return await this.rewound(chat, messageId, cwd, from);
    } finally {
      this.rewinding.delete(chat.id);
      this.drain(chat.id);
    }
  }

  private async rewound(
    chat: ChatRecord,
    messageId: unknown,
    cwd: string,
    from: string | undefined,
  ): Promise<{ text: string }> {
    if (from) await this.options.git.restore(cwd, chat.id, from);
    // The next turn diffs from the folder as it is now, not the removed turn's end.
    await this.options.git.rebaseline(cwd, chat.id).catch((error: unknown) => {
      this.options.log("could not take a checkpoint", error);
    });
    // Nothing could start meanwhile; the point is checked again in case it was edited away.
    const gone = this.rewindPoint(chat, messageId);
    for (const message of gone) {
      this.store.deleteMessage(message.id);
      this.options.emit({ type: "messageDeleted", chatId: chat.id, messageId: message.id });
    }
    const latest = this.chat(chat.id);
    // As on an agent switch: a fresh session, handed the history that is left.
    if (
      latest.sessionId !== null ||
      this.store.messages(chat.id).some((m) => m.status !== "queued")
    ) {
      this.store.setSession(chat.id, null);
      this.store.setContext(chat.id, null);
      this.store.setHandoff(chat.id, true);
    }
    this.emitChat(chat.id);
    const dir = this.attachmentDir(chat.id);
    await Promise.all(
      gone
        .flatMap((m) => m.attachments)
        .map((a) => rm(NodePath.join(dir, a.id + extension(a.name)), { force: true })),
    );
    return {
      text: gone[0]!.parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("\n\n"),
    };
  }

  /** The sent user message `messageId` and every sent message after it; throws otherwise. */
  /** Rejects a turn in a chat being rewound, or in a folder a rewind is reverting. */
  private notRewinding(chat: ChatRecord): void {
    const cwd = this.cwd(chat);
    for (const [id, folder] of this.rewinding)
      if (id === chat.id || (folder && overlaps(folder, cwd)))
        throw new ChatRuntimeError("Wait for the rewind to finish first.");
  }

  private rewindPoint(chat: ChatRecord, messageId: unknown): ChatMessage[] {
    if (this.runs.has(chat.id)) throw new ChatRuntimeError("Wait for the reply to finish first.");
    const messages = this.store.messages(chat.id).filter((m) => m.status !== "queued");
    const index = messages.findIndex((m) => m.id === messageId && m.role === "user");
    if (index < 0) throw new ChatRuntimeError("That message is no longer in the chat.");
    return messages.slice(index);
  }

  /** Stops the turn. Queued messages stay, held until the user sends one on. */
  stop(chatId: unknown): void {
    const chat = this.writable(chatId);
    this.held.add(chat.id);
    this.runs.get(chat.id)?.controller.abort();
  }

  answer(chatId: unknown, requestId: unknown, answer: unknown): void {
    const chat = this.writable(chatId);
    const run = this.runs.get(chat.id);
    const resolve = typeof requestId === "string" ? run?.requests.get(requestId) : undefined;
    const part = run?.reply.parts.find((p) => isRequest(p) && p.id === requestId);
    if (!run || !resolve || !part || !isRequest(part))
      throw new ChatRuntimeError("That request has already ended.");
    const checked = checkAnswer(part, answer);
    run.requests.delete(part.id);
    run.decide(part.id, checked);
    resolve(checked);
    this.emitChat(chat.id); // `waiting` moves on.
  }

  /** "send" starts a queued message now (or after the running turn); "remove" drops it. */
  async dequeue(chatId: unknown, messageId: unknown, action: unknown): Promise<void> {
    const chat = this.writable(chatId);
    if (action === "send") this.notRewinding(chat);
    const message = typeof messageId === "string" ? this.store.message(messageId) : null;
    if (
      (action !== "send" && action !== "remove") ||
      message?.chatId !== chat.id ||
      message.status !== "queued" ||
      this.steering.has(message.id)
    )
      throw new ChatRuntimeError("That message is no longer queued.");
    if (action === "remove") {
      this.store.deleteMessage(message.id);
      this.options.emit({ type: "messageDeleted", chatId: chat.id, messageId: message.id });
      const dir = this.attachmentDir(chat.id);
      await Promise.all(
        message.attachments.map((a) =>
          rm(NodePath.join(dir, a.id + extension(a.name)), { force: true }),
        ),
      );
      return;
    }
    this.held.delete(chat.id);
    if (!this.runs.has(chat.id)) this.start(chat, this.markSent(message));
  }

  /** Starts the next queued message unless the chat is running or held. Task results go first. */
  private drain(chatId: string): void {
    const chat = this.store.chat(chatId);
    if (!chat || this.runs.has(chatId) || this.held.has(chatId) || this.rewinding.has(chatId))
      return;
    const queued = this.store.queued(chatId).filter((m) => !this.steering.has(m.id));
    const next = queued.find((m) => m.parts.some((p) => p.kind === "taskResults")) ?? queued[0];
    if (next) this.start(chat, this.markSent(next));
  }

  /** Drains after `ms`, e.g. so sibling task results arriving together go in one turn. */
  drainSoon(chatId: string, ms: number): void {
    setTimeout(() => this.drain(chatId), ms);
  }

  /** Marks a queued message sent: it moves after the replies saved since it was queued. */
  private markSent(message: ChatMessage): ChatMessage {
    this.store.dequeue(message.id);
    const sent: ChatMessage = { ...message, status: "done" };
    // The renderer keeps a message where it first saw it, so it is removed and added again.
    this.options.emit({ type: "messageDeleted", chatId: message.chatId, messageId: message.id });
    this.options.emit({ type: "message", message: sent });
    return sent;
  }

  /** The prompt that hands finished tasks to the parent's agent. */
  private taskResultsPrompt(chatId: string, results: readonly TaskResult[]): string {
    if (!this.hooks) throw new ChatRuntimeError("Task results need delegation, which is off.");
    return this.hooks.resultsPrompt(chatId, results);
  }

  private async acceptsImages(settings: ChatSettings): Promise<boolean> {
    const catalog = await this.catalog(settings.agentId);
    const model =
      catalog.models.find((m) => m.id === settings.model) ??
      catalog.models.find((m) => m.isDefault);
    return model?.images ?? true; // Unknown model: let the agent decide.
  }

  private async turnInput(chat: ChatRecord, prompt: ChatMessage) {
    const dir = this.attachmentDir(chat.id);
    const files: { name: string; text: string }[] = [];
    const images: TurnImage[] = [];
    for (const attachment of prompt.attachments) {
      const path = NodePath.join(dir, attachment.id + extension(attachment.name));
      if (attachment.kind === "image") images.push({ path, mediaType: attachment.mediaType });
      // oxlint-disable-next-line no-await-in-loop -- a handful of small files
      else files.push({ name: attachment.name, text: await readFile(path, "utf8") });
    }
    const text = prompt.parts
      .map((part) =>
        part.kind === "text"
          ? part.text
          : part.kind === "taskResults"
            ? this.taskResultsPrompt(chat.id, part.results)
            : "",
      )
      .join("");
    return { prompt: buildPrompt(text, files), images };
  }

  /** Starts a turn in the background; its reply streams in as `message` events. */
  private start(record: ChatRecord, prompt: ChatMessage): void {
    // send() awaited attachments; the agent or settings may have changed since it read the chat.
    const chat = this.store.chat(record.id) ?? record;
    const runtime = this.runtimes.get(chat.settings.agentId)!;
    const controller = new AbortController();
    const reply = new Reply(chat.settings.model);
    const message = (
      status: ChatMessage["status"],
      error: string | null = null,
      finishedAt: number | null = null,
    ): ChatMessage => ({
      id: replyId,
      chatId: chat.id,
      role: "assistant",
      parts: [...reply.parts],
      attachments: [],
      status,
      error,
      agentId: runtime.agentId,
      model: reply.model,
      createdAt,
      finishedAt,
    });
    // A steered message splits the reply: these move on to the reply after it.
    let replyId = randomUUID();
    let createdAt = Date.now();
    let emitTimer: NodeJS.Timeout | undefined;
    let lastSave = 0;
    let finished = false;
    const flush = (save: boolean) => {
      if (finished) return; // A runtime event after the turn ended must not reopen the reply.
      clearTimeout(emitTimer);
      emitTimer = undefined;
      const current = message("streaming");
      if (save || Date.now() - lastSave >= SAVE_MS) {
        lastSave = Date.now();
        this.save(current);
      }
      this.options.emit({ type: "message", message: current });
    };
    const changed = () => {
      if (!finished) emitTimer ??= setTimeout(() => flush(false), EMIT_MS);
    };
    const decide = (requestId: string, answer: RequestAnswer) => {
      const part = reply.parts.find((p) => isRequest(p) && p.id === requestId);
      const feedback = answer.kind === "decline" ? answer.feedback : null;
      if (part?.kind === "question")
        reply.upsert(
          answer.kind === "answers"
            ? { ...part, answers: answer.answers }
            : { ...part, declined: true, feedback },
        );
      else if (part?.kind === "approval" || part?.kind === "plan")
        reply.upsert({
          ...part,
          decision: answer.kind === "decision" ? answer.decision : "deny",
          ...(feedback && { feedback }),
        });
      flush(true);
    };
    const split = (between: () => void) => {
      clearTimeout(emitTimer);
      emitTimer = undefined;
      const done = message("done", null, Date.now());
      this.save(done);
      this.options.emit({ type: "message", message: done });
      between();
      reply.parts = [];
      replyId = randomUUID();
      createdAt = Date.now();
      flush(true);
    };
    const run: Run = {
      controller,
      requests: new Map(),
      reply,
      replyId: () => replyId,
      flush,
      decide,
      split,
    };
    // A stopped turn must not wait on the user: the runtime interrupts only once approve() returns.
    const release = () => {
      for (const resolve of run.requests.values()) resolve({ kind: "decline", feedback: null });
      run.requests.clear();
    };
    /** Shows the request part and waits for the user's answer (decline once the turn stops). */
    const wait = (part: RequestPart): Promise<RequestAnswer> => {
      if (controller.signal.aborted) return Promise.resolve({ kind: "decline", feedback: null });
      reply.upsert(part);
      flush(true);
      const answer = new Promise<RequestAnswer>((resolve) => run.requests.set(part.id, resolve));
      this.emitChat(chat.id); // `waiting`
      return answer;
    };
    controller.signal.addEventListener("abort", release, { once: true });
    this.runs.set(chat.id, run);
    flush(true);
    this.store.touchChat(chat.id);
    this.emitChat(chat.id);

    const sink: TurnSink = {
      session: (id) => {
        this.store.setSession(chat.id, id);
        this.store.setHandoff(chat.id, false);
        this.emitChat(chat.id);
      },
      context: (usage) => {
        const current = this.store.chat(chat.id)?.context;
        if (current?.used === usage.used && current.window === usage.window) return;
        this.store.setContext(chat.id, usage);
        this.emitChat(chat.id);
      },
      text: (delta) => {
        reply.append("text", delta);
        changed();
      },
      reasoning: (delta) => {
        reply.append("reasoning", delta);
        changed();
      },
      tool: (update) => {
        reply.upsert({ kind: "tool", ...update });
        changed();
      },
      model: (id) => {
        reply.model = id;
      },
      approve: async (request) =>
        approval(await wait({ kind: "approval", ...request, decision: null })),
      reviewPlan: async (plan) => approval(await wait({ kind: "plan", ...plan, decision: null })),
      ask: async (request): Promise<QuestionReply> => {
        const answer = await wait({ kind: "question", ...request, answers: null });
        return answer.kind === "answers"
          ? { answers: answer.answers }
          : { declined: true, feedback: answer.kind === "decline" ? answer.feedback : null };
      },
      part: (part) => {
        reply.upsert(part);
        changed();
      },
      subagent: (id, event) => this.subagent(chat, run, id, event),
    };

    void (async () => {
      let status: ChatMessage["status"] = "done";
      let error: string | null = null;
      let cwd = "";
      let before: { turn: number; sha: string } | null = null;
      try {
        const turn = await this.turnInput(chat, prompt);
        const latest = this.store.chat(chat.id) ?? chat;
        // Everything before this prompt; retry already removed the reply after it.
        const messages = this.store.messages(chat.id).filter((m) => m.status !== "queued");
        const index = messages.findIndex((m) => m.id === prompt.id);
        cwd = this.cwd(latest);
        // Normally the previous turn's end snapshot, so nothing is captured before the agent starts.
        before = await this.options.git.baseline(cwd, chat.id).catch((caught: unknown) => {
          this.options.log("could not take a checkpoint", caught);
          return null;
        });
        // Stopped while the baseline was captured: the agent never starts.
        if (!controller.signal.aborted)
          await runtime.run(
            {
              chatId: chat.id,
              cwd,
              sessionId: latest.sessionId,
              settings: latest.settings,
              // A new task chat has no earlier messages: its agent sees the task text only.
              history: buildHandoff(index > 0 ? messages.slice(0, index) : []),
              ...turn,
              ...this.hooks?.extras(latest),
            },
            sink,
            controller.signal,
          );
        if (controller.signal.aborted) status = "stopped";
      } catch (caught) {
        status = controller.signal.aborted ? "stopped" : "error";
        if (status === "error") {
          error =
            caught instanceof ChatRuntimeError ? caught.message : "The agent stopped unexpectedly.";
          if (!(caught instanceof ChatRuntimeError)) this.options.log("turn failed", caught);
        }
      } finally {
        const endedAt = Date.now();
        // Unanswered approvals expire (decision stays null) and the agent hears "deny".
        release();
        finished = true;
        clearTimeout(emitTimer);
        // Still in `runs` meanwhile, so the folder counts as busy until the checkpoint is taken.
        const changes = before && (await this.turnChanges(cwd, chat.id, before));
        if (changes) reply.parts.push(changes);
        this.runs.delete(chat.id);
        const final = message(status, error, endedAt);
        this.save(final);
        this.options.emit({ type: "message", message: final });
        if (this.store.chat(chat.id)) this.store.touchChat(chat.id);
        this.emitChat(chat.id);
        run.done?.();
        this.hooks?.turnEnded(chat.id, final);
        // A stopped or broken turn holds the queue, so a failing agent can't burn through it.
        if (status !== "done") this.held.add(chat.id);
        this.drain(chat.id);
      }
    })();
  }

  /**
   * The turn's end snapshot and its `changes` part (baseline to end), null when no file changed.
   * Never throws: a failed checkpoint is logged and must not fail the turn.
   */
  private async turnChanges(
    cwd: string,
    chatId: string,
    before: { turn: number; sha: string },
  ): Promise<MessagePart | null> {
    const git = this.options.git;
    try {
      // Deleted mid-turn (abort gave up waiting): no changes part, and no end snapshot unless the
      // delete landed while it was being taken.
      const after = this.store.chat(chatId) ? await git.checkpoint(cwd, chatId, before.turn) : null;
      if (!after || !this.store.chat(chatId)) return null;
      const { files, truncated } = await git.turnChanges(cwd, before.sha, after);
      return files.length
        ? { kind: "changes", from: before.sha, to: after, files, truncated }
        : null;
    } catch (error) {
      this.options.log("could not take a checkpoint", error);
      return null;
    }
  }

  /**
   * A native subagent's activity during `parent`'s turn, written into a read-only child chat: a
   * user message with its prompt, then a reply streamed like the turn's own. The agent part
   * `partId` in the parent's reply links to that chat.
   */
  private subagent(parent: ChatRecord, run: Run, partId: string, event: SubagentEvent): void {
    const key = `${parent.id}\n${partId}`;
    if (event.type === "started") return this.startSubagent(parent, run, key, partId, event);
    const transcript = this.transcripts.get(key);
    if (!transcript) return;
    // The user deleted its chat.
    if (!this.store.chat(transcript.chatId)) return void this.transcripts.delete(key);
    const { reply } = transcript;
    if (event.type === "text" || event.type === "reasoning") reply.append(event.type, event.delta);
    else if (event.type === "tool") reply.upsert({ kind: "tool", ...event.update });
    if (event.type !== "ended") return transcript.changed();
    this.transcripts.delete(key);
    const error = event.status === "failed" ? (event.error ?? "The subagent failed.") : null;
    const final = transcript.end(
      event.status === "completed" ? "done" : event.status === "failed" ? "error" : "stopped",
      error,
    );
    const chat = this.store.chat(transcript.chatId);
    if (!chat?.task) return;
    this.store.setTask(chat.id, {
      ...chat.task,
      status: event.status,
      summary: summaryOf(final),
      error,
      finishedAt: final.finishedAt ?? Date.now(),
    });
    this.store.touchChat(chat.id);
    this.emitChat(chat.id);
  }

  private startSubagent(
    record: ChatRecord,
    run: Run,
    key: string,
    partId: string,
    event: Extract<SubagentEvent, { type: "started" }>,
  ): void {
    const parent = this.store.chat(record.id);
    if (!parent || this.transcripts.has(key)) return;
    const task: TaskRecord = {
      status: "running",
      summary: null,
      filesChanged: [],
      error: null,
      finishedAt: null,
      clientRequestId: null,
      parentMessageId: run.replyId(),
      startHead: null,
      dirtyAtStart: [],
      deadline: 0, // No deadline: it ends with its parent's turn.
      delivered: true, // Its result is in the parent's own turn, never delivered.
    };
    // Its parent's folder, named only: delete() never lets it keep or remove a worktree.
    const chat = this.store.createChat(
      randomUUID(),
      parent.projectId,
      chatTitle(event.title),
      parent.settings,
      parent.worktreePath,
      { parentChatId: parent.id, relationship: "subagent", depth: parent.depth + 1 },
      task,
    );
    const now = Date.now();
    const prompt: ChatMessage = {
      id: randomUUID(),
      chatId: chat.id,
      role: "user",
      parts: event.prompt?.trim() ? [{ kind: "text", text: event.prompt.trim() }] : [],
      attachments: [],
      status: "done",
      error: null,
      agentId: null,
      model: null,
      createdAt: now,
    };
    this.save(prompt);
    this.options.emit({ type: "message", message: prompt });

    const reply = new Reply(event.model ?? parent.settings.model);
    const replyId = randomUUID();
    const message = (status: ChatMessage["status"], error: string | null = null): ChatMessage => ({
      id: replyId,
      chatId: chat.id,
      role: "assistant",
      parts: [...reply.parts],
      attachments: [],
      status,
      error,
      agentId: parent.settings.agentId,
      model: reply.model,
      createdAt: now,
      finishedAt: status === "streaming" ? null : Date.now(),
    });
    let emitTimer: NodeJS.Timeout | undefined;
    let lastSave = 0;
    const flush = (save: boolean) => {
      clearTimeout(emitTimer);
      emitTimer = undefined;
      const current = message("streaming");
      if (save || Date.now() - lastSave >= SAVE_MS) {
        lastSave = Date.now();
        this.save(current);
      }
      this.options.emit({ type: "message", message: current });
    };
    this.transcripts.set(key, {
      chatId: chat.id,
      reply,
      flush,
      changed: () => void (emitTimer ??= setTimeout(() => flush(false), EMIT_MS)),
      end: (status, error) => {
        clearTimeout(emitTimer);
        const final = message(status, error);
        this.save(final);
        this.options.emit({ type: "message", message: final });
        return final;
      },
    });
    flush(true);
    this.emitChat(chat.id);
    // Tie the parent's part to the chat; later runtime updates of the part keep the link.
    const part = run.reply.parts.find((p) => p.kind === "tool" && p.id === partId);
    if (part?.kind === "tool") {
      run.reply.upsert({ ...part, chatId: chat.id });
      run.flush(true);
    }
  }

  /** Saves unless the chat was deleted meanwhile. */
  private save(message: ChatMessage): void {
    if (!this.store.chat(message.chatId)) return;
    try {
      this.store.saveMessage(message);
    } catch (error) {
      this.options.log("could not save a message", error);
    }
  }

  /** Stops the chat's turn and waits (at most 10 s) until its reply is saved. */
  async abort(chatId: string): Promise<void> {
    const run = this.runs.get(chatId);
    if (!run) return;
    const done = new Promise<void>((resolve) => (run.done = resolve));
    run.controller.abort();
    await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  }

  // Git

  gitStatus(ref: unknown) {
    return this.options.git.status(this.workspaceCwd(ref));
  }

  gitBranches(ref: unknown) {
    return this.options.git.branches(this.workspaceCwd(ref));
  }

  gitSwitch(ref: unknown, branch: unknown) {
    if (typeof branch !== "string" || !branch || branch.length > 250)
      throw new ChatRuntimeError("Choose a branch.");
    const cwd = this.workspaceCwd(ref);
    // An agent working in this folder would have its files changed underneath it.
    if (this.busy(cwd))
      throw new ChatRuntimeError("Wait for the running turn to finish before switching branches.");
    return this.options.git.switchBranch(cwd, branch);
  }

  // Side tools

  /** The folder a workspace ref names: a chat's working folder, or a project's own folder. */
  workspaceCwd(ref: unknown): string {
    const projectId = typeof ref === "string" ? projectIdOf(ref) : null;
    return projectId ? this.project(projectId).path : this.cwd(this.chat(ref));
  }

  /** Whether a turn is running with `cwd` as its working folder. */
  busy(cwd: string): boolean {
    for (const id of this.runs.keys()) {
      const other = this.store.chat(id);
      const folder = other && (other.worktreePath ?? this.store.project(other.projectId)?.path);
      if (folder && overlaps(folder, cwd)) return true;
    }
    for (const folder of this.rewinding.values()) if (folder && overlaps(folder, cwd)) return true;
    return false;
  }

  github(ref: unknown) {
    return this.options.github.info(this.workspaceCwd(ref));
  }

  dispose(): void {
    for (const run of this.runs.values()) run.controller.abort();
    for (const runtime of this.runtimes.values()) runtime.dispose();
  }
}
