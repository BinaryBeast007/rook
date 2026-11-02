// Chats: projects (folders the user picked), conversations that run a coding agent inside one,
// their messages, and the live events the main process pushes while an agent works.

/** A folder the user picked with the native dialog. Agents only ever run inside one. */
export interface Project {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

/** Agents Rook can chat with. Each drives its own official runtime and keeps its own sign-in. */
export type ChatAgentId = "claude" | "codex";

/**
 * How much an agent may do without asking. Not every agent supports every mode; see
 * `AgentCatalog.accessModes`.
 * - `ask`: the agent asks before editing files or running commands.
 * - `edit`: edits inside the project run without asking; other actions still ask.
 * - `auto`: the agent's own reviewer approves or blocks actions, asking only when unsure.
 * - `full`: no prompts and no sandbox. Only ever set by an explicit user choice.
 */
export type AccessMode = "ask" | "edit" | "auto" | "full";

export interface ChatSettings {
  readonly agentId: ChatAgentId;
  /** A model id from the agent's catalog; null uses the agent's default. */
  readonly model: string | null;
  /** A reasoning effort the model supports; null uses the model's default. */
  readonly effort: string | null;
  /** The agent's faster, higher-usage tier, where the model has one. */
  readonly fast: boolean;
  readonly access: AccessMode;
  /**
   * Plan mode: the agent researches and proposes a plan (a `plan` part) instead of changing
   * anything. Absent on settings saved before plan mode existed, which means off.
   */
  readonly plan?: boolean;
}

export interface ModelOption {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** Reasoning efforts in increasing order; empty when the model has no effort setting. */
  readonly efforts: readonly string[];
  readonly defaultEffort: string | null;
  /** The model has a fast tier. */
  readonly fast: boolean;
  /** The model supports the `auto` access mode. */
  readonly auto: boolean;
  /** The model accepts image attachments. */
  readonly images: boolean;
  readonly isDefault: boolean;
  /** An older model the agent still runs; the picker tucks these behind "Legacy models". */
  readonly legacy: boolean;
}

/**
 * How full the agent's context window is, as the agent itself last reported it. Absent until a
 * turn reports usage, and reset when the chat hands over to another agent.
 */
export interface ContextUsage {
  /** Tokens the conversation occupies now. */
  readonly used: number;
  /** The model's context window in tokens. */
  readonly window: number;
}

/** What one agent offers right now, read from the agent itself. */
export interface AgentCatalog {
  readonly agentId: ChatAgentId;
  readonly models: readonly ModelOption[];
  readonly accessModes: readonly AccessMode[];
  /** Why the list is empty or stale, safe to show. */
  readonly error: string | null;
  /** A message sent while a turn runs can join that turn (`SendInput.mode` "steer"). */
  readonly steering: boolean;
}

/**
 * Where a delegated task stands. `timedOut`: it ran past its time limit. `interrupted`: Rook
 * closed while it ran.
 */
export type TaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timedOut"
  | "interrupted";

/**
 * How a chat that another chat's agent started relates to that chat. A "task" is a delegated
 * task (its own turns, its own composer). A "subagent" is one of the agent's native subagents:
 * Rook writes its transcript into the child chat as it runs, and the child never runs a turn of
 * its own, so it is read-only.
 */
export interface ChatLineage {
  readonly parentChatId: string;
  readonly relationship: "task" | "subagent";
  /** 1 for a task of a top-level chat. */
  readonly depth: number;
}

/** A delegated task or native subagent, carried by the child chat that runs it. */
export interface ChatTask {
  readonly status: TaskStatus;
  /** The child's final reply, trimmed; null while running. */
  readonly summary: string | null;
  /** Relative to the child's folder. */
  readonly filesChanged: readonly string[];
  /** The agent's own error, safe to show. */
  readonly error: string | null;
  /** Epoch milliseconds. */
  readonly finishedAt: number | null;
}

/** A finished task as handed back to its parent; kept after the child chat is gone. */
export interface TaskResult extends ChatTask {
  /** The child chat's id. */
  readonly taskId: string;
  readonly title: string;
}

export interface ChatSummary {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly settings: ChatSettings;
  /** Where the agent works: the project folder, or this chat's own git worktree. */
  readonly cwd: string;
  /** The chat has its own worktree (on its own branch), so it never touches other chats' files. */
  readonly worktree: boolean;
  /** The agent has a session for this chat. */
  readonly started: boolean;
  /**
   * The chat switched agents: its next turn starts a fresh session on the new agent and hands it
   * the conversation so far as context.
   */
  readonly handoff: boolean;
  /** Null when the agent has not reported usage for this session. */
  readonly context: ContextUsage | null;
  /** An agent turn is running now. */
  readonly running: boolean;
  /** Set when another chat's agent started this chat as a task. */
  readonly lineage: ChatLineage | null;
  /** Set on task chats. */
  readonly task: ChatTask | null;
  /**
   * The approval, question or plan the agent waits for, so the parent's task card can show it
   * (and answer an approval) too.
   */
  readonly waiting: {
    readonly approvalId: string;
    /** Absent on summaries from before questions existed: "approval". */
    readonly kind?: "approval" | "question" | "plan";
    readonly title: string;
    /** The approval's `subagent`: the `agent` part whose native subagent asks. */
    readonly subagent?: string;
  } | null;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type ApprovalDecision = "allow" | "allowSession" | "deny";

/** One choice of a question. */
export interface QuestionOption {
  readonly label: string;
  readonly description: string | null;
}

/** One question an agent asks the user. */
export interface Question {
  /** Unique within its part; answers are keyed by it. */
  readonly id: string;
  /** A short tag, e.g. "Auth method"; null when the agent gives none. */
  readonly header: string | null;
  /** Markdown. */
  readonly question: string;
  /** Empty for a free-text question. */
  readonly options: readonly QuestionOption[];
  /** More than one option may be picked. */
  readonly multiSelect: boolean;
  /** The user may type their own answer instead of (or beside) the options. */
  readonly allowCustom: boolean;
}

/** The user's answer to one question: the option labels they picked, and/or their own text. */
export interface QuestionAnswer {
  readonly selected: readonly string[];
  /** Null when they only picked options. */
  readonly text: string | null;
}

/** How the user answers a request the agent waits on (`ChatBridge.answer`). */
export type RequestAnswer =
  /** An approval's decision. */
  | { readonly kind: "decision"; readonly decision: ApprovalDecision }
  /** A question's answers, by question id; every question needs one. */
  | { readonly kind: "answers"; readonly answers: Readonly<Record<string, QuestionAnswer>> }
  /**
   * Declines an approval, question or plan. `feedback` tells the agent what to do instead, e.g.
   * "use pnpm, not npm" or "also cover Windows"; null declines without a word.
   */
  | { readonly kind: "decline"; readonly feedback: string | null };

/** One step of an agent's task list. */
export interface TodoItem {
  readonly text: string;
  readonly status: "pending" | "inProgress" | "completed";
}

export type ToolStatus = "running" | "done" | "failed" | "declined";

/** One file a tool call or a turn changed. Counts are lines; null for a binary file. */
export interface FileChange {
  /** Relative to the chat's folder, `/`-separated. */
  readonly path: string;
  readonly additions: number | null;
  readonly deletions: number | null;
}

export type MessagePart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly id: string;
      /**
       * Tool kind for the icon, e.g. "command", "edit", "read", "search", "web", "mcp", "other".
       * "task" is a delegated task's card, written by Rook: `id` is the child chat's id, `detail`
       * the task prompt, `output` its summary. Status: running → running, completed → done,
       * cancelled → declined, failed / timedOut / interrupted → failed.
       */
      readonly tool: string;
      /** One line, e.g. "Run npm test" or "Edit src/app.ts". */
      readonly title: string;
      /** The command, diff, or arguments; truncated. */
      readonly detail: string | null;
      /** What the tool returned; truncated. */
      readonly output: string | null;
      readonly status: ToolStatus;
      /** Files an edit tool changed, as the agent reported them. Absent on other tools. */
      readonly files?: readonly FileChange[];
      /** For an "agent" part: the subagent chat holding its transcript, once Rook made one. */
      readonly chatId?: string;
      /** A finished command's exit code; absent on other tools and older messages. */
      readonly exitCode?: number | null;
    }
  | {
      readonly kind: "approval";
      readonly id: string;
      readonly title: string;
      readonly detail: string | null;
      readonly options: readonly ApprovalDecision[];
      /** Null while the agent waits for an answer. */
      readonly decision: ApprovalDecision | null;
      /** The id of the `agent` tool part whose native subagent asks, when one does. */
      readonly subagent?: string;
      /** What is asked for, as a tool part's `tool` kind ("command", "edit", "mcp", …). */
      readonly tool?: string;
      /** Why the agent asks, in its own words; safe to show. */
      readonly reason?: string | null;
      /** The tool part this approval is for, when the agent says. */
      readonly toolId?: string;
      /** With a "deny" decision: what the user told the agent to do instead. */
      readonly feedback?: string | null;
    }
  /** Questions the agent asks; it waits until they are answered or declined. */
  | {
      readonly kind: "question";
      readonly id: string;
      readonly questions: readonly Question[];
      /** By question id; null while unanswered (waiting, declined, or expired with the turn). */
      readonly answers: Readonly<Record<string, QuestionAnswer>> | null;
      /** The user declined to answer. */
      readonly declined?: boolean;
      /** With `declined`: what the user told the agent instead. */
      readonly feedback?: string | null;
      /** The id of the `agent` tool part whose native subagent asks, when one does. */
      readonly subagent?: string;
    }
  /**
   * A plan the agent proposes, as markdown. `decision` is present when the agent waits for the
   * user to accept it ("allow": go ahead; "deny": refine, with `feedback`); null while it waits.
   * A plan without `decision` is only proposed; the user follows up with a message.
   */
  | {
      readonly kind: "plan";
      readonly id: string;
      readonly text: string;
      readonly decision?: ApprovalDecision | null;
      readonly feedback?: string | null;
    }
  /** The agent's task list as it last reported it. */
  | { readonly kind: "todo"; readonly id: string; readonly items: readonly TodoItem[] }
  /**
   * Something the agent reported that is not part of its answer: a warning, a retry, a usage
   * limit, a context compaction. A later notice with the same id replaces it (e.g. a retry count).
   */
  | {
      readonly kind: "notice";
      readonly id: string;
      readonly level: "info" | "warning" | "error";
      /** One line, safe to show. */
      readonly text: string;
      readonly detail: string | null;
    }
  /** Finished tasks, in a user message Rook writes to hand their results to the parent. */
  | { readonly kind: "taskResults"; readonly results: readonly TaskResult[] }
  /**
   * What the turn changed in the chat's folder, written by Rook at the end of a reply in a git
   * repository. `from` and `to` are checkpoint commits taken before and after the turn (see
   * `ChangesBridge.rangeFiles`); only written when at least one file changed.
   */
  | {
      readonly kind: "changes";
      readonly from: string;
      readonly to: string;
      readonly files: readonly FileChange[];
      /** More files changed than `files` lists. */
      readonly truncated: boolean;
    };

export interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly kind: "image" | "text";
  readonly mediaType: string;
  /** Bytes. */
  readonly size: number;
}

/**
 * "streaming" is still arriving, "stopped" was cut short, "error" failed part way. "queued" is a
 * user message waiting for the running turn to end.
 */
export type ChatMessageStatus = "streaming" | "done" | "stopped" | "error" | "queued";

export interface ChatMessage {
  readonly id: string;
  readonly chatId: string;
  readonly role: "user" | "assistant";
  readonly parts: readonly MessagePart[];
  readonly attachments: readonly Attachment[];
  readonly status: ChatMessageStatus;
  /** Why an "error" message failed, safe to show. */
  readonly error: string | null;
  /** The agent and model that wrote an assistant reply. */
  readonly agentId: ChatAgentId | null;
  readonly model: string | null;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** When an assistant reply stopped streaming, epoch milliseconds. Absent on older messages. */
  readonly finishedAt?: number | null;
}

/** A file the user attached, as bytes from the renderer. */
export interface AttachmentUpload {
  readonly name: string;
  readonly mediaType: string;
  readonly data: Uint8Array;
}

export const ATTACHMENT_LIMITS = {
  maxFiles: 10,
  imageBytes: 10 * 1024 * 1024,
  textBytes: 512 * 1024,
  imageTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
} as const;

export interface SendInput {
  readonly text: string;
  readonly attachments: readonly AttachmentUpload[];
  /**
   * While a turn runs: "queue" (the default) waits for it to end; "steer" joins the running turn
   * where the agent supports it (`AgentCatalog.steering`), else queues.
   */
  readonly mode?: "queue" | "steer";
}

/** A merge, rebase, etc. that git has stopped part way, e.g. on a conflict. */
export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";

export interface GitStatus {
  readonly isRepo: boolean;
  /** Display name: "owner/repo" from the origin remote, else the repository folder's name. */
  readonly repo: string | null;
  /** Null when HEAD is detached. */
  readonly branch: string | null;
  readonly ahead: number;
  readonly behind: number;
  /** Files with uncommitted changes. */
  readonly changed: number;
  /** Files with unresolved merge conflicts. */
  readonly conflicts: number;
  readonly operation: GitOperation | null;
}

/**
 * GitHub, through the user's own GitHub CLI (`gh`) sign-in. Rook never reads or holds the token.
 * - `ready`: signed in, and the repo's origin is on GitHub.
 * - `notGitHub`: the repo has no GitHub origin, so there is nothing to ask GitHub.
 * - `missing`: the GitHub CLI is not installed.
 * - `signedOut`: `gh` is installed but not signed in, or its sign-in expired.
 * - `error`: GitHub could not be reached or refused; `message` says why.
 */
export interface GitHubInfo {
  readonly status: "ready" | "notGitHub" | "missing" | "signedOut" | "error";
  /** "owner/repo" when the origin is on GitHub. */
  readonly repo: string | null;
  /** https URL of the repository on GitHub. */
  readonly url: string | null;
  /** The pull request for the current branch, when there is one. */
  readonly pullRequest: {
    readonly number: number;
    readonly title: string;
    readonly state: "open" | "closed" | "merged" | "draft";
    readonly url: string;
  } | null;
  /** Safe to show. */
  readonly message: string | null;
}

/** Pushed by the main process. */
export type ChatEvent =
  /** A message was added or changed. Replaces any earlier copy with the same id. */
  | { readonly type: "message"; readonly message: ChatMessage }
  /** A chat's summary changed (title, settings, running). */
  | { readonly type: "chat"; readonly chat: ChatSummary }
  | { readonly type: "chatDeleted"; readonly chatId: string }
  /** A project left Rook (its chats' `chatDeleted` events come first). */
  | { readonly type: "projectRemoved"; readonly projectId: string }
  /** Retry removed a reply before running the prompt again. */
  | { readonly type: "messageDeleted"; readonly chatId: string; readonly messageId: string };

export interface ChatBridge {
  projects(): Promise<Project[]>;
  /** Shows the folder picker. Resolves to the project (existing or new), or null if cancelled. */
  addProject(): Promise<Project | null>;
  /** Removes the project and its chats from Rook. Nothing on disk changes. */
  removeProject(projectId: string): Promise<void>;
  chats(): Promise<ChatSummary[]>;
  /**
   * `worktree`: give the chat its own git worktree on a new branch (from the project's current
   * HEAD), so parallel chats never edit the same files. Rejects when the project is not a repo.
   * `joinChat`: work in that chat's worktree instead (a worktree is removed with its last chat).
   */
  create(
    projectId: string,
    settings: ChatSettings,
    options?: { readonly worktree?: boolean; readonly joinChat?: string },
  ): Promise<ChatSummary>;
  rename(chatId: string, title: string): Promise<void>;
  /**
   * Deletes the chat and its history. A worktree is removed only when it has no uncommitted
   * changes; otherwise it stays on disk (resolves to its path) along with its branch.
   */
  delete(chatId: string): Promise<{ readonly keptWorktree: string | null }>;
  /**
   * Applies to the next turn. Changing the agent of a started chat clears its session and sets
   * `handoff`; that rejects while a turn runs.
   */
  updateSettings(chatId: string, settings: ChatSettings): Promise<ChatSummary>;
  messages(chatId: string): Promise<ChatMessage[]>;
  /** Starts a turn. Rejects with a message safe to show when it cannot start. */
  send(chatId: string, input: SendInput): Promise<void>;
  stop(chatId: string): Promise<void>;
  /** Runs the last prompt again, replacing the reply that failed or was stopped. */
  retry(chatId: string): Promise<void>;
  /**
   * Removes a sent user message and everything after it (queued messages stay), and resolves to
   * its text for the composer; its attachments are not restored. The agent's session restarts,
   * handed the history left. `revertFiles` also puts the chat's folder back as it was before the
   * first removed turn that changed files, after saving the folder as it is under
   * `refs/rook/rewind/`; HEAD, the branch and the index are untouched. Rejects with a message safe
   * to show while a turn runs, in a subagent's chat, or when a merge or rebase is in progress.
   */
  rewind(
    chatId: string,
    messageId: string,
    options: { readonly revertFiles: boolean },
  ): Promise<{ readonly text: string }>;
  /**
   * Answers the approval, question or plan with this id that the chat's agent waits on. Rejects
   * with a message safe to show when it has ended or the answer does not fit it.
   */
  answer(chatId: string, requestId: string, answer: RequestAnswer): Promise<void>;
  /** Starts a queued message now, or removes it from the queue. */
  dequeue(chatId: string, messageId: string, action: "send" | "remove"): Promise<void>;
  /** Bytes of an attachment, e.g. to preview an image. */
  attachment(chatId: string, attachmentId: string): Promise<Uint8Array>;
  catalog(agentId: ChatAgentId, refresh?: boolean): Promise<AgentCatalog>;
  /** Calls `listener` with every change. Returns an unsubscribe function. */
  subscribe(listener: (event: ChatEvent) => void): () => void;
  /** Git state of the chat's working folder (`ChatSummary.cwd`). */
  gitStatus(chatId: string): Promise<GitStatus>;
  gitBranches(chatId: string): Promise<string[]>;
  /**
   * Checks out a local branch in the chat's folder. For a project-folder chat this affects every
   * other project-folder chat of that project. Rejects with a reason safe to show when a turn uses
   * the folder, a merge or rebase is in progress, there are conflicts, or git refuses (e.g. local
   * changes would be overwritten, or the branch is checked out in another worktree).
   */
  gitSwitch(chatId: string, branch: string): Promise<GitStatus>;
  /** GitHub details for the chat's repo via the GitHub CLI. Never rejects. */
  github(chatId: string): Promise<GitHubInfo>;
}
