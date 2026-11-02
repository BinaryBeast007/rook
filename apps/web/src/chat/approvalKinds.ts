// What an approval asks for, in words: its kind's label, its buttons, and how it ended.
import type { ApprovalDecision, MessagePart } from "@rook/contracts";

export type ApprovalPart = Extract<MessagePart, { kind: "approval" }>;

/** Labels by the approval's `tool` kind; unknown or absent kinds read "Approval". */
const LABELS: Record<string, string> = {
  command: "Run command",
  edit: "Edit files",
  read: "Read file",
  search: "Search files",
  web: "Use the web",
  network: "Network access",
  mcp: "MCP tool",
  agent: "Start an agent",
  permissions: "Permissions",
  link: "Open link",
  elicitation: "MCP server request",
};

export function approvalLabel(tool: string | undefined): string {
  return LABELS[tool ?? ""] ?? "Approval";
}

/** A button's text. */
export function optionLabel(tool: string | undefined, option: ApprovalDecision): string {
  if (option === "deny") return "Deny";
  if (option === "allowSession") return "Allow for this chat";
  if (tool === "link") return "Open link";
  return tool === "permissions" ? "Grant for this turn" : "Allow once";
}

/**
 * How the approval ended; null while it can still be answered. An unanswered one in a reply that
 * stopped can't be: the agent heard "deny" when its turn ended.
 */
export function approvalResult(part: ApprovalPart, live: boolean): string | null {
  switch (part.decision ?? null) {
    case "allow":
      if (part.tool === "link") return "Opened";
      return part.tool === "permissions" ? "Granted for this turn" : "Allowed once";
    case "allowSession":
      return "Allowed for this chat";
    case "deny":
      return "Denied";
    case null:
      return live ? null : "No longer answerable: the turn ended";
  }
}

/** An https URL the card may open; anything else is shown as text. */
export const openableUrl = (text: string | null): string | null =>
  text && /^https:\/\/\S+$/.test(text.trim()) ? text.trim() : null;
