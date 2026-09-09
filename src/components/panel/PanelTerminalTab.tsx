import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Icon } from "../ui/Icon";
import {
  useDispatch,
  useTerminalSessions,
  useActiveTerminal,
  useToast,
} from "../../ide/hooks";
import type { TerminalSession } from "../../ide/store";
import type { TerminalProfile } from "../../ipc/tauri";
import { bonafide } from "../../ipc/tauri";

// Stable counter for generating unique terminal session ids without
// pulling in a uuid dependency.
let terminalIdCounter = 0;
function makeTerminalId(): string {
  terminalIdCounter += 1;
  return `term_${Date.now()}_${terminalIdCounter}`;
}

// Stripped-down xterm.js theme. Matches the surface-container-lowest
// background of the Bonafide UI so the terminal reads as part of the
// panel, not a floating island.
const THEME = {
  background: "#1c1f26",
  foreground: "#c5c8d4",
  cursor: "#a8b3cf",
  selectionBackground: "#3b4252",
  black: "#1e2127",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#abb2bf",
  brightBlack: "#5c6370",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
};

/**
 * One xterm.js instance bound to one PTY session over a single WebSocket.
 *
 * Lifecycle:
 *   - On mount: open a WS to the PTY bridge, send a JSON "hello" frame
 *     identifying the chosen profile, then pipe binary frames in both
 *     directions until the socket closes.
 *   - On unmount: close the socket and dispose of the xterm instance.
 *
 * The terminal is "ready upon launch" — we don't wait for the user to
 * click Connect. As soon as the session is added to the store, we open
 * the WS and start streaming bytes.
 */
function TerminalSessionView({
  session,
  isActive,
}: {
  session: TerminalSession;
  isActive: boolean;
}) {
  const dispatch = useDispatch();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const connectedRef = useRef(false);

  // Open the WebSocket and start streaming as soon as this component mounts.
  // We don't render any "Connect" button — the contract with the user is
  // that a new terminal is ready immediately.
  useEffect(() => {
    if (!containerRef.current) return;
    if (termRef.current) return; // already initialized

    const term = new Terminal({
      cursorBlink: true,
      // fontSize + lineHeight are the two settings that fix the "way too
      // far apart" rendering from before. xterm's default lineHeight of
      // 1.4 with our 13px font produced 18.2px line boxes — paired with
      // the terminal grid's natural row height this left a wide vertical
      // gap between every line of output. Setting lineHeight: 1 matches
      // the row height xterm computes from the font metrics, so the text
      // sits tightly inside each row, exactly like VS Code.
      fontFamily: "var(--font-mono, 'Cascadia Code', 'Fira Code', Consolas, monospace)",
      fontSize: 13,
      lineHeight: 1,
      // Letter-spacing tightens the columns too — xterm defaults to a
      // value that's fine in editors but feels loose in a terminal.
      letterSpacing: 0,
      theme: THEME,
      scrollback: 5000,
      convertEol: true,
      // Allow xterm to handle the buffer as soon as the user scrolls
      // past it; without this, long outputs freeze the UI.
      fastScrollModifier: "alt",
      // Smooth scrolling on a per-pixel basis. Feels nicer in long
      // outputs but doesn't affect line spacing.
      smoothScrollDuration: 80,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    let cancelled = false;

    async function connect() {
      try {
        const wsUrl = await bonafide.pty.getWsUrl();
        if (cancelled) return;
        const ws = new WebSocket(wsUrl);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;

        ws.onopen = () => {
          if (cancelled) return;
          connectedRef.current = true;
          // Handshake: tell the server which profile to spawn and the
          // initial grid size so the PTY opens at the correct dimensions.
          const handshake = JSON.stringify({
            type: "hello",
            profileId: session.profileId,
            cols: term.cols,
            rows: term.rows,
          });
          ws.send(handshake);
          dispatch({
            type: "SET_TERMINAL_STATUS",
            id: session.id,
            status: "ready",
          });
        };

        ws.onmessage = (e) => {
          if (cancelled) return;
          if (typeof e.data === "string") {
            // JSON control frame (e.g. exit notification).
            try {
              const msg = JSON.parse(e.data);
              if (msg.type === "exit") {
                term.writeln(
                  `\r\n\x1b[2m[process completed${
                    msg.code != null ? ` with code ${msg.code}` : ""
                  }]\x1b[0m`,
                );
                dispatch({
                  type: "SET_TERMINAL_STATUS",
                  id: session.id,
                  status: "exited",
                });
              }
            } catch {
              // Not JSON — write it raw.
              term.write(e.data);
            }
          } else {
            const text = new TextDecoder().decode(e.data as ArrayBuffer);
            term.write(text);
          }
        };

        ws.onclose = () => {
          connectedRef.current = false;
          if (termRef.current && !cancelled) {
            term.writeln("\r\n\x1b[33m[disconnected]\x1b[0m");
          }
          dispatch({
            type: "SET_TERMINAL_STATUS",
            id: session.id,
            status: "exited",
          });
        };

        ws.onerror = () => {
          if (cancelled) return;
          term.writeln("\r\n\x1b[31m[connection error]\x1b[0m");
          dispatch({
            type: "SET_TERMINAL_STATUS",
            id: session.id,
            status: "error",
          });
        };

        // Pipe keystrokes from xterm into the PTY.
        term.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
          }
        });

        // Pipe resize events from xterm into the PTY.
        term.onResize(({ cols, rows }) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "resize", cols, rows }));
          }
        });
      } catch (err) {
        if (cancelled) return;
        term.writeln(
          `\r\n\x1b[31m[failed to connect: ${(err as Error).message}]\x1b[0m`,
        );
        dispatch({
          type: "SET_TERMINAL_STATUS",
          id: session.id,
          status: "error",
        });
      }
    }

    void connect();

    return () => {
      cancelled = true;
      connectedRef.current = false;
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [dispatch, session.id, session.profileId]);

  // Refit the terminal whenever the panel's height changes (window
  // resize, resize handle drag) so the grid stays full.
  useEffect(() => {
    if (!isActive) return;
    const observer = new ResizeObserver(() => {
      fitRef.current?.fit();
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [isActive]);

  // Only fit when this session becomes active — otherwise we'd fight
  // with the xterm canvas size while the panel is hidden.
  useEffect(() => {
    if (isActive) {
      // Defer to next frame so the container has its real dimensions.
      requestAnimationFrame(() => fitRef.current?.fit());
    }
  }, [isActive]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden p-1"
      style={{ background: THEME.background }}
    />
  );
}

// ── Profile picker dropdown ──────────────────────────────────────────────

function LaunchProfileMenu({
  onPick,
  onClose,
}: {
  onPick: (p: TerminalProfile) => void;
  onClose: () => void;
}) {
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    bonafide.pty
      .listProfiles()
      .then((list) => {
        if (cancelled) return;
        setProfiles(list);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setProfiles([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close on outside click — VS Code does this too.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border border-outline-variant bg-surface-container-lowest py-1 font-sans text-[12px] shadow-xl"
    >
      <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-outline">
        Launch Profile
      </div>
      {loading ? (
        <div className="px-3 py-2 text-outline">Detecting shells…</div>
      ) : profiles.length === 0 ? (
        <div className="px-3 py-2 text-outline">No shells detected.</div>
      ) : (
        profiles.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={!p.available}
            onClick={() => {
              onPick(p);
              onClose();
            }}
            className={`flex w-full items-center justify-between px-3 py-1.5 text-left transition-colors duration-[80ms] ${
              p.available
                ? "text-on-surface hover:bg-surface-container-high"
                : "cursor-not-allowed text-outline"
            }`}
          >
            <span className="flex items-center gap-2">
              <Icon name="terminal" size={12} />
              {p.label}
            </span>
            {!p.available && (
              <span className="text-[10px] text-outline">not found</span>
            )}
          </button>
        ))
      )}
    </div>
  );
}

// ── Session tab strip ────────────────────────────────────────────────────

function TerminalSessionTabs({
  sessions,
  activeId,
  onSelect,
  onClose,
  onAdd,
}: {
  sessions: TerminalSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="flex h-7 shrink-0 items-stretch border-b border-outline-variant/40 bg-surface-container-low pl-1">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {sessions.map((s) => {
          const isActive = s.id === activeId;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s.id)}
              className={`group flex shrink-0 items-center gap-1.5 border-r border-outline-variant/40 px-2.5 font-sans text-[11px] transition-colors duration-[80ms] ${
                isActive
                  ? "bg-surface-container-lowest text-on-surface"
                  : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
              }`}
            >
              {/* Status dot — same convention as VS Code Terminal tabs */}
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  s.status === "ready"
                    ? "bg-green-500"
                    : s.status === "spawning"
                      ? "bg-yellow-500 animate-pulse"
                      : s.status === "error"
                        ? "bg-red-500"
                        : "bg-outline"
                }`}
                aria-label={s.status}
              />
              <span className="max-w-[120px] truncate">{s.profileLabel}</span>
              <span
                role="button"
                aria-label="Close terminal"
                title="Close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(s.id);
                }}
                className={`ml-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded transition-colors ${
                  isActive
                    ? "hover:bg-surface-container-high"
                    : "opacity-0 group-hover:opacity-100 hover:bg-surface-container-high"
                }`}
              >
                <Icon name="x" size={10} />
              </span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onAdd}
        title="New Terminal (Ctrl+Shift+`)"
        aria-label="New Terminal"
        className="flex w-7 shrink-0 items-center justify-center border-l border-outline-variant/40 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
      >
        <Icon name="plus" size={12} />
      </button>
    </div>
  );
}

// ── Public component ─────────────────────────────────────────────────────

export function PanelTerminalTab() {
  const dispatch = useDispatch();
  const sessions = useTerminalSessions();
  const active = useActiveTerminal();
  const [menuOpen, setMenuOpen] = useState(false);
  const pushToast = useToast();

  const launchProfile = useCallback(
    async (p: TerminalProfile) => {
      if (!p.available) {
        pushToast(`${p.label} not found on PATH`, "error");
        return;
      }
      const id = makeTerminalId();
      const session: TerminalSession = {
        id,
        profileId: p.id,
        profileLabel: p.label,
        status: "spawning",
      };
      dispatch({ type: "ADD_TERMINAL_SESSION", session });
    },
    [dispatch, pushToast],
  );

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* Session tab strip + "new" menu */}
      <TerminalSessionTabs
        sessions={sessions}
        activeId={active?.id ?? null}
        onSelect={(id) => dispatch({ type: "ACTIVATE_TERMINAL_SESSION", id })}
        onClose={(id) => dispatch({ type: "REMOVE_TERMINAL_SESSION", id })}
        onAdd={() => setMenuOpen((v) => !v)}
      />

      {/* Right-side toolbar with fit + new menu (also opens the picker) */}
      <div className="absolute right-1 top-0.5 z-40 flex items-center gap-0.5">
        {menuOpen && (
          <LaunchProfileMenu
            onPick={launchProfile}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </div>

      {/* Body: active xterm, or empty state */}
      <div className="min-h-0 flex-1 overflow-hidden bg-surface-container-lowest">
        {active ? (
          <TerminalSessionView
            key={active.id}
            session={active}
            isActive={true}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center font-sans text-[12px] text-outline">
            <Icon name="terminal" size={28} className="text-outline-variant" />
            <p>No terminal open.</p>
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              className="mt-1 rounded bg-primary px-3 py-1 text-[12px] font-medium text-on-primary hover:brightness-110"
            >
              + New Terminal
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
