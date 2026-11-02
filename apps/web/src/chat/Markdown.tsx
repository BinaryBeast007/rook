// oxlint-disable react/no-array-index-key -- parsed blocks have no identity, and a streaming reply only grows at its end.

import { memo, use, useMemo, type ReactNode } from "react";

import { CodeBlock } from "./CodeBlock.tsx";
import { CODE, FileLink } from "./FileLink.tsx";
import {
  parseMarkdown,
  referenceDefinitions,
  splitBlocks,
  type Alert,
  type Block,
  type FileScope,
  type Inline,
} from "./markdown.ts";
import { ChatLinks } from "./links.ts";

/** The chat a reply belongs to, whose folder its file references point into. */
interface Files extends FileScope {
  readonly chatId: string;
}

/** The blinking end-of-text marker of a reply that is still streaming. */
function Caret() {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[0.2em] rounded-full bg-neutral-300 motion-safe:animate-pulse"
    />
  );
}

function Inlines({ nodes, files }: { nodes: readonly Inline[]; files?: Files | undefined }) {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "break":
        return <br key={index} />;
      case "code":
        return (
          <code key={index} className={CODE}>
            {node.text}
          </code>
        );
      case "file":
        return files ? (
          <FileLink key={index} node={node} chatId={files.chatId} />
        ) : (
          <code key={index} className={CODE}>
            {node.text}
          </code>
        );
      case "bold":
        return (
          <strong key={index} className="font-semibold text-neutral-100">
            <Inlines nodes={node.children} files={files} />
          </strong>
        );
      case "italic":
        return (
          <em key={index} className="italic">
            <Inlines nodes={node.children} files={files} />
          </em>
        );
      case "strike":
        return (
          <del key={index} className="text-neutral-400 line-through decoration-neutral-500">
            <Inlines nodes={node.children} files={files} />
          </del>
        );
      case "link":
        return (
          <a
            key={index}
            href={node.href}
            target="_blank"
            rel="noreferrer"
            className="rounded-sm text-neutral-100 underline decoration-white/25 underline-offset-2 hover:decoration-white/60 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none"
          >
            {node.text}
          </a>
        );
    }
  });
}

// h4–h6 share the smallest tag; size and tone keep them apart.
const HEADING_STYLE = [
  "text-lg text-neutral-100",
  "text-base text-neutral-100",
  "text-sm text-neutral-100",
  "text-sm text-neutral-300",
  "text-xs text-neutral-300",
  "text-xs text-neutral-400",
];
const ALIGN = { left: "text-left", center: "text-center", right: "text-right" } as const;
const ALERTS: Record<Alert, { label: string; border: string; text: string }> = {
  note: { label: "Note", border: "border-sky-400/50", text: "text-sky-300" },
  tip: { label: "Tip", border: "border-emerald-400/50", text: "text-emerald-300" },
  important: { label: "Important", border: "border-violet-400/50", text: "text-violet-300" },
  warning: { label: "Warning", border: "border-amber-400/50", text: "text-amber-300" },
  caution: { label: "Caution", border: "border-red-400/50", text: "text-red-300" },
};

function Blocks({
  blocks,
  caret,
  files,
}: {
  blocks: readonly Block[];
  caret: boolean;
  files?: Files | undefined;
}) {
  return blocks.map((block, index) => (
    <BlockView
      key={index}
      block={block}
      caret={caret && index === blocks.length - 1}
      files={files}
    />
  ));
}

function BlockView({
  block,
  caret,
  files,
}: {
  block: Block;
  caret: boolean;
  files?: Files | undefined;
}): ReactNode {
  const end = caret && <Caret />;
  switch (block.type) {
    case "heading": {
      const Tag = `h${Math.min(block.level + 2, 6)}` as "h3" | "h4" | "h5" | "h6";
      return (
        <Tag
          className={`mt-6 font-semibold tracking-tight first:mt-0 ${HEADING_STYLE[block.level - 1]}`}
        >
          <Inlines nodes={block.content} files={files} />
          {end}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p>
          <Inlines nodes={block.content} files={files} />
          {end}
        </p>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          start={block.ordered ? block.start : undefined}
          className={`space-y-1.5 pl-5 marker:text-neutral-500 ${block.ordered ? "list-decimal" : "list-disc"}`}
        >
          {block.items.map((item, index) => (
            <li
              key={index}
              className={`space-y-1.5 ${item.checked === undefined ? "pl-1" : "-ml-4 flex list-none items-baseline gap-2"}`}
            >
              {item.checked !== undefined && (
                <input
                  type="checkbox"
                  checked={item.checked}
                  readOnly
                  disabled
                  className="size-3.5 shrink-0 translate-y-0.5 accent-neutral-400"
                />
              )}
              <div className="min-w-0 space-y-1.5">
                <Blocks
                  blocks={item.blocks}
                  caret={caret && index === block.items.length - 1}
                  files={files}
                />
              </div>
            </li>
          ))}
        </Tag>
      );
    }
    case "code":
      return (
        <CodeBlock lang={block.lang} code={block.code} live={caret && !block.closed} caret={end} />
      );
    case "table":
      return (
        <div className="overflow-x-auto rounded-lg border border-white/8">
          <table className="w-full border-collapse text-left text-[0.93em]">
            <thead className="bg-white/4">
              <tr>
                {block.header.map((cell, index) => (
                  <th
                    key={index}
                    scope="col"
                    className={`border-b border-white/8 px-3 py-1.5 font-semibold whitespace-nowrap text-neutral-100 ${ALIGN[block.align[index] ?? "left"]}`}
                  >
                    <Inlines nodes={cell} files={files} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, at) => (
                <tr key={at} className="border-t border-white/6 first:border-t-0">
                  {row.map((cell, index) => (
                    <td
                      key={index}
                      className={`px-3 py-1.5 align-top ${ALIGN[block.align[index] ?? "left"]}`}
                    >
                      <Inlines nodes={cell} files={files} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {end}
        </div>
      );
    case "quote": {
      const alert = block.alert && ALERTS[block.alert];
      return (
        <blockquote
          className={`space-y-2 border-l-2 pl-3.5 ${alert?.border ?? "border-white/15"} text-neutral-300`}
        >
          {alert && <p className={`text-xs font-semibold ${alert.text}`}>{alert.label}</p>}
          <Blocks blocks={block.blocks} caret={caret} files={files} />
          {!block.blocks.length && end}
        </blockquote>
      );
    }
    case "rule":
      return (
        <>
          <hr className="border-white/10" />
          {end}
        </>
      );
  }
}

/** One top-level block, parsed and rendered again only when its own source changes. */
const Section = memo(function Section({
  source,
  definitions,
  caret,
  files,
}: {
  source: string;
  /** The reply's reference definitions, which may sit in another section. */
  definitions: string;
  caret: boolean;
  files?: Files | undefined;
}) {
  const blocks = useMemo(
    () => parseMarkdown(definitions ? `${source}\n\n${definitions}` : source, files),
    [source, definitions, files],
  );
  return <Blocks blocks={blocks} caret={caret} files={files} />;
});

/**
 * Renders an agent reply. Builds React elements only, so reply text can never inject HTML. With
 * `chatId`, file references in code spans and links open in the chat's workspace. A streaming
 * reply re-parses only its last block: the others keep their source, so `Section` skips them.
 */
export function Markdown({
  text,
  streaming = false,
  chatId,
}: {
  text: string;
  streaming?: boolean;
  chatId?: string | undefined;
}) {
  const sections = useMemo(() => splitBlocks(text), [text]);
  const definitions = useMemo(() => referenceDefinitions(text), [text]);
  const { chats } = use(ChatLinks);
  const cwd = chatId === undefined ? null : (chats.find((chat) => chat.id === chatId)?.cwd ?? null);
  const files = useMemo(() => (chatId === undefined ? undefined : { chatId, cwd }), [chatId, cwd]);
  return (
    <div className="space-y-3 text-sm/relaxed text-neutral-200">
      {sections.map((source, index) => (
        <Section
          key={index}
          source={source}
          definitions={definitions}
          caret={streaming && index === sections.length - 1}
          files={files}
        />
      ))}
    </div>
  );
}
