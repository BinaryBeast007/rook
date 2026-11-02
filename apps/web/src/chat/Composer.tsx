import { ATTACHMENT_LIMITS, type AttachmentUpload, type SendInput } from "@rook/contracts";
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";

import { ipcErrorMessage } from "../agents.ts";
import { desktop } from "../desktop.ts";
import { IconButton } from "../IconButton.tsx";
import { ArrowUpIcon, CloseIcon, PaperclipIcon, StopIcon } from "../icons.tsx";
import { checkAttachment } from "./attachments.ts";
import { FileChip } from "./MessageView.tsx";

const isMac = desktop ? desktop.platform === "darwin" : /Mac/.test(navigator.platform);
const STEER_KEY = isMac ? "⌘Enter" : "Ctrl+Enter";

const PILL =
  "inline-flex h-8 shrink-0 items-center rounded-full px-3 text-xs font-medium transition-colors focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-ink focus-visible:outline-none";

export interface ComposerHandle {
  /** Replaces the draft and focuses it, ready to edit or send. */
  fill(text: string): void;
  /** Attaches files, e.g. dropped on the chat. */
  addFiles(files: readonly File[]): void;
  /** Puts the caret in the message box. */
  focus(): void;
}

interface Pending {
  readonly id: string;
  readonly file: File;
  readonly kind: "image" | "text";
  readonly mediaType: string;
  /** A Blob URL previewing an image. */
  readonly url: string | null;
}

interface ComposerProps {
  ref?: Ref<ComposerHandle>;
  agentName: string;
  /** A turn is running: Send turns into Queue (and Steer), beside Stop. */
  busy: boolean;
  /** The agent can add a message to its running turn. */
  steering: boolean;
  /** The selected model reads images. */
  images: boolean;
  /** Footer controls beside the attach button, e.g. effort and permissions. */
  leftControls: ReactNode;
  /** Footer controls before Send, e.g. the model picker. */
  rightControls: ReactNode;
  /**
   * Starts the turn, or queues or steers the message while one runs. Rejects with a message safe
   * to show, and the draft is kept.
   */
  onSend: (input: SendInput) => Promise<void>;
  onStop: () => void;
  /** Replaces the default prompt, e.g. while the agent waits on an answer. */
  placeholder?: string | undefined;
  /** Shift+Tab in the message box turns plan mode on or off. */
  onTogglePlan?: (() => void) | undefined;
}

function PendingChip({ item, onRemove }: { item: Pending; onRemove: () => void }) {
  return (
    <li className="group/chip relative">
      {item.kind === "image" ? (
        <span
          title={item.file.name}
          className="block size-14 overflow-hidden rounded-lg border border-white/8 bg-white/4"
        >
          {item.url && (
            <img src={item.url} alt={item.file.name} className="size-full object-cover" />
          )}
        </span>
      ) : (
        <FileChip name={item.file.name} size={item.file.size} />
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${item.file.name}`}
        title="Remove"
        className="absolute -top-1.5 -right-1.5 inline-flex size-5 items-center justify-center rounded-full border border-white/10 bg-neutral-800 text-neutral-300 opacity-0 transition-opacity group-hover/chip:opacity-100 hover:text-neutral-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none motion-reduce:transition-none"
      >
        <CloseIcon className="size-3" />
      </button>
    </li>
  );
}

/**
 * The prompt box. Enter sends, Shift+Enter adds a line. While a turn runs, Enter queues the
 * message for after it, Ctrl/⌘+Enter steers it into the turn (where the agent can), and Escape
 * stops the turn.
 */
export function Composer({
  ref,
  agentName,
  busy,
  steering,
  images,
  leftControls,
  rightControls,
  onSend,
  onStop,
  placeholder,
  onTogglePlan,
}: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [items, setItems] = useState<readonly Pending[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const empty = draft.trim() === "" && items.length === 0;
  const blocked = sending || empty;
  // Every preview URL made here, revoked when the composer goes away.
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const made = urls.current;
    return () => {
      for (const url of made) URL.revokeObjectURL(url);
      made.clear();
    };
  }, []);

  const discard = (list: readonly Pending[]) => {
    for (const { url } of list) {
      if (!url) continue;
      URL.revokeObjectURL(url);
      urls.current.delete(url);
    }
  };

  const addFiles = (files: readonly File[]) => {
    const problems: string[] = [];
    const added: Pending[] = [];
    for (const file of files) {
      if (items.length + added.length >= ATTACHMENT_LIMITS.maxFiles) {
        problems.push(`A message can carry up to ${ATTACHMENT_LIMITS.maxFiles} files.`);
        break;
      }
      const check = checkAttachment(file, images);
      if (!check.ok) {
        problems.push(check.error);
        continue;
      }
      const url = check.kind === "image" ? URL.createObjectURL(file) : null;
      if (url) urls.current.add(url);
      added.push({
        id: crypto.randomUUID(),
        file,
        kind: check.kind,
        mediaType: check.mediaType,
        url,
      });
    }
    setItems((list) => [...list, ...added]);
    setNotice(problems.length ? problems.join(" ") : null);
    if (added.length) input.current?.focus();
  };

  useImperativeHandle(ref, () => ({
    fill(text) {
      setDraft(text);
      const element = input.current;
      element?.focus();
      // Put the caret after the filled text, after React has rendered it.
      requestAnimationFrame(() => element?.setSelectionRange(text.length, text.length));
    },
    addFiles,
    focus: () => input.current?.focus(),
  }));

  const submit = async (mode: "queue" | "steer" = "queue") => {
    // Clicking Send moves focus to the button; the next prompt is typed in the box.
    input.current?.focus();
    if (blocked) return;
    if (!images && items.some((item) => item.kind === "image")) {
      setError("This model can't read images. Remove them or pick another model.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const attachments: AttachmentUpload[] = await Promise.all(
        items.map(async (item) => ({
          name: item.file.name,
          mediaType: item.mediaType,
          data: new Uint8Array(await item.file.arrayBuffer()),
        })),
      );
      await onSend(
        busy ? { text: draft.trim(), attachments, mode } : { text: draft.trim(), attachments },
      );
      setDraft("");
      discard(items);
      setItems([]);
      setNotice(null);
    } catch (cause: unknown) {
      setError(ipcErrorMessage(cause));
    } finally {
      setSending(false);
    }
  };

  const message = error ?? notice;

  return (
    <div>
      {message && (
        <div
          role="alert"
          className="mb-2 flex items-start gap-2 rounded-lg border border-amber-300/20 bg-amber-300/[0.06] py-2 pr-1.5 pl-3 text-xs/5 text-amber-200"
        >
          <span className="min-w-0 flex-1">{message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              setError(null);
              setNotice(null);
            }}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded text-amber-200/70 hover:text-amber-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none"
          >
            <CloseIcon className="size-3.5" />
          </button>
        </div>
      )}
      <div className="@container rounded-xl border border-white/8 bg-white/[0.03] transition-colors focus-within:border-white/16 focus-within:bg-white/[0.045] motion-reduce:transition-none">
        {items.length > 0 && (
          <ul aria-label="Attachments" className="flex flex-wrap gap-2 px-3 pt-3">
            {items.map((item) => (
              <PendingChip
                key={item.id}
                item={item}
                onRemove={() => {
                  discard([item]);
                  setItems((list) => list.filter((other) => other.id !== item.id));
                  setNotice(null);
                  input.current?.focus();
                }}
              />
            ))}
          </ul>
        )}
        <textarea
          ref={input}
          value={draft}
          autoFocus
          rows={1}
          aria-label={`Message ${agentName}`}
          placeholder={
            placeholder ?? (busy ? `Queue a follow-up for ${agentName}…` : `Ask ${agentName} to…`)
          }
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            // Rich copies (e.g. from a document) carry text and an image; the text is what's meant.
            if (files.length && !event.clipboardData.types.includes("text/plain")) {
              event.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit(steering && (isMac ? event.metaKey : event.ctrlKey) ? "steer" : "queue");
            } else if (
              event.key === "Tab" &&
              event.shiftKey &&
              !event.ctrlKey &&
              !event.altKey &&
              !event.metaKey &&
              onTogglePlan
            ) {
              event.preventDefault();
              onTogglePlan();
            } else if (event.key === "Escape" && busy) {
              event.preventDefault();
              onStop();
            }
          }}
          // field-sizing grows the box with its text (Chromium, so the Electron window); max-h caps it near ten lines.
          className="block max-h-60 min-h-12 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-sm/6 text-neutral-100 select-text [field-sizing:content] placeholder:text-neutral-500 focus:outline-none"
        />
        <div className="flex items-center justify-between gap-2 py-2 pr-2 pl-1.5">
          <div className="flex shrink-0 items-center gap-0.5">
            <IconButton
              label="Attach files"
              onClick={() => picker.current?.click()}
              className="size-7 shrink-0 [&>svg]:size-4"
            >
              <PaperclipIcon />
            </IconButton>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              tabIndex={-1}
              onChange={(event) => {
                addFiles([...(event.target.files ?? [])]);
                event.target.value = ""; // Picking the same file again still fires a change.
              }}
            />
            {leftControls}
          </div>
          <div className="flex min-w-0 items-center gap-0.5">
            {rightControls}
            {busy ? (
              <>
                {steering && (
                  <button
                    type="button"
                    onClick={() => void submit("steer")}
                    aria-disabled={blocked}
                    aria-keyshortcuts={isMac ? "Meta+Enter" : "Control+Enter"}
                    title={`Steer: add to the running turn (${STEER_KEY})`}
                    className={`ml-1.5 ${PILL} ${blocked ? "bg-white/4 text-neutral-500" : "bg-white/8 text-neutral-100 hover:bg-white/12"}`}
                  >
                    Steer
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void submit("queue")}
                  aria-disabled={blocked}
                  aria-busy={sending}
                  aria-keyshortcuts="Enter"
                  title="Queue: send when this turn ends (Enter)"
                  className={`ml-1.5 ${PILL} ${blocked ? "bg-white/8 text-neutral-500" : "bg-paper text-ink hover:bg-white"}`}
                >
                  Queue
                </button>
                <button
                  type="button"
                  onClick={onStop}
                  aria-label="Stop"
                  title="Stop (Esc)"
                  // Queue takes the lead once there is something to queue.
                  className={`ml-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-ink focus-visible:outline-none ${
                    blocked
                      ? "bg-paper text-ink hover:bg-white"
                      : "bg-white/8 text-neutral-100 hover:bg-white/12"
                  }`}
                >
                  <StopIcon className="size-4" />
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                aria-label="Send"
                aria-disabled={blocked}
                aria-busy={sending}
                className={`ml-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-ink focus-visible:outline-none ${
                  blocked ? "bg-white/8 text-neutral-500" : "bg-paper text-ink hover:bg-white"
                }`}
              >
                <ArrowUpIcon className="size-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
