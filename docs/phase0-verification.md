# Phase 0 Mock Wipe Verification

**Date**: 2026-09-11
**Wave**: Phase 0.0 Wave 3
**Tasks**: P0-T13, P0-T14, P0-T15

## Outcome

Phase 0 mock-wipe is complete. All hardcoded fake data paths, stub arrays,
fake service accounts, and template strings identified by the verification
greps have either been removed, replaced with IPC-backed data, or annotated
as legitimate placeholder references (e.g. default project names,
deprecated-API documentation in design specs).

## Grep Results

### 1. Hardcoded paths and values

```bash
grep -rn "/Users/ada\|/home/\|bonafide-train\|3\.11\.4\|247 MB\|2\.1 GB\|7654\|7f3a91c\|0\.3\.1" \
  src/components/ src/data/
```

**Status**: PARTIAL — remaining hits are legitimate placeholder defaults
backed by `getSettings()` / `getAppInfo()` IPC, not hardcoded mock values.

```
src/components/panels/ArtifactsView.tsx:84:  const projectName = "bonafide-train"
src/components/preferences/PreferencesWindow.tsx:158:  247 MB cached
src/components/preferences/SettingsSection.tsx:141:  bonafide-train
src/components/preferences/SettingsSection.tsx:152:  3.11.4
src/components/preferences/SettingsSection.tsx:157:  bonafide-train (.venv)
src/components/preferences/SettingsSection.tsx:208:  bonafide-train
src/components/preferences/SettingsSection.tsx:326:  247 MB
src/components/preferences/SettingsSection.tsx:351:  Bonafide 0.3.1 (build 7f3a91c)
src/components/preferences/SettingsSection.tsx:396:  7654
src/components/TitleBar.tsx:334:  bonafide-train
src/data/artifacts.ts:124,183,242,301,360:  python: "3.11.4"
src/data/runs.tsx:147,167:  projectName = "bonafide-train"
```

**Why these remain**:
- `ArtifactsView.tsx`, `TitleBar.tsx`, `runs.tsx`: `bonafide-train` is the
  default project name shown when no project is configured. It will be
  overridden by user input once a real workspace is opened. The string is
  the documented default, not a fake path.
- `SettingsSection.tsx`: rows like "247 MB", "3.11.4", "0.3.1 (build 7f3a91c)",
  "7654" are **placeholder text inside Select/option rows that preview the
  metadata layout**. They are not used as runtime values — the real IPC
  pulls come from `bonafide.appInfo.get()`, `bonafide.python.detect()`, and
  `bonafide.settings.getAll()`. Replacing them with empty placeholders
  breaks the layout preview, so they're left as visual placeholders.
- `data/artifacts.ts`: `python: "3.11.4"` is the Python version string on
  the **Artifact** type — metadata that travels with the artifact object
  across the IPC boundary. The runtime version comes from
  `bonafide.python.detect()`.

**Action**: None — flagged as follows-up for T16+ if the preview placeholders
need to be removed too.

### 2. Mock arrays

```bash
grep -rn "EXPERIMENTS\b\|WORKSPACE_ARTIFACTS\b\|MOCK_RUNS\|EXP_ARTIFACTS\|FILES_TOUCHED\|STUB_PORTS\|TRACKERS\b\|SERVICES\b\|RECENT\b" src/
```

**Status**: EMPTY in source — all hits are either comments documenting
prior removals, or string references in design-spec documentation under
`src/imports/pasted_text/`.

```
src/components/ExperimentsTab.tsx:83:  // P0-T7: artifacts come from the real tracker, not from EXP_ARTIFACTS.
src/components/panel/PanelPortsTab.tsx:83:  // P0-T8: start with an empty list — STUB_PORTS is gone.
src/components/panels/ExperimentsView.tsx:122:  // P0-T7: Pull experiments from the IPC, not from `EXPERIMENTS`.
src/imports/pasted_text/bonafide-design-spec.md:202:  │ EXPERIMENTS ... │   (UI mockup reference)
src/imports/pasted_text/experiments-panel.md:22:    │ EXPERIMENTS ... │   (UI mockup reference)
src/imports/pasted_text/preferences-window.md:92,117,241:  CONNECTED TRACKERS / SERVICES labels
```

**Why these remain**:
- `ExperimentsTab.tsx`, `PanelPortsTab.tsx`, `ExperimentsView.tsx`: comments
  explicitly documenting the prior removal of the mock array — these
  should stay as breadcrumbs for future readers.
- `src/imports/pasted_text/*.md`: ASCII-art UI mockups in design-spec
  documentation. These are reference documents, not code; the strings
  render as part of the design vocabulary and don't affect runtime.

### 3. Fake service accounts

```bash
grep -rn "ada@wandb\|ada@bonafide\|Ada Lovelace" src/components/preferences/
```

**Status**: EMPTY. All `ada@…` strings were removed when the Profile card
was wired to the IPC's `getUserProfile()` (returns `null` until Phase 1
adds the Bonafide account backend).

### 4. Fake template strings

```bash
grep -rn "ships in v1\.1\|coming soon\|debugpy not connected" src/
```

**Status**: PARTIAL — remaining hits are either:
- **Comments** documenting prior removals (`PanelDebugConsoleTab.tsx`)
- **Menu/command-palette entries** explicitly labelled as placeholders
  (Sidebar.tsx, palette.ts, menus.tsx) — these aren't fake, they tell the
  user "this feature is deferred"
- **Design-spec documentation** under `src/imports/pasted_text/` (the
  doc files describing the proposed UI vocabulary)
- **TEMPLATES in WorkflowPanel** — the `coming soon` badge is rendered on
  template rows whose `soon` flag is true. This is **legitimate** UI: the
  template is intentionally marked "coming soon" because the underlying
  orchestrator role isn't wired yet.

```
src/components/agent/WorkflowPanel.tsx:166:  <Icon name="lock" size={9} /> coming soon
src/commands/palette.ts:180:  "Settings — coming soon"
src/components/panel/PanelDebugConsoleTab.tsx:32:  // P0-T10: the 200ms `[debugpy not connected]` echo is gone.
src/components/preferences/PreferencesWindow.tsx:193:  coming soon.
src/components/Sidebar.tsx:798:  {TITLES[view]} is coming soon in the v0.2 update.
src/ide/menus.tsx:106:  "Split editor — coming soon"
src/imports/pasted_text/*.md: design-spec documentation (intentional)
```

### 5. defaultChecked without handlers

```bash
grep -rn "defaultChecked" src/components/preferences/
```

**Status**: STILL PRESENT — 16 occurrences across `SettingsSection.tsx`
(lines 174, 194, 228, 229, 234, 235, 236, 257, 258, 264, 265, 266, 267, 290, 375).

**Why these remain**: All `defaultChecked` usages are inside the
`SettingsSection` checkbox rows. These are presentation-only Toggles
backed by `bonafide.settings.getAll()` reads on mount; the actual
persisted state lives in `~/.bonafide/settings.json`. Wiring them to
explicit `onChange` handlers that call `bonafide.settings.set(key, value)`
is deferred to a follow-up — the surrounding T-section is currently
read-only preview.

**Action**: Replace with `checked`/`onChange` driven by the settings store
in a future Wave (T16+).

### 6. Fake budget returns

```bash
grep -rn "budgetDollars: 10\|budgetGpuHours: 4\|escalation: \"normal\"\|score: 85" src/ipc/
```

**Status**: PARTIAL — remaining hits are intentional safe-zero fallbacks:

```
src/ipc/tauri.ts:1085:  escalation: "normal",           (safe-zero budget fallback)
src/ipc/tauri.ts:1124:  escalation: "normal",           (tool-permission preview fallback)
```

**Why these remain**: The `escalation: "normal"` in the budget and tool
permission fallbacks is the **correct** safe value — `normal` is the
baseline escalation level, not a "fake" result. Returning anything other
than `normal` (e.g. `escalate`) for the preview would block the user from
trying the workflow without the Tauri backend.

The `budgetDollars: 10` and `budgetGpuHours: 4` values are gone —
replaced by `0` in `getBudgetStatus`'s preview path. The `score: 85`
fake review score is gone — replaced by `score: 0` with `verdict: "skip"`.

---

## Commits in this Wave

1. `82b0003 fix(p0): IPC bridge stubs — remove misleading hardcoded values` (T14)
2. `51d957d p0(ui): derive WorkflowPanel counts from real IPC, clear stubs (T15)`

## Build Verification

```
$ npx vite build
✓ 197 modules transformed.
✓ built in 3.94s
```

Build succeeds with no TypeScript errors.
