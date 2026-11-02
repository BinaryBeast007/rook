// The one gate between a renderer-supplied relative path and the filesystem. Every side tool
// resolves paths through `resolveInside`, so none can reach outside the chat's folder.
import { realpathSync } from "node:fs";
import * as NodePath from "node:path";

import { ChatRuntimeError } from "../chat/runtime.ts";

const MAX_PATH = 4096;

const isInside = (root: string, path: string) => {
  const relative = NodePath.relative(root, path);
  const up = relative === ".." || relative.startsWith(`..${NodePath.sep}`);
  return relative === "" || (!up && !NodePath.isAbsolute(relative));
};

/** The real path of `path`, or of its nearest existing ancestor joined with the rest. */
function realish(path: string): string {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return NodePath.join(realpathSync.native(current), ...rest.toReversed());
    } catch {
      const parent = NodePath.dirname(current);
      if (parent === current) return path;
      rest.push(NodePath.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves `relative` (`/`- or `\`-separated, `""` for the root) inside `root`. Rejects absolute
 * paths, `..` escapes, NUL bytes, and symlinks (anywhere along the path) that lead outside.
 * Returns the absolute path and its normalized `/`-separated relative form.
 */
export function resolveInside(root: string, relative: unknown): { abs: string; rel: string } {
  if (typeof relative !== "string" || relative.length > MAX_PATH || relative.includes("\0"))
    throw new ChatRuntimeError("That path is not valid.");
  const parts = relative.split(/[\\/]+/).filter((part) => part && part !== ".");
  if (/^[a-z]:/i.test(relative) || relative.startsWith("/") || relative.startsWith("\\"))
    throw new ChatRuntimeError("That path is outside this folder.");
  const abs = NodePath.resolve(root, ...parts);
  if (!isInside(root, abs) || !isInside(realish(root), realish(abs)))
    throw new ChatRuntimeError("That path is outside this folder.");
  return { abs, rel: NodePath.relative(root, abs).split(NodePath.sep).join("/") };
}

/** A path under `root` as the renderer sees it: relative and `/`-separated. */
export function toRelative(root: string, abs: string): string {
  return NodePath.relative(root, abs).split(NodePath.sep).join("/");
}
