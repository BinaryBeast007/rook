// Newline-delimited JSON-RPC over a child's stdio. Codex's app-server and every
// ACP agent speak this; Codex omits the `"jsonrpc": "2.0"` member.
import type { ChildProcess } from "node:child_process";

import { killTree } from "./process.ts";

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export class RpcClosedError extends Error {}

type Handler = (params: unknown) => unknown;

export interface RpcPeerOptions {
  /** Whether messages carry `"jsonrpc": "2.0"`. */
  readonly jsonrpc: boolean;
  /** Sees every stdout line first; return true to keep it out of the protocol. */
  readonly onLine?: (line: string) => boolean;
  readonly onStderr?: (text: string) => void;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

const MAX_LINE = 16 * 1024 * 1024;

export class RpcPeer {
  readonly closed: Promise<void>;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, Pending>();
  private readonly notifications = new Map<string, Handler>();
  private readonly requests = new Map<string, Handler>();
  private exited = false;
  private readonly child: ChildProcess;
  private readonly options: RpcPeerOptions;

  constructor(child: ChildProcess, options: RpcPeerOptions) {
    this.child = child;
    this.options = options;
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => this.receive(chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => options.onStderr?.(chunk));
    child.stdin?.on("error", () => undefined); // Surfaces as an exit instead.
    this.closed = new Promise((resolve) => {
      const finish = (reason: string) => {
        if (this.exited) return;
        this.exited = true;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new RpcClosedError(reason));
        }
        this.pending.clear();
        resolve();
      };
      child.once("error", (error) => finish(`The agent could not start: ${error.message}`));
      child.once("exit", (code) => finish(`The agent exited (code ${code ?? "none"}).`));
    });
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.exited) return Promise.reject(new RpcClosedError("The agent is not running."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The agent did not answer ${method} in time.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  onNotification(method: string, handler: Handler): void {
    this.notifications.set(method, handler);
  }

  /** Answers requests the agent sends to Rook. Unhandled methods get -32601. */
  onRequest(method: string, handler: Handler): void {
    this.requests.set(method, handler);
  }

  close(): void {
    if (!this.exited) killTree(this.child);
  }

  private send(message: Record<string, unknown>): void {
    if (this.exited) return;
    const payload = this.options.jsonrpc ? { jsonrpc: "2.0", ...message } : message;
    this.child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE) {
      this.buffer = "";
      this.close();
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    if (this.options.onLine?.(line)) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // Agents log non-protocol lines to stdout now and then.
    }
    if (typeof message !== "object" || message === null) return;
    const { id, method } = message;

    if (typeof method !== "string") {
      const pending = typeof id === "number" ? this.pending.get(id) : undefined;
      if (!pending) return;
      this.pending.delete(id as number);
      clearTimeout(pending.timer);
      const error = message.error as
        | { code?: unknown; message?: unknown; data?: unknown }
        | undefined;
      if (error) {
        pending.reject(
          new RpcError(
            typeof error.code === "number" ? error.code : -32603,
            typeof error.message === "string" ? error.message : "The agent reported an error.",
            error.data,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (id === undefined || id === null) {
      try {
        this.notifications.get(method)?.(message.params);
      } catch {
        // A faulty handler must not stop the stream.
      }
      return;
    }

    const handler = this.requests.get(method);
    if (!handler) {
      this.send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    Promise.resolve()
      .then(() => handler(message.params))
      .then(
        (result) => this.send({ id, result: result ?? null }),
        (error: unknown) =>
          this.send({
            id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : "Request failed.",
            },
          }),
      );
  }
}
