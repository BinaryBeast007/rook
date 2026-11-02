import { expect, test } from "vite-plus/test";

import { classifyGitError, commitError, firstLines, redact } from "./errors.ts";

test("redact hides URL credentials and GitHub tokens", () => {
  expect(
    redact("fatal: unable to access 'https://octo:ghp_abcdefghijklmnop1234@github.com/a/b'"),
  ).toBe("fatal: unable to access 'https://***@github.com/a/b'");
  expect(redact("token github_pat_11ABCDEFG0123456789_xyz in use")).toBe("token *** in use");
  expect(redact("git@github.com:acme/rook.git")).toBe("git@github.com:acme/rook.git");
});

test("classifyGitError explains common push and network failures", () => {
  const credentials =
    "GitHub refused the credentials. Check `gh auth status` or your git credential helper, then try again.";
  expect(classifyGitError("fatal: Authentication failed for 'https://github.com/a/b.git/'")).toBe(
    credentials,
  );
  expect(
    classifyGitError(
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    ),
  ).toBe(credentials);
  expect(
    classifyGitError(
      "remote: Permission to acme/rook.git denied to octo.\nfatal: unable to access 'https://github.com/acme/rook.git/': The requested URL returned error: 403",
    ),
  ).toBe(credentials);
  expect(
    classifyGitError(
      "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    ),
  ).toBe(credentials);
  expect(
    classifyGitError("Host key verification failed.\nfatal: Could not read from remote"),
  ).toMatch(/host key couldn't be verified/);
  expect(
    classifyGitError(
      "fatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com",
    ),
  ).toBe("Couldn't reach the remote. Check your connection.");
  expect(
    classifyGitError(
      " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'x'\nhint: Updates were rejected because the remote contains work",
    ),
  ).toBe("The remote has commits this branch doesn't have. Pull first, then push again.");
  expect(classifyGitError(" ! [rejected]        main -> main (non-fast-forward)")).toMatch(
    /Pull first/,
  );
  expect(
    classifyGitError(
      "remote: error: GH006: Protected branch update failed for refs/heads/main.\n ! [remote rejected] main -> main (protected branch hook declined)",
    ),
  ).toBe(
    "The remote rejected the push: error: GH006: Protected branch update failed for refs/heads/main.",
  );
  expect(classifyGitError(" ! [remote rejected] main -> main (pre-receive hook declined)")).toBe(
    "The remote rejected the push: pre-receive hook declined",
  );
  expect(classifyGitError(" ! [rejected]        main -> main (stale info)")).toBe(
    "The remote branch changed since you last fetched. Pull first.",
  );
});

test("classifyGitError falls back to git's first lines, redacted", () => {
  expect(
    classifyGitError(
      "hint: ignore me\nfatal: something odd at https://u:secret@host/x\nline two\nline three\nline four",
    ),
  ).toBe("something odd at https://***@host/x\nline two\nline three");
  expect(classifyGitError("", "Nope.")).toBe("Nope.");
  expect(firstLines("a\n\n  b  \nc", 2)).toBe("a\nb");
});

test("commitError shows the hook's output, or explains a missing identity", () => {
  const hook = Array.from({ length: 15 }, (_, i) => `lint: problem ${i}`).join("\n");
  expect(commitError(hook).split("\n")).toHaveLength(10);
  expect(commitError("Author identity unknown\n*** Please tell me who you are.")).toMatch(
    /git config --global user.name/,
  );
  expect(commitError("\n")).toBe("Git couldn't commit.");
});
