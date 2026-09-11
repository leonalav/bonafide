import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"

/**
 * ResizeHandle — a draggable 4px bar between two resizable panels.
 *
 * Pass the current width + a setter, plus min/max bounds. The handle emits
 * width values that already account for the bounds and the axis. Pass
 * `getWidth` if width is sourced from a ref / external store that doesn't
 * trigger re-renders (we read it on each pointer move).
 *
 * Orientation is always "vertical" (the handle itself is a thin vertical
 * strip); the `onResize` callback fires with a width in pixels along the
 * horizontal axis.
 */
export function ResizeHandle({
  width,
  onResize,
  getWidth,
  minWidth,
  maxWidth,
  side = "right",
  ariaLabel,
  /** Optional escape hatch — read the latest width inside pointer events. */
  /** Which side of the panel the handle sits on. Affects the cursor styling. */
}: {
  width: number
  onResize: (w: number) => void
  getWidth?: () => number
  minWidth: number
  maxWidth: number
  side?: "left" | "right"
  ariaLabel: string
}) {
  const [dragging, setDragging] = useState(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
      setDragging(true)
      startXRef.current = e.clientX
      startWidthRef.current = getWidth ? getWidth() : width
    },
    [getWidth, width],
  )

  useEffect(() => {
    if (!dragging) return

    function onMove(e: PointerEvent) {
      const dx = e.clientX - startXRef.current
      // If the handle is on the LEFT side of a panel (e.g. resize handle on
      // the right panel's left edge), moving the mouse right *shrinks* the
      // panel. Otherwise it grows it.
      const sign = side === "left" ? -1 : 1
      const next = startWidthRef.current + sign * dx
      const clamped = Math.max(minWidth, Math.min(maxWidth, next))
      onResize(Math.round(clamped))
    }
    function onUp() {
      setDragging(false)
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
    }
  }, [dragging, minWidth, maxWidth, onResize, side])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      className={`relative z-10 w-1 shrink-0 cursor-col-resize select-none transition-colors duration-[120ms] ${
        dragging ? "bg-primary" : "bg-transparent hover:bg-outline-variant/60"
      }`}
    >
      {/* Wider invisible hit target — makes the handle easier to grab */}
      <div className="pointer-events-none absolute inset-y-0 -left-1 -right-1" />
    </div>
  )
}
