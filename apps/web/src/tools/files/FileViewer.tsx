import type { FileContent, FilesBridge } from "@rook/contracts";
import { useEffect, useRef, useState } from "react";

import { IconButton } from "../../IconButton.tsx";
import { ChevronIcon, FileIcon } from "../../icons.tsx";
import { EmptyState, ErrorNote, errorMessage } from "../ui.tsx";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A read-only view of one file. `version` changes when the file may have changed on disk. `at`
 * scrolls to a 1-based line and flashes it; a new `id` does it again.
 */
export function FileViewer({
  files,
  chatId,
  path,
  version,
  at = null,
  onBack,
}: {
  files: FilesBridge;
  chatId: string;
  path: string;
  version: number;
  at?: { readonly line: number; readonly id: string } | null;
  onBack: () => void;
}) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    files.read(chatId, path).then(
      (read) => {
        if (!current) return;
        setContent(read);
        setError(null);
      },
      (cause: unknown) => current && setError(errorMessage(cause)),
    );
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- version and attempt are reload triggers
  }, [files, chatId, path, version, attempt]);

  // Keep the last good content while a refresh loads, but never show another file's.
  const shown = content?.path === path ? content : null;
  const name = path.slice(path.lastIndexOf("/") + 1);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.key === "Escape") onBack();
      }}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-white/6 pr-3 pl-1.5">
        <IconButton label="Back to files" autoFocus onClick={onBack} className="[&>svg]:size-4">
          <ChevronIcon className="rotate-180" />
        </IconButton>
        <span title={path} className="min-w-0 flex-1 truncate text-xs text-neutral-300">
          {path}
        </span>
        {shown && (
          <span className="shrink-0 text-2xs text-neutral-500">{formatSize(shown.size)}</span>
        )}
      </div>
      {error ? (
        <ErrorNote message={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : !shown ? (
        <p className="px-4 py-3 text-xs text-neutral-500">Loading…</p>
      ) : shown.kind === "binary" ? (
        <EmptyState icon={<FileIcon />} title="Not a text file">
          {name} looks like binary data, so it isn't shown here.
        </EmptyState>
      ) : shown.kind === "tooLarge" ? (
        <EmptyState icon={<FileIcon />} title="Too large to show">
          {name} is {formatSize(shown.size)}. Files over 1 MB aren't shown here.
        </EmptyState>
      ) : !shown.text ? (
        <p className="px-4 py-3 text-xs text-neutral-500">This file is empty.</p>
      ) : (
        <Code text={shown.text} label={`Contents of ${name}`} at={at} />
      )}
    </div>
  );
}

// Code lines are `leading-5` under `py-2`: 1.25rem each, after 0.5rem.
const LINE_REM = 1.25;
const TOP_REM = 0.5;

function Code({
  text,
  label,
  at,
}: {
  text: string;
  label: string;
  at: { readonly line: number; readonly id: string } | null;
}) {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n").length - (normalized.endsWith("\n") ? 1 : 0);
  const region = useRef<HTMLDivElement>(null);
  // A line past the end goes to the last one.
  const line = at && Math.min(at.line, Math.max(lines, 1));
  // The line sits a third of the way down, under the lines before it.
  // `at` is new only on a reveal, so a file refreshing on disk doesn't scroll back.
  useEffect(() => {
    const element = region.current;
    if (!element || !at || !line) return;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    element.scrollTop = (TOP_REM + (line - 1) * LINE_REM) * rem - element.clientHeight / 3;
  }, [at, line]);
  // One text node per column, so a 1 MB file is two DOM nodes, not tens of thousands.
  const gutter = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
  return (
    <div
      role="region"
      ref={region}
      aria-label={label}
      tabIndex={0}
      className="min-h-0 flex-1 overflow-auto font-mono text-code/5 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none focus-visible:ring-inset"
    >
      <div className="relative flex min-w-max py-2">
        {at && line && (
          // Fades out after a moment; stays when motion is reduced.
          <div
            key={at.id}
            aria-hidden="true"
            style={{ top: `${TOP_REM + (line - 1) * LINE_REM}rem` }}
            className="pointer-events-none absolute inset-x-0 h-5 bg-amber-300/12 motion-safe:animate-[fade-in_1s_ease-in_1.2s_reverse_both]"
          />
        )}
        <pre
          aria-hidden="true"
          className="sticky left-0 shrink-0 bg-surface pr-3 pl-4 text-right text-neutral-600"
        >
          {gutter}
        </pre>
        <pre className="pr-4 text-neutral-300 select-text [tab-size:4]">{normalized}</pre>
      </div>
    </div>
  );
}
