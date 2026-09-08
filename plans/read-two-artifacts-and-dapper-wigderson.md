# Build the Bonafide IDE Surface

## Context

The project is an empty Vite + React 19 + Tailwind v4 scaffold (`src/App.tsx` is a blank
centered div; `src/index.css` only imports Tailwind). Two artifacts define what to build:

- `src/imports/DESIGN.md` — the **design system** "Bonafide Core": color tokens, typography
  (Geist Sans + Inter), radii, spacing, and component/elevation rules. This is authoritative
  for tokens and visual craft (supersedes generated themes; no Make Kit is present).
- `src/imports/pasted_text/bonafide-design-spec.md` — the **surface spec**: a dark-mode ML
  engineering IDE with a Utility Dock, Navigation Sidebar, Editor surface with inline gutter
  decorations, Run Timeline, Run Inspector, status bar, onboarding, and states.

Goal: implement a static-but-interactive, mocked-data reproduction of this IDE that faithfully
follows the tokens in `DESIGN.md` and the layout/behavior in the surface spec.

## Approach

Build the full application window as a composed set of components, driven by local mock data
and React state (no backend). Everything is client-side and visual.

### 1. Tokens & fonts — `src/index.css`
- Add Google Fonts `@import` for **Geist** and **Inter** as the first non-comment line.
- Define a Tailwind v4 `@theme` block mapping every `DESIGN.md` color token to a CSS custom
  property so utilities work: `bg-surface`, `bg-surface-container-low/high/highest`,
  `text-on-surface`, `text-on-surface-variant`, `text-primary`, `border-outline-variant`,
  `text-tertiary`, `text-error`, etc. Map radii (`--radius-*`, default 0.25rem) and fonts
  (`--font-sans` = Geist, `--font-body` = Inter).
- Add small utilities/keyframes for the motion spec (Section L): `pulse` (1.6s status dot),
  `spin` (sync ring 800ms), decoration fade-in, hover-card fade. Wrap animations in a
  `@media (prefers-reduced-motion: reduce)` guard that keeps opacity, drops translate.
- Do NOT add an unlayered `* {}` reset.

### 2. Mock data — `src/data/runs.ts`
Typed run objects (name, short-hash, state, duration, commit, metric series for
loss/val_loss/acc, env, config) plus the file tree and artifact lists. Powers the sidebar,
timeline, inspector, and gutter decorations from one source.

### 3. Component tree — `src/App.tsx` + `src/components/`
`App.tsx` renders the fixed shell and owns top-level UI state (active dock item, selected run,
open tabs, panel collapse/inspector-open flags). Components:

- `TitleBar.tsx` — 32px, traffic-light left, "Bonafide" wordmark center, window controls right.
- `UtilityDock.tsx` — 48px, square icon buttons (Explorer, Runs, Experiments, Artifacts, Git,
  Search, Extensions) with flex spacer then Account/Settings; active = 2px `primary` left bar +
  `surface-container` bg; account `primary` dot. Lucide icons.
- `Sidebar.tsx` (240px) with `ExplorerView.tsx` (file tree, 24px rows, selected = left border +
  `surface-container-high`) and `RunsView.tsx` (status summary chips, grouped run rows with
  status dots + delta chips). View swaps with the active dock item.
- `EditorPane.tsx` — `TabStrip.tsx` (36px, active tab 2px `primary` top border) + a
  `CodeSurface.tsx` rendering `train.py` as statically syntax-highlighted lines (spans colored
  per the Monaco token colors in D) with a 56px gutter, and inline `GutterDecoration.tsx`
  widgets (run-anchor / live-metric / metric-anchor) using `Sparkline`.
- `RunTimeline.tsx` — bottom panel, resizable-feel, header (Hide/Filter/Sort) + comparison grid
  with 60×18 sparkline cells, sortable `label-caps` headers, selected row highlight, collapsed
  36px summary state.
- `Inspector.tsx` (320px) — header + tab strip (Overview / Metrics / Config / Diff / Artifacts),
  each tab implemented: Overview (status + progress + key metrics + mini sparkline + env),
  Metrics (pill toggles + line chart + step slider), Config (key/value), Diff (added/removed
  line backgrounds at 10% primary/error), Artifacts (typed icon rows).
- `StatusBar.tsx` — 24px three-zone flex (git / runtime / tracker+notifications).
- `Sparkline.tsx` — reusable inline-SVG sparkline (sizes 24, 60×18, 200×40; positive/negative/
  neutral coloring). Built by hand, no chart dependency. Includes `aria-label` fallback.
- `Onboarding.tsx` — Level-2 glassmorphism modal (80% opacity, 20px backdrop blur, Silver
  hairline border): Welcome → W&B sign-in → Workspace picker steps, dismissable, gated behind a
  first-run state flag with a "Reset onboarding" affordance for demo.
- Shared atoms in `src/components/ui/`: `Button` (primary/secondary/ghost/danger, sm/md/lg),
  `Chip`, `StatusDot`, `Tab`, `HoverCard`/`Tooltip`, matching Section J.

### 4. Dependencies
- Add `lucide-react` for icons (used throughout the dock, tree, tabs, artifacts).
- No chart library — sparklines/charts are hand-built inline SVG.

### 5. Behavior / interactivity (mocked)
Dock switches sidebar view; clicking a run in the sidebar/timeline selects it and updates the
Inspector; tabs open/close; timeline and inspector collapse toggles; running runs show the
pulsing amber dot and a spinning sync ring. Provenance/hover cards on decorations.

## Files
- Edit: `src/App.tsx`, `src/index.css`, `package.json` (add `lucide-react`).
- New: `src/data/runs.ts`; `src/components/*` and `src/components/ui/*` as listed above.

## Verification
- `pnpm dev` server is already running — confirm the preview renders the full window with no
  console errors.
- Run `pnpm build` once to typecheck/compile the new component tree.
- Spot-check against the spec: dock active bar, sidebar selected-row border, editor gutter
  decorations + sparklines, timeline comparison grid, inspector Diff coloring, onboarding
  glassmorphism, status bar zones. Verify tokens resolve (colors match DESIGN.md hexes) and
  `prefers-reduced-motion` disables translate-based motion.
