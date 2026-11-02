import { projectRef, type ChatSummary, type Project } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import { chatsIn, resolveWorkspace, workspaceRefOf } from "./model.ts";

const project: Project = { id: "p", name: "app", path: "/code/app" };
const chat = (id: string, patch: Partial<ChatSummary> = {}) =>
  ({
    id,
    projectId: "p",
    title: id,
    cwd: "/code/app",
    worktree: false,
    running: false,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }) as ChatSummary;

test("project-folder chats share the project's workspace; worktree chats share their worktree's", () => {
  const chats = [
    chat("a"),
    chat("w1", { worktree: true, cwd: "/wt/1", createdAt: 5 }),
    chat("w2", { worktree: true, cwd: "/wt/1", createdAt: 9, running: true }),
    chat("w3", { worktree: true, cwd: "/wt/3" }),
  ];
  expect(workspaceRefOf(chats[0]!, chats)).toBe(projectRef("p"));
  expect(workspaceRefOf(chats[2]!, chats)).toBe("w1");
  expect(chatsIn("w1", chats).map((c) => c.id)).toEqual(["w1", "w2"]);
  expect(resolveWorkspace("w1", [project], chats)).toMatchObject({
    cwd: "/wt/1",
    worktree: true,
    running: true,
  });
  expect(resolveWorkspace(projectRef("p"), [project], chats)).toMatchObject({
    cwd: "/code/app",
    worktree: false,
    running: false,
  });
  expect(resolveWorkspace("a", [project], chats)).toBeNull();
  expect(resolveWorkspace(projectRef("gone"), [project], chats)).toBeNull();
});
