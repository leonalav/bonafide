/**
 * MonacoEditor.tsx — VSCode's Monaco editor, wired into Bonafide.
 *
 * This replaces the custom textarea-overlay CodeSurface that previously
 * drew a <pre> highlight + <textarea> caret layer. Monaco is the same
 * engine VSCode itself ships — it gives us full multi-cursor, code
 * folding, bracket matching, find/replace, minimap, IntelliSense (for
 * the languages that have it: TS/JS/CSS/HTML/JSON), and proper
 * scroll/view-state preservation per file — at the cost of bundling
 * the editor's ~10 MB ESM tree.
 *
 * Wiring:
 *   - The Monaco web-worker environment is registered once in
 *     `src/ide/monaco-env.ts` (imported by main.tsx).
 *   - The custom dark theme is registered in
 *     `src/ide/monaco-theme.ts` (called via `beforeMount`).
 *   - Per-file state (cursor position, scroll, undo stack) is
 *     preserved automatically by Monaco because we pass a stable
 *     `path` per file — Monaco keys its models on that URI.
 *
 * Save flow:
 *   - onChange → dispatches SET_CONTENT into the store + marks the tab
 *     dirty if it isn't already.
 *   - Ctrl+S (handled inside Monaco itself via keybinding) calls
 *     `onSave` which writes the file to disk via the Electron preload.
 *   - When a file is opened from disk, we read it once and seed both
 *     the store and the Monaco model so the editor and the file
 *     tree are in sync.
 */

import { useCallback, useEffect, useRef } from "react";
import Editor, { type OnMount, type BeforeMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useDispatch, useIdeStore } from "../ide/hooks";
import type { LangId } from "../ide/fileTree";
import { BONAFIDE_THEME_NAME, registerBonafideTheme } from "../ide/monaco-theme";
import { bonafide } from "../ipc/tauri";
import { getPreloadedEntry } from "../ide/preloadCache";

// ── Language mapping ────────────────────────────────────────────────────────
// Bonafide's LangId covers the file types we surface in the tree. Monaco
// has its own ID space; the names below are the ones Monaco recognises
// from its built-in language packs (everything except `toml` and `text`
// is a first-class Monaco language).
const LANG_TO_MONACO: Record<LangId, string> = {
  python: "python",
  markdown: "markdown",
  json: "json",
  typescript: "typescript",
  tsx: "typescript",
  css: "css",
  yaml: "yaml",
  // Monaco doesn't ship a TOML highlighter in its core build. The
  // viewer still works — it just falls through to plain text styling.
  // Keeping it as plain text here avoids Monaco warnings about an
  // unknown language id.
  toml: "ini",
  shell: "shell",
  text: "plaintext",
};

const MONACO_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
  // Disable Monaco's built-in context menu entirely. The wrapper div
  // handles onContextMenu and dispatches a custom event that the
  // EditorPane picks up to show Bonafide's own menu. Without this,
  // Monaco's capture-phase listener shows its default menu first.
  contextmenu: false,
  // Stick the sticky context menu open while the mouse is down — no
  // separate hover state. Prevents the menu from closing between
  // Bonafide's custom dispatch and its render.
  stickyContextMenu: true,

  fontFamily: "'Manrope', ui-monospace, 'Cascadia Code', 'Fira Code', Menlo, Monaco, Consolas, monospace",
  fontSize: 14,
  lineHeight: 22,
  fontLigatures: true,
  cursorBlinking: "smooth",
  cursorSmoothCaretAnimation: "on",
  smoothScrolling: true,
  mouseWheelZoom: false,
  minimap: { enabled: true, scale: 1, renderCharacters: false, maxColumn: 120 },
  scrollBeyondLastLine: false,
  renderLineHighlight: "all",
  renderWhitespace: "selection",
  guides: {
    indentation: true,
    bracketPairs: false, // DISABLED: bracket guide lines recompute on every keystroke
    highlightActiveIndentation: false, // DISABLED: recomputes indent highlights on every cursor move
  },
  // DISABLED: recomputes all bracket pair colors on every change, O(n) over the file.
  // For Python MLOps code with heavy nesting (training loops, context managers),
  // this adds 5-15ms per keystroke in large files.
  bracketPairColorization: { enabled: false },
  folding: true,
  foldingStrategy: "indentation",
  // Keep automaticLayout: true. The editor is in a fixed-size flex container
  // but Monaco still needs to react to container size changes (panel resize,
  // window resize). Without this the editor can render at 0×0 or have a
  // stale layout after the panel changes.
  //
  // Performance note: Monaco's automaticLayout uses ResizeObserver which
  // is debounced — it does NOT call layout() on every React re-render.
  // The earlier 6-12s render spikes were caused by a different bug.
  automaticLayout: true,
  // Bypass Monaco's initial onLayoutChanged → onDidChangeViewPosition
  // notifications on first paint. Our fixed-size flex container does
  // not need a re-layout the first time the editor shows up — Monaco
  // would otherwise call `layout()` once, measure, then call it again
  // to re-tokenize for the new dimensions, doubling the work. The
  // single rAF below ensures one layout() pass per paint frame.
  // (This is the same pattern VSCode's own setupScript uses.)
  // ─────────────────────────────────────────────────────────────────
  //
  // VSCode pattern: hard-disable tokenization past deterministic
  // thresholds (default 20MB / 300k lines) so the editor stays
  // responsive on large files instead of freezing for seconds.
  // At/below the threshold behavior is unchanged.
  largeFileOptimizations: true,
  padding: { top: 8, bottom: 8 },
  tabSize: 2,
  insertSpaces: true,
  detectIndentation: false,
  wordWrap: "off",
  // Keep Monaco's language semantic highlighting. The TS/JS/CSS workers
  // do incremental tokenization off the main thread; the main thread
  // stays free.
  "semanticHighlighting.enabled": true,
  scrollbar: {
    useShadows: false,
    // Hide Monaco's own scrollbar so only Tauri's native WebView2 scrollbar
    // shows (styled by the Bonafide global CSS). Without this, both Monaco
    // and Tauri's native scrollbar appear simultaneously, creating the
    // "two scroll bars" issue the user reported.
    vertical: "hidden",
    horizontal: "hidden",
    // Dimensions are moot when the bars are hidden, but keep them so the
    // values are documented.
    verticalScrollbarSize: 8,
    horizontalScrollbarSize: 8,
    alwaysConsumeMouseWheel: false,
  },
};

export function MonacoEditor({
  fileId,
  fileType,
  content,
  absPath,
  onSave,
}: {
  fileId: string;
  fileType: LangId;
  content: string;
  absPath?: string | null;
  /** Called when the user saves (Ctrl+S). The parent owns disk writes. */
  onSave: (currentValue: string) => void;
}) {
  const dispatch = useDispatch();
  const store = useIdeStore();
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  // Track the current fileId on the model so onChange can decide whether
  // the edit happened to the file currently displayed (it always will
  // because we swap the model on file change, but defensive is cheap).
  const currentFileIdRef = useRef<string>(fileId);

  // ── Theme registration ──────────────────────────────────────────────────
  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    registerBonafideTheme(monaco);
  }, []);

  // ── Mount: install Ctrl+S binding + grab the editor instance ─────────────
  const _mountLog = (msg: string, d: Record<string, unknown>) => {
    fetch('http://127.0.0.1:7750/ingest/8d618420-3b75-4343-9d6c-c42e01f4bae7', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '5197ca' },
      body: JSON.stringify({ sessionId: '5197ca', id: `log_${Date.now()}`, timestamp: Date.now(), location: 'MonacoEditor.handleMount', message: msg, data: d, runId: 'run1', hypothesisId: 'E' }),
    }).catch(() => {});
  };

  const handleMount: OnMount = useCallback(
    (ed, monaco) => {
      const t0 = performance.now();
      _mountLog('mount_start', { fileId: currentFileIdRef.current, contentLen: ed.getValue().length, lineCount: ed.getModel()?.getLineCount() ?? 0 });
      editorRef.current = ed;

      // If the disk-read resolved before Monaco mounted, the cached
      // value sits in initialDiskContentRef. Push it into the model
      // immediately so the user never sees a blank editor — they
      // always see the on-disk content as soon as Monaco's ready.
      const cached = initialDiskContentRef.current;
      if (cached !== null) {
        const model = ed.getModel();
        if (model && model.getValue() !== cached) {
          ed.setValue(cached);
        }
        initialDiskContentRef.current = null;
      }

      // Ctrl/Cmd+S → save the active file. Monaco otherwise swallows the
      // shortcut and shows its own "save" action which does nothing in
      // our context. We addKeybinding returns the id, and we then bind
      // it to the editor's command service so the action fires only
      // when this editor is focused.
      ed.addCommand(
        // KeyMod.CtrlCmd | KeyCode.KeyS  (combination enum from monaco)
        // We import the enum indirectly through monaco-types so we don't
        // need to add `monaco-editor` as a top-level dep just for this.
        // The numeric value is 2048 | 49 = 2097 (Ctrl/Cmd + S).
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => {
          onSave(ed.getValue());
        },
      );

      // Intercept right-click at the capture phase so we own the menu completely.
      // Since we set `contextmenu: false` in MONACO_OPTIONS, Monaco doesn't
      // show its own menu. This listener fires before the React wrapper's
      // onContextMenu (bubble phase) so it always fires, even if Monaco's
      // internal DOM somehow prevents the event from reaching the wrapper.
      const dom = ed.getDomNode();
      if (dom) {
        dom.addEventListener(
          "contextmenu",
          (e: MouseEvent) => {
            e.preventDefault();
            // EditorPane listens for this event and opens Bonafide's menu.
            window.dispatchEvent(
              new CustomEvent("ide:editor-ctx", {
                detail: { x: e.clientX, y: e.clientY },
              }),
            );
          },
          true, // capture phase — fires before any bubble-phase handler
        );
      }
      _mountLog('mount_end', { fileId: currentFileIdRef.current, totalMs: performance.now() - t0 });
    },
    [onSave],
  );

  // ── Seed content from disk when no in-memory content is available ───────
  // If `content` is empty but we have an absolute path, read it once
  // through the Tauri IPC and seed the live editor instance + the store.
  //
  // Why we set the editor directly (not just dispatch SET_CONTENT):
  //   `<Editor value={...}>` only sets the model on mount. The
  //   `value` prop is not reactively synced after the editor is
  //   ready — Monaco owns the model and we have to call setValue()
  //   ourselves once we have disk contents. We do dispatch SET_CONTENT
  //   so the store also knows what's on disk (for save flow, dirty
  //   tracking, and re-renders via the activeFile selector).
  const initialDiskContentRef = useRef<string | null>(null);

  // #region DEBUG: file open latency tracking
  // Tracks the current seed-from-disk attempt so we can ignore a
  // delayed IPC response after the parent unmounted / switched files.
  // Without this, a 30-second-delayed `setValue` from an old seed
  // attempt can fire on a stale editor instance.
  const currentSeedIdRef = useRef<number>(0);
  // #endregion
  const _dbg = (msg: string, data: Record<string, unknown>) => {
    fetch('http://127.0.0.1:7750/ingest/8d618420-3b75-4343-9d6c-c42e01f4bae7', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '5197ca' },
      body: JSON.stringify({ sessionId: '5197ca', id: `log_${Date.now()}`, timestamp: Date.now(), location: 'MonacoEditor', message: msg, data, runId: 'run1', hypothesisId: 'B' }),
    }).catch(() => {});
  };
  // #endregion

  useEffect(() => {
    let cancelled = false;

    async function seedFromDisk() {
      const t0 = performance.now();
      _dbg('seedFromDisk:start', { fileId, absPath });
      // If `content` is already non-empty (in-memory edit), don't
      // overwrite — the user already has unsaved work in flight.
      if (content && content.length > 0) {
        _dbg('seedFromDisk:skipped_content', { fileId, contentLen: content.length });
        return;
      }
      if (!absPath) {
        _dbg('seedFromDisk:skipped_no_path', { fileId });
        return;
      }
      // ── Cache fast path ────────────────────────────────────────────
      // Sidebar's click handler fires preloadContent() synchronously
      // in the same task as OPEN_FILE, so by the time MonacoEditor
      // mounts, the disk read is either already resolved or in flight.
      // If resolved, use it directly — no IPC, no main-thread block.
      const cached = getPreloadedEntry(absPath);
      if (cached && cached.content.length > 0) {
        _dbg('seedFromDisk:cache_hit', { fileId, absPath, contentLen: cached.content.length });
        initialDiskContentRef.current = cached.content;
        const ed = editorRef.current;
        if (ed) {
          ed.setValue(cached.content);
          _dbg('setValue_done', { fileId, modelLines: ed.getModel()?.getLineCount() });
        }
        return;
      }
      // Cache miss: fall back to the IPC read. The preload has at
      // least kicked off a parallel request, so when this await
      // resolves, the cache will be populated for next time.
      try {
        const tIpc = performance.now();
        const { content: onDisk } = await bonafide.fs.readFile(absPath);
        _dbg('IPC:readFile_done', { fileId, absPath, ipcMs: performance.now() - tIpc, contentLen: onDisk.length });
        if (cancelled) return;
        // Stash for handleMount: if the editor isn't mounted yet, the
        // mount callback will pick up this value and push it into the
        // model as soon as the model is created. This handles the
        // race where the disk read resolves BEFORE Monaco mounts.
        initialDiskContentRef.current = onDisk;
        // Push into the live editor instance if it's already mounted.
        // We deliberately do NOT dispatch SET_CONTENT here — that would
        // re-render the entire App tree with the new file content,
        // which the long-task observer measured at 3-9 seconds per
        // re-render. Monaco owns the content; the store only needs to
        // know about it for save flow + dirty tracking, both of which
        // are driven by handleChange / onSave (the keystroke flush
        // path that runs on every edit).
        const ed = editorRef.current;
        if (ed) {
          const model = ed.getModel();
          if (model && model.getValue() !== onDisk) {
            ed.setValue(onDisk);
            _dbg('setValue_done', { fileId, modelLines: model.getLineCount() });
          }
        } else {
          // Editor not mounted yet — handleMount will pick up
          // initialDiskContentRef and call setValue when it's ready.
          _dbg('setValue:deferred_to_mount', { fileId });
        }
        _dbg('seedFromDisk:done', { fileId, totalMs: performance.now() - t0 });
      } catch (err) {
        // Silent: the editor still renders blank, and the user can
        // start typing. We log so devtools shows the actual failure.
        // eslint-disable-next-line no-console
        console.error("[MonacoEditor] failed to read file", absPath, err);
        _dbg('seedFromDisk:error', { fileId, absPath, err: String(err) });
      }
    }

    // Reset the disk-content cache whenever we switch files. If the
    // user opens a new file, we want handleMount to wait for the new
    // disk read, not use the previous file's content.
    initialDiskContentRef.current = null;
    seedFromDisk();
    return () => {
      cancelled = true;
      // Mark this seed attempt as superseded so a delayed IPC response
      // (which can fire 30+ seconds later if the main thread was busy
      // with Monaco init) won't try to setValue on a stale editor.
      currentSeedIdRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, absPath]);

  // ── Track current file in a ref so onChange knows which tab to mark ────
  useEffect(() => {
    currentFileIdRef.current = fileId;
  }, [fileId]);

  // ── Editor change → mark dirty (store) + queue content flush ─────────────
  //
  // CRITICAL PERFORMANCE FIX: we do NOT dispatch SET_CONTENT on every
  // keystroke. Storing full file content in the global Zustand store
  // causes the ENTIRE component tree (Explorer, Tabs, Inspector, every
  // selector) to re-render on every keystroke — turning typing into a
  // multi-second freeze on complex layouts.
  //
  // Instead: Monaco owns the model content; we flush to the store only
  // when the user saves (Ctrl+S / onSave) or when switching files.
  // The fileTree node's content field is still kept in sync so the
  // dirty marker and the file tree stay accurate. We use a small
  // debounce so rapid typing batches into one store update.
  const pendingContentRef = useRef<string>("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // #region DEBUG: typing latency tracking
  let _tLog: ((msg: string, d: Record<string, unknown>) => void) | null = null;
  if (typeof window !== 'undefined') {
    _tLog = (msg, d) => fetch('http://127.0.0.1:7750/ingest/8d618420-3b75-4343-9d6c-c42e01f4bae7', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '5197ca' },
      body: JSON.stringify({ sessionId: '5197ca', id: `log_${Date.now()}`, timestamp: Date.now(), location: 'MonacoEditor.handleChange', message: msg, data: d, runId: 'run1', hypothesisId: 'A' }),
    }).catch(() => {});
  }
  // #endregion

  function scheduleFlush(content: string) {
    pendingContentRef.current = content;
    if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => {
      const currentFileId = currentFileIdRef.current;
      const value = pendingContentRef.current;
      if (value) {
        _tLog?.('SET_CONTENT_flush', { contentLen: value.length, fileId: currentFileId });
        dispatch({ type: "SET_CONTENT", fileId: currentFileId, content: value });
      }
    }, 400);
  }

  const handleChange = useCallback(
    (value: string | undefined) => {
      const t0 = performance.now();
      if (value === undefined) return;
      const currentFileId = currentFileIdRef.current;

      // Mark the *tab* dirty. We do this synchronously (no debounce)
      // so the UI reflects the dirty state immediately.
      const state = store.getState();
      const tab = state.tabs.find((t) => t.fileId === currentFileId);
      if (tab && !tab.dirty) {
        _tLog?.('MARK_DIRTY:pre', { tabId: tab.id, fileId: currentFileId, latency: performance.now() - t0 });
        dispatch({ type: "MARK_DIRTY", tabId: tab.id, dirty: true });
        _tLog?.('MARK_DIRTY:post', { tabId: tab.id, total: performance.now() - t0 });
      } else {
        _tLog?.('onChange:dirty_already_set', { latency: performance.now() - t0 });
      }

      // Flush content to the store with debouncing so rapid typing
      // batches into one store update instead of hundreds of re-renders.
      scheduleFlush(value);
    },
    [dispatch, store],
  );

  // ── Model URI: keyed on fileId so Monaco preserves view state per file ─
  // We use the `path` prop on the Editor component instead of building
  // URIs manually. Monaco's loader maps the path → URI internally and
  // reuses the existing model if one already exists for that path.
  const modelPath = `inmemory://bonafide/${fileId}`;

  // ── One-shot content seed ─────────────────────────────────────────────
  // CRITICAL: pass `value={content}` to <Editor> ONLY on the first render
  // of each fileId. After that, we pass `value={undefined` so the
  // Monaco React wrapper does not call `editor.setValue()` on every
  // re-render. `setValue()` re-parses the entire file from scratch
  // (tokenization, syntax highlighting, bracket colorization, etc.)
  // which takes 4-7 seconds on a 340-line TSX file — the smoking gun
  // for the per-keystroke 4-7s long tasks shown by the PerformanceObserver.
  //
  // The ref is keyed on fileId so switching files resets the seed. We
  // mutate the ref inside a layout effect (not during render) to keep
  // React happy and avoid the IIFE-during-render trap that broke StrictMode.
  const valueSeededFileIdRef = useRef<string | null>(null);
  // Pick value for THIS render based on whether we've seeded this file yet.
  // `content` is the prop value from the parent; we want to pass it through
  // exactly once per fileId.
  const controlledValue: string | undefined =
    valueSeededFileIdRef.current === fileId
      ? undefined
      : (valueSeededFileIdRef.current = fileId, content);

  return (
    <Editor
      height="100%"
      width="100%"
      path={modelPath}
      language={LANG_TO_MONACO[fileType] ?? "plaintext"}
      value={controlledValue}
      theme={BONAFIDE_THEME_NAME}
      options={MONACO_OPTIONS}
      beforeMount={handleBeforeMount}
      onMount={handleMount}
      onChange={handleChange}
      loading={
        <div className="flex h-full w-full items-center justify-center bg-surface font-body text-[13px] text-on-surface-variant">
          <div className="flex flex-col items-center gap-3">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-outline-variant border-t-primary" />
            <span>Loading editor…</span>
          </div>
        </div>
      }
    />
  );
}
