import { useState } from "react"
import { Icon } from "../ui/Icon"
import { Button } from "../ui/primitives"
import type { Confidence, Investigation } from "../../data/agents"

const CONF_TONE: Record<Confidence, string> = {
  Low: "text-outline",
  Medium: "text-tertiary",
  High: "text-primary",
}

function Region({
  label,
  right,
  children,
}: {
  label: string
  right?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="label-caps text-on-surface-variant">{label}</span>
        {right}
      </div>
      {children}
    </section>
  )
}

export function ProposalView({
  data,
  editableGoal = true,
}: {
  data: Investigation
  editableGoal?: boolean
}) {
  const [traceOpen, setTraceOpen] = useState(false)
  const [expanded, setExpanded] = useState<Record<number, boolean>>({ 0: true })
  const shown = traceOpen ? data.trace : data.trace.slice(0, 4)

  return (
    <div className="flex flex-col gap-6">
      {/* Goal */}
      <Region label="Goal (auto-detected, editable)">
        <textarea
          defaultValue={data.goal}
          readOnly={!editableGoal}
          rows={2}
          className="w-full resize-none rounded border border-outline-variant bg-surface px-3 py-2 font-body text-[13px] leading-[19px] text-on-surface focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/25"
        />
      </Region>

      {/* Reasoning trace */}
      <Region
        label="Actions"
        right={
          <button
            onClick={() => setTraceOpen((v) => !v)}
            className="font-sans text-[11px] text-outline hover:text-on-surface"
          >
            {traceOpen ? "collapse" : `${data.trace.length} tool calls`}
          </button>
        }
      >
        <div className="overflow-hidden rounded border border-outline-variant bg-surface">
          {shown.map((s, i) => {
            const open = !!expanded[i]
            return (
              <div
                key={i}
                className="border-b border-outline-variant/50 last:border-b-0"
              >
                <button
                  onClick={() => setExpanded((e) => ({ ...e, [i]: !e[i] }))}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-surface-container/50"
                >
                  <Icon
                    name={open ? "chevron-down" : "chevron-right"}
                    size={12}
                    className="text-outline"
                  />
                  <span className="flex-1 truncate font-sans text-[12px] text-on-surface">
                    <span className="text-primary">{s.tool}</span>
                    <span className="text-on-surface-variant">({s.args})</span>
                  </span>
                  <span className="shrink-0 font-sans text-[11px] text-outline">
                    {s.time}
                  </span>
                </button>
                {open && s.result && (
                  <div className="border-t border-outline-variant/40 bg-surface-container/40 px-3 py-1.5 pl-7 font-sans text-[12px] text-on-surface-variant">
                    {s.result}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </Region>

      {/* Hypothesis */}
      <Region label="Hypothesis">
        <div className="flex flex-col gap-3 rounded border border-outline-variant bg-surface-container-low p-3">
          <div className="flex gap-2">
            <Icon
              name="flag"
              size={15}
              className="mt-0.5 shrink-0 text-tertiary"
            />
            <p className="font-body text-[13px] leading-[19px] text-on-surface">
              <span className="font-medium text-tertiary">
                {data.hypothesis.verdict}:
              </span>{" "}
              {data.hypothesis.statement}
            </p>
          </div>
          <div>
            <div className="label-caps mb-1 text-outline">Evidence cited</div>
            <div className="flex flex-col gap-1">
              {data.hypothesis.evidence.map((e, i) => (
                <button
                  key={i}
                  className="group flex items-center gap-1.5 text-left font-sans text-[12px] text-on-surface-variant hover:text-primary"
                >
                  <span className="text-outline group-hover:text-primary">
                    •
                  </span>
                  <span className="flex-1">{e.text}</span>
                  {e.jump && (
                    <Icon
                      name="corner-down-right"
                      size={12}
                      className="text-outline group-hover:text-primary"
                    />
                  )}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-outline-variant/50 pt-2 font-sans text-[12px]">
            <span className="text-on-surface-variant">
              Confidence{" "}
              <span
                className={`font-medium ${CONF_TONE[data.hypothesis.confidence]}`}
              >
                {data.hypothesis.confidence}
              </span>
            </span>
            {data.hypothesis.ruledOut && (
              <span className="text-outline">
                Ruled out: {data.hypothesis.ruledOut}
              </span>
            )}
          </div>
        </div>
      </Region>

      {/* Proposed patch */}
      <Region label="Proposed patch">
        <div className="overflow-hidden rounded border border-outline-variant">
          <div className="font-sans text-[13px] leading-[22px]">
            {data.patch.lines.map((l, i) => (
              <div
                key={i}
                className={`flex whitespace-pre ${
                  l.sign === "+"
                    ? "bg-primary/10 text-primary"
                    : l.sign === "-"
                      ? "bg-error/10 text-error"
                      : "text-on-surface-variant"
                }`}
              >
                <span
                  className={`w-6 shrink-0 text-center ${
                    l.sign === "+"
                      ? "text-primary"
                      : l.sign === "-"
                        ? "text-error"
                        : "text-outline"
                  }`}
                >
                  {l.sign === " " ? "" : l.sign}
                </span>
                <span className="pr-2">{l.text}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-outline-variant bg-surface-container px-2 py-1 font-sans text-[11px] text-outline">
            {data.patch.summary} · {data.patch.file}
          </div>
        </div>
      </Region>

      {/* Verification */}
      {data.verification.status !== "none" && (
        <Region label="Verification report">
          <div
            className={`rounded border p-3 ${
              data.verification.status === "success"
                ? "border-primary/30 bg-primary/5"
                : data.verification.status === "failed"
                  ? "border-error/30 bg-error/5"
                  : "border-outline-variant bg-surface-container-low"
            }`}
          >
            <div className="mb-1 flex items-center gap-2 font-sans text-[13px]">
              {data.verification.status === "running" ? (
                <Icon
                  name="refresh"
                  size={14}
                  className="animate-sync-spin text-tertiary"
                />
              ) : (
                <Icon
                  name={data.verification.status === "success" ? "check" : "x"}
                  size={14}
                  className={
                    data.verification.status === "success"
                      ? "text-primary"
                      : "text-error"
                  }
                />
              )}
              <span className="font-medium text-on-surface">
                {data.verification.lines[0]}
              </span>
            </div>
            {data.verification.lines.slice(1).map((l, i) => (
              <p
                key={i}
                className="pl-6 font-sans text-[12px] text-on-surface-variant"
              >
                {l}
              </p>
            ))}
            {data.verification.upgrade && (
              <p className="pl-6 font-sans text-[12px] text-primary">
                Confidence upgraded: {data.verification.upgrade}
              </p>
            )}
          </div>
        </Region>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-1.5 border-t border-outline-variant pt-4">
        <Button
          variant="ghost"
          size="sm"
          className="whitespace-nowrap !text-error hover:bg-error/10"
        >
          Reject
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="whitespace-nowrap hover:!text-on-surface"
        >
          Request revision
        </Button>
        <Button size="sm" className="whitespace-nowrap">
          Approve &amp; apply
        </Button>
      </div>
    </div>
  )
}
