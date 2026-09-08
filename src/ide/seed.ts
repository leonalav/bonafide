/**
 * seed.ts — placeholder for the seed-data concept.
 *
 * The IDE used to ship with a hardcoded seed file tree (`SEED_FILE_TREE`)
 * and a pair of tabs (`SEED_TABS`) so the app rendered something on first
 * launch. As of the workspace refactor there is no such thing — the tree
 * comes from the directory the user opens through `bonafide.fs`
 * (the Tauri IPC bridge in `src/ipc/tauri.ts`).
 *
 * This file stays so existing imports keep typechecking. Do **not** add
 * new exports here; if you need to pre-populate anything, do it after
 * `OPEN_WORKSPACE` in the store using real filesystem data.
 *
 * If you want the original demo data back (loss curves, train.py anchors,
 * the bright-mt-7 run etc.), copy it from `src/data/artifacts.ts` into a
 * new `src/data/runs.ts` and re-wire the panels.
 */

export {}
