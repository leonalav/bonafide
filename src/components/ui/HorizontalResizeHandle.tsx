import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"

/**
 * HorizontalResizeHandle — a draggable 4px bar between the editor area and
 * the bottom panel (VS Code-style).
 *
 * `height` / `onResize` / `getHeight` / `minHeight` / `maxHeight` follow
 * the same contract as the vertical ResizeHandle but along the vertical axis.
 */
export function HorizontalResizeHandle({
  height,
  onResize,
  getHeight,
  minHeight,
  maxHeight,
  ariaLabel,
}: {
  height: number
  onResize: (h: number) => void
  getHeight?: () => number
  minHeight: number
  maxHeight: number
  ariaLabel: string
}) {
  const [dragging, setDragging] = useState(false)
  const startYRef = useRef(0)
  const startHeightRef = useRef(0)

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
      setDragging(true)
      startYRef.current = e.clientY
      startHeightRef.current = getHeight ? getHeight() : height
    },
    [getHeight, height],
  )

  useEffect(() => {
    if (!dragging) return

    function onMove(e: PointerEvent) {
      const dy = e.clientY - startYRef.current
      // Dragging down grows the panel height.
      const next = startHeightRef.current + dy
      const clamped = Math.max(minHeight, Math.min(maxHeight, next))
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
  }, [dragging, minHeight, maxHeight, onResize])

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      className={`relative h-1 shrink-0 cursor-row-resize select-none transition-colors duration-[120ms] ${
        dragging ? "bg-primary" : "bg-transparent hover:bg-outline-variant/60"
      }`}
    >
      {/* Taller invisible hit target */}
      <div className="pointer-events-none absolute inset-x-0 -top-1 -bottom-1" />
    </div>
  )
}
