import { useEffect, useState } from "react";
import { Icon } from "./ui/Icon";
import { bonafide, isTauri } from "../ipc/tauri";

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
 * Tauri 2 note: in browser/dev builds (where the Tauri IPC isn't
 * available) the title bar renders but the window controls are inert —
 * the icons render as static dots, no hover effects.
 */
export function TitleBar() {
  const desktop = isTauri();
  const isMac = desktop && window.navigator.platform.toLowerCase().includes("mac");
  const [isMaximized, setIsMaximized] = useState(false);

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

      {/* Windows / Linux: functional window controls on the trailing edge. */}
      {!isMac ? (
        <div
          className="flex items-center gap-2"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
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
  );
}
