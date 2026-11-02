import type { ChatSettings } from "@rook/contracts";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { ipcErrorMessage } from "../agents.ts";
import { CheckIcon, ChevronIcon } from "../icons.tsx";
import { roveFocus } from "./roving.ts";
import { usePopover } from "./usePopover.ts";

export const FOCUS = "focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none";

export const NEUTRAL_TONE =
  "text-neutral-400 hover:text-neutral-200 aria-expanded:text-neutral-200";

/** Saves settings and keeps a rejection to show; resolves true once saved. */
export function useSave(onChange: (settings: ChatSettings) => Promise<void>) {
  const [saveError, setSaveError] = useState<string | null>(null);
  const save = async (next: ChatSettings) => {
    setSaveError(null);
    try {
      await onChange(next);
      return true;
    } catch (cause: unknown) {
      setSaveError(ipcErrorMessage(cause));
      return false;
    }
  };
  return { saveError, save };
}

export function SaveError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="border-t border-white/6 px-3 py-2 text-xs text-amber-300">
      {message}
    </p>
  );
}

/**
 * A composer footer control: a small text button with a panel that opens above it (or below,
 * elsewhere). The panel closes on Escape (focus returns to the button), a press outside, or
 * tabbing out of it.
 */
export function Picker({
  label,
  haspopup,
  align,
  placement = "above",
  tone = NEUTRAL_TONE,
  trigger,
  panelClassName,
  children,
}: {
  /** The button's accessible name, naming the current choice. */
  label: string;
  haspopup: "menu" | "dialog";
  align: "left" | "right";
  placement?: "above" | "below";
  tone?: string;
  trigger: ReactNode;
  panelClassName: string;
  children: (close: () => void) => ReactNode;
}) {
  const { open, setOpen, close, rootRef, triggerRef, onKeyDown } = usePopover();
  const panelId = useId();

  return (
    <div
      ref={rootRef}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        // Only a real move elsewhere closes it: a focused option unmounting reports no target.
        const next = event.relatedTarget;
        if (open && next && !rootRef.current?.contains(next)) setOpen(false);
      }}
      className="relative min-w-0"
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup={haspopup}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(!open)}
        className={`flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-white/6 aria-expanded:bg-white/6 motion-reduce:transition-none ${tone} ${FOCUS}`}
      >
        {trigger}
        <ChevronIcon
          className={`size-3 shrink-0 text-neutral-500 ${placement === "above" ? "-rotate-90" : "rotate-90"}`}
        />
      </button>
      {open && (
        <div
          id={panelId}
          tabIndex={-1}
          className={`absolute z-20 overflow-hidden rounded-xl border border-white/8 bg-raised shadow-2xl focus:outline-none motion-safe:animate-dialog-in ${
            placement === "above" ? "bottom-full mb-2" : "top-full mt-2"
          } ${align === "right" ? "right-0" : "left-0"} ${panelClassName}`}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

export interface MenuChoice<T> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
  /** Text color of the label. */
  readonly tone?: string | undefined;
  /** A CSS font-family for the label, to preview a font. */
  readonly font?: string | undefined;
}

/**
 * A radio menu: opens with focus on the checked choice; the arrows, Home and End move between
 * choices, Enter or Space picks one.
 */
export function RadioMenu<T>({
  labelledBy,
  choices,
  value,
  onSelect,
}: {
  labelledBy: string;
  choices: readonly MenuChoice<T>[];
  value: T;
  onSelect: (value: T) => void;
}) {
  const checked = Math.max(
    0,
    choices.findIndex((choice) => choice.value === value),
  );
  const [focused, setFocused] = useState(checked);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => menu.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus(), []);

  return (
    <div
      ref={menu}
      role="menu"
      aria-labelledby={labelledBy}
      onKeyDown={roveFocus}
      className="space-y-px p-1.5"
    >
      {choices.map((choice, index) => (
        <button
          key={String(choice.value)}
          type="button"
          role="menuitemradio"
          aria-checked={choice.value === value}
          // aria-disabled keeps it reachable with the arrows, so its reason is read out.
          aria-disabled={choice.disabled || undefined}
          tabIndex={index === focused ? 0 : -1}
          data-rove
          onFocus={() => setFocused(index)}
          onClick={() => !choice.disabled && onSelect(choice.value)}
          className={`flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-white/6 focus-visible:bg-white/6 aria-disabled:cursor-default aria-disabled:opacity-45 aria-disabled:hover:bg-transparent motion-reduce:transition-none ${FOCUS}`}
        >
          <span className="min-w-0 flex-1">
            <span
              className={`block text-sm ${choice.tone ?? "text-neutral-200"}`}
              style={choice.font ? { fontFamily: choice.font } : undefined}
            >
              {choice.label}
            </span>
            {choice.description && (
              <span className="block text-xs text-neutral-500">{choice.description}</span>
            )}
          </span>
          {choice.value === value && (
            <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-neutral-300" />
          )}
        </button>
      ))}
    </div>
  );
}

/** The small heading a menu panel is labelled by. */
export function PanelTitle({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="px-4 pt-2.5 text-xs font-medium text-neutral-500">
      {children}
    </p>
  );
}
