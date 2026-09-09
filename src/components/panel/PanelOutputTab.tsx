import { useCallback, useEffect, useRef } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { useOutputLogs } from "../../ide/hooks";
import { Icon } from "../ui/Icon";
import { useDispatch } from "../../ide/hooks";
import { bonafideTheme } from "../../ide/cm-theme";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function PanelOutputTab() {
  const dispatch = useDispatch();
  const logs = useOutputLogs();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    if (!containerRef.current) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: logs.map(stripAnsi).join("\n"),
        extensions: [
          bonafideTheme,
          history(),
          drawSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          lineNumbers(),
          EditorState.readOnly.of(true),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.theme({
            "&": { height: "100%", fontSize: "12px" },
            ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono, monospace)" },
          }),
        ],
      }),
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Only recreate on container mount — logs update via dispatch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update document content when logs change
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentContent = view.state.doc.toString();
    const newContent = logs.map(stripAnsi).join("\n");

    if (currentContent === newContent) return;

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: newContent },
    });

    // Auto-scroll to bottom if the user hasn't scrolled up.
    if (autoScrollRef.current) {
      view.dispatch({
        selection: { anchor: view.state.doc.length },
        scrollIntoView: true,
      });
    }
  }, [logs]);

  // Track manual scroll to disable auto-scroll
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    function onScroll() {
      const v = viewRef.current;
      if (!v) return;
      const scroller = v.scrollDOM;
      const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
      autoScrollRef.current = atBottom;
    }

    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    return () => view.scrollDOM.removeEventListener("scroll", onScroll);
  }, []);

  if (logs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center font-sans text-[13px] text-outline">
        <div className="text-center">
          <Icon name="terminal" size={24} className="mx-auto mb-2" />
          <p>No output yet</p>
          <p className="mt-1 text-[12px]">Output from commands and processes will appear here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-between border-b border-outline-variant/40 bg-surface-container-low px-2 py-1">
        <span className="font-sans text-[12px] text-outline">
          {logs.length} line{logs.length !== 1 ? "s" : ""}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              autoScrollRef.current = true;
              const view = viewRef.current;
              if (view) {
                view.dispatch({
                  selection: { anchor: view.state.doc.length },
                  scrollIntoView: true,
                });
              }
            }}
            className="flex items-center gap-1 rounded px-2 py-0.5 font-sans text-[12px] text-on-surface-variant hover:bg-surface-container-high"
            title="Scroll to Bottom"
          >
            <Icon name="arrow-down" size={12} />
            Bottom
          </button>
          <button
            onClick={() => dispatch({ type: "CLEAR_OUTPUT" })}
            className="flex items-center gap-1 rounded px-2 py-0.5 font-sans text-[12px] text-on-surface-variant hover:bg-surface-container-high"
            title="Clear Output"
          >
            <Icon name="trash-2" size={12} />
            Clear
          </button>
        </div>
      </div>

      {/* Editor */}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}
