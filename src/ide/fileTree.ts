// ── Types ───────────────────────────────────────────────────────────────────

export type LangId = "python" | "markdown" | "json" | "typescript" | "tsx" | "css" | "yaml" | "toml" | "shell" | "text"

export type FileNode = {
  id: string // path-style: "bonafide-train/src/train.py"

  name: string // display: "train.py"

  kind: "folder" | "file"

  parentId: string | null // null = workspace root

  expanded?: boolean // folders only

  fileType: LangId

  content?: string // files only; populated when opened
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Map a file extension (including leading dot) to a LangId. */

export function extToLangId(name: string): LangId {
  const lower = name.toLowerCase()

  if (lower.endsWith(".py")) return "python"

  if (lower.endsWith(".md") || lower === "readme") return "markdown"

  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "json"

  if (lower.endsWith(".ts")) return "typescript"

  if (lower.endsWith(".tsx")) return "tsx"

  if (
    lower.endsWith(".css") ||
    lower.endsWith(".scss") ||
    lower.endsWith(".less")
  )
    return "css"

  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml"

  if (lower.endsWith(".toml")) return "toml"

  if (
    lower.endsWith(".sh") ||
    lower.endsWith(".bash") ||
    lower.endsWith(".zsh")
  )
    return "shell"

  return "text"
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
): { tree: FileNode[] file: FileNode } {
  const id = parentId ? `${parentId}/${name}` : name

  const file: FileNode = {
    id,

    name,

    kind: "file",

    parentId,

    fileType: extToLangId(name),

    content,
  }

  return { tree: [...tree, file], file }
}

/**
 * Create a new folder node.
 * Returns { tree, folder }.
 */

export function createFolder(
  tree: FileNode[],

  parentId: string | null,

  name: string,
): { tree: FileNode[] folder: FileNode } {
  const id = parentId ? `${parentId}/${name}` : name

  const folder: FileNode = {
    id,

    name,

    kind: "folder",

    parentId,

    expanded: true,

    fileType: "text",
  }

  return { tree: [...tree, folder], folder }
}

export type RenameResult = { ok: true tree: FileNode[] node: FileNode } | {
  ok: false
  reason: "exists" | "invalid"
}

/** Rename a node. Rejects if newName collides with a sibling. */

export function renameNode(
  tree: FileNode[],

  nodeId: string,

  newName: string,
): RenameResult {
  if (!newName.trim() || newName.includes("/") || newName.includes("\\")) {
    return { ok: false, reason: "invalid" }
  }

  const node = tree.find((n) => n.id === nodeId)

  if (!node) return { ok: false, reason: "invalid" }

  // Check sibling collision (same parent, different id)

  const siblings = tree.filter(
    (n) => n.parentId === node.parentId && n.id !== nodeId,
  )

  if (siblings.some((n) => n.name.toLowerCase() === newName.toLowerCase())) {
    return { ok: false, reason: "exists" }
  }

  const newId = node.parentId ? `${node.parentId}/${newName}` : newName

  // If renaming a folder, also update all child ids

  function updateId(n: FileNode): FileNode {
    if (n.id === nodeId) {
      return { ...n, name: newName, id: newId }
    }

    if (n.parentId === nodeId) {
      return { ...n, id: `${newId}/${n.name}`, parentId: newId }
    }

    return n
  }

  return {
    ok: true,
    tree: tree.map(updateId),
    node: { ...node, name: newName, id: newId },
  }
}

/** Delete a node and all its descendants. Returns the removed nodes. */

export function deleteNode(tree: FileNode[], nodeId: string): {
  tree: FileNode[]

  removed: FileNode[]
} {
  // Collect all ids to remove (the node + all its descendants)

  const toRemove = new Set<string>()

  function collectDescendants(id: string) {
    toRemove.add(id)

    tree

      .filter((n) => n.parentId === id)

      .forEach((n) => collectDescendants(n.id))
  }

  collectDescendants(nodeId)

  return {
    tree: tree.filter((n) => !toRemove.has(n.id)),

    removed: tree.filter((n) => toRemove.has(n.id)),
  }
}

/** Find a node by predicate. */

export function findNode(
  tree: FileNode[],
  predicate: (n: FileNode) => boolean,
): FileNode | null {
  return tree.find(predicate) ?? null
}

/** Find a node by path segments (last segment is the name). */

export function findNodeByPath(
  tree: FileNode[],
  segments: string[],
): FileNode | null {
  if (segments.length === 0) return null

  const name = segments[segments.length - 1]

  const parentId = segments.length > 1 ? segments.slice(0, -1).join("/") : null

  return tree.find((n) => n.name === name && n.parentId === parentId) ?? null
}

/**
 * Build a parentId → children[] index over a flat file tree. O(N).
 *
 * Used by `walkVisible` to turn the inner per-node `tree.filter()` from
 * O(N) into an O(1) Map lookup. Without this, walking a 2 000-file tree
 * was O(N × D) where D is depth (≈ 4 million comparisons per render);
 * with the index it's O(N) (≈ 2 000 comparisons).
 *
 * The index is built fresh on each call — call sites that render on every
 * dispatch should memoize it (see `useTreeIndex` in `Sidebar.tsx`).
 */

export function buildTreeIndex(
  tree: FileNode[],
): {
  childrenByParent: Map<string | null, FileNode[]>

  byId: Map<string, FileNode>
} {
  const childrenByParent = new Map<string | null, FileNode[]>()

  const byId = new Map<string, FileNode>()

  for (const node of tree) {
    byId.set(node.id, node)

    const bucket = childrenByParent.get(node.parentId)

    if (bucket) bucket.push(node)
    else childrenByParent.set(node.parentId, [node])
  }

  return { childrenByParent, byId }
}

/** Walk visible nodes in depth-first order, yielding node + depth. */

export function* walkVisible(
  tree: FileNode[],

  collapsed: Record<string, boolean>,
): Generator<{ node: FileNode depth: number }> {
  const { childrenByParent } = buildTreeIndex(tree)

  const roots = childrenByParent.get(null) ?? []

  for (const root of roots) {
    yield* walkFrom(root, 0, collapsed, childrenByParent)
  }
}

function* walkFrom(
  node: FileNode,

  depth: number,

  collapsed: Record<string, boolean>,

  childrenByParent: Map<string | null, FileNode[]>,
): Generator<{ node: FileNode depth: number }> {
  yield { node, depth }

  // Only check the `collapsed` map. The `node.expanded` field on FileNode

  // was being set to `false` on load (from the Rust walker's `expanded`

  // field) and then `TOGGLE_COLLAPSE` was also writing `collapsed[nodeId]`

  // — so the condition ended up as `node.expanded && !collapsed[nodeId]`

  // which evaluated to `false && !true = false` on the very first click,

  // making every folder appear permanently collapsed.

  if (node.kind === "folder" && !collapsed[node.id]) {
    const children = childrenByParent.get(node.id) ?? []

    for (const child of children) {
      yield* walkFrom(child, depth + 1, collapsed, childrenByParent)
    }
  }
}

/**
 * Same as `walkVisible`, but skips rebuilding the parent → children index
 * when the caller already has one. This is the hot path used by the
 * Explorer view: the index is built once per tree change, then walks
 * across every dispatch are pure O(visibleNodes).
 */

export function* walkVisibleIndexed(
  childrenByParent: Map<string | null, FileNode[]>,

  collapsed: Record<string, boolean>,
): Generator<{ node: FileNode depth: number }> {
  const roots = childrenByParent.get(null) ?? []

  for (const root of roots) {
    yield* walkFromIndexed(root, 0, collapsed, childrenByParent)
  }
}

function* walkFromIndexed(
  node: FileNode,

  depth: number,

  collapsed: Record<string, boolean>,

  childrenByParent: Map<string | null, FileNode[]>,
): Generator<{ node: FileNode depth: number }> {
  yield { node, depth }

  if (node.kind === "folder" && !collapsed[node.id]) {
    const children = childrenByParent.get(node.id) ?? []

    for (const child of children) {
      yield* walkFromIndexed(child, depth + 1, collapsed, childrenByParent)
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
  const visible = [...walkVisible(tree, collapsed)]

  if (visible.length === 0) return null

  if (currentId === null) return visible[0].node.id

  const idx = visible.findIndex((v) => v.node.id === currentId)

  const next = idx + delta

  if (next < 0) return visible[0].node.id

  if (next >= visible.length) return visible[visible.length - 1].node.id

  return visible[next].node.id
}

/**
 * Like `moveFocus`, but skips rebuilding the parent → children index.
 * Pass `childrenByParent` from `buildTreeIndex(tree)`. Used by the
 * keyboard handler in the Explorer, which already has a memoized index.
 */

export function moveFocusIndexed(
  childrenByParent: Map<string | null, FileNode[]>,

  currentId: string | null,

  delta: -1 | 1,

  collapsed: Record<string, boolean>,
): string | null {
  const visible = [...walkVisibleIndexed(childrenByParent, collapsed)]

  if (visible.length === 0) return null

  if (currentId === null) return visible[0].node.id

  const idx = visible.findIndex((v) => v.node.id === currentId)

  const next = idx + delta

  if (next < 0) return visible[0].node.id

  if (next >= visible.length) return visible[visible.length - 1].node.id

  return visible[next].node.id
}

/** Count descendants of a folder node. */

export function countDescendants(tree: FileNode[], nodeId: string): number {
  return tree.filter((n) => {
    let current = n

    while (current.parentId !== null) {
      if (current.parentId === nodeId) return true

      const parent = tree.find((p) => p.id === current.parentId)

      if (!parent) break

      current = parent
    }

    return false
  }).length
}

/**
 * Like `countDescendants`, but uses the precomputed parent → children
 * index. O(N) instead of the O(N × D) walk that the version above does
 * for every descendant (each `tree.find` is a linear scan). On a 2 000-
 * node tree this turns ~4 million operations into ~2 000.
 */

export function countDescendantsIndexed(
  childrenByParent: Map<string | null, FileNode[]>,

  nodeId: string,
): number {
  let count = 0

  const queue: string[] = [nodeId]

  while (queue.length > 0) {
    const id = queue.pop()!

    const children = childrenByParent.get(id)

    if (!children) continue

    for (const child of children) {
      count++

      queue.push(child.id)
    }
  }

  return count - 1 // subtract the node itself
}

/** Get parent of a node. */

export function getParent(tree: FileNode[], node: FileNode): FileNode | null {
  if (node.parentId === null) return null

  return tree.find((n) => n.id === node.parentId) ?? null
}

/** Toggle a folder's expanded state. */

export function toggleCollapse(tree: FileNode[], nodeId: string): FileNode[] {
  return tree.map((n) =>
    n.id === nodeId && n.kind === "folder"
      ? { ...n, expanded: !n.expanded }
      : n,
  )
}

/** Collapse all folders. */

export function collapseAll(tree: FileNode[]): FileNode[] {
  return tree.map((n) => (n.kind === "folder" ? { ...n, expanded: false } : n))
}

/** Expand all folders. */

export function expandAll(tree: FileNode[]): FileNode[] {
  return tree.map((n) => (n.kind === "folder" ? { ...n, expanded: true } : n))
}

/** Check if a name already exists as a sibling of parentId. */

export function nameExists(
  tree: FileNode[],
  parentId: string | null,
  name: string,
): boolean {
  return tree.some(
    (n) =>
      n.parentId === parentId && n.name.toLowerCase() === name.toLowerCase(),
  )
}

/**
 * Apply a batch of file-system events to a tree, returning a new tree.
 *
 * Used by the real-time file watcher (`APPLY_FS_EVENTS` reducer action).
 * The Rust watcher debounces bursts of events (git checkout, bulk
 * rename, etc.) into a single batch which we apply atomically here so
 * the tree never sees intermediate states.
 *
 * Path semantics: each event's `path` is the relative path from the
 * workspace root (e.g. `src/foo.py`), which is the same format used
 * for `FileNode.id` in this codebase. No prefix stripping required.
 *
 * What we do for each event type:
 *   - `created`: insert a new FileNode with `fileType` derived from the
 *     file extension (matches `extToLangId`). For folders, also ensure
 *     any parent folders exist (defensive — they should already).
 *   - `modified`: no-op for the tree (we don't track mtime in FileNode).
 *     The editor's `SET_CONTENT` action is what reflects edits — the
 *     watcher is only for *external* changes (git pull, build output,
 *     user editing in another app).
 *   - `removed`: run the existing `deleteNode` to remove the node and
 *     all its descendants. If the removed file had an open tab, the
 *     caller is responsible for closing it (the reducer handles this).
 */

export type FsEventForTree = {
  type: "created"
  path: string
  is_dir: boolean
} | { type: "modified" path: string } | { type: "removed" path: string }

export function applyFsEvents(
  tree: FileNode[],
  events: FsEventForTree[],
): FileNode[] {
  let next = tree

  for (const event of events) {
    if (event.type === "created") {
      next = applyCreate(next, event.path, event.is_dir)
    } else if (event.type === "removed") {
      next = applyRemove(next, event.path)
    }

    // "modified" is a no-op — the editor already tracks live edits via

    // SET_CONTENT. The watcher only fires for external writes.
  }

  return next
}

function parentIdFor(path: string): string | null {
  const idx = path.lastIndexOf("/")

  if (idx < 0) return null

  return path.slice(0, idx)
}

function nameFor(path: string): string {
  const idx = path.lastIndexOf("/")

  if (idx < 0) return path

  return path.slice(idx + 1)
}

function applyCreate(
  tree: FileNode[],
  relPath: string,
  isDir: boolean,
): FileNode[] {
  // Skip if already present (idempotent — Rust watcher may double-fire

  // on some platforms like macOS FSEvents).

  if (tree.some((n) => n.id === relPath)) return tree

  // Ensure all parent folders exist. They should already be there from

  // the initial `read_directory`, but a deleted-and-recreated folder

  // hierarchy could arrive in any order.

  let withParents = tree

  let cursor = parentIdFor(relPath)

  while (cursor !== null) {
    const parentName = nameFor(cursor)

    const parentPath = cursor

    if (withParents.some((n) => n.id === parentPath)) break

    withParents = [
      ...withParents,

      {
        id: parentPath,

        name: parentName,

        kind: "folder",

        parentId: parentIdFor(parentPath),

        expanded: true,

        fileType: "text",
      },
    ]

    cursor = parentIdFor(parentPath)
  }

  const name = nameFor(relPath)

  return [
    ...withParents,

    {
      id: relPath,

      name,

      kind: isDir ? "folder" : "file",

      parentId: parentIdFor(relPath),

      expanded: isDir ? true : undefined,

      fileType: isDir ? "text" : extToLangId(name),
    },
  ]
}

function applyRemove(tree: FileNode[], relPath: string): FileNode[] {
  // Reuse the existing deleteNode helper — it already handles removing

  // the node and all descendants, plus collecting the removed ids.

  const { tree: next } = deleteNode(tree, relPath)

  return next
}

/**
 * Extract the set of removed file ids from a batch of events. Used by
 * the reducer to close any open tabs whose underlying file was deleted
 * on disk.
 */

export function removedFileIds(events: FsEventForTree[]): Set<string> {
  const ids = new Set<string>()

  for (const event of events) {
    if (event.type === "removed") ids.add(event.path)
  }

  return ids
}
