Got it, no images. Here's the complete function map I built from reading every source file in the codebase end-to-end.

---

## Inventory of the scaffold

Everything you've built is **presentation** — fully-styled, fully-interactive React components — but with the placeholders, mock data, and fake handlers all wiring to **no real backend**. The shell, the visual language, the interactions, the chart math, the diff coloring, the sparkline ticks, the decoration anchors, the onboarding flow, the preferences window, the status bar — those all exist and they all look right. What's missing is the **substance of an ML-Ops IDE**: the actual features an ML engineer would point a run at and do useful work with.

The scaffold makes this map of what's currently wired to mocks vs. what's a no-op.

### Currently mocked (visual only — no real I/O)

| Surface | Function | Mock source |
|---|---|---|
| Sidebar › Runs | List, filter, group runs | `RUNS` array in `data/runs.ts` |
| Sidebar › Explorer | File tree | static `FILE_TREE` |
| Sidebar › Experiments | Experiments dashboard | static `EXPERIMENTS` |
| Sidebar › Artifacts | Artifact list | static `WORKSPACE_ARTIFACTS` |
| Sidebar › Git | Source control, commits | static `GIT_STATE` |
| Editor tabs | `train.py`, `model.py` | static `TRAIN_PY` tokens |
| Editor decorations | run-anchor, live-metric | reads from `RUNS` |
| Run Inspector | 6 tabs (Overview, Agent, Metrics, Config, Diff, Artifacts) | all reads from `RUNS` |
| Run Timeline | Sortable comparison grid | reads `RUNS` |
| Chart tab | metric curves | reads series from `RUNS` |
| Experiments tab | per-run artifacts/config/metrics | mixed static + reads |
| Workflow panel | thread inbox + composer | static `THREADS` |
| Composer | model picker, mode picker | static `MODELS`, `MODES` |
| Onboarding | 3-step modal | static |
| Preferences | settings, account, trackers | static |
| Status bar | git/python/W&B badges | hardcoded strings |
| TitleBar | hardcoded |

### Wire-up features (functions to implement)

Grouped by the surface they live in. Every entry is a discrete function the agent would build.

---

## 1. Workspace & project bootstrap

**Surface:** App open → Pick workspace → Open folder.

| Function | What it does |
|---|---|
| `openLocalFolder()` | Native folder picker (Electron `dialog.showOpenDialog` / web `showDirectoryPicker`); resolves to a project root. |
| `watchFolder(root)` | Filesystem watcher; fires change events for files in root. |
| `listFiles(root)` | Initial scan; returns the `FileNode[]` shape currently in `FILE_TREE`. |
| `readFile(path)` | Read contents; Monaco-ready string. |
| `writeFile(path, content)` | Write back from the editor; debounced, atomic (`.tmp` rename). |
| `recentWorkspaces()` | Persist + list recently-opened roots; powers Sidebar › Account › Recent. |
| `createWorkspace(name, path)` | Scaffold a new project (git init, .venv, pyproject.toml, README, .gitignore). |
| `switchWorkspace(root)` | Dispose watchers, flush caches, reload indexers. |

Implementation depends on a runtime: **Electron** (most natural fit — IPC, fs, dialogs, dock-icon) or **Tauri** (lighter, Rust backend). Scaffold has no native host yet; that's the first gate.

---

## 2. Git integration

**Surface:** Status bar (branch, ahead/behind), Sidebar › Git, Provenance borders in editor, Run Inspector provenance row.

| Function | What it does |
|---|---|
| `gitStatus(root)` | Parse `git status --porcelain` into `FileChange[]`. |
| `gitBranch(root)` | Current branch + ahead/behind counts. |
| `gitLog(root, n)` | Last N commits with hash/author/message/date. |
| `gitShow(root, ref)` | Commit metadata for a pinned run. |
| `gitDiff(root, base, head, path?)` | Unified diff for the Inspector Diff tab and provenanced lines. |
| `gitBlame(root, path, line)` | Optional; powers "who wrote this line" hover. |
| `gitCommit(root, msg, files?)` | Commit staged changes. |
| `gitPush(root)` / `gitPull(root)` | Sync. |
| `gitBranchLeaderboard(root)` | Aggregate val_loss for runs whose commit is reachable from each branch; populates the "best run" badge in Sidebar › Git. |
| `gitFileProvenance(root, path)` | For each line, the commit + run that produced it; drives the Editor's provenance left-border. |

Uses `simple-git` against the user's repo. No fake data — everything currently in `GIT_STATE` becomes real.

---

## 3. Tracker integrations (W&B / MLflow / Comet / Neptune)

**Surface:** everywhere — sidebar runs, timeline, inspector, experiments, decorations, status bar W&B dot, preferences trackers.

| Function | What it does |
|---|---|
| `connectTracker(kind, creds)` | OAuth/API-key handshake; persist credentials in OS keychain. |
| `listRuns(project)` | Paginated run list, filtered by state/group. |
| `watchRuns()` | Server-sent / streaming updates; replaces the static 5-run array with the live project. |
| `getRun(id)` | Full run metadata: state, metrics, config, env, duration. |
| `getMetricSeries(runId, key, stepRange?)` | Resampled time-series for sparklines + charts (the `series()` mock generates one of these). |
| `getRunConfig(runId)` | Hyperparameters; editable in Inspector › Config. |
| `listArtifacts(runId)` | All artifact files for a run; feeds Inspector › Artifacts and Experiments › Artifacts. |
| `downloadArtifact(runId, name, dest)` | Stream to disk with progress. |
| `previewArtifact(runId, name)` | Fetch bytes for preview (image render, csv→table, json→tree, yaml→Monaco read-only). |
| `compareRuns(a, b)` | Per-key delta; populates the Compare picker and the experiments tab's "Config diff". |
| `leaderboardAcrossRuns(metric)` | Sorted list of runs by metric — the Experiments card "Best" + the run timeline. |
| `annotateRun(runId, labels)` | Add tags the Sidebar › Experiments card already displays. |

Provider abstraction — one interface, four backends (W&B API, MLflow REST, Comet GraphQL, Neptune REST). Auth tokens stored in OS keychain. The "Connect MLflow" form in Preferences › Account currently has the input but no submit handler.

---

## 4. Real Python interpreter & training execution

**Surface:** Status bar (Python version, PyTorch, GPU dot), Settings › Python field, pre-commit checks, all runs.

| Function | What it does |
|---|---|
| `detectInterpreter(root)` | Walk up `root` for `.venv`, `conda`, `pyenv`; return `python path` + version + `requirements.txt` parse. |
| `startShim(pythonPath)` | Spawn a long-lived Python subprocess that hosts the tracker client + filesystem watch hook (the "Python shim socket" mentioned in Settings › Advanced). |
| `runScript(scriptPath, args)` | Execute `python train.py ...`; stream stdout/stderr to the Run Inspector log. |
| `cancelRun(runId)` | SIGTERM the process group. |
| `gpuProbe()` | Return GPU model + count + utilization (NVIDIA via `nvidia-smi`; falls back gracefully). |
| `applyPatch(file, lines)` | Write the proposal patch to disk atomically before running the verification run. |
| `runSmokeVerify(config, nSteps)` | Run a 200-step verification; the green-checked "Smoke run completed" in `ProposalView` becomes real. |

The 4-tier abstraction: `Interpreter → Process → Shim → Tracker SDK`. Each layer is small.

---

## 5. Editor surface — Monaco, code intelligence, decorations

**Surface:** Editor tabs, tab strip, inline decorations, file tree.

| Function | What it does |
|---|---|
| `mountMonaco(path, content)` | Lazy-mounted Monaco editor per file. |
| `tokenizeLanguage(path)` | Python via Pyright in a worker; TS/YAML via Monaco's built-in langs. |
| `completionProvider(path, position)` | LSP-style completion feeding the artifacts and runs as contextual suggestions. |
| `formatOnSave(file)` | Honors the Settings › Formatter dropdown (Ruff / Black / autopep8 / yapf). |
| `lintOnSave(file)` | Per-file diagnostics surfaced as a gutter marker. |
| `runAnchorDecorations()` | Walk metrics in the file → spawn the `deco.kind === "run-anchor"` widget at the matching line. |
| `liveMetricDecorations()` | Stream the active metric for the bound run; spawn the `live-metric` widget with a *real-time-updating sparkline*. |
| `metricAnchorDecorations()` | Static marker where a metric is referenced. |
| `provenanceBorder()` | Paint the 2px `primary` left border on lines whose commit maps to the selected run. |
| `quickOpenFile(query)` | ⌘P fuzzy search; opens a tab. |
| `tabClose(id)` / `tabReorder(from, to)` / `tabSplitRight()` / `tabSplitDown()` | The two unhandled buttons in the tab strip. |
| `editorSyncScroll(fromTab, toTab)` | Optional scroll sync across splits. |

Replace `CodeSurface` with a Monaco lazy import. Keep the decoration widgets as overlay layers positioned from Monaco's `viewZone` API or `glyphMarginWidget`.

---

## 6. The Experiments tab — already designed

**Surface:** Editor › Experiments tab. Scaffolding is present in `ExperimentsTab.tsx`; the four cards (Artifacts / Config / Metrics / Provenance) are wired to mock arrays.

| Function | What it does |
|---|---|
| `getFullRun(runId)` | Aggregated artifact list, config, full metric series with timestamps, provenance, file diff. Replaces `EXP_ARTIFACTS` and `FILES_TOUCHED` mocks. |
| `searchConfig(runId, query)` | Live filter on the Config card. |
| `sparklineSeries(runId, key)` | Pull real series for the Metrics card. |
| `overlaidMetricChart(runId, otherRunId)` | Renders the Compare Pane's two-series chart from real data. |
| `openDiff(root, base, head, path)` | Reads the "Open diff" button — opens the file diff in a new Monaco diff editor tab. |
| `previewArtifactInTab(runId, name)` | If `name` ends in `.png/.jpg/.csv/.yaml/.json/.pt`: opens a preview tab next to the run. |
| `highlightArtifact(runId, name)` | The "Open in Experiments" card from a debugger thread calls this with `(artifacts, metrics)[]` tuples. |

---

## 7. Run Inspector — six tabs

**Surface:** Right column. Already structured as a tab strip.

### 7a. Overview tab
Already populated. Just bind to `getRun()`.

### 7b. Agent tab — **the biggest gap**
There's a `Composer`, `QuickSuggestions`, and a `ProposalView` showing one pre-canned `INVESTIGATION`. None of it runs.

| Function | What it does |
|---|---|
| `openInvestigation(runId, role)` | Creates a `Thread`; binds to the run; spawns an agent worker. |
| `agentWorker(threadId, role)` | The actual LLM loop with tool access. |
| `toolReadMetrics(runId)` | Pulls real metric series. |
| `toolReadConfig(runId)` | Real hyperparameters. |
| `toolDiffRuns(a, b)` | Real config delta + metric overlay. |
| `toolReadCode(root, range)` | Range slice of the source file referenced by a line deco. |
| `toolApplyPatch(file, lines)` | Atomic write. |
| `toolRunSmokeVerify(config, nSteps)` | Run the 200-step smoke test. |
| `toolExecuteShell(cmd)` | Optional; gated behind a confirmation modal. |
| `streamTrace(threadId)` | Streams `TraceStep[]` into the `Reasoning trace` accordion. |
| `formHypothesis(threadId)` | Streams the `Hypothesis` block (verdict + statement + evidence + confidence + ruledOut). |
| `proposePatch(threadId)` | Streams the `Proposed patch` unified diff. |
| `verify(threadId)` | Triggers the smoke-run; streams the verification card. |
| `approvePatch(threadId)` | Applies patch to disk; spawns the next full run; flips the thread to `verifying`. |
| `rejectPatch(threadId, reason?)` | Closes the proposal; threads stays `awaiting`. |
| `requestRevision(threadId, note)` | User note attaches to the thread; agent continues with the note. |
| `agentStop(threadId)` | Cancellation; preserves last good state. |
| `modelSelect(threadId, modelId)` | Persisted per-thread; default = Settings default. |
| `attachContext(threadId, items)` | Attaches files / metrics / diffs the user dragged in. |
| `composerSend(threadId, text)` | The send button — posts a follow-up turn; the whole `CONVERSATION` becomes the thread's real message log. |
| `agentsAsProjectMemory(threadId)` | Persistent recollection across threads (currently a single hardcoded "ruled out: data issue" line). |

### 7c. Metrics tab
| Function | What it does |
|---|---|
| `getMetricSeries(runId, key)` (already covered above) | Powers the chart + step slider. |
| `pickBaseline(runId)` | Sets the "Δ vs prior" chip — the Compare picker currently does nothing. |
| `expandChart(runId, key)` | Already wired to `onExpandChart` — opens the Chart tab with a real big chart. |

### 7d. Config tab
| Function | What it does |
|---|---|
| `getRunConfig(runId)` | Powers the table. |
| `compareConfigToWorkspace(runId)` | The `[edited]` badge — diffs against the workspace default config in the file. |

### 7e. Diff tab
| Function | What it does |
|---|---|
| `pickComparator(runId)` | The `DiffPicker` — fully mock today. |
| `getUnifiedDiff(root, a, b, path?)` | Real git diff with the +/− line coloring. |

### 7f. Artifacts tab
| Function | What it does |
|---|---|
| `listArtifacts(runId)` (already covered) | Powers the row. |
| `downloadArtifact` / `previewArtifact` (already covered) | Real download and preview. |

---

## 8. Run Timeline (bottom strip)

**Surface:** `RunTimeline.tsx`. Already styled; reads `RUNS` only.

| Function | What it does |
|---|---|
| `getRunsForTimeline()` | Live run list with val_loss/acc/duration/commit. |
| `sortBy(metric)` | Currently the click-on-header hardcodes the sort key. |
| `filterBy(metric)` | Powers the "Filter:" dropdown. |
| `killRun(runId)` | The `x` button in the row. |
| `collapseTimeline()` / `expandTimeline()` | Already wired. |

---

## 9. Workflow panel

**Surface:** `WorkflowPanel.tsx`. Static inbox + composer + templates.

| Function | What it does |
|---|---|
| `listThreads(filter)` | Active / awaiting-review / closed. |
| `openThread(threadId)` | Opens detail view. |
| `createThreadFromTemplate(templateId, runId?)` | The "Use" button on templates is `disabled`. |
| `agentWorker(threadId)` (already covered above) | Each thread is an agent loop. |
| `closeThread(threadId, archive?)` | Moves to closed band; affects `CLOSED_COUNT`. |

---

## 10. Notifications

**Surface:** Status bar bell (currently shows hardcoded "1"), `StatusBar`'s syncing state.

| Function | What it does |
|---|---|
| `subscribeRunEvents()` | Fires on `finished` / `failed` / `crashed` / `better` (new SOTA). |
| `toast(notif)` | In-app toast via a `<Notifications>` stack mounted in `App.tsx`. |
| `osNotify(notif)` | Native notify via Electron `Notification` API / web `Notification` with permission. |
| `emailDigest(notif)` / `slackPost(notif)` | The Preferences › Notifications checkboxes have no handlers. |
| `quietHoursCheck()` | The 22:00–08:00 setting in Preferences is inert. |

---

## 11. Preferences window

**Surface:** `PreferencesWindow.tsx`. All sections currently inert.

| Function | What it does |
|---|---|
| `setSetting(key, value)` | Persist to disk (~/.bonafide/settings.json). |
| `fontFamily`, `fontSize`, `tabSize`, etc. (all Settings › Editor fields) | Reload Monaco with the new values. |
| `detectInterpreter` (covered above) | The "Detect" button in Settings › Python. |
| `installFormatter` | Settings › Python › Formatter dropdown. |
| `manageTrackers` (already covered above) | Cross-link from Account → Settings › Trackers (already wired). |
| `clearCache()` | Settings › Privacy. |
| `changeCacheLocation(path)` | Settings › Privacy. |
| `checkForUpdates()` | Settings › Updates. |
| `exportUserData()` / `deleteAccount()` | GDPR pair. |
| `resetSettings()` | Settings › Advanced. |

The deep-link from Account → Settings › Trackers with the pulse animation is already wired beautifully; it's the only animated transition in Preferences today.

---

## 12. Search, Extensions, and the unset dock items

**Surface:** Sidebar when dock = "search" or "extensions"; they're stubbed with the empty-state message.

| Function | What it does |
|---|---|
| `globalSearch(query)` | Powers `Search`. Indexes filenames, contents (ripgrep), metric keys, run names, commit messages. |
| `regexSearch(query, root)` | ⌘⇧F regex. |
| `loadExtension(manifest)` / `installExtension(id)` | The Extensions panel. |
| `extensionRPC(extensionId, method, args)` | The plugin sandbox. |

---

## 13. Theming & accessibility

**Surface:** CSS tokens in `index.css`. Already have light-vs-dark left as a fork.

| Function | What it does |
|---|---|
| `setTheme(name)` | Switch CSS theme file. |
| `respectReducedMotion()` | Already wired via the `@media` rule. |
| `bypassLink()` | The skip-to-content link is already installed by Vite when `accessibility.addBypassLinks` is true. |

---

## 14. Packaging — the "make it a desktop app" part

This is the actual sentence at the end of your message. Every function above presumes a desktop runtime. The minimum viable host:

| Function | What it does |
|---|---|
| `electronMain()` | Window creation, IPC handlers for `fs`, `git`, `python`, `dialog`. |
| `tauriMain()` | Alt: Tauri with Rust commands. |
| `protocolBonafide()` | Custom protocol `bonafide://` for opening files from URLs. |
| `autoUpdater()` | Updates from Settings › Channel (Stable/Beta). |
| `signApp()` | macOS / Windows code-signing. |
| `packDist()` | `electron-builder` config for `.dmg`, `.app`, `.msi`, `.exe`, `.AppImage`. |
| `firstRunWizard()` | The Onboarding screen is already in — needs the `connectTracker` to actually fire instead of advancing steps. |
| `systemTray()` | Optional; quick-launch new run / open project. |
| `chromeTrafficLight()` | The hardcoded three-color circles in `TitleBar.tsx`. Replace with `process.platform === 'darwin'` to hide them, `framen`/`frame` to position traffic lights. |

Recommend **Electron + electron-vite** for v1 (cold start + Windows build pipeline more mature than Tauri at this moment); Tauri is the right migration path when the team can absorb Rust.

---

## How to actually build this

The scaffold is so complete that the implementation order matters more than the function list:

1. **Pick the runtime** (Electron or Tauri) — every other function sits on top of this.
2. **Pick the tracker of record** (W&B is the obvious first; MLflow second). One adapter per `tracker.ts` file.
3. **Build the IPC bridge** — `bonafide://ipc/*` for fs, git, python, dialog. The renderer is already there.
4. **Replace `RUNS`** — the moment `tracker.listRuns()` returns real data, ~40% of the app stops being a prototype.
5. **Replace `GIT_STATE`** — `gitStatus()` + `gitBranchLeaderboard()` fill in the Source Control view, Status bar branch badge, and Editor provenance borders.
6. **Wire the Agent** — the most complex surface, but the most valuable. Start with one role (Debugger), one tracker (W&B), one Python shim. The composer and proposal UI are ready.
7. **Settings / Preferences** — every field already exists in markup; add a `useSetting` hook + persistence and 80% of it lights up.
8. **Packaging + auto-update** — last mile.

That's the whole function surface. The scaffold reads like a finished design doc; the engineering is the wiring. Want me to start at step 1 with Electron, or do you have a target runtime preference in mind that I should plan against?