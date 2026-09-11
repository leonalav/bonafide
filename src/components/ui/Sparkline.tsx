type Tone = "positive" | "negative" | "neutral"

const STROKE: Record<Tone, string> = {
  positive: "var(--color-primary)",
  negative: "var(--color-error)",
  neutral: "var(--color-outline)",
}

export function Sparkline({
  data,
  width = 60,
  height = 18,
  tone = "neutral",
  fill = false,
  responsive = false,
  ariaLabel,
  /** Stretch to the container width (never overflows) instead of a fixed px width. */
}: {
  data: number[]
  width?: number
  height?: number
  tone?: Tone
  fill?: boolean
  responsive?: boolean
  ariaLabel?: string
}) {
  if (data.length < 2) return null
  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const pad = 1.5
  const stepX = (width - pad * 2) / (data.length - 1)
  const pts = data.map((v, i) => {
    const x = pad + i * stepX
    const y = pad + (height - pad * 2) * (1 - (v - min) / span)
    return [x, y] as const
  })
  const line = pts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(" ")
  const area = `${line} L${pts[pts.length - 1][0].toFixed(2)},${height} L${pts[0][0].toFixed(2)},${height} Z`
  const stroke = STROKE[tone]
  const last = pts[pts.length - 1]

  return (
    <svg
      width={responsive ? "100%" : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={responsive ? "none" : "xMidYMid meet"}
      role="img"
      aria-label={
        ariaLabel ?? `trend, final value ${data[data.length - 1].toFixed(2)}`
      }
      className={responsive ? "block max-w-full" : ""}
    >
      <title>{`${
        ariaLabel ? ariaLabel + " — " : ""
      }min ${min.toFixed(2)} · max ${max.toFixed(2)} · last ${data[data.length - 1].toFixed(2)}`}</title>
      {fill && <path d={area} fill={stroke} opacity={0.12} />}
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r={1.6} fill={stroke} />
    </svg>
  )
}

// Unicode block sparkline for tight inline gutter/table contexts.
const BLOCKS = "▁▂▃▄▅▆▇█"
export function blockSpark(data: number[], n = 10): string {
  const s = data.slice(-n)
  const min = Math.min(...s)
  const max = Math.max(...s)
  const span = max - min || 1
  return s
    .map((v) => BLOCKS[Math.min(7, Math.floor(((v - min) / span) * 7.999))])
    .join("")
}
