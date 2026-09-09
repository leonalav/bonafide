import { useEffect, useState } from "react";
import { Icon } from "./ui/Icon";
import { bonafide, isTauri } from "../ipc/tauri";
import { useDispatch, usePanel } from "../ide/hooks";
import type { PanelTab } from "../ide/store";

// Panel tab buttons rendered in the title bar, just left of the
// window controls. Each button toggles its tab: if the panel is
// closed it opens with that tab; if the panel is open with a
// different tab it switches to that tab; if the same tab is
// already active the button closes the panel.
const PANEL_TABS: { id: PanelTab; label: string; icon: string }[] = [
  { id: "problems", label: "Problems", icon: "alert-triangle" },
  { id: "output", label: "Output", icon: "terminal" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "debug", label: "Debug Console", icon: "bug" },
  { id: "ports", label: "Ports", icon: "network" },
];

// Severity dots: shows problem counts inline on the Problems tab button.
// Pure UI helper — derived from the diagnostic list each render. Cheap.
function ProblemsBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-1 font-sans text-[9px] font-medium leading-none text-white">
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * Custom title bar.
 *
 * macOS: the OS draws its own traffic lights on the leading edge; we leave a
 *       padded gap there.
 * Win/Linux: the three trailing circles are the real window controls
 *       (minimize, maximize/restore, close). Order is orange → blue → red.
 *       The bar is a drag region; the buttons opt out via
 *       `WebkitAppRegion: no-drag` so click events still reach them.
 *
 * Panel tabs: A row of small icon buttons sits just left of the window
 *             controls. Each button toggles its corresponding tab in the
 *             bottom Panel. The Problems button shows a red badge with
 *             the error count, like VS Code's tab.
 *
 * Tauri 2 note: in browser/dev builds (where the Tauri IPC isn't
 * available) the title bar renders but the window controls are inert —
 * the icons render as static dots, no hover effects.
 */
export function TitleBar() {
  const desktop = isTauri();
  const isMac = desktop && window.navigator.platform.toLowerCase().includes("mac");
  const [isMaximized, setIsMaximized] = useState(false);
  const dispatch = useDispatch();
  const panel = usePanel();

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void bonafide.window.isMaximized().then((v) => {
      if (!cancelled) setIsMaximized(v);
    });
    const unsubscribe = bonafide.window.onMaximizeChanged((maximized) => {
      setIsMaximized(maximized);
    });
    return () => {
      cancelled = true;
      void unsubscribe();
    };
  }, [desktop]);

  // Fail loudly if the IPC bridge is missing — otherwise a stray click
  // does nothing and the user has no idea why.
  const send = (fn: (() => Promise<void> | void) | undefined, label: string): void => {
    if (!fn) {
      console.error(`[TitleBar] bonafide.window.${label} is unavailable — IPC bridge not loaded`);
      return;
    }
    void fn();
  };

  function onPanelTabClick(tab: PanelTab) {
    // Same tab → close. Different tab → switch. Closed → open with that tab.
    if (panel.open && panel.tab === tab) {
      dispatch({ type: "TOGGLE_PANEL" });
    } else {
      dispatch({ type: "SET_PANEL_TAB", tab });
    }
  }

  const errorCount = panel.diagnostics.filter((d) => d.severity === "error").length;

  return (
    <div
      className="flex h-8 shrink-0 items-center border-b border-outline-variant bg-surface-container-lowest pl-3 pr-3 select-none"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {/* macOS draws its own traffic lights — leave room so we don't overlap. */}
      {isMac ? <div className="w-[70px] shrink-0" /> : null}

      <div className="flex flex-1 items-center justify-center gap-2">
        <Icon name="diamond" size={13} className="text-primary" />
        <span className="font-sans text-[13px] font-semibold tracking-tight text-on-surface">Bonafide</span>
        <span className="font-sans text-[12px] text-outline">— bonafide-train</span>
      </div>

      {/* Panel tab buttons + window controls on the trailing edge. */}
      <div
        className="flex items-center gap-1"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {/* Divider between app title and panel buttons — subtle */}
        <div className="mx-1 h-4 w-px bg-outline-variant/60" />

        {PANEL_TABS.map((tab) => {
          const isActive = panel.open && panel.tab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onPanelTabClick(tab.id)}
              title={`${tab.label} (Ctrl+J)`}
              aria-label={tab.label}
              aria-pressed={isActive}
              className={`flex h-6 items-center gap-1 rounded px-1.5 font-sans text-[11px] transition-colors duration-[100ms] ${
                isActive
                  ? "bg-primary/20 text-primary"
                  : "text-outline hover:bg-surface-container hover:text-on-surface"
              }`}
            >
              <Icon name={tab.icon} size={12} className="shrink-0" />
              {tab.id === "problems" && <ProblemsBadge count={errorCount} />}
            </button>
          );
        })}

        {/* Slight gap before window controls */}
        <div className="mx-1 h-4 w-px bg-outline-variant/60" />

        {/* Windows / Linux: functional window controls. */}
        {!isMac ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Minimize"
              title="Minimize"
              className="group h-3 w-3 rounded-full border border-black/10 bg-tertiary transition-colors hover:bg-tertiary-container focus-visible:ring-2 focus-visible:ring-primary"
              onClick={() => send(desktop ? bonafide.window.minimize : undefined, "minimize")}
            />
            <button
              type="button"
              aria-label={isMaximized ? "Restore" : "Maximize"}
              title={isMaximized ? "Restore" : "Maximize"}
              className="group h-3 w-3 rounded-full border border-black/10 bg-primary transition-colors hover:bg-primary-container focus-visible:ring-2 focus-visible:ring-primary"
              onClick={() => send(desktop ? bonafide.window.toggleMaximize : undefined, "toggleMaximize")}
            />
            <button
              type="button"
              aria-label="Close"
              title="Close"
              className="h-3 w-3 rounded-full border border-black/10 bg-error transition-colors hover:brightness-110 focus-visible:ring-2 focus-visible:ring-primary"
              onClick={() => send(desktop ? bonafide.window.close : undefined, "close")}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
