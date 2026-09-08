import { readFileSync, mkdirSync, cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Plugin } from "vite";

// Subpaths under monaco-editor/esm/vs/ that we expose as virtual modules.
const WORKER_PATHS = [
  "editor/editor.worker",
  "language/json/json.worker",
  "language/css/css.worker",
  "language/html/html.worker",
  "language/typescript/ts.worker",
] as const;

// Output directory for the Monaco `esm/vs/` tree.
// Files are copied here at build/startup so the browser can load them
// as same-origin module workers. The relative `import "../..."` paths
// inside Monaco's workers resolve correctly because the full tree is
// mirrored under public/monaco-workers/.
const WORKER_OUT_DIR = "public/monaco-workers";

// Virtual module prefix — maps bare `monaco-editor/esm/vs/X/worker`
// specifiers to a virtual module that exports the static asset's URL.
const VIRTUAL_PREFIX = "\0virtual:monaco-worker:";
const SPECIFIER_RE = new RegExp(
  `^monaco-editor/esm/vs/(${[...WORKER_PATHS].join("|")})$`,
);

export function monacoWorkersPlugin(): Plugin {
  let monacoVersion = "unknown";
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const projectRoot = path.resolve(path.dirname(thisFile), "..", "..");
    const pkg = JSON.parse(
      readFileSync(
        path.join(projectRoot, "node_modules", "monaco-editor", "package.json"),
        "utf8",
      ),
    ) as { version?: string };
    monacoVersion = pkg.version ?? "unknown";
  } catch { /* best-effort */ }

  // ── Worker tree builder ─────────────────────────────────────────────────
  // Finds the real monaco-editor esm/vs/ root (works with pnpm hoisting)
  // and copies the whole tree to public/monaco-workers/. The copy is a
  // one-time cost; a .built marker prevents repeated copies on HMR.
  async function buildWorkerTree(): Promise<void> {
    const thisFile = fileURLToPath(import.meta.url);
    const projectRoot = path.resolve(path.dirname(thisFile), "..", "..");
    const markerFile = path.join(projectRoot, WORKER_OUT_DIR, ".built");

    if (existsSync(markerFile)) return;

    // Walk up to find the real monaco-editor (pnpm may hoist differently).
    let monacoRoot = "";
    let dir = projectRoot;
    while (dir && dir !== path.dirname(dir)) {
      const candidate = path.join(
        dir,
        "node_modules",
        "monaco-editor",
        "esm",
        "vs",
      );
      if (existsSync(path.join(candidate, "editor", "editor.worker.js"))) {
        monacoRoot = candidate;
        break;
      }
      dir = path.dirname(dir);
    }
    if (!monacoRoot) return;

    const outDir = path.join(projectRoot, WORKER_OUT_DIR);
    if (existsSync(outDir)) rmSync(outDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });

    try {
      cpSync(monacoRoot, outDir, {
        recursive: true,
        filter: (src) => {
          const base = path.basename(src);
          // Skip .d.ts, test, and hidden files.
          if (base.endsWith(".d.ts")) return false;
          if (base.endsWith(".test.js")) return false;
          if (base.startsWith(".")) return false;
          return true;
        },
      });
      // Write the marker so we skip on subsequent (HMR) starts.
      writeFileSync(markerFile, "1");
    } catch (err) {
      console.warn("[bonafide-monaco-workers] copy failed:", err);
    }
  }

  return {
    name: "bonafide-monaco-workers",
    enforce: "pre",

    // Serve monaco-workers as static files from the public directory.
    configureServer(server) {
      // Register the public directory path so Vite serves the files.
      // No additional middleware needed — Vite serves public/ files
      // from the project root automatically.
    },

    // Dev: build once on first start.
    async buildStart() {
      await buildWorkerTree();
    },

    // Resolve: map bare `monaco-editor/esm/vs/...` to our virtual module.
    resolveId(id: string) {
      const m = id.match(SPECIFIER_RE);
      if (!m) return null;
      return VIRTUAL_PREFIX + m[1];
    },

    // Load: virtual module exports the public URL of the static asset.
    // Vite rewrites `new URL(..., import.meta.url)` to the actual URL
    // at build time. In dev, the browser fetches the file from
    // /monaco-workers/... and Vite's public-file middleware serves it.
    load(id: string) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      const sub = id.slice(VIRTUAL_PREFIX.length);
      const outName = `${sub.replace(/\//g, "_")}.js`;
      return `export default new URL('./monaco-workers/${outName}', import.meta.url).href;\n`;
    },

    // Version placeholder injection.
    transform(code: string, id: string) {
      if (id.endsWith("monaco-env.ts") && code.includes("MONACO_VERSION_INJECTED")) {
        return code.replace(
          /declare const MONACO_VERSION_INJECTED: string;/,
          `const MONACO_VERSION_INJECTED: string = ${JSON.stringify(monacoVersion)};`,
        );
      }
      return null;
    },
  };
}
