import { Icon } from "../ui/Icon"
import { StatusDot } from "../ui/primitives"
import {
  ROLE_META,
  THREAD_STATE_META,
  type Thread,
} from "../../data/agents"

const BANDS: { key: Thread["band"]; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "awaiting_review", label: "Awaiting review" },
  { key: "closed", label: "Closed" },
]

function ThreadCard({ t, onOpen }: { t: Thread; onOpen: () => void }) {
  const meta = THREAD_STATE_META[t.state]
  const role = ROLE_META[t.role]

  return (
    <button
      onClick={onOpen}
      className="flex w-full flex-col gap-1.5 rounded-lg border border-outline-variant bg-surface-container-low p-3 text-left transition-colors hover:border-outline hover:bg-surface-container"
    >
      <div className="flex items-center gap-2">
        <span className="text-[15px] leading-none">{role.glyph}</span>
        <span className="flex-1 truncate font-body text-[13px] font-medium text-on-surface">
          {t.title}
        </span>
        <span className="shrink-0 font-sans text-[11px] text-outline">
          {t.role} · {t.time}
        </span>
      </div>
      <p className="font-body text-[12px] leading-[17px] text-on-surface-variant">
        {t.summary}
      </p>
      <div className="flex items-center gap-2">
        <StatusDot token={meta.token} pulse={meta.pulse} size={7} />
        <span className="font-sans text-[12px] text-on-surface-variant">
          {meta.label}
        </span>
        {t.system && (
          <span className="rounded bg-outline/15 px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-wide text-outline">
            System
          </span>
        )}
        <span className="ml-auto font-sans text-[11px] text-outline">
          {t.detail}
        </span>
      </div>
    </button>
  )
}

function SectionBand({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="label-caps text-on-surface-variant">{label}</span>
      <span className="font-sans text-[11px] text-outline">({count})</span>
      <span className="h-px flex-1 bg-outline-variant/50" />
    </div>
  )
}

export function WorkflowInbox({
  threads,
  onOpen,
}: {
  threads: Thread[]
  onOpen: (t: Thread) => void
}) {
  return (
    <div className="flex flex-col gap-5">
      {BANDS.map((band) => {
        const rows = threads.filter((t) => t.band === band.key)
        if (!rows.length) return null
        return (
          <section key={band.key} className="flex flex-col gap-2">
            <SectionBand label={band.label} count={rows.length} />
            {rows.map((t) => (
              <ThreadCard key={t.id} t={t} onOpen={() => onOpen(t)} />
            ))}
          </section>
        )
      })}
    </div>
  )
}
