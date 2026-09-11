/**
 * lsp-client.ts — LSP client manager for Bonafide.
 *
 * Creates and caches LanguageServerClient instances keyed by `file://<workspace>`
 * URI. Each client connects over WebSocket to the Rust bridge, which spawns
 * the LSP child process (pyright-langserver or ruff server) and relays
 * JSON-RPC messages between browser and stdin/stdout.
 *
 * The Rust bridge URL is fixed at `ws://127.0.0.1:9877` — see
 * `src-tauri/src/lib.rs` and `src-tauri/src/lsp_bridge.rs`.
 *
 * Lifecycle:
 *   - getOrCreateClient(uri) returns a singleton client per workspace URI.
 *   - Clients are reused across file switches in the same workspace.
 *   - closeClient() is called when the workspace is closed.
 */

import {
  LanguageServerClient,
  WebSocketTransport,
} from "@marimo-team/codemirror-languageserver"
import { invoke, isTauri as tauriIsTauri } from "@tauri-apps/api/core"

const BRIDGE_PORT = 9877

// `LanguageServerOptions` lives in `lsp.d.ts` but isn't re-exported from
// the package's `index.d.ts`. We re-declare the shape we need locally;
// the LSP plugin only reads these fields by name at runtime.
type LanguageServerOptions = {
  client: LanguageServerClient
  documentUri?: string
  languageId?: string
  diagnosticsEnabled?: boolean
  hoverEnabled?: boolean
  completionEnabled?: boolean
  definitionEnabled?: boolean
  renameEnabled?: boolean
  codeActionsEnabled?: boolean
  signatureHelpEnabled?: boolean
  signatureActivateOnTyping?: boolean
  sendIncrementalChanges?: boolean
  clientSideFiltering?: boolean
  allowHTMLContent?: boolean
}

/** Convert an absolute filesystem path to a `file://` URI. */
export function pathToUri(absPath: string): string {
  // On Windows: "C:/Users/foo/bar.py" → "file:///C:/Users/foo/bar.py"
  // On POSIX:   "/home/foo/bar.py"    → "file:///home/foo/bar.py"
  const normalized = absPath.replace(/\\/g, "/")
  if (normalized.startsWith("/")) {
    return `file://${normalized}`
  }
  // Drive-letter path: prepend an extra slash.
  return `file:///${normalized}`
}

/** Convert a `file://` URI back to a filesystem path. */
export function uriToPath(uri: string): string {
  // "file:///C:/Users/foo" → "C:/Users/foo"
  if (uri.startsWith("file:///")) {
    const path = uri.slice("file:///".length)
    return path.startsWith("/") ? path : "/" + path
  }
  if (uri.startsWith("file://")) {
    return uri.slice("file://".length)
  }
  return uri
}

type ServerKind = "pyright" | "ruff"

/**
 * A cached LSP client and its metadata. We keep one client per (server kind,
 * workspace URI) pair so file switches don't re-initialize the language
 * server.
 */
type ClientEntry = {
  client: LanguageServerClient
  serverKind: ServerKind
  workspaceRoot: string
  /** Promise that resolves once `initialize` has completed. */
  ready: Promise<void>
}

const clientCache = new Map<string, ClientEntry>()

function cacheKey(serverKind: ServerKind, rootUri: string): string {
  return `${serverKind}:${rootUri}`
}

/** Cache the LSP bridge URL once fetched from the backend. */
let bridgeUrlPromise: Promise<string> | null = null

/** Get the WebSocket bridge URL from the Tauri backend. */
export async function getBridgeUrl(): Promise<string> {
  if (bridgeUrlPromise) return bridgeUrlPromise
  bridgeUrlPromise = (async () => {
    if (tauriIsTauri()) {
      try {
        return await invoke<string>("get_lsp_bridge_url")
      } catch {
        // Fall through to default URL.
      }
    }
    return `ws://127.0.0.1:${BRIDGE_PORT}`
  })()
  return bridgeUrlPromise
}

const DEFAULT_PYRIGHT_OPTS: Partial<LanguageServerOptions> = {
  diagnosticsEnabled: true,
  hoverEnabled: true,
  completionEnabled: true,
  definitionEnabled: true,
  renameEnabled: true,
  codeActionsEnabled: true,
  signatureHelpEnabled: true,
  // Don't show signature help on every keystroke — only when explicitly
  // requested via the LSP plugin's signatureHelp keybinding.
  signatureActivateOnTyping: false,
  sendIncrementalChanges: true,
  clientSideFiltering: true,
  allowHTMLContent: false,
}

/**
 * Get or create an LSP client for the given workspace root URI.
 * Returns null if the client could not be created (e.g. bridge not reachable).
 */
export async function getOrCreateClient(
  serverKind: ServerKind,
  workspaceRoot: string,
): Promise<{ client: LanguageServerClient ready: Promise<void> } | null> {
  const rootUri = pathToUri(workspaceRoot)
  const key = cacheKey(serverKind, rootUri)
  const existing = clientCache.get(key)
  if (existing) {
    return { client: existing.client, ready: existing.ready }
  }

  try {
    const bridgeUrl = await getBridgeUrl()
    // Server URL encodes both the server kind and the workspace root.
    // The Rust bridge uses the path to decide which LSP process to spawn
    // (pyright vs ruff) and the rootUri from the initialize request to
    // bucket per-workspace processes.
    const serverUri = `${bridgeUrl}/${serverKind}` as const
    const transport = new WebSocketTransport(serverUri)
    const client = new LanguageServerClient({
      rootUri,
      workspaceFolders: [
        {
          uri: rootUri,
          name: workspaceRoot.split(/[\\/]/).pop() ?? "workspace",
        },
      ],
      transport,
    })
    const ready = client.initialize()

    clientCache.set(key, {
      client,
      serverKind,
      workspaceRoot,
      ready,
    })
    return { client, ready }
  } catch (err) {
    console.error(
      `[lsp] Failed to create ${serverKind} client for ${workspaceRoot}:`,
      err,
    )
    return null
  }
}

/** Get a cached client (does not create one). */
export function getClient(
  serverKind: ServerKind,
  workspaceRoot: string,
): LanguageServerClient | null {
  const rootUri = pathToUri(workspaceRoot)
  const key = cacheKey(serverKind, rootUri)
  return clientCache.get(key)?.client ?? null
}

/** Close and remove a single LSP client. */
export function closeClient(
  serverKind: ServerKind,
  workspaceRoot: string,
): void {
  const rootUri = pathToUri(workspaceRoot)
  const key = cacheKey(serverKind, rootUri)
  const entry = clientCache.get(key)
  if (entry) {
    entry.client.close()
    clientCache.delete(key)
  }
}

/** Close all LSP clients (e.g. on app shutdown). */
export function closeAllClients(): void {
  for (const entry of clientCache.values()) {
    entry.client.close()
  }
  clientCache.clear()
}

/**
 * Resolve the URI of a file inside the workspace. Used by
 * `languageId`/`documentUri` config when the editor mounts.
 */
export function documentUriFor(
  workspaceRoot: string,
  filePath: string,
): string {
  // filePath can be a relative path (e.g. "src/main.py") or absolute.
  // If absolute, convert directly. If relative, join with workspace root.
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("/")) {
    return pathToUri(filePath)
  }
  return pathToUri(`${workspaceRoot}/${filePath}`)
}

/** Build the `LanguageServerOptions` for an editor mount. */
export function buildLspOptions(
  client: LanguageServerClient,
  workspaceRoot: string,
  filePath: string,
): LanguageServerOptions {
  return {
    client,
    documentUri: documentUriFor(workspaceRoot, filePath),
    languageId: "python",
    ...DEFAULT_PYRIGHT_OPTS,
  }
}
