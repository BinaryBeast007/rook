import { use } from "react";

import { useContextMenu, type MenuItem } from "./ContextMenu.tsx";
import { FileTypeIcon } from "./fileIcons.tsx";
import { fileLabel, fileWhere, fullPath } from "./fileRefs.ts";
import { Inspect } from "./inspect.ts";
import { ChatLinks } from "./links.ts";
import type { Inline } from "./markdown.ts";

/** Inline code. */
export const CODE =
  "rounded-[5px] bg-white/7 px-1.5 py-0.5 font-mono text-[0.86em] text-neutral-100";

/** The folder of the chat `chatId`, or null when it is not known. */
export function useChatCwd(chatId: string): string | null {
  return use(ChatLinks).chats.find((chat) => chat.id === chatId)?.cwd ?? null;
}

const copy = (text: string) => {
  // A denied clipboard changes nothing, which is the honest result.
  navigator.clipboard.writeText(text).catch(() => undefined);
};

/** A file's menu: open it, or copy its path relative to the folder or in full. */
export function fileMenuItems(
  open: MenuItem,
  path: string,
  cwd: string | null,
): readonly MenuItem[] {
  return [
    open,
    { label: "Copy relative path", onSelect: () => copy(path) },
    ...(cwd ? [{ label: "Copy full path", onSelect: () => copy(fullPath(cwd, path)) }] : []),
  ];
}

/**
 * A file reference: a chip reading `name · folder · L12` that opens the file, at its line, in the
 * workspace's Files tool. Its context menu also copies the path.
 */
export function FileLink({
  node,
  chatId,
}: {
  node: Extract<Inline, { type: "file" }>;
  chatId: string;
}) {
  const inspect = use(Inspect);
  const cwd = useChatCwd(chatId);
  const where = fileWhere(node);
  const label = fileLabel(node);
  const name = node.path.slice(node.path.lastIndexOf("/") + 1);
  const open = () =>
    inspect(chatId, { kind: "file", path: node.path, ...(node.line && { line: node.line }) });
  const { triggerProps, menu } = useContextMenu(`Actions for ${node.path}`, () =>
    fileMenuItems({ label: "Open", onSelect: open }, node.path, cwd),
  );
  return (
    <>
      <button
        type="button"
        title={where}
        aria-label={where}
        onClick={open}
        {...triggerProps}
        className="mx-px inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md border border-white/8 bg-white/5 px-1.5 align-[-0.2em] text-[0.86em] leading-[1.6] transition-colors hover:border-white/15 hover:bg-white/9 data-open:bg-white/9 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none motion-reduce:transition-none"
      >
        <FileTypeIcon path={node.path} className="size-3.5 shrink-0 text-neutral-400" />
        <span className="min-w-0 truncate">
          <span className="text-neutral-100">{name}</span>
          <span className="text-neutral-500">{label.slice(name.length)}</span>
        </span>
      </button>
      {menu}
    </>
  );
}
