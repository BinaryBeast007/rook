// Turns git's and gh's error output into messages for the Commit button. Pure, so it is tested
// without a remote. Nothing that could be a credential ever reaches the message.

/** Hides credentials: URL userinfo (`https://user:token@host`) and GitHub token strings. */
export function redact(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{10,}/g, "***");
}

/** The first `count` meaningful lines, without git's `fatal:`/`error:` prefixes or hints. */
export function firstLines(output: string, count: number): string {
  return redact(
    output
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^(?:fatal|error): /, ""))
      .filter((line) => line && !line.startsWith("hint:"))
      .slice(0, count)
      .join("\n"),
  );
}

const CREDENTIALS =
  /authentication failed|could not read (?:username|password)|permission to \S+ denied|returned error: 403|403 forbidden|permission denied \(publickey|invalid username or password|bad credentials/i;
const NETWORK =
  /could not resolve host|unable to access|failed to connect|connection timed out|network is unreachable|connection refused|could not read from remote repository/i;

/** Why `git commit` failed: usually the user's own pre-commit hook, so its first lines. */
export function commitError(output: string): string {
  if (
    /please tell me who you are|author identity unknown|unable to auto-detect email/i.test(output)
  )
    return 'Set your git name and email first: git config --global user.name "Your Name", then git config --global user.email you@example.com.';
  return firstLines(output, 10) || "Git couldn't commit.";
}

/** A message safe to show for a failed git or gh command. */
export function classifyGitError(output: string, fallback = "Git couldn't do that."): string {
  if (CREDENTIALS.test(output))
    return "GitHub refused the credentials. Check `gh auth status` or your git credential helper, then try again.";
  if (/host key verification failed/i.test(output))
    return "The remote's SSH host key couldn't be verified. Connect to it once with ssh in a terminal, then try again.";
  if (/\(stale info\)/i.test(output))
    return "The remote branch changed since you last fetched. Pull first.";
  if (/\[remote rejected\]|pre-receive hook declined|protected branch/i.test(output)) {
    const remote = /^remote:\s*(\S.*)$/m.exec(output)?.[1];
    const reason =
      remote ?? /\[remote rejected\][^(]*\(([^)]+)\)/.exec(output)?.[1] ?? "no reason given";
    return `The remote rejected the push: ${redact(reason.trim())}`;
  }
  if (/non-fast-forward|\(fetch first\)|updates were rejected because/i.test(output))
    return "The remote has commits this branch doesn't have. Pull first, then push again.";
  // After the push-specific checks: a rejected push also mentions "could not read from remote".
  if (/repository not found/i.test(output))
    return "The remote repository wasn't found, or this account can't see it.";
  if (NETWORK.test(output)) return "Couldn't reach the remote. Check your connection.";
  return firstLines(output, 3) || fallback;
}
