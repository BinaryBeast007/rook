import { expect, test } from "vite-plus/test";

import { checkAttachment, formatBytes } from "./attachments.ts";

const MB = 1024 * 1024;

test("images need a supported type, a size within limits, and a model that reads them", () => {
  expect(checkAttachment({ name: "a.png", type: "image/png", size: MB }, true)).toEqual({
    ok: true,
    kind: "image",
    mediaType: "image/png",
  });
  expect(checkAttachment({ name: "a.png", type: "image/png", size: 11 * MB }, true)).toEqual({
    ok: false,
    error: "a.png is larger than 10 MB.",
  });
  expect(checkAttachment({ name: "a.png", type: "image/png", size: 1 }, false).ok).toBe(false);
  expect(checkAttachment({ name: "a.bmp", type: "image/bmp", size: 1 }, true)).toEqual({
    ok: false,
    error: "a.bmp isn't a supported image. Use PNG, JPEG, GIF or WebP.",
  });
});

test("text files go by media type or a code extension", () => {
  expect(checkAttachment({ name: "notes.md", type: "text/markdown", size: 10 }, false)).toEqual({
    ok: true,
    kind: "text",
    mediaType: "text/markdown",
  });
  expect(checkAttachment({ name: "app.tsx", type: "", size: 10 }, false)).toEqual({
    ok: true,
    kind: "text",
    mediaType: "text/plain",
  });
  expect(checkAttachment({ name: "Dockerfile", type: "", size: 10 }, false).ok).toBe(true);
  expect(checkAttachment({ name: "a.json", type: "application/json", size: 10 }, false)).toEqual({
    ok: true,
    kind: "text",
    mediaType: "application/json",
  });
  expect(checkAttachment({ name: "big.log", type: "text/plain", size: MB }, false)).toEqual({
    ok: false,
    error: "big.log is larger than 512 KB.",
  });
  expect(checkAttachment({ name: "a.zip", type: "application/zip", size: 10 }, true)).toEqual({
    ok: false,
    error: "a.zip isn't an image or a text file.",
  });
});

test("formatBytes", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(2048)).toBe("2 KB");
  expect(formatBytes(1.5 * MB)).toBe("1.5 MB");
  expect(formatBytes(10 * MB)).toBe("10 MB");
});
