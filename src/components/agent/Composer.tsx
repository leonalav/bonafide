import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Icon } from "../ui/Icon"
import {
  useModelsStore,
  BUILT_IN_MODELS,
  type ModelFamily,
} from "../../modelsStore"
import type { ModeId } from "../../chats/types"
import { MODE_META, toCanonicalModeId } from "../../chats/types"
import type { Attachment } from "../../chats/ChatStore"
import { useWorkspaceRoot } from "../../ide/hooks"
import { bonafide, type BudgetStatus } from "../../ipc/tauri"
import {
  MentionMenu,
  computeCaretAnchor,
  filterMentionEntries,
  findActiveMention,
  useWorkspaceMentionEntries,
  type MentionEntry,
} from "../chat/MentionMenu"

// The mode picker surfaces the five canonical agent roles. The
// identifier (`id`) is the snake_case `AgentRole` value the Rust
// engine accepts verbatim, so picking a mode here is the only step
// required to route a message through the right system prompt +
// approval gate + tool allowlist.
const MODES = MODE_META

const HINTS: Record<ModeId, string> = {
  debugger: "▸ investigating… Type a follow-up.",
  scaffolder: "▸ scaffolding… Describe what to build.",
  planner: "▸ planning… Describe the goal you want to sequence.",
  researcher: "▸ researching… Describe the topic or paper to look up.",
  critic: "▸ reviewing… Describe a proposal you want reviewed.",
}

// Model IDs that are considered expensive (for budget lockout per spec §10)
const EXPENSIVE_MODEL_IDS = new Set([
  "claude-opus",
  "o1-preview",
])

/** Returns true when the given escalation level means expensive models should be locked. */
function shouldDisableExpensiveModels(escalation: BudgetStatus["escalation"]): boolean {
  return escalation === "caution" || escalation === "critical"
}

// ─── Click-outside backdrop ────────────────────────────────────────────────────
function Backdrop({ onClose }: { onClose: () => void }) {
  // Use onClick (not onMouseDown) so the button's onClick fires first.
  return (
    <div className="fixed inset-0 z-[60] cursor-default" onClick={onClose} />
  )
}

// ─── Viewport-aware positioning ────────────────────────────────────────────────

const MARGIN = 6 // px between anchor and popover edge
const MENU_HEIGHT_ESTIMATE = 240 // px — used to decide direction before render
const VIEWPORT_EDGE_PAD = 8 // px — keep popover off the viewport edges

function computePosition(
  anchor: DOMRect,
  menuWidth: number,
): { top: number left: number flip: boolean width: number } {
  const spaceBelow = window.innerHeight - anchor.bottom
  const flip = spaceBelow < MARGIN + MENU_HEIGHT_ESTIMATE
  // Clamp horizontal bounds so the popover never escapes the viewport.
  // Prefer anchoring flush-left with the button, then shift left if it
  // would overflow the right edge. If even the button's left edge is
  // past the viewport (very narrow window), shrink the width to fit.
  const maxLeft = Math.max(
    VIEWPORT_EDGE_PAD,
    window.innerWidth - VIEWPORT_EDGE_PAD - menuWidth,
  )
  const left = Math.min(Math.max(VIEWPORT_EDGE_PAD, anchor.left), maxLeft)
  const width = Math.min(
    menuWidth,
    window.innerWidth - VIEWPORT_EDGE_PAD - VIEWPORT_EDGE_PAD,
  )
  return {
    top: flip ? anchor.top - MARGIN : anchor.bottom + MARGIN,
    left,
    width,
    flip,
  }
}

// ─── Positioned popover (rendered via portal so it escapes overflow ancestors)
function Popover({
  anchor,
  width = 240,
  onClose,
  children,
}: {
  anchor: DOMRect | null
  width?: number
  onClose: () => void
  children: React.ReactNode
}) {
  if (!anchor) return null
  const {
    top,
    left,
    width: resolvedWidth,
    flip,
  } = computePosition(anchor, width)
  return createPortal(
    <>
      <Backdrop onClose={onClose} />
      <div
        style={{
          position: "fixed",
          top,
          left,
          width: resolvedWidth,
          transform: flip ? "translateY(-100%)" : undefined,
        }}
        className="z-[70] rounded-lg border border-outline-variant bg-surface-container p-1.5 shadow-xl"
      >
        {children}
      </div>
    </>,
    document.body,
  )
}

// ─── Mode row (used inside the dropdown) ───────────────────────────────────────
// Every canonical `AgentRole` is active today. The row renders a
// short description (from `MODE_META`) under the label via
// `title=` so users can tell what each mode does without clicking.
function ModeRow({
  m,
  active,
  onClick,
}: {
  m: typeof MODES[number]
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={m.desc}
      className={`relative flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-surface-container-high ${
        active ? "bg-surface-container-high" : ""
      }`}
    >
      {active && (
        <span className="absolute left-0 top-0 h-full w-[2px] rounded-full bg-primary" />
      )}
      <span className="flex w-4 shrink-0 justify-center">
        <Icon name={m.icon} size={12} className="text-on-surface-variant" />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate font-body text-[12px] font-medium text-on-surface">
          {m.label}
        </span>
      </span>
      {active && (
        <Icon name="check" size={11} className="shrink-0 text-primary" />
      )}
    </button>
  )
}

// ─── Model row (used inside the model dropdown) ───────────────────────────────
function ModelRow({
  m,
  active,
  onClick,
  disabled,
  disabledReason,
}: {
  m: { id: string name: string badge: string }
  active: boolean
  onClick: () => void
  disabled?: boolean
  disabledReason?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabledReason}
      className={`relative flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-surface-container-high ${
        active ? "bg-surface-container-high" : ""
      } ${disabled ? "opacity-50" : ""}`}
    >
      {active && (
        <span className="absolute left-0 top-0 h-full w-[2px] rounded-full bg-primary" />
      )}
      <Icon
        name={disabled ? "lock" : (active ? "check" : "circle")}
        size={11}
        className={active ? "text-primary" : "text-outline"}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-body text-[12px] text-on-surface">
          {m.name}
        </span>
        <span className="truncate font-sans text-[10px] text-outline">
          {m.badge}
        </span>
      </span>
    </button>
  )
}

// ─── Composer ─────────────────────────────────────────────────────────────────
export function Composer({
  onSubmit,
  onCancel,
  sending = false,
  seedText,
  resetKey,
  mode: controlledMode,
  builtinId: controlledBuiltinId,
  onModeChange,
  onBuiltinChange,
  /** Called when the user presses Esc or the inline cancel while sending. */
  /**
   * When true, the send button swaps to a Stop button and the textarea
   * becomes read-only. The parent owns the in-flight state — the
   * Composer just renders the affordance and invokes onCancel.
   */
  /**
   * When the value changes, the composer's textarea is reset to the
   * new value AND any staged attachments are cleared. Used by the
   * Rewind / Return affordance on prior user messages: the parent
   * sets `seedText` to the rewound message content and bumps
   * `resetKey` so any leftover attachments from the previous send
   * don't survive.
   *
   * Pass `null` to clear without setting text (the parent uses this to
   * indicate "no edit in progress").
   */
  /**
   * Monotonically-increasing key. Bumping this value triggers the
   * seedText effect regardless of whether the text actually changed
   * — needed for Return-to-composer where the parent re-seeds the
   * same message twice in a row.
   */
  /** Controlled mode — when provided, the Composer is controlled and calls
   *  onModeChange instead of managing mode internally. */
  /** Controlled built-in model — used when mode is controlled. */
  /** Called whenever the mode picker changes. */
  /** Called whenever the built-in model picker changes. REVIEW(opus) F-4
   *  [final]: previously this was a silent no-op in controlled mode. */
}: {
  onSubmit?: (text: string, attachments: Attachment[]) => void
  onCancel?: () => void
  sending?: boolean
  seedText?: string | null
  resetKey?: number
  mode?: ModeId
  builtinId?: ModelFamily
  onModeChange?: (mode: ModeId) => void
  onBuiltinChange?: (id: ModelFamily) => void
}) {
  const workspaceRoot = useWorkspaceRoot()

  const [loop, setLoop] = useState(true)
  const [text, setText] = useState("")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [menu, setMenu] = useState<"mode" | "model" | null>(null)

  // @-mention menu state. The menu opens whenever the user's caret
  // sits inside an active `@`-reference (handled by `findActiveMention`)
  // and closes whenever they type whitespace or move the caret out.
  const allEntries = useWorkspaceMentionEntries()
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState("")
  const [mentionStart, setMentionStart] = useState(-1)
  const [mentionHighlight, setMentionHighlight] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [mentionAnchor, setMentionAnchor] =
    useState<ReturnType<typeof computeCaretAnchor>>(null)

  // Filtered + ranked entries for the current query.
  const mentionEntries = useMemo<MentionEntry[]>(
    () => filterMentionEntries(allEntries, mentionQuery).slice(0, 50),
    [allEntries, mentionQuery],
  )

  // Whenever the entry list shrinks below the highlighted index,
  // clamp the highlight so the cursor doesn't sit on a phantom row.
  useEffect(() => {
    if (mentionHighlight >= mentionEntries.length) {
      setMentionHighlight(0)
    }
  }, [mentionHighlight, mentionEntries.length])

  // Controlled mode: parent owns the state, we just call onModeChange.
  // Uncontrolled mode: own state internally.
  const [internalMode, setInternalMode] =
    useState<ModeId>("debugger")
  const mode = controlledMode ?? internalMode

  // REVIEW: defensively canonicalise the incoming mode so a stale
  // persistence row or a typo in a parent can't make `MODES.find`
  // return undefined and crash on `activeMode.icon`. `toCanonicalModeId`
  // maps every legacy / shorthand label back to a known `ModeId`, so
  // `MODES.find(...)` is guaranteed to match. We additionally fall
  // back to the Debugger row in the (impossible-after-canonicalise)
  // case that the lookup still misses.
  const safeMode = toCanonicalModeId(mode)
  const activeMode =
    MODES.find((m) => m.id === safeMode) ?? MODES[0]!

  // Controlled built-in model.
  const [internalBuiltinId, setInternalBuiltinId] =
    useState<ModelFamily>("fable")
  const builtinId = controlledBuiltinId ?? internalBuiltinId

  function changeMode(id: ModeId) {
    if (controlledMode !== undefined) {
      onModeChange?.(id)
    } else {
      setInternalMode(id)
    }
  }

  function changeBuiltinId(id: ModelFamily) {
    if (controlledBuiltinId !== undefined) {
      // REVIEW(opus) F-4 [final]: in controlled mode, hook through to
      // the parent via onBuiltinChange so the thread store can pick up
      // the user's selection.
      onBuiltinChange?.(id)
    } else {
      setInternalBuiltinId(id)
    }
  }

  // Keyboard: Escape cancels the in-flight request.
  useEffect(() => {
    if (!onCancel) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault()
        onCancel?.()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onCancel])

  // When `seedText` (or `resetKey`) changes, replace the local
  // textarea content AND clear any staged attachments. The parent
  // drives this from the Return affordance so the user can
  // immediately tweak and resubmit without dragging leftover
  // attachments from the prior send.
  useEffect(() => {
    if (seedText === undefined) return
    setText(seedText ?? "")
    setAttachments([])
  }, [seedText, resetKey])

  // Budget status — drives the expensive-model lockout in the model
  // picker per spec §10. Polled once on mount + whenever the workspace
  // changes; the value is re-fetched after every successful send so
  // the picker reflects the latest spend ratio.
  const [budget, setBudget] = useState<BudgetStatus | null>(null)
  useEffect(() => {
    if (!workspaceRoot) {
      setBudget(null)
      return
    }
    let cancelled = false
    void bonafide.agent
      .getBudgetStatus(workspaceRoot)
      .then((b) => {
        if (!cancelled) setBudget(b)
      })
      .catch(() => {
        // Surface budget lookup failures silently — the picker
        // degrades to "all models enabled" when we can't read the
        // status, which is a safe default.
        if (!cancelled) setBudget(null)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceRoot])

  const expensiveLocked = budget
    ? shouldDisableExpensiveModels(budget.escalation)
    : false

  const modeBtnRef = useRef<HTMLButtonElement | null>(null)
  const modelBtnRef = useRef<HTMLButtonElement | null>(null)
  const [modeAnchor, setModeAnchor] = useState<DOMRect | null>(null)
  const [modelAnchor, setModelAnchor] = useState<DOMRect | null>(null)

  const { config, selectedEndpoint, selectEndpoint } = useModelsStore()

  // Recompute anchor when window resizes / scrolls so the menu stays pinned.
  useEffect(() => {
    if (!menu) return
    function refresh() {
      if (menu === "mode") {
        setModeAnchor(modeBtnRef.current?.getBoundingClientRect() ?? null)
      } else {
        setModelAnchor(modelBtnRef.current?.getBoundingClientRect() ?? null)
      }
    }
    window.addEventListener("resize", refresh)
    window.addEventListener("scroll", refresh, true)
    return () => {
      window.removeEventListener("resize", refresh)
      window.removeEventListener("scroll", refresh, true)
    }
  }, [menu])

  const activeModeIcon = activeMode.icon
  const activeModeLabel = activeMode.label

  // Label + badge shown in the model picker button.
  const modelButtonLabel = selectedEndpoint
    ? selectedEndpoint.label
    : (BUILT_IN_MODELS.find((m) => m.id === builtinId)?.name ?? "Model")
  const modelButtonBadge = selectedEndpoint
    ? selectedEndpoint.defaultModel
    : (BUILT_IN_MODELS.find((m) => m.id === builtinId)?.badge ?? "")

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)

  // Maximum attachment size — picked so a 5MB image / a couple of
  // PDFs don't bloat localStorage beyond sane limits. Larger files
  // are silently rejected; the user can drop a comment in the
  // composer explaining the rejection.
  const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

  /**
   * Read one or more `File` objects into base64 data URLs and
   * append them as `Attachment` records. The data URL is what we
   * forward to the LLM (OpenAI's image_url.url accepts data: URLs)
   * and what we display in the user bubble.
   *
   * Reads happen one-at-a-time so the FileReader doesn't run out of
   * file handles on a 20-file paste. The whole list is rejected if
   * any one file exceeds the size cap — partial uploads are more
   * confusing than helpful.
   */
  async function ingestFiles(
    files: FileList | File[],
    asKind: "image" | "file",
  ) {
    const list = Array.from(files)
    const oversized = list.find((f) => f.size > MAX_ATTACHMENT_BYTES)
    if (oversized) {
      // For Phase 1 we just drop oversized files silently rather
      // than wiring a toast — the size cap is a soft guard, not a
      // product feature, and the composer textarea itself remains
      // usable. A toast would feel noisy for every accidental paste.
      return
    }
    const results: Attachment[] = []
    for (const f of list) {
      const dataUrl = await readFileAsDataUrl(f)
      results.push({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        kind: asKind,
        name: f.name,
        mime: f.type || "application/octet-stream",
        size: f.size,
        dataUrl,
      })
    }
    setAttachments((prev) => [...prev, ...results])
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  function submit() {
    if (!text.trim() && attachments.length === 0) return
    const trimmed = text
    // Snapshot attachments before clearing — setText + setAttachments
    // are async and the parent may already re-render with empty
    // composer state by the time onSubmit fires.
    const snapshot = attachments.slice()
    onSubmit?.(trimmed, snapshot)
    setText("")
    setAttachments([])
    setMentionOpen(false)
    setMentionQuery("")
    setMentionStart(-1)
  }

  // Refresh the active-mention state from the textarea. Called on
  // every change / selection / focus event so the menu tracks the
  // user's caret as they type. We deliberately re-read the
  // textarea's DOM (selectionStart, getBoundingClientRect) rather
  // than tracking caret via React state — selection changes can
  // happen via keyboard / mouse without an onChange fire.
  function refreshMentionFromCaret() {
    const el = textareaRef.current
    if (!el || sending) {
      if (mentionOpen) {
        setMentionOpen(false)
        setMentionQuery("")
        setMentionStart(-1)
      }
      return
    }
    const caret = el.selectionStart ?? 0
    const active = findActiveMention(text, caret)
    if (active) {
      setMentionOpen(true)
      setMentionQuery(active.query)
      setMentionStart(active.start)
      // Anchor the menu to the caret position (not the textarea
      // bounding rect). The mirror-element technique in
      // `computeCaretAnchor` measures the caret's true viewport
      // position, which keeps the menu glued to the `@` token even
      // on a multi-line composer where the textarea top is far
      // above the caret. Falls back to the textarea rect when the
      // textarea isn't laid out yet (e.g. first render after
      // opening the panel).
      const caretAnchor = computeCaretAnchor(el, active.start + 1)
      setMentionAnchor(caretAnchor ?? el.getBoundingClientRect())
      // Reset highlight when the query changes so the first match
      // is always the one Enter picks by default.
      setMentionHighlight(0)
    } else if (mentionOpen) {
      setMentionOpen(false)
      setMentionQuery("")
      setMentionStart(-1)
    }
  }

  // Insert a chosen entry's chip token at the active mention
  // position. Replaces the partial query text with the full
  // reference (so the user doesn't have to delete the partial
  // string themselves) and adds a trailing space so the next
  // keystroke doesn't run into the chip.
  function insertMention(entry: MentionEntry) {
    const el = textareaRef.current
    if (mentionStart < 0) return
    const caret = el?.selectionStart ?? mentionStart + 1 + mentionQuery.length
    const before = text.slice(0, mentionStart)
    const after = text.slice(caret)
    const inserted = `@${entry.relativePath} `
    const next = before + inserted + after
    setText(next)
    setMentionOpen(false)
    setMentionQuery("")
    setMentionStart(-1)
    // Place the caret right after the inserted chip so the user
    // can keep typing without having to reposition the cursor.
    requestAnimationFrame(() => {
      if (!textareaRef.current) return
      const pos = before.length + inserted.length
      textareaRef.current.focus()
      textareaRef.current.setSelectionRange(pos, pos)
    })
  }

  return (
    <div className="rounded-xl border border-outline-variant bg-surface-container-low focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
      {/* ── Control row ───────────────────────────────────────────────────── */}
      <div className="flex h-9 items-center gap-2 overflow-hidden rounded-t-xl px-2">
        {/* Mode picker */}
        <div className="relative">
          <button
            ref={modeBtnRef}
            onClick={() => {
              if (menu !== "mode") {
                setModeAnchor(
                  modeBtnRef.current?.getBoundingClientRect() ?? null,
                )
              }
              setMenu(menu === "mode" ? null : "mode")
            }}
            className="flex h-6 items-center gap-1.5 rounded border border-outline-variant px-2 font-sans text-[12px] text-on-surface hover:bg-surface-container"
          >
            <Icon
              name={activeModeIcon}
              size={13}
              className="text-on-surface-variant"
            />
            {activeModeLabel}
            <Icon name="chevron-down" size={11} className="text-outline" />
          </button>

          {menu === "mode" && (
            <Popover
              anchor={modeAnchor}
              width={220}
              onClose={() => setMenu(null)}
            >
              <div className="label-caps px-1.5 pb-0.5 pt-0.5 text-outline">
                Agent mode
              </div>
              {MODES.map((m) => (
                <ModeRow
                  key={m.id}
                  m={m}
                  active={mode === m.id}
                  onClick={() => {
                    changeMode(m.id)
                    setMenu(null)
                  }}
                />
              ))}
              <p className="flex gap-1.5 px-2 pb-1 pt-1.5 font-body text-[11px] text-outline">
                <span>ⓘ</span> Picking a mode routes your message
                through the matching tool allowlist + protocol.
              </p>
            </Popover>
          )}
        </div>

        {/* Model picker — `min-w-0` lets the button shrink; the label
            and badge each truncate independently so the chevron stays
            visible at any width. */}
        <div className="relative flex min-w-0 flex-1 items-center">
          <button
            ref={modelBtnRef}
            onClick={() => {
              if (menu !== "model") {
                setModelAnchor(
                  modelBtnRef.current?.getBoundingClientRect() ?? null,
                )
              }
              setMenu(menu === "model" ? null : "model")
            }}
            className="flex h-6 min-w-0 max-w-full items-center gap-1 rounded border border-outline-variant px-2 font-sans text-[12px] text-on-surface-variant hover:border-outline hover:bg-surface-container hover:text-on-surface"
          >
            <span className="min-w-0 truncate">{modelButtonLabel}</span>
            <span className="min-w-0 shrink truncate text-outline">
              {modelButtonBadge}
            </span>
            <Icon
              name="chevron-down"
              size={11}
              className="shrink-0 text-outline"
            />
          </button>

          {menu === "model" && (
            <Popover
              anchor={modelAnchor}
              width={260}
              onClose={() => setMenu(null)}
            >
              {/* Custom endpoint (if configured) */}
              {config.endpoints.length > 0 && (
                <>
                  <div className="label-caps px-1.5 pb-0.5 pt-0.5 text-outline">
                    Custom endpoint
                  </div>
                  {config.endpoints.map((ep) => (
                    <button
                      key={ep.id}
                      onClick={() => {
                        selectEndpoint(
                          config.selectedEndpointId === ep.id ? null : ep.id,
                        )
                        setMenu(null)
                      }}
                      className={`relative flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-surface-container-high ${
                        config.selectedEndpointId === ep.id
                          ? "bg-surface-container-high"
                          : ""
                      }`}
                    >
                      {config.selectedEndpointId === ep.id && (
                        <span className="absolute left-0 top-0 h-full w-[2px] rounded-full bg-primary" />
                      )}
                      <Icon
                        name={
                          config.selectedEndpointId === ep.id
                            ? "check"
                            : "circle"
                        }
                        size={11}
                        className={
                          config.selectedEndpointId === ep.id
                            ? "text-primary"
                            : "text-outline"
                        }
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-body text-[12px] text-on-surface">
                          {ep.label}
                        </span>
                        <span className="truncate font-sans text-[10px] text-outline">
                          {ep.defaultModel}
                        </span>
                      </span>
                    </button>
                  ))}
                  <div className="my-0.5 h-px bg-outline-variant/50" />
                  <div className="label-caps px-1.5 pb-0.5 pt-0.5 text-outline">
                    Built-in
                  </div>
                </>
              )}

              {/* Built-in models */}
              <div className="label-caps px-1.5 pb-0.5 pt-0.5 text-outline">
                {config.endpoints.length === 0 ? "Model" : ""}
              </div>
              {BUILT_IN_MODELS.map((m) => {
                const isExpensive = EXPENSIVE_MODEL_IDS.has(m.id)
                const disabled = expensiveLocked && isExpensive
                const reason = disabled
                  ? `Disabled — budget is ${budget?.escalation ?? "critical"}. Switch to a cheaper model or raise the budget in Preferences → Budget.`
                  : undefined
                return (
                  <ModelRow
                    key={m.id}
                    m={m}
                    active={selectedEndpoint === null && builtinId === m.id}
                    disabled={disabled}
                    disabledReason={reason}
                    onClick={() => {
                      changeBuiltinId(m.id as ModelFamily)
                      selectEndpoint(null)
                      setMenu(null)
                    }}
                  />
                )
              })}

              <div className="my-0.5 h-px bg-outline-variant/50" />
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault()
                  setMenu(null)
                  // Open Preferences to Models section.
                  window.dispatchEvent(
                    new CustomEvent("bonafide:open-prefs", {
                      detail: "models",
                    }),
                  )
                }}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left font-body text-[12px] text-primary hover:bg-surface-container-high"
              >
                <Icon name="plus" size={11} /> Configure endpoints…
              </a>
              <p className="flex gap-1.5 px-2 pb-1 pt-1.5 font-body text-[11px] text-outline">
                <span>ⓘ</span> Model selection affects reasoning depth and
                tool-use fidelity. Default model recommended.
              </p>
            </Popover>
          )}
        </div>

        <div className="flex-1" />

        {/* Loop toggle */}
        <button
          onClick={() => setLoop((v) => !v)}
          title={loop ? "Auto-continue: on" : "Auto-continue: off"}
          aria-pressed={loop}
          className={`flex h-6 w-6 items-center justify-center rounded hover:bg-surface-container ${
            loop ? "text-primary" : "text-on-surface-variant"
          }`}
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>

      {/* ── Input area ─────────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-b-xl border-t border-outline-variant bg-surface-container">
        {/* Attachment preview strip — only shown when there's at
            least one staged attachment. Right-aligned to mirror the
            user-bubble layout. Each chip has an X button to drop
            it before sending. */}
        {attachments.length > 0 ? (
          <div className="flex flex-wrap items-end justify-end gap-1.5 px-3 pt-2">
            {attachments.map((a) => (
              <ComposerAttachmentChip
                key={a.id}
                attachment={a}
                onRemove={() => removeAttachment(a.id)}
              />
            ))}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            // Defer to a microtask so the controlled value has
            // landed in the DOM before `findActiveMention` reads
            // selectionStart.
            queueMicrotask(refreshMentionFromCaret)
          }}
          onSelect={refreshMentionFromCaret}
          onFocus={refreshMentionFromCaret}
          onBlur={() => {
            // Delay closing so a click on a menu row (which fires
            // mousedown on the row, not the textarea) still has a
            // chance to insert the chip before the menu disappears.
            setTimeout(() => {
              if (
                document.activeElement &&
                document.activeElement.closest("[data-mention-menu]")
              ) {
                return
              }
              setMentionOpen(false)
              setMentionQuery("")
              setMentionStart(-1)
            }, 80)
          }}
          onKeyDown={(e) => {
            // Mention-menu keys: when the menu is open, hijack
            // ArrowUp/ArrowDown/Enter/Escape to drive selection
            // before they fall through to the textarea.
            if (mentionOpen && mentionEntries.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault()
                setMentionHighlight((h) =>
                  (h + 1) % mentionEntries.length,
                )
                return
              }
              if (e.key === "ArrowUp") {
                e.preventDefault()
                setMentionHighlight((h) =>
                  (h - 1 + mentionEntries.length) %
                    mentionEntries.length,
                )
                return
              }
              if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
                e.preventDefault()
                const entry = mentionEntries[mentionHighlight]
                if (entry) {
                  insertMention(entry)
                }
                return
              }
              if (e.key === "Escape") {
                e.preventDefault()
                setMentionOpen(false)
                setMentionQuery("")
                setMentionStart(-1)
                return
              }
            }
            // Enter sends; Shift+Enter (or Alt+Enter for Windows
            // users without an easy Shift modifier — a common
            // ergonomic ask) inserts a new line. We deliberately
            // leave the modifier-free Enter path alone to break the
            // textarea's default "newline" behaviour, which is the
            // standard for chat composers (Slack, Cursor, ChatGPT,
            // VS Code Copilot all use this convention).
            if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
              e.preventDefault()
              submit()
              return
            }
            if (e.key === "Enter" && (e.shiftKey || e.altKey)) {
              // Insert a newline by letting the default behaviour
              // run. React's controlled <textarea> will pick the
              // \n up on the next onChange tick.
              return
            }
          }}
          rows={2}
          disabled={sending}
          placeholder={text || attachments.length > 0 ? "" : HINTS[safeMode]}
          className="w-full resize-none bg-transparent px-3 pb-9 pt-2 font-body text-[13px] leading-[19px] text-on-surface placeholder:text-outline focus:outline-none disabled:opacity-60"
        />

        {/* @-mention menu — anchored to the textarea's bottom edge
            so it floats directly underneath (or above, when there's
            no room below). The `data-mention-menu` attribute is
            checked in the textarea's onBlur to keep the menu alive
            long enough for row clicks to fire. */}
        {mentionOpen ? (
          <div data-mention-menu>
            <MentionMenu
              anchor={mentionAnchor}
              query={mentionQuery}
              highlighted={mentionHighlight}
              entries={mentionEntries}
              onSelect={insertMention}
              onHighlight={setMentionHighlight}
              onClose={() => {
                setMentionOpen(false)
                setMentionQuery("")
                setMentionStart(-1)
              }}
            />
          </div>
        ) : null}

        {/* Hidden file inputs — the visible buttons below click these
            programmatically. We keep `accept` narrow so the picker
            opens with sensible defaults (image picker only shows
            images; generic picker shows everything but images, since
            those have their own button). */}
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = e.target.files
            if (files) void ingestFiles(files, "image")
            e.target.value = ""
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = e.target.files
            if (files) void ingestFiles(files, "file")
            e.target.value = ""
          }}
        />

        {/* Bottom-left: image + file pickers. Bottom-right: clipboard + send (or stop). */}
        <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center justify-between gap-1">
          <div className="pointer-events-auto flex items-center gap-0.5">
            <button
              type="button"
              title="Attach image"
              aria-label="Attach image"
              onClick={() => imageInputRef.current?.click()}
              className="flex h-7 w-7 items-center justify-center rounded text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
            >
              <Icon name="image" size={14} />
            </button>
            <button
              type="button"
              title="Attach file"
              aria-label="Attach file"
              onClick={() => fileInputRef.current?.click()}
              className="flex h-7 w-7 items-center justify-center rounded text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
            >
              <Icon name="paperclip" size={14} />
            </button>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              title="Paste from clipboard"
              onClick={async () => {
                try {
                  const v = await navigator.clipboard.readText()
                  if (v) setText((t) => (t ? `${t}\n${v}` : v))
                } catch {
                  /* clipboard read can be blocked; silently ignore */
                }
              }}
              className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
            >
              <Icon name="clipboard" size={14} />
            </button>
            {sending ? (
              <button
                type="button"
                onClick={() => onCancel?.()}
                aria-label="Stop"
                title="Stop the in-flight request (Esc)"
                className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full bg-error text-on-primary transition-opacity hover:brightness-110"
              >
                <span className="block h-2.5 w-2.5 rounded-[2px] bg-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!text.trim() && attachments.length === 0}
                aria-label="Send"
                className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full bg-primary text-on-primary transition-opacity disabled:opacity-40"
              >
                <Icon name="send" size={13} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── File / image helpers ─────────────────────────────────────────────────────

/** Read a `File` as a base64 data URL. Used by the attachment pipeline. */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () =>
      reject(reader.error ?? new Error("FileReader failed"))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(file)
  })
}

/** Compact preview of a staged attachment, shown above the textarea. */
function ComposerAttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: Attachment
  onRemove: () => void
}) {
  const isImage = attachment.kind === "image"
  if (isImage) {
    return (
      <div
        className="group/att relative h-12 w-12 shrink-0 overflow-hidden rounded border border-outline-variant/60 bg-surface-container-lowest"
        title={attachment.name}
      >
        <img
          src={attachment.dataUrl}
          alt={attachment.name}
          className="h-full w-full object-cover"
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove attachment"
          className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-bl bg-surface-container-highest/90 text-on-surface hover:bg-error hover:text-on-primary"
        >
          <Icon name="circle-x" size={9} />
        </button>
      </div>
    )
  }
  return (
    <div
      className="group/att relative flex max-w-[180px] items-center gap-1.5 rounded border border-outline-variant/60 bg-surface-container-low px-2 py-1"
      title={attachment.name}
    >
      <Icon
        name="file"
        size={12}
        className="shrink-0 text-on-surface-variant"
      />
      <span className="truncate font-body text-[11px] text-on-surface">
        {attachment.name}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove attachment"
        className="ml-1 flex h-4 w-4 items-center justify-center rounded text-outline hover:bg-error hover:text-on-primary"
      >
        <Icon name="circle-x" size={9} />
      </button>
    </div>
  )
}

// ─── QuickSuggestions ─────────────────────────────────────────────────────────
export function QuickSuggestions({
  items,
  onPick,
}: {
  items: string[]
  onPick: (t: string) => void
}) {
  if (!items.length) return null
  return (
    <div className="flex flex-col gap-1.5">
      <span className="label-caps text-on-surface-variant">
        Quick suggestions
      </span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="h-7 rounded bg-surface-container-high px-3 font-sans text-[12px] text-on-surface transition-colors hover:bg-surface-container-highest"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}
