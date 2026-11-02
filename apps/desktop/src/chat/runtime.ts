// The seam between the chat service and each agent's official runtime. A runtime only talks to
// its agent; the ChatService owns persistence, message assembly, and the renderer.
import type {
  AccessMode,
  AgentCatalog,
  ApprovalDecision,
  ChatAgentId,
  ChatSettings,
  ContextUsage,
  FileChange,
  MessagePart,
  Question,
  QuestionAnswer,
  ToolStatus,
} from "@rook/contracts";

/** An image saved under Rook's data directory, passed to the agent by path or bytes. */
export interface TurnImage {
  readonly path: string;
  readonly mediaType: string;
}

/**
 * Rook's MCP server for one chat. The registry keeps only token hashes, so the runtime holds the
 * raw token with the process or thread it handed it to.
 */
export interface McpAccess {
  readonly url: string;
  /** Issues a new token for the chat and revokes its previous one. */
  credential(): string;
  /** False once the token is revoked or expired: respawn or re-resume with `credential()`. */
  live(token: string): boolean;
}

export interface TurnInput {
  readonly chatId: string;
  /** The project folder: the agent's working directory. */
  readonly cwd: string;
  /** The agent's own session (Claude) or thread (Codex) id from an earlier turn, if any. */
  readonly sessionId: string | null;
  readonly settings: ChatSettings;
  /** The prompt, with any text attachments already inlined. */
  readonly prompt: string;
  readonly images: readonly TurnImage[];
  /**
   * The earlier conversation as handoff text (see buildHandoff), null when there is none. Runtimes
   * put it in front of the prompt only when they start a new session for the chat.
   */
  readonly history: string | null;
  /** Rook's MCP server (delegation tools) for this chat; absent or null when it gets none. */
  readonly mcp?: McpAccess | null;
  /** Extra system instructions from Rook, e.g. delegation guidance. */
  readonly instructions?: string | null;
}

export interface ToolUpdate {
  readonly id: string;
  readonly tool: string;
  readonly title: string;
  readonly detail: string | null;
  readonly output: string | null;
  readonly status: ToolStatus;
  /** Files an edit tool changed (relative to the turn's cwd), when the agent reports them. */
  readonly files?: readonly FileChange[];
  /** A finished command's exit code, when the agent reports one. */
  readonly exitCode?: number | null;
}

/**
 * A native subagent's own activity, so Rook can keep its transcript in a chat of its own. Its
 * steps still fold into the parent's `agent` tool part as before.
 */
export type SubagentEvent =
  | {
      readonly type: "started";
      readonly title: string;
      /** What the parent asked it to do. */
      readonly prompt: string | null;
      readonly model: string | null;
    }
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "reasoning"; readonly delta: string }
  | { readonly type: "tool"; readonly update: ToolUpdate }
  | {
      readonly type: "ended";
      readonly status: "completed" | "failed" | "cancelled";
      /** The agent's own error, safe to show. */
      readonly error: string | null;
    };

export interface ApprovalRequest {
  readonly id: string;
  readonly title: string;
  readonly detail: string | null;
  readonly options: readonly ApprovalDecision[];
  /** The id of the `agent` tool part whose native subagent asks, when one does. */
  readonly subagent?: string;
  /** What is asked for, as a tool part's `tool` kind ("command", "edit", "mcp", …). */
  readonly tool?: string;
  /** Why the agent asks, in its own words. */
  readonly reason?: string | null;
  /** The tool part this approval is for. */
  readonly toolId?: string;
}

/** The user's answer to an approval or a plan. `feedback` comes only with "deny". */
export interface ApprovalAnswer {
  readonly decision: ApprovalDecision;
  /** What the user wants instead; null when they declined without a word. */
  readonly feedback: string | null;
}

export interface QuestionRequest {
  readonly id: string;
  readonly questions: readonly Question[];
  /** The id of the `agent` tool part whose native subagent asks, when one does. */
  readonly subagent?: string;
}

/** Every question's answer by question id, or the user declined (also when the turn stops). */
export type QuestionReply =
  | { readonly answers: Readonly<Record<string, QuestionAnswer>> }
  | { readonly declined: true; readonly feedback: string | null };

/** Parts a runtime reports whole: a later one with the same kind and id replaces it. */
export type ReportedPart = Extract<MessagePart, { kind: "plan" | "todo" | "notice" }>;

/** Where a running turn reports. Calls arrive in the order the agent produced them. */
export interface TurnSink {
  /** The agent's session/thread id; stored so the next turn resumes it. */
  session(id: string): void;
  /** Reply text. A new text part starts after any tool or reasoning part. */
  text(delta: string): void;
  reasoning(delta: string): void;
  /** Adds or replaces the tool part with this id. */
  tool(update: ToolUpdate): void;
  /**
   * Asks the user. Resolves with their answer, or "deny" when the turn stops first. The runtime
   * passes the answer back to its agent.
   */
  approve(request: ApprovalRequest): Promise<ApprovalAnswer>;
  /** Asks the user questions. Resolves with their answers, or declined when the turn stops first. */
  ask(request: QuestionRequest): Promise<QuestionReply>;
  /**
   * Shows a plan and waits for the user to accept it ("allow") or ask for changes ("deny" with
   * feedback). Resolves "deny" when the turn stops first. For a plan that needs no answer, use
   * `part`.
   */
  reviewPlan(plan: { readonly id: string; readonly text: string }): Promise<ApprovalAnswer>;
  /** Adds or replaces a plan, todo or notice part. */
  part(part: ReportedPart): void;
  /** The model the agent actually used, when it reports one. */
  model(id: string): void;
  /** How full the context window is, as the agent reports it. */
  context(usage: ContextUsage): void;
  /**
   * A native subagent's activity. `id` is the id of its `agent` tool part, which the runtime
   * reports through `tool` first. Events for one id arrive in order and end with "ended".
   */
  subagent?(id: string, event: SubagentEvent): void;
}

/** Thrown by runtimes with text that is safe to show the user. */
export class ChatRuntimeError extends Error {}

export interface ChatRuntime {
  readonly agentId: ChatAgentId;
  /** Access modes this agent supports, in the order the picker lists them. */
  readonly accessModes: readonly AccessMode[];
  /** Live models and capabilities from the agent. Throws ChatRuntimeError. */
  catalog(signal: AbortSignal): Promise<Omit<AgentCatalog, "steering">>;
  /**
   * Runs one turn to completion. Resolves when the agent finishes; rejects with a
   * ChatRuntimeError when it fails. When `signal` aborts, interrupts the agent (gracefully, then
   * by force) and resolves once it has stopped.
   */
  run(input: TurnInput, sink: TurnSink, signal: AbortSignal): Promise<void>;
  /**
   * Adds a user message to the chat's running turn. Resolves false when it cannot, e.g. no turn
   * runs; the caller then queues the message. Absent when the agent cannot steer.
   */
  steer?(chatId: string, input: Pick<TurnInput, "prompt" | "images">): Promise<boolean>;
  /** Stops every process this runtime started. */
  dispose(): void;
}
