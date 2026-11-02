import type { ChatMessage, MessagePart } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import { revertableFrom } from "./rewind.ts";

const CHANGES: MessagePart = {
  kind: "changes",
  from: "a".repeat(40),
  to: "b".repeat(40),
  files: [{ path: "a.txt", additions: 1, deletions: 0 }],
  truncated: false,
};

function message(
  id: string,
  role: ChatMessage["role"],
  parts: MessagePart[] = [{ kind: "text", text: id }],
  status: ChatMessage["status"] = "done",
): ChatMessage {
  return {
    id,
    chatId: "c",
    role,
    parts,
    attachments: [],
    status,
    error: null,
    agentId: role === "user" ? null : "claude",
    model: null,
    createdAt: 1,
  };
}

test("revertableFrom marks user messages with a file-changing reply at or after them", () => {
  const timeline = [
    message("u1", "user"),
    message("a1", "assistant"),
    message("u2", "user"),
    message("a2", "assistant", [{ kind: "text", text: "edit" }, CHANGES]),
    message("u3", "user"),
    message("a3", "assistant"),
  ];
  expect([...revertableFrom(timeline)].toSorted()).toEqual(["u1", "u2"]);
  expect(revertableFrom([])).toEqual(new Set());
  // A queued message never counts, and nothing after the last change does.
  expect([...revertableFrom([...timeline, message("q", "user", [], "queued")])]).not.toContain("q");
});
