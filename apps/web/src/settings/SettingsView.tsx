import type { Project } from "@rook/contracts";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import { AgentsIcon, ChevronIcon, ContrastIcon, SlidersIcon } from "../icons.tsx";
import { AgentsSection } from "./AgentsSection.tsx";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { GeneralSection } from "./GeneralSection.tsx";
import type { SettingsPage } from "./settings.ts";

/** Nav order follows this list; a new page is one entry here and its id in `SETTINGS_PAGES`. */
const PAGES: readonly {
  id: SettingsPage;
  label: string;
  icon: ReactNode;
  render: (projects: readonly Project[]) => ReactNode;
}[] = [
  {
    id: "general",
    label: "General",
    icon: <SlidersIcon />,
    render: (projects) => <GeneralSection projects={projects} />,
  },
  {
    id: "agents",
    label: "Agents",
    icon: <AgentsIcon />,
    render: () => <AgentsSection />,
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: <ContrastIcon />,
    render: () => <AppearanceSection />,
  },
];

const pageOf = (id: SettingsPage) => PAGES.find((p) => p.id === id) ?? PAGES[0]!;

const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "Home", "End"]);

// Arrow keys and Home/End move focus between pages; Tab still visits each one.
function onNavKey(event: KeyboardEvent<HTMLUListElement>) {
  if (!NAV_KEYS.has(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll("button")];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}

/** The sidebar's contents while Settings is open, in place of the project list. */
export function SettingsNav({
  page,
  agentsAttention,
  onSelect,
}: {
  page: SettingsPage;
  /** Some agent needs signing in or a failed step dealt with; marks the Agents page. */
  agentsAttention: boolean;
  onSelect: (page: SettingsPage) => void;
}) {
  return (
    <nav aria-label="Settings" className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <h2 className="flex h-8 items-center px-2 text-xs font-medium text-neutral-500">
          Settings
        </h2>
        <ul className="flex flex-col gap-0.5" onKeyDown={onNavKey}>
          {PAGES.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                aria-current={p.id === page ? "page" : undefined}
                onClick={() => onSelect(p.id)}
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-neutral-300 transition-colors hover:bg-white/6 hover:text-neutral-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none active:bg-white/10 aria-[current=page]:bg-white/8 aria-[current=page]:text-neutral-100 motion-reduce:transition-none [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-neutral-500"
              >
                {p.icon}
                <span className="min-w-0 truncate">{p.label}</span>
                {p.id === "agents" && agentsAttention && (
                  <>
                    <span
                      aria-hidden="true"
                      className="ml-auto size-1.5 shrink-0 rounded-full bg-amber-400"
                    />
                    <span className="sr-only">, needs attention</span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

/** One Settings page in the main area; the sidebar picks which. Every change saves at once. */
export function SettingsView({
  page,
  projects,
  onClose,
}: {
  page: SettingsPage;
  projects: readonly Project[];
  onClose: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const current = pageOf(page);

  // Move focus into the view when it opens, so keyboard and screen reader users land on it.
  useEffect(() => headingRef.current?.focus(), []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    // Keyed by page, so each page opens scrolled to the top.
    <div key={page} className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-5 pb-12 sm:px-8">
        <header className="flex min-h-9 items-center pt-2 pb-6">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="flex min-w-0 items-center gap-1.5 text-lg font-medium tracking-tight text-paper focus:outline-none"
          >
            <span className="text-neutral-500">Settings</span>
            <ChevronIcon className="size-4 shrink-0 text-neutral-600" />
            <span className="truncate">{current.label}</span>
          </h1>
        </header>
        {current.render(projects)}
      </div>
    </div>
  );
}
