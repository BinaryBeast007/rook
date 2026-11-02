import { expect, test } from "vite-plus/test";

import {
  approvalLabel,
  approvalResult,
  openableUrl,
  optionLabel,
  type ApprovalPart,
} from "./approvalKinds.ts";

const part = (extra: Partial<ApprovalPart>): ApprovalPart => ({
  kind: "approval",
  id: "a",
  title: "Run x?",
  detail: null,
  options: ["allow", "allowSession", "deny"],
  decision: null,
  ...extra,
});

test("each kind has a label; unknown and older approvals read Approval", () => {
  expect(approvalLabel("command")).toBe("Run command");
  expect(approvalLabel("permissions")).toBe("Permissions");
  expect(approvalLabel("mcp")).toBe("MCP tool");
  expect(approvalLabel("future-kind")).toBe("Approval");
  expect(approvalLabel(undefined)).toBe("Approval");
});

test("option labels fit the kind", () => {
  expect(optionLabel("command", "allow")).toBe("Allow once");
  expect(optionLabel("command", "allowSession")).toBe("Allow for this chat");
  expect(optionLabel("permissions", "allow")).toBe("Grant for this turn");
  expect(optionLabel("link", "allow")).toBe("Open link");
  expect(optionLabel(undefined, "deny")).toBe("Deny");
});

test("results say how an approval ended", () => {
  expect(approvalResult(part({}), true)).toBeNull();
  expect(approvalResult(part({}), false)).toBe("No longer answerable: the turn ended");
  expect(approvalResult(part({ decision: "allow" }), false)).toBe("Allowed once");
  expect(approvalResult(part({ decision: "allowSession" }), true)).toBe("Allowed for this chat");
  expect(approvalResult(part({ decision: "deny", feedback: "no" }), true)).toBe("Denied");
  expect(approvalResult(part({ decision: "allow", tool: "permissions" }), true)).toBe(
    "Granted for this turn",
  );
});

test("only https links open", () => {
  expect(openableUrl(" https://x.test/a ")).toBe("https://x.test/a");
  expect(openableUrl("http://x.test")).toBeNull();
  expect(openableUrl("javascript:alert(1)")).toBeNull();
  expect(openableUrl("https://x.test two")).toBeNull();
  expect(openableUrl(null)).toBeNull();
});
