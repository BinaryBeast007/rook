// Opening what a conversation points at: a file at a line, or a diff, in the workspace's side
// tools. The workspace provides the handler; chat surfaces only describe the target.
import { createContext } from "react";

export type InspectTarget =
  /** A file in the chat's folder (relative, `/`-separated), optionally scrolled to a 1-based line. */
  | { readonly kind: "file"; readonly path: string; readonly line?: number }
  /** The folder's uncommitted changes, optionally opened at one file. */
  | { readonly kind: "worktree"; readonly path?: string }
  /**
   * What one turn changed: the checkpoints of a `changes` part, optionally opened at one file.
   * `label` names the range in the diff view, e.g. "This turn".
   */
  | {
      readonly kind: "range";
      readonly from: string;
      readonly to: string;
      readonly path?: string;
      readonly label: string;
    };

/**
 * Opens a target in the workspace of the chat `chatId`. The default does nothing, for surfaces
 * rendered outside a workspace (tests, previews).
 */
export const Inspect = createContext<(chatId: string, target: InspectTarget) => void>(
  () => undefined,
);
