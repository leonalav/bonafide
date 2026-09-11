import { useEffect, useRef, useState } from "react"
import { Icon } from "./Icon"

export type SelectOption = { value: string label: string }

export function Select({
  value,
  options,
  onChange,
  prefix,
  leadingIcon,
  size = "sm",
  align = "left",
  className = "",
  menuClassName = "",
  ariaLabel,
}: {
  value: string
  options: (SelectOption | string)[]
  onChange: (value: string) => void
  prefix?: string
  leadingIcon?: string
  size?: "sm" | "md"
  align?: "left" | "right"
  className?: string
  menuClassName?: string
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const opts = options.map((o) =>
    typeof o === "string" ? { value: o, label: o } : o,
  )
  const current = opts.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const h = size === "md" ? "h-8" : "h-6"
  const text = size === "md" ? "text-[13px]" : "text-[12px]"

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className={`flex ${h} w-full items-center gap-1.5 rounded border border-outline-variant bg-surface px-2 font-sans ${text} text-on-surface-variant transition-colors hover:border-outline hover:text-on-surface ${
          open ? "border-primary text-on-surface" : ""
        }`}
      >
        {leadingIcon && (
          <Icon
            name={leadingIcon}
            size={13}
            className="shrink-0 text-outline"
          />
        )}
        <span className="min-w-0 flex-1 truncate text-left">
          {prefix && <span className="text-outline">{prefix} </span>}
          {current?.label ?? value}
        </span>
        <Icon
          name="chevron-down"
          size={12}
          className={`shrink-0 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className={`absolute z-50 mt-1 max-h-56 min-w-full animate-card-in overflow-auto rounded-md border border-outline-variant bg-surface-container/95 p-1 shadow-2xl backdrop-blur-[16px] ${
            align === "right" ? "right-0" : "left-0"
          } ${menuClassName}`}
        >
          {opts.map((o) => {
            const active = o.value === value
            return (
              <button
                key={o.value}
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
                className={`flex w-full items-center gap-2 whitespace-nowrap rounded px-2 py-1.5 text-left font-sans ${text} transition-colors ${
                  active
                    ? "bg-surface-container-high text-on-surface"
                    : "text-on-surface-variant hover:bg-surface-container"
                }`}
              >
                <span className="flex-1">{o.label}</span>
                {active && (
                  <Icon name="check" size={13} className="text-primary" />
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
