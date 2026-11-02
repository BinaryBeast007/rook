// The Commit button's main-process half. The renderer names a workspace (a chat or a project);
// its folder is resolved here and every request is checked by the engine.
import { GitChannel, type GitPhase, type GitProgress } from "@rook/contracts";

import type { Handle, WorkspaceContext } from "../workspace/context.ts";
import { gitActions } from "./actions.ts";

export function registerGitHandlers(
  context: WorkspaceContext,
  handle: Handle,
): { dispose(): void } {
  const git = gitActions({ env: () => context.env(), busy: (cwd) => context.busy(cwd) });
  const progress = (ref: unknown) => (phase: GitPhase) =>
    context.send(GitChannel.progress, { ref: String(ref), phase } satisfies GitProgress);
  handle(GitChannel.overview, (_event, ref) => git.overview(context.cwd(ref)));
  handle(GitChannel.init, (_event, ref) => git.init(context.cwd(ref)));
  handle(GitChannel.generate, (_event, ref, request) => git.generate(context.cwd(ref), request));
  handle(GitChannel.run, (_event, ref, request) =>
    git.run(context.cwd(ref), request, progress(ref)),
  );
  handle(GitChannel.publish, (_event, ref, request) =>
    git.publish(context.cwd(ref), request, progress(ref)),
  );
  handle(GitChannel.remoteBranches, (_event, ref) => git.remoteBranches(context.cwd(ref)));
  // Nothing long-lived: each action's processes end with it.
  return { dispose() {} };
}
