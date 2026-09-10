import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { Button, StatusDot } from "../ui/primitives";
import { Card, CardHeader, Checkbox } from "../ui/controls";
import {
  bonafide,
  type MlflowConnectPayload,
  type TrackerKind,
} from "@/ipc/tauri";

type Provider = { name: string; account?: string; connected: boolean; meta?: string; note?: string };

const TRACKERS: Provider[] = [
  { name: "Weights & Biases", account: "ada@wandb.ai", connected: true, meta: "Synced 12s ago · 27 runs · last login 2h ago" },
  { name: "MLflow", connected: false, note: "http://localhost:5000" },
  { name: "Comet", connected: false },
  { name: "Neptune", connected: false },
];

const SERVICES: Provider[] = [
  { name: "GitHub", account: "ada", connected: true, meta: "23 repos accessible" },
  { name: "Hugging Face", account: "ada", connected: true, meta: "4 orgs · write access" },
  { name: "Slack", connected: false, meta: "For run notifications" },
];

const RECENT = [
  { path: "/Users/ada/projects/vision-experiments", runs: 27 },
  { path: "/Users/ada/projects/llama-finetune", runs: 12 },
  { path: "/Users/ada/projects/recommender", runs: 218 },
];

function ProviderRow({ p, onManage }: { p: Provider; onManage?: () => void }) {
  return (
    <div className="border-t border-outline-variant/60 py-2 first:border-t-0">
      <div className="flex items-center gap-3">
        <StatusDot token={p.connected ? "primary" : "outline"} />
        <span className="flex-1 font-body text-[13px] text-on-surface">{p.name}</span>
        <span className="font-body text-[12px] text-on-surface-variant">{p.connected ? p.account : "Not connected"}</span>
        {p.connected ? (
          <div className="flex items-center gap-1">
            <Button variant="secondary" size="sm" onClick={onManage}>Manage</Button>
            <button className="flex h-7 w-7 items-center justify-center rounded text-outline hover:bg-surface-container-high hover:text-error" aria-label={`Disconnect ${p.name}`}>
              <Icon name="x" size={13} />
            </button>
          </div>
        ) : (
          <Button variant="secondary" size="sm">Connect</Button>
        )}
      </div>
      {p.connected && p.meta && <p className="ml-6 mt-0.5 font-body text-[12px] text-on-surface-variant">{p.meta}</p>}
      {!p.connected && p.meta && <p className="ml-6 mt-0.5 font-body text-[12px] text-outline">{p.meta}</p>}
      {!p.connected && p.note && (
        <div className="ml-6 mt-1.5 flex items-center gap-2">
          <input
            defaultValue={p.note}
            className="h-7 flex-1 rounded border border-outline-variant bg-surface px-2 font-sans text-[12px] text-on-surface focus:border-primary focus:outline-none"
          />
          <Button variant="secondary" size="sm">Test connection</Button>
        </div>
      )}
    </div>
  );
}

export function AccountSection({
  onManageTracker,
  workspaceRoot,
  trackerKind,
  onTrackerConnected,
  onTrackerDisconnected,
}: {
  onManageTracker: () => void;
  workspaceRoot: string | null;
  trackerKind: TrackerKind | null;
  onTrackerConnected?: (kind: "wandb" | "mlflow") => void;
  onTrackerDisconnected?: (kind: "wandb" | "mlflow") => void;
}) {
  const [wbApiKey, setWbApiKey] = useState("");
  const [wbConnecting, setWbConnecting] = useState(false);
  const [wbError, setWbError] = useState<string | null>(null);

  // MLflow form state — same parallel structure as W&B so the two cards
  // stay visually consistent.
  const [mlflowBaseUrl, setMlflowBaseUrl] = useState("http://localhost:5000");
  const [mlflowToken, setMlflowToken] = useState("");
  const [mlflowProject, setMlflowProject] = useState("Default");
  const [mlflowConnecting, setMlflowConnecting] = useState(false);
  const [mlflowError, setMlflowError] = useState<string | null>(null);

  // Workspace is opened from the App shell; when `null` the Connect
  // actions are gated so we never call `connect_tracker` with an
  // empty/missing workspace root.
  const workspaceOpen = workspaceRoot != null;

  // Mirror `workspaceRoot` into a ref so the async connect handlers
  // can detect a workspace switch mid-flight. Capturing the prop
  // directly in the closure (the previous behaviour) meant the
  // post-await setters could land on the wrong workspace.
  const workspaceRootRef = useRef<string | null>(workspaceRoot);
  useEffect(() => {
    workspaceRootRef.current = workspaceRoot;
  }, [workspaceRoot]);

  // Derive the connected state from the `trackerKind` prop so the
  // "Connected" pill survives a remount of the prefs window (the
  // source of truth lives in App's `trackerKindByWs` map, not in
  // local component state).
  const wbConnected = trackerKind === "wandb";
  const mlflowConnected = trackerKind === "mlflow";

  async function handleWbConnect() {
    if (!wbApiKey.trim() || !workspaceRoot) return;
    // Snapshot the workspace root so we can detect a mid-flight switch.
    const targetRoot = workspaceRoot;
    setWbConnecting(true);
    setWbError(null);
    try {
      await bonafide.tracker.connect("wandb", wbApiKey, targetRoot, undefined);
      // Guard: only update state if we're still targeting the same workspace.
      if (targetRoot !== workspaceRootRef.current) return;
      onTrackerConnected?.("wandb");
    } catch (err: unknown) {
      // Same guard on the error path — if the workspace changed while
      // we were awaiting, leave the new workspace's state alone.
      if (targetRoot !== workspaceRootRef.current) return;
      const kind = (err as { kind?: string }).kind;
      if (kind === "auth_failed") {
        setWbError("Auth failed — check your W&B API key.");
      } else if (kind === "no_python") {
        setWbError("Python 3.10+ not found. Set path in Settings → Python.");
      } else if (kind === "not_found") {
        setWbError("Workspace not found. Open a folder first.");
      } else if (kind === "shim_crashed") {
        setWbError("W&B shim crashed. Check the logs.");
      } else {
        setWbError((err as Error)?.message ?? String(err) ?? "Connection failed");
      }
    } finally {
      // Only clear the spinner if we're still on the same workspace —
      // otherwise the new workspace's own connect cycle owns the flag.
      if (targetRoot === workspaceRootRef.current) {
        setWbConnecting(false);
      }
    }
  }

  async function handleMlflowConnect() {
    if (!mlflowBaseUrl.trim() || !workspaceRoot) return;
    // Snapshot the workspace root so we can detect a mid-flight switch.
    const targetRoot = workspaceRoot;
    setMlflowConnecting(true);
    setMlflowError(null);
    try {
      const payload: MlflowConnectPayload = {
        baseUrl: mlflowBaseUrl,
        token: mlflowToken || undefined,
        project: mlflowProject || "Default",
      };
      await bonafide.tracker.connect(
        "mlflow",
        JSON.stringify(payload),
        targetRoot,
        mlflowProject,
      );
      // Guard: only update state if we're still targeting the same workspace.
      if (targetRoot !== workspaceRootRef.current) return;
      onTrackerConnected?.("mlflow");
    } catch (err: unknown) {
      // Same guard on the error path — if the workspace changed while
      // we were awaiting, leave the new workspace's state alone.
      if (targetRoot !== workspaceRootRef.current) return;
      const kind = (err as { kind?: string }).kind;
      if (kind === "auth_failed") {
        setMlflowError("Auth failed — check your MLflow token.");
      } else if (kind === "unknown") {
        setMlflowError("Connection refused — check that the MLflow server is running.");
      } else {
        setMlflowError((err as Error)?.message ?? String(err) ?? "Connection failed");
      }
    } finally {
      // Only clear the spinner if we're still on the same workspace —
      // otherwise the new workspace's own connect cycle owns the flag.
      if (targetRoot === workspaceRootRef.current) {
        setMlflowConnecting(false);
      }
    }
  }

  // Disconnect clears the OS-keyring credential, kills the W&B shim
  // process, and drops the workspace's tracker entry. Without the IPC
  // call the local React flag would clear but the keyring would still
  // hold the API key and the shim process would keep running. Guarded
  // by the same workspace snapshot pattern as the connect handlers so
  // a mid-flight click during a workspace switch can't write into the
  // wrong workspace's state.
  async function handleWbDisconnect() {
    const targetRoot = workspaceRoot;
    if (!targetRoot) return;
    try {
      await bonafide.tracker.disconnect("wandb", targetRoot);
    } catch (err) {
      console.error("[AccountSection] wandb disconnect failed:", err);
      // Continue — still update local state so UI is consistent
    }
    if (targetRoot !== workspaceRootRef.current) return;
    setWbError(null);
    onTrackerDisconnected?.("wandb");
  }

  async function handleMlflowDisconnect() {
    const targetRoot = workspaceRoot;
    if (!targetRoot) return;
    try {
      await bonafide.tracker.disconnect("mlflow", targetRoot);
    } catch (err) {
      console.error("[AccountSection] mlflow disconnect failed:", err);
    }
    if (targetRoot !== workspaceRootRef.current) return;
    setMlflowError(null);
    onTrackerDisconnected?.("mlflow");
  }
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-8">
      {/* Card 1 — Profile */}
      <Card>
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
            <Icon name="user-circle" size={26} />
          </div>
          <div className="flex-1">
            <div className="font-body text-[16px] font-medium text-on-surface">Ada Lovelace</div>
            <div className="font-body text-[13px] text-on-surface-variant">ada@bonafide.dev</div>
            <div className="font-body text-[12px] text-outline">Joined September 2026</div>
          </div>
          <Button variant="secondary" size="sm">
            <Icon name="edit" size={13} /> Edit
          </Button>
        </div>
      </Card>

      {/* Card 2 — Connected Trackers */}
      <Card>
        <CardHeader title="Connected Trackers" />
        <div className="mb-3 flex items-start gap-2 rounded border border-error/30 bg-error-container/20 p-3">
          <Icon name="alert-triangle" size={15} className="mt-0.5 shrink-0 text-error" />
          <div className="flex-1">
            <p className="font-body text-[13px] text-error">Connect a tracker to unlock inline decorations</p>
            <p className="mt-0.5 font-body text-[12px] text-on-surface-variant">
              Bonafide works without one, but you&apos;ll only see file-level git annotations.
            </p>
          </div>
          <Button size="sm">Connect W&amp;B →</Button>
        </div>
        {TRACKERS.map((p) => (
          <ProviderRow key={p.name} p={p} onManage={onManageTracker} />
        ))}
      </Card>

      {/* W&B Connect Card */}
      <Card>
        <CardHeader
          title="Weights & Biases"
          right={
            wbConnected ? (
              <div className="flex items-center gap-1.5">
                <StatusDot token="primary" />
                <span className="font-body text-[12px] text-primary">Connected</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <StatusDot token="outline" />
                <span className="font-body text-[12px] text-outline">Not connected</span>
              </div>
            )
          }
        />
        <div className="flex flex-col gap-2">
          {!workspaceOpen && (
            <div className="flex items-center gap-2 rounded border border-outline-variant/60 bg-surface-container-high/40 p-2.5">
              <Icon name="folder-open" size={13} className="shrink-0 text-on-surface-variant" />
              <span className="font-body text-[12px] text-on-surface-variant">
                Open a workspace before connecting a tracker.
              </span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <input
                type="password"
                value={wbApiKey}
                onChange={(e) => {
                  setWbApiKey(e.target.value);
                  setWbError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleWbConnect();
                }}
                placeholder="W&B API Key (xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx)"
                className="h-8 w-full rounded border border-outline-variant bg-surface px-3 pr-10 font-sans text-[13px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
              />
              {wbApiKey && (
                <button
                  onClick={() => {
                    setWbApiKey("");
                    setWbError(null);
                  }}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-outline hover:text-on-surface"
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
            <Button
              variant="primary"
              size="sm"
              disabled={!wbApiKey.trim() || wbConnecting || !workspaceOpen}
              onClick={() => void handleWbConnect()}
            >
              {wbConnecting ? "Connecting…" : wbConnected ? "Reconnect" : "Connect"}
            </Button>
            {wbConnected && !wbConnecting && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleWbDisconnect}
                className="hover:!text-error"
                aria-label="Disconnect W&B"
              >
                Disconnect
              </Button>
            )}
          </div>
          {wbError && (
            <div className="flex items-center gap-2 rounded border border-error/30 bg-error-container/20 p-2.5">
              <Icon name="alert-triangle" size={13} className="shrink-0 text-error" />
              <span className="font-body text-[12px] text-error">{wbError}</span>
            </div>
          )}
          {!wbConnected && !wbError && (
            <p className="font-body text-[12px] text-on-surface-variant">
              Find your API key at{" "}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  void bonafide.shell.openExternal("https://wandb.ai/authorize");
                }}
                className="underline hover:text-primary"
              >
                wandb.ai/authorize
              </a>
            </p>
          )}
        </div>
      </Card>

      {/* MLflow Connect Card */}
      <Card>
        <CardHeader
          title="MLflow"
          right={
            mlflowConnected ? (
              <div className="flex items-center gap-1.5">
                <StatusDot token="primary" />
                <span className="font-body text-[12px] text-primary">Connected</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <StatusDot token="outline" />
                <span className="font-body text-[12px] text-outline">Not connected</span>
              </div>
            )
          }
        />
        <div className="flex flex-col gap-2">
          {!workspaceOpen && (
            <div className="flex items-center gap-2 rounded border border-outline-variant/60 bg-surface-container-high/40 p-2.5">
              <Icon name="folder-open" size={13} className="shrink-0 text-on-surface-variant" />
              <span className="font-body text-[12px] text-on-surface-variant">
                Open a workspace before connecting a tracker.
              </span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={mlflowBaseUrl}
              onChange={(e) => {
                setMlflowBaseUrl(e.target.value);
                setMlflowError(null);
              }}
              placeholder="http://localhost:5000"
              className="h-8 w-full rounded border border-outline-variant bg-surface px-3 font-sans text-[13px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={mlflowToken}
              onChange={(e) => {
                setMlflowToken(e.target.value);
                setMlflowError(null);
              }}
              placeholder="Bearer token (optional)"
              className="h-8 w-full rounded border border-outline-variant bg-surface px-3 font-sans text-[13px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={mlflowProject}
              onChange={(e) => {
                setMlflowProject(e.target.value);
                setMlflowError(null);
              }}
              placeholder="Default"
              className="h-8 w-full rounded border border-outline-variant bg-surface px-3 font-sans text-[13px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
            />
            <Button
              variant="primary"
              size="sm"
              disabled={!mlflowBaseUrl.trim() || mlflowConnecting || !workspaceOpen}
              onClick={() => void handleMlflowConnect()}
            >
              {mlflowConnecting ? "Connecting…" : mlflowConnected ? "Reconnect" : "Connect"}
            </Button>
            {mlflowConnected && !mlflowConnecting && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleMlflowDisconnect}
                className="hover:!text-error"
                aria-label="Disconnect MLflow"
              >
                Disconnect
              </Button>
            )}
          </div>
          {mlflowError && (
            <div className="flex items-center gap-2 rounded border border-error/30 bg-error-container/20 p-2.5">
              <Icon name="alert-triangle" size={13} className="shrink-0 text-error" />
              <span className="font-body text-[12px] text-error">{mlflowError}</span>
            </div>
          )}
          {!mlflowConnected && !mlflowError && (
            <p className="font-body text-[12px] text-on-surface-variant">
              Default URL works for a local{" "}
              <code className="rounded bg-surface-container px-1 font-mono text-[11px]">mlflow server</code>
              . For hosted MLflow, paste the tracking URL and an access token.
            </p>
          )}
        </div>
      </Card>

      {/* Card 3 — Connected Services */}
      <Card>
        <CardHeader title="Connected Services" />
        {SERVICES.map((p) => (
          <ProviderRow key={p.name} p={p} />
        ))}
      </Card>

      {/* Card 4 — Workspace */}
      <Card>
        <CardHeader title="Workspace" />
        <div className="relative rounded border-l-2 border-primary bg-surface-container-high/50 py-1.5 pl-3">
          <div className="font-sans text-[13px] text-on-surface">/Users/ada/projects/bona-train</div>
          <div className="font-body text-[12px] text-on-surface-variant">Last opened 4 minutes ago</div>
        </div>
        <div className="label-caps mb-1 mt-3 text-outline">Recent</div>
        <div className="flex flex-col">
          {RECENT.map((r) => (
            <button key={r.path} className="flex h-8 items-center gap-2 rounded px-2 text-left hover:bg-surface-container-high">
              <Icon name="chevron-right" size={12} className="text-outline" />
              <span className="flex-1 truncate font-sans text-[13px] text-on-surface-variant">{r.path}</span>
              <span className="font-sans text-[12px] text-outline">{r.runs} runs</span>
            </button>
          ))}
          <button className="flex h-8 items-center gap-2 rounded px-2 text-left font-body text-[13px] text-primary hover:bg-surface-container-high">
            <Icon name="plus" size={12} /> Open another folder…
          </button>
        </div>
        <div className="mt-3">
          <Checkbox label="Open at login" />
        </div>
      </Card>

      {/* Card 5 — Plan */}
      <Card>
        <CardHeader title="Plan" />
        <div className="flex items-center justify-between">
          <div>
            <div className="font-body text-[14px] text-on-surface">Pro · $20/month</div>
            <div className="font-body text-[12px] text-on-surface-variant">Renews October 5, 2026</div>
          </div>
          <Button variant="secondary" size="sm">Manage billing</Button>
        </div>
        <div className="label-caps mb-1 mt-4 text-outline">Usage this month</div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-high">
          <div className="h-full rounded-full bg-primary" style={{ width: "4.2%" }} />
        </div>
        <div className="mt-1 text-right font-sans text-[12px] tabular-nums text-on-surface-variant">2.1 GB / 50 GB</div>
      </Card>

      {/* Sign out */}
      <Card className="p-2">
        <Button variant="ghost" size="md" className="w-full hover:!text-error">Sign out</Button>
      </Card>
    </div>
  );
}
