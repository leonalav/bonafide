import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// Register Monaco web-worker environment BEFORE anything else. This must run
// once at startup so Monaco can spawn its workers when the editor mounts.
import './ide/monaco-env'
import './index.css'

// ── Window-level contextmenu interceptor ────────────────────────────────────
// Tauri's WebView2 shows a *native* context menu (with system "Reload",
// "Back", "Properties", etc.) by default. There is no public config to
// disable it inside the webview. The fix is to suppress the browser's
// default contextmenu at the window level (capture phase, before WebView2
// can route it to the native shell) and dispatch a Bonafide custom event
// the EditorPane / tree context menus can listen for.
//
// Per-surface handlers (Monaco, tree, tabs, etc.) still call
// e.preventDefault() locally — the listener below is the safety net for
// any click that lands on a region without its own handler (panels,
// chrome, empty editor area, etc.).
function installContextMenuInterceptor() {
  if (typeof window === 'undefined') return;
  const target = window as unknown as {
    __bonafideContextMenuInstalled?: boolean;
  };
  if (target.__bonafideContextMenuInstalled) return;
  target.__bonafideContextMenuInstalled = true;

  window.addEventListener(
    'contextmenu',
    (e: MouseEvent) => {
      // Always preventDefault so WebView2 never shows its native menu.
      e.preventDefault();
      e.stopPropagation();
      // Don't dispatch here — per-surface handlers (Monaco, tree, tabs)
      // do that themselves so they can supply their own coordinates
      // and target metadata.
    },
    // Capture phase: fire BEFORE any bubble-phase handler can
    // accidentally allow the event to reach WebView2.
    true,
  );
}
installContextMenuInterceptor();

// ── DEBUG: Long Task Observer ───────────────────────────────────────────────
// Watches for tasks longer than 100ms on the main thread. Long tasks during
// a React render are usually the smoking gun for jank. We log each one
// with start time + duration so we can correlate with user actions.
if (typeof PerformanceObserver !== 'undefined') {
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const url = 'http://127.0.0.1:7750/ingest/8d618420-3b75-4343-9d6c-c42e01f4bae7';
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '5197ca' },
          body: JSON.stringify({
            sessionId: '5197ca',
            id: `log_${Date.now()}`,
            timestamp: Date.now(),
            location: 'main.longTask',
            message: 'long_task',
            data: {
              durationMs: entry.duration.toFixed(2),
              startTimeMs: entry.startTime.toFixed(2),
              name: entry.name,
            },
            runId: 'run2',
            hypothesisId: 'H',
          }),
        }).catch(() => {});
      }
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch {}
}
// ── end DEBUG ──────────────────────────────────────────────────────────────

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// ── Pre-warm Monaco so the first file-open doesn't pay 30+ seconds ──────
// Monaco's editor bundle is huge (5,000+ internal AMD modules). On Tauri +
// Windows + WebView2 + Vite dev mode, loading Monaco the first time takes
// 30-40 seconds because the WebView has to fetch + parse every chunk.
// Without this pre-warm, the user's first file click spends most of its
// time on Monaco init, blocking everything else on the main thread —
// including our own IPC reads.
//
// We schedule the pre-warm via `requestIdleCallback` so it runs after
// the app has finished its first render, when the browser would
// otherwise be sitting idle. By the time the user clicks a file,
// Monaco's bundle is already in memory and the editor mounts in
// milliseconds.
//
// We deliberately import from the top-level `monaco-editor` entry
// (which is part of the package's `exports` map and pre-bundled by
// Vite's `optimizeDeps`) rather than the deep `vs/editor/editor.api`
// path that's outside the exports map.
if (typeof window !== 'undefined') {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  const scheduleIdle: (cb: () => void) => void = ric
    ? (cb) => ric(cb, { timeout: 5000 })
    : (cb) => setTimeout(cb, 1500);
  scheduleIdle(() => {
    import('monaco-editor').then((m) => {
      // Touch the editor API so the view/worker code paths are pulled
      // in. Without this, the view code only loads on the first
      // .create() call, which is exactly what we're trying to avoid.
      try { void m.editor; } catch {}
    }).catch(() => {});
  });
}
