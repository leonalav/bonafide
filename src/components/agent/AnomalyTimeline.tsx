import { useEffect, useState } from "react"
import { bonafide, type AnomalyEntry } from "../../ipc/tauri"
import { Icon } from "../ui/Icon"

/**
 * AnomalyTimeline — Overlay anomaly markers on a metric chart for a selected experiment run.
 * 
 * Calls detectAnomalies(experimentId, runId) to fetch anomalies, then renders markers at
 * the step position where each anomaly occurred. Hover shows anomaly details (type, threshold, actual value).
 * 
 * Props:
 * - workspaceRoot: string
 * - runId: string
 * - chartWidth: number (total width of the chart in pixels)
 * - chartHeight: number (total height of the chart in pixels)
 * - maxStep: number (maximum step value in the chart for positioning)
 * - onMarkerClick?: (anomaly: AnomalyEntry) => void
 */

const ANOMALY_COLORS: Record<AnomalyEntry["kind"], string> = {
  spike: "text-error",
  drop: "text-error",
  plateau: "text-tertiary",
  drift: "text-outline",
}

const ANOMALY_ICONS: Record<AnomalyEntry["kind"], string> = {
  spike: "trending-up",
  drop: "trending-down",
  plateau: "minus",
  drift: "activity",
}

const SEVERITY_COLORS: Record<AnomalyEntry["severity"], string> = {
  low: "bg-outline/20 border-outline",
  medium: "bg-tertiary/20 border-tertiary",
  high: "bg-error/20 border-error",
}

export function AnomalyTimeline({
  workspaceRoot,
  runId,
  chartWidth,
  chartHeight,
  maxStep,
  onMarkerClick,
}: {
  workspaceRoot: string
  runId: string
  chartWidth: number
  chartHeight: number
  maxStep: number
  onMarkerClick?: (anomaly: AnomalyEntry) => void
}) {
  const [anomalies, setAnomalies] = useState<AnomalyEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  useEffect(() => {
    let mounted = true
    setLoading(true)

    bonafide.agent
      .detectAnomalies(workspaceRoot, runId)
      .then((report) => {
        if (mounted) {
          setAnomalies(report.anomalies)
          setLoading(false)
        }
      })
      .catch((err) => {
        console.error("[AnomalyTimeline] detectAnomalies failed:", err)
        if (mounted) {
          setAnomalies([])
          setLoading(false)
        }
      })

    return () => {
      mounted = false
    }
  }, [workspaceRoot, runId])

  if (loading) {
    return (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <Icon
          name="refresh"
          size={16}
          className="animate-sync-spin text-outline"
        />
      </div>
    )
  }

  if (anomalies.length === 0) {
    return null
  }

  return (
    <svg
      className="pointer-events-none absolute inset-0"
      width={chartWidth}
      height={chartHeight}
      style={{ overflow: "visible" }}
    >
      {anomalies.map((anomaly, i) => {
        // Position the marker based on step (x-axis)
        const xPos = (anomaly.step / maxStep) * chartWidth
        const yPos = chartHeight / 2 // Center vertically; adjust if you have actual Y data

        const iconColor = ANOMALY_COLORS[anomaly.kind]
        const severityBorder = SEVERITY_COLORS[anomaly.severity]
        const isHovered = hoveredIndex === i

        return (
          <g key={i}>
            {/* Vertical line marker */}
            <line
              x1={xPos}
              y1={0}
              x2={xPos}
              y2={chartHeight}
              stroke="currentColor"
              strokeWidth={1}
              strokeDasharray="3,3"
              className={`opacity-40 ${iconColor}`}
            />

            {/* Circle marker at step position */}
            <circle
              cx={xPos}
              cy={yPos}
              r={isHovered ? 8 : 6}
              className={`pointer-events-auto cursor-pointer fill-current transition-all ${iconColor} ${severityBorder}`}
              strokeWidth={2}
              onMouseEnter={() => setHoveredIndex(i)}
              onMouseLeave={() => setHoveredIndex(null)}
              onClick={() => onMarkerClick?.(anomaly)}
            />

            {/* Tooltip on hover */}
            {isHovered && (
              <foreignObject
                x={xPos + 12}
                y={yPos - 40}
                width={220}
                height={80}
                className="pointer-events-none"
              >
                <div className="rounded border border-outline-variant bg-surface-container-high p-2 shadow-lg">
                  <div className="mb-1 flex items-center gap-1.5">
                    <Icon
                      name={ANOMALY_ICONS[anomaly.kind]}
                      size={12}
                      className={iconColor}
                    />
                    <span className={`label-caps ${iconColor}`}>
                      {anomaly.kind.toUpperCase()}
                    </span>
                    <span className="ml-auto font-sans text-[10px] text-outline">
                      {anomaly.severity}
                    </span>
                  </div>
                  <p className="mb-1 font-body text-[11px] leading-[15px] text-on-surface">
                    {anomaly.description}
                  </p>
                  <div className="flex items-center justify-between font-sans text-[10px] text-on-surface-variant">
                    <span>Step {anomaly.step}</span>
                    <span>Value: {anomaly.value.toFixed(4)}</span>
                  </div>
                  <div className="mt-1 font-sans text-[10px] text-outline">
                    Metric: {anomaly.metric}
                  </div>
                </div>
              </foreignObject>
            )}
          </g>
        )
      })}
    </svg>
  )
}
