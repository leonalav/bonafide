import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import { ModelsProvider } from "./modelsStore"
import { ChatStoreProvider } from "./chats/ChatStoreProvider"
import "./index.css"

// ── Window-level contextmenu interceptor ────────────────────────────────────
// Tauri's WebView2 shows a *native* context menu (with system "Reload",
// "Back", "Properties", etc.) by default. There is no public config to
// disable it inside the webview. The fix is to suppress the browser's
// default contextmenu at the window level (capture phase, before WebView2
// can route it to the native shell) and dispatch a Bonafide custom event
// the EditorPane / tree context menus can listen for.
//
// Per-surface handlers (CodeMirror, tree, tabs, etc.) still call
// e.preventDefault() locally — the listener below is the safety net for
// any click that lands on a region without its own handler (panels,
// chrome, empty editor area, etc.).
function installContextMenuInterceptor() {
  if (typeof window === "undefined") return
  const target = window as unknown as {
    __bonafideContextMenuInstalled?: boolean
  }
  if (target.__bonafideContextMenuInstalled) return
  target.__bonafideContextMenuInstalled = true

  window.addEventListener(
    "contextmenu",
    (e: MouseEvent) => {
      // Always preventDefault so WebView2 never shows its native menu.
      e.preventDefault()
      // NOTE: do NOT call stopPropagation() here. The capture phase fires
      // BEFORE the target/bubble phases; calling stopPropagation() in the
      // capture phase would prevent the event from ever reaching the
      // per-surface handlers (CodeMirror's `domEventHandlers` extension,
      // the React `onContextMenu` on `<CodeMirror>`, the file-tree
      // `onContextMenu`, the tab strip's `onContextMenu`, etc.) and
      // therefore none of the Bonafide context menus would ever appear.
      // Letting the event continue to bubble lets each surface see it
      // and dispatch its own `ide:*-ctx` custom event with its own
      // coordinates + target metadata. We only need preventDefault here
      // to suppress the WebView2 native context menu — propagation is
      // allowed.
    },
    // Capture phase: fire BEFORE any bubble-phase handler can
    // accidentally allow the event to reach WebView2.
    true,
  )
}
installContextMenuInterceptor()

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ModelsProvider>
      <ChatStoreProvider>
        <App />
      </ChatStoreProvider>
    </ModelsProvider>
  </React.StrictMode>,
)
