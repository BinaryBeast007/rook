// Chat history in SQLite (Node's built-in node:sqlite, so no native module to build). The main
// process owns it: turns keep running and saving while the renderer reloads or closes.
import { DatabaseSync } from "node:sqlite";

import type {
  ChatLineage,
  ChatMessage,
  ChatSettings,
  ChatTask,
  ContextUsage,
  Project,
  TaskResult,
} from "@rook/contracts";

/** A delegated task as the desktop keeps it on its child chat. */
export interface TaskRecord extends ChatTask {
  readonly clientRequestId: string | null;
  /** The parent reply holding the task card. */
  readonly parentMessageId: string | null;
  readonly startHead: string | null;
  /** Shared-folder children only. */
  readonly dirtyAtStart: readonly string[];
  /** Epoch milliseconds. */
  readonly deadline: number;
  /** In the parent's queue, or never will be (the parent cancelled it). */
  readonly delivered: boolean;
}

export interface ChatRecord {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly settings: ChatSettings;
  /** The agent's own session (Claude) or thread (Codex) id, once a turn has started one. */
  readonly sessionId: string | null;
  /** The chat's own git worktree; null when it works in the project folder. */
  readonly worktreePath: string | null;
  /** The latest context-window usage the agent reported for its session. */
  readonly context: ContextUsage | null;
  /** The chat switched agents and the new one has not started its session yet. */
  readonly handoff: boolean;
  /** Null for a top-level chat, and once its parent is deleted. */
  readonly lineage: ChatLineage | null;
  /** Kept when the parent is deleted, so a task can never escalate to top-level depth. */
  readonly depth: number;
  readonly task: TaskRecord | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const SCHEMA_VERSION = 4;

const SCHEMA = `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    settings TEXT NOT NULL,
    session_id TEXT,
    worktree_path TEXT,
    context TEXT,
    handoff INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    parent_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
    relationship TEXT,
    depth INTEGER NOT NULL DEFAULT 0,
    task TEXT
  );
  CREATE INDEX chats_updated ON chats(updated_at DESC);
  CREATE INDEX chats_parent ON chats(parent_chat_id);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    parts TEXT NOT NULL,
    attachments TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    agent_id TEXT,
    model TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX messages_chat ON messages(chat_id, seq);
`;

// UPGRADES[n - 1] takes a version n database to n + 1. A new database gets SCHEMA instead.
const UPGRADES = [
  "ALTER TABLE chats ADD COLUMN context TEXT; ALTER TABLE chats ADD COLUMN handoff INTEGER NOT NULL DEFAULT 0;",
  `ALTER TABLE chats ADD COLUMN parent_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL;
   ALTER TABLE chats ADD COLUMN relationship TEXT;
   ALTER TABLE chats ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE chats ADD COLUMN task TEXT;
   CREATE INDEX chats_parent ON chats(parent_chat_id);`,
  "ALTER TABLE messages ADD COLUMN finished_at INTEGER;",
];

type Row = Record<string, unknown>;

const text = (value: unknown) => String(value);
const nullable = (value: unknown) => (value === null || value === undefined ? null : String(value));

function toProject(row: Row): Project {
  return { id: text(row.id), name: text(row.name), path: text(row.path) };
}

function toChat(row: Row): ChatRecord {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    title: text(row.title),
    settings: JSON.parse(text(row.settings)) as ChatSettings,
    sessionId: nullable(row.session_id),
    worktreePath: nullable(row.worktree_path),
    context: row.context ? (JSON.parse(text(row.context)) as ContextUsage) : null,
    handoff: Number(row.handoff) === 1,
    lineage: row.parent_chat_id
      ? {
          parentChatId: text(row.parent_chat_id),
          relationship: text(row.relationship) as ChatLineage["relationship"],
          depth: Number(row.depth),
        }
      : null,
    depth: Number(row.depth),
    task: row.task ? (JSON.parse(text(row.task)) as TaskRecord) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toMessage(row: Row): ChatMessage {
  return {
    id: text(row.id),
    chatId: text(row.chat_id),
    role: text(row.role) as ChatMessage["role"],
    parts: JSON.parse(text(row.parts)) as ChatMessage["parts"],
    attachments: JSON.parse(text(row.attachments)) as ChatMessage["attachments"],
    status: text(row.status) as ChatMessage["status"],
    error: nullable(row.error),
    agentId: nullable(row.agent_id) as ChatMessage["agentId"],
    model: nullable(row.model),
    createdAt: Number(row.created_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
  };
}

export type ChatStore = ReturnType<typeof openChatStore>;

/** Opens (creating or migrating) the database. `file` may be ":memory:" for tests. */
export function openChatStore(file: string) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
  const version = Number((db.prepare("PRAGMA user_version").get() as Row).user_version);
  if (version > SCHEMA_VERSION) throw new Error(`Chat history is from a newer Rook (v${version}).`);
  if (version < SCHEMA_VERSION) {
    const upgrade = version === 0 ? SCHEMA : UPGRADES.slice(version - 1).join(" ");
    db.exec(`BEGIN; ${upgrade} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
  }
  // A reply that was streaming when Rook quit can never finish.
  db.exec("UPDATE messages SET status = 'stopped' WHERE status = 'streaming'");

  const q = {
    projects: db.prepare("SELECT * FROM projects ORDER BY created_at"),
    project: db.prepare("SELECT * FROM projects WHERE id = ?"),
    projectByPath: db.prepare("SELECT * FROM projects WHERE path = ?"),
    addProject: db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)"),
    removeProject: db.prepare("DELETE FROM projects WHERE id = ?"),
    chats: db.prepare("SELECT * FROM chats ORDER BY updated_at DESC"),
    chat: db.prepare("SELECT * FROM chats WHERE id = ?"),
    addChat: db.prepare(
      "INSERT INTO chats (id, project_id, title, settings, session_id, worktree_path, created_at, updated_at, parent_chat_id, relationship, depth, task) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)",
    ),
    children: db.prepare("SELECT * FROM chats WHERE parent_chat_id = ? ORDER BY created_at"),
    taskByRequest: db.prepare(
      "SELECT * FROM chats WHERE parent_chat_id = ? AND json_extract(task, '$.clientRequestId') = ?",
    ),
    runningTasks: db.prepare(
      "SELECT * FROM chats WHERE json_extract(task, '$.status') = 'running' ORDER BY depth DESC",
    ),
    task: db.prepare("UPDATE chats SET task = ? WHERE id = ?"),
    rename: db.prepare("UPDATE chats SET title = ? WHERE id = ?"),
    settings: db.prepare("UPDATE chats SET settings = ? WHERE id = ?"),
    session: db.prepare("UPDATE chats SET session_id = ? WHERE id = ?"),
    context: db.prepare("UPDATE chats SET context = ? WHERE id = ?"),
    handoff: db.prepare("UPDATE chats SET handoff = ? WHERE id = ?"),
    touch: db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?"),
    deleteChat: db.prepare("DELETE FROM chats WHERE id = ?"),
    messages: db.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY seq"),
    message: db.prepare("SELECT * FROM messages WHERE id = ?"),
    nextSeq: db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE chat_id = ?"),
    insertMessage: db.prepare(
      "INSERT INTO messages (id, chat_id, seq, role, parts, attachments, status, error, agent_id, model, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    updateMessage: db.prepare(
      "UPDATE messages SET parts = ?, attachments = ?, status = ?, error = ?, model = ?, finished_at = ? WHERE id = ?",
    ),
    deleteMessage: db.prepare("DELETE FROM messages WHERE id = ?"),
    queued: db.prepare(
      "SELECT * FROM messages WHERE chat_id = ? AND status = 'queued' ORDER BY seq",
    ),
    dequeue: db.prepare(
      "UPDATE messages SET status = 'done', seq = (SELECT MAX(seq) + 1 FROM messages AS m WHERE m.chat_id = messages.chat_id) WHERE id = ?",
    ),
    dropTaskDeliveries: db.prepare(
      "DELETE FROM messages WHERE chat_id = ? AND status = 'queued' AND EXISTS (SELECT 1 FROM json_each(parts) WHERE json_extract(value, '$.kind') = 'taskResults') RETURNING id",
    ),
  };

  /** Inserts a new message at the end of its chat, or updates the stored copy. */
  function saveMessage(message: ChatMessage): void {
    const parts = JSON.stringify(message.parts);
    const attachments = JSON.stringify(message.attachments);
    const changed = q.updateMessage.run(
      parts,
      attachments,
      message.status,
      message.error,
      message.model,
      message.finishedAt ?? null,
      message.id,
    ).changes;
    if (changed) return;
    const { seq } = q.nextSeq.get(message.chatId) as { seq: number };
    q.insertMessage.run(
      message.id,
      message.chatId,
      seq,
      message.role,
      parts,
      attachments,
      message.status,
      message.error,
      message.agentId,
      message.model,
      message.createdAt,
      message.finishedAt ?? null,
    );
  }

  const transaction = <T>(run: () => T): T => {
    db.exec("BEGIN");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  return {
    projects: () => (q.projects.all() as Row[]).map(toProject),
    project: (id: string) => {
      const row = q.project.get(id) as Row | undefined;
      return row ? toProject(row) : null;
    },
    /** The project for `path`, adding it if it is new. */
    addProject(id: string, name: string, path: string): Project {
      const existing = q.projectByPath.get(path) as Row | undefined;
      if (existing) return toProject(existing);
      q.addProject.run(id, name, path, Date.now());
      return { id, name, path };
    },
    removeProject: (id: string) => void q.removeProject.run(id),

    chats: () => (q.chats.all() as Row[]).map(toChat),
    chat: (id: string) => {
      const row = q.chat.get(id) as Row | undefined;
      return row ? toChat(row) : null;
    },
    createChat(
      id: string,
      projectId: string,
      title: string,
      settings: ChatSettings,
      worktreePath: string | null = null,
      lineage: ChatLineage | null = null,
      task: TaskRecord | null = null,
    ): ChatRecord {
      const now = Date.now();
      const depth = lineage?.depth ?? 0;
      q.addChat.run(
        id,
        projectId,
        title,
        JSON.stringify(settings),
        worktreePath,
        now,
        now,
        lineage?.parentChatId ?? null,
        lineage?.relationship ?? null,
        depth,
        task && JSON.stringify(task),
      );
      return {
        id,
        projectId,
        title,
        settings,
        sessionId: null,
        worktreePath,
        context: null,
        handoff: false,
        lineage,
        depth,
        task,
        createdAt: now,
        updatedAt: now,
      };
    },
    setTask: (id: string, task: TaskRecord | null) =>
      void q.task.run(task && JSON.stringify(task), id),
    /** Chats started as tasks of `parentId`, oldest first. */
    children: (parentId: string) => (q.children.all(parentId) as Row[]).map(toChat),
    taskByRequest: (parentId: string, clientRequestId: string) => {
      const row = q.taskByRequest.get(parentId, clientRequestId) as Row | undefined;
      return row ? toChat(row) : null;
    },
    /** Chats whose task is running, deepest first, so children finish before their parents. */
    runningTasks: () => (q.runningTasks.all() as Row[]).map(toChat),
    renameChat: (id: string, title: string) => void q.rename.run(title, id),
    setSettings: (id: string, settings: ChatSettings) =>
      void q.settings.run(JSON.stringify(settings), id),
    setSession: (id: string, sessionId: string | null) => void q.session.run(sessionId, id),
    setContext: (id: string, usage: ContextUsage | null) =>
      void q.context.run(usage && JSON.stringify(usage), id),
    setHandoff: (id: string, handoff: boolean) => void q.handoff.run(handoff ? 1 : 0, id),
    touchChat: (id: string, at = Date.now()) => void q.touch.run(at, id),
    deleteChat: (id: string) => void q.deleteChat.run(id),

    messages: (chatId: string) => (q.messages.all(chatId) as Row[]).map(toMessage),
    message: (id: string) => {
      const row = q.message.get(id) as Row | undefined;
      return row ? toMessage(row) : null;
    },
    saveMessage,
    deleteMessage: (id: string) => void q.deleteMessage.run(id),
    /** The chat's queued user messages, in the order they were sent. */
    queued: (chatId: string) => (q.queued.all(chatId) as Row[]).map(toMessage),
    /** Marks a queued message sent and moves it to the end, after the replies before it. */
    dequeue: (id: string) => void q.dequeue.run(id),
    /**
     * Stores the child's finished task as delivered and, given `delivery`, hands its result to
     * the parent: appended to the parent's queued taskResults message, or in a new queued message
     * with id `delivery.messageId`. One transaction, so a result is never delivered twice. Returns
     * the parent's message, or null when nothing was delivered (no delivery, parent gone, or
     * delivered before).
     */
    finishTask(
      childId: string,
      task: TaskRecord,
      delivery: { readonly messageId: string; readonly result: TaskResult } | null,
    ): ChatMessage | null {
      return transaction(() => {
        const row = q.chat.get(childId) as Row | undefined;
        if (!row) return null;
        const child = toChat(row);
        q.task.run(JSON.stringify({ ...task, delivered: true }), childId);
        const parentId = child.lineage?.parentChatId;
        if (!delivery || !parentId || child.task?.delivered) return null;
        const pending = (q.queued.all(parentId) as Row[])
          .map(toMessage)
          .find((message) => message.parts[0]?.kind === "taskResults");
        const part = pending?.parts[0];
        const results = part?.kind === "taskResults" ? [...part.results, delivery.result] : [];
        const message: ChatMessage = pending
          ? { ...pending, parts: [{ kind: "taskResults", results }] }
          : {
              id: delivery.messageId,
              chatId: parentId,
              role: "user",
              parts: [{ kind: "taskResults", results: [delivery.result] }],
              attachments: [],
              status: "queued",
              error: null,
              agentId: null,
              model: null,
              createdAt: Date.now(),
            };
        saveMessage(message);
        return message;
      });
    },
    /**
     * Deletes the chat's queued taskResults messages (Rook writes them with that one part only)
     * and returns their ids.
     */
    dropTaskDeliveries: (chatId: string) =>
      (q.dropTaskDeliveries.all(chatId) as Row[]).map((row) => text(row.id)),
    close: () => db.close(),
  };
}
