import { useEffect, useId, useRef, useState } from "react";

import { ipcErrorMessage } from "../agents.ts";
import { desktop } from "../desktop.ts";
import { IconButton } from "../IconButton.tsx";
import { PencilIcon } from "../icons.tsx";

const BUTTON =
  "h-7 rounded-md px-3 text-xs font-medium transition-colors focus-visible:ring-1 focus-visible:ring-white/40 focus-visible:outline-none disabled:opacity-50";

/**
 * A user message's "Edit from here" action: confirms, removes the message and everything after
 * it (optionally reverting the files those turns changed), then hands its text to `onEdit`.
 */
export function EditFromHere({
  chatId,
  messageId,
  revertable,
  onEdit,
}: {
  chatId: string;
  messageId: string;
  /** Whether a removed reply changed files, so "Revert files too" has something to revert. */
  revertable: boolean;
  onEdit: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton label="Edit from here" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <PencilIcon />
      </IconButton>
      {open && (
        <ConfirmDialog
          chatId={chatId}
          messageId={messageId}
          revertable={revertable}
          onEdit={onEdit}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * A native modal <dialog> keeps focus inside, makes the chat behind it inert, cancels on Escape,
 * and returns focus to the opener when cancelled. After a rewind the opener is gone with its
 * message, and `onEdit` puts focus in the composer.
 */
function ConfirmDialog({
  chatId,
  messageId,
  revertable,
  onEdit,
  onClose,
}: {
  chatId: string;
  messageId: string;
  revertable: boolean;
  onEdit: (text: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const bodyId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const rewind = async (revertFiles: boolean) => {
    if (!desktop) return;
    setBusy(true);
    setError(null);
    try {
      const { text } = await desktop.chat.rewind(chatId, messageId, { revertFiles });
      ref.current?.close();
      onEdit(text);
    } catch (cause: unknown) {
      setError(ipcErrorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      role="alertdialog"
      aria-labelledby={headingId}
      aria-describedby={bodyId}
      onClose={onClose}
      // Stay open while files are being reverted.
      onCancel={(event) => busy && event.preventDefault()}
      // Escape belongs to the dialog, not the composer or chat behind it.
      onKeyDown={(event) => event.key === "Escape" && event.stopPropagation()}
      className="m-auto w-[min(24rem,calc(100%-2rem))] rounded-lg border border-white/8 bg-raised p-5 text-neutral-200 shadow-xl backdrop:bg-black/60"
    >
      <h2 id={headingId} className="text-sm font-medium text-neutral-100">
        Edit from here?
      </h2>
      <p id={bodyId} className="mt-2 text-xs/5 text-neutral-400">
        This message and everything after it will be removed, and its text goes back in the
        composer.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-xs text-amber-300">
          {error}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          autoFocus
          disabled={busy}
          onClick={() => ref.current?.close()}
          className={`${BUTTON} text-neutral-300 hover:bg-white/6 hover:text-neutral-100`}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void rewind(false)}
          className={`${BUTTON} bg-white/6 text-neutral-200 hover:bg-white/10`}
        >
          Keep files
        </button>
        <button
          type="button"
          disabled={busy || !revertable}
          onClick={() => void rewind(true)}
          className={`${BUTTON} bg-white/10 text-neutral-100 hover:bg-white/14 active:bg-white/18`}
        >
          Revert files too
        </button>
      </div>
    </dialog>
  );
}
