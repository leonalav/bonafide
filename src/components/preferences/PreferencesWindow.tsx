import { useEffect, useRef, useState } from "react"
import { Icon } from "../ui/Icon"
import { AccountSection } from "./AccountSection"
import { ModelsSection } from "./ModelsSection"
import { SettingsSection } from "./SettingsSection"
import type { TrackerKind } from "@/ipc/tauri"

export type PrefSection = "settings" | "account" | "shortcuts" | "themes" | "extensions" | "models"

const NAV: { id: PrefSection icon: string label: string }[] = [
  { id: "settings", icon: "settings", label: "Settings" },
  { id: "account", icon: "user-circle", label: "Account" },
  { id: "models", icon: "brain", label: "Models" },
  { id: "shortcuts", icon: "keyboard", label: "Keyboard shortcuts" },
  { id: "themes", icon: "palette", label: "Themes" },
  { id: "extensions", icon: "puzzle", label: "Extensions" },
]

export function PreferencesWindow({
  initialSection,
  onClose,
  workspaceRoot,
  trackerKind,
  onTrackerConnected,
  onTrackerDisconnected,
}: {
  initialSection: PrefSection
  onClose: () => void
  workspaceRoot: string | null
  trackerKind: TrackerKind | null
  onTrackerConnected?: (kind: "wandb" | "mlflow") => void
  onTrackerDisconnected?: (kind: "wandb" | "mlflow") => void
}) {
  const [section, setSection] = useState<PrefSection>(initialSection)
  const [pinned, setPinned] = useState(false)
  const [highlightTrackers, setHighlightTrackers] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const trackersRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w") {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  // Deep-link: Account → Manage tracker jumps to Settings › Trackers with a pulse.
  function manageTracker() {
    setSection("settings")
    setHighlightTrackers(true)
    requestAnimationFrame(() => {
      trackersRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      })
    })
    setTimeout(() => setHighlightTrackers(false), 1400)
  }

  function selectSection(id: PrefSection) {
    setSection(id)
    scrollRef.current?.scrollTo({ top: 0 })
  }

  return (
    <div
      className="absolute inset-0 z-[60] flex items-center justify-center bg-black/40 p-6 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-[min(540px,85vh)] w-[min(864px,92vw)] animate-card-in flex-col overflow-hidden rounded-lg border border-outline/20 bg-surface shadow-2xl"
      >
        {/* Chrome */}
        <div className="flex h-8 shrink-0 items-center border-b border-outline-variant bg-surface-container-lowest px-3">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-full bg-error/90" />
            <span className="h-3 w-3 rounded-full bg-tertiary/90" />
            <span className="h-3 w-3 rounded-full bg-primary/90" />
          </div>
          <div className="flex flex-1 items-center justify-center gap-2">
            <Icon name="diamond" size={12} className="text-primary" />
            <span className="font-sans text-[13px] font-semibold text-on-surface">
              Bonafide — Preferences
            </span>
          </div>
          <div className="flex items-center gap-3 text-outline">
            <button
              onClick={() => setPinned((v) => !v)}
              title="Always on top"
              aria-pressed={pinned}
              className={pinned ? "text-primary" : "hover:text-on-surface"}
            >
              <Icon name="pin" size={13} />
            </button>
            <Icon name="minimize" size={14} className="hover:text-on-surface" />
            <Icon name="square" size={11} className="hover:text-on-surface" />
            <button
              onClick={onClose}
              aria-label="Close preferences"
              className="hover:text-on-surface"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Left rail */}
          <nav className="flex w-60 shrink-0 flex-col border-r border-outline-variant bg-surface-container-low pt-4">
            <div className="label-caps px-4 pb-2 text-on-surface-variant">
              Preferences
            </div>
            {NAV.map((item) => {
              const active = section === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => selectSection(item.id)}
                  aria-current={active}
                  className={`relative flex h-9 items-center gap-3 pl-4 pr-3 font-body text-[14px] font-medium transition-colors ${
                    active
                      ? "bg-surface-container-high text-on-surface"
                      : "text-on-surface-variant hover:bg-surface-container"
                  }`}
                >
                  {active && (
                    <span className="absolute left-0 top-0 h-full w-[3px] bg-primary" />
                  )}
                  <Icon
                    name={item.icon}
                    size={16}
                    className={
                      active ? "text-on-surface" : "text-on-surface-variant"
                    }
                  />
                  {item.label}
                </button>
              )
            })}

            <div className="flex-1" />
            <div className="mx-3 border-t border-outline-variant py-3">
              <div className="flex items-center gap-2 font-sans text-[12px] text-on-surface-variant">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />{" "}
                Connected to W&amp;B
              </div>
              <div className="mt-1 flex items-center gap-1.5 font-sans text-[12px] text-on-surface-variant">
                <Icon name="git-branch" size={11} className="text-outline" />{" "}
                main · a3f9c12
              </div>
              <div className="mt-1 flex items-center gap-1.5 font-sans text-[12px] text-outline">
                <Icon name="hard-drive" size={11} /> 247 MB cached
              </div>
            </div>
          </nav>

          {/* Content — overflow-hidden prevents cards from visually extending into the nav rail */}
          <div ref={scrollRef} className="flex-1 overflow-hidden p-8">
            <div className="h-full overflow-y-auto pr-2">
              {section === "account" && (
                <AccountSection
                  onManageTracker={manageTracker}
                  workspaceRoot={workspaceRoot}
                  trackerKind={trackerKind}
                  onTrackerConnected={onTrackerConnected}
                  onTrackerDisconnected={onTrackerDisconnected}
                />
              )}
              {section === "settings" && (
                <SettingsSection
                  ref={trackersRef}
                  highlightTrackers={highlightTrackers}
                />
              )}
              {section === "models" && <ModelsSection />}
              {(section === "shortcuts" ||
                section === "themes" ||
                section === "extensions") && (
                <div className="mx-auto flex max-w-[720px] flex-col items-center justify-center gap-3 pt-20 text-center">
                  <Icon
                    name={NAV.find((n) => n.id === section)!.icon}
                    size={30}
                    className="text-outline-variant"
                  />
                  <p className="font-body text-[14px] text-on-surface-variant">
                    {NAV.find((n) => n.id === section)!.label} preferences
                    coming soon.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
