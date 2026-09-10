import { useState, type ReactNode } from "react";
import { Icon } from "./Icon";

// Label ............ control row used inside preference cards.
// `block` stacks the label above the control so the control can use the full row width.
export function Field({
  label,
  block = false,
  children,
}: {
  label: string;
  block?: boolean;
  children: ReactNode;
}) {
  if (block) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="font-body text-[13px] text-on-surface-variant">{label}</span>
        <div className="flex w-full items-center gap-2">{children}</div>
      </div>
    );
  }
  return (
    <div className="flex min-h-7 items-center justify-between gap-4">
      <span className="font-body text-[13px] text-on-surface-variant">{label}</span>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function Checkbox({
  label,
  description,
  defaultChecked = false,
}: {
  label: ReactNode;
  description?: string;
  defaultChecked?: boolean;
}) {
  const [on, setOn] = useState(defaultChecked);
  return (
    <label className="flex cursor-pointer items-start gap-2 py-0.5">
      <button
        type="button"
        role="checkbox"
        aria-checked={on}
        onClick={() => setOn((v) => !v)}
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition-colors ${
          on ? "border-primary bg-primary text-on-primary" : "border-outline bg-transparent"
        }`}
      >
        {on && <Icon name="check" size={11} strokeWidth={2.5} />}
      </button>
      <span className="min-w-0">
        <span className="block font-body text-[13px] text-on-surface">{label}</span>
        {description && <span className="mt-0.5 block font-body text-[12px] leading-4 text-on-surface-variant">{description}</span>}
      </span>
    </label>
  );
}

// Single-select segmented / radio group. Renders inline options.
export function RadioGroup({
  options,
  value,
  onChange,
  variant = "radio",
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  variant?: "radio" | "segmented";
}) {
  if (variant === "segmented") {
    return (
      <div className="inline-flex overflow-hidden rounded border border-outline-variant">
        {options.map((o, i) => (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`h-7 px-3 font-sans text-[12px] transition-colors ${i > 0 ? "border-l border-outline-variant" : ""} ${
              value === o.value ? "bg-primary text-on-primary" : "bg-transparent text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-4">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} className="flex items-center gap-1.5 font-body text-[13px] text-on-surface-variant hover:text-on-surface">
          <span className={`flex h-4 w-4 items-center justify-center rounded-full border ${value === o.value ? "border-primary" : "border-outline"}`}>
            {value === o.value && <span className="h-2 w-2 rounded-full bg-primary" />}
          </span>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  min,
  max,
  defaultValue,
  suffix,
}: {
  min: number;
  max: number;
  defaultValue: number;
  suffix?: string;
}) {
  const [v, setV] = useState(defaultValue);
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        value={v}
        onChange={(e) => setV(Number(e.target.value))}
        className="w-32 accent-[var(--color-primary)]"
      />
      <span className="w-8 text-right font-sans text-[13px] tabular-nums text-on-surface">
        {v}
        {suffix}
      </span>
    </div>
  );
}

// Card section header (label-caps) with optional right slot.
export function CardHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <span className="label-caps text-on-surface-variant">{title}</span>
      {right}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-outline-variant bg-surface-container p-4 ${className}`}>{children}</div>;
}
