import { Icon } from "../ui/Icon";
import { Button, StatusDot } from "../ui/primitives";
import { Card, CardHeader, Checkbox } from "../ui/controls";

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

export function AccountSection({ onManageTracker }: { onManageTracker: () => void }) {
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
