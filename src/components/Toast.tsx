/**
 * Toast.tsx — Toast notification (top-right, glassmorphic)
 *
 * Tones:
 *   - info:    no accent border, on-surface-variant text
 *   - success: 2px primary left-border accent
 *   - error:   2px error left-border accent
 *
 * Auto-dismisses after ttlMs. Clicking dismisses early.
 */

import { useEffect, type CSSProperties } from "react"

import type { Toast as ToastT } from "../ide/store.tsx"

import { useIdeStore } from "../ide/hooks"

export function Toast({ toast }: { toast: ToastT }) {
  const store = useIdeStore()

  // Auto-dismiss

  useEffect(() => {
    const id = setTimeout(() => {
      store.dispatch({ type: "DISMISS_TOAST", id: toast.id })
    }, toast.ttlMs)

    return () => clearTimeout(id)
  }, [toast.id, toast.ttlMs, store])

  const accent =
    toast.tone === "success"
      ? "border-l-2 border-l-primary"
      : toast.tone === "error"
        ? "border-l-2 border-l-error"
        : ""

  const textColor =
    toast.tone === "error"
      ? "text-error"
      : toast.tone === "success"
        ? "text-on-surface"
        : "text-on-surface-variant"

  const style: CSSProperties = {
    minWidth: 200,

    maxWidth: 320,
  }

  return (
    <div
      role="status"
      onClick={() => store.dispatch({ type: "DISMISS_TOAST", id: toast.id })}
      style={style}
      className={`pointer-events-auto cursor-pointer rounded border border-outline-variant bg-surface-container px-3 py-2 font-body text-[14px] leading-[20px] transition-all duration-[160ms] ease-out hover:bg-surface-container-high ${accent} ${textColor}`}
    >
      {toast.message}
    </div>
  )
}
