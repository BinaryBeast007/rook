/**
 * An on/off switch: a native checkbox (so Space toggles it) drawn as a track and knob. Place it
 * inside the <label> that names it, or name it with `labelledBy`.
 */
export function Switch({
  checked,
  onChange,
  disabled,
  labelledBy,
  describedBy,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean | undefined;
  labelledBy?: string;
  describedBy?: string;
}) {
  return (
    <>
      <input
        type="checkbox"
        role="switch"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={`relative mt-0.5 h-4.5 w-8 shrink-0 rounded-full transition-colors peer-focus-visible:ring-1 peer-focus-visible:ring-white/40 peer-disabled:opacity-45 motion-reduce:transition-none ${
          checked ? "bg-paper" : "bg-white/12"
        }`}
      >
        <span
          className={`absolute top-0.5 size-3.5 rounded-full transition-[left] motion-reduce:transition-none ${
            checked ? "left-4 bg-ink" : "left-0.5 bg-neutral-400"
          }`}
        />
      </span>
    </>
  );
}
