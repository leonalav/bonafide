Great — the Figma sketches match the spec closely (Editor, Run Timeline, Inspector look right). The three empty panels are exactly where the next design pass goes. Let me describe each in detail.

---

## 1. Experiments Panel (dock #3 `line-chart`)

This is distinct from the **Runs** panel (dock #2, flat list of individual runs) and the bottom **Run Timeline** (current selection grid). **Experiments** is the higher-level curation surface — "groups of related runs toward a goal."

### 1.1 Concept

An **Experiment** in Bonafide is a named collection of runs with a shared hypothesis and a leaderboard. Examples:
- "ResNet50 sweep on CIFAR-10" — 24 runs varying lr/wd/batch_size
- "Best val_loss < 0.30 on bonafide-train" — 7 runs hand-picked from different branches
- "llama-finetune-baselines" — 3 runs across different LoRA ranks

Created automatically when Bonafide detects ≥ 3 runs sharing a `wandb.Group` tag, or manually via "New experiment from selection" (Shift+click in Runs).

### 1.2 Header

```
┌──────────────────────────────────────────────────────────────────────┐
│ EXPERIMENTS                                          [+ New] [⌘E]   │
├──────────────────────────────────────────────────────────────────────┤
│ [🔍] Search experiments...                                           │
│ [▾ Sort: best val_loss ▼]   [▾ Group: status ▼]   [▢ Compact] [⋯]  │
└──────────────────────────────────────────────────────────────────────┘
```

Header is 36px, then a 48px filter row with the search input (full width), sort, group-by, density toggle.

### 1.3 Card view (default density)

Each experiment is a card, 32px gap between cards, padding 16px:

```
┌──────────────────────────────────────────────────────────────────────┐
│  ResNet50 sweep on CIFAR-10                          ●● Active · 24  │
│  ──────────────────────────────────────────────────────────────────  │
│  Goal:  val_loss < 0.30                            Best: 0.28 🟢     │
│                                                               ─3d   │
│                                                                       │
│  ▁▂▃▅▆▇█▇▅▃▂▁▂  leaderboard sparkline (best val_loss over runs)      │
│                                                                       │
│  Top runs:                                                            │
│  ▸ bold-tnd-9     0.28   a3f9c12   main    4m12s                     │
│  ▸ quiet-rv-12    0.31   8b2a4f0   main    6m08s                     │
│  ▸ swift-fl-3     0.34   8b2a4f0   main    5m44s                     │
│  ▸ ... 21 more                                                       │
│                                                                       │
│  Tags: cifar · resnet · sweep · lr_search                  [Open ↗] │
└──────────────────────────────────────────────────────────────────────┘
```

- Card surface: `surface-container` bg, 1px `outline-variant` border, 8px radius.
- Status chip top-right: `Active` (`primary` chip), `Won` (`primary` chip), `Failed` (`error` chip), `Archived` (`outline` chip).
- Goal line: `body-sm` `on-surface-variant`. "Best" value in `headline-md` `primary` with delta chip.
- Leaderboard sparkline: 280×32px, shows the best `val_loss` per run in chronological order — gives an at-a-glance "are we improving?" read.
- Top runs: 4 rows max, then `... N more`. Each row: 24px, name `code-md` `primary`, value `code-md`, commit short-hash `caption` `outline`.
- Hover card: full leaderboard table.

### 1.4 Compact view (toggle)

Table-only — 28px rows, same columns as Run Timeline. Same hover/selection semantics.

### 1.5 Card actions

- Click anywhere on card body → expands inline (replaces leaderboard sparkline with full table; "Show less" link).
- `Open ↗` → opens a dedicated Experiment view (full-screen takeover) with: goal editor, full leaderboard, hyperparameter heatmap, run-by-run diff.
- Right-click → context menu: Pin to sidebar / Duplicate / Archive / Delete / Export JSON / Copy goal.

### 1.6 Experiment full view (deep dive)

When you click `Open ↗`, the entire center pane becomes that experiment:

```
┌────────────────────────────────────────────────────────────────────────┐
│ ← Back   ResNet50 sweep on CIFAR-10              [▢ Compare] [⋯]      │
├─────────────┬──────────────────────────────────────────────────────────┤
│  GOAL       │  LEADERBOARD                                              │
│  val_loss   │  ┌────────────────────────────────────────────────────┐  │
│  < 0.30     │  │ Run         val_loss  acc    lr     wd     bs      │  │
│  ✎ edit     │  ├────────────────────────────────────────────────────┤  │
│             │  │ ●bold-tnd-9  0.28 🟢  0.89   5e-4   1e-5   128     │  │
│  HYPERPARAM │  │ ●quiet-rv-12 0.31 🟡  0.88   1e-3   1e-4   128     │  │
│  HEATMAP    │  │ ●swift-fl-3  0.34 🔴  0.86   5e-4   1e-4    64     │  │
│  ┌───────┐  │  │ ...                                                  │  │
│  │       │  │  └────────────────────────────────────────────────────┘  │
│  │  5×5  │  │                                                          │
│  │ grid  │  │  PARALLEL COORDS                                          │
│  │       │  │  ┌────────────────────────────────────────────────────┐  │
│  └───────┘  │  │  multi-line chart, one line per run                 │  │
│             │  └────────────────────────────────────────────────────┘  │
│  TAGS       │                                                          │
│  cifar ✕    │                                                          │
│  resnet ✕   │                                                          │
│  [+ add]    │                                                          │
└─────────────┴──────────────────────────────────────────────────────────┘
```

Left rail (240px): goal, hyperparam heatmap (lr × wd grid, colored by best val_loss in that cell — empty cells show `—`), tag chips. Right side: leaderboard table + parallel coordinates plot for hyperparameter sensitivity analysis.

### 1.7 Empty state

The current "no items to show in this workspace yet." copy works, but I want it more specific:

```
┌──────────────────────────────────────────────────┐
│                                                  │
│                  ◆                               │
│                                                  │
│   No experiments yet.                            │
│                                                  │
│   Experiments group related runs toward          │
│   a goal — e.g. "ResNet50 sweep" or              │
│   "best val_loss under 0.30".                    │
│                                                  │
│   They'll appear automatically when you          │
│   have ≥3 runs sharing a wandb group, or        │
│   you can create one now.                        │
│                                                  │
│   [  New experiment  ]   primary                 │
│                                                  │
└──────────────────────────────────────────────────┘
```

Same glassmorphism card pattern as onboarding.

---

## 2. Source Control Panel (dock #5 `git-branch`)

You said VS Code–normal is fine. I'll keep the core exactly VS Code-shaped, then add **two ML-specific overlays** that are the differentiator: **commit → run linkage** and **branch → leaderboard** view.

### 2.1 Layout

Three zones vertically, all inside the 240px sidebar:

```
┌──────────────────────────────────────────────────────────────────────┐
│ SOURCE CONTROL                                                       │
├──────────────────────────────────────────────────────────────────────┤
│  ⎇ main    ↑ 0 ↓ 0                       [⇣ pull] [⇡ push] [⟳]     │  ← branch + sync bar, 40px
├──────────────────────────────────────────────────────────────────────┤
│  CHANGES (3)            STASHES (0)        [⌘⌃S commit ⇧⌘P push]     │  ← tab strip 32px
├──────────────────────────────────────────────────────────────────────┤
│  ▾ Staged Changes (1)                                                │
│    M src/model.py                                  2 runs · best 0.31│  ← VS Code standard
│  ▾ Changes (2)                                                       │     with ML chip appended
│    M src/train.py                                  3 runs · best 0.28│
│    M src/data.py                                   1 run  · best —  │
│  ▾ Untracked (1)                                                     │
│    U configs/sweep.yaml                            —                 │
├──────────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ Message (⌘↵ to commit)                                         │ │  ← commit input
│  └────────────────────────────────────────────────────────────────┘ │
│  [▢ Commit]  [▢ Commit & Sync]                  lint ✓   tests ✓     │
└──────────────────────────────────────────────────────────────────────┘
```

That's the standard VS Code shape. Now the ML overlays:

### 2.2 ML overlay #1: "Runs for this file" chip

Every Changed/Untracked file row gets a right-aligned chip showing how many runs touched this file in the workspace's history, with the best `val_loss` achieved:

```
M src/train.py             3 runs · best 0.28   ← chip right-aligned
                                ↑                  ↑ chip: 22px tall
                          "3 runs · best 0.28"   text body-sm, color-coded by best
                          background: surface-container, 4px radius
```

Color coding:
- `🟢 0.28` (best under goal) — `primary` text on 10% `primary` bg
- `🟡 0.45` (best above goal) — `tertiary` text on 10% `tertiary` bg
- `🔴 failed only` — `error` text on 10% `error` bg
- `—` (no runs ever) — `outline` text, no bg

Hover the chip → tooltip lists the run names. Click → opens a popover with the top-3 runs by `val_loss`, each clickable into Inspector.

### 2.3 ML overlay #2: Branch leaderboard strip

A collapsible strip at the top of the panel (32px), above branch picker:

```
┌──────────────────────────────────────────────────────────────────────┐
│ ⎇ main   best run: bold-tnd-9 · val_loss 0.28 · 24 runs on branch    │
│           [+ Compare branches ↗]                                     │
└──────────────────────────────────────────────────────────────────────┘
```

If you're on a feature branch, this shows the best run *on this branch*. Click `Compare branches ↗` → opens a side-by-side leaderboard (one column per local branch, top run per branch). Helps answer "should I merge this branch or keep iterating?"

### 2.4 Log view

Click the branch picker → dropdown changes from "list of branches" to "tabs: [Branches] [Commits]". Commits tab:

```
COMMIT  MESSAGE                              RUNS   BEST VAL_LOSS
a3f9c12 bump lr to 5e-4                     2      0.28 🟢
8b2a4f0 try wider batch                     1      0.34 🟡
8d2ee91 initial commit                       —      —
```

Click a commit row → opens a transient diff view in the editor (the same one used for run-vs-run comparison, but keyed to git commit instead of run). Right-click → "Revert (create new branch)" or "Tag run from this commit".

### 2.5 Empty state

Replace the current copy with this more honest one:

```
┌──────────────────────────────────────────────────┐
│                                                  │
│              ◆ (branch icon)                     │
│                                                  │
│   No git repository.                             │
│                                                  │
│   Bonafide will use this workspace's git         │
│   history to link runs to commits.               │
│                                                  │
│   [  Initialize repo  ]   secondary              │
│                                                  │
│   Or open a folder that already has git.         │
│                                                  │
└──────────────────────────────────────────────────┘
```

---

## 3. Artifacts Panel (dock #4 `package`)

This is the most "engineer-tool" panel of the three — model checkpoints, datasets, plots, configs. Treat it like a specialized file browser with type-aware preview, filtering, and download.

### 3.1 Concept

The Artifacts panel shows **all artifacts across all runs in the current workspace**, plus a **Local Artifacts** section for files that exist only in the workspace (e.g., a checkpoint you trained locally and didn't push to a tracker).

### 3.2 Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ ARTIFACTS                                       47 items · 2.1 GB   │
├──────────────────────────────────────────────────────────────────────┤
│ [🔍] Search by name, run, type...                                   │
│ [▾ Type: all ▼]  [▾ Run: all ▼]  [▾ Size ▼]  [▢ Grid ⌘G]             │
├──────────────────────────────────────────────────────────────────────┤
│ ▾ From runs (43)                                                     │
│   📦 model.ckpt       bold-tnd-9    412 MB    2026-09-05  [↓] [⋯]   │
│   🖼  loss_curve.png   bold-tnd-9    84 KB     2026-09-05  [↓] [↗]   │
│   📋 config.yaml      bold-tnd-9    2 KB      2026-09-05  [↓] [⋯]   │
│   📦 model.ckpt       quiet-rv-12   408 MB    2026-09-05  [↓] [⋯]   │
│   ...                                                                 │
│ ▾ Local (4)                                                          │
│   📦 latest.pt        —             412 MB    2026-09-05  [↗] [⋯]   │
│   📁 checkpoints/     folder        —         —            [↗]       │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.3 Artifact type icons

| Type | Icon (Lucide) | Color |
|---|---|---|
| Model checkpoint | `box` | `primary` |
| Dataset | `database` | `tertiary` |
| Plot (PNG, SVG, PDF) | `image` | `secondary` |
| Config / JSON / YAML | `file-code` | `on-surface-variant` |
| Tensor / Numpy | `layers` | `primary` |
| Other | `file` | `outline` |

### 3.4 Row anatomy

Each row: 32px tall. 8px gap between icon and name. Name in `code-md`. Run name in `caption` `on-surface-variant`. Size humanized (KB / MB / GB). Date in `caption` `outline`. Right side: action buttons (hover-revealed).

- **`[↓]` Download:** saves to `~/Downloads` by default; long-press for "save to workspace" submenu.
- **`[↗]` Open externally:** opens in OS default app (PNG → Preview, .pt → nothing → error toast).
- **`[⋯]` More:** copy path / copy URI / drag-to-editor / pin to sidebar / delete local.

### 3.5 Grid view (toggle `⌘G`)

Cards 180×140px, 12px gap. Each card shows:
- Top 80px: preview thumbnail (image preview for plots; type icon for non-previewable)
- Below: name (truncate), size, run name (chip)

Click card → opens Preview panel (right side, replaces Inspector temporarily).

### 3.6 Preview panel

When you click an artifact, the right-side Inspector transforms:

```
┌──────────────────────────────────────────────────────────────────┐
│  ← Back to Inspector        loss_curve.png           [↓] [↗]    │
│  bold-tnd-9 · 84 KB · PNG                                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │                                                          │  │
│   │                  preview image                           │  │
│   │                  (fit to panel)                          │  │
│   │                                                          │  │
│   └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│   METADATA                                                       │
│   Created    2026-09-05 14:22:11                                 │
│   Run        bold-mountain-7   [open ↗]                          │
│   Step       8,420 / 20,000                                     │
│   Type       PNG · RGB · 1200×800                               │
│   SHA256     a3f9c12...                                         │
└──────────────────────────────────────────────────────────────────┘
```

For models (.pt, .safetensors, .onnx), the preview shows a header card:
- File size, dtype inferred from extension, parameter count if parseable, ONNX graph thumbnail if applicable.
- Button: "Load into Python REPL" → opens an integrated Python REPL panel with `model = load('artifact://bold-tnd-9/model.ckpt')` pre-populated.

For configs: syntax-highlighted JSON/YAML with collapsible nodes, no preview pane (full content).

### 3.7 Drag-and-drop

You can drag any artifact onto the editor to insert its path:
- `.pt` → `"./artifacts/bold-tnd-9/model.ckpt"` (quoted string at cursor)
- `.png` → markdown image with relative path
- `.yaml` → YAML literal block

### 3.8 Empty state

```
┌──────────────────────────────────────────────────┐
│                                                  │
│              ◆                                   │
│                                                  │
│   No artifacts yet.                              │
│                                                  │
│   When runs log model checkpoints, datasets,     │
│   or plots, they'll appear here automatically.   │
│                                                  │
│   Want to add a local file?                      │
│   [  Add local artifact  ]   secondary           │
│                                                  │
│   Or drop a file anywhere in this panel.         │
│                                                  │
└──────────────────────────────────────────────────┘
```

Drop zone: the entire panel accepts drops when empty (dashed `outline` border, 2px, animated pulse). When populated, the header row doubles as a drop zone.

### 3.9 Filters as chips

Above the list, a row of active-filter chips (visible only when filters are non-default):

```
[ Type: model ✕ ]   [ Run: bold-tnd-9 ✕ ]   [ Clear all ]
```

Each chip: `surface-container` bg, 4px radius, ✕ on hover in `error`.

---

## Cross-panel consistency notes

- All three panels use the **same header pattern**: 36px tall, label-caps title, right-aligned actions (icon buttons 28×28 in `outline`, hover `on-surface`).
- All three share the **empty state pattern**: centered glassmorphism card (480×320 max), icon, headline, body, primary CTA.
- All three **respect the responsive collapse rules** I gave earlier: below 1024px sidebar width, panel collapses to icons only; user re-expands on click.
- **All commit/file/run identifiers** use the same short-hash typography (`code-md`, `on-surface-variant`, monospace context).

—
