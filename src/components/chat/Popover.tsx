/**
 * chat/Popover.tsx — Shared, viewport-aware anchored popover.
 *
 * A near-clone of the private `Popover` inside `Composer.tsx` so the
 * chat thread dropdown can use the same positioning logic without
 * us refactoring Composer. Composer keeps its local copy for now —
 * when a third caller needs a popover, we lift this into `ui/` and
 * have Composer and ThreadList both import it.
 *
 * Behaviour:
 *   - Renders into a portal so it escapes overflow ancestors.
 *   - Computes position from a `DOMRect` anchor rect.
 *   - Flips above the anchor when there's not enough room below.
 *   - Click-outside (on the backdrop) closes the popover.
 *
 * Note: the backdrop uses `onClick` (not `onMouseDown`) so the
 * popover's internal button onClicks fire before the backdrop close
 * handler. This matches the existing Composer behaviour exactly.
 */

import { useEffect } from "react"
import { createPortal } from "react-dom"

const MARGIN = 6 // px between anchor and popover edge
const MENU_HEIGHT_ESTIMATE = 360 // px — used to decide direction before render

function computePosition(
  anchor: DOMRect,
  popoverHeight: number,
  popoverWidth: number,
): { top: number left: number flip: boolean clampLeft: number } {
  const spaceBelow = window.innerHeight - anchor.bottom
  const flip = spaceBelow < MARGIN + popoverHeight
  // Clamp horizontally so wide popovers near the right edge don't
  // overflow the viewport.
  const idealLeft = anchor.left
  const maxLeft = window.innerWidth - popoverWidth - 4
  const clampLeft = Math.max(4, Math.min(idealLeft, maxLeft))
  return {
    top: flip ? anchor.top - MARGIN : anchor.bottom + MARGIN,
    left: anchor.left,
    clampLeft,
    flip,
  }
}

function Backdrop({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] cursor-default" onClick={onClose} />
  )
}

export function Popover({
  anchor,
  width = 320,
  height = MENU_HEIGHT_ESTIMATE,
  onClose,
  children,
}: {
  anchor: DOMRect | null
  width?: number
  height?: number
  onClose: () => void
  children: React.ReactNode
}) {
  // Escape closes the popover. We attach on the document level so
  // it fires regardless of focus — useful when the user clicks into
  // the popover, then decides to back out.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  if (!anchor) return null
  const { top, clampLeft, flip } = computePosition(anchor, height, width)
  return createPortal(
    <>
      <Backdrop onClose={onClose} />
      <div
        style={{
          position: "fixed",
          top,
          left: clampLeft,
          width,
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
