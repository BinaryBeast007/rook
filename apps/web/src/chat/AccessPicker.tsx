import type { AccessMode, ChatSettings } from "@rook/contracts";
import { useId, useState } from "react";

import { ShieldIcon } from "../icons.tsx";
import {
  FOCUS,
  NEUTRAL_TONE,
  PanelTitle,
  Picker,
  RadioMenu,
  SaveError,
  useSave,
} from "./Picker.tsx";
import { ACCESS_INFO, AGENT_NAMES, selectedModel } from "./settings.ts";
import { useCatalog } from "./useCatalog.ts";

/** How much the agent may do without asking. Full access always takes an explicit confirm. */
export function AccessPicker({
  settings,
  onChange,
}: {
  settings: ChatSettings;
  /** Saves the settings; rejects with a message safe to show. */
  onChange: (settings: ChatSettings) => Promise<void>;
}) {
  const { label } = ACCESS_INFO[settings.access];
  const full = settings.access === "full";

  return (
    <Picker
      label={`Permissions: ${label}`}
      haspopup="menu"
      align="left"
      tone={
        full ? "text-amber-300 hover:text-amber-200 aria-expanded:text-amber-200" : NEUTRAL_TONE
      }
      panelClassName="w-72"
      trigger={
        <>
          <ShieldIcon className="size-4 shrink-0" />
          <span className="hidden truncate @md:inline">{label}</span>
        </>
      }
    >
      {(close) => <AccessMenu settings={settings} onChange={onChange} onDone={close} />}
    </Picker>
  );
}

/** The warning that stands between a permissions menu and "full". */
export function FullAccessConfirm({
  agent,
  onConfirm,
  onCancel,
}: {
  /** Who gets full access, e.g. "Claude Code". */
  agent: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="alert"
      onKeyDown={(event) => {
        // Escape backs out of the confirm, not the whole menu.
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onCancel();
      }}
      className="m-1.5 rounded-lg border border-amber-400/25 bg-amber-400/6 p-3 text-xs"
    >
      <p className="font-medium text-amber-200">Give full access?</p>
      <p className="mt-1 text-neutral-400">
        {agent} will run any command and change any file without asking, outside the sandbox. Use it
        only in a project you can restore.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          autoFocus
          onClick={onConfirm}
          className={`h-7 rounded-md bg-amber-300 px-3 font-medium text-ink hover:bg-amber-200 ${FOCUS}`}
        >
          Use full access
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={`h-7 rounded-md px-3 text-neutral-300 hover:bg-white/6 ${FOCUS}`}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function AccessMenu({
  settings,
  onChange,
  onDone,
}: {
  settings: ChatSettings;
  onChange: (settings: ChatSettings) => Promise<void>;
  onDone: () => void;
}) {
  const { catalog } = useCatalog(settings.agentId);
  const model = selectedModel(settings, catalog);
  const titleId = useId();
  const { saveError, save } = useSave(onChange);
  const [confirmFull, setConfirmFull] = useState(false);

  const apply = async (access: AccessMode) => {
    if (await save({ ...settings, access })) onDone();
  };

  const choices = (catalog?.accessModes ?? [settings.access]).map((mode) => {
    const blocked = mode === "auto" && model?.auto !== true && mode !== settings.access;
    return {
      value: mode,
      label: ACCESS_INFO[mode].label,
      description: blocked ? "Not available for this model" : ACCESS_INFO[mode].description,
      disabled: blocked,
      tone: mode === "full" ? "text-amber-200" : undefined,
    };
  });

  return (
    <>
      <PanelTitle id={titleId}>Permissions</PanelTitle>
      {confirmFull ? (
        <FullAccessConfirm
          agent={AGENT_NAMES[settings.agentId]}
          onConfirm={() => void apply("full")}
          onCancel={() => setConfirmFull(false)}
        />
      ) : (
        <RadioMenu
          labelledBy={titleId}
          choices={choices}
          value={settings.access}
          onSelect={(mode) => {
            if (mode === "full" && settings.access !== "full") setConfirmFull(true);
            else void apply(mode);
          }}
        />
      )}
      <SaveError message={saveError} />
    </>
  );
}
