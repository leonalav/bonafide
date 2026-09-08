# Electron wrapper report for `bonafide`

**Research date:** 7 September 2026. Package versions below are current npm registry observations and should be pinned/lockfile-tested before release.

## 1. Recommended approach

Use **`vite-plugin-electron` 1.1.2 + `vite-plugin-electron-renderer` 1.0.0** for this project. It is a thin integration over the existing Vite configuration, supports Vite 8 (`vite-plugin-electron` declares `vite >=6`), and lets the existing React/Tailwind/Figma plugins remain in place. Its simple API builds the main/preload entry and starts/restarts Electron from Vite's lifecycle.

`electron-vite` is a good alternative for a new app with separate `electron/main`, `electron/preload`, and renderer configs. The current npm release observed was **5.0.0**, but its peer range is `vite ^5 || ^6 || ^7`; it does not formally support Vite 8. Do not force-install it with this Vite 8 app without either downgrading Vite or accepting an unverified peer mismatch. Neither integration is React- or Tailwind-specific: both run the renderer through normal Vite, so React 19 and Tailwind v4 are compatible in principle.

Electron 44.2.0 is current in the registry and is an appropriate modern target for a Node 22 development environment. The Node version used to install/run the toolchain and Electron's embedded Node version are separate. Pin Electron rather than using a floating major, and test the exact embedded runtime. Electron's ecosystem has moved to Node 22 as a minimum for many `@electron/*` packages; Node 22 is therefore the correct CI/developer baseline.

## 2. Packages to add

Recommended:

```text
npm i -D electron@44.2.0 vite-plugin-electron@1.1.2 vite-plugin-electron-renderer@1.0.0 electron-builder@26.15.3 concurrently@9.2.1 wait-on@9.0.1
npm i electron-log@5.4.4
```

Use `@electron/rebuild@4.2.0` only when a dependency contains native addons (SQLite, node-pty, sharp, etc.); it is not required for React, Tailwind, or ordinary TypeScript. Add `npm-run-all` instead of `concurrently` only if that is already a project convention.

## 3. `package.json` changes

Keep React 19, Tailwind 4, Vite 8, and TypeScript 5.7. Add scripts:

```json
{
  "scripts": {
    "dev": "concurrently -k \"vite --host 127.0.0.1\" \"wait-on http://127.0.0.1:8443 && electron .\"",
    "build": "vite build && electron-builder",
    "build:renderer": "vite build",
    "package": "npm run build",
    "preview": "vite preview",
    "format": "oxfmt"
  },
  "main": "dist-electron/main.js",
  "build": {
    "appId": "com.bonafide.app",
    "productName": "Bonafide",
    "files": ["dist/**/*", "dist-electron/**/*", "package.json"],
    "win": { "target": [{ "target": "nsis", "arch": ["x64"] }] },
    "mac": { "target": ["dmg"] },
    "nsis": { "oneClick": false, "perMachine": false, "allowToChangeInstallationDirectory": true }
  }
}
```

For development, `main` may point at `dist-electron/main.js`; the plugin's `onstart` callback launches the generated entry. Do not ship source maps unless intentionally needed.

## 4. New files

- `electron/main.ts`: creates the `BrowserWindow`, loads the dev URL or packaged `dist/index.html`, owns native dialogs/filesystem/shell, and registers validated IPC handlers.
- `electron/preload.ts`: runs in the isolated preload world and exposes a narrow `window.electronAPI` via `contextBridge`.
- Optional `electron/env.ts`: main-process environment/config parsing. Never expose secrets through renderer Vite variables.
- Optional `electron/log.ts`: configures `electron-log` and file-level diagnostics.

## 5. `vite.config.ts`

Keep React, Tailwind, alias, and Figma plugins. Add the Electron plugin after the existing plugins (or at least after plugins whose ordering is significant):

```ts
import electron from "vite-plugin-electron/simple";
import renderer from "vite-plugin-electron-renderer";

export default defineConfig(({ mode }) => ({
  base: mode === "development" ? "/" : "./",
  plugins: [
    react(),
    tailwindcss(),
    figmaSiteConfiguration(),
    figmaErrorOverlayReplay(),
    figmaReactRefreshBoundaryFallback(),
    figmaMakeKitPlugin(),
    electron({
      main: { entry: "electron/main.ts" },
      preload: { input: "electron/preload.ts" },
      onstart(options) { options.startup(); }
    }),
    renderer()
  ],
  // retain resolve.alias and existing build options
}));
```

The exact `simple` export/API should be checked against the installed package's TypeScript declarations. If its version does not accept `preload` in the simple API, use the documented array API or build preload with a second `electron()` entry. Vite's current `base` derived from `FIGMA_PUBLIC_URL` is unsuitable for a packaged `file://` app when it is an absolute hosted path. Gate it: use `/` during dev, `./` for packaged builds, and reserve `FIGMA_PUBLIC_URL` for Figma deployment mode.

Do not pass the Figma-only dev server or overlay assumptions into production. Guard custom Figma plugins with an environment flag if they expect a browser/Figma host; retain them in renderer development only if they work under Electron's localhost origin.

## 6. `index.html`

No structural change is required. Keep the `#root` element and module script. Use root-relative or Vite-managed asset references, not hard-coded `/assets/...` URLs; `base: "./"` rewrites bundled asset URLs for `file://` loading. Add a CSP meta tag after validating all required scripts/styles, for example: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:8443 https:`. Avoid `unsafe-eval`; Vite dev/HMR may need a development-only CSP exception.

## 7. Minimal working example

```ts
// electron/main.ts
import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";

const isDev = !app.isPackaged;
function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  if (isDev) win.loadURL("http://127.0.0.1:8443");
  else win.loadFile(path.join(__dirname, "../dist/index.html"));
}
app.whenReady().then(() => {
  ipcMain.handle("workspace:pick", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });
  createWindow();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
```

```ts
// electron/preload.ts
import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("electronAPI", {
  pickWorkspace: () => ipcRenderer.invoke("workspace:pick")
});
```

```ts
// relevant vite.config.ts additions
import electron from "vite-plugin-electron/simple";
// plugins: [...existingPlugins, electron({ main: { entry: "electron/main.ts" } })]
```

Declare `window.electronAPI` in `src/types/electron.d.ts`; renderer code should call only these typed methods, never import `electron`, `fs`, or `child_process`.

## 8. Security checklist

- Keep `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true` where compatible.
- Expose one operation per IPC method; validate every argument in the main process and never expose raw `ipcRenderer`.
- Restrict navigation with `will-navigate`/`setWindowOpenHandler`; open external links with `shell.openExternal` after URL allow-list validation.
- Use a strict production CSP and HTTPS for remote connections. Do not use remote code or `eval`.
- Keep tokens, API keys, filesystem paths, and main-process environment values out of `VITE_*` variables and renderer bundles.
- Store secrets in OS-appropriate secure storage (for example, `safeStorage`) rather than plain localStorage.
- Enable signing/notarization before distribution; publish update metadata only over HTTPS.
- Add `electron-log` in main/preload and redact credentials and sensitive file contents.

## 9. Project-specific pitfalls and workarounds

- **Custom TitleBar:** choose one model. The lowest-risk first release uses a normal native frame and removes/hides the custom TitleBar. A custom title bar requires `frame: false`, `titleBarOverlay`/platform-specific window controls, `-webkit-app-region: drag`, and `no-drag` on every button; it also requires implementing minimize/maximize/close IPC and accessibility. macOS `titleBarStyle: "hidden"` differs from Windows and is not a cross-platform substitute.
- **Keyboard shortcuts:** Electron does not normally prevent `window` keydown events in the renderer. Ctrl/Cmd+E will work unless a menu accelerator, focused text input, DevTools, or another handler consumes it. For app-global shortcuts use a main-process `globalShortcut`; for app-local commands use renderer keydown plus an allow-list and `preventDefault()` only when appropriate.
- **React 19:** no known Electron-specific incompatibility. React runs in Chromium; test the exact Electron Chromium version and avoid depending on browser APIs newer than it.
- **Tailwind v4:** it is compiled by Vite into ordinary CSS and needs no Electron-specific package. Check that all classes are statically discoverable and that packaged CSS URLs are relative. Avoid runtime-generated class names.
- **Native modules:** rebuild against the exact Electron ABI with `@electron/rebuild`, and ensure electron-builder's install-app-deps step runs. Prefer pure-JS dependencies where possible.
- **Figma plugins:** these may assume `FIGMA_PUBLIC_URL`, Figma Make overlays, or a browser-only origin. Gate them by `mode`/`app.isPackaged`; do not let Figma dev overlays ship in production.
- **Filesystem:** all `fs`, child process, Git, watcher, and dialog operations belong in main; preload should expose typed, minimal calls. The existing planned workspace/Git features map naturally to IPC handlers.
- **Dev startup:** the fixed `8443` port is convenient, but avoid a collision by selecting an available port or passing the actual Vite URL from the plugin's startup callback. HMR is normal Vite WebSocket HMR over localhost; packaged builds load `file://` and have no HMR.

## 10. Packaging comparison

`electron-builder` 26.15.3 is recommended here: concise JSON/YAML configuration, mature NSIS and DMG targets, signing/notarization hooks, and auto-update ecosystem. Electron Forge is a strong all-in-one alternative and is particularly attractive for a new Electron-native project, but adds Forge-specific makers/plugins and would require reshaping this Vite app around Forge conventions. Do not use both packagers.

Run `npm run build` on each target OS. Confirm the artifact contains `dist/index.html`, hashed CSS/JS assets, `dist-electron/main.js`, and preload output. Test a clean installed build, not only the unpacked directory; test dialogs, shortcuts, filesystem access, external links, and window controls.

## Sources

- [electron-vite](https://electron-vite.org) and [electron-vite npm](https://www.npmjs.com/package/electron-vite)
- [vite-plugin-electron GitHub](https://github.com/electron-vite/vite-plugin-electron)
- [Electron Node 22 ecosystem announcement](https://www.electronjs.org/blog/ecosystem-node-22)
- [Electron release timeline](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)
- [electron-builder configuration](https://www.electron.build/docs/configuration)
- [electron-builder NSIS options](https://www.electron.build/v26/docs/nsis)
