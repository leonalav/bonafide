/**
 * ContextMenu.tsx — Glassmorphic right-click menu (DESIGN.md Level 2)
 *
 * Features:
 *   - Portal to body
 *   - Viewport flip (x right-edge, y bottom-edge)
 *   - Submenu hover-to-open (180ms)
 *   - Escape + outside-click close
 *   - Item, separator, submenu variants
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react"

import { createPortal } from "react-dom"

import type { IconName } from "./ui/Icon"

import { Icon } from "./ui/Icon"

// ── MenuItem type ──────────────────────────────────────────────────────────

export type MenuItem = {
  kind: "action"

  label: string

  shortcut?: string

  icon?: IconName

  danger?: boolean

  onSelect: () => void

  disabled?: boolean
} | { kind: "separator" } | {
  kind: "submenu"

  label: string

  icon?: IconName

  items: MenuItem[]
}

// ── Positioning helpers ────────────────────────────────────────────────────

type MenuBounds = { x: number y: number width: number height: number }

const MENU_BASE_WIDTH = 240

const MENU_LINE_HEIGHT = 28 // px per item

const PADDING = 8

const SAFE_GAP = 4

function estimateMenuHeight(items: MenuItem[]): number {
  let h = PADDING

  for (const item of items) {
    h += item.kind === "separator" ? 9 : MENU_LINE_HEIGHT
  }

  return h + PADDING
}

function flipPosition(target: MenuBounds, win: Window): MenuBounds {
  const innerW = win.innerWidth

  const innerH = win.innerHeight

  const w = target.width

  const h = target.height

  const x =
    target.x + w > innerW - SAFE_GAP
      ? Math.max(SAFE_GAP, innerW - w - SAFE_GAP)
      : target.x

  const y =
    target.y + h > innerH - SAFE_GAP
      ? Math.max(SAFE_GAP, innerH - h - SAFE_GAP)
      : target.y

  return { ...target, x, y }
}

// ── Submenu open-state hook ─────────────────────────────────────────────────

function useSubmenuOpen() {
  const [openId, setOpenId] = useState<number | null>(null)

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function requestOpen(id: number) {
    if (timerRef.current) clearTimeout(timerRef.current)

    timerRef.current = setTimeout(() => setOpenId(id), 180)
  }

  function close() {
    if (timerRef.current) clearTimeout(timerRef.current)

    setOpenId(null)
  }

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  return { openId, requestOpen, close, setOpenId }
}

// ── Item renderers ─────────────────────────────────────────────────────────

function ActionItem({
  item,

  onActivate,
}: {
  item: Extract<MenuItem, { kind: "action" }>

  onActivate: () => void
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        if (item.disabled) return

        e.stopPropagation()

        onActivate()
      }}
      disabled={item.disabled}
      className={`group flex h-7 w-full items-center gap-2 rounded-sm px-3 font-body text-[14px] leading-[20px] transition-colors duration-[80ms] ${
        item.disabled
          ? "pointer-events-none text-outline"
          : item.danger
            ? "text-error hover:bg-surface-container-high hover:text-error-container"
            : "text-on-surface hover:bg-surface-container-high"
      }`}
    >
      {item.icon && (
        <Icon
          name={item.icon}
          size={14}
          className="shrink-0 text-on-surface-variant"
        />
      )}
      <span className="flex-1 truncate text-left">{item.label}</span>
      {item.shortcut && (
        <span className="ml-2 font-mono text-[12px] text-outline">
          {item.shortcut}
        </span>
      )}
    </button>
  )
}

function Separator() {
  return <div className="mx-2 my-1 h-px bg-outline-variant/50" />
}

// ── Root component ──────────────────────────────────────────────────────────

export function ContextMenu({
  x,

  y,

  items,

  onClose,
}: {
  x: number

  y: number

  items: MenuItem[]

  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)

  const [pos, setPos] = useState<{ x: number y: number }>({ x, y })

  // Position with viewport flip

  useLayoutEffect(() => {
    if (!ref.current) return

    const bounds = flipPosition(
      {
        x,

        y,

        width: MENU_BASE_WIDTH,

        height: estimateMenuHeight(items),
      },

      window,
    )

    setPos({ x: bounds.x, y: bounds.y })
  }, [x, y, items])

  // Close on Escape

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault()

        onClose()
      }
    }

    window.addEventListener("keydown", onKey)

    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  // Close on outside pointerdown (capture phase)

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (!ref.current) return

      if (!ref.current.contains(e.target as Node)) {
        onClose()
      }
    }

    function onScroll() {
      onClose()
    }

    document.addEventListener("pointerdown", onPointerDown, true)

    window.addEventListener("scroll", onScroll, true)

    window.addEventListener("resize", onScroll, true)

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)

      window.removeEventListener("scroll", onScroll, true)

      window.removeEventListener("resize", onScroll, true)
    }
  }, [onClose])

  const style: CSSProperties = {
    left: pos.x,

    top: pos.y,

    width: MENU_BASE_WIDTH,

    position: "fixed",

    zIndex: 9999,
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Context menu"
      style={style}
      // DESIGN.md Level 2: glassmorphism overlay

      className="rounded border border-outline/20 bg-surface/80 p-1 font-sans shadow-none backdrop-blur-xl"
    >
      {items.map((item, idx) => (
        <MenuItemRenderer
          key={item.kind === "separator" ? `sep-${idx}` : `${item.kind}-${idx}`}
          item={item}
          itemIndex={idx}
          onClose={onClose}
        />
      ))}
    </div>,

    document.body,
  )
}

// ── Item renderer (recursive for submenu) ───────────────────────────────────

function MenuItemRenderer({
  item,

  itemIndex,

  onClose,
}: {
  item: MenuItem

  itemIndex: number

  onClose: () => void
}) {
  const { openId, requestOpen, close } = useSubmenuOpen()

  const isOpen = item.kind === "submenu" && openId === itemIndex

  if (item.kind === "separator") return <Separator />

  if (item.kind === "action") {
    return (
      <ActionItem
        item={item}
        onActivate={() => {
          item.onSelect()

          onClose()
        }}
      />
    )
  }

  // Submenu

  return (
    <div
      className="relative"
      onMouseEnter={() => requestOpen(itemIndex)}
      onMouseLeave={() => close()}
    >
      <button
        type="button"
        disabled
        className="flex h-7 w-full cursor-default items-center gap-2 rounded-sm px-3 font-body text-[14px] leading-[20px] text-on-surface hover:bg-surface-container-high"
      >
        {item.icon && (
          <Icon
            name={item.icon}
            size={14}
            className="text-on-surface-variant"
          />
        )}
        <span className="flex-1 truncate text-left">{item.label}</span>
        <span className="text-[12px] text-outline">▶</span>
      </button>
      {isOpen && (
        <div className="absolute left-full top-0 -ml-1">
          <SubmenuPortal items={item.items} onClose={onClose} />
        </div>
      )}
    </div>
  )
}

// ── Submenu render (portals itself for stacking) ───────────────────────────

function SubmenuPortal({
  items,
  onClose,
}: {
  items: MenuItem[]
  onClose: () => void
}) {
  return createPortal(
    <div
      style={{ width: MENU_BASE_WIDTH }}
      className="rounded border border-outline/20 bg-surface/80 p-1 font-sans backdrop-blur-xl"
    >
      {items.map((item, idx) => (
        <MenuItemRenderer
          key={item.kind === "separator" ? `sep-${idx}` : `${item.kind}-${idx}`}
          item={item}
          itemIndex={idx}
          onClose={onClose}
        />
      ))}
    </div>,

    document.body,
  )
}
