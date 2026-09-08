/**
 * tauri.ts — Renderer-side bridge to the Tauri 2 backend.
 *
 * Direct replacement for `electron/preload.ts`. The old API was a single
 * `window.electronAPI` namespace hung off the renderer via contextBridge.
 * In Tauri we don't need a preload at all — the backend commands are
 * called directly via `invoke()` from `@tauri-apps/api/core`. Plugin
 * commands (file dialogs, etc.) come from `@tauri-apps/plugin-dialog`,
 * etc.
 *
 * To keep the rest of the renderer code unchanged, this module exports a
 * `bonafide` object with the same shape as the old `electronAPI`. The
 * `App.tsx`/EditorPane/etc. files now import the typed `bonafide` object
 * from here and call its methods instead of digging into
 * `window.electronAPI`.
 *
 * Detection: `window.isTauri` is set by Tauri's webview. If absent
 * (running the renderer standalone in `vite dev` without the desktop
 * shell), all methods become no-ops or fall back to in-memory stubs.
 * That lets the existing preview/Storybook workflow keep working.
 */

import { invoke, isTauri as tauriIsTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openExternal } from "@tauri-apps/plugin-shell";

// ── Tauri presence check ───────────────────────────────────────────────────

/**
 * True when the renderer is hosted inside a Tauri webview. False when
 * running standalone (`vite dev`/Figma preview/Storybook).
 *
 * Components can use this to skip desktop-only behavior (custom title
 * bar, native menus) without crashing.
 *
 * Uses `@tauri-apps/api/core`'s own `tauriIsTauri()` detection, which checks
 * for `window.isTauri` — a boolean injected by Tauri's webview at page
 * load time. This is the correct and documented approach.
 */
export { tauriIsTauri as isTauri };

// ── Types — keep camelCase to match the old preload's shape ────────────────

export type AppInfo = {
  version: string;
  name: string;
  platform: NodeJS.Platform;
  arch: string;
  // Tauri-specific fields; older Electron fields are dropped.
  tauri: string;
  webview: string;
  isPackaged: boolean;
  theme: "dark" | "light";
};

export type FileType =
  | "python" | "markdown" | "json" | "typescript" | "tsx"
  | "css" | "yaml" | "toml" | "shell" | "text";

export type FsNode = {
  id: string;
  name: string;
  kind: "folder" | "file";
  parentId: string | null;
  expanded?: boolean;
  fileType: FileType;
};

export type DirListing = {
  rootPath: string;
  rootName: string;
  files: FsNode[];
};

export type OpResult = { ok: boolean; path?: string };

// ── IPC functions ──────────────────────────────────────────────────────────

async function pickFolder(): Promise<string | null> {
  if (!tauriIsTauri()) {
    console.warn("[bonafide] pickFolder called outside Tauri — returning null");
    return null;
  }
  try {
    const result = await openDialog({
      directory: true,
      multiple: false,
      title: "Open folder",
    });
    if (Array.isArray(result)) return result[0] ?? null;
    return result ?? null;
  } catch (err) {
    // Common causes: capability mismatch (window label not "main"), plugin not
    // registered, or CSP blocking the IPC. Log for devtools, return null so
    // the caller (openFolder in App.tsx) can show its own error toast.
    console.error("[bonafide] pickFolder failed:", err);
    return null;
  }
}

async function readDirectory(dirPath: string): Promise<DirListing> {
  return invoke<DirListing>("read_directory", { path: dirPath });
}

async function readFile(filePath: string): Promise<{ content: string }> {
  return invoke<{ content: string }>("read_file", { path: filePath });
}

async function writeFile(filePath: string, content: string): Promise<OpResult> {
  return invoke<OpResult>("write_file", { path: filePath, content });
}

async function createFile(parentDir: string, name: string): Promise<OpResult> {
  return invoke<OpResult>("create_file", { parentDir, name });
}

async function createFolder(parentDir: string, name: string): Promise<OpResult> {
  return invoke<OpResult>("create_folder", { parentDir, name });
}

async function rename(src: string, newName: string): Promise<OpResult> {
  return invoke<OpResult>("rename_path", { src, newName });
}

async function deletePath(target: string): Promise<OpResult> {
  return invoke<OpResult>("delete_path", { target });
}

async function minimize(): Promise<void> {
  if (!tauriIsTauri()) return;
  await getCurrentWindow().minimize();
}

async function toggleMaximize(): Promise<void> {
  if (!tauriIsTauri()) return;
  const w = getCurrentWindow();
  if (await w.isMaximized()) await w.unmaximize();
  else await w.maximize();
}

async function isMaximized(): Promise<boolean> {
  if (!tauriIsTauri()) return false;
  return getCurrentWindow().isMaximized();
}

async function close(): Promise<void> {
  if (!tauriIsTauri()) return;
  await getCurrentWindow().close();
}

/**
 * Subscribe to window maximize/unmaximize events. The Tauri webview
 * emits `tauri://resize` and we derive the bool from comparing the
 * window's current maximized state.
 */
function onMaximizeChanged(cb: (maximized: boolean) => void): () => void {
  if (!tauriIsTauri()) return () => {};
  const w = getCurrentWindow();
  let lastState: boolean | null = null;
  const handler = async () => {
    const m = await w.isMaximized();
    if (m !== lastState) {
      lastState = m;
      cb(m);
    }
  };
  const unlistenResize = w.onResized(handler);
  // Initial sync — fires once if the window starts maximized.
  void handler();
  return async () => {
    await unlistenResize.then((f) => f());
  };
}

async function getInfo(): Promise<AppInfo> {
  if (!tauriIsTauri()) {
    return {
      version: "1.0.0",
      name: "Bonafide",
      platform: "win32",
      arch: "x64",
      tauri: "browser-preview",
      webview: navigator.userAgent,
      isPackaged: false,
      theme: "dark",
    };
  }
  // `tauriIsTauri()` checks for `window.isTauri` — the official flag set by
  // Tauri's webview at load time. When false we know this is the browser
  // preview; when true we know it's the real desktop shell.
  const tauriVersion = tauriIsTauri() ? "2.x" : "browser-preview";
  return {
    version: "1.0.0", // populated at build time by tauri.conf.json
    name: "Bonafide",
    platform: (navigator.platform.toLowerCase().includes("mac")
      ? "darwin"
      : navigator.platform.toLowerCase().includes("linux")
        ? "linux"
        : "win32") as NodeJS.Platform,
    arch: "x64",
    tauri: tauriVersion,
    webview: navigator.userAgent,
    isPackaged: !import.meta.env.DEV,
    theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  };
}

async function shellOpenExternal(url: string): Promise<boolean> {
  if (!tauriIsTauri()) {
    try { window.open(url, "_blank", "noopener"); return true; }
    catch { return false; }
  }
  await openExternal(url);
  return true;
}

// ── Public API — same shape as the old electronAPI ────────────────────────

export const bonafide = {
  window: {
    minimize,
    toggleMaximize,
    isMaximized,
    close,
    onMaximizeChanged,
  },
  shell: {
    openExternal: shellOpenExternal,
  },
  app: {
    getInfo,
  },
  fs: {
    pickFolder,
    readDirectory,
    readFile,
    writeFile,
    createFile,
    createFolder,
    rename,
    delete: deletePath,
  },
};

export type BonafideAPI = typeof bonafide;
