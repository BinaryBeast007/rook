import type { ChatSummary, Project } from "@rook/contracts";
import { use, useRef, useState } from "react";

import { IconButton } from "../IconButton.tsx";
import { PencilIcon, WorktreeIcon } from "../icons.tsx";
import { isSubagent } from "../library.ts";
import { ChatLinks } from "./links.ts";

/** The title, renamed in place; without `onRename` (a read-only chat) it only shows. */
function TitleEditor({
  title,
  onRename,
}: {
  title: string;
  onRename: ((title: string) => void) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  // Set once Enter or Escape ends the edit, so a blur as the field goes away doesn't save again.
  const finished = useRef(false);
  const start = () => {
    finished.current = false;
    setValue(title);
    setEditing(true);
  };
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    setEditing(false);
    if (save && value.trim() && value.trim() !== title) onRename?.(value.trim());
  };

  if (!onRename) return <h1 className="truncate px-1 text-sm text-neutral-200">{title}</h1>;
  if (editing)
    return (
      <input
        aria-label="Chat title"
        value={value}
        autoFocus
        onFocus={(event) => event.target.select()}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) finish(true);
          else if (event.key === "Escape") {
            event.stopPropagation();
            finish(false);
          }
        }}
        className="app-region-no-drag h-7 w-64 min-w-0 rounded-md bg-white/6 px-2 text-sm text-neutral-100 ring-1 ring-white/20 focus:outline-none"
      />
    );

  return (
    <span className="group/title flex min-w-0 items-center">
      {/* No-drag: a double-click in a drag region would maximize the window instead. */}
      <h1
        onDoubleClick={start}
        title="Double-click to rename"
        className="app-region-no-drag truncate px-1 text-sm text-neutral-200"
      >
        {title}
      </h1>
      <IconButton
        label="Rename chat"
        onClick={start}
        className="size-6 shrink-0 opacity-0 group-hover/title:opacity-100 focus-visible:opacity-100 [&>svg]:size-3.5"
      >
        <PencilIcon />
      </IconButton>
    </span>
  );
}

/**
 * The open chat's title bar: title, project, whether it has its own worktree, and for a task or
 * subagent the chat that started it.
 */
export function ChatHeader({
  chat,
  project,
  onRename,
}: {
  chat: ChatSummary;
  project: Project;
  onRename: (title: string) => void;
}) {
  const { chats, open } = use(ChatLinks);
  const parentId = chat.lineage?.parentChatId;
  const parent = parentId === undefined ? undefined : chats.find((c) => c.id === parentId);
  return (
    <div className="flex min-w-0 items-center gap-2 px-1">
      <TitleEditor
        key={chat.id}
        title={chat.title}
        onRename={isSubagent(chat) ? undefined : onRename}
      />
      {parent && (
        <button
          type="button"
          title={`Open ${parent.title}`}
          onClick={() => open(parent)}
          className="app-region-no-drag flex h-6 max-w-48 min-w-0 shrink items-center rounded-md px-1.5 text-xs text-neutral-500 transition-colors hover:bg-white/6 hover:text-neutral-200 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none motion-reduce:transition-none"
        >
          <span className="truncate">
            {chat.lineage?.relationship === "subagent" ? "Subagent of" : "Task of"}{" "}
            <span className="text-neutral-300">{parent.title}</span>
          </span>
        </button>
      )}
      <span
        title={chat.worktree ? `${project.path}\nWorktree: ${chat.cwd}` : project.path}
        className="app-region-no-drag shrink-0 text-xs text-neutral-500"
      >
        {project.name}
      </span>
      {chat.worktree && (
        <span
          title={`Own worktree: ${chat.cwd}`}
          className="app-region-no-drag flex h-5 shrink-0 items-center gap-1 rounded bg-white/5 px-1.5 text-2xs text-neutral-400"
        >
          <WorktreeIcon className="size-3" />
          worktree
        </span>
      )}
    </div>
  );
}
