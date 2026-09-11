import { useCallback, useRef, useEffect } from "react"
import { Icon } from "../ui/Icon"
import { useDiagnostics } from "../../ide/hooks"
import { useDispatch } from "../../ide/hooks"
import type { DiagnosticEntry } from "../../ide/store"

const SEVERITY_ICON: Record<DiagnosticEntry["severity"], {
  icon: string
  color: string
}> = {
  error: { icon: "alert-triangle", color: "text-red-400" },
  warning: { icon: "alert-triangle", color: "text-yellow-400" },
  info: { icon: "alert-triangle", color: "text-blue-400" },
}

function DiagnosticRow({ diag }: { diag: DiagnosticEntry }) {
  const dispatch = useDispatch()
  const { icon, color } = SEVERITY_ICON[diag.severity]

  const handleClick = useCallback(() => {
    // Open the file and jump to the line.
    dispatch({ type: "OPEN_FILE", fileId: diag.fileId ?? "" })
    // TODO: also scroll to line — requires EditorView ref from CodeMirrorEditor.
    // For now, opening the file is sufficient.
  }, [dispatch, diag.fileId])

  return (
    <div
      onClick={handleClick}
      className={`group flex cursor-pointer items-start gap-2 border-b border-outline-variant/40 px-3 py-1.5 font-mono text-[12px] transition-colors hover:bg-surface-container-high ${
        diag.severity === "error"
          ? "bg-red-950/20"
          : diag.severity === "warning"
            ? "bg-yellow-950/10"
            : ""
      }`}
    >
      <Icon name={icon} size={13} className={`mt-0.5 shrink-0 ${color}`} />
      <div className="min-w-0 flex-1">
        <span className="truncate text-on-surface-variant">{diag.message}</span>
      </div>
      {diag.code && <span className="shrink-0 text-outline">{diag.code}</span>}
      {diag.fileLabel && (
        <span className="shrink-0 truncate text-[11px] text-outline">
          {diag.fileLabel}:{diag.line}
        </span>
      )}
      <span className="shrink-0 text-[11px] text-outline-variant">
        {diag.source}
      </span>
    </div>
  )
}

export function ProblemsTab() {
  const diagnostics = useDiagnostics()

  if (diagnostics.length === 0) {
    return (
      <div className="flex h-full items-center justify-center font-sans text-[13px] text-outline">
        <div className="text-center">
          <Icon
            name="check"
            size={24}
            className="mx-auto mb-2 text-green-500"
          />
          <p>No Problems</p>
          <p className="mt-1 text-[12px]">
            No errors, warnings, or hints detected.
          </p>
        </div>
      </div>
    )
  }

  // Group by source label for cleaner display
  const errorCount = diagnostics.filter((d) => d.severity === "error").length
  const warningCount = diagnostics.filter(
    (d) => d.severity === "warning",
  ).length
  const infoCount = diagnostics.filter((d) => d.severity === "info").length

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Summary bar */}
      <div className="flex shrink-0 items-center gap-4 border-b border-outline-variant/40 bg-surface-container-low px-3 py-1.5 font-sans text-[12px]">
        {errorCount > 0 && (
          <span className="flex items-center gap-1 text-red-400">
            <Icon name="alert-triangle" size={12} />
            {errorCount} error{errorCount !== 1 ? "s" : ""}
          </span>
        )}
        {warningCount > 0 && (
          <span className="flex items-center gap-1 text-yellow-400">
            <Icon name="alert-triangle" size={12} />
            {warningCount} warning{warningCount !== 1 ? "s" : ""}
          </span>
        )}
        {infoCount > 0 && (
          <span className="flex items-center gap-1 text-blue-400">
            <Icon name="alert-triangle" size={12} />
            {infoCount} hint{infoCount !== 1 ? "s" : ""}
          </span>
        )}
        <div className="flex-1" />
        <span className="text-outline">{diagnostics.length} total</span>
      </div>

      {/* Diagnostic list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {diagnostics.map((diag) => (
          <DiagnosticRow key={diag.id} diag={diag} />
        ))}
      </div>
    </div>
  )
}
