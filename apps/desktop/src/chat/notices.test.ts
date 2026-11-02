import { expect, test } from "vite-plus/test";

import {
  claudeCompactingNotice,
  claudeCompactNotice,
  claudeModeNotice,
  claudeRateLimitNotice,
  claudeRetryNotice,
  codexErrorNotice,
  codexItemNotice,
  codexResetsAt,
  codexReroutedNotice,
  codexWarningNotice,
  oneLine,
  recoveredNotice,
  gaveUpNotice,
} from "./notices.ts";

const RESET = 1793609605; // 2026-11-02T08:53:25Z

test("codex retries update one notice per turn, and a recovery replaces it", () => {
  const error = { message: "Stream disconnected\n  at x.rs:1", additionalDetails: "HTTP 502" };
  expect(codexErrorNotice(error, true, "t1", 2, null)).toEqual({
    kind: "notice",
    id: "retry:t1",
    level: "warning",
    text: "Retrying (2)…",
    detail: "Stream disconnected\n  at x.rs:1\n\nHTTP 502",
  });
  // An error that ends the turn is the reply's error line, not a notice.
  expect(codexErrorNotice(error, false, "t1", 0, null)).toBeNull();
  expect(recoveredNotice("t1", 2)).toMatchObject({
    id: "retry:t1",
    level: "info",
    text: "Reconnected after 2 retries",
  });
  expect(recoveredNotice("t1", 1).text).toBe("Reconnected after 1 retry");
});

test("codex usage and context limits get their own notices, with the reset time", () => {
  const limits = {
    primary: { usedPercent: 40, resetsAt: 1 },
    secondary: { usedPercent: 100, resetsAt: RESET },
    rateLimitReachedType: "rate_limit_reached",
  };
  expect(codexResetsAt(limits)).toBe(RESET);
  expect(codexResetsAt(null)).toBeNull();
  const usage = { message: "You've hit your limit", codexErrorInfo: "usageLimitExceeded" };
  expect(codexErrorNotice(usage, false, "t1", 0, limits)).toMatchObject({
    id: "usage:t1",
    level: "error",
    text: "Usage limit reached. Resets at 2026-11-02T08:53:25.000Z.",
    detail: "You've hit your limit",
  });
  expect(
    codexErrorNotice({ ...usage, codexErrorInfo: "rateLimitExceeded" }, true, "t1", 1, null)?.text,
  ).toBe("Rate limit reached.");
  expect(
    codexErrorNotice(
      { message: "x", codexErrorInfo: "contextWindowExceeded" },
      false,
      "t1",
      0,
      null,
    ),
  ).toMatchObject({ id: "context:t1", level: "error" });
  // Object-shaped infos are plain retries.
  const disconnected = { responseStreamDisconnected: { httpStatusCode: null } };
  expect(
    codexErrorNotice({ message: "x", codexErrorInfo: disconnected }, true, "t1", 1, null)?.id,
  ).toBe("retry:t1");
});

test("codex warnings, reroutes and item events", () => {
  expect(codexWarningNotice("warning", { threadId: null, message: "Sandbox off" })).toMatchObject({
    id: "warning:Sandbox off",
    level: "warning",
    text: "Sandbox off",
    detail: null,
  });
  expect(
    codexWarningNotice("configWarning", { summary: "Bad key", details: "line 3", path: "c.toml" }),
  ).toMatchObject({ text: "Bad key", detail: "line 3\n\nc.toml" });
  expect(codexWarningNotice("deprecationNotice", { summary: "Old API", details: null })?.text).toBe(
    "Deprecated: Old API",
  );
  expect(codexWarningNotice("warning", { message: "  " })).toBeNull();
  expect(
    codexReroutedNotice({ fromModel: "a", toModel: "b", reason: "highRiskCyberActivity" }),
  ).toMatchObject({
    level: "info",
    text: "Codex switched from a to b",
    detail: "Flagged as high-risk activity.",
  });
  expect(codexItemNotice({ type: "contextCompaction", id: "c" }, "t1", false)).toMatchObject({
    id: "compact:t1",
    text: "Compacting context…",
  });
  expect(codexItemNotice({ type: "contextCompaction", id: "c" }, "t1", true)?.text).toBe(
    "Context compacted",
  );
  expect(
    codexItemNotice({ type: "exitedReviewMode", id: "r", review: "Looks good" }, "t1", true),
  ).toMatchObject({ text: "Finished the code review", detail: "Looks good" });
  expect(codexItemNotice({ type: "enteredReviewMode", id: "r", review: "x" }, "t1", false)).toBe(
    null,
  );
  expect(codexItemNotice({ type: "commandExecution", id: "x" }, "t1", true)).toBeNull();
});

test("claude rate limits notify only when not allowed", () => {
  const info = { resetsAt: RESET, rateLimitType: "five_hour" };
  expect(claudeRateLimitNotice({ ...info, status: "allowed" })).toBeNull();
  expect(claudeRateLimitNotice(null)).toBeNull();
  expect(claudeRateLimitNotice({ ...info, status: "allowed_warning" })).toMatchObject({
    id: "usage:five_hour",
    level: "warning",
    text: "You are close to your usage limit. Resets at 2026-11-02T08:53:25.000Z.",
  });
  expect(claudeRateLimitNotice({ ...info, status: "rejected" })?.level).toBe("error");
  expect(
    claudeRateLimitNotice({ ...info, status: "rejected", overageStatus: "allowed" }),
  ).toMatchObject({ level: "info", text: expect.stringContaining("using extra usage") });
  // A missing or bogus reset time is left out.
  expect(claudeRateLimitNotice({ status: "rejected", resetsAt: "soon" })?.text).toBe(
    "Usage limit reached.",
  );
});

test("claude retries and compaction", () => {
  expect(
    claudeRetryNotice({
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 4500,
      error: "rate_limit",
      error_status: 429,
    }),
  ).toMatchObject({
    id: "retry:turn",
    text: "Retrying (2/10) in 5s…",
    detail: "Claude API rate limit (HTTP 429).",
  });
  expect(claudeRetryNotice({})).toMatchObject({ text: "Retrying…", detail: null });
  expect(
    claudeCompactNotice({ uuid: "u", compact_metadata: { trigger: "auto", pre_tokens: 150000 } }),
  ).toMatchObject({
    id: "compact:turn",
    text: "Context compacted",
    detail: "Automatically, from 150,000 tokens",
  });
  expect(claudeCompactNotice({}).detail).toBeNull();
});

test("notice text is one capped line", () => {
  expect(oneLine("  first\nsecond")).toBe("first");
  expect(oneLine("x".repeat(250))).toBe(`${"x".repeat(200)}…`);
});

test("a retry notice ends as given up, and a rate limit Codex retries is a warning", () => {
  expect(gaveUpNotice("t", 3)).toMatchObject({
    id: "retry:t",
    level: "error",
    text: "Gave up after 3 retries",
  });
  const limit = { message: "slow down", codexErrorInfo: "rateLimitExceeded" };
  expect(codexErrorNotice(limit, true, "t", 1, null)).toMatchObject({ level: "warning" });
  expect(codexErrorNotice(limit, false, "t", 1, null)).toMatchObject({ level: "error" });
});

test("compaction updates one notice in place, and a mode fallback is called out", () => {
  expect(claudeCompactingNotice()).toMatchObject({
    id: "compact:turn",
    text: "Compacting context…",
  });
  expect(
    claudeCompactNotice({
      compact_metadata: { trigger: "manual", pre_tokens: 37198, post_tokens: 19643 },
    }),
  ).toMatchObject({ id: "compact:turn", detail: "On request, from 37,198 to 19,643 tokens" });
  expect(claudeModeNotice("bypassPermissions", "default").text).toBe(
    "Claude Code went on in Ask first mode, not Full access.",
  );
});

test("a config problem sent as configWarning and warning is one notice, with its specifics", () => {
  const summary =
    "Codex is ignoring 1 unrecognized setting.\n  user (config.toml): `bogus` is ignored.";
  const config = codexWarningNotice("configWarning", { summary, details: null });
  const thread = codexWarningNotice("warning", { threadId: "t", message: summary });
  expect(config!.id).toBe(thread!.id);
  expect(config).toMatchObject({
    text: "Codex is ignoring 1 unrecognized setting.",
    detail: expect.stringContaining("bogus"),
  });
});
