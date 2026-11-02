import type { ContextUsage } from "@rook/contracts";
import { useId, useState } from "react";

import { displayPercent, formatCompact, meterTone, type MeterTone } from "../usage/format.ts";
import { FOCUS } from "./Picker.tsx";

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const ARC: Record<MeterTone, string> = {
  normal: "text-neutral-400",
  warning: "text-amber-400",
  critical: "text-red-400",
};

/** How full the context window is, as the agent last reported it. */
export function ContextMeter({ context, agentName }: { context: ContextUsage; agentName: string }) {
  const [tip, setTip] = useState(false);
  const tipId = useId();
  if (context.window <= 0) return null;
  const exact = (context.used / context.window) * 100;
  const percent = displayPercent(exact);
  const amounts = `${formatCompact(context.used)} of ${formatCompact(context.window)} tokens`;
  const filled = (Math.min(Math.max(exact, 0), 100) / 100) * CIRCUMFERENCE;

  return (
    <div
      className="relative shrink-0"
      onMouseEnter={() => setTip(true)}
      onMouseLeave={() => setTip(false)}
    >
      <div
        role="meter"
        tabIndex={0}
        aria-label="Context window"
        aria-valuemin={0}
        aria-valuemax={context.window}
        aria-valuenow={Math.min(context.used, context.window)}
        aria-valuetext={`${percent}% used, ${amounts}`}
        aria-describedby={tipId}
        onFocus={() => setTip(true)}
        onBlur={() => setTip(false)}
        onKeyDown={(event) => {
          // The tooltip can be dismissed without moving away (WCAG 1.4.13).
          if (event.key !== "Escape" || !tip) return;
          event.stopPropagation();
          setTip(false);
        }}
        className={`inline-flex size-7 items-center justify-center rounded-md hover:bg-white/6 ${FOCUS}`}
      >
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          className={`size-4 -rotate-90 ${ARC[meterTone(exact)]}`}
        >
          <circle
            cx="8"
            cy="8"
            r={RADIUS}
            fill="none"
            strokeWidth="2"
            className="stroke-white/10"
          />
          {filled > 0 && (
            <circle
              cx="8"
              cy="8"
              r={RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={`${filled} ${CIRCUMFERENCE}`}
            />
          )}
        </svg>
      </div>
      <div
        id={tipId}
        role="tooltip"
        hidden={!tip}
        className="absolute right-0 bottom-full z-20 mb-2 w-max max-w-64 rounded-lg border border-white/8 bg-raised px-3 py-2 text-xs shadow-2xl motion-safe:animate-fade-in"
      >
        <p className="text-neutral-200">{`Context: ${amounts} (${percent}%)`}</p>
        <p className="mt-0.5 text-xs text-neutral-500">
          Reported by {agentName} after the last turn.
        </p>
      </div>
    </div>
  );
}
