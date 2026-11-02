import type { ChatAgentId, Project } from "@rook/contracts";
import { useId, useState } from "react";

import { FullAccessConfirm } from "../chat/AccessPicker.tsx";
import { PanelTitle, Picker, RadioMenu, type MenuChoice } from "../chat/Picker.tsx";
import { ACCESS_INFO, AGENT_NAMES, CHAT_AGENTS } from "../chat/settings.ts";
import { useCatalog } from "../chat/useCatalog.ts";
import { desktop } from "../desktop.ts";
import { FolderIcon } from "../icons.tsx";
import { Row, Section, Segmented, SELECT_TONE, SwitchRow, type Scoped } from "./rows.tsx";
import {
  updateProject,
  updateSettings,
  useSettings,
  type DefaultAccess,
  type DefaultModel,
  type ProjectSettings,
  type TimeFormat,
} from "./settings.ts";

const TIME_FORMATS: readonly { value: TimeFormat; label: string }[] = [
  { value: "system", label: "System" },
  { value: "12h", label: "12-hour" },
  { value: "24h", label: "24-hour" },
];

/** New-chat defaults for all projects or one project, plus app-wide preferences. */
export function GeneralSection({ projects }: { projects: readonly Project[] }) {
  const { settings, overrides } = useSettings();
  const [scopeId, setScopeId] = useState<string | null>(null);
  // A project removed while it was picked falls back to all projects.
  const project = projects.find((p) => p.id === scopeId);
  const override = project ? overrides[project.id] : undefined;

  const value = <K extends keyof ProjectSettings>(key: K): ProjectSettings[K] =>
    override?.[key] ?? settings[key];
  const set = <K extends keyof ProjectSettings>(key: K, next: ProjectSettings[K]) =>
    project ? updateProject(project.id, key, next) : updateSettings({ [key]: next });
  const scoped = (key: keyof ProjectSettings): Scoped | undefined =>
    project && {
      inherited: override?.[key] === undefined,
      onReset: () => updateProject(project.id, key, undefined),
    };

  return (
    <Section
      title="General"
      action={<ScopeSelect projects={projects} project={project} onChange={setScopeId} />}
    >
      <Row
        label="Default model"
        description="The agent and model new chats start with."
        scoped={scoped("model")}
      >
        {() => <ModelSelect value={value("model")} onChange={(next) => set("model", next)} />}
      </Row>
      <Row
        label="Default permissions"
        description="What the agent in a new chat may do without asking."
        scoped={scoped("access")}
      >
        {() => <AccessSelect value={value("access")} onChange={(next) => set("access", next)} />}
      </Row>
      <SwitchRow
        label="Run new chats in a separate worktree"
        description="Each chat gets its own branch and folder, so parallel chats never touch each other's files."
        scoped={scoped("worktree")}
        checked={value("worktree")}
        onChange={(next) => set("worktree", next)}
      />
      {project ? (
        <p className="py-4 text-xs text-neutral-500">
          Notifications and time format apply to all projects.
        </p>
      ) : (
        <>
          <SwitchRow
            label="Notify me when a chat finishes or needs approval"
            description={
              desktop
                ? "Only while Rook is in the background. Click the notification to open the chat."
                : "Available in the Rook desktop app."
            }
            checked={settings.notify}
            disabled={!desktop}
            onChange={(notify) => updateSettings({ notify })}
          />
          <Row label="Time format" description="How times show in chats and usage.">
            {(labelId, descriptionId) => (
              <Segmented
                labelledBy={labelId}
                describedBy={descriptionId}
                value={settings.timeFormat}
                options={TIME_FORMATS}
                onChange={(timeFormat) => updateSettings({ timeFormat })}
              />
            )}
          </Row>
        </>
      )}
    </Section>
  );
}

function ScopeSelect({
  projects,
  project,
  onChange,
}: {
  projects: readonly Project[];
  project: Project | undefined;
  onChange: (projectId: string | null) => void;
}) {
  const titleId = useId();
  const name = project?.name ?? "All projects";
  const choices: MenuChoice<string | null>[] = [
    { value: null, label: "All projects", description: "Unless a project changes them" },
    ...projects.map((p) => ({ value: p.id, label: p.name, description: p.path })),
  ];
  return (
    <Picker
      label={`Applies to: ${name}`}
      haspopup="menu"
      align="right"
      placement="below"
      tone={SELECT_TONE}
      panelClassName="w-80"
      trigger={
        <>
          <span className="shrink-0 text-neutral-500">Applies to:</span>
          {project && <FolderIcon className="size-3.5 shrink-0 text-neutral-500" />}
          <span className="max-w-48 truncate">{name}</span>
        </>
      }
    >
      {(close) => (
        <>
          <PanelTitle id={titleId}>Applies to</PanelTitle>
          <div className="max-h-[min(60vh,24rem)] overflow-y-auto">
            <RadioMenu
              labelledBy={titleId}
              choices={choices}
              value={project?.id ?? null}
              onSelect={(id) => {
                onChange(id);
                close();
              }}
            />
          </div>
        </>
      )}
    </Picker>
  );
}

// Menu values are strings: "last", or "<agent>:<model id>" with an empty id for the default.
const modelKey = (model: DefaultModel) =>
  model === "last" ? "last" : `${model.agentId}:${model.model ?? ""}`;

function parseModelKey(key: string): DefaultModel {
  if (key === "last") return "last";
  const at = key.indexOf(":");
  return { agentId: key.slice(0, at) as ChatAgentId, model: key.slice(at + 1) || null };
}

function ModelSelect({
  value,
  onChange,
}: {
  value: DefaultModel;
  onChange: (value: DefaultModel) => void;
}) {
  const titleId = useId();
  const { catalog } = useCatalog(value === "last" ? "claude" : value.agentId);
  let name = "Last used";
  if (value !== "last") {
    const model =
      value.model === null
        ? "Default model"
        : (catalog?.models.find((m) => m.id === value.model)?.name ?? value.model);
    name = `${AGENT_NAMES[value.agentId]} · ${model}`;
  }

  return (
    <Picker
      label={`Default model: ${name}`}
      haspopup="menu"
      align="right"
      placement="below"
      tone={SELECT_TONE}
      panelClassName="w-72"
      trigger={<span className="max-w-56 truncate">{name}</span>}
    >
      {(close) => (
        <>
          <PanelTitle id={titleId}>Default model</PanelTitle>
          <div className="max-h-[min(60vh,24rem)] overflow-y-auto">
            <ModelMenu
              titleId={titleId}
              value={value}
              onSelect={(next) => {
                onChange(next);
                close();
              }}
            />
          </div>
        </>
      )}
    </Picker>
  );
}

function ModelMenu({
  titleId,
  value,
  onSelect,
}: {
  titleId: string;
  value: DefaultModel;
  onSelect: (value: DefaultModel) => void;
}) {
  const catalogs = { claude: useCatalog("claude"), codex: useCatalog("codex") };
  const choices: MenuChoice<string>[] = [
    { value: "last", label: "Last used", description: "The model from your most recent chat" },
  ];
  for (const agentId of CHAT_AGENTS) {
    const agent = AGENT_NAMES[agentId];
    choices.push({ value: `${agentId}:`, label: "Default model", description: agent });
    for (const model of catalogs[agentId].catalog?.models ?? []) {
      const chosen = value !== "last" && value.agentId === agentId && value.model === model.id;
      if (model.legacy && !chosen) continue;
      choices.push({ value: `${agentId}:${model.id}`, label: model.name, description: agent });
    }
    // Keep a chosen model listed while the catalog loads, or after the agent retired it.
    const key = modelKey(value);
    if (value !== "last" && value.agentId === agentId && !choices.some((c) => c.value === key))
      choices.push({ value: key, label: value.model ?? "Default model", description: agent });
  }
  return (
    <RadioMenu
      labelledBy={titleId}
      choices={choices}
      value={modelKey(value)}
      onSelect={(key) => onSelect(parseModelKey(key))}
    />
  );
}

function AccessSelect({
  value,
  onChange,
}: {
  value: DefaultAccess;
  onChange: (value: DefaultAccess) => void;
}) {
  const label = value === "last" ? "Last used" : ACCESS_INFO[value].label;
  return (
    <Picker
      label={`Default permissions: ${label}`}
      haspopup="menu"
      align="right"
      placement="below"
      tone={
        value === "full"
          ? "border border-amber-400/25 text-amber-300 hover:text-amber-200 aria-expanded:text-amber-200"
          : SELECT_TONE
      }
      panelClassName="w-72"
      trigger={<span className="truncate">{label}</span>}
    >
      {(close) => (
        <AccessMenu
          value={value}
          onSelect={(next) => {
            onChange(next);
            close();
          }}
        />
      )}
    </Picker>
  );
}

function AccessMenu({
  value,
  onSelect,
}: {
  value: DefaultAccess;
  onSelect: (value: DefaultAccess) => void;
}) {
  const titleId = useId();
  const [confirmFull, setConfirmFull] = useState(false);
  const choices: MenuChoice<DefaultAccess>[] = [
    {
      value: "last",
      label: "Last used",
      description: "The permissions from your most recent chat",
    },
    ...(["ask", "edit", "auto", "full"] as const).map((mode) => ({
      value: mode,
      label: ACCESS_INFO[mode].label,
      description: ACCESS_INFO[mode].description,
      tone: mode === "full" ? "text-amber-200" : undefined,
    })),
  ];
  return (
    <>
      <PanelTitle id={titleId}>Default permissions</PanelTitle>
      {confirmFull ? (
        <FullAccessConfirm
          agent="The agent in every new chat"
          onConfirm={() => onSelect("full")}
          onCancel={() => setConfirmFull(false)}
        />
      ) : (
        <RadioMenu
          labelledBy={titleId}
          choices={choices}
          value={value}
          onSelect={(mode) => {
            if (mode === "full" && value !== "full") setConfirmFull(true);
            else onSelect(mode);
          }}
        />
      )}
    </>
  );
}
