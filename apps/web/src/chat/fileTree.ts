// A turn's changed files as a folder tree, with each folder's line counts rolled up.
import type { FileChange } from "@rook/contracts";

export type TreeNode =
  /** `name` may hold several segments when single-folder chains compress (`apps/web/src`). */
  | {
      readonly kind: "folder";
      readonly name: string;
      readonly path: string;
      readonly additions: number;
      readonly deletions: number;
      readonly children: readonly TreeNode[];
    }
  | { readonly kind: "file"; readonly name: string; readonly file: FileChange };

interface Draft {
  folders: Map<string, Draft>;
  files: FileChange[];
}

/** Folders first, then files, each by name; folders that hold only one folder merge into it. */
export function buildTree(files: readonly FileChange[]): TreeNode[] {
  const root: Draft = { folders: new Map(), files: [] };
  for (const file of files) {
    const segments = file.path.split("/");
    let at = root;
    for (const segment of segments.slice(0, -1)) {
      let next = at.folders.get(segment);
      if (!next) at.folders.set(segment, (next = { folders: new Map(), files: [] }));
      at = next;
    }
    at.files.push(file);
  }
  return toNodes(root, "");
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

function toNodes(draft: Draft, prefix: string): TreeNode[] {
  const folders = [...draft.folders].map(([segment, child]) => {
    let name = segment;
    let inner = child;
    while (inner.files.length === 0 && inner.folders.size === 1) {
      const [next, only] = [...inner.folders][0]!;
      name += `/${next}`;
      inner = only;
    }
    const path = prefix + name;
    const children = toNodes(inner, `${path}/`);
    const sum = (key: "additions" | "deletions") =>
      children.reduce(
        (total, node) => total + (node.kind === "folder" ? node[key] : (node.file[key] ?? 0)),
        0,
      );
    return {
      kind: "folder" as const,
      name,
      path,
      additions: sum("additions"),
      deletions: sum("deletions"),
      children,
    };
  });
  const files = draft.files.map((file) => ({
    kind: "file" as const,
    name: file.path.slice(file.path.lastIndexOf("/") + 1),
    file,
  }));
  return [...folders.toSorted(byName), ...files.toSorted(byName)];
}

/** Every folder's path, at any depth. */
export function folderPaths(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "folder" ? [node.path, ...folderPaths(node.children)] : [],
  );
}

/** Past this many files, folders deeper than two levels start collapsed. */
const LARGE = 30;

/** The folders that start collapsed: none for a small change, the deep ones for a large one. */
export function initiallyCollapsed(nodes: readonly TreeNode[], fileCount: number): Set<string> {
  const collapsed = new Set<string>();
  if (fileCount <= LARGE) return collapsed;
  const walk = (level: readonly TreeNode[], depth: number) => {
    for (const node of level) {
      if (node.kind !== "folder") continue;
      if (depth >= 2) collapsed.add(node.path);
      walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return collapsed;
}
