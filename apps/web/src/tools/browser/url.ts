// What the Browser tool's address bar accepts, and how it words a page that failed to load.

export type Address = { url: string } | { error: string };

const SCHEME = /^([a-z][a-z\d+.-]*):/i;
// `localhost:3000` also matches SCHEME; a host and port is never one.
const HOST_PORT = /^[^/?#:]+:\d+(?:[/?#]|$)/;
const LOCAL_HOST = /^(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[[\da-f:]+\])$/i;

/**
 * Turns what was typed (`3000`, `localhost:3000`, `example.com/docs`, a full URL) into an http(s)
 * URL. Local addresses and ones with a port default to http, the rest to https.
 */
export function normalizeAddress(input: string): Address {
  let text = input.trim();
  if (!text) return { error: "Enter an address, like localhost:3000." };
  if (/^\d+$/.test(text)) text = `localhost:${text}`;
  const scheme = HOST_PORT.test(text) ? undefined : SCHEME.exec(text)?.[1];
  if (scheme && !/^https?$/i.test(scheme)) {
    return { error: `${scheme.toLowerCase()}: addresses can't be opened here. Use http or https.` };
  }
  if (!scheme) {
    const host = text.split(/[/?#]/, 1)[0]!;
    const name = host.replace(/:\d+$/, "");
    const plain =
      host !== name || LOCAL_HOST.test(name) || /^[\d.]+$/.test(name) || !name.includes(".");
    text = `${plain ? "http" : "https"}://${text}`;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { error: `"${input.trim()}" isn't an address.` };
  }
  if (!url.hostname) return { error: `"${input.trim()}" isn't an address.` };
  // Chromium refuses 0.0.0.0, which dev servers print for "all interfaces".
  if (url.hostname === "0.0.0.0") url.hostname = "localhost";
  return { url: url.href };
}

/** The message for a main-frame `did-fail-load`. */
export function loadFailure(errorCode: number, description: string, url: string): string {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Keep the raw URL.
  }
  switch (errorCode) {
    case -102: // ERR_CONNECTION_REFUSED
      return `Nothing is running at ${host}.`;
    case -105: // ERR_NAME_NOT_RESOLVED
      return `Couldn't find ${host}.`;
    case -106: // ERR_INTERNET_DISCONNECTED
      return "You're offline.";
    default:
      return `Couldn't load ${host}${description ? ` (${description})` : ""}.`;
  }
}

/** Where a Browser tab keeps its page; set it before the tab first shows to open a URL there. */
export const browserUrlKey = (chatId: string, tabId: string) =>
  `rook:browser-url:${chatId}:${tabId}`;

/** Whether `url` is an http(s) page on this machine, which the Browser tool previews in place. */
export function isLocalPage(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      /^https?:$/.test(protocol) &&
      /^(localhost|.+\.localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/i.test(hostname)
    );
  } catch {
    return false;
  }
}
