import { useState } from "react";
import { Icon } from "../ui/Icon";

// ── Port label map for common dev services ────────────────────────────────

const PORT_LABELS: Record<number, string> = {
  6006: "TensorBoard",
  8888: "Jupyter",
  5000: "Flask / MLflow",
  5001: "MLflow UI",
  8080: "HTTP",
  8265: "Ray Dashboard",
  9090: "Prometheus",
  9091: "Prometheus (remote)",
  4040: "Ray (Memory)",
  8266: "Ray (Redact)",
};

function getPortLabel(port: number): string {
  return PORT_LABELS[port] ?? `Port ${port}`;
}

// ── ForwardedPort shape ───────────────────────────────────────────────────

type ForwardedPort = {
  id: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  label: string;
  status: "active" | "error";
};

// ── Stub data ────────────────────────────────────────────────────────────

const STUB_PORTS: ForwardedPort[] = [
  { id: "p1", localPort: 16006, remoteHost: "training-cluster-01", remotePort: 6006, label: "TensorBoard", status: "active" },
  { id: "p2", localPort: 18888, remoteHost: "training-cluster-01", remotePort: 8888, label: "Jupyter", status: "active" },
];

// ── PortRow ──────────────────────────────────────────────────────────────

function PortRow({ port, onRemove }: { port: ForwardedPort; onRemove: (id: string) => void }) {
  const statusColor = port.status === "active" ? "bg-green-500" : "bg-red-500";

  return (
    <div className="group flex items-center gap-3 border-b border-outline-variant/40 px-3 py-2 transition-colors hover:bg-surface-container-high">
      {/* Status dot */}
      <span className={`h-2 w-2 shrink-0 rounded-full ${statusColor}`} />

      {/* Label */}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-sans text-[13px] font-medium text-on-surface">{port.label}</span>
        <span className="font-mono text-[11px] text-outline">
          {port.remoteHost}:{port.remotePort} → localhost:{port.localPort}
        </span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          className="flex h-6 w-6 items-center justify-center rounded text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface"
          title="Open in browser"
        >
          <Icon name="external-link" size={12} />
        </button>
        <button
          onClick={() => onRemove(port.id)}
          className="flex h-6 w-6 items-center justify-center rounded text-on-surface-variant hover:bg-red-950/40 hover:text-red-400"
          title="Stop forwarding"
        >
          <Icon name="x" size={12} />
        </button>
      </div>
    </div>
  );
}

// ── PortsTab ─────────────────────────────────────────────────────────────

export function PortsTab() {
  const [ports, setPorts] = useState<ForwardedPort[]>(STUB_PORTS);

  const handleRemove = (id: string) => {
    setPorts((prev) => prev.filter((p) => p.id !== id));
  };

  const handleAdd = () => {
    // TODO: wire up to SSH forwarder. For now, add a stub entry.
    const port: ForwardedPort = {
      id: `p${Date.now()}`,
      localPort: 18000 + Math.floor(Math.random() * 100),
      remoteHost: "training-cluster",
      remotePort: 8080,
      label: "New Forward",
      status: "error",
    };
    setPorts((prev) => [...prev, port]);
  };

  if (ports.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 font-sans text-[13px] text-outline">
        <div className="text-center">
          <Icon name="network" size={28} className="mx-auto mb-2" />
          <p>No forwarded ports</p>
          <p className="mt-1 text-[12px]">
            Forward ports from your training cluster to access services like TensorBoard and Jupyter.
          </p>
        </div>
        <button
          onClick={handleAdd}
          className="flex items-center gap-1.5 rounded bg-surface-container px-3 py-1.5 text-on-surface-variant hover:bg-surface-container-high"
        >
          <Icon name="plus" size={14} />
          Forward a Port
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-outline-variant/40 bg-surface-container-low px-3 py-1.5">
        <div className="flex items-center gap-2 font-sans text-[12px] text-outline">
          <span>{ports.length} forwarded port{ports.length !== 1 ? "s" : ""}</span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-green-500" />
            <span className="text-green-400">{ports.filter((p) => p.status === "active").length} active</span>
          </span>
        </div>
        <button
          onClick={handleAdd}
          className="flex items-center gap-1 rounded px-2 py-0.5 font-sans text-[12px] text-on-surface-variant hover:bg-surface-container-high"
        >
          <Icon name="plus" size={12} />
          Forward Port
        </button>
      </div>

      {/* Port list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {ports.map((port) => (
          <PortRow key={port.id} port={port} onRemove={handleRemove} />
        ))}
      </div>
    </div>
  );
}
