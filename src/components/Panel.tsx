import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./ui/Icon";
import { useDispatch, usePanel, usePanelHeight, usePanelTab } from "../ide/hooks";
import { HorizontalResizeHandle } from "./ui/HorizontalResizeHandle";
import { ProblemsTab } from "./panel/PanelProblemsTab";
import { PanelOutputTab } from "./panel/PanelOutputTab";
import { PanelTerminalTab } from "./panel/PanelTerminalTab";
import { PanelDebugConsoleTab } from "./panel/PanelDebugConsoleTab";
import { PortsTab } from "./panel/PanelPortsTab";

// ── Panel tab registry ───────────────────────────────────────────────────────

type PanelTabId = "problems" | "output" | "terminal" | "debug" | "ports";

const TABS: { id: PanelTabId; label: string; icon: string }[] = [
  { id: "problems", label: "Problems", icon: "alert-triangle" },
  { id: "output", label: "Output", icon: "terminal" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "debug", label: "Debug Console", icon: "bug" },
  { id: "ports", label: "Ports", icon: "network" },
];

// ── Tab strip ───────────────────────────────────────────────────────────────

function PanelTabStrip({ active }: { active: PanelTabId }) {
  const dispatch = useDispatch();

  return (
    <div className="flex h-8 shrink-0 items-stretch border-b border-outline-variant bg-surface-container-low">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => dispatch({ type: "SET_PANEL_TAB", tab: tab.id })}
          className={`group flex items-center gap-1.5 border-r border-outline-variant px-3 font-sans text-[12px] transition-colors duration-[100ms] ${
            active === tab.id
              ? "border-b-2 border-b-primary bg-surface-container-lowest text-on-surface"
              : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
          }`}
          style={active === tab.id ? { borderBottomColor: "var(--primary)" } : {}}
        >
          <Icon name={tab.icon} size={12} className="shrink-0" />
          <span>{tab.label}</span>
        </button>
      ))}
      <div className="flex-1" />
      <button
        onClick={() => dispatch({ type: "TOGGLE_PANEL" })}
        className="flex w-8 items-center justify-center text-outline hover:bg-surface-container-high hover:text-on-surface"
        aria-label="Close panel"
        title="Close Panel"
      >
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}

// ── Panel ───────────────────────────────────────────────────────────────────

export function Panel() {
  const dispatch = useDispatch();
  const panel = usePanel();
  const height = usePanelHeight();
  const activeTab = usePanelTab();

  if (!panel.open) return null;

  const content = () => {
    switch (activeTab) {
      case "problems":
        return <ProblemsTab />;
      case "output":
        return <PanelOutputTab />;
      case "terminal":
        return <PanelTerminalTab />;
      case "debug":
        return <PanelDebugConsoleTab />;
      case "ports":
        return <PortsTab />;
    }
  };

  return (
    <div
      className="flex shrink-0 flex-col overflow-hidden border-t border-outline-variant bg-surface-container-low"
      style={{ height }}
    >
      <HorizontalResizeHandle
        height={height}
        onResize={(h) => dispatch({ type: "SET_PANEL_HEIGHT", height: h })}
        minHeight={100}
        maxHeight={600}
        ariaLabel="Resize panel"
      />
      <PanelTabStrip active={activeTab} />
      <div className="min-h-0 flex-1 overflow-hidden">
        {content()}
      </div>
    </div>
  );
}
