## Bonafide v1 — Surface Design (full detail for Figma reference)

I'll describe every screen, every panel, every state, in writing. All values reference tokens from `DESIGN.md`.

---

### A. App Window Anatomy

The window is a single fixed shell at 1440×900 (design baseline; layouts adapt down to 1280×720 minimum).

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  [ Title Bar 32px — traffic-light left, "Bonafide" wordmark center, ─ □ ✕ right ] │  ← native chrome
├────┬──────────┬───────────────────────────────────────────────────┬──────────────┤
│    │          │  Tab Strip 36px                                    │              │
│ U  ├──────────┼───────────────────────────────────────────────────┤  Inspector   │
│ t  │          │                                                    │  320px       │
│ i  │          │                                                    │              │
│ l  │          │                                                    │  (collapses  │
│ i  │ Sidebar  │          Editor Surface (Monaco)                    │   to 0 on    │
│ t  │ 240px    │                                                    │   close)     │
│ y  │          │                                                    │              │
│    │          │                                                    │              │
│ D  │          │                                                    │              │
│ o  │          ├───────────────────────────────────────────────────┤              │
│ c  │          │  Run Timeline Panel 200px (collapsible to 36px)     │              │
│ k  │          │                                                    │              │
│48px│          │                                                    │              │
├────┴──────────┴───────────────────────────────────────────────────┴──────────────┤
│  Status Bar 24px                                                                       │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**Layout grid:** strict 4px baseline (per `DESIGN.md` `spacing.unit`). Outer window padding = 0. Gutters between editor and panels = 1px `outline-variant` borders. Inner panel padding = 16px (`margin-md`).

---

### B. The Utility Dock (48px wide, full height)

Vertical column of icon-only buttons. Per `DESIGN.md` "Utility Dock Icons":
- Background: `surface-container-low` (#191C20)
- Right border: 1px `outline-variant`
- Each icon button: 48×48, icon 20×20 centered
- Icon default color: `on-surface-variant` (#C3C6D2)
- Icon hover: `on-surface` (#E2E2E9), background `surface-container` (#1E2024)
- Active state: icon `on-surface`, **2px Official Blue (#AAC7FF) vertical bar on the LEFT edge** spanning full button height, background `surface-container`
- Border radius: 0 (square — they're docked, not floating)

**Stack from top to bottom** (each labeled with its keyboard shortcut):

| # | Icon (Lucide) | Label (tooltip) | Shortcut |
|---|---|---|---|
| 1 | `folder-tree` | Explorer | ⌘1 / Ctrl+1 |
| 2 | `flask-conical` | Runs | ⌘2 / Ctrl+2 |
| 3 | `line-chart` | Experiments | ⌘3 / Ctrl+3 |
| 4 | `package` | Artifacts | ⌘4 / Ctrl+4 |
| 5 | `git-branch` | Git | ⌘5 / Ctrl+5 |
| 6 | `search` | Search | ⌘6 / Ctrl+6 |
| 7 | `puzzle` | Extensions | ⌘7 / Ctrl+7 |
| — | (spacer, flex) | — | — |
| 8 | `user-circle` | Account | — |
| 9 | `settings` | Settings | ⌘, / Ctrl+, |

Group 1–7 are primary nav. Group 8–9 are pinned to the bottom with a flex spacer in between. Account icon shows a 6px diameter `primary` dot when signed in.

---

### C. The Navigation Sidebar (240px wide)

Background: `surface-container-low` (#191C20). Right border: 1px `outline-variant`. Header row 36px tall.

**C.1 Explorer view** (default after sign-in):

```
┌─ Header ─────────────────────────────────┐
│ EXPLORER                       [⋯] [⌘⇧P] │  ← 36px, label-caps typography
├──────────────────────────────────────────┤
│ [🔍] Search files...                      │  ← 32px input, 1px Steel border
├──────────────────────────────────────────┤
│ ▾ 📁 bonafide-train/                      │  ← tree rows 24px tall
│   ▾ 📁 src/                                │
│     🐍 train.py              ← selected  │  ← selected = bg surface-container-high
│     🐍 model.py                            │     active text: on-surface
│     🐍 data.py                             │     inactive: on-surface-variant
│   ▸ 📁 data/                               │
│   ▸ 📁 checkpoints/                        │
│   📄 README.md                             │
│   📄 pyproject.toml                        │
└──────────────────────────────────────────┘
```

Tree row height: 24px. Indent: 12px per level. Icon 14×14, 8px gap to label. Label `body-sm`. Chevron `▸`/`▾` 12px `outline`. Hover: bg `surface-container`. Selected: bg `surface-container-high` + 2px `primary` left-border (like a softer version of the dock's active state).

**C.2 Runs view** (when dock item #2 is active):

Same shell, content swaps:

```
┌─ Header ─────────────────────────────────┐
│ RUNS                            [⌘R sync] │
├──────────────────────────────────────────┤
│ [🔍] Filter runs by name / metric...       │
├──────────────────────────────────────────┤
│ Status: ●●●● Running 4                    │  ← summary chips row, 28px
│ Status: ● Finished 27                      │
├──────────────────────────────────────────┤
│ ▾ Today                                   │
│   ● bright-mountain-7   2h ago   🟢 -0.42 │  ← row: 24px
│   ● quiet-river-12      3h ago   🔴 +0.18 │     status dot 8px
│   ● swift-falcon-3      5h ago   ⚪  —    │     name body-sm primary
│ ▾ Yesterday                               │     duration caption
│   ...                                     │     delta chip right-aligned
└──────────────────────────────────────────┘
```

The status dot uses the run's state color: running = `tertiary` (#FFB77A, amber pulse animation 1.6s), finished = `primary`, failed = `error`, crashed = `error` with ⚠. Delta chip shows `val_loss` delta vs the previously selected baseline run: `🟢 -0.42` means better (text `primary` on 10% `primary` bg), `🔴 +0.18` means worse (text `error` on 10% `error` bg), `⚪ —` neutral.

---

### D. The Editor Surface

Per `DESIGN.md`:
- Background: `surface` (#111318) for the editor pane itself
- Custom Monaco theme with these token colors:
  - Keywords: `#FFB77A` (tertiary, soft amber)
  - Strings: `#AAC7FF` (primary, used unusually for strings to "own" the ML verb calls)
  - Functions: `#BFc7D4` (secondary)
  - Variables: `#E2E2E9` (on-surface)
  - Comments: `#8D919C` italic (outline)
  - Numbers: `#FFB77A`
- Font: Geist Sans, 14px / 22px line-height = 1.57. Note `DESIGN.md` says 1.6× for code — we use exactly 1.57× which is 22/14, the actual ratio we'll ship.
- Cursor: 2px `primary`, with a 4px halo at 30% opacity when blinking.
- Active line: bg `surface-container-low` at 60% opacity.

**D.1 Tab strip (above editor):**

```
┌────────────────────────────────────────────────────────────┐
│ 🐍 train.py ✕ │ 🐍 model.py ✕ │ + │                       │  ← 36px
└────────────────────────────────────────────────────────────┘
```

- Tab height 36px. Tab padding 12px horizontal. Tab separator: 1px `outline-variant` vertical.
- Active tab: bg `surface-container`, top 2px `primary` border, text `on-surface`. Bottom border 1px `outline-variant` (so editor bg shows through cleanly).
- Inactive tab: bg `surface-container-low`, text `on-surface-variant`.
- Hover: bg `surface-container-high`.
- File-type icon 14×14 left of label. Close ✕ 12px right of label, opacity 0 → 0.6 on hover.
- "+" button right of tabs, 36×36, opens Quick Open.

**D.2 Inline Gutter Decorations** (the killer feature)

The gutter is Monaco's left margin (line-number area). We override it. Width: 56px (24px wider than stock Monaco to fit our 24px widgets + line number).

Three decoration types per Section 5.2 of the spec:

```
Standard gutter:
│ 24  │ def train(cfg):
│ 25  │     model = build_model(cfg.model)
│ 26  │     wandb.init(project="bonafide-train")   ← RUN ANCHOR decoration
│     │     ↑
│     │     [● bright-mountain-7 · running · 4m12s]    ← 24px widget
│ 27  │     for epoch in range(cfg.epochs):
│ 28  │         ...
│ 29  │         loss = model.fit(train_loader)     ← LIVE METRIC decoration
│     │         ↓
│     │         [loss ▁▂▃▅▇▇█▇▅▃  0.42]                 ← 24px sparkline
│ 30  │         wandb.log({"loss": loss})
│ 31  │         wandb.log({"val_loss": val_loss})   ← METRIC ANCHOR decoration
│     │         ↓
│     │         [val_loss ▆▇▆▅▃▂▁▂  0.31]              ← 24px sparkline
│ 32  │
```

Decoration widget anatomy (24px tall):
- Left edge: 2px `primary` vertical bar (always present, signals "ML context here")
- Background: `surface-container` (subtle, doesn't fight code)
- Content: 8px status dot, then 4px gap, then 14px `code-md` text (run name short-hash + status), max-width 160px with ellipsis
- Hover: bg `surface-container-high`, tooltip with full metrics JSON
- Click: opens Run Inspector with this run selected
- Right edge of gutter is the line number area: 28px, right-aligned `code-md` `outline` color

**D.3 Code Provenance Decoration:**

When a run is selected in the Run Timeline, every line that produced that run (intersected with the workspace git tree at that commit) gets a 2px `primary` left-border on the code area itself (not the gutter). On hover, a subtle tooltip: "Part of run bright-mountain-7 (commit a3f9c12)". Lines not in the diff show no decoration.

**D.4 Hover cards / hovers:**

- Decorations have hover cards (glassy popovers, `surface-container` at 95% opacity, 12px padding, 8px radius, 1px `outline-variant` border, 16px backdrop blur). Show: full run name, status, duration, 3 key metrics (loss / val_loss / accuracy as a 200×60 sparkline), config summary.
- Quick info on hover over `wandb.log({"val_loss": ...})`: shows "logged 142 times across 5 runs, mean 0.38 ± 0.12".

---

### E. The Run Timeline Panel (bottom, 200px tall, resizable to 36–500px)

Background `surface-container-low`. Top border 1px `outline-variant`. Header row 36px.

**E.1 Header:**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ EXPERIMENTS    [▢ Hide]   [Filter: val_loss ▼]   [Sort: created ▼]  [⋯]  │
└──────────────────────────────────────────────────────────────────────────┘
```

**E.2 Body — Run Comparison Grid:**

```
┌─────────────┬────────┬─────────┬─────────┬─────────┬─────────┬────────┐
│ Run         │ State  │ val_loss│ acc     │ duration│ commit  │ ↕      │
├─────────────┼────────┼─────────┼─────────┼─────────┼─────────┼────────┤
│ ●bright-mt-7│ ●run   │ ▁▂▃▄▅▆▇█│ ▇▆▅▄▃▂▁▂│ 4m12s   │ a3f9c12 │ ✕ ⋮   │
│ ●quiet-rv-12│ ●done  │ ▂▃▄▅▆▇█▇│ ▇▆▅▄▃▂▁▂│ 6m08s   │ 8b2a4f0 │ ✕ ⋮   │  ← selected
│ ●swift-fl-3 │ ●done  │ ▅▆▇█▇▆▅▄│ ▁▂▃▄▅▆▇█│ 5m44s   │ 8b2a4f0 │ ✕ ⋮   │
│ ●...        │        │         │         │         │         │        │
└─────────────┴────────┴─────────┴─────────┴─────────┴─────────┴────────┘
```

- Row height: 28px. Selected row: bg `surface-container-high` + 2px `primary` left border.
- Each metric cell is a 60×18px sparkline (microcharts) — same data as the gutter sparklines but compressed.
- Column headers: `label-caps`, click to sort.
- State column: 8px colored dot. State colors: running = `tertiary` (pulse), done = `primary`, failed = `error`, crashed = `error` + ⚠.
- Hover any row → same hover card as D.4.
- Shift+click to multi-select → all selected runs drive a stacked metric chart in the Inspector.

**E.3 Collapsed state (36px):**

Just the header, with a tiny inline summary: "27 runs · 4 running · last sync 12s ago". Click to expand.

---

### F. The Run Inspector (right side, 320px wide, resizable 240–600px)

Background `surface-container-low`. Left border 1px `outline-variant`. When closed: collapsed to 0, replaced by a 4px handle at the right edge of the editor.

**F.1 Header:**

```
┌──────────────────────────────────────┐
│ bright-mountain-7           [⌘W ×]  │  ← 36px, body-lg primary
│ a3f9c12 · main · 4m12s ago           │  ← caption, on-surface-variant
└──────────────────────────────────────┘
```

**F.2 Tabs (under header):**

```
[ Overview ]  [ Metrics ]  [ Config ]  [ Diff ]  [ Artifacts ]    ← 32px tab strip
```

Underline on active tab: 2px `primary`. Tab text: `code-md`, active `on-surface`, inactive `on-surface-variant`.

**F.3 Overview tab content:**

```
┌──────────────────────────────────────┐
│ STATUS                               │
│ ● Running · step 8,420 / 20,000      │  ← label-caps + body-sm
│ ──────────░░░░░░░░░░░░░░░░░  42%    │  ← progress bar
├──────────────────────────────────────┤
│ KEY METRICS                          │
│  loss      0.42  ▼ 0.07 (vs prev)   │  ← body-sm, delta chip
│  val_loss  0.31  ▼ 0.04             │
│  acc       0.89  ▲ 0.02             │
│ ─ mini sparkline 200×40 ─            │
├──────────────────────────────────────┤
│ ENVIRONMENT                          │
│  Python 3.11.4 · PyTorch 2.2.1       │
│  GPU NVIDIA A100 80GB                │
│  Commit a3f9c12 (main)              │
└──────────────────────────────────────┘
```

Section headers use `label-caps`. Spacing between sections: 24px (`margin-lg`). Within sections: 8px (`margin-sm`).

**F.4 Metrics tab:**

```
┌──────────────────────────────────────┐
│ METRIC                              [+]
├──────────────────────────────────────┤
│ [val_loss] [loss] [acc] [lr]         │  ← pill toggles, 28px each
├──────────────────────────────────────┤
│                                       │
│     ┌─────────────────────────┐      │
│     │   chart 280×180         │      │  ← uses CSS sparkline lib
│     │   multi-line, axis      │      │
│     │   labels in label-caps   │      │
│     └─────────────────────────┘      │
│                                       │
│ Step: [────●────]  8,420             │  ← range slider
│ [ Compare: 0 selected ▼ ]            │
└──────────────────────────────────────┘
```

**F.5 Diff tab** (the killer view):

```
┌──────────────────────────────────────┐
│ DIFF: bright-mountain-7 vs quiet-rv-12│  ← header with run picker
├──────────────────────────────────────┤
│ ── src/train.py ──────────────────────│
│                                       │
│ -lr = 1e-3                            │  ← removed: red text on 10% error bg
│ +lr = 5e-4                            │  ← added: primary text on 10% primary bg
│                                       │
│ -batch_size = 64                      │
│ +batch_size = 128                     │
│                                       │
│  optimizer = AdamW(model.parameters(),│  ← context: unchanged
│                    lr=lr,             │
│ -                  weight_decay=1e-4) │
│ +                  weight_decay=1e-5) │
└──────────────────────────────────────┘
```

Diff text font: `code-md`. Added-line bg: `primary` at 10% opacity. Removed-line bg: `error` at 10% opacity. Gutter shows `+`/`−` in `primary`/`error`. File headers use `label-caps` on `surface-container` bg. The "vs" run picker (right side of header) is a combobox 140px wide.

**F.6 Artifacts tab:**

```
┌──────────────────────────────────────┐
│ ARTIFACTS                   3 items  │
├──────────────────────────────────────┤
│ 📦 model.ckpt        412 MB   [↓]    │  ← row 32px
│ 📦 config.yaml       2 KB     [↓]    │
│ 🖼  loss_curve.png    84 KB    [↗]    │
└──────────────────────────────────────┘
```

Icon by artifact type (model = `box`, dataset = `database`, plot = `image`, other = `file`). Click `[↓]` downloads to workspace `downloads/`; `[↗]` opens externally.

---

### G. Onboarding Flow

First-run only. Modal at Level 2 glassmorphism per `DESIGN.md` (80% opacity, 20px backdrop blur, Silver hairline border at 20% opacity).

**G.1 Welcome card** (centered, 480×320):

```
┌──────────────────────────────────────────┐
│                                          │
│              ◆  Bonafide                 │  ← logo, 48px
│                                          │
│   The IDE for ML engineers.              │  ← headline-xl
│   See your experiments live,             │  ← body-lg, on-surface-variant
│   right where you write them.            │
│                                          │
│   [  Get started  ]   primary button     │  ← 40px tall, full primary
│                                          │
│   Already have an account? Sign in       │  ← body-sm
│                                          │
└──────────────────────────────────────────┘
```

**G.2 W&B Sign-in card** (480×400):

```
┌──────────────────────────────────────────┐
│  ← Connect Weights & Biases              │
│                                          │
│  Sign in with W&B to bring your runs     │
│  into Bonafide.                          │
│                                          │
│  [  Authorize with W&B  ]  primary       │  ← triggers OAuth in browser
│                                          │
│  ────  or  ────                          │
│                                          │
│  [  Use API key  ]   secondary button    │
│                                          │
│  Your credentials are stored locally     │  ← body-sm, on-surface-variant
│  in your OS keychain.                    │
└──────────────────────────────────────────┘
```

**G.3 Workspace picker** (after auth):

```
┌──────────────────────────────────────────┐
│  Select a workspace                      │
│                                          │
│  [🔍] Search projects...                 │
│                                          │
│  ▾ bonafide-train           127 runs    │  ← row 40px, hover bg
│  ▾ vision-experiments       43 runs     │
│  ▸ nlp-finetuning           218 runs    │
│                                          │
│  Project path on disk:                  │
│  [ /Users/me/projects/bona... ]  📂     │  ← input + folder picker
│                                          │
│       [ Cancel ]  [ Open workspace ]     │
└──────────────────────────────────────────┘
```

---

### H. Status Bar (24px bottom)

Background `surface-container-low`. Top border 1px `outline-variant`.

```
┌────────────────────────────────────────────────────────────────────────┐
│ main ✓           · 0 ↓ 0 ↑    · 🐍 Python 3.11.4                       │
│                                  · 🤖 PyTorch 2.2.1 · GPU ●             │
│                                  · W&B ● synced 12s ago · 27 runs       │
│                                              · ⓘ Notifications (1)    │
└────────────────────────────────────────────────────────────────────────┘
```

Three-zone flex: left = git + file changes, center = detected language/runtime, right = tracker status + notifications.

---

### I. Empty / Loading / Error States

**I.1 Empty workspace (no runs yet):**

Center the Editor with a glassmorphism card 480×280:

```
┌──────────────────────────────────────────┐
│              ◆                            │
│                                          │
│   No runs yet.                           │  ← headline-md
│                                          │
│   Start a run and Bonafide will           │  ← body-sm
│   annotate it here automatically.        │
│                                          │
│   > pip install wandb                    │  ← code-md, surface-container bg
│   > wandb login                          │
│   > python train.py                      │
│                                          │
└──────────────────────────────────────────┘
```

**I.2 Tracker offline:**

Inline banner at top of Editor (40px tall, `error-container` bg at 30% opacity, error text, 1px error bottom border):
"W&B unreachable. Showing last synced data from 14 minutes ago. [Retry]"

Decorations remain visible but show ⚪ instead of status colors.

**I.3 Sync indicator (top-right of Run Timeline header):**

Animated 12px ring spinner in `primary` when syncing; static `primary` dot when idle; `error` when last sync failed.

---

### J. Component Library Snapshot (for Figma)

For consistency, these are the reusable atomic components the surface uses — please represent each as a variant set in Figma:

| Component | Variants | Tokens used |
|---|---|---|
| Button | primary / secondary / ghost / danger, sizes sm 28 / md 36 / lg 40 | surface, primary, outline |
| Input | default / focus / error / disabled | surface, outline, primary, error |
| Tab | active / inactive / hover | surface-container, primary, outline-variant |
| Run Status Dot | running / finished / failed / crashed / queued | tertiary, primary, error |
| Decoration Widget | run-anchor / live-metric / metric-anchor | surface-container, primary |
| Sparkline | positive / negative / neutral, sizes 24×24 / 60×18 / 200×40 | primary, error, outline |
| Tooltip | default / error | surface-container, outline-variant |
| Toast | success / error / info | inverse-surface, inverse-on-surface |
| Modal | default / onboarding | glassmorphism Level 2 |
| Chip | positive / negative / neutral | primary, error, outline at 10% bg |
| Progress Bar | running / finished / failed | primary, surface-container |

---

### K. Responsive Behavior

- **Minimum window:** 1280×720. Below this, the Inspector auto-collapses (240px taken from editor).
- **Sidebar below 1024:** auto-collapses to 48px (icons only). Toggling re-expands.
- **Run Timeline below 600:** auto-collapses to 36px header.
- **Utility dock never collapses.**

---

### L. Motion Spec (subtle, low-latency feel)

- **State transitions:** 120ms `ease-out` for color/opacity changes.
- **Panel collapse/expand:** 180ms `ease-in-out`, transform + width.
- **Decoration entry:** fade-in 200ms, slight 4px downward translate.
- **Status dot pulse (running):** 1.6s infinite, opacity 0.4 → 1.0.
- **Sync indicator:** 360° rotation, 800ms linear infinite.
- **Hover cards:** 100ms fade-in, 8px Y translate.

All motion respects `prefers-reduced-motion` (disables translate, keeps opacity).

---

### M. Accessibility Notes

- All interactive elements reachable via keyboard. Tab order: Utility Dock top→bottom → Sidebar → Editor → Run Timeline → Inspector → Status Bar.
- Focus ring: 2px `primary` outline with 2px offset, always visible (no `outline: none`).
- Color contrast: all text against background ≥ 4.5:1 (verified against `on-surface` on `surface` = 14.8:1).
- Sparklines have textual fallback for screen readers (`aria-label="val_loss trend over 8,420 steps, final value 0.31"`).
- All decoration widgets have `aria-label` describing the run.

---

This is the full surface description. **Now over to you for the Figma sketch.** Once you pass back the Figma link (or screenshots), I'll:

