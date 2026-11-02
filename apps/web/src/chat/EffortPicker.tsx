import type { ChatSettings } from "@rook/contracts";
import { useId } from "react";

import { GaugeIcon } from "../icons.tsx";
import { PanelTitle, Picker, RadioMenu, SaveError, useSave } from "./Picker.tsx";
import { selectedModel } from "./settings.ts";
import { useCatalog } from "./useCatalog.ts";

/** Reasoning effort for the next turn; shown only for models that have the setting. */
export function EffortPicker({
  settings,
  onChange,
}: {
  settings: ChatSettings;
  /** Saves the settings; rejects with a message safe to show. */
  onChange: (settings: ChatSettings) => Promise<void>;
}) {
  const { catalog } = useCatalog(settings.agentId);
  const model = selectedModel(settings, catalog);
  if (!model || model.efforts.length === 0) return null;
  const fallback = model.defaultEffort;
  const word = settings.effort ?? fallback ?? "Effort";
  const label =
    settings.effort === null
      ? `Reasoning effort: default${fallback ? ` (${fallback})` : ""}`
      : `Reasoning effort: ${settings.effort}`;

  return (
    <Picker
      label={label}
      haspopup="menu"
      align="left"
      panelClassName="w-52"
      trigger={
        <>
          <GaugeIcon className="size-4 shrink-0" />
          <span className="hidden truncate @md:inline">{word}</span>
        </>
      }
    >
      {(close) => (
        <EffortMenu
          settings={settings}
          efforts={model.efforts}
          fallback={fallback}
          onChange={onChange}
          onDone={close}
        />
      )}
    </Picker>
  );
}

function EffortMenu({
  settings,
  efforts,
  fallback,
  onChange,
  onDone,
}: {
  settings: ChatSettings;
  efforts: readonly string[];
  fallback: string | null;
  onChange: (settings: ChatSettings) => Promise<void>;
  onDone: () => void;
}) {
  const titleId = useId();
  const { saveError, save } = useSave(onChange);
  const choices = [
    { value: null, label: fallback ? `Default (${fallback})` : "Default" },
    ...efforts.map((effort) => ({ value: effort, label: effort })),
  ];

  return (
    <>
      <PanelTitle id={titleId}>Reasoning effort</PanelTitle>
      <RadioMenu<string | null>
        labelledBy={titleId}
        choices={choices}
        value={settings.effort}
        onSelect={async (effort) => {
          if (await save({ ...settings, effort })) onDone();
        }}
      />
      <SaveError message={saveError} />
    </>
  );
}
