That image URL isn't accessible from here — looks like a private cloud storage link that needs authentication. Could you share it a different way? Options:

- Drag-and-drop directly into the chat if the IDE supports it
- A public link (Imgur, GitHub Gist, etc.)
- Or just describe what you're seeing and I'll work from that

In the meantime, I can work from the description: **an Experiments tab that works like editor tabs** — so `train.py` and `model.py` are tabs on the right side of the editor, and `Experiments` gets its own tab in the same strip. Clicking it opens a full panel that surfaces all usable ML artifacts for the selected run. That's a clean mental model. Let me design it on that basis and we can correct against the image once you can share it.

---

## Experiments Tab — design

### Position in the tab strip

The editor area has a tab strip. Standard file tabs live on the left cluster; `Experiments` and `+` (new split) live on the right cluster, pinned to the right edge of the tab bar:

```
┌─────────┬─────────────────────────────────────────────────────────────┐
│ ≡       │  train.py  model.py  utils.py  │  Experiments  [+]  ⌘K    │
└─────────┴─────────────────────────────────────────────────────────────┘
```

`Experiments` is not a panel that opens below or beside the editor — it's a **first-class tab** in the editor strip, taking the same space as any code file. When active, the editor shows the Experiments panel instead of code. When inactive, a small indicator on the tab shows whether there are unread / new artifacts since the last visit.

### Experiments tab anatomy

```
┌────────────────────────────────────────────────────────────────────────┐
│                                                                        │
│  ┌─────────────────────────────────────────────┐  ┌─────────────────┐ │
│  │ RUN: a3f9c12_diverged     RUN: b4c8f30     │  │ CURRENT RUN     │ │
│  │ val_loss 0.51 → diverged  val_loss 0.42   │  │                 │ │
│  │ 8m ago · finished         2h ago · done   │  │ a3f9c12         │ │
│  └─────────────────────────────────────────────┘  │ Diverged        │ │
│                                                   │                 │ │
│  ┌─────────────────────────────────────────────┐  │ QUICK STATS     │ │
│  │  ████ ARTIFACTS                           │  │ Loss  0.5123   │ │
│  │                                             │  │ LR    0.0031   │ │
│  │  🗁 best_model.pt   142MB  model/weights  │  │ Step  5,000    │ │
│  │  🗁 train_logs.csv  8MB   metrics/logs    │  │ Time  8m 12s   │ │
│  │  🗁 config.yaml     2KB   config          │  │                 │ │
│  │  🗁 predictions.json 12MB  outputs/preds  │  │ ARTIFACTS (4)  │ │
│  │  🗁 grad_hist.pt   89MB   diagnostics    │  │ ▶ best_model.pt │ │
│  │  + 1 more                             ▶   │  │ ▶ predictions   │ │
│  │                                             │  │ ▶ grad_hist.pt │ │
│  └─────────────────────────────────────────────┘  │                 │ │
│                                                   │ DIFF vs b4c8f30│ │
│  ┌─────────────────────────────────────────────┐  │ ▶ Show diff     │ │
│  │  ████ CONFIG                               │  │                 │ │
│  │                                             │  │ ⌘E Open in     │ │
│  │  optimizer        AdamW       [edited]     │  │ Inspector       │ │
│  │  lr               0.0031      [edited]     │  │                 │ │
│  │  weight_decay     1e-4        [edited]     │  └─────────────────┘ │
│  │  warmup_steps     500         [edited]     │                      │
│  │  batch_size       64          [edited]     │                      │
│  │  epochs           20          [edited]     │                      │
│  │  scheduler        cosine_wr   [edited]     │                      │
│  │                                             │  │                  │
│  │  🔍 Search config…                         │  │                  │ │
│  └─────────────────────────────────────────────┘  │                  │
│                                                   │                  │
│  ┌─────────────────────────────────────────────┐  │                  │
│  │  ████ METRICS  [sparkline toggle]           │  │                  │
│  │                                             │  │                  │
│  │  train/loss  ████████████→ 0.21          │  │                  │
│  │  val/loss    ████████████→ 0.51 (⚠)       │  │                  │
│  │  train/acc   ██████████████  0.94         │  │                  │
│  │  val/acc     ██████████░░░  0.87          │  │                  │
│  │  lr          ██████████░░░░  3.1e-3       │  │                  │
│  │                                             │  │                  │
│  │  ⚠ val/loss diverged at step 4,800         │  │                  │
│  │  ⚠ val/acc dropped 0.04 vs best            │  │                  │
│  │                                             │  │                  │
│  │  ↗ Compare with: [b4c8f30 ▼]               │  │                  │
│  └─────────────────────────────────────────────┘  │                  │
│                                                   │                  │
│  ┌─────────────────────────────────────────────┐  │                  │
│  │  ████ PROVENANCE                            │  │                  │
│  │                                             │  │                  │
│  │  commit  a3f9c12  HEAD                     │  │                  │
│  │  branch   feature/lr-sweep                  │  │                  │
│  │  author   Jane D. <jane@…>                  │  │                  │
│  │  started  8 minutes ago                     │  │                  │
│  │  duration  8m 12s                           │  │                  │
│  │                                             │  │                  │
│  │  📄 Files touched (3)                       │  │                  │
│  │  train.py        +12 −3      ▶ Open diff   │  │                  │
│  │  model.py        +1  −1      ▶ Open diff   │  │                  │
│  │  configs/lr.yaml +8  −0      ▶ Open diff   │  │                  │
│  └─────────────────────────────────────────────┘  │                  │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

Two-column layout, **left 65% / right 35%**, with a shared 16px gutter.

**Left column: scrollable card stack.** Four section cards stacked vertically with 12px gap:
- **Artifacts** — downloadable files, type-labeled, size, click-to-preview (images, text) or click-to-download (everything else).
- **Config** — full hyperparameters table, searchable, `[edited]` badge on lines that differ from the workspace default.
- **Metrics** — per-metric sparkline row with current value and a **warning strip** for anomalies (diverged, dropped, NaN). Sparkline toggle lets the user switch to a full metric curves chart.
- **Provenance** — git context + file-level diff list. Each file has an **Open diff** action that opens the git diff in a Monaco diff view in a new tab.

**Right column: sticky current run sidebar.** Stays fixed as the left column scrolls. Shows the currently selected run name + state badge, quick stats, artifact list (click-to-preview), the diff-vs comparator trigger, and a shortcut to open everything in the Run Inspector.

### Comparison mode

When the user selects two runs from the run strip at the top (shift-click or the `Compare with:` picker), the left column transforms from a single-run view to a side-by-side diff view:

```
┌──────────────────────────────────────────────────────────────────────┐
│  ┌────────────────────────┐  ┌────────────────────────┐              │
│  │  a3f9c12 (selected)    │  │  b4c8f30 (comparison) │              │
│  │  val_loss: 0.51 ⚠     │  │  val_loss: 0.42 ✓     │              │
│  └────────────────────────┘  └────────────────────────┘              │
│                                                                        │
│  Config diff                          Metrics overlaid                 │
│  ┌──────────────────────────────┐   ┌────────────────────────────┐   │
│  │  lr     0.0031  →  0.0015   │   │  [────── a3f9c12 ──────]  │   │
│  │  warmup 500     →  200       │   │  [────── b4c8f30 ──────]  │   │
│  │  sched  cosine_wr → cosine   │   │  val_loss: 0.51 vs 0.42   │   │
│  │  (all other params identical) │   │  Diverged at step 4,800    │   │
│  └──────────────────────────────┘   └────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

Config diff shows only the changed parameters. Metrics overlaid shows both sparklines on one chart with a step marker where they diverge.

### Artifact types and preview behavior

| Artifact type | Preview in-tab | Download | Open in external |
|---|---|---|---|
| `.pt` / `.pth` / `.safetensors` | Size + layer count + param count only | Yes | Yes (downloads) |
| `.csv` / `.json` | First 20 rows rendered as a table | Yes | Yes |
| `.yaml` / `.toml` / `.json` (config) | Syntax-highlighted in Monaco (read-only) | Yes | Yes |
| Images (`.png`, `.jpg`, `.gif`) | Thumbnail with expand on click | Yes | Yes |
| HTML (tensorboard exports, etc.) | Rendered iframe preview | Yes | Yes |
| Everything else | Icon + filename + size | Yes | Yes |

### Relation to the Run Inspector

The Experiments tab is the **editor-surface counterpart** to the Run Inspector panel. They show the same data, but:

- **Run Inspector** is a side panel — it sits beside the editor and doesn't take editor space.
- **Experiments tab** takes over the editor entirely — it's what you open when you want to think in the data, not write code.

Opening a run from the Run Inspector with `⌘E` opens the Experiments tab for that run. The Run Inspector's "Open in Experiments" button is the bridge. The two surfaces are kept consistent — selecting a run in one updates the other's selection state.

### Relation to the Agent

When a Debugger thread has a hypothesis in flight, it can open its evidence directly into the Experiments tab. The agent posts a card that says:

> "To verify this hypothesis, examine [Artifacts → best_model.pt → layer 12 gradients] and [Metrics → val/loss trajectory, step 4800–5000]."

And the card has a chip: **"Open in Experiments"** — which switches to the Experiments tab and highlights exactly those two artifacts. This is the agent's read path made tangible in the UI.

---

That's the Experiments tab. Still the only thing I'm working from is the description — tab-as-first-class, all usable artifacts surfaced. Want to share that image so I can verify against what you actually have in mind before I commit this to the spec doc?