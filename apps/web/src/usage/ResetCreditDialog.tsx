import { useEffect, useId, useRef, useState } from "react";

const BUTTON =
  "h-7 rounded-md px-3 text-xs font-medium transition-colors focus-visible:ring-1 focus-visible:ring-white/40 focus-visible:outline-none disabled:opacity-50";

/**
 * Confirms spending a reset credit. A native modal <dialog> keeps focus inside, makes the page
 * behind it inert, cancels on Escape, and returns focus to the opener when it closes.
 */
export function ResetCreditDialog({
  provider,
  title,
  onConfirm,
  onClose,
}: {
  provider: string;
  title: string | null;
  /** Never rejects; the caller reports the outcome. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const headingId = useId();
  const bodyId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      role="alertdialog"
      aria-labelledby={headingId}
      aria-describedby={bodyId}
      onClose={onClose}
      // Stay open while the credit is being redeemed; the confirm button shows the progress.
      onCancel={(event) => busy && event.preventDefault()}
      // Escape belongs to the dialog, not the Usage view behind it.
      onKeyDown={(event) => event.key === "Escape" && event.stopPropagation()}
      className="m-auto w-[min(24rem,calc(100%-2rem))] rounded-lg border border-white/8 bg-raised p-5 text-neutral-200 shadow-xl backdrop:bg-black/60"
    >
      <h2 id={headingId} className="text-sm font-medium text-neutral-100">
        Use a reset credit?
      </h2>
      <div id={bodyId} className="mt-2 text-xs/5 text-neutral-400">
        {title && <p className="text-neutral-300">{title}</p>}
        <p className={title ? "mt-1" : ""}>
          Redeems one credit on your {provider} account and clears your current rate-limit windows.
          This can't be undone.
        </p>
      </div>
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
          aria-busy={busy}
          onClick={() => {
            setBusy(true);
            void onConfirm().finally(() => ref.current?.close());
          }}
          className={`${BUTTON} bg-white/10 text-neutral-100 hover:bg-white/14 active:bg-white/18`}
        >
          {busy ? "Using credit…" : "Use credit"}
        </button>
      </div>
    </dialog>
  );
}
