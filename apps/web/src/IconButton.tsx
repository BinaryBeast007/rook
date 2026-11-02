import type { ComponentProps } from "react";

interface IconButtonProps extends ComponentProps<"button"> {
  /** Accessible name, also shown as the hover tooltip. */
  label: string;
}

export function IconButton({ label, className = "", children, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`app-region-no-drag inline-flex size-8 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-white/6 hover:text-neutral-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none active:bg-white/10 [&>svg]:size-4.5 ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
