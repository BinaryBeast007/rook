import { expect, test } from "vite-plus/test";

import { isLocalPage, loadFailure, normalizeAddress } from "./url.ts";

test("short local addresses become http URLs", () => {
  expect(normalizeAddress("3000")).toEqual({ url: "http://localhost:3000/" });
  expect(normalizeAddress(" localhost:5173 ")).toEqual({ url: "http://localhost:5173/" });
  expect(normalizeAddress("localhost")).toEqual({ url: "http://localhost/" });
  expect(normalizeAddress("localhost:3000/docs?x=1#y")).toEqual({
    url: "http://localhost:3000/docs?x=1#y",
  });
  expect(normalizeAddress("127.0.0.1:8080")).toEqual({ url: "http://127.0.0.1:8080/" });
  expect(normalizeAddress("[::1]:8080")).toEqual({ url: "http://[::1]:8080/" });
  expect(normalizeAddress("0.0.0.0:3000")).toEqual({ url: "http://localhost:3000/" });
  expect(normalizeAddress("192.168.1.5")).toEqual({ url: "http://192.168.1.5/" });
  expect(normalizeAddress("myapp.test:8000")).toEqual({ url: "http://myapp.test:8000/" });
});

test("web addresses default to https, full URLs are kept", () => {
  expect(normalizeAddress("example.com/a")).toEqual({ url: "https://example.com/a" });
  expect(normalizeAddress("http://example.com")).toEqual({ url: "http://example.com/" });
  expect(normalizeAddress("HTTPS://Example.com/A")).toEqual({ url: "https://example.com/A" });
  expect(normalizeAddress("http://0.0.0.0:4321/x")).toEqual({ url: "http://localhost:4321/x" });
});

test("other schemes and junk are refused with a message", () => {
  for (const bad of [
    "javascript:alert(1)",
    "file:///C:/Windows",
    "data:text/html,hi",
    "rook://app/index.html",
    "devtools://devtools",
    "about:blank",
    "view-source:http://localhost:3000",
  ]) {
    const result = normalizeAddress(bad);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/http or https/);
  }
  expect(normalizeAddress("   ")).toHaveProperty("error");
  expect(normalizeAddress("http://")).toHaveProperty("error");
  expect(normalizeAddress("99999")).toHaveProperty("error");
  expect(normalizeAddress("local host")).toHaveProperty("error");
});

test("load failures read as plain sentences", () => {
  expect(loadFailure(-102, "ERR_CONNECTION_REFUSED", "http://localhost:3000/")).toBe(
    "Nothing is running at localhost:3000.",
  );
  expect(loadFailure(-105, "ERR_NAME_NOT_RESOLVED", "https://nope.invalid/")).toBe(
    "Couldn't find nope.invalid.",
  );
  expect(loadFailure(-200, "ERR_CERT_COMMON_NAME_INVALID", "https://a.com/")).toBe(
    "Couldn't load a.com (ERR_CERT_COMMON_NAME_INVALID).",
  );
});

test("isLocalPage", () => {
  for (const url of [
    "http://localhost:3000/",
    "https://app.localhost/",
    "http://127.0.0.1:8080",
    "http://[::1]:5173/",
  ])
    expect(isLocalPage(url)).toBe(true);
  for (const url of [
    "https://example.com/",
    "file:///C:/x",
    "http://localhost.evil.com/",
    "nonsense",
  ])
    expect(isLocalPage(url)).toBe(false);
});
