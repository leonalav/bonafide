/// <reference types="vite/client" />
import type { BonafideAPI } from "../ipc/tauri";

declare global {
  interface Window {
    /** Optional handle to the Tauri IPC bridge. Mirrors the old
     * electronAPI shape; see `src/ipc/tauri.ts`. Components should
     * import the typed `bonafide` object directly rather than reading
     * `window.electronAPI`. */
    electronAPI?: BonafideAPI;
  }
}

export {};
