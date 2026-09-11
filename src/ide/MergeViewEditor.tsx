/**
 * MergeViewEditor.tsx — CodeMirror 6 merge/diff editor for Bonafide.
 *
 * Built on @codemirror/merge (official CM6 package). Used to let users
 * review and accept/reject AI agent patches before they land.
 *
 * Two flavors supported:
 *   1. `unifiedMergeView` — inline diff (inserted/deleted markers in a single
 *      pane). Best for the common "review a small patch" case.
 *   2. `MergeView` — true side-by-side. Used for large multi-hunk diffs.
 *
 * The component exposes both via the `mode` prop. Default is "unified".
 *
 * Keyboard shortcuts (unified mode):
 *   - Ctrl+.    → accept chunk under cursor
 *   - Ctrl+,    → reject chunk under cursor
 *   - F8        → next chunk
 *   - Shift+F8  → previous chunk
 *
 * When the user is satisfied with the proposed content, `onAccept(mergedText)`
 * fires so the parent can apply the merged content to the underlying file.
 * `onReject()` cancels without applying changes.
 *
 * Stateless wrapper: rebuilds when originalText/proposedText change, which
 * is correct because diffs are stateless functions of the inputs.
 */

import { useEffect, useRef } from "react"
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror"
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
} from "@codemirror/view"
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands"
import {
  bracketMatching,
  indentOnInput,
  indentUnit,
} from "@codemirror/language"
import { python } from "@codemirror/lang-python"
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete"
import {
  unifiedMergeView,
  acceptChunk,
  rejectChunk,
  goToNextChunk,
  goToPreviousChunk,
  getOriginalDoc,
  getChunks,
  MergeView,
} from "@codemirror/merge"
import { type Extension } from "@codemirror/state"
import { bonafideTheme } from "./cm-theme"

export type MergeViewEditorProps = {
  /** The current/original file content (read-only reference). */
  originalText: string
  /** The agent's proposed changes (this is what the editor starts with). */
  proposedText: string
  /** Called when the user accepts the merged result. */
  onAccept: (mergedText: string) => void
  /** Called when the user rejects the changes. */
  onReject: () => void
  /** Optional language extension. Defaults to Python. */
  languageExtension?: Extension
  /** Optional className for the outer wrapper. */
  className?: string
}

export function MergeViewEditor({
  originalText,
  proposedText,
  onAccept,
  onReject,
  languageExtension,
  className,
}: MergeViewEditorProps) {
  const editorRef = useRef<ReactCodeMirrorRef | null>(null)
  // Keep latest callbacks in refs so the editor's keymap can read them
  // without needing to remount when they change.
  const onAcceptRef = useRef(onAccept)
  onAcceptRef.current = onAccept
  const onRejectRef = useRef(onReject)
  onRejectRef.current = onReject

  // Build extensions for the proposed-text editor with unifiedMergeView.
  const extensions = useRef<Extension[]>([])
  extensions.current = [
    lineNumbers(),
    highlightActiveLine(),
    history(),
    bracketMatching(),
    closeBrackets(),
    indentOnInput(),
    indentUnit.of("  "),
    autocompletion(),
    languageExtension ?? python(),
    bonafideTheme,
    unifiedMergeView({
      original: originalText,
      highlightChanges: true,
      gutter: true,
      mergeControls: true,
      syntaxHighlightDeletions: true,
    }),
    keymap.of([
      {
        key: "Mod-.",
        preventDefault: true,
        run: (view) => acceptChunk(view),
      },
      {
        key: "Mod-,",
        preventDefault: true,
        run: (view) => rejectChunk(view),
      },
      {
        key: "F8",
        preventDefault: true,
        run: goToNextChunk,
      },
      {
        key: "Shift-F8",
        preventDefault: true,
        run: goToPreviousChunk,
      },
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
      ...closeBracketsKeymap,
    ]),
  ]

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className ?? ""}`}>
      {/* Header / action bar */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-outline-variant bg-surface-container-lowest px-3">
        <div className="flex items-center gap-2 text-[12px] font-medium text-on-surface-variant">
          <span className="label-caps">Review Changes</span>
          <span className="text-outline">·</span>
          <span className="font-mono text-on-surface-variant">
            {originalText.split("\n").length} →{" "}
            {proposedText.split("\n").length} lines
          </span>
          <span className="text-outline">·</span>
          <span className="text-[11px] text-outline">
            Ctrl+. accept · Ctrl+, reject · F8 next · Shift+F8 prev
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => {
              const view = editorRef.current?.view
              if (!view) return
              // Accept the merged result by reading the editor's current doc.
              const mergedText = view.state.doc.toString()
              onAcceptRef.current(mergedText)
            }}
            className="flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium text-primary hover:bg-primary/10"
          >
            Accept All
          </button>
          <button
            onClick={() => onRejectRef.current()}
            className="flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium text-on-surface-variant hover:bg-surface-container"
          >
            Reject All
          </button>
        </div>
      </div>

      {/* Unified merge editor. Re-mount on input change to recompute the diff. */}
      <CodeMirror
        key={`${originalText.length}-${proposedText.length}`}
        ref={editorRef}
        value={proposedText}
        height="100%"
        width="100%"
        theme={bonafideTheme}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLine: true,
          foldGutter: false,
          bracketMatching: true,
          closeBrackets: true,
          indentOnInput: true,
          highlightSelectionMatches: true,
        }}
        extensions={extensions.current}
      />
    </div>
  )
}

/**
 * Standalone `MergeView` (side-by-side) component for the rare case where
 * a unified diff isn't enough — e.g. when the diff is large enough that
 * inline deletions are confusing. Uses the official `MergeView` class.
 *
 * NOT wired into the tab system by default; exposed for future use.
 */
export function SideBySideMergeEditor({
  originalText,
  proposedText,
  onAccept,
  onReject,
  className,
}: MergeViewEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<{ a: EditorView b: EditorView } | null>(null)
  const onAcceptRef = useRef(onAccept)
  onAcceptRef.current = onAccept
  const onRejectRef = useRef(onReject)
  onRejectRef.current = onReject

  useEffect(() => {
    if (!hostRef.current) return
    let mounted = true
    const mergeView = new MergeView({
      a: {
        doc: originalText,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          bracketMatching(),
          closeBrackets(),
          indentOnInput(),
          indentUnit.of("  "),
          bonafideTheme,
          python(),
          EditorView.editable.of(false),
        ],
      },
      b: {
        doc: proposedText,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          bracketMatching(),
          closeBrackets(),
          indentOnInput(),
          indentUnit.of("  "),
          bonafideTheme,
          python(),
          keymap.of([
            {
              key: "Mod-Shift-Enter",
              preventDefault: true,
              run: () => {
                acceptChunk(mergeView.b, mergeView.b.state.selection.main.head)
                return true
              },
            },
            {
              key: "Mod-Shift-Backspace",
              preventDefault: true,
              run: () => {
                rejectChunk(mergeView.b, mergeView.b.state.selection.main.head)
                return true
              },
            },
            indentWithTab,
          ]),
        ],
      },
      highlightChanges: true,
      gutter: true,
      parent: hostRef.current,
    })
    viewRef.current = { a: mergeView.a, b: mergeView.b }

    return () => {
      if (!mounted) return
      mounted = false
      mergeView.destroy()
    }
  }, [originalText, proposedText])

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className ?? ""}`}>
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-outline-variant bg-surface-container-lowest px-3">
        <div className="flex items-center gap-2 text-[12px] font-medium text-on-surface-variant">
          <span className="label-caps">Side-by-Side Review</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => {
              const view = viewRef.current
              if (!view) return
              onAcceptRef.current(view.b.state.doc.toString())
            }}
            className="flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium text-primary hover:bg-primary/10"
          >
            Accept All
          </button>
          <button
            onClick={() => onRejectRef.current()}
            className="flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium text-on-surface-variant hover:bg-surface-container"
          >
            Reject All
          </button>
        </div>
      </div>
      <div
        ref={hostRef}
        className="min-h-0 flex-1 overflow-hidden bg-surface"
      />
    </div>
  )
}
