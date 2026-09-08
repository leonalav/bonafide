

Three structural changes to the bottom of the Inspector Agent tab (and the matching composer in Workflow threads):

1. **The composer gains a real control bar** — mode picker, model picker, two utility buttons, send. Mirrors the affordances you flagged in image 2.
2. **The mode dropdown is the four-role taxonomy** — `Debug`, `Scaffold`, `Plan`, `Research` — with `Plan` and `Research` muted as designed-but-deferred, matching what we locked in brainstorming.
3. **A context-sensitive chip row sits between the action buttons and the composer** — so the chatbox isn't the only way to drive the next move.

---

## The composer, closed and open

### Closed state (default in any thread)

```
┌────────────────────────────────────────────────────────────────────────┐
│ [⚙ Debug ▼]   Claude Fable 5.1 · 1M Max ▼      [⟲]  [📎]  [➤]      │
├────────────────────────────────────────────────────────────────────────┤
│ Type a follow-up…                                                     │
└────────────────────────────────────────────────────────────────────────┘
```

- **Total height:** 88px (top control row 36px + input row 52px). Grows to 6 lines max (≈200px), then internal scroll.
- **Top row** sits on `surface-container-low`; **input row** sits on `surface-container`. Hairline 1px `outline-variant` divider between them.
- Border-radius 12px (matches Inspector card radius).
- Focus state: 1px `primary` border, 2px `primary` outer glow — same as other inputs.
- Send button (`➤`) is 28×28, circular, `primary-container` bg, `on-primary-container` icon. Disabled (40% opacity) when input is empty.
- Paperclip (`📎`) opens an attachment popover: Runs, Files, Past proposals. Selected attachments render as small chips above the input.
- Loop icon (`⟲`) is the **auto-continue toggle** — when on (default for live investigations), the agent keeps working through hypothesis → verify cycles without prompting between rounds. When off, the agent stops after each verification and waits for user direction. Visually: loop icon is `primary` when on, `on-surface-variant` when off.

### Mode picker dropdown (open)

```
┌──────────────────────────────────┐
│  ACTIVE                           │
│                                  │
│  ⚙  Debug              ✓         │  ← current selection
│  ▤  Scaffold                     │
│                                  │
│  COMING IN v1.1                  │  ← label-caps, on-surface-variant
│                                  │
│  ∞  Plan                  ⓘ      │  ← 50% opacity, "info" dot
│  🔬 Research               ⓘ     │
│                                  │
│  ─────────────────               │
│  ⚙  Multitask        ⚒           │  ← "in design" pill
└──────────────────────────────────┘
```

- Dropdown width 280px, anchored to the picker. Padding 8px.
- Each row 36px, 12px row gap. Icon 16px in 24px leading cell, label `body-sm`, weight 500.
- Selected row has 3px `primary` left-bar + `surface-container-high` bg.
- `Plan` and `Research` are visually muted (50% opacity entire row, no hover) but clickable. Clicking them shows a tooltip card anchored to the row: *"This role ships in v1.1. The thread is created but won't receive replies yet."*
- `Multitask` is a designed role placeholder — same pattern as the Templates tab in Workflow. Locked with the `⚒` "in design" pill.
- Footer hairline divider is 1px `outline-variant` at 50% opacity.

### Model picker dropdown

```
┌──────────────────────────────────────────────────────┐
│  CURRENT                                              │
│                                                       │
│  ● Claude Fable 5.1          1M Max · $0.012/turn   ✓│  ← current
│  ○ Claude Sonnet 5.1           200k · $0.004/turn    │
│  ○ Claude Haiku 5.1             200k · $0.001/turn    │
│                                                       │
│  ─────────────────                                    │
│  + Add custom model endpoint                          │
│                                                       │
│  ⓘ Model selection affects reasoning depth and      │
│    tool-use fidelity. Default model recommended.     │
└──────────────────────────────────────────────────────┘
```

- Width 320px. Active row gets `primary` left-bar.
- Cost per turn is a hint, not a charge — Bonafide is local, model is the user's choice.
- "Custom model endpoint" reveals an inline form (base URL + API key field) for OpenAI-compatible endpoints (Ollama, vLLM, etc.).

---

## The full bottom strip

Putting it together, the bottom of the Inspector Agent tab now reads top-to-bottom as:

```
┌────────────────────────────────────────────────────────────────────────┐
│  [Reject]   [Request revision]   [Approve & apply]                    │  ← proposal actions
│                                                                        │
│  Quick suggestions                                                     │  ← label-caps
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ │
│  │ Compare      │ │ Show metric  │ │ Try smaller  │ │ Explain in   │ │
│  │ vs b4c8f30   │ │ trajectory   │ │ LR (×0.5)    │ │ plain terms  │ │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘ │
│                                                                        │
│  Composer (mode · model · loop · attach · send)                        │
└────────────────────────────────────────────────────────────────────────┘
```

- **Action buttons row** is only visible when there's an active proposal card. Hidden when the thread is mid-investigation with no proposal yet (the agent is the one talking).
- **Quick suggestions** are chip rows, generated from thread state. Source mapping:
  - `Compare vs <last-best-run>` — fires when one is selected.
  - `Show metric trajectory` — fires when a hypothesis card is visible.
  - `Try smaller LR (×0.5)` — fires when a hypothesis implicates LR, AND project memory doesn't already rule it out.
  - `Explain in plain terms` — always available.
  - `Re-run with this patch` — fires only when patch is approved-and-applied.
  - `Open in Workflow as a thread` — fires always; promotes the Inspector session to a Workflow thread.
- Chips are 28px tall, 12px padding, `surface-container-high` bg, 4px radius. Hover: `surface-container-highest`. Click: chip text fills the input box and submits immediately.

---

## Mode-aware composer behavior

The mode picker doesn't just decorate — it changes what the composer does:

| Mode | Submit input prefix | Toolset enabled |
|---|---|---|
| `Debug` | `▸ investigate: <input>` | All read tools + write-patch + smoke-run |
| `Scaffold` | `▸ scaffold: <input>` | Read tools + write-file + 60s scaffold-smoke |
| `Plan` | `▸ plan: <input>` (no-op for v1) | Read tools only — emits empty proposal card |
| `Research` | `▸ research: <input>` (no-op for v1) | Read tools only — emits empty proposal card |

So switching modes mid-thread is a meaningful action: the user is telling the agent "respond to my next message as if you were the Scaffolder role, even though this thread started as Debug." This is the structural payoff of separating Track A into roles.

When the user is in `Debug` and types a plain message, the composer shows a ghosted hint inside the input:

> `▸ investigating... Type a follow-up.`

In `Scaffold`:
> `▸ scaffolding... Describe what to build.`

In `Plan` / `Research` (locked):
> `▸ planning... (this role ships in v1.1)`

---

## The same composer in Workflow threads

The Workflow thread detail view's input bar at the bottom of the conversation log uses the **exact same composer component** — same dimensions, same mode picker, same model picker, same loop/attach/send row. The only differences:

- **Quick suggestions** are computed against the full thread history (not just the latest proposal), so chips can be more contextual (e.g. "Reference run 47 in your response," "Compare with the proposal from 2h ago").
- **Submitting** creates a new user message at the bottom of the conversation log (the Inspector variant submits into the active proposal flow).

This keeps the two surfaces feeling like the same product — same control surface, same role taxonomy, same model picker — just different in their relationship to run context.

---

## Quick Edit stays simple (Track B is dumb on purpose)

The Quick Edit modal I described earlier already had a model picker at the bottom — that doesn't change. It does **not** get a mode picker, because Track B has no agent involvement. Track B's mental model is "I'm editing code, give me one shot at it." Adding a mode picker would imply Track B has access to roles, and it doesn't.

Quick Edit's model picker shows the same model list but without the `Plan` / `Research` / `Multitask` cruft — it's a tighter dropdown, only the active models, since Quick Edit doesn't reason about workflow.

