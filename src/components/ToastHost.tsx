/**
 * ToastHost.tsx — Mounted once in App.tsx, renders the toast stack.
 *
 * Position: top-right, fixed.
 * Stack: vertical column with 8px gap.
 * Pointer-events: container is none, toasts are auto.
 */

import { createPortal } from "react-dom"

import { useToasts } from "../ide/hooks"

import { Toast } from "./Toast"

export function ToastHost() {
  const toasts = useToasts()

  return createPortal(
    <div
      aria-label="Notifications"
      className="pointer-events-none fixed right-3 top-3 z-[10000] flex flex-col gap-2"
    >
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} />
      ))}
    </div>,

    document.body,
  )
}
