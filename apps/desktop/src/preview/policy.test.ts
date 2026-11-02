import type { WebPreferences } from "electron";
import { expect, test } from "vite-plus/test";

import {
  hardenWebview,
  isAllowedPreviewUrl,
  isLoopbackUrl,
  isOwnPreviewGuest,
  popupAction,
  PREVIEW_PARTITION,
} from "./policy.ts";

test("only http and https pages may load", () => {
  for (const ok of ["http://localhost:3000/", "https://example.com/a?b#c", "http://[::1]:5173"])
    expect(isAllowedPreviewUrl(ok)).toBe(true);
  for (const bad of [
    "file:///C:/Windows/win.ini",
    "rook://app/index.html",
    "javascript:alert(1)",
    "data:text/html,<b>x</b>",
    "devtools://devtools/bundled/inspector.html",
    "about:blank",
    "localhost:3000",
    "",
    null,
    42,
  ])
    expect(isAllowedPreviewUrl(bad)).toBe(false);
});

test("loopback means this machine", () => {
  expect(isLoopbackUrl("http://localhost:3000/")).toBe(true);
  expect(isLoopbackUrl("http://app.localhost/")).toBe(true);
  expect(isLoopbackUrl("http://127.0.0.1:8080/")).toBe(true);
  expect(isLoopbackUrl("http://[::1]:8080/")).toBe(true);
  expect(isLoopbackUrl("https://localhost.example.com/")).toBe(false);
  expect(isLoopbackUrl("file://localhost/etc/passwd")).toBe(false);
});

test("guests lose preloads and node, and attach only in the preview partition to a web page", () => {
  const prefs = {
    preload: "C:/evil.js",
    preloadURL: "file:///evil.js",
    nodeIntegration: true,
    contextIsolation: false,
    sandbox: false,
    webSecurity: false,
    webviewTag: true,
    partition: "persist:other",
  } as WebPreferences;
  const params = { src: "http://localhost:3000/", partition: PREVIEW_PARTITION };
  expect(hardenWebview(prefs, params)).toBe(true);
  expect(prefs).not.toHaveProperty("preload");
  expect(prefs).not.toHaveProperty("preloadURL");
  expect(prefs).toMatchObject({
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    partition: PREVIEW_PARTITION,
  });
  expect(hardenWebview({}, { ...params, partition: "" })).toBe(false);
  expect(hardenWebview({}, { ...params, partition: "persist:other" })).toBe(false);
  expect(hardenWebview({}, { ...params, src: "file:///C:/" })).toBe(false);
  expect(hardenWebview({}, { ...params, src: "rook://app/index.html" })).toBe(false);
  expect(hardenWebview({}, { partition: PREVIEW_PARTITION })).toBe(false);
});

test("popups stay in the view for the dev server, go to the system browser for the web", () => {
  expect(popupAction("http://localhost:3000/docs")).toBe("load");
  expect(popupAction("https://github.com/")).toBe("external");
  expect(popupAction("http://example.com/")).toBe("external");
  expect(popupAction("file:///C:/")).toBe("deny");
  expect(popupAction("javascript:alert(1)")).toBe("deny");
});

const contents = (type: string, hostId: number | null) => ({
  getType: () => type,
  hostWebContents: hostId === null ? null : { id: hostId },
});

test("only the calling window's own preview guests can be captured", () => {
  expect(isOwnPreviewGuest(contents("webview", 1), 1)).toBe(true);
  expect(isOwnPreviewGuest(contents("webview", 2), 1)).toBe(false);
  expect(isOwnPreviewGuest(contents("window", null), 1)).toBe(false);
  expect(isOwnPreviewGuest(contents("remote", 1), 1)).toBe(false);
  expect(isOwnPreviewGuest(undefined, 1)).toBe(false);
});
