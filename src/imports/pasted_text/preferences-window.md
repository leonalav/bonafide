Got it — a single 60% Preferences window with Account and Settings as the two primary sections, opened from the dock's bottom two icons. Let me design it meticulously.

---

## Window Anatomy

**Dimensions:** 60% of fullscreen on a 1440×900 baseline = **864 × 540**. Centered over the parent app (not modal — it's a real OS-level window with its own chrome). Minimum 720 × 480, max 1100 × 760 (caps so it doesn't outgrow the parent).

**Window chrome:** 32px title bar. Traffic lights on macOS / minimize-maximize-close on Windows. Title: `Bonafide — Preferences`. Centered wordmark + subtle `◆` logo to the left of title.

**Layout:** Fixed 240px left rail + flexible right content area. Background `surface` (#111318). Inner padding 0 on the rail, 32px on the content area.

```
┌──────────────────────────────────────────────────────────────────────┐
│  ◆  Bonafide — Preferences                                  ─ □ ✕  │  ← 32px chrome
├──────────────┬───────────────────────────────────────────────────────┤
│              │                                                       │
│  Preferences │                                                       │
│              │                                                       │
│  Account     │                                                       │
│              │                                                       │
│              │                                                       │
│  ● signed-in │                                                       │
│              │                                                       │
│              │                                                       │
│              │                                                       │
│              │                                                       │
└──────────────┴───────────────────────────────────────────────────────┘
```

**Left rail (240px wide):**

```
┌──────────────────────────────────────┐
│                                      │  ← 24px top padding
│  PREFERENCES                         │  ← label-caps, on-surface-variant, 16px from top
│                                      │
│  ⚙  Settings                         │  ← 36px row, label-lg? No — body-md
│  👤  Account                         │     body-md (14px, weight 500)
│  ⌨  Keyboard shortcuts               │
│  🎨  Themes                          │
│  🔌  Extensions                      │
│                                      │
│                                      │
│  ── quick info ──                    │  ← 1px outline-variant divider
│                                      │
│  ● Connected to W&B                  │  ← caption, primary dot 6px
│  ⎇ main · a3f9c12                    │  ← caption, on-surface-variant
│  💾 247 MB cached                    │  ← caption, outline
└──────────────────────────────────────┘
```

Row anatomy:
- Height 36px, padding-left 16px
- Icon 16×16 in `on-surface-variant`, 12px gap to label
- Hover: bg `surface-container`
- Selected: bg `surface-container-high` + 3px `primary` left-border (slightly thicker than the dock's 2px because this is the primary nav of the window)
- Bottom-aligned "quick info" block: 16px padding, label-caps header

**Content area (right, ~624px wide):**

Scrollable, max-width 720px (centered if window grows). 32px padding all around. Section spacing 32px (`margin-lg`).

---

## Section 1: Account

The Account view is structured as five cards stacked vertically, each card is `surface-container` bg with 1px `outline-variant` border, 8px radius, 16px padding.

### 1.1 Card 1 — Profile

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ╭────╮                                                               │
│  │ 👤 │   Ada Lovelace                                    ✎ Edit    │  ← 72px header
│  ╰────╯   ada@bonafide.dev                                           │     body-lg name
│           Joined September 2026                                      │     caption meta
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

- Avatar: 48×48, `surface-container-high` bg, `on-surface-variant` person icon when no image set
- Name + email + join date stacked
- `✎ Edit` button (secondary, 28px) opens inline edit (turns card into a form: name input, email input, "Change photo" button, "Save" / "Cancel")
- After save: subtle 1.5s `primary` border pulse on the card

### 1.2 Card 2 — Connected Trackers (the most important card for Bonafide)

```
┌──────────────────────────────────────────────────────────────────────┐
│  CONNECTED TRACKERS                                                  │  ← label-caps header
│                                                                      │
│  ● Weights & Biases              ada@wandb.ai     [Manage] [×]       │  ← 48px row
│    Synced 12s ago · 27 runs · last login 2h ago                     │  ← caption meta
│                                                                      │
│  ○ MLflow                       Not connected     [Connect]          │
│    Self-hosted URL: [ http://localhost:5000 ]                        │
│                                                                      │
│  ○ Comet                        Not connected     [Connect]          │
│  ○ Neptune                      Not connected     [Connect]          │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

- Each provider row: 48px tall. Status dot 8px (`primary` if connected, `outline` if not).
- `Manage` opens a sub-section in the same content area (slide-in 200ms, no new window): refresh interval, default project, default metric for delta chips, whether to send git metadata automatically.
- `×` disconnects with confirmation modal.
- `Connect` triggers OAuth in browser (W&B / Comet / Neptune) or accepts API key (MLflow self-hosted: input + "Test connection" button below).

**Why this matters:** Bonafide's core feature (inline decorations) only works if at least one tracker is connected. Account → Trackers is the gateway.

### 1.3 Card 3 — Connected Services

```
┌──────────────────────────────────────────────────────────────────────┐
│  CONNECTED SERVICES                                                  │
│                                                                      │
│  ● GitHub                       ada               [Manage] [×]       │
│    23 repos accessible                                              │
│                                                                      │
│  ● Hugging Face                 ada               [Manage] [×]       │
│    4 orgs · write access                                             │
│                                                                      │
│  ○ Slack                        Not connected     [Connect]          │
│    For run notifications                                             │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

- Same row anatomy as trackers but slightly less critical (Bonafide works without these).
- Slack uses an OAuth flow + a "channel picker" inline (`#ml-experiments ▼`).
- GitHub's `Manage` shows: org list, default branch for new workspaces, repo allowlist.

### 1.4 Card 4 — Workspace

```
┌──────────────────────────────────────────────────────────────────────┐
│  WORKSPACE                                                           │
│                                                                      │
│  Current:    /Users/ada/projects/bona-train                          │
│              Last opened 4 minutes ago                               │
│                                                                      │
│  Recent:                                                           │
│  ▸ /Users/ada/projects/vision-experiments          27 runs           │
│  ▸ /Users/ada/projects/llama-finetune              12 runs           │
│  ▸ /Users/ada/projects/recommender                 218 runs          │
│  ▸ + Open another folder…                                            │
│                                                                      │
│  [▢ Open at login]                                                   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

- Current row highlighted with 2px `primary` left-border.
- Recent rows: 32px, hover bg, click switches workspace (closes Preferences, opens new workspace in main app).
- Open-at-login checkbox: standard.

### 1.5 Card 5 — Subscription & Sign Out

```
┌──────────────────────────────────────────────────────────────────────┐
│  PLAN                                                               │
│                                                                      │
│  Pro · $20/month                                  [Manage billing]   │
│  Renews October 5, 2026                                              │
│                                                                      │
│  USAGE THIS MONTH                                                    │
│  ────░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  2.1 GB / 50 GB           │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  [Sign out]                                            ghost, error text on hover
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

- Sign out button is full-width within its card, but rendered as `ghost` variant with `error` text color on hover. Confirmation modal on click.

---

## Section 2: Settings (when ⚙ Settings is selected in the rail)

Seven cards, same visual pattern as Account.

### 2.1 Card 1 — Editor

```
┌──────────────────────────────────────────────────────────────────────┐
│  EDITOR                                                              │
│                                                                      │
│  Font family     [Geist Sans                            ▼]           │
│  Font size       [────●──] 14                                         │
│  Tab size        [2 ▼]                                                │
│  Insert spaces   [●○]  [ ○ Use tabs ]                                │
│  Word wrap       [ ○ off ]  [ ● on ]                                  │
│  Minimap         [ ● on ]  [ ○ off ]                                  │
│  Cursor style    [ ● line ]  [ ○ block ]  [ ○ underline ]              │
│  Render whitespace    [ ○ off ]  [ ● selection ]  [ ○ all ]           │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

- Font size slider: 10–24px, live preview on the right side ("Aa" sample in current font)
- All controls 28px tall, 8px gap between rows
- Radios are custom: 16px circle, 8px inner dot when selected, `primary` color

### 2.2 Card 2 — Python & Environments

```
┌──────────────────────────────────────────────────────────────────────┐
│  PYTHON                                                              │
│                                                                      │
│  Interpreter    [🐍 /usr/local/bin/python3.11  ▼]      [Detect]      │
│  Version        3.11.4                                                │
│  Virtual env    bonafide-train (.venv)  ✓                            │
│  Packages       torch 2.2.1 · transformers 4.36 · wandb 0.16          │
│                                                                      │
│  ── detect on workspace open ──                                      │
│  [●] Auto-detect .venv or conda env                                  │
│  [ ] Always use system Python                                        │
│  [ ] Use python from $PATH                                           │
│                                                                      │
│  ── formatting on save ──                                            │
│  Formatter      [Ruff                                ▼]               │
│  [●] Format on save                                                  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

- Interpreter dropdown shows all detected envs (system, .venv, conda envs, pyenv versions). Selecting one triggers a 1–2s "Detecting…" state.
- Packages line is a collapsed view — click expands to a scrollable list (height 200px max).
- Formatter dropdown: Ruff (default), Black, autopep8, yapf, none. Ruff is **the** default for ML projects in 2026.

### 2.3 Card 3 — Trackers

```
┌──────────────────────────────────────────────────────────────────────┐
│  TRACKERS                                                            │
│                                                                      │
│  Default project    [bonafide-train                              ]   │
│                                                                      │
│  Sync interval                                                       │
│  ● 5s    ○ 10s    ○ 30s    ○ 1m    ○ 5m                              │
│                                                                      │
│  On file save                                                        │
│  [●] Re-index workspace                                              │
│  [●] Send git metadata to trackers                                   │
│  [ ] Run pre-commit hooks                                            │
│                                                                      │
│  Decorations                                                         │
│  [●] Show run anchor decorations                                     │
│  [●] Show live metric sparklines                                     │
│  [●] Show code provenance borders                                    │
│  [ ] Animate status dots                                             │
│                                                                      │
│  Delta chip metric      [val_loss                                ▼]  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

This is the ML-specific settings — every option directly affects what the user sees in the gutter.

### 2.4 Card 4 — Notifications

```
┌──────────────────────────────────────────────────────────────────────┐
│  NOTIFICATIONS                                                       │
│                                                                      │
│  When a run finishes                                                 │
│  [●] Toast in app                                                    │
│  [●] Native OS notification                                         │
│  [ ] Email                                                           │
│  [ ] Slack (channel: #ml-experiments)                                │
│                                                                      │
│  When a run fails                                                    │
│  [●] Toast in app                                                    │
│  [●] Native OS notification                                         │
│  [●] Email                                                           │
│  [●] Slack                                                           │
│                                                                      │
│  When a better run appears                                           │
│  [ ] Toast in app                                                    │
│  [ ] Native OS notification                                         │
│                                                                      │
│  Quiet hours                                                         │
│  From [22:00] to [08:00]   [●] Enabled                               │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

- Quiet hours pause non-error notifications.
- Notification preferences sync across devices via the Bonafide account (foreshadows future multi-device; v1 stores locally).

### 2.5 Card 5 — Privacy & Telemetry

```
┌──────────────────────────────────────────────────────────────────────┐
│  PRIVACY                                                             │
│                                                                      │
│  [ ] Send anonymous usage analytics                                  │
│      Helps improve Bonafide. No code or run data is ever sent.        │
│                                                                      │
│  [ ] Send crash reports                                              │
│      Includes stack traces only, no file contents.                   │
│                                                                      │
│  Data storage                                                        │
│  Cache location    ~/Library/Application Support/Bonafide            │
│                     [Open in Finder]   [Change location…]             │
│  Cache size        247 MB                                             │
│                     [Clear cache]                                     │
│                                                                      │
│  GDPR                                          [Request data export]  │
│                                              [Delete account]        │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

- `Clear cache` shows a confirmation: "This will require re-syncing 27 runs (~2 min). Continue?"
- GDPR row uses `error` text color on hover for "Delete account" (destructive action confirmation modal: type your email to confirm).

### 2.6 Card 6 — Updates

```
┌──────────────────────────────────────────────────────────────────────┐
│  UPDATES                                                             │
│                                                                      │
│  Current version        Bonafide 0.3.1 (build 7f3a91c)                │
│  Channel                [Stable ▼]                                    │
│  [Check for updates]    Last checked 14 minutes ago                   │
│                                                                      │
│  [●] Auto-download updates                                           │
│  [ ] Install automatically (no prompt)                               │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

- Channel options: Stable (default), Beta. No "nightly" for v1.

### 2.7 Card 7 — Advanced

Collapsed by default (single row), expands to:

```
┌──────────────────────────────────────────────────────────────────────┐
│  ADVANCED                                              [▾ Expand]    │
└──────────────────────────────────────────────────────────────────────┘

(when expanded:)

┌──────────────────────────────────────────────────────────────────────┐
│  ADVANCED                                              [▴ Collapse]  │
│                                                                      │
│  IPC port          7654                                               │
│  Python shim socket    ~/.bonafide/shim.sock                         │
│  Local DB          ~/Library/Application Support/Bonafide/cache.db   │
│                                                                      │
│  [ ] Verbose logging (writes to ~/.bonafide/logs/)                    │
│  [ ] Enable experimental features                                    │
│  [ ] Allow Bonafide to write to ~/.bonafide/external/                 │
│                                                                      │
│  [Reset all settings to default]                                     │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Cross-window interactions

### Opening flow

- Click dock's `user-circle` icon (8) → opens Preferences window to **Account** section.
- Click dock's `settings` icon (9) → opens Preferences window to **Settings** section.
- Window remembers last-opened section per session.

### Window-level behaviors

- **Always-on-top toggle** in title bar (small pin icon right of title) — useful while watching a long training run.
- **ESC closes** the window.
- **⌘W closes** on Mac, **Ctrl+W** on Windows.
- If the parent app's workspace closes, Preferences window stays open (orphaned but valid).

### Account → Settings deep-linking

From the "Trackers" card in Account, the `Manage` button can deep-link to the relevant Settings sub-card by switching the rail selection to Settings and scrolling the content area to the **Trackers** card with a 1s subtle highlight pulse.

---

## Empty / Edge States

### No tracker connected (fresh install)

Account's Trackers card shows a banner at the top:

```
┌──────────────────────────────────────────────────────────────────────┐
│  ⚠  Connect a tracker to unlock inline decorations                   │
│      Bonafide works without one, but you'll only see file-level       │
│      git annotations.                              [Connect W&B →]   │
└──────────────────────────────────────────────────────────────────────┘
```

Banner: 12px padding, `error-container` bg at 20% opacity, `error` text. 1px `error` border at 30% opacity.

### Offline

When tracker unreachable, the connected tracker row shows:

```
● Weights & Biases     ada@wandb.ai       ⚠ unreachable  [Retry]
  Last sync 14 minutes ago · 27 cached runs
```

The ⚠ icon uses `tertiary` color (warning, not error — recoverable).

### Signed out

Rail shows:

```
ACCOUNT
👤  Sign in
```

And the content area is a full-card sign-in flow (compact version of the onboarding cards).

---

## Motion

- **Window open:** 180ms scale-from-0.96 + fade-in from the dock icon that triggered it (transform-origin follows the icon position).
- **Rail selection change:** 120ms `ease-out` crossfade on content area.
- **Card expand (Advanced):** 200ms height transition with content reveal.
- **Tracker row status change:** 300ms color transition on the status dot.

All motion respects `prefers-reduced-motion`.

---

## Accessibility

- All form controls keyboard-navigable in source order (top-to-bottom, left-to-right within cards).
- Focus order matches visual order.
- Radios and checkboxes have visible labels (not just the visual control).
- `aria-live="polite"` on the cache size number so screen readers announce when it changes after clear.
- All icons have `aria-hidden="true"`; meaning is conveyed by adjacent text.

---

That covers Account + Settings. Want me to fold this into the spec doc now, or continue iterating on other surfaces first (e.g., onboarding beyond the W&B flow, command palette, search panel)?