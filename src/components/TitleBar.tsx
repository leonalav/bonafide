import { useEffect, useRef, useState } from "react";
import { Icon } from "./ui/Icon";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { bonafide, isTauri } from "../ipc/tauri";
import { useDispatch, usePanel } from "../ide/hooks";
import type { IdeAction, PanelTab } from "../ide/store";

// ── Context menu helpers ──────────────────────────────────────────────────
// All take dispatch directly; no callbacks needed.

function panelTabItems(
  dispatch: (a: IdeAction) => void,
  currentTab: PanelTab,
  panelOpen: boolean,
): MenuItem[] {
  const tabs: { id: PanelTab; label: string; shortcut?: string }[] = [
    { id: "problems", label: "Problems", shortcut: "Ctrl+Shift+M" },
    { id: "output", label: "Output", shortcut: "Ctrl+Shift+U" },
    { id: "terminal", label: "Terminal", shortcut: "Ctrl+`" },
    { id: "debug", label: "Debug Console" },
    { id: "ports", label: "Ports" },
  ];
  return [
    {
      kind: "action",
      label: panelOpen ? "Close Panel" : "Toggle Panel",
      icon: panelOpen ? "chevrons-down" : "chevrons-up",
      shortcut: "Ctrl+J",
      onSelect: () => dispatch({ type: "TOGGLE_PANEL" }),
    },
    { kind: "separator" },
    ...tabs.map((t) => ({
      kind: "action" as const,
      label: `Show: ${t.label}`,
      icon: "panel-bottom",
      shortcut: t.shortcut,
      disabled: currentTab === t.id && panelOpen,
      onSelect: () => dispatch({ type: "SET_PANEL_TAB", tab: t.id }),
    })),
  ];
}

function windowMinimizeItems(): MenuItem[] {
  return [
    { kind: "action", label: "Minimize", icon: "minus", onSelect: () => bonafide.window.minimize() },
    { kind: "separator" },
    {
      kind: "action",
      label: "Maximize / Restore",
      icon: "maximize-2",
      onSelect: () => bonafide.window.toggleMaximize(),
    },
    { kind: "separator" },
    {
      kind: "action",
      label: "Close Window",
      icon: "x",
      shortcut: "Alt+F4",
      danger: true,
      onSelect: () => bonafide.window.close(),
    },
  ];
}

function windowMaximizeItems(): MenuItem[] {
  return [
    {
      kind: "action",
      label: "Maximize / Restore",
      icon: "maximize-2",
      onSelect: () => bonafide.window.toggleMaximize(),
    },
    { kind: "separator" },
    { kind: "action", label: "Minimize", icon: "minus", onSelect: () => bonafide.window.minimize() },
    { kind: "separator" },
    {
      kind: "action",
      label: "Close Window",
      icon: "x",
      shortcut: "Alt+F4",
      danger: true,
      onSelect: () => bonafide.window.close(),
    },
  ];
}

function windowCloseItems(): MenuItem[] {
  return [
    {
      kind: "action",
      label: "Close Window",
      icon: "x",
      shortcut: "Alt+F4",
      danger: true,
      onSelect: () => bonafide.window.close(),
    },
    { kind: "separator" },
    { kind: "action", label: "Minimize", icon: "minus", onSelect: () => bonafide.window.minimize() },
    { kind: "separator" },
    {
      kind: "action",
      label: "Maximize / Restore",
      icon: "maximize-2",
      onSelect: () => bonafide.window.toggleMaximize(),
    },
  ];
}

// ── TitleBar ─────────────────────────────────────────────────────────────

/**
 * Custom title bar.
 *
 * Layout (right → left):
 *   [ Panel toggle ] [ Min ● Max ● Close ]
 *
 * Every button has a right-click context menu. Keyboard shortcuts registered
 * at the title bar div level (Ctrl+J, Ctrl+Shift+M/U/`, F11) work whenever
 * the window has focus.
 *
 * Tauri note: in browser/dev preview, window controls are inert — the circles
 * render but clicks are no-ops.
 */
export function TitleBar() {
  const desktop = isTauri();
  const isMac = desktop && window.navigator.platform.toLowerCase().includes("mac");

  const [isMaximized, setIsMaximized] = useState(false);
  const dispatch = useDispatch();
  const panel = usePanel();

  // Context menu state — single shared anchor, one menu at a time
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const closeCtxMenu = () => setCtxMenu(null);

  // Track maximized state via resize events from the OS
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void bonafide.window.isMaximized().then((v) => {
      if (!cancelled) setIsMaximized(v);
    });
    const unsub = bonafide.window.onMaximizeChanged((m) => {
      setIsMaximized(m);
    });
    return () => {
      cancelled = true;
      void unsub();
    };
  }, [desktop]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────
  function onKeyDown(e: React.KeyboardEvent) {
    const cmd = e.ctrlKey || e.metaKey;
    if (!cmd) return;
    switch (e.key.toLowerCase()) {
      case "j":
        e.preventDefault();
        dispatch({ type: "TOGGLE_PANEL" });
        break;
      case "p":
        if (e.shiftKey) { e.preventDefault(); dispatch({ type: "SET_PANEL_TAB", tab: "problems" }); }
        break;
      case "u":
        if (e.shiftKey) { e.preventDefault(); dispatch({ type: "SET_PANEL_TAB", tab: "output" }); }
        break;
      case "`":
        e.preventDefault();
        dispatch({ type: "SET_PANEL_TAB", tab: "terminal" });
        break;
    }
  }

  // ── Context menu openers ─────────────────────────────────────────────
  function openPanelCtx(e: React.MouseEvent) {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, items: panelTabItems(dispatch, panel.tab, panel.open) });
  }

  function openMinCtx(e: React.MouseEvent) {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, items: windowMinimizeItems() });
  }

  function openMaxCtx(e: React.MouseEvent) {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, items: windowMaximizeItems() });
  }

  function openCloseCtx(e: React.MouseEvent) {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, items: windowCloseItems() });
  }

  return (
    <>
      <div
        onKeyDown={onKeyDown}
        onClick={closeCtxMenu}
        // drag region — the whole bar is draggable; child buttons opt out
        className="flex h-8 shrink-0 select-none items-center border-b border-outline-variant bg-surface-container-lowest pl-3 pr-2"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {/* macOS traffic-light spacer */}
        {isMac ? <div className="w-[70px] shrink-0" /> : null}

        {/* App title */}
        <div className="flex flex-1 items-center justify-center gap-2">
          <Icon name="diamond" size={13} className="text-primary" />
          <span className="font-sans text-[13px] font-semibold tracking-tight text-on-surface">
            Bonafide
          </span>
          <span className="font-sans text-[12px] text-outline">— bonafide-train</span>
        </div>

        {/* ── Action buttons + window controls ─────────────────────────── */}
        <div
          className="flex items-center gap-1"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          {/* Divider */}
          <div className="mx-1 h-4 w-px bg-outline-variant/60" />

          {/* ── Panel toggle ───────────────────────────────────────── */}
          <button
            type="button"
            aria-label="Toggle Panel"
            aria-pressed={panel.open}
            title="Toggle Panel (Ctrl+J)"
            onClick={() => dispatch({ type: "TOGGLE_PANEL" })}
            onContextMenu={openPanelCtx}
            className={`flex h-6 w-6 items-center justify-center rounded transition-colors duration-[100ms] ${
              panel.open
                ? "bg-primary/20 text-primary"
                : "text-outline hover:bg-surface-container hover:text-on-surface"
            }`}
          >
            <Icon name="panel-bottom" size={14} />
          </button>

          {/* Divider */}
          <div className="mx-1 h-4 w-px bg-outline-variant/60" />

          {/* ── Window controls ───────────────────────────────────── */}
          {!isMac && (
            <div className="flex items-center gap-2">
              {/* Minimize */}
              <button
                type="button"
                aria-label="Minimize"
                title="Minimize"
                onClick={() => bonafide.window.minimize()}
                onContextMenu={openMinCtx}
                className="h-3 w-3 rounded-full border border-black/10 bg-tertiary transition-colors hover:bg-tertiary-container"
              />
              {/* Maximize / Restore */}
              <button
                type="button"
                aria-label={isMaximized ? "Restore" : "Maximize"}
                title={isMaximized ? "Restore" : "Maximize"}
                onClick={() => bonafide.window.toggleMaximize()}
                onContextMenu={openMaxCtx}
                className="h-3 w-3 rounded-full border border-black/10 bg-primary transition-colors hover:bg-primary-container"
              />
              {/* Close */}
              <button
                type="button"
                aria-label="Close"
                title="Close"
                onClick={() => bonafide.window.close()}
                onContextMenu={openCloseCtx}
                className="h-3 w-3 rounded-full border border-black/10 bg-error transition-colors hover:brightness-110"
              />
            </div>
          )}
        </div>
      </div>

      {/* Context menu overlay */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenu.items}
          onClose={closeCtxMenu}
        />
      )}
    </>
  );
}
