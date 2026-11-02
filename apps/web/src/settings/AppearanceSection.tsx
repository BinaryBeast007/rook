import { useId, type KeyboardEvent } from "react";

import { FOCUS, PanelTitle, Picker, RadioMenu } from "../chat/Picker.tsx";
import { CheckIcon } from "../icons.tsx";
import { mix } from "../theme/color.ts";
import { CODE_FONTS, UI_FONTS, codeFontStack, uiFontStack } from "../theme/fonts.ts";
import {
  SYSTEM_THEMES,
  THEME_IDS,
  THEMES,
  paletteOf,
  type Theme,
  type ThemeChoice,
} from "../theme/themes.ts";
import { Row, Section, Segmented, SELECT_TONE } from "./rows.tsx";
import { updateSettings, useSettings, type ChatWidth, type Size } from "./settings.ts";

const WIDTHS: readonly { value: ChatWidth; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "wide", label: "Wide" },
  { value: "full", label: "Full" },
];

const SIZES: readonly { value: Size; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
];

const CHOICES: readonly ThemeChoice[] = ["system", ...THEME_IDS];

const labelOf = (choice: ThemeChoice) => (choice === "system" ? "System" : THEMES[choice].label);

/** How Rook looks, for every project. Changes apply at once (see `applyAppearance`). */
export function AppearanceSection() {
  const { settings } = useSettings();
  return (
    <Section title="Appearance">
      <ThemeRow value={settings.theme} onChange={(theme) => updateSettings({ theme })} />
      <Row label="Interface font" description="Menus, labels and messages.">
        {() => (
          <FontPicker
            title="Interface font"
            fonts={UI_FONTS}
            stack={uiFontStack}
            value={settings.uiFont}
            onChange={(uiFont) => updateSettings({ uiFont })}
          />
        )}
      </Row>
      <Row label="Code font" description="Code blocks, diffs, file previews and the terminal.">
        {() => (
          <FontPicker
            title="Code font"
            fonts={CODE_FONTS}
            stack={codeFontStack}
            value={settings.codeFont}
            onChange={(codeFont) => updateSettings({ codeFont })}
          />
        )}
      </Row>
      <Row label="Text size" description="Makes text and controls across Rook smaller or larger.">
        {(labelId, descriptionId) => (
          <Segmented
            labelledBy={labelId}
            describedBy={descriptionId}
            value={settings.textSize}
            options={SIZES}
            onChange={(textSize) => updateSettings({ textSize })}
          />
        )}
      </Row>
      <Row
        label="Code and terminal font size"
        description="Code blocks, diffs, file previews and the terminal."
      >
        {(labelId, descriptionId) => (
          <Segmented
            labelledBy={labelId}
            describedBy={descriptionId}
            value={settings.codeSize}
            options={SIZES}
            onChange={(codeSize) => updateSettings({ codeSize })}
          />
        )}
      </Row>
      <Row label="Chat width" description="How wide messages and the message box can grow.">
        {(labelId, descriptionId) => (
          <Segmented
            labelledBy={labelId}
            describedBy={descriptionId}
            value={settings.chatWidth}
            options={WIDTHS}
            onChange={(chatWidth) => updateSettings({ chatWidth })}
          />
        )}
      </Row>
    </Section>
  );
}

const STEPS: Partial<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/** Every theme as a card that previews it; picking one applies it at once. */
function ThemeRow({
  value,
  onChange,
}: {
  value: ThemeChoice;
  onChange: (choice: ThemeChoice) => void;
}) {
  const labelId = useId();
  const descriptionId = useId();
  const at = CHOICES.indexOf(value);

  // A radio group: the arrows move the choice, and with it the theme.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = STEPS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = (at + step + CHOICES.length) % CHOICES.length;
    onChange(CHOICES[next]!);
    event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <div className="py-4">
      <p id={labelId} className="text-sm text-neutral-200">
        Theme
      </p>
      <p id={descriptionId} className="mt-0.5 text-xs/5 text-neutral-500">
        Colors for every part of Rook, the terminal included. System follows your OS between{" "}
        {THEMES[SYSTEM_THEMES.light].label} and {THEMES[SYSTEM_THEMES.dark].label}.
      </p>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        onKeyDown={onKeyDown}
        className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3"
      >
        {CHOICES.map((choice, index) => (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={choice === value}
            tabIndex={index === Math.max(at, 0) ? 0 : -1}
            onClick={() => onChange(choice)}
            className={`group rounded-lg border border-white/8 p-1.5 text-left transition-colors hover:border-white/16 aria-checked:border-paper/60 motion-reduce:transition-none ${FOCUS}`}
          >
            {choice === "system" ? (
              <div className="relative h-20">
                <ThemePreview theme={THEMES[SYSTEM_THEMES.light]} />
                <div className="absolute inset-0 [clip-path:polygon(58%_0,100%_0,100%_100%,42%_100%)]">
                  <ThemePreview theme={THEMES[SYSTEM_THEMES.dark]} />
                </div>
              </div>
            ) : (
              <ThemePreview theme={THEMES[choice]} />
            )}
            <span className="flex items-center gap-1.5 px-0.5 pt-2 pb-0.5 text-xs text-neutral-300 group-aria-checked:text-paper">
              <span className="min-w-0 flex-1 truncate">{labelOf(choice)}</span>
              {choice === value && <CheckIcon className="size-3.5 shrink-0" />}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** A tiny Rook window in a theme's own colors: sidebar, a message, text, status colors, tools. */
function ThemePreview({ theme }: { theme: Theme }) {
  const palette = paletteOf(theme);
  const color = (name: string) => palette[`--color-${name}`];
  const line = mix(theme.text, theme.canvas, 0.1);
  return (
    <div
      aria-hidden="true"
      className="flex h-20 overflow-hidden rounded-md"
      style={{ background: theme.canvas, boxShadow: `inset 0 0 0 1px ${line}` }}
    >
      <div
        className="flex w-1/4 flex-col gap-1.5 px-1.5 py-2"
        style={{ background: theme.panel, borderRight: `1px solid ${line}` }}
      >
        <span className="h-1 w-3/4 rounded-full" style={{ background: color("neutral-300") }} />
        <span
          className="-mx-0.5 h-2 rounded-sm"
          style={{ background: mix(theme.text, theme.panel, 0.1) }}
        />
        <span className="h-1 w-2/3 rounded-full" style={{ background: color("neutral-600") }} />
        <span className="h-1 w-1/2 rounded-full" style={{ background: color("neutral-600") }} />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2">
        <span
          className="h-3 w-3/5 self-end rounded-md"
          style={{ background: mix(theme.text, theme.canvas, 0.08) }}
        />
        <span className="h-1 w-5/6 rounded-full" style={{ background: color("neutral-200") }} />
        <span className="h-1 w-2/3 rounded-full" style={{ background: color("neutral-500") }} />
        <span className="mt-auto flex items-center gap-1">
          {["amber-400", "red-400", "emerald-400", "sky-400", "violet-400"].map((name) => (
            <span
              key={name}
              className="size-1.5 rounded-full"
              style={{ background: color(name) }}
            />
          ))}
          <span className="ml-auto h-2.5 w-5 rounded-full" style={{ background: theme.text }} />
        </span>
      </div>
      <div
        className="flex w-1/5 flex-col gap-1.5 px-1.5 py-2"
        style={{ background: theme.panel, borderLeft: `1px solid ${line}` }}
      >
        <span className="h-1 w-2/3 rounded-full" style={{ background: color("neutral-600") }} />
        <span className="h-1 w-5/6 rounded-full" style={{ background: color("neutral-600") }} />
      </div>
    </div>
  );
}

/** A dropdown of fonts, each shown in itself. */
function FontPicker<T extends string>({
  title,
  fonts,
  stack,
  value,
  onChange,
}: {
  title: string;
  fonts: Readonly<Record<T, { readonly label: string }>>;
  stack: (font: T) => string;
  value: T;
  onChange: (font: T) => void;
}) {
  const titleId = useId();
  const ids = Object.keys(fonts) as T[];
  return (
    <Picker
      label={`${title}: ${fonts[value].label}`}
      haspopup="menu"
      align="right"
      placement="below"
      tone={SELECT_TONE}
      panelClassName="w-60"
      trigger={
        <span className="max-w-48 truncate" style={{ fontFamily: stack(value) }}>
          {fonts[value].label}
        </span>
      }
    >
      {(close) => (
        <>
          <PanelTitle id={titleId}>{title}</PanelTitle>
          <div className="max-h-[min(60vh,24rem)] overflow-y-auto">
            <RadioMenu
              labelledBy={titleId}
              choices={ids.map((id) => ({ value: id, label: fonts[id].label, font: stack(id) }))}
              value={value}
              onSelect={(font) => {
                onChange(font);
                close();
              }}
            />
          </div>
        </>
      )}
    </Picker>
  );
}
