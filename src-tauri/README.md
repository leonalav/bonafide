# src-tauri/

Tauri 2 backend for Bonafide. This replaces the previous Electron shell —
direct port of `electron/main.ts` and `electron/preload.ts`.

## Layout

```
src-tauri/
├── Cargo.toml          — Rust dependencies (tauri 2, dialog/fs/shell plugins)
├── build.rs            — tauri-build entry
├── tauri.conf.json     — Window, bundle, dev URL configuration
├── capabilities/
│   └── default.json    — Tauri 2 capability permissions
├── src/
│   ├── main.rs         — Thin shim → lib::run()
│   └── lib.rs          — All `#[tauri::command]` handlers + setup hook
└── icons/              — Generated via `pnpm tauri icon <src.png>`
```

## Commands

```bash
pnpm dev:desktop        # tauri dev (spawns vite + the Rust binary)
pnpm build              # vite build only (renderer)
pnpm package            # tauri build (production .msi/.dmg/.AppImage/.deb)
pnpm package:dir        # tauri build --debug (unpackaged build for testing)
```

## IPC surface

All commands are declared in `src/lib.rs` via `tauri::generate_handler![...]`:

| Renderer call                              | Rust command         | Notes                                     |
| ------------------------------------------ | -------------------- | ----------------------------------------- |
| `bonafide.fs.pickFolder()`                 | `@tauri/plugin-dialog` `open`  | Native folder picker; no Rust code needed  |
| `bonafide.fs.readDirectory(path)`          | `read_directory`     | Same dir-walker semantics as Electron     |
| `bonafide.fs.readFile(path)`               | `read_file`          | utf-8 text only                           |
| `bonafide.fs.writeFile(path, content)`     | `write_file`         | Creates parent dirs if missing            |
| `bonafide.fs.createFile(parent, name)`    | `create_file`        | Empty file                                |
| `bonafide.fs.createFolder(parent, name)`  | `create_folder`      |                                           |
| `bonafide.fs.rename(src, newName)`        | `rename_path`        |                                           |
| `bonafide.fs.delete(target)`              | `delete_path`        | Recursive on directories                  |
| `bonafide.window.minimize/toggleMaximize/…` | plugin-window        | Tauri 2 plugin                            |
| `bonafide.shell.openExternal(url)`        | plugin-shell         | Default browser                           |

## Renderer bridge

The renderer talks to the Rust commands via the typed `bonafide` object
in `src/ipc/tauri.ts`. That module wraps:

- `@tauri-apps/api/core#invoke` (our custom commands)
- `@tauri-apps/plugin-dialog` (folder picker)
- `@tauri-apps/api/window` (window controls)
- `@tauri-apps/plugin-shell` (external links)

In dev (`pnpm dev:desktop`) the renderer runs in WebView2 and reaches
the Rust binary through `tauri://localhost`. In browser preview (`pnpm dev`)
the IPC bridge detects the absence of `window.__TAURI__` and falls back
to no-ops — useful for Storybook / Figma preview but desktop-only
features will be inert.

## Capabilities

`capabilities/default.json` allows the main window to use only the
operations actually needed: `dialog:default`, a small set of `fs:allow-*`
granular permissions, and `shell:allow-open`. The full file system is
NOT exposed by default — if you add a new command that touches the
filesystem outside the workspace, you'll need to widen the scope here
or your command will get a Tauri permission error at runtime.
