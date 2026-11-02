import { expect, test } from "vite-plus/test";

import {
  argsText,
  argvText,
  claudeReason,
  codexDecision,
  codexOptions,
  elicitationApproval,
  elicitationResponse,
  grantText,
  legacyCommand,
  legacyDecision,
  patchText,
  permissionsResponse,
  permissionsText,
  type Elicitation,
} from "./approvals.ts";

test("argsText reads arguments as lines, not JSON", () => {
  expect(argsText({ query: "rook", limit: 5, empty: "", gone: null })).toBe(
    "query: rook\nlimit: 5",
  );
  expect(argsText({ body: "a\nb", tags: ["x"] })).toBe('body:\n  a\n  b\ntags: ["x"]');
  expect(argsText({})).toBeNull();
  expect(argsText(undefined)).toBeNull();
  expect(argsText("raw")).toBe('"raw"');
});

test("claudeReason prefers the CLI's reason, without terminal codes", () => {
  expect(claudeReason({ decision_reason: "\u001b[1mRisky\u001b[0m " })).toBe("Risky");
  expect(claudeReason({ blocked_path: "/etc/hosts" })).toBe(
    "It needs /etc/hosts, outside the folders it may use.",
  );
  expect(claudeReason({ description: "README.md" })).toBeNull();
});

test("codexOptions shows only what Codex offers; deny is always there", () => {
  expect(codexOptions(undefined)).toEqual(["allow", "allowSession", "deny"]);
  expect(codexOptions(["accept", { acceptWithExecpolicyAmendment: {} }, "cancel"])).toEqual([
    "allow",
    "deny",
  ]);
  expect(codexOptions(["acceptForSession", "decline"])).toEqual(["allowSession", "deny"]);
  expect(codexOptions([])).toEqual(["deny"]);
});

test("decisions map to each Codex request's answer", () => {
  expect(["allow", "allowSession", "deny"].map((d) => codexDecision(d as never))).toEqual([
    "accept",
    "acceptForSession",
    "decline",
  ]);
  expect(legacyDecision({ decision: "allow", feedback: null })).toEqual({ decision: "approved" });
  expect(legacyDecision({ decision: "allowSession", feedback: null })).toEqual({
    decision: "approved_for_session",
  });
  expect(legacyDecision({ decision: "deny", feedback: null })).toEqual({
    decision: { denied: { rejection: "The user declined this action." } },
  });
  expect(legacyDecision({ decision: "deny", feedback: "use pnpm" })).toEqual({
    decision: { denied: { rejection: "The user declined this action and said: use pnpm" } },
  });
});

test("argvText quotes arguments with spaces", () => {
  expect(argvText(["git", "commit", "-m", "a b"])).toBe('git commit -m "a b"');
});

test("patchText names each file in its hunks", () => {
  expect(
    patchText({
      "a.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-x\n+y\n", move_path: null },
      "b.ts": { type: "delete", content: "old\n" },
    }),
  ).toBe(
    [
      "diff --git a/a.ts b/a.ts",
      "@@ -1 +1 @@ a.ts",
      "-x",
      "+y",
      "diff --git a/b.ts b/b.ts",
      "@@ -1,1 +0,0 @@ b.ts",
      "-old",
    ].join("\n"),
  );
  expect(patchText({})).toBeNull();
});

test("permissions read as lines and are granted only on allow", () => {
  const asked = {
    network: { enabled: true },
    fileSystem: {
      read: null,
      write: ["/repo/out"],
      entries: [
        { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
        { path: { type: "glob_pattern", pattern: "**/*.env" }, access: "deny" },
      ],
    },
  };
  expect(permissionsText(asked)).toBe(
    "Network access\nWrite: /repo/out\nWrite: the temp folder\nDeny: **/*.env",
  );
  expect(permissionsText({ network: null, fileSystem: null })).toBeNull();
  expect(permissionsResponse(asked, "allow")).toEqual({
    permissions: { network: asked.network, fileSystem: asked.fileSystem },
    scope: "turn",
  });
  expect(permissionsResponse(asked, "deny")).toEqual({ permissions: {}, scope: "turn" });
});

const elicitation = (extra: Partial<Elicitation>): Elicitation => ({
  server: "docs",
  mode: "form",
  message: "Continue?",
  url: null,
  schema: { type: "object", properties: {} },
  meta: null,
  ...extra,
});

test("elicitations become approvals only when the card can answer them", () => {
  const link = elicitation({ mode: "url", url: "https://x.test", message: "Sign in" });
  expect(elicitationApproval(link)).toMatchObject({ tool: "link", detail: "https://x.test" });
  expect(elicitationApproval(elicitation({}))).toMatchObject({
    tool: "elicitation",
    reason: "Continue?",
    options: ["allow", "deny"],
  });
  const toolCall = elicitation({
    message: 'Allow the docs MCP server to run tool "search"?',
    meta: { codex_approval_kind: "mcp_tool_call", persist: ["session"], tool_params: { q: "a" } },
  });
  expect(elicitationApproval(toolCall)).toMatchObject({
    tool: "mcp",
    detail: "q: a",
    options: ["allow", "allowSession", "deny"],
  });
  const required = { type: "object", properties: { email: {} }, required: ["email"] };
  expect(elicitationApproval(elicitation({ schema: required }))).toBeNull();
  expect(elicitationApproval(elicitation({ mode: "openai/userVerification" }))).toBeNull();
});

test("elicitationResponse accepts with nothing filled in, or declines", () => {
  expect(elicitationResponse(elicitation({}), "allow")).toEqual({ action: "accept", content: {} });
  expect(elicitationResponse(elicitation({}), "allowSession")).toEqual({
    action: "accept",
    content: {},
    _meta: { persist: "session" },
  });
  expect(elicitationResponse(elicitation({ mode: "url" }), "allow")).toEqual({ action: "accept" });
  expect(elicitationResponse(elicitation({}), "deny")).toEqual({ action: "decline" });
});

const link = (url: string): Elicitation => ({
  server: "docs",
  mode: "url",
  message: "Sign in",
  url,
  schema: null,
  meta: null,
});

test("legacy commands read as typed, folder grants are spelled out, links must be https", () => {
  expect(legacyCommand(["bash", "-lc", 'echo "hi"\nls'])).toBe('echo "hi"\nls');
  expect(legacyCommand(["git", "commit", "-m", "a b"])).toBe('git commit -m "a b"');
  expect(grantText("/repo")).toBe("It asks to write anywhere in /repo.");
  expect(grantText(null)).toBeNull();
  expect(elicitationApproval(link("https://docs.example/login"))?.tool).toBe("link");
  for (const url of ["http://docs.example", "javascript:alert(1)", "file:///etc/passwd"])
    expect(elicitationApproval(link(url)), url).toBeNull();
  // A form without a schema says nothing about what accepting means.
  expect(elicitationApproval({ ...link(""), mode: "form", url: null })).toBeNull();
});
