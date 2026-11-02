// Agents' permission requests as Rook approvals, and the user's answers back in each agent's terms.
import { stripVTControlCharacters } from "node:util";

import type { ApprovalDecision } from "@rook/contracts";

import type { ApprovalAnswer, ApprovalRequest } from "./runtime.ts";

type Json = Record<string, unknown>;
type Ask = Omit<ApprovalRequest, "id">;

const MAX_DETAIL = 4000;

const object = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const truncate = (text: string) =>
  text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
const oneLine = (text: string, max = 120) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max || line !== text.trim() ? `${line.slice(0, max)}…` : line;
};

/**
 * A tool's arguments as `key: value` lines: strings as they are (multi-line ones indented under
 * their key), anything else as compact JSON. Null when there are none.
 */
export function argsText(input: unknown): string | null {
  const args = object(input);
  if (!args) return input === null || input === undefined ? null : truncate(JSON.stringify(input));
  const lines = Object.entries(args)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return text.includes("\n")
        ? `${key}:\n  ${text.replaceAll("\n", "\n  ")}`
        : `${key}: ${text}`;
    });
  return lines.length ? truncate(lines.join("\n")) : null;
}

/** Why Claude Code asks, from a `can_use_tool` request; null when it doesn't say. */
export function claudeReason(request: Json): string | null {
  const reason = str(request.decision_reason);
  if (reason) return stripVTControlCharacters(reason).trim();
  const blocked = str(request.blocked_path);
  return blocked ? `It needs ${blocked}, outside the folders it may use.` : null;
}

/** The options Codex offers for a command approval; deny is always there. */
export function codexOptions(available: readonly unknown[] | null | undefined): ApprovalDecision[] {
  // shortcut: `acceptWithExecpolicyAmendment` / `applyNetworkPolicyAmendment` (allow and remember
  // a rule beyond this chat) have no Rook option yet, so they are left out.
  if (!available) return ["allow", "allowSession", "deny"];
  return [
    ...(available.includes("accept") ? (["allow"] as const) : []),
    ...(available.includes("acceptForSession") ? (["allowSession"] as const) : []),
    "deny",
  ];
}

/** A v2 command or file change approval's answer. */
export function codexDecision(
  decision: ApprovalDecision,
): "accept" | "acceptForSession" | "decline" {
  return decision === "allow"
    ? "accept"
    : decision === "allowSession"
      ? "acceptForSession"
      : "decline";
}

/** What Codex hears when the user declines, with what they want instead if they said. */
export function codexRejection(feedback: string | null): string {
  return feedback
    ? `The user declined this action and said: ${feedback}`
    : "The user declined this action.";
}

/** A legacy `execCommandApproval` / `applyPatchApproval` answer; its denial carries the feedback. */
export function legacyDecision({ decision, feedback }: ApprovalAnswer) {
  if (decision === "allow") return { decision: "approved" };
  if (decision === "allowSession") return { decision: "approved_for_session" };
  return { decision: { denied: { rejection: codexRejection(feedback) } } };
}

/** A legacy command's argv as one line, quoting arguments with spaces. */
/** A folder-wide write grant, spelled out; null when there is none. */
export const grantText = (root: string | null | undefined) =>
  root ? `It asks to write anywhere in ${root}.` : null;

/** A legacy command as typed: the script of a `sh -c`-style wrapper, else the quoted argv. */
export function legacyCommand(command: readonly string[]): string {
  const [shell, flag, script, ...rest] = command;
  return shell &&
    script !== undefined &&
    !rest.length &&
    /^(?:-l?c|-Command|\/c)$/i.test(flag ?? "")
    ? script
    : argvText(command);
}

export function argvText(command: readonly string[]): string {
  return command.map((arg) => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

/**
 * A legacy patch's files as one unified diff, each hunk header naming its file (the renderer
 * leaves file headers out); added and deleted files whole.
 */
export function patchText(changes: unknown): string | null {
  const parts = Object.entries(object(changes) ?? {}).map(([path, raw]) => {
    const change = object(raw) ?? {};
    const header = `diff --git a/${path} b/${path}`;
    if (change.type === "update") {
      const name = str(change.move_path) ? `${path} → ${String(change.move_path)}` : path;
      const diff = (str(change.unified_diff) ?? "").replace(
        /^(@@ [^@]* @@).*$/gm,
        (_, hunk: string) => `${hunk} ${name}`,
      );
      return `${header}\n${diff}`.trimEnd();
    }
    const lines = (str(change.content) ?? "").replace(/\n$/, "").split("\n");
    const hunk =
      change.type === "delete" ? `@@ -1,${lines.length} +0,0 @@` : `@@ -0,0 +1,${lines.length} @@`;
    const sign = change.type === "delete" ? "-" : "+";
    return [header, `${hunk} ${path}`, ...lines.map((line) => sign + line)].join("\n");
  });
  return parts.length ? truncate(parts.join("\n")) : null;
}

function fileSystemPath(path: unknown): string {
  const entry = object(path) ?? {};
  if (entry.type === "path") return String(entry.path);
  if (entry.type === "glob_pattern") return String(entry.pattern);
  const special = object(entry.value) ?? {};
  const names: Record<string, string> = {
    root: "the whole disk",
    minimal: "system files",
    tmpdir: "the temp folder",
    slash_tmp: "/tmp",
  };
  if (special.kind === "project_roots")
    return str(special.subpath) ? `${String(special.subpath)} in the project` : "the project";
  return names[String(special.kind)] ?? str(special.path) ?? "a path";
}

/** A Codex permission profile as lines, e.g. "Network access" or "Write: src". */
export function permissionsText(permissions: unknown): string | null {
  const profile = object(permissions) ?? {};
  const lines: string[] = [];
  if (object(profile.network)?.enabled === true) lines.push("Network access");
  const files = object(profile.fileSystem) ?? {};
  for (const [key, label] of [
    ["read", "Read"],
    ["write", "Write"],
  ] as const) {
    const paths = list(files[key]).filter((path) => typeof path === "string");
    if (paths.length) lines.push(`${label}: ${paths.join(", ")}`);
  }
  for (const entry of list(files.entries).map(object)) {
    const access = String(entry?.access ?? "read");
    lines.push(
      `${access.charAt(0).toUpperCase()}${access.slice(1)}: ${fileSystemPath(entry?.path)}`,
    );
  }
  return lines.length ? lines.join("\n") : null;
}

/** Grants what was asked for the turn on "allow", nothing on "deny". */
export function permissionsResponse(permissions: unknown, decision: ApprovalDecision) {
  const asked = object(permissions) ?? {};
  const granted =
    decision === "deny"
      ? {}
      : {
          ...(object(asked.network) && { network: asked.network }),
          ...(object(asked.fileSystem) && { fileSystem: asked.fileSystem }),
        };
  return { permissions: granted, scope: "turn" };
}

/** An MCP server's request for input (`elicitation`), from Claude Code or Codex. */
export interface Elicitation {
  readonly server: string;
  /** "form", "url", or another mode Rook can't answer. */
  readonly mode: string;
  readonly message: string;
  readonly url: string | null;
  readonly schema: unknown;
  /** Codex's `_meta`, which marks an MCP tool call approval. */
  readonly meta: unknown;
}

/**
 * The approval an elicitation becomes: a link to open, an MCP tool call to allow, or a form with
 * nothing to fill in. Null when it needs input the approval card can't take.
 */
export function elicitationApproval(elicitation: Elicitation): Ask | null {
  const { server, mode, message } = elicitation;
  // Only an https link can be opened; anything else is declined with a notice.
  if (mode === "url" && /^https:\/\/\S+$/i.test(elicitation.url ?? ""))
    return {
      tool: "link",
      title: `The ${server} MCP server asks you to open a link`,
      detail: elicitation.url,
      reason: str(message),
      options: ["allow", "deny"],
    };
  const schema = object(elicitation.schema);
  if (mode !== "form" || list(schema?.required).length) return null;
  const meta = object(elicitation.meta);
  const options: ApprovalDecision[] = list(meta?.persist).includes("session")
    ? ["allow", "allowSession", "deny"]
    : ["allow", "deny"];
  if (meta?.codex_approval_kind === "mcp_tool_call")
    return {
      tool: "mcp",
      title: oneLine(message) || `Use a ${server} MCP tool?`,
      detail: argsText(meta.tool_params),
      reason: str(meta.tool_description),
      options,
    };
  // A form with no schema at all says nothing about what accepting means.
  if (!schema) return null;
  return {
    tool: "elicitation",
    title: `The ${server} MCP server asks to continue`,
    detail: null,
    reason: str(message),
    options,
  };
}

/** The notice for an elicitation Rook declined because it can't show it. */
export function elicitationNotice(elicitation: Elicitation) {
  return {
    level: "warning" as const,
    text: `Declined a request from the ${elicitation.server} MCP server: it needs input Rook can't show yet.`,
    detail: str(elicitation.message),
  };
}

/** An elicitation's answer: accept with nothing filled in, or decline. */
export function elicitationResponse(elicitation: Elicitation, decision: ApprovalDecision) {
  if (decision === "deny") return { action: "decline" };
  return {
    action: "accept",
    ...(elicitation.mode === "form" && { content: {} }),
    ...(decision === "allowSession" && { _meta: { persist: "session" } }),
  };
}
