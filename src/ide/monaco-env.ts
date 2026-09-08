/**
 * monaco-env.ts — Monaco Editor runtime configuration for Bonafide.
 *
 * Two responsibilities:
 *   1. Provide the MonacoEnvironment.getWorker() shim that returns
 *      Web Workers built from Monaco's language-service worker scripts.
 *   2. Hand the bundled `monaco-editor` instance to the
 *      `@monaco-editor/react` loader so the React component uses our
 *      installed copy instead of fetching from a CDN.
 *
 * Workers are loaded via the virtual module pattern:
 *   import url from "monaco-editor/esm/vs/editor/editor.worker"
 * The vite-plugin-monaco-workers plugin maps that specifier to a
 * virtual module that returns `new URL('./monaco-workers/editor/editor.worker.js', import.meta.url).href`.
 * Vite then rewrites that to the actual static asset's public URL.
 * The plugin also copies the entire monaco-editor esm/vs/ tree into
 * public/monaco-workers/ at build time, preserving the relative import
 * paths Monaco's workers use internally (e.g. `../base/...`).
 */

import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

// ── Worker entry points ───────────────────────────────────────────────────────
// Vite rewrites the URL in each virtual module to the actual static asset.
// Since the plugin copies the full esm/vs/ tree to public/monaco-workers/,
// the workers' internal ESM `import "../..."` statements resolve correctly
// at runtime (served from the same origin as the app).
import editorWorkerUrl from "monaco-editor/esm/vs/editor/editor.worker";
import jsonWorkerUrl from "monaco-editor/esm/vs/language/json/json.worker";
import cssWorkerUrl from "monaco-editor/esm/vs/language/css/css.worker";
import htmlWorkerUrl from "monaco-editor/esm/vs/language/html/html.worker";
import tsWorkerUrl from "monaco-editor/esm/vs/language/typescript/ts.worker";

const WORKER_URLS: Record<string, string> = {
  // All language-specific workers are intentionally routed to the
  // generic editor worker. The TS/JS language-service workers
  // (typescript.worker, json.worker, css.worker, html.worker) ship
  // with their own multi-megabyte ESM dependency trees that have to
  // be fetched + parsed on first use. In dev mode (Vite serving
  // those modules one-by-one over HTTP) this first use takes
  // 25-35 SECONDS on a Tauri+WebView2+Windows machine — the worker
  // bootstrap blocks the main thread for that entire window.
  //
  // Routing all language labels to the editor worker gives us full
  // syntax highlighting and tokenizer support without spinning up
  // the heavy language services. We trade semantic highlighting,
  // bracket pair colorization, and TS intellisense for a startup
  // that's measured in milliseconds instead of tens of seconds.
  // Bonafide is an editor, not a full IDE — text editing + syntax
  // coloring is what we actually need.
  json: editorWorkerUrl,
  css: editorWorkerUrl,
  scss: editorWorkerUrl,
  less: editorWorkerUrl,
  html: editorWorkerUrl,
  handlebars: editorWorkerUrl,
  razor: editorWorkerUrl,
  typescript: editorWorkerUrl,
  javascript: editorWorkerUrl,
  _editor: editorWorkerUrl,
};

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: (workerId: string, label: string) => Worker;
    };
  }
}

if (typeof window !== "undefined" && !window.MonacoEnvironment) {
  window.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      const workerUrl = WORKER_URLS[label] ?? WORKER_URLS._editor;
      // Vite replaces `new URL(..., import.meta.url).href` with the
      // actual static asset URL at build time. Module workers
      // (type: 'module') support ESM import/export, so Monaco's internal
      // cross-worker message routing works correctly.
      return new Worker(workerUrl, { type: "module" });
    },
  };
}

// Use the bundled monaco-editor package instead of the CDN.
loader.config({ monaco });

// Re-export the installed Monaco version. The vite plugin
// (vite-plugin-monaco-workers.ts) replaces the placeholder at build
// time with the version string from monaco-editor's package.json.
declare const MONACO_VERSION_INJECTED: string;
export const MONACO_VERSION: string = MONACO_VERSION_INJECTED;
