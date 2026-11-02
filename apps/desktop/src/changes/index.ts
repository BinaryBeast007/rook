// The Changes side tool's main-process half: git status, diffs, staging, discards and history
// for a chat's folder. The renderer names a chat; its folder and every path are checked here.
import { ChangesChannel } from "@rook/contracts";

import type { Handle, WorkspaceContext } from "../workspace/context.ts";
import { changesGit } from "./git.ts";

export function registerChangesHandlers(context: WorkspaceContext, handle: Handle): void {
  const git = changesGit(context.env, (cwd) => context.busy(cwd));
  handle(ChangesChannel.status, (_event, chatId) => git.status(context.cwd(chatId)));
  handle(ChangesChannel.diff, (_event, chatId, path, staged) =>
    git.diff(context.cwd(chatId), path, staged === true),
  );
  handle(ChangesChannel.stage, (_event, chatId, paths) => git.stage(context.cwd(chatId), paths));
  handle(ChangesChannel.unstage, (_event, chatId, paths) =>
    git.unstage(context.cwd(chatId), paths),
  );
  handle(ChangesChannel.discard, (_event, chatId, paths) =>
    git.discard(context.cwd(chatId), paths),
  );
  handle(ChangesChannel.log, (_event, chatId, page) => git.log(context.cwd(chatId), page));
  handle(ChangesChannel.commitFiles, (_event, chatId, sha) =>
    git.commitFiles(context.cwd(chatId), sha),
  );
  handle(ChangesChannel.commitDiff, (_event, chatId, sha, path) =>
    git.commitDiff(context.cwd(chatId), sha, path),
  );
  handle(ChangesChannel.rangeFiles, (_event, chatId, from, to) =>
    git.rangeFiles(context.cwd(chatId), from, to),
  );
  handle(ChangesChannel.rangeDiff, (_event, chatId, from, to, path) =>
    git.rangeDiff(context.cwd(chatId), from, to, path),
  );
}
