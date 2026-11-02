import type { DevServer } from "@rook/contracts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import { FOCUS } from "../../chat/Picker.tsx";
import { desktop } from "../../desktop.ts";
import { IconButton } from "../../IconButton.tsx";
import {
  ArrowUpIcon,
  CloseIcon,
  ExternalIcon,
  GlobeIcon,
  MoreIcon,
  RefreshIcon,
  SpinnerIcon,
} from "../../icons.tsx";
import { usePersistentState } from "../../usePersistentState.ts";
import type { Folder } from "../../workspace/model.ts";
import { EmptyState, ErrorNote, errorMessage, Menu, type MenuEntry } from "../ui.tsx";
import { browserUrlKey, loadFailure, normalizeAddress } from "./url.ts";

// Must match PREVIEW_PARTITION in apps/desktop/src/preview/policy.ts; main refuses any other.
const PARTITION = "persist:rook-preview";
// Chromium's ERR_ABORTED: a load replaced by another, not a failure.
const ABORTED = -3;

/** The parts of Electron's WebviewTag this view calls. */
interface Webview extends HTMLElement {
  loadURL(url: string): Promise<void>;
  reload(): void;
  reloadIgnoringCache(): void;
  openDevTools(): void;
  getWebContentsId(): number;
  stop(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
}

const parseUrl = (raw: string) => {
  const value: unknown = JSON.parse(raw);
  return typeof value === "string" && /^https?:\/\//.test(value) ? value : undefined;
};

/** Previews the chat's dev server in an isolated <webview>, one page per Browser tab. */
export function BrowserView({
  chat,
  tabId,
}: {
  chat: Folder;
  /** The panel tab showing it, which keeps its own page. */
  tabId: string;
}) {
  if (!desktop) {
    return (
      <EmptyState icon={<GlobeIcon />} title="Previews need the desktop app">
        Open Rook's desktop app to preview your project here.
      </EmptyState>
    );
  }
  // Keyed so each tab starts from its own page and history.
  return <Browser key={tabId} chatId={chat.id} urlKey={browserUrlKey(chat.id, tabId)} />;
}

function Browser({ chatId, urlKey }: { chatId: string; urlKey: string }) {
  // The page last shown, restored when the tab comes back.
  const [url, setUrl] = usePersistentState<string | null>(urlKey, null, parseUrl);
  // The webview's starting page. Later navigation goes through loadURL, since changing `src`
  // reloads the guest even when it already shows that page.
  const [src, setSrc] = useState(url);
  const [generation, setGeneration] = useState(0);
  const [draft, setDraft] = useState(url ?? "");
  const [inputError, setInputError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState({ back: false, forward: false });
  const [title, setTitle] = useState("");
  const [failure, setFailure] = useState<{ message: string; url: string } | null>(null);
  const [crashed, setCrashed] = useState(false);
  // A menu action's brief confirmation, e.g. "Cookies cleared".
  const [notice, setNotice] = useState("");
  const view = useRef<Webview | null>(null);
  const ready = useRef(false);
  const editing = useRef(false);
  const servers = useDevServers(chatId, src === null || failure !== null);

  const attach = useCallback(
    (node: HTMLWebViewElement | null) => {
      const webview = node as Webview | null;
      view.current = webview;
      ready.current = false;
      if (!webview) return;
      const sync = () => setHistory({ back: webview.canGoBack(), forward: webview.canGoForward() });
      const shown = (next: string) => {
        setUrl(next);
        if (!editing.current) setDraft(next);
        sync();
      };
      const listeners: [string, (event: never) => void][] = [
        ["dom-ready", () => void (ready.current = true)],
        [
          "did-start-loading",
          () => {
            setLoading(true);
            setFailure(null);
          },
        ],
        [
          "did-stop-loading",
          () => {
            setLoading(false);
            sync();
          },
        ],
        ["did-navigate", (event: { url: string }) => shown(event.url)],
        [
          "did-navigate-in-page",
          (event: { url: string; isMainFrame: boolean }) => event.isMainFrame && shown(event.url),
        ],
        ["page-title-updated", (event: { title: string }) => setTitle(event.title)],
        [
          "did-fail-load",
          (event: {
            errorCode: number;
            errorDescription: string;
            validatedURL: string;
            isMainFrame: boolean;
          }) => {
            if (!event.isMainFrame || event.errorCode === ABORTED) return;
            const message = loadFailure(
              event.errorCode,
              event.errorDescription,
              event.validatedURL,
            );
            setFailure({ message, url: event.validatedURL });
          },
        ],
        [
          "render-process-gone",
          () => {
            setCrashed(true);
            setLoading(false);
          },
        ],
      ];
      for (const [name, listener] of listeners)
        webview.addEventListener(name, listener as EventListener);
      return () => {
        for (const [name, listener] of listeners)
          webview.removeEventListener(name, listener as EventListener);
      };
    },
    [setUrl],
  );

  const go = (next: string) => {
    setInputError(null);
    setFailure(null);
    setTitle("");
    setDraft(next);
    setUrl(next);
    if (view.current && ready.current && !crashed) {
      // Failures arrive as did-fail-load.
      view.current.loadURL(next).catch(() => {});
    } else {
      // Nothing to navigate yet, or a crashed guest: start a fresh one.
      setCrashed(false);
      setSrc(next);
      setGeneration((value) => value + 1);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const address = normalizeAddress(draft);
    if ("error" in address) setInputError(address.error);
    else go(address.url);
  };

  const revert = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    setDraft(url ?? "");
    setInputError(null);
  };

  const openExternal = () => {
    if (url)
      desktop?.preview.open(url).catch((cause: unknown) => setInputError(errorMessage(cause)));
  };

  const live = src !== null && !crashed;

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  // The guest page, once it can take commands; until dom-ready its methods throw.
  const page = () => {
    if (!view.current || !ready.current || crashed) throw new Error("The page hasn't loaded yet.");
    return view.current;
  };
  // Menu actions confirm with a notice and report failure where address errors go.
  const run = (action: () => unknown, done?: string) => {
    setInputError(null);
    Promise.resolve()
      .then(action)
      .then(
        () => done && setNotice(done),
        (cause: unknown) => setInputError(errorMessage(cause)),
      );
  };
  const menu: MenuEntry[] = [
    {
      label: "Take screenshot",
      disabled: !live,
      onSelect: () =>
        run(() => desktop?.preview.capture(page().getWebContentsId()), "Screenshot copied"),
    },
    {
      label: "Hard reload",
      separated: true,
      disabled: !live,
      onSelect: () => run(() => page().reloadIgnoringCache()),
    },
    {
      label: "Copy current URL",
      disabled: !url,
      onSelect: () => run(() => navigator.clipboard.writeText(url!), "URL copied"),
    },
    { label: "Open DevTools", disabled: !live, onSelect: () => run(() => page().openDevTools()) },
    {
      label: "Clear cookies",
      separated: true,
      onSelect: () => run(() => desktop?.preview.clear("cookies"), "Cookies cleared"),
    },
    {
      label: "Clear cache",
      onSelect: () => run(() => desktop?.preview.clear("cache"), "Cache cleared"),
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form onSubmit={submit} className="flex shrink-0 items-center gap-0.5 px-2 pb-2">
        <IconButton
          label="Back"
          disabled={!live || !history.back}
          onClick={() => view.current?.goBack()}
          className={NAV}
        >
          <ArrowUpIcon className="-rotate-90" />
        </IconButton>
        <IconButton
          label="Forward"
          disabled={!live || !history.forward}
          onClick={() => view.current?.goForward()}
          className={NAV}
        >
          <ArrowUpIcon className="rotate-90" />
        </IconButton>
        <IconButton
          label={loading ? "Stop loading" : "Reload"}
          disabled={!live}
          onClick={() => (loading ? view.current?.stop() : view.current?.reload())}
          className={NAV}
        >
          {loading ? <CloseIcon /> : <RefreshIcon />}
        </IconButton>
        <input
          type="text"
          aria-label="Address"
          aria-invalid={inputError !== null}
          aria-describedby={inputError ? "browser-address-error" : undefined}
          title={title || url || undefined}
          placeholder="localhost:3000"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => {
            editing.current = true;
            event.target.select();
          }}
          onBlur={() => (editing.current = false)}
          onKeyDown={revert}
          className={`mx-1 h-7 min-w-0 flex-1 rounded-md bg-white/4 px-2 text-xs text-neutral-200 placeholder:text-neutral-600 aria-invalid:ring-1 aria-invalid:ring-red-400/40 ${FOCUS}`}
        />
        <IconButton
          label="Open in system browser"
          disabled={!url}
          onClick={openExternal}
          className={NAV}
        >
          <ExternalIcon />
        </IconButton>
        <Menu
          label="More actions"
          trigger={<MoreIcon />}
          align="right"
          className={NAV}
          entries={menu}
        />
      </form>
      {inputError && (
        <div id="browser-address-error">
          <ErrorNote message={inputError} />
        </div>
      )}
      <div
        aria-busy={loading}
        className="relative min-h-0 flex-1 overflow-hidden border-t border-white/6"
      >
        {src === null ? (
          <div className="flex h-full flex-col overflow-y-auto">
            {/* A block box, so EmptyState doesn't stretch and push the list to the bottom. */}
            <div className="my-auto">
              <EmptyState icon={<GlobeIcon />} title="Preview your app">
                Start the project's dev server, then open it here or type an address above.
              </EmptyState>
              <ServerList {...servers} onOpen={go} />
            </div>
          </div>
        ) : (
          <>
            <webview
              key={generation}
              ref={attach}
              src={src}
              partition={PARTITION}
              // React drops `true` for attributes it doesn't know; Electron reads it at attach.
              {...({ allowpopups: "true" } as unknown as { allowpopups?: boolean })}
              aria-label={title || "Page preview"}
              // A page with no background of its own expects white, whatever the theme.
              className="absolute inset-0 size-full bg-[white]"
            />
            {loading && (
              <span
                aria-hidden="true"
                className="absolute inset-x-0 top-0 h-0.5 bg-sky-400/70 motion-safe:animate-pulse"
              />
            )}
            {(failure || crashed) && (
              <div className="absolute inset-0 flex flex-col overflow-y-auto bg-surface">
                <div
                  role="alert"
                  className="flex flex-col items-center gap-3 px-8 pt-12 pb-4 text-center"
                >
                  <p className="text-sm text-balance text-neutral-300">
                    {crashed ? "This page stopped working." : failure!.message}
                  </p>
                  <button
                    type="button"
                    onClick={() => go(crashed ? (url ?? src) : failure!.url)}
                    className={`h-7 rounded-md bg-white/8 px-3 text-xs text-neutral-200 transition-colors hover:bg-white/12 motion-reduce:transition-none ${FOCUS}`}
                  >
                    {crashed ? "Reload page" : "Try again"}
                  </button>
                </div>
                {!crashed && <ServerList {...servers} onOpen={go} />}
              </div>
            )}
          </>
        )}
        <p
          role="status"
          className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md border border-white/8 bg-raised px-2.5 py-1 text-xs text-neutral-200 shadow-lg empty:hidden"
        >
          {notice}
        </p>
      </div>
    </div>
  );
}

const NAV = "shrink-0 [&>svg]:size-4 disabled:pointer-events-none disabled:opacity-35";

function useDevServers(chatId: string, enabled: boolean) {
  const [state, setState] = useState<{
    servers: DevServer[];
    loading: boolean;
    error: string | null;
  }>({ servers: [], loading: true, error: null });
  const load = useCallback(() => {
    desktop?.preview.servers(chatId).then(
      (servers) => setState({ servers, loading: false, error: null }),
      (cause: unknown) => setState({ servers: [], loading: false, error: errorMessage(cause) }),
    );
  }, [chatId]);
  useEffect(() => {
    if (enabled) load();
  }, [enabled, load]);
  const refresh = () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    load();
  };
  return { ...state, refresh };
}

function ServerList({
  servers,
  loading,
  error,
  refresh,
  onOpen,
}: ReturnType<typeof useDevServers> & { onOpen: (url: string) => void }) {
  return (
    <section aria-label="Dev servers" className="mx-auto w-full max-w-72 px-3 pb-4">
      <div className="flex items-center gap-1 pl-2">
        <h3 className="min-w-0 flex-1 text-xs text-neutral-500">Running on this machine</h3>
        <IconButton label="Look again" disabled={loading} onClick={refresh} className={NAV}>
          {loading ? <SpinnerIcon className="motion-safe:animate-spin" /> : <RefreshIcon />}
        </IconButton>
      </div>
      {error ? (
        <ErrorNote message={error} onRetry={refresh} />
      ) : servers.length > 0 ? (
        <ul className="flex flex-col gap-px">
          {servers.map((server) => (
            <li key={server.port}>
              <button
                type="button"
                onClick={() => onOpen(server.url)}
                className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-neutral-300 transition-colors hover:bg-white/6 hover:text-neutral-100 active:bg-white/10 motion-reduce:transition-none ${FOCUS}`}
              >
                <GlobeIcon className="size-4 shrink-0 text-neutral-500" />
                localhost:{server.port}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 py-1 text-xs text-neutral-600" aria-live="polite">
          {loading ? "Looking for dev servers…" : "No dev servers found."}
        </p>
      )}
    </section>
  );
}
