import type { ChatSettings } from "@rook/contracts";

import { FOCUS, NEUTRAL_TONE, useSave } from "./Picker.tsx";
import { togglePlan } from "./plans.ts";

/**
 * Plan mode for the next turn: the agent researches and proposes a plan instead of changing
 * anything. Shift+Tab in the composer does the same (`togglePlan`).
 */
export function PlanToggle({
  settings,
  onChange,
}: {
  settings: ChatSettings;
  /** Saves the settings; rejects with a message safe to show. */
  onChange: (settings: ChatSettings) => Promise<void>;
}) {
  const { saveError, save } = useSave(onChange);
  const on = settings.plan === true;
  const label = `Plan mode: ${on ? "on" : "off"} (Shift+Tab)`;

  return (
    <div className="flex min-w-0 items-center">
      <button
        type="button"
        aria-pressed={on}
        aria-label="Plan mode"
        title={label}
        onClick={() => void save(togglePlan(settings))}
        className={`flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-white/6 motion-reduce:transition-none ${
          on ? "bg-sky-300/10 text-sky-300 hover:text-sky-200" : NEUTRAL_TONE
        } ${FOCUS}`}
      >
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${on ? "bg-sky-300" : "bg-neutral-600"}`}
        />
        Plan
      </button>
      {saveError && (
        <span role="alert" className="ml-1 truncate text-xs text-amber-300">
          {saveError}
        </span>
      )}
    </div>
  );
}
