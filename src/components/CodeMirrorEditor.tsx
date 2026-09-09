/**
 * CodeMirrorEditor.tsx — Bonafide's source code editor.
 *
 * Built on CodeMirror 6 (the same engine that powers Replit's editor and
 * powers much of the modern web). Replaces the previous Monaco-based
 * MonacoEditor.tsx.
 *
 * Feature integrations:
 *   - @codemirror/autocomplete + commands + search — baseline editing.
 *   - @codemirror/lint + @codemirror/lang-python — diagnostics surface.
 *   - @marimo-team/codemirror-languageserver — LSP client that connects
 *     over WebSocket to the Rust bridge, which spawns pyright-langserver
 *     and ruff server child processes for Python IntelliSense.
 *   - Custom domain diagnostics (see src/ide/diagnostics.ts) for things
 *     like "MLflow run reference doesn't exist".
 *
 * Wiring:
 *   - The Bonafide theme is a single extension exported from
 *     `src/ide/cm-theme.ts` (editor chrome + syntax highlight style +
 *     diagnostics + merge + hover styles).
 *   - Per-file content sync is handled by `<CodeMirror value={...}>`
 *     seeding the doc exactly once per fileId, then letting CodeMirror
 *     own the document until the file is closed or replaced.
 *   - Ctrl/Cmd+S → onSave, wired via `@codemirror/commands` keymap.
 *   - Right-click context menu is intercepted at the capture phase
 *     and dispatched as a custom "ide:editor-ctx" event so EditorPane
 *     can show Bonafide's own menu (mirrors the previous Monaco
 *     behavior).
 *   - LSP plugins (pyright + ruff) are mounted only for Python files
 *     and only when there's a workspace root + absPath.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror"
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
} from "@codemirror/view"
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  selectAll,
} from "@codemirror/commands"
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
  indentUnit,
  foldKeymap,
} from "@codemirror/language"
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete"
import { FindReplaceWidget, findReplaceExtensions } from "./FindReplaceWidget"
import { lintGutter } from "@codemirror/lint"
import { javascript } from "@codemirror/lang-javascript"
import { css } from "@codemirror/lang-css"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { python } from "@codemirror/lang-python"
import { yaml } from "@codemirror/lang-yaml"
import { languageServerWithClient } from "@marimo-team/codemirror-languageserver"
import { useDispatch, useIdeStore, useWorkspaceRoot } from "../ide/hooks"
import type { LangId } from "../ide/fileTree"
import { bonafideTheme } from "../ide/cm-theme"
import { bonafide } from "../ipc/tauri"
import { getPreloadedEntry } from "../ide/preloadCache"
import {
  getOrCreateClient,
  buildLspOptions,
  closeClient,
} from "../ide/lsp-client"
import { diagnosticsExtensions } from "../ide/diagnostics"
import type { Extension } from "@codemirror/state"

// ── Language mapping ────────────────────────────────────────────────────────
// Bonafide's LangId → CodeMirror language extension. We pull each lang
// lazily through a memo so the editor only loads the language pack it
// actually needs.
function langExtensionFor(fileType: LangId) {
  switch (fileType) {
    case "python":
      return python()
    case "markdown":
      return markdown()
    case "json":
      return json()
    case "typescript":
    case "tsx":
      // CodeMirror's lang-javascript covers both JS and TS via the
      // `typescript` option; we keep this single-extension setup since
      // semantic TS services aren't something we ship.
      return javascript({ typescript: true, jsx: fileType === "tsx" })
    case "css":
      return css()
    case "yaml":
      return yaml()
    case "toml":
      // No first-class TOML extension; `css()` with no rules would
      // crash, so we return nothing and fall through to plain text.
      return []
    case "shell":
      // CodeMirror 6 doesn't ship shell highlighting in its core.
      // Plain text is fine; a future PR can add `@codemirror/legacy-modes`
      // + `StreamLanguage` for shell highlighting.
      return []
    case "text":
      return []
  }
}

const baseExtensions = [
  lineNumbers(),
  highlightActiveLine(),
  highlightActiveLineGutter(),
  history(),
  foldGutter(),
  bracketMatching(),
  closeBrackets(),
  indentOnInput(),
  indentUnit.of("  "),
  EditorView.lineWrapping,
  autocompletion(),
  // Diagnostics + lint gutter from @codemirror/lint. Combined with the
  // LSP plugin's own diagnostics surface, this gives us:
  //   - A gutter indicator per diagnostic (red/yellow/blue dot)
  //   - Hover tooltip with the diagnostic message + source
  //   - The merged-in domain diagnostics StateField
  lintGutter(),
  // NOTE: minimap omitted for v1 — `@replit/codemirror-minimap` ships
  // without TypeScript declarations in its current release, which
  // makes it a typing-only pain. We can layer it in once upstream
  // publishes `.d.ts`. Monaco's minimap was always on the right edge
  // of the editor; this is the only feature we knowingly regressed
  // in the swap.
  //
  // NOTE: `bonafideTheme` is NOT included here. It's wired in via the
  // <CodeMirror theme={...} /> prop so @uiw/react-codemirror applies it
  // as the editor's base extension — the slot that determines the
  // "no theme" fallback for the editor root, gutters, panels, etc.
  // Registering it twice (once via `theme`, once here) is harmless in
  // practice because CodeMirror 6 deduplicates by reference, but
  // single-registration is cleaner and prevents any future extension
  // that toggles behavior on first-registration from running twice.
  keymap.of([
    ...defaultKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
    ...closeBracketsKeymap,
    // We deliberately omit `searchKeymap` (Ctrl+F / Ctrl+H / F3 / etc.)
    // — those shortcuts are owned by the Bonafide find/replace widget
    // and the global App.tsx keyboard router. CodeMirror's built-in
    // search panel is replaced by `FindReplaceWidget` rendered inside
    // the editor wrapper below.
    indentWithTab,
  ]),
  // Decoration extension for the Bonafide find/replace widget — every
  // match is underlined with a tertiary-tinted background; the active
  // match (cursor position) gets a stronger border + tint. Wired into
  // the StateField below so the React widget can drive it via
  // `setSearchMatches` effects.
  ...findReplaceExtensions,
]

/**
 * Build the LSP extension for the current editor instance.
 *
 * Returns an empty array when:
 *   - The file isn't Python (we only ship pyright right now)
 *   - There's no `absPath` (untitled file — nothing on disk)
 *   - There's no `workspaceRoot` (no .venv / project context)
 *   - The LSP client couldn't connect (e.g. pyright-langserver isn't installed)
 */
function useLspExtensions(
  fileType: LangId,
  workspaceRoot: string | null,
  absPath: string | null,
): Extension[] {
  const [extensions, setExtensions] = useState<Extension[]>([])

  useEffect(() => {
    let cancelled = false

    async function build() {
      if (fileType !== "python") {
        if (!cancelled) setExtensions([])
        return
      }
      if (!absPath || !workspaceRoot) {
        if (!cancelled) setExtensions([])
        return
      }
      try {
        const clientResult = await getOrCreateClient("pyright", workspaceRoot)
        if (!clientResult || cancelled) {
          setExtensions([])
          return
        }
        const opts = buildLspOptions(
          clientResult.client,
          workspaceRoot,
          absPath,
        )
        // languageServerWithClient returns an Extension[] (not just an
        // Extension) because the LSP plugin needs to coordinate multiple
        // sub-extensions (transactions, decorations, hover tooltips, etc.).
        const exts = languageServerWithClient(opts)
        if (!cancelled) setExtensions(exts)
      } catch (err) {
        console.error("[lsp] failed to build extensions", err)
        if (!cancelled) setExtensions([])
      }
    }
    void build()

    return () => {
      cancelled = true
    }
  }, [fileType, workspaceRoot, absPath])

  return extensions
}

export function CodeMirrorEditor({
  fileId,
  fileType,
  content,
  absPath,
  onSave,
  /** Called when the user saves (Ctrl/Cmd+S). The parent owns disk writes. */
}: {
  fileId: string
  fileType: LangId
  content: string
  absPath?: string | null
  onSave: (currentValue: string) => void
}) {
  const dispatch = useDispatch()
  const store = useIdeStore()
  const editorRef = useRef<ReactCodeMirrorRef | null>(null)
  // Hold the latest onSave in a ref so the keymap closure (registered
  // once per fileId) doesn't capture a stale callback.
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  // Reactive workspace root so LSP plugins re-mount when the user opens a folder.
  const workspaceRoot = useWorkspaceRoot()
  // LSP extensions only mount for Python files with a workspace root.
  const lspExtensions = useLspExtensions(
    fileType,
    workspaceRoot,
    absPath ?? null,
  )
  // Track latest view for diagnostics dispatch.
  const viewRef = useRef<EditorView | null>(null)

  // ── Ctrl/Cmd+S → onSave ──────────────────────────────────────────────────
  // We register the keymap as an extension so it travels with the
  // editor instance. The closure calls onSaveRef which always points
  // at the latest onSave — that way swapping the parent's onSave
  // prop doesn't require re-mounting the editor.
  const saveKeymap = useMemo(
    () =>
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            const view = editorRef.current?.view
            if (!view) return false
            onSaveRef.current(view.state.doc.toString())
            return true
          },
        },
      ]),
    [],
  )

  // Belt-and-suspenders: override Ctrl+F / Ctrl+H here too. Even if a
  // future change re-enables basicSetup's searchKeymap, our keymap is
  // registered LATER (higher precedence in CodeMirror's LIFO stack),
  // so these bindings always win.
  //
  // We dispatch a CustomEvent that `FindReplaceWidget` listens for
  // (mounted inside the editor wrapper below). The widget reads the
  // current selection to seed its find input. We mark the run as
  // handled (`return true`) so no downstream handler — including the
  // global App.tsx keyboard router — runs a second time. This keymap
  // is registered AFTER `baseExtensions` in the `extensions` array,
  // so it wins the LIFO precedence over anything CodeMirror's basic
  // setup tries to register.
  const openFindKeymap = useMemo(
    () =>
      keymap.of([
        {
          key: "Mod-f",
          run: () => {
            window.dispatchEvent(
              new CustomEvent("ide:open-find", { detail: { mode: "find" } }),
            )
            return true
          },
        },
        {
          key: "Mod-h",
          run: () => {
            window.dispatchEvent(
              new CustomEvent("ide:open-find", { detail: { mode: "replace" } }),
            )
            return true
          },
        },
      ]),
    [],
  )

  // ── Right-click context menu ────────────────────────────────────────────
  // The previous (Monaco) version attached the context-menu interception
  // as an `onContextMenu` prop on the wrapper that hosted Monaco. We
  // can do the same here: `<CodeMirror>` from `@uiw/react-codemirror`
  // forwards every unknown prop (including React synthetic events) to
  // its root `<div class="cm-theme">`, which encompasses the gutters
  // and the content — i.e. the entire editor surface. That makes a
  // single React-level handler the right shape for this: one listener
  // covers right-clicks on text, line numbers, the fold gutter, and
  // indent guides, all without the CodeMirror `domEventHandlers`
  // extension having to be tweaked per-target.
  //
  // The handler runs AFTER `main.tsx`'s capture-phase
  // `preventDefault()` (which suppresses WebView2's native context
  // menu) and BEFORE the bubble-phase would otherwise let anything
  // else see the event. The handler dispatches `ide:editor-ctx` so
  // EditorPane can show Bonafide's own editor context menu.
  const onEditorContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    window.dispatchEvent(
      new CustomEvent("ide:editor-ctx", {
        detail: { x: e.clientX, y: e.clientY },
      }),
    )
  }, [])

  // ── ide:editor-action events from the editor context menu ────────────────
  // Dispatched by menus.tsx for Cut, Copy, Paste, Select All, Find, Replace,
  // Go to Line, and Format Document. Find/Replace are routed through the
  // Bonafide `FindReplaceWidget` (rendered in the editor wrapper below) by
  // dispatching a window event the widget listens for; everything else
  // maps directly to a CodeMirror command.
  useEffect(() => {
    function onEditorAction(e: Event) {
      const { kind } = (e as CustomEvent).detail as { kind: string }
      const view = editorRef.current?.view
      if (!view) return
      switch (kind) {
        case "select-all":
          selectAll(view)
          break
        case "find":
          // Open the Bonafide find/replace widget (find mode). The widget
          // seeds its input from the current selection, if any.
          window.dispatchEvent(
            new CustomEvent("ide:open-find", { detail: { mode: "find" } }),
          )
          break
        case "replace":
          // Same widget, but with the replace row expanded.
          window.dispatchEvent(
            new CustomEvent("ide:open-find", {
              detail: { mode: "replace" },
            }),
          )
          break
        case "goto-line":
          // Prompt the user for a line number and jump there.
          {
            const line = view.state.doc.lines
            const input = window.prompt(`Go to line (1–${line}):`)
            if (!input) break
            const lineNum = parseInt(input.trim(), 10)
            if (isNaN(lineNum) || lineNum < 1 || lineNum > line) break
            const lineInfo = view.state.doc.line(lineNum)
            view.dispatch({
              selection: { anchor: lineInfo.from },
              scrollIntoView: true,
            })
            view.focus()
          }
          break
        default:
          break
      }
    }
    window.addEventListener("ide:editor-action", onEditorAction)
    return () => window.removeEventListener("ide:editor-action", onEditorAction)
  }, [])

  const extensions = useMemo(
    () => [
      baseExtensions,
      ...diagnosticsExtensions(),
      saveKeymap,
      // Override Ctrl+F / Ctrl+H so they ALWAYS dispatch the Bonafide
      // find/replace widget — even if a future basicSetup toggle
      // re-enables CodeMirror's built-in `searchKeymap`. LIFO order
      // means this keymap wins precedence over basicSetup's.
      openFindKeymap,
      langExtensionFor(fileType),
      ...lspExtensions,
    ],
    [saveKeymap, openFindKeymap, fileType, lspExtensions],
  )

  // ── Seed content from disk when no in-memory content is available ──────
  // The Sidebar's preload cache fires a disk read in the click task,
  // before OPEN_FILE is dispatched, so by the time CodeMirrorEditor
  // mounts the cache is already warm. We hit the cache first, fall
  // back to a direct IPC read, and in both cases we *also* push the
  // content into the store via `SET_CONTENT` so a future remount of
  // this editor (i.e. another file-switch away-and-back) doesn't have
  // to re-read from disk.
  const initialDiskContentRef = useRef<string | null>(null)
  const currentSeedIdRef = useRef<number>(0)

  useEffect(() => {
    let cancelled = false
    const seedId = ++currentSeedIdRef.current

    async function seedFromDisk() {
      if (content && content.length > 0) return
      if (!absPath) return

      // Cache fast path
      const cached = getPreloadedEntry(absPath)
      if (cached && cached.content.length > 0) {
        if (cancelled || seedId !== currentSeedIdRef.current) return
        initialDiskContentRef.current = cached.content
        // Update the baseline so handleChange(diskContent) doesn't mark dirty.
        baselineContentRef.current = cached.content
        // Push into the store so a future remount mounts with content.
        dispatch({ type: "SET_CONTENT", fileId, content: cached.content })
        const view = editorRef.current?.view
        if (view) {
          view.dispatch({
            changes: {
              from: 0,
              to: view.state.doc.length,
              insert: cached.content,
            },
          })
        }
        return
      }

      try {
        const { content: onDisk } = await bonafide.fs.readFile(absPath)
        if (cancelled || seedId !== currentSeedIdRef.current) return
        initialDiskContentRef.current = onDisk
        // Update the baseline so handleChange(onDisk) doesn't mark dirty.
        baselineContentRef.current = onDisk
        dispatch({ type: "SET_CONTENT", fileId, content: onDisk })
        const view = editorRef.current?.view
        if (view) {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: onDisk },
          })
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[CodeMirrorEditor] failed to read file", absPath, err)
      }
    }

    initialDiskContentRef.current = null
    seedFromDisk()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, absPath])

  // ── Track the "baseline" content for the currently open file.
  //
  // When a file opens, CodeMirror's first handleChange fires with the
  // controlled `value` prop (usually empty when content hasn't been
  // seeded into the store yet). That call must NOT mark the tab dirty.
  // After the seed effect patches the editor doc with the on-disk
  // content, that call must also NOT mark dirty.
  //
  // The baseline is the content we last saw on disk for this fileId.
  // handleChange compares the incoming value to the baseline: if they
  // match, the change is just code syncing to the file's known state,
  // not a user edit.
  //
  // The baseline is set on mount (empty string), updated by the seed
  // effect (disk content), and reset whenever the fileId changes.
  const baselineContentRef = useRef<string>("")
  const currentFileIdRef = useRef<string>(fileId)

  useEffect(() => {
    // Reset baseline when switching files so the new fileId starts fresh.
    if (currentFileIdRef.current !== fileId) {
      currentFileIdRef.current = fileId
      baselineContentRef.current = ""
    }
  }, [fileId])

  // ── Editor change → mark dirty (store) + queue content flush ───────────
  //
  // Debounce SET_CONTENT so rapid typing batches into a single store update
  // instead of hundreds of re-renders.
  const pendingContentRef = useRef<string>("")
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function scheduleFlush(value: string) {
    pendingContentRef.current = value
    if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current)
    flushTimerRef.current = setTimeout(() => {
      const currentFileId = currentFileIdRef.current
      const value = pendingContentRef.current
      if (value) {
        dispatch({ type: "SET_CONTENT", fileId: currentFileId, content: value })
      }
    }, 400)
  }

  const handleChange = useCallback(
    (value: string) => {
      const currentFileId = currentFileIdRef.current
      // Only mark dirty when the value diverges from the on-disk baseline
      // for this file. Two cases are NOT user edits and must NOT mark dirty:
      //   1. CodeMirror's first handleChange("") on mount — the baseline is
      //      "" until the seed effect patches the doc.
      //   2. The seed effect's view.dispatch() that loads disk content into
      //      the editor — once we set baseline to that content, future
      //      handleChange(value) calls that match it are no-ops.
      const matchesBaseline = baselineContentRef.current === value
      if (!matchesBaseline) {
        const state = store.getState()
        const tab = state.tabs.find((t) => t.fileId === currentFileId)
        if (tab && !tab.dirty) {
          dispatch({ type: "MARK_DIRTY", tabId: tab.id, dirty: true })
        }
      }
      scheduleFlush(value)
    },
    [dispatch, store],
  )

  // ── One-shot content seed ────────────────────────────────────────────────
  // The previous design passed `value={content}` to `<CodeMirror>` only on
  // the first render per fileId, then handed `value={undefined}` on every
  // subsequent render so CodeMirror would not re-sync. This worked for
  // *intra*-file re-renders, but every file *switch* still passed a new
  // value to the underlying CodeMirror instance (because `content` goes
  // from one file's cached text to another file's empty string), which
  // triggered a full clear + re-highlight transaction on the existing
  // editor instance — measured at hundreds of milliseconds for typical
  // files and up to several seconds for the very large files Bonafide
  // is meant for.
  //
  // The fix: tie the CodeMirror mount to the fileId via `key`. When the
  // user switches files, React unmounts the old editor and mounts a fresh
  // one seeded with the new file's content in a single render. There is
  // no value-clear transaction, no re-highlight on stale content, and the
  // new editor's first paint is the new file's first paint.
  //
  // The `seedFromDisk` effect above is still useful for cache-miss
  // cases: if `content` is empty and the preload cache missed, we read
  // from disk and patch the view once IPC resolves. But for the
  // overwhelming majority of switches (the user just opened the file a
  // few moments ago, or it was preloaded via the sidebar click), `content`
  // is already populated and the editor mounts with content immediately.
  const controlledValue: string | undefined = content

  // Cleanup the LSP client when the workspace is closed (workspaceRoot
  // becomes null). The cache key includes the workspace, so dropping it
  // here is safe even if the same workspace is re-opened later (a fresh
  // client will be created on the next `getOrCreateClient` call).
  useEffect(() => {
    if (fileType === "python" && absPath && workspaceRoot) {
      // Defer cleanup so the LSP plugin has time to flush didClose.
      const t = setTimeout(() => {
        closeClient("pyright", workspaceRoot)
      }, 100)
      return () => clearTimeout(t)
    }
    return undefined
  }, [workspaceRoot, absPath, fileType])

  // Hold a reactive copy of the CodeMirror view so the FindReplaceWidget
  // overlay (rendered in the wrapper below) can call commands on it.
  // The CodeMirror component only writes `editorRef.current.view` once
  // per `key` mount, so we mirror that into React state when the view
  // becomes available — that way the wrapper re-renders and the widget
  // gets a non-null view.
  const [cmView, setCmView] = useState<EditorView | null>(null)
  useEffect(() => {
    const v = editorRef.current?.view ?? null
    if (v && v !== cmView) {
      setCmView(v)
    }
    // We intentionally depend only on fileId: the view lifetime is
    // tied to the `key={fileId}` mount, so when fileId changes we get
    // a fresh ref and re-run this effect to capture the new view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId])

  return (
    <div className="relative h-full w-full">
      <CodeMirror
        key={fileId}
        ref={editorRef}
        value={controlledValue}
        // The `theme` prop on @uiw/react-codemirror's <CodeMirror> is the
        // extension applied to the editor view as its base visual surface.
        // If we omit it, the component falls back to its built-in *light*
        // theme — which is what was producing the giant white rectangle
        // over the code. Passing our `bonafideTheme` array (editor chrome
        // + syntax highlight) makes Bonafide's theme the sole authority:
        // the editor root, gutters, panels, tooltips, selection, and active
        // line all come from a single source of truth.
        theme={bonafideTheme}
      height="100%"
      width="100%"
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
        foldGutter: true,
        bracketMatching: true,
        closeBrackets: true,
        indentOnInput: true,
        highlightSelectionMatches: true,
        // Disable CodeMirror's built-in searchKeymap. Without this,
        // Ctrl+F / Ctrl+H / F3 from `@uiw/codemirror-extensions-basic-setup`
        // would call `openSearchPanel` and open CodeMirror's native
        // search panel — the one that lives at the BOTTOM of the
        // editor (not our top-right widget). We want a single find UI,
        // so we turn off CodeMirror's keymap and rely on the global
        // App.tsx keyboard router (`Ctrl+F` / `Ctrl+H`) plus the
        // context menu's "Find…" / "Replace…" entries.
        searchKeymap: false,
        // Same logic for the lint keymap (Alt+Shift+L etc.) — Bonafide
        // doesn't ship a lint action; disabling avoids accidentally
        // running a CodeMirror default that we haven't reviewed.
        lintKeymap: false,
      }}
      extensions={extensions}
      onChange={handleChange}
      onContextMenu={onEditorContextMenu}
      onCreateEditor={(view) => {
        viewRef.current = view
        setCmView(view)
      }}
      />
      {/* Find/Replace overlay — sits inside the editor wrapper so its
          absolute positioning is anchored to the editor surface. The
          widget listens for `ide:open-find` (dispatched by the editor
          context menu and the App.tsx keyboard router) and drives the
          underlying CodeMirror view via SearchQuery / findNext /
          findPrevious / replaceNext / replaceAll. */}
      <FindReplaceWidget view={cmView} />
    </div>
  )
}
