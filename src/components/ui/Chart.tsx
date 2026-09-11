import { useEffect, useRef, useState } from "react"

type Tone = "positive" | "negative" | "neutral"

const STROKE: Record<Tone, string> = {
  positive: "var(--color-primary)",
  negative: "var(--color-error)",
  neutral: "var(--color-outline)",
}

export function fmtValue(v: number): string {
  const a = Math.abs(v)
  if (a !== 0 && a < 0.01) return v.toExponential(1)
  if (a < 1) return v.toFixed(3)
  if (a < 100) return v.toFixed(2)
  return Math.round(v).toLocaleString()
}

export function fmtStep(s: number): string {
  if (s >= 1000) return `${(s / 1000).toFixed(s % 1000 === 0 ? 0 : 1)}k`
  return String(Math.round(s))
}

/**
 * Single-series line chart with X/Y tick labels and a crosshair tooltip.
 * Width is measured from the container (no distortion) and the SVG is drawn at
 * exact pixel width, so nothing overflows its viewport. The tooltip is clamped
 * inside the plot.
 */
export function Chart({
  data,
  totalSteps,
  tone = "positive",
  height = 180,
  fill = true,
  yTicks = 4,
  xTicks = 5,
  ariaLabel,
}: {
  data: number[]
  totalSteps: number
  tone?: Tone
  height?: number
  fill?: boolean
  yTicks?: number
  xTicks?: number
  ariaLabel?: string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) =>
      setW(Math.floor(entries[0].contentRect.width)),
    )
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const stroke = STROKE[tone]
  const n = data.length
  const mL = 46
  const mR = 12
  const mT = 10
  const mB = 22
  const plotW = Math.max(0, w - mL - mR)
  const plotH = Math.max(0, height - mT - mB)

  const rawMin = Math.min(...data)
  const rawMax = Math.max(...data)
  const span0 = rawMax - rawMin || 1
  const domMin = rawMin - span0 * 0.08
  const domMax = rawMax + span0 * 0.08
  const span = domMax - domMin || 1

  const xAt = (i: number) => mL + (n <= 1 ? 0 : (i / (n - 1)) * plotW)
  const yAt = (v: number) => mT + plotH * (1 - (v - domMin) / span)
  const stepAt = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * totalSteps)

  const pts = data.map((v, i) => [xAt(i), yAt(v)] as const)
  const line = pts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(" ")
  const area = `${line} L${pts[n - 1]?.[0].toFixed(2)},${(mT + plotH).toFixed(2)} L${pts[0]?.[0].toFixed(2)},${(mT + plotH).toFixed(2)} Z`

  const yTickVals = Array.from(
    { length: yTicks + 1 },
    (_, k) => domMin + (span * k) / yTicks,
  )
  const xTickIdx = Array.from({ length: xTicks }, (_, k) =>
    Math.round((k / (xTicks - 1)) * (n - 1)),
  )

  function onMove(e: React.MouseEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const idx = Math.max(0, Math.min(n - 1, Math.round((x / plotW) * (n - 1))))
    setHover(idx)
  }

  const ready = w > 0 && n >= 2
  // Tooltip position, clamped inside the container.
  const tipW = 116
  const hx = hover != null ? xAt(hover) : 0
  const tipLeft = Math.max(2, Math.min(w - tipW - 2, hx - tipW / 2))

  return (
    <div
      ref={wrapRef}
      className="relative w-full overflow-hidden"
      style={{ height }}
    >
      {ready && (
        <svg
          width={w}
          height={height}
          role="img"
          aria-label={ariaLabel ?? "metric chart"}
          className="block"
        >
          {/* Y grid + ticks */}
          {yTickVals.map((v, i) => {
            const y = yAt(v)
            return (
              <g key={`y${i}`}>
                <line
                  x1={mL}
                  y1={y}
                  x2={w - mR}
                  y2={y}
                  stroke="var(--color-outline-variant)"
                  strokeWidth={1}
                  opacity={0.35}
                />
                <text
                  x={mL - 6}
                  y={y + 3}
                  textAnchor="end"
                  className="fill-[var(--color-outline)]"
                  style={{ fontSize: 10 }}
                >
                  {fmtValue(v)}
                </text>
              </g>
            )
          })}

          {/* X ticks */}
          {xTickIdx.map((idx, i) => {
            const x = xAt(idx)
            return (
              <text
                key={`x${i}`}
                x={x}
                y={height - 6}
                textAnchor={
                  i === 0
                    ? "start"
                    : i === xTickIdx.length - 1
                      ? "end"
                      : "middle"
                }
                className="fill-[var(--color-outline)]"
                style={{ fontSize: 10 }}
              >
                {fmtStep(stepAt(idx))}
              </text>
            )
          })}

          {/* Axis baseline */}
          <line
            x1={mL}
            y1={mT + plotH}
            x2={w - mR}
            y2={mT + plotH}
            stroke="var(--color-outline-variant)"
            strokeWidth={1}
          />

          {fill && <path d={area} fill={stroke} opacity={0.1} />}
          <path
            d={line}
            fill="none"
            stroke={stroke}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Hover crosshair */}
          {hover != null && (
            <g>
              <line
                x1={xAt(hover)}
                y1={mT}
                x2={xAt(hover)}
                y2={mT + plotH}
                stroke={stroke}
                strokeWidth={1}
                opacity={0.5}
                strokeDasharray="3 3"
              />
              <circle
                cx={xAt(hover)}
                cy={yAt(data[hover])}
                r={3.5}
                fill="var(--color-surface)"
                stroke={stroke}
                strokeWidth={2}
              />
            </g>
          )}

          {/* Hover capture */}
          <rect
            x={mL}
            y={mT}
            width={plotW}
            height={plotH}
            fill="transparent"
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          />
        </svg>
      )}

      {ready && hover != null && (
        <div
          className="pointer-events-none absolute top-1 rounded border border-outline-variant bg-surface-container-high px-2 py-1 shadow-lg"
          style={{ left: tipLeft, width: tipW }}
        >
          <div className="font-sans text-[11px] text-outline">
            step {fmtStep(stepAt(hover))}
          </div>
          <div className="font-sans text-[13px] font-medium tabular-nums text-on-surface">
            {fmtValue(data[hover])}
          </div>
        </div>
      )}
    </div>
  )
}
