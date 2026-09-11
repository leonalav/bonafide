import type { ButtonHTMLAttributes, ReactNode } from "react"

// ── Button ──────────────────────────────────────────────────────────────
type Variant = "primary" | "secondary" | "ghost" | "danger"
type Size = "sm" | "md" | "lg"

const SIZE: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12px]",
  md: "h-9 px-3.5 text-[13px]",
  lg: "h-10 px-5 text-[14px]",
}

const VARIANT: Record<Variant, string> = {
  primary: "bg-primary text-on-primary hover:brightness-105 font-medium",
  secondary:
    "bg-transparent border border-outline-variant text-secondary hover:bg-surface-container hover:border-outline",
  ghost:
    "bg-transparent text-outline hover:text-primary hover:bg-surface-container/60",
  danger: "bg-transparent border border-error/40 text-error hover:bg-error/10",
}

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...props
}: {
  variant?: Variant
  size?: Size
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded font-sans transition-[background-color,color,border-color,filter] duration-[120ms] ease-out disabled:opacity-40 disabled:pointer-events-none ${SIZE[size]} ${VARIANT[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

// ── Status dot ──────────────────────────────────────────────────────────
type DotToken = "tertiary" | "primary" | "error" | "outline"
const DOT_BG: Record<DotToken, string> = {
  tertiary: "bg-tertiary",
  primary: "bg-primary",
  error: "bg-error",
  outline: "bg-outline",
}

export function StatusDot({
  token,
  pulse,
  size = 8,
}: {
  token: DotToken
  pulse?: boolean
  size?: number
}) {
  return (
    <span
      className={`inline-block shrink-0 rounded-full ${DOT_BG[token]} ${
        pulse ? "animate-dot-pulse" : ""
      }`}
      style={{ width: size, height: size }}
    />
  )
}

// ── Chip ────────────────────────────────────────────────────────────────
type ChipTone = "positive" | "negative" | "neutral"
const CHIP: Record<ChipTone, string> = {
  positive: "text-primary bg-primary/10",
  negative: "text-error bg-error/10",
  neutral: "text-outline bg-outline/10",
}

export function Chip({
  tone = "neutral",
  children,
}: {
  tone?: ChipTone
  children: ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-sans text-[12px] font-medium tabular-nums ${CHIP[tone]}`}
    >
      {children}
    </span>
  )
}

// ── Section label ───────────────────────────────────────────────────────
export function SectionLabel({
  children,
  className = "",
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`label-caps text-on-surface-variant ${className}`}>
      {children}
    </div>
  )
}
