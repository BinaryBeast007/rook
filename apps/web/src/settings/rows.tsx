// Building blocks for the Settings view: titled sections of rows, each a label, one line of
// description and a control.
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import { FOCUS } from "../chat/Picker.tsx";
import { Switch } from "../Switch.tsx";

/** Tone for a Picker used as a settings dropdown. */
export const SELECT_TONE =
  "border border-white/8 text-neutral-200 hover:text-paper aria-expanded:text-paper";

/** A page's rows. The page header already shows `title`, so here it only names the section. */
export function Section({
  title,
  action,
  children,
}: {
  title: string;
  /** Sits above the rows at the right, e.g. the scope picker. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      {action && <div className="flex min-h-9 items-center justify-end gap-3 pb-2">{action}</div>}
      <div className="divide-y divide-white/6 border-y border-white/6">{children}</div>
    </section>
  );
}

/** For a per-project row under a project scope: whether it follows all projects, and its reset. */
export interface Scoped {
  readonly inherited: boolean;
  readonly onReset: () => void;
}

/** `children` gets the ids that name and describe its control. */
export function Row({
  label,
  description,
  scoped,
  children,
}: {
  label: string;
  description: string;
  scoped?: Scoped | undefined;
  children: (labelId: string, descriptionId: string) => ReactNode;
}) {
  const labelId = useId();
  const descriptionId = useId();
  const control = useRef<HTMLDivElement>(null);

  const reset = () => {
    scoped?.onReset();
    // The reset button goes away, so focus moves on to the control it reset.
    control.current?.querySelector<HTMLElement>("button, input")?.focus();
  };

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 py-4">
      <div className="min-w-0 flex-1 basis-64">
        <p id={labelId} className="text-sm text-neutral-200">
          {label}
        </p>
        <p id={descriptionId} className="mt-0.5 text-xs/5 text-neutral-500">
          {description}
        </p>
        {scoped && (
          <p
            className={`mt-1 text-xs ${scoped.inherited ? "text-neutral-500" : "text-neutral-300"}`}
          >
            {scoped.inherited ? "Same as all projects" : "Set for this project"}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {scoped && !scoped.inherited && (
          <button
            type="button"
            aria-label={`Reset ${label.toLowerCase()} to the all projects setting`}
            onClick={reset}
            className={`h-7 rounded-md px-2 text-xs text-neutral-400 transition-colors hover:bg-white/6 hover:text-neutral-100 motion-reduce:transition-none ${FOCUS}`}
          >
            Reset
          </button>
        )}
        <div ref={control} className="flex">
          {children(labelId, descriptionId)}
        </div>
      </div>
    </div>
  );
}

/** A row with an on/off switch. */
export function SwitchRow({
  label,
  description,
  scoped,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  scoped?: Scoped | undefined;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Row label={label} description={description} scoped={scoped}>
      {(labelId, descriptionId) => (
        <Switch
          checked={checked}
          disabled={disabled}
          onChange={onChange}
          labelledBy={labelId}
          describedBy={descriptionId}
        />
      )}
    </Row>
  );
}

const STEPS: Partial<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/** A row of radio buttons. The arrow keys move the choice, as in any radio group. */
export function Segmented<T extends string>({
  labelledBy,
  describedBy,
  value,
  options,
  onChange,
}: {
  labelledBy: string;
  describedBy: string;
  value: T;
  options: readonly { readonly value: T; readonly label: string }[];
  onChange: (value: T) => void;
}) {
  const at = options.findIndex((option) => option.value === value);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = STEPS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = (at + step + options.length) % options.length;
    onChange(options[next]!.value);
    event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onKeyDown={onKeyDown}
      className="flex rounded-lg bg-white/4 p-0.5"
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={index === Math.max(at, 0) ? 0 : -1}
          onClick={() => onChange(option.value)}
          className={`h-7 rounded-md px-3 text-xs whitespace-nowrap text-neutral-400 transition-colors hover:text-neutral-100 aria-checked:bg-white/10 aria-checked:text-paper motion-reduce:transition-none ${FOCUS}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
