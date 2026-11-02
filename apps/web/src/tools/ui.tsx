// Pieces shared by the side tools in ToolPanel (Changes, Browser, Terminal, Files).
import { Fragment, useEffect, useId, useRef, type ReactNode } from "react";

import { FOCUS } from "../chat/Picker.tsx";
import { roveFocus } from "../chat/roving.ts";
import { usePopover } from "../chat/usePopover.ts";
import { IconButton } from "../IconButton.tsx";
import { CheckIcon } from "../icons.tsx";

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 py-12 text-center">
      <span className="mb-2 flex size-9 items-center justify-center rounded-lg border border-white/6 text-neutral-500 [&>svg]:size-4.5">
        {icon}
      </span>
      <p className="text-sm text-neutral-300">{title}</p>
      <p className="max-w-64 text-xs/5 text-balance text-neutral-500">{children}</p>
    </div>
  );
}

/** A failure the user can read, with an optional way to try again. */
export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="mx-3 my-2 rounded-md bg-red-500/8 px-3 py-2 text-xs/5 text-red-300"
    >
      {message}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="ml-2 text-red-200 underline underline-offset-2 hover:text-red-100"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/** The message of an IPC rejection, without Electron's "Error invoking remote method" prefix. */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

export interface MenuEntry {
  label: string;
  icon?: ReactNode;
  /** A letter that picks the entry while the menu is open, shown at the right. */
  hint?: string;
  disabled?: boolean;
  /** Why it's disabled (or what it does), as a tooltip and accessible description. */
  description?: string | undefined;
  /** Marks the chosen one of a set, e.g. the preferred app. */
  checked?: boolean;
  /** Starts a new group, drawn with a line above. */
  separated?: boolean;
  onSelect: () => void;
}

/**
 * A toolbar button with a dropdown menu. Opens with focus on the first available item; the
 * arrows, Home and End move, Enter or Space (or an entry's hint letter) picks, Escape closes.
 */
export function Menu({
  label,
  trigger,
  align,
  className = "",
  menuClassName = "w-48",
  entries,
}: {
  /** The button's accessible name, also the menu's. */
  label: string;
  trigger: ReactNode;
  align: "left" | "right";
  className?: string;
  /** The dropdown's width. */
  menuClassName?: string;
  entries: MenuEntry[];
}) {
  const { open, setOpen, close, rootRef, triggerRef, onKeyDown } = usePopover();
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>("[data-rove]:not([aria-disabled])")?.focus();
  }, [open]);
  const pick = (entry: MenuEntry) => {
    if (entry.disabled) return;
    close();
    entry.onSelect();
  };

  return (
    <div
      ref={rootRef}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        // Pressing into a <webview> moves focus to it; outside presses don't reach here.
        const next = event.relatedTarget;
        if (open && next && !rootRef.current?.contains(next)) setOpen(false);
      }}
      className="relative shrink-0"
    >
      <IconButton
        ref={triggerRef}
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
        className={`aria-expanded:bg-white/6 ${className}`}
      >
        {trigger}
      </IconButton>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            const entry = entries.find(
              (item) => item.hint && item.hint.toLowerCase() === event.key.toLowerCase(),
            );
            if (entry && !event.ctrlKey && !event.metaKey && !event.altKey) {
              event.preventDefault();
              pick(entry);
            } else roveFocus(event);
          }}
          className={`absolute top-full z-20 mt-1 ${menuClassName} rounded-xl border border-white/8 bg-raised p-1.5 shadow-2xl motion-safe:animate-dialog-in ${align === "right" ? "right-0" : "left-0"}`}
        >
          {entries.map((entry) => (
            <Fragment key={entry.label}>
              {entry.separated && <div role="separator" className="mx-1 my-1 h-px bg-white/6" />}
              <button
                type="button"
                role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={entry.checked}
                title={entry.description}
                aria-description={entry.description}
                // aria-disabled keeps it reachable with the arrows, as in the composer's menus.
                aria-disabled={entry.disabled || undefined}
                aria-keyshortcuts={entry.hint}
                tabIndex={-1}
                data-rove
                onClick={() => pick(entry)}
                className={`flex h-7 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-neutral-200 transition-colors hover:bg-white/6 focus-visible:bg-white/6 aria-disabled:cursor-default aria-disabled:opacity-45 aria-disabled:hover:bg-transparent motion-reduce:transition-none [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-neutral-500 ${FOCUS}`}
              >
                {entry.icon}
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                {entry.hint && (
                  // aria-keyshortcuts already tells assistive tech; keep it out of the name.
                  <kbd aria-hidden="true" className="font-sans text-xs text-neutral-500">
                    {entry.hint}
                  </kbd>
                )}
                {entry.checked && <CheckIcon aria-hidden="true" className="text-neutral-300!" />}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
