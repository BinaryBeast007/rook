// What a turn changed, at the end of its reply, and the file rows tool calls share with it.
import type { FileChange } from "@rook/contracts";
import { use, useId, useMemo, useState } from "react";

import { ChevronIcon, DiffIcon, FolderIcon } from "../icons.tsx";
import { useContextMenu } from "./ContextMenu.tsx";
import { FileTypeIcon } from "./fileIcons.tsx";
import { fileMenuItems, useChatCwd } from "./FileLink.tsx";
import { buildTree, folderPaths, initiallyCollapsed, type TreeNode } from "./fileTree.ts";
import { Inspect } from "./inspect.ts";
import type { ChangesPart } from "./timeline.ts";

const FOCUS = "focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none";
const LINK = `h-6 shrink-0 rounded-md px-2 text-xs text-neutral-400 transition-colors hover:bg-white/6 hover:text-neutral-100 motion-reduce:transition-none ${FOCUS}`;
const TREE_ROW = `flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-sm transition-colors hover:bg-white/4 motion-reduce:transition-none ${FOCUS}`;
/** Left padding of a tree row `depth` folders deep, in pixels. */
const indent = (depth: number) => ({ paddingLeft: 8 + depth * 14 });

function Counts({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  if (additions === null || deletions === null)
    return <span className="shrink-0 text-xs text-neutral-500">binary</span>;
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      <span className={additions ? "text-emerald-400" : "text-neutral-600"}>+{additions}</span>{" "}
      <span className={deletions ? "text-red-400" : "text-neutral-600"}>−{deletions}</span>
    </span>
  );
}

/** One changed file: its type, its folder dimmed, its name, and its line counts. */
export function FileRow({ file, onOpen }: { file: FileChange; onOpen: () => void }) {
  const slash = file.path.lastIndexOf("/");
  return (
    <button
      type="button"
      onClick={onOpen}
      title={file.path}
      className={`flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-white/4 motion-reduce:transition-none ${FOCUS}`}
    >
      <FileTypeIcon path={file.path} className="size-3.5 shrink-0 text-neutral-500" />
      <span className="flex min-w-0 flex-1">
        <span className="min-w-0 truncate text-neutral-500">{file.path.slice(0, slash + 1)}</span>
        <span className="max-w-full shrink-0 truncate text-neutral-200">
          {file.path.slice(slash + 1)}
        </span>
      </span>
      <Counts additions={file.additions} deletions={file.deletions} />
    </button>
  );
}

/** A file in the tree: opens the turn's diff at it; its context menu also copies the path. */
function TreeFile({
  file,
  name,
  depth,
  cwd,
  onOpen,
}: {
  file: FileChange;
  name: string;
  depth: number;
  cwd: string | null;
  onOpen: () => void;
}) {
  const { triggerProps, menu } = useContextMenu(`Actions for ${file.path}`, () =>
    fileMenuItems({ label: "Open diff", onSelect: onOpen }, file.path, cwd),
  );
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={file.path}
        {...triggerProps}
        style={indent(depth)}
        className={`${TREE_ROW} data-open:bg-white/4`}
      >
        {/* Lines the icon up with its sibling folders' icons, past their chevrons. */}
        <span className="w-3 shrink-0" />
        <FileTypeIcon path={file.path} className="size-3.5 shrink-0 text-neutral-500" />
        <span className="min-w-0 flex-1 truncate text-neutral-200">{name}</span>
        <Counts additions={file.additions} deletions={file.deletions} />
      </button>
      {menu}
    </li>
  );
}

function Tree({
  nodes,
  depth,
  collapsed,
  onToggle,
  cwd,
  onOpen,
}: {
  nodes: readonly TreeNode[];
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  cwd: string | null;
  onOpen: (path: string) => void;
}) {
  const id = useId();
  return nodes.map((node) => {
    if (node.kind === "file")
      return (
        <TreeFile
          key={node.file.path}
          file={node.file}
          name={node.name}
          depth={depth}
          cwd={cwd}
          onOpen={() => onOpen(node.file.path)}
        />
      );
    const open = !collapsed.has(node.path);
    const groupId = `${id}-${node.path}`;
    return (
      <li key={node.path}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? groupId : undefined}
          onClick={() => onToggle(node.path)}
          title={node.path}
          style={indent(depth)}
          className={TREE_ROW}
        >
          <ChevronIcon
            className={`size-3 shrink-0 text-neutral-500 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
          />
          <FolderIcon className="size-3.5 shrink-0 text-neutral-500" />
          <span className="min-w-0 flex-1 truncate text-neutral-400">{node.name}</span>
          <Counts additions={node.additions} deletions={node.deletions} />
        </button>
        {open && (
          <ul id={groupId} className="flex flex-col">
            <Tree
              nodes={node.children}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              cwd={cwd}
              onOpen={onOpen}
            />
          </ul>
        )}
      </li>
    );
  });
}

export function ChangedFiles({ part, chatId }: { part: ChangesPart; chatId: string }) {
  const inspect = use(Inspect);
  const cwd = useChatCwd(chatId);
  const titleId = useId();
  const { files } = part;
  const tree = useMemo(() => buildTree(files), [files]);
  const folders = useMemo(() => folderPaths(tree), [tree]);
  const [collapsed, setCollapsed] = useState(() => initiallyCollapsed(tree, files.length));
  // Paths in `collapsed` can outlive their folder when more files arrive and the tree regroups.
  const anyCollapsed = folders.some((path) => collapsed.has(path));
  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const sum = (key: "additions" | "deletions") =>
    files.reduce((total, file) => total + (file[key] ?? 0), 0);
  const review = (path?: string) =>
    inspect(chatId, {
      kind: "range",
      from: part.from,
      to: part.to,
      label: "This turn",
      ...(path === undefined ? {} : { path }),
    });
  return (
    <section
      aria-labelledby={titleId}
      className="rounded-xl border border-white/8 bg-white/[0.02] p-1.5"
    >
      <div className="flex h-8 items-center gap-2.5 pr-1 pl-2">
        <DiffIcon className="size-4 shrink-0 text-neutral-500" />
        <h3 id={titleId} className="min-w-0 truncate text-sm text-neutral-200">
          {files.length}
          {part.truncated && "+"} {files.length === 1 && !part.truncated ? "file" : "files"} changed
        </h3>
        <Counts additions={sum("additions")} deletions={sum("deletions")} />
        <span className="flex-1" />
        {folders.length > 0 && (
          <button
            type="button"
            onClick={() => setCollapsed(new Set(anyCollapsed ? [] : folders))}
            className={LINK}
          >
            {anyCollapsed ? "Expand all" : "Collapse all"}
          </button>
        )}
        <button
          type="button"
          aria-label="Review this turn's changes"
          onClick={() => review()}
          className={LINK}
        >
          Review
        </button>
      </div>
      <ul aria-label="Changed files" className="flex flex-col">
        <Tree
          nodes={tree}
          depth={0}
          collapsed={collapsed}
          onToggle={toggle}
          cwd={cwd}
          onOpen={review}
        />
      </ul>
      {part.truncated && (
        <p className="flex h-7 items-center px-2 text-xs text-neutral-500">
          More files changed than are listed here.
        </p>
      )}
    </section>
  );
}
