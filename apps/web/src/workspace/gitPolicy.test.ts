import type { GitOverview } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import {
  branchFromSubject,
  menuChoices,
  needsDefaultBranchConfirm,
  primaryChoice,
} from "./gitPolicy.ts";

const base: GitOverview = {
  status: {
    isRepo: true,
    repo: "me/app",
    branch: "feature",
    ahead: 0,
    behind: 0,
    changed: 0,
    conflicts: 0,
    operation: null,
  },
  staged: 0,
  unstaged: 0,
  hasCommits: true,
  upstream: "origin/feature",
  remote: "origin",
  defaultBranch: "main",
  onDefaultBranch: false,
  headPushed: true,
  suggestedBase: "main",
  lastCommit: "Add thing",
  github: {
    status: "ready",
    repo: "me/app",
    url: "https://github.com/me/app",
    pullRequest: null,
    message: null,
  },
};
const make = (patch: Partial<GitOverview>, status: Partial<GitOverview["status"]> = {}) => ({
  ...base,
  ...patch,
  status: { ...base.status, ...status },
});
const pr = {
  number: 7,
  title: "x",
  state: "open" as const,
  url: "https://github.com/me/app/pull/7",
};
const withPr = { github: { ...base.github, pullRequest: pr } };

test("the primary action follows the repository's state", () => {
  expect(primaryChoice(null).disabled).toBeTruthy();
  expect(primaryChoice(make({}, { isRepo: false })).command).toBe("init");
  expect(primaryChoice(make({ unstaged: 2 })).command).toBe("commitPushPr");
  expect(primaryChoice(make({ unstaged: 2, onDefaultBranch: true })).command).toBe("commitPush");
  expect(primaryChoice(make({ staged: 1, remote: null, upstream: null })).command).toBe("commit");
  expect(primaryChoice(make({ remote: null, upstream: null })).command).toBe("publish");
  expect(primaryChoice(make({ upstream: null })).command).toBe("pushPr");
  expect(primaryChoice(make({}, { behind: 2 })).command).toBe("pull");
  expect(primaryChoice(make({}, { ahead: 1, behind: 2 })).disabled).toMatch(/both moved on/);
  expect(primaryChoice(make({}, { ahead: 1 })).command).toBe("pushPr");
  expect(primaryChoice(make(withPr, { ahead: 1 })).command).toBe("push");
  expect(primaryChoice(make(withPr)).label).toBe("View PR #7");
  expect(primaryChoice(base).command).toBe("prDialog");
  expect(primaryChoice(make({ onDefaultBranch: true })).disabled).toBeTruthy();
});

test("conflicts, operations and detached HEAD stop everything", () => {
  expect(primaryChoice(make({ unstaged: 1 }, { conflicts: 2 })).disabled).toMatch(/conflicted/);
  expect(primaryChoice(make({}, { operation: "rebase" })).disabled).toMatch(/rebase/);
  expect(primaryChoice(make({}, { branch: null })).disabled).toMatch(/detached/);
  for (const choice of menuChoices(make({ unstaged: 1 }, { conflicts: 1 })).flat())
    expect(choice.disabled).toMatch(/conflicted/);
});

test("the menu explains why actions are unavailable", () => {
  const items = menuChoices(make({}, { behind: 1 })).flat();
  expect(items.find((i) => i.command === "push")?.disabled).toMatch(/Pull first/);
  expect(items.find((i) => i.command === "pull")?.disabled).toBeUndefined();
  expect(items.find((i) => i.command === "commitDialog")?.disabled).toBe("Nothing to commit.");
  const signedOut = menuChoices(
    make({ github: { ...base.github, status: "signedOut", message: "Run gh auth login." } }),
  ).flat();
  expect(signedOut.find((i) => i.command === "prDialog")?.disabled).toBe("Run gh auth login.");
  const local = menuChoices(make({ remote: null, upstream: null })).flat();
  expect(local.map((i) => i.command)).toContain("publish");
  expect(
    menuChoices(make(withPr))
      .flat()
      .map((i) => i.command),
  ).toEqual(expect.arrayContaining(["viewPr", "updatePrDialog"]));
});

test("pushing to the default branch asks first; a branch name comes from the subject", () => {
  const main = make({ onDefaultBranch: true });
  expect(needsDefaultBranchConfirm(main, "commitPush")).toBe(true);
  expect(needsDefaultBranchConfirm(main, "commit")).toBe(false);
  expect(needsDefaultBranchConfirm(base, "push")).toBe(false);
  expect(branchFromSubject("Fix the login redirect!")).toBe("rook/fix-the-login-redirect");
  expect(branchFromSubject("???")).toBe("rook/changes");
});
