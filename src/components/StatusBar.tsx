import { useEffect, useState } from "react"
import { Icon } from "./ui/Icon"
import { bonafide } from "../ipc/tauri"
import { useWorkspaceRoot } from "../ide/hooks"

type StatusInfo = {
  version: string
  pythonDetected: boolean
  gitBranch: string | null
  wandbConnected: boolean
}

/**
 * StatusBar — the bottom strip showing the workspace name + version
 * + optional Python / Git / W&B badges.
 *
 * P0-T12: every badge is now wired to its source — the version
 * comes from `bonafide.app.getInfo().version`, the Git branch from
 * `bonafide.git.status(workspace)`, the Python detection from
 * `bonafide.python.detect()`, and the W&B badge from
 * `bonafide.account.getTrackerStatus()`. Each IPC call has its own
 * `.catch` so a single broken subscriber doesn't break the others;
 * any failure hides just that badge.
 */
export function StatusBar({ workspaceName }: { workspaceName: string | null }) {
  const workspaceRoot = useWorkspaceRoot()
  const [info, setInfo] = useState<StatusInfo | null>(null)

  useEffect(() => {
    let cancelled = false

    // 1. Version — synchronous-ish, single call.
    void (async () => {
      try {
        const app = await bonafide.app.getInfo()
        if (cancelled) return
        setInfo((prev) => ({
          version: app.version,
          pythonDetected: prev?.pythonDetected ?? false,
          gitBranch: prev?.gitBranch ?? null,
          wandbConnected: prev?.wandbConnected ?? false,
        }))
      } catch {
        if (cancelled) return
        setInfo((prev) => ({
          version: "—",
          pythonDetected: prev?.pythonDetected ?? false,
          gitBranch: prev?.gitBranch ?? null,
          wandbConnected: prev?.wandbConnected ?? false,
        }))
      }
    })()

    // 2. Git branch — only when a workspace is open.
    if (workspaceRoot) {
      void (async () => {
        try {
          const status = await bonafide.git.status(workspaceRoot)
          if (cancelled) return
          setInfo((prev) => ({
            version: prev?.version ?? "—",
            pythonDetected: prev?.pythonDetected ?? false,
            gitBranch: status?.branch ? status.branch : null,
            wandbConnected: prev?.wandbConnected ?? false,
          }))
        } catch {
          if (cancelled) return
          setInfo((prev) => ({
            ...(prev ?? {
              version: "—",
              pythonDetected: false,
              gitBranch: null,
              wandbConnected: false,
            }),
            gitBranch: null,
          }))
        }
      })()
    } else {
      setInfo((prev) => ({
        ...(prev ?? {
          version: "—",
          pythonDetected: false,
          gitBranch: null,
          wandbConnected: false,
        }),
        gitBranch: null,
      }))
    }

    // 3. Python detection — independent of workspace root.
    void (async () => {
      try {
        const detected = await bonafide.python.detect()
        if (cancelled) return
        setInfo((prev) => ({
          ...(prev ?? {
            version: "—",
            pythonDetected: false,
            gitBranch: null,
            wandbConnected: false,
          }),
          pythonDetected: !!detected,
        }))
      } catch {
        if (cancelled) return
        setInfo((prev) => ({
          ...(prev ?? {
            version: "—",
            pythonDetected: false,
            gitBranch: null,
            wandbConnected: false,
          }),
          pythonDetected: false,
        }))
      }
    })()

    // 4. W&B connection — pulled from the account/tracker status. We
    // highlight the badge when any tracker is connected, since the
    // P0.0 panel currently shows W&B / MLflow rows together.
    void (async () => {
      try {
        const rows = await bonafide.account.getTrackerStatus()
        if (cancelled) return
        const connected = rows.some((r) => r?.connected)
        setInfo((prev) => ({
          ...(prev ?? {
            version: "—",
            pythonDetected: false,
            gitBranch: null,
            wandbConnected: false,
          }),
          wandbConnected: connected,
        }))
      } catch {
        if (cancelled) return
        setInfo((prev) => ({
          ...(prev ?? {
            version: "—",
            pythonDetected: false,
            gitBranch: null,
            wandbConnected: false,
          }),
          wandbConnected: false,
        }))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [workspaceRoot])

  return (
    <div className="flex h-6 shrink-0 items-center border-t border-outline-variant bg-surface-container-low px-3 font-sans text-[12px] text-on-surface-variant">
      {/* left: workspace */}
      <div className="flex items-center gap-2">
        {workspaceName ? (
          <>
            <Icon name="folder-open" size={12} className="text-secondary" />
            <span>{workspaceName}</span>
          </>
        ) : (
          <span className="text-outline">No folder open</span>
        )}
      </div>

      <div className="mx-3 h-3 w-px bg-outline-variant" />

      {/* center: status */}
      <div className="flex items-center gap-3">
        <span className="text-outline">Ready</span>
      </div>

      <div className="flex-1" />

      {/* right: badges — each shows only when its IPC reports truthy. */}
      <div className="flex items-center gap-3">
        {info?.gitBranch ? (
          <span className="flex items-center gap-1 text-outline">
            <Icon name="git-branch" size={11} /> {info.gitBranch}
          </span>
        ) : null}
        {info?.pythonDetected ? (
          <span className="flex items-center gap-1 text-outline">
            <Icon name="terminal" size={11} /> Python
          </span>
        ) : null}
        {info?.wandbConnected ? (
          <span className="flex items-center gap-1 text-outline">
            <Icon name="zap" size={11} /> W&amp;B
          </span>
        ) : null}
        {info ? (
          <span className="text-outline">Bonafide v{info.version}</span>
        ) : null}
      </div>
    </div>
  )
}
