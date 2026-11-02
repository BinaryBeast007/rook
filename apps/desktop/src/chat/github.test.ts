import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink } from "node:fs/promises";
import * as NodePath from "node:path";

import { expect, test } from "vite-plus/test";

import { resolveCommand } from "../agents/process.ts";
import { fakeBin, tempDir } from "../agents/testing/fakeBin.ts";
import { githubClient } from "./github.ts";

const gitFile = resolveCommand("git");

/** A repo with `remote` as origin, and a client whose PATH holds git and, unless told not to, a fake gh. */
async function setup(remote: string, extra: Record<string, string> = {}, withGh = true) {
  const dir = await tempDir("rook-github-");
  const repo = NodePath.join(dir, "repo");
  const bin = NodePath.join(dir, "bin");
  await mkdir(repo);
  await mkdir(bin);
  execFileSync("git", ["init", "-q", "-b", "feature"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
  if (withGh) await fakeBin(bin, "gh", "gh.mjs");
  // Outside Windows, git usually sits in /usr/bin next to a real gh, so it is linked in rather
  // than putting its folder on PATH. Windows installs them apart (and symlinks need privileges).
  const windows = process.platform === "win32";
  if (!windows) await symlink(gitFile!, NodePath.join(bin, "git"));
  const log = NodePath.join(dir, "gh.log");
  const { PATH: _path, Path: _winPath, ...rest } = process.env;
  const env = {
    ...rest,
    PATH: windows ? [bin, NodePath.dirname(gitFile!)].join(NodePath.delimiter) : bin,
    FAKE_GH_LOG: log,
    ...extra,
  };
  const calls = async () => (existsSync(log) ? await readFile(log, "utf8") : "");
  return { repo, client: githubClient(() => env), calls };
}

const PR = {
  number: 7,
  title: "Add repo bar",
  state: "OPEN",
  isDraft: true,
  url: "https://github.com/acme/rook/pull/7",
};

test.skipIf(!gitFile)("GitHub through the gh CLI", async () => {
  const notGitHub = await setup("git@gitlab.com:acme/rook.git");
  expect(await notGitHub.client.info(notGitHub.repo)).toMatchObject({
    status: "notGitHub",
    repo: null,
  });
  expect(await notGitHub.calls()).toBe("");

  const missing = await setup("https://github.com/acme/rook.git", {}, false);
  expect(await missing.client.info(missing.repo)).toMatchObject({
    status: "missing",
    repo: "acme/rook",
    url: "https://github.com/acme/rook",
  });

  const signedOut = await setup("git@github.com:acme/rook.git", { FAKE_GH_AUTH: "0" });
  const out = await signedOut.client.info(signedOut.repo);
  expect(out).toMatchObject({ status: "signedOut", pullRequest: null });
  expect(out.message).toContain("gh auth login");

  const none = await setup("git@github.com:acme/rook.git");
  expect(await none.client.info(none.repo)).toMatchObject({ status: "ready", pullRequest: null });

  const found = await setup("https://github.com/acme/rook", { FAKE_GH_PR: JSON.stringify(PR) });
  const info = await found.client.info(found.repo);
  expect(info).toEqual({
    status: "ready",
    repo: "acme/rook",
    url: "https://github.com/acme/rook",
    pullRequest: { number: 7, title: "Add repo bar", state: "draft", url: PR.url },
    message: null,
  });
  // A second look within the cache window does not run gh again.
  await found.client.info(found.repo);
  const calls = await found.calls();
  expect(calls).toBe(
    "auth status --hostname github.com\npr view feature --repo acme/rook --json number,title,state,isDraft,url\n",
  );
  expect(calls).not.toMatch(/token/i);
});
