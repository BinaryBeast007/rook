// The Commit button's dialogs: commit (or amend), pull request (create or update), publish to
// GitHub, and the check before pushing straight to the default branch.
import type { GitBridge, GitOverview, GitRunRequest } from "@rook/contracts";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { SpinnerIcon } from "../icons.tsx";
import { errorMessage } from "../tools/ui.tsx";
import { branchFromSubject, openPr } from "./gitPolicy.ts";

const BUTTON =
  "h-7 rounded-md px-3 text-xs font-medium transition-colors focus-visible:ring-1 focus-visible:ring-white/40 focus-visible:outline-none disabled:opacity-50";
const PRIMARY = `${BUTTON} bg-paper text-ink hover:opacity-90 active:opacity-80`;
const SECONDARY = `${BUTTON} bg-white/8 text-neutral-100 hover:bg-white/12 active:bg-white/16`;
const QUIET = `${BUTTON} text-neutral-300 hover:bg-white/6 hover:text-neutral-100`;
const FIELD =
  "w-full rounded-md bg-white/4 px-2.5 text-sm text-neutral-100 ring-1 ring-white/10 placeholder:text-neutral-500 focus:ring-white/25 focus:outline-none";
const LABEL = "mb-1 block text-xs font-medium text-neutral-400";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * A native modal <dialog>: keeps focus inside, makes the page behind it inert, closes on Escape
 * (unless busy), and returns focus to the opener. Chromium lets a second Escape close it even
 * while busy, so whoever runs the action must not rely on it staying open.
 *
 * It renders inside the title bar, and `-webkit-app-region` is inherited: without `no-drag` the
 * whole dialog is a window-drag area, and Windows swallows real clicks on its buttons and fields.
 */
function Modal({
  title,
  busy,
  onClose,
  children,
  footer,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={headingId}
      onClose={onClose}
      onCancel={(event) => busy && event.preventDefault()}
      onKeyDown={(event) => event.key === "Escape" && event.stopPropagation()}
      className="app-region-no-drag m-auto w-[min(32rem,calc(100%-2rem))] rounded-xl border border-white/8 bg-raised p-5 text-neutral-200 shadow-2xl backdrop:bg-black/60 motion-safe:animate-dialog-in"
    >
      <h2 id={headingId} className="text-sm font-medium text-neutral-100">
        {title}
      </h2>
      <div className="mt-4 space-y-4">{children}</div>
      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">{footer}</div>
    </dialog>
  );
}

function ErrorText({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-xs/5 whitespace-pre-wrap text-amber-300">
      {message}
    </p>
  ) : null;
}

/** "Write with AI": fills fields from `generate`, saying when it fell back to a plain summary. */
function GenerateButton({
  disabled,
  generate,
  onText,
}: {
  disabled: boolean;
  generate: () => ReturnType<GitBridge["generate"]>;
  onText: (title: string, body: string, note: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled || busy}
      aria-busy={busy}
      onClick={() => {
        setBusy(true);
        generate()
          .then(
            (text) =>
              onText(
                text.title,
                text.body,
                text.fallback ? `Wrote a plain summary instead: ${text.fallback}` : null,
              ),
            (cause: unknown) => onText("", "", errorMessage(cause)),
          )
          .finally(() => setBusy(false));
      }}
      className={`${QUIET} inline-flex items-center gap-1.5 px-2`}
    >
      {busy && <SpinnerIcon className="size-3.5 motion-safe:animate-spin" />}
      {busy ? "Writing…" : "Write with AI"}
    </button>
  );
}

export function CommitDialog({
  overview,
  bridge,
  refId,
  amend: amendInitially,
  onRun,
  onClose,
}: {
  overview: GitOverview;
  bridge: GitBridge;
  refId: string;
  amend: boolean;
  /** Rejects with a message safe to show. */
  onRun: (request: GitRunRequest) => Promise<void>;
  onClose: () => void;
}) {
  const { staged, unstaged, remote, headPushed, lastCommit, onDefaultBranch } = overview;
  const [message, setMessage] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [scope, setScope] = useState<"staged" | "all">(staged > 0 ? "staged" : "all");
  const [amend, setAmend] = useState(amendInitially);
  const [branching, setBranching] = useState(false);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subject = message.split("\n")[0]!.trim();
  const branchName = branch.trim() || branchFromSubject(subject || "changes");
  const willForce = amend && headPushed;
  const canPr =
    overview.github.status === "ready" && !openPr(overview) && (!onDefaultBranch || branching);
  const nothing = !amend && staged + unstaged === 0;

  const run = (action: GitRunRequest["action"]) => {
    setBusy(true);
    setError(null);
    onRun({
      action,
      message: message.trim() || undefined,
      scope,
      amend,
      force: willForce && action !== "commit",
      newBranch: branching ? branchName : undefined,
    }).then(
      () => setBusy(false),
      (cause: unknown) => {
        setError(errorMessage(cause));
        setBusy(false);
      },
    );
  };

  return (
    <Modal
      title={amend ? "Amend last commit" : "Commit changes"}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" disabled={busy} onClick={onClose} className={QUIET}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || nothing}
            onClick={() => run("commit")}
            className={remote ? SECONDARY : PRIMARY}
          >
            {amend ? "Amend" : "Commit"}
          </button>
          {remote && (
            <button
              type="button"
              disabled={busy || nothing}
              onClick={() => run("commitPush")}
              className={canPr ? SECONDARY : PRIMARY}
            >
              {willForce ? "Amend & force push" : amend ? "Amend & push" : "Commit & push"}
            </button>
          )}
          {remote && canPr && (
            <button
              type="button"
              disabled={busy || nothing}
              onClick={() => run("commitPushPr")}
              className={PRIMARY}
            >
              {amend ? "Amend, push & PR" : "Commit, push & PR"}
            </button>
          )}
        </>
      }
    >
      <p className="text-xs/5 text-neutral-500">
        On <span className="text-neutral-300">{overview.status.branch}</span>
        {onDefaultBranch && " (the default branch)"} ·{" "}
        {staged > 0 && `${plural(staged, "staged file")}`}
        {staged > 0 && unstaged > 0 && ", "}
        {unstaged > 0 && `${plural(unstaged, "unstaged file")}`}
        {staged + unstaged === 0 && "no changes"}
      </p>

      <div>
        <div className="flex items-end justify-between">
          <label htmlFor="commit-message" className={LABEL}>
            Message
          </label>
          <GenerateButton
            disabled={busy || nothing}
            generate={() => bridge.generate(refId, { kind: "commit", scope })}
            onText={(title, body, why) => {
              if (title) setMessage(body ? `${title}\n\n${body}` : title);
              setNote(why);
            }}
          />
        </div>
        <textarea
          id="commit-message"
          rows={4}
          value={message}
          autoFocus
          onChange={(event) => setMessage(event.target.value)}
          placeholder={
            amend && lastCommit ? `Keep “${lastCommit}”` : "Leave empty to have AI write it"
          }
          className={`${FIELD} resize-y py-2 font-mono text-xs/5`}
        />
        {note && <p className="mt-1 text-xs text-neutral-500">{note}</p>}
      </div>

      {staged > 0 && unstaged > 0 && (
        <fieldset>
          <legend className={LABEL}>Include</legend>
          <div className="flex gap-4 text-sm">
            {(
              [
                ["staged", `Staged only (${staged})`],
                ["all", `All changes (${staged + unstaged})`],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-neutral-300">
                <input
                  type="radio"
                  name="commit-scope"
                  checked={scope === value}
                  onChange={() => setScope(value)}
                  className="accent-white"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="space-y-2 text-sm">
        {overview.hasCommits && (
          <label className="flex items-start gap-2 text-neutral-300">
            <input
              type="checkbox"
              checked={amend}
              onChange={(event) => setAmend(event.target.checked)}
              className="mt-1 accent-white"
            />
            <span>
              Amend the last commit
              {lastCommit && <span className="text-neutral-500"> · {lastCommit}</span>}
              {willForce && (
                <span className="mt-0.5 block text-xs text-amber-300">
                  That commit is already pushed. Pushing rewrites it on the remote (force with
                  lease, so nobody else&apos;s new commits are lost).
                </span>
              )}
            </span>
          </label>
        )}
        <label className="flex items-start gap-2 text-neutral-300">
          <input
            type="checkbox"
            checked={branching}
            onChange={(event) => setBranching(event.target.checked)}
            className="mt-1 accent-white"
          />
          <span>
            Commit on a new branch
            <span className="block text-xs text-neutral-500">
              Branches from {overview.status.branch}; a PR from it targets {overview.status.branch}{" "}
              unless you pick another base.
            </span>
          </span>
        </label>
        {branching && (
          <input
            aria-label="New branch name"
            value={branch}
            placeholder={branchName}
            onChange={(event) => setBranch(event.target.value)}
            className={`${FIELD} h-8 font-mono text-xs`}
          />
        )}
      </div>
      <ErrorText message={error} />
    </Modal>
  );
}

export function PullRequestDialog({
  overview,
  bridge,
  refId,
  update,
  onRun,
  onClose,
}: {
  overview: GitOverview;
  bridge: GitBridge;
  refId: string;
  /** Rewrites the open pull request's title and body instead of creating one. */
  update: boolean;
  onRun: (request: GitRunRequest) => Promise<void>;
  onClose: () => void;
}) {
  const pr = openPr(overview);
  const [base, setBase] = useState(overview.suggestedBase ?? overview.defaultBranch ?? "");
  const [branches, setBranches] = useState<string[]>([]);
  const [title, setTitle] = useState(update && pr ? pr.title : "");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const branch = overview.status.branch;

  useEffect(() => {
    if (update) return;
    let live = true;
    bridge.remoteBranches(refId).then(
      (list) => live && setBranches(list.filter((name) => name !== branch)),
      () => undefined, // The suggested base still works without the list.
    );
    return () => void (live = false);
  }, [bridge, refId, update, branch]);

  const needsPush = !overview.upstream || overview.status.ahead > 0;
  const submit = () => {
    setBusy(true);
    setError(null);
    const text = { title: title.trim() || undefined, body: body.trim() || undefined };
    onRun(
      update
        ? { action: "updatePr", pr: text }
        : {
            action: needsPush ? "pushPr" : "createPr",
            pr: { ...text, draft, base: base || undefined },
          },
    ).then(
      () => setBusy(false),
      (cause: unknown) => {
        setError(errorMessage(cause));
        setBusy(false);
      },
    );
  };
  const options = [...new Set([base, ...branches].filter(Boolean))];
  const stacked = base && base !== overview.defaultBranch;

  return (
    <Modal
      title={update && pr ? `Update PR #${pr.number}` : "Create pull request"}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" disabled={busy} onClick={onClose} className={QUIET}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || (!update && !base)}
            onClick={submit}
            className={PRIMARY}
          >
            {busy
              ? "Working…"
              : update
                ? "Push & update PR"
                : `${needsPush ? "Push & create" : "Create"}${draft ? " draft" : ""} PR`}
          </button>
        </>
      }
    >
      {!update && (
        <div>
          <label htmlFor="pr-base" className={LABEL}>
            Merge <span className="text-neutral-200">{branch}</span> into
          </label>
          <select
            id="pr-base"
            value={base}
            onChange={(event) => setBase(event.target.value)}
            className={`${FIELD} h-8`}
          >
            {options.map((name) => (
              <option key={name} value={name}>
                {name}
                {name === overview.defaultBranch ? " (default)" : ""}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-neutral-500">
            {stacked
              ? `Stacked on ${base}: the PR shows only this branch's commits on top of it.`
              : "Pick another feature branch to stack this PR on it."}
          </p>
        </div>
      )}
      <div>
        <div className="flex items-end justify-between">
          <label htmlFor="pr-title" className={LABEL}>
            Title
          </label>
          <GenerateButton
            disabled={busy}
            generate={() =>
              bridge.generate(refId, { kind: "pr", base: update ? undefined : base || undefined })
            }
            onText={(nextTitle, nextBody, why) => {
              if (nextTitle) setTitle(nextTitle);
              if (nextBody) setBody(nextBody);
              setNote(why);
            }}
          />
        </div>
        <input
          id="pr-title"
          value={title}
          autoFocus
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Leave empty to have AI write it"
          className={`${FIELD} h-8`}
        />
      </div>
      <div>
        <label htmlFor="pr-body" className={LABEL}>
          Description
        </label>
        <textarea
          id="pr-body"
          rows={7}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={
            update ? "Leave empty to have AI rewrite it" : "Leave empty to have AI write it"
          }
          className={`${FIELD} resize-y py-2 font-mono text-xs/5`}
        />
        {note && <p className="mt-1 text-xs text-neutral-500">{note}</p>}
      </div>
      {!update && (
        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={draft}
            onChange={(event) => setDraft(event.target.checked)}
            className="accent-white"
          />
          Open as a draft
        </label>
      )}
      <ErrorText message={error} />
    </Modal>
  );
}

export function PublishDialog({
  defaultName,
  hasCommits,
  onPublish,
  onClose,
}: {
  defaultName: string;
  hasCommits: boolean;
  onPublish: (name: string, visibility: "private" | "public") => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(defaultName.replace(/[^A-Za-z0-9._-]+/g, "-"));
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(name.trim());
  return (
    <Modal
      title="Publish to GitHub"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" disabled={busy} onClick={onClose} className={QUIET}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !valid}
            onClick={() => {
              setBusy(true);
              setError(null);
              onPublish(name.trim(), visibility).catch((cause: unknown) => {
                setError(errorMessage(cause));
                setBusy(false);
              });
            }}
            className={PRIMARY}
          >
            {busy ? "Publishing…" : "Publish"}
          </button>
        </>
      }
    >
      <p className="text-xs/5 text-neutral-500">
        Creates the repository with your GitHub CLI sign-in, adds it as <code>origin</code>
        {hasCommits ? ", and pushes this branch." : ". Commit something to push it."}
      </p>
      <div>
        <label htmlFor="publish-name" className={LABEL}>
          Repository
        </label>
        <input
          id="publish-name"
          value={name}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          aria-invalid={!valid}
          className={`${FIELD} h-8`}
        />
        <p className="mt-1 text-xs text-neutral-500">
          “name”, or “owner/name” for an organization.
        </p>
      </div>
      <fieldset className="flex gap-4 text-sm">
        <legend className={LABEL}>Visibility</legend>
        {(["private", "public"] as const).map((value) => (
          <label key={value} className="flex items-center gap-2 text-neutral-300 capitalize">
            <input
              type="radio"
              name="publish-visibility"
              checked={visibility === value}
              onChange={() => setVisibility(value)}
              className="accent-white"
            />
            {value}
          </label>
        ))}
      </fieldset>
      <ErrorText message={error} />
    </Modal>
  );
}

/** Before pushing straight to the default branch: go ahead, move the work to a branch, or stop. */
export function DefaultBranchDialog({
  branch,
  canBranch,
  onPush,
  onBranch,
  onClose,
}: {
  branch: string;
  /** There are changes to commit, so they can go on a new branch instead. */
  canBranch: boolean;
  onPush: () => void;
  onBranch: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={`Push to ${branch}?`}
      busy={false}
      onClose={onClose}
      footer={
        <>
          <button type="button" autoFocus onClick={onClose} className={QUIET}>
            Cancel
          </button>
          <button type="button" onClick={onPush} className={SECONDARY}>
            Push to {branch}
          </button>
          {canBranch && (
            <button type="button" onClick={onBranch} className={PRIMARY}>
              Commit on a new branch…
            </button>
          )}
        </>
      }
    >
      <p className="text-xs/5 text-neutral-400">
        <span className="text-neutral-200">{branch}</span> is the repository&apos;s default branch.
        Pushing there skips review. A new branch keeps it untouched and can become a pull request.
      </p>
    </Modal>
  );
}
