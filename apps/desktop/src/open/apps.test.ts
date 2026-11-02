import { expect, test } from "vite-plus/test";

import { detectApps, iconPath, isOpenAppId, launchCommand, type Probe } from "./apps.ts";

function probe(
  overrides: Partial<Probe> & { files?: string[]; clis?: Record<string, string> },
): Probe {
  const files = new Set(overrides.files ?? []);
  const clis = overrides.clis ?? {};
  return {
    platform: "linux",
    env: {},
    home: "/home/me",
    exists: (path) => files.has(path),
    which: (name) => clis[name] ?? null,
    ...overrides,
  };
}

test("win32 prefers installed .exe files over CLI shims, in both install roots", () => {
  const apps = detectApps(
    probe({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", ProgramFiles: "C:\\Program Files" },
      files: [
        "C:\\Program Files\\cursor\\Cursor.exe",
        "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
      ],
      clis: {
        cursor: "C:\\Program Files\\cursor\\resources\\app\\bin\\cursor.cmd",
        windsurf: "C:\\tools\\windsurf.cmd",
      },
    }),
  );
  expect(apps).toEqual([
    { id: "cursor", name: "Cursor", path: "C:\\Program Files\\cursor\\Cursor.exe" },
    {
      id: "vscode",
      name: "VS Code",
      path: "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
    },
    { id: "windsurf", name: "Windsurf", path: "C:\\tools\\windsurf.cmd" },
    { id: "explorer", name: "Explorer", path: "" },
  ]);
});

test("darwin finds .app bundles in /Applications and ~/Applications, then PATH", () => {
  const apps = detectApps(
    probe({
      platform: "darwin",
      home: "/Users/me",
      files: ["/Applications/Visual Studio Code.app", "/Users/me/Applications/Zed.app"],
      clis: { code: "/usr/local/bin/code", cursor: "/usr/local/bin/cursor" },
    }),
  );
  expect(apps.map((app) => [app.id, app.path])).toEqual([
    ["cursor", "/usr/local/bin/cursor"],
    ["vscode", "/Applications/Visual Studio Code.app"],
    ["zed", "/Users/me/Applications/Zed.app"],
    ["explorer", ""],
  ]);
  expect(apps.at(-1)?.name).toBe("Finder");
});

test("linux uses PATH only, including Zed's zeditor name", () => {
  const apps = detectApps(
    probe({ files: ["/Applications/Cursor.app"], clis: { zeditor: "/usr/bin/zeditor" } }),
  );
  expect(apps).toEqual([
    { id: "zed", name: "Zed", path: "/usr/bin/zeditor" },
    { id: "explorer", name: "Files", path: "" },
  ]);
});

test("the file manager is listed even when nothing else is installed", () => {
  expect(detectApps(probe({ platform: "win32" }))).toEqual([
    { id: "explorer", name: "Explorer", path: "" },
  ]);
});

test("launchCommand passes the folder as its own argument", () => {
  const folder = "/Users/me/my project; rm -rf ~";
  expect(launchCommand("/Applications/Zed.app", folder)).toEqual({
    file: "open",
    args: ["-a", "/Applications/Zed.app", folder],
  });
  expect(launchCommand("C:\\Program Files\\cursor\\Cursor.exe", "C:\\a b")).toEqual({
    file: "C:\\Program Files\\cursor\\Cursor.exe",
    args: ["C:\\a b"],
  });
  expect(launchCommand("/usr/bin/code", folder)).toEqual({ file: "/usr/bin/code", args: [folder] });
});

test("isOpenAppId accepts only known apps", () => {
  expect(["cursor", "vscode", "windsurf", "zed", "explorer"].every(isOpenAppId)).toBe(true);
  expect(isOpenAppId("notepad")).toBe(false);
  expect(isOpenAppId(undefined)).toBe(false);
});

const cursorAt = (path: string) => ({ id: "cursor" as const, name: "Cursor", path });
const explorer = { id: "explorer" as const, name: "Explorer", path: "" };

test("icons come from the app bundle or file manager, never from a CLI", () => {
  expect(iconPath(cursorAt("C:\\Program Files\\cursor\\Cursor.exe"), "win32", {})).toBe(
    "C:\\Program Files\\cursor\\Cursor.exe",
  );
  expect(iconPath(cursorAt("C:\\tools\\cursor.cmd"), "win32", {})).toBeNull();
  expect(iconPath(cursorAt("/Applications/Cursor.app"), "darwin", {})).toBe(
    "/Applications/Cursor.app",
  );
  expect(iconPath(cursorAt("/usr/bin/cursor"), "linux", {})).toBeNull();
  expect(iconPath(explorer, "win32", { SystemRoot: "D:\\Windows" })).toBe(
    "D:\\Windows\\explorer.exe",
  );
  expect(iconPath(explorer, "win32", {})).toBe("C:\\Windows\\explorer.exe");
  expect(iconPath(explorer, "darwin", {})).toBe("/System/Library/CoreServices/Finder.app");
  expect(iconPath(explorer, "linux", {})).toBeNull();
});
