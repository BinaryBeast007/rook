// Notices: what an agent reports that is not part of its answer (retries, usage limits, warnings,
// compaction), mapped to `notice` parts. Pure, so each driver only routes its events here.
import type { MessagePart } from "@rook/contracts";

export type Notice = Extract<MessagePart, { kind: "notice" }>;

type Json = Record<string, unknown>;

const MAX_LINE = 200;
const MAX_DETAIL = 2000;

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** The first line, capped, so a notice's text is one short line. */
export function oneLine(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line;
}

function notice(id: string, level: Notice["level"], text: string, ...details: unknown[]): Notice {
  const detail = details.map(str).filter(Boolean).join("\n\n");
  return {
    kind: "notice",
    id,
    level,
    text: oneLine(text),
    detail: detail ? detail.slice(0, MAX_DETAIL) : null,
  };
}

/**
 * " Resets at <ISO time>." for a reset time in epoch seconds. The renderer shows ISO times in
 * the user's local time; stored as ISO so the text stays correct wherever it is read.
 */
function resets(seconds: unknown): string {
  const ms = typeof seconds === "number" && seconds > 0 ? seconds * 1000 : NaN;
  return Number.isFinite(ms) && ms < 8.64e15 ? ` Resets at ${new Date(ms).toISOString()}.` : "";
}

// ---- Codex ----

export interface CodexRateLimits {
  readonly primary?: { readonly usedPercent: number; readonly resetsAt: number | null } | null;
  readonly secondary?: { readonly usedPercent: number; readonly resetsAt: number | null } | null;
  readonly rateLimitReachedType?: string | null;
}

/** When the fullest rate-limit window resets, in epoch seconds. */
export function codexResetsAt(limits: CodexRateLimits | null): number | null {
  const windows = [limits?.primary, limits?.secondary].filter((w) => w?.resetsAt);
  windows.sort((a, b) => b!.usedPercent - a!.usedPercent);
  return windows[0]?.resetsAt ?? null;
}

export interface CodexError {
  readonly message: string;
  readonly codexErrorInfo?: unknown;
  readonly additionalDetails?: string | null;
}

/**
 * The notice for a Codex `error`: usage and context limits get their own; any other error Codex
 * retries is "Retrying (n)…", one per turn so the count updates in place. Null for an error that
 * ends the turn, which the reply's error line already shows.
 */
/** A usage or rate limit, which gets its own notice rather than a retry count. */
export const isLimit = (info: unknown) =>
  info === "usageLimitExceeded" || info === "rateLimitExceeded";

export function codexErrorNotice(
  error: CodexError,
  willRetry: boolean,
  turnId: string,
  attempt: number,
  limits: CodexRateLimits | null,
): Notice | null {
  const info = error.codexErrorInfo;
  if (isLimit(info))
    return notice(
      `usage:${turnId}`,
      // Codex retrying a rate limit is a wait, not a failure.
      willRetry ? "warning" : "error",
      `${info === "usageLimitExceeded" ? "Usage limit reached." : "Rate limit reached."}${resets(codexResetsAt(limits))}`,
      error.message,
    );
  if (info === "contextWindowExceeded")
    return notice(
      `context:${turnId}`,
      "error",
      "The conversation is too long for the model's context window. Start a new chat or compact it.",
      error.message,
    );
  if (!willRetry) return null;
  return notice(
    `retry:${turnId}`,
    "warning",
    `Retrying (${attempt})…`,
    error.message,
    error.additionalDetails,
  );
}

/** Replaces the turn's retry notice once the agent is back. */
export function recoveredNotice(turnId: string, attempts: number): Notice {
  return notice(
    `retry:${turnId}`,
    "info",
    `Reconnected after ${attempts} ${attempts === 1 ? "retry" : "retries"}`,
  );
}

/** Replaces the turn's retry notice when the turn fails after retrying, so it never hangs on. */
export function gaveUpNotice(turnId: string, attempts: number): Notice {
  return notice(
    `retry:${turnId}`,
    "error",
    `Gave up after ${attempts} ${attempts === 1 ? "retry" : "retries"}`,
  );
}

/** `warning` / `guardianWarning` {message}; `configWarning` / `deprecationNotice` {summary, details}. */
export function codexWarningNotice(method: string, params: Json): Notice | null {
  const text = str(params.message) ?? str(params.summary);
  if (!text) return null;
  const [first = "", ...rest] = text.trim().split("\n");
  const prefix = method === "deprecationNotice" ? "Deprecated: " : "";
  const where = str(params.path);
  // Codex sends one config problem as both configWarning and a thread's warning (verified 0.166):
  // keyed by its text, the second replaces the first. The specifics are in the later lines.
  return notice(
    `warning:${first}`,
    "warning",
    prefix + first,
    rest.join("\n").trim(),
    params.details,
    where,
  );
}

export function codexReroutedNotice(params: Json): Notice | null {
  const to = str(params.toModel);
  if (!to) return null;
  const from = str(params.fromModel);
  const reason =
    params.reason === "highRiskCyberActivity" ? "Flagged as high-risk activity." : null;
  return notice(
    `rerouted:${to}`,
    "info",
    from ? `Codex switched from ${from} to ${to}` : `Codex switched to ${to}`,
    reason ?? params.reason,
  );
}

/** Context compaction: one notice per turn, "Compacting…" until it is done. */
export function compactionNotice(id: string, done: boolean, detail?: string | null): Notice {
  return notice(
    `compact:${id}`,
    "info",
    done ? "Context compacted" : "Compacting context…",
    detail,
  );
}

/** Thread items that are events, not tool calls: compaction and review mode. */
export function codexItemNotice(
  item: { readonly type: string; readonly id: string; readonly review?: string },
  turnId: string,
  completed: boolean,
): Notice | null {
  if (item.type === "contextCompaction") return compactionNotice(turnId, completed);
  // A review mode item arrives started and completed; one notice, shown once it completed.
  if (!completed) return null;
  if (item.type === "enteredReviewMode")
    return notice(`review:${item.id}`, "info", "Started a code review", item.review);
  if (item.type === "exitedReviewMode")
    return notice(`review:${item.id}`, "info", "Finished the code review", item.review);
  return null;
}

// ---- Claude Code ----

/** A `rate_limit_event`'s info; null while usage is allowed. */
export function claudeRateLimitNotice(info: Json | null): Notice | null {
  const status = str(info?.status);
  if (!info || !status || status === "allowed") return null;
  const type = str(info.rateLimitType) ?? "usage";
  const overage =
    info.overageStatus === "allowed" ||
    info.overageStatus === "allowed_warning" ||
    info.isUsingOverage === true;
  const at = resets(info.resetsAt);
  if (status === "allowed_warning")
    return notice(`usage:${type}`, "warning", `You are close to your usage limit.${at}`);
  if (overage)
    return notice(`usage:${type}`, "info", `Usage limit reached; using extra usage.${at}`);
  return notice(`usage:${type}`, "error", `Usage limit reached.${at}`);
}

/** The id Claude Code's retry notices share within a turn, for `recoveredNotice`. */
export const CLAUDE_TURN = "turn";

/**
 * `system` `api_retry` {attempt, max_retries, retry_delay_ms, error, error_status}, verified with
 * claude 2.1.316.
 */
export function claudeRetryNotice(message: Json): Notice {
  const attempt = typeof message.attempt === "number" ? Math.trunc(message.attempt) : null;
  const max = typeof message.max_retries === "number" ? Math.trunc(message.max_retries) : null;
  const count = attempt ? (max ? ` (${attempt}/${max})` : ` (${attempt})`) : "";
  const delay =
    typeof message.retry_delay_ms === "number" && message.retry_delay_ms >= 1000
      ? ` in ${Math.round(message.retry_delay_ms / 1000)}s`
      : "";
  const error = str(message.error)?.replaceAll("_", " ");
  const status = typeof message.error_status === "number" ? ` (HTTP ${message.error_status})` : "";
  return notice(
    `retry:${CLAUDE_TURN}`,
    "warning",
    `Retrying${count}${delay}…`,
    error && `Claude API ${error}${status}.`,
  );
}

/**
 * `system` `compact_boundary` {compact_metadata: {trigger, pre_tokens, post_tokens}}, verified with
 * claude 2.1.316. It replaces the turn's "Compacting…" notice (`claudeCompactingNotice`).
 */
export function claudeCompactNotice(message: Json): Notice {
  const meta = (message.compact_metadata ?? {}) as Json;
  const trigger =
    meta.trigger === "manual" ? "On request" : meta.trigger === "auto" ? "Automatically" : null;
  const before = tokenCount(meta.pre_tokens);
  const after = tokenCount(meta.post_tokens);
  const tokens = before && (after ? `from ${before} to ${after} tokens` : `from ${before} tokens`);
  const detail = [trigger, tokens].filter(Boolean).join(", ");
  return compactionNotice(CLAUDE_TURN, true, detail || null);
}

const tokenCount = (value: unknown) =>
  typeof value === "number" ? value.toLocaleString("en-US") : null;

/** `system` `status` "compacting", which comes before the boundary (verified 2.1.316). */
export const claudeCompactingNotice = (): Notice => compactionNotice(CLAUDE_TURN, false);

const MODE_NAMES: Record<string, string> = {
  default: "Ask first",
  acceptEdits: "Edit files",
  auto: "Auto",
  bypassPermissions: "Full access",
  plan: "Plan",
};

const modeName = (mode: string) => MODE_NAMES[mode] ?? mode;

/**
 * The CLI quietly falls back to another mode when it can't switch (verified 2.1.316: without
 * --allow-dangerously-skip-permissions, bypassPermissions becomes default), so say so.
 */
export function claudeModeNotice(asked: string, got: string): Notice {
  return notice(
    "mode:plan",
    "warning",
    `Claude Code went on in ${modeName(got)} mode, not ${modeName(asked)}.`,
  );
}

const unknown = new Set<string>();

/** One debug line per unknown event kind, so new agent events are noticed without noise. */
export function logUnknown(agent: string, kind: string): void {
  const key = `${agent}:${kind}`;
  if (unknown.has(key)) return;
  unknown.add(key);
  console.debug(`${agent}: ignored ${kind}`);
}
