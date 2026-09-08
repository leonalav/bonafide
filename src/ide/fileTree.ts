// ── Types ───────────────────────────────────────────────────────────────────

export type LangId =
  | "python"
  | "markdown"
  | "json"
  | "typescript"
  | "tsx"
  | "css"
  | "yaml"
  | "toml"
  | "shell"
  | "text";

export type FileNode = {
  id: string; // path-style: "bonafide-train/src/train.py"
  name: string; // display: "train.py"
  kind: "folder" | "file";
  parentId: string | null; // null = workspace root
  expanded?: boolean; // folders only
  fileType: LangId;
  content?: string; // files only; populated when opened
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Map a file extension (including leading dot) to a LangId. */
export function extToLangId(name: string): LangId {
  const lower = name.toLowerCase();
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".md") || lower === "readme") return "markdown";
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "json";
  if (lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".less")) return "css";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "shell";
  return "text";
}

// ── Pure operations ─────────────────────────────────────────────────────────

/**
 * Create a new file node.
 * Returns { tree, file } where tree is a new array and file is the created node.
 * Does NOT add it to any tab or open it — callers handle that.
 */
export function createFile(
  tree: FileNode[],
  parentId: string | null,
  name: string,
  content?: string,
): { tree: FileNode[]; file: FileNode } {
  const id = parentId ? `${parentId}/${name}` : name;
  const file: FileNode = {
    id,
    name,
    kind: "file",
    parentId,
    fileType: extToLangId(name),
    content,
  };
  return { tree: [...tree, file], file };
}

/**
 * Create a new folder node.
 * Returns { tree, folder }.
 */
export function createFolder(
  tree: FileNode[],
  parentId: string | null,
  name: string,
): { tree: FileNode[]; folder: FileNode } {
  const id = parentId ? `${parentId}/${name}` : name;
  const folder: FileNode = {
    id,
    name,
    kind: "folder",
    parentId,
    expanded: true,
    fileType: "text",
  };
  return { tree: [...tree, folder], folder };
}

export type RenameResult =
  | { ok: true; tree: FileNode[]; node: FileNode }
  | { ok: false; reason: "exists" | "invalid" };

/** Rename a node. Rejects if newName collides with a sibling. */
export function renameNode(
  tree: FileNode[],
  nodeId: string,
  newName: string,
): RenameResult {
  if (!newName.trim() || newName.includes("/") || newName.includes("\\")) {
    return { ok: false, reason: "invalid" };
  }

  const node = tree.find((n) => n.id === nodeId);
  if (!node) return { ok: false, reason: "invalid" };

  // Check sibling collision (same parent, different id)
  const siblings = tree.filter(
    (n) => n.parentId === node.parentId && n.id !== nodeId,
  );
  if (siblings.some((n) => n.name.toLowerCase() === newName.toLowerCase())) {
    return { ok: false, reason: "exists" };
  }

  const newId = node.parentId ? `${node.parentId}/${newName}` : newName;

  // If renaming a folder, also update all child ids
  function updateId(n: FileNode): FileNode {
    if (n.id === nodeId) {
      return { ...n, name: newName, id: newId };
    }
    if (n.parentId === nodeId) {
      return { ...n, id: `${newId}/${n.name}`, parentId: newId };
    }
    return n;
  }

  return { ok: true, tree: tree.map(updateId), node: { ...node, name: newName, id: newId } };
}

/** Delete a node and all its descendants. Returns the removed nodes. */
export function deleteNode(tree: FileNode[], nodeId: string): {
  tree: FileNode[];
  removed: FileNode[];
} {
  // Collect all ids to remove (the node + all its descendants)
  const toRemove = new Set<string>();

  function collectDescendants(id: string) {
    toRemove.add(id);
    tree
      .filter((n) => n.parentId === id)
      .forEach((n) => collectDescendants(n.id));
  }
  collectDescendants(nodeId);

  return {
    tree: tree.filter((n) => !toRemove.has(n.id)),
    removed: tree.filter((n) => toRemove.has(n.id)),
  };
}

/** Find a node by predicate. */
export function findNode(tree: FileNode[], predicate: (n: FileNode) => boolean): FileNode | null {
  return tree.find(predicate) ?? null;
}

/** Find a node by path segments (last segment is the name). */
export function findNodeByPath(tree: FileNode[], segments: string[]): FileNode | null {
  if (segments.length === 0) return null;
  const name = segments[segments.length - 1];
  const parentId = segments.length > 1
    ? segments.slice(0, -1).join("/")
    : null;
  return tree.find((n) => n.name === name && n.parentId === parentId) ?? null;
}

/** Walk visible nodes in depth-first order, yielding node + depth. */
export function* walkVisible(
  tree: FileNode[],
  collapsed: Record<string, boolean>,
): Generator<{ node: FileNode; depth: number }> {
  // Root nodes: parentId === null
  const roots = tree.filter((n) => n.parentId === null);
  for (const root of roots) {
    yield* walkFrom(root, 0, tree, collapsed);
  }
}

function* walkFrom(
  node: FileNode,
  depth: number,
  tree: FileNode[],
  collapsed: Record<string, boolean>,
): Generator<{ node: FileNode; depth: number }> {
  yield { node, depth };
  // Only check the `collapsed` map. The `node.expanded` field on FileNode
  // was being set to `false` on load (from the Rust walker's `expanded`
  // field) and then `TOGGLE_COLLAPSE` was also writing `collapsed[nodeId]`
  // — so the condition ended up as `node.expanded && !collapsed[nodeId]`
  // which evaluated to `false && !true = false` on the very first click,
  // making every folder appear permanently collapsed.
  if (node.kind === "folder" && !collapsed[node.id]) {
    const children = tree.filter((n) => n.parentId === node.id);
    for (const child of children) {
      yield* walkFrom(child, depth + 1, tree, collapsed);
    }
  }
}

/** Move keyboard focus to the next/prev visible node. Returns the new focused id or null. */
export function moveFocus(
  tree: FileNode[],
  currentId: string | null,
  delta: -1 | 1,
  collapsed: Record<string, boolean>,
): string | null {
  const visible = [...walkVisible(tree, collapsed)];
  if (visible.length === 0) return null;

  if (currentId === null) return visible[0].node.id;

  const idx = visible.findIndex((v) => v.node.id === currentId);
  const next = idx + delta;

  if (next < 0) return visible[0].node.id;
  if (next >= visible.length) return visible[visible.length - 1].node.id;

  return visible[next].node.id;
}

/** Count descendants of a folder node. */
export function countDescendants(tree: FileNode[], nodeId: string): number {
  return tree.filter((n) => {
    let current = n;
    while (current.parentId !== null) {
      if (current.parentId === nodeId) return true;
      const parent = tree.find((p) => p.id === current.parentId);
      if (!parent) break;
      current = parent;
    }
    return false;
  }).length;
}

/** Get parent of a node. */
export function getParent(tree: FileNode[], node: FileNode): FileNode | null {
  if (node.parentId === null) return null;
  return tree.find((n) => n.id === node.parentId) ?? null;
}

/** Toggle a folder's expanded state. */
export function toggleCollapse(tree: FileNode[], nodeId: string): FileNode[] {
  return tree.map((n) =>
    n.id === nodeId && n.kind === "folder" ? { ...n, expanded: !n.expanded } : n,
  );
}

/** Collapse all folders. */
export function collapseAll(tree: FileNode[]): FileNode[] {
  return tree.map((n) => (n.kind === "folder" ? { ...n, expanded: false } : n));
}

/** Expand all folders. */
export function expandAll(tree: FileNode[]): FileNode[] {
  return tree.map((n) => (n.kind === "folder" ? { ...n, expanded: true } : n));
}

/** Check if a name already exists as a sibling of parentId. */
export function nameExists(tree: FileNode[], parentId: string | null, name: string): boolean {
  return tree.some(
    (n) => n.parentId === parentId && n.name.toLowerCase() === name.toLowerCase(),
  );
}
