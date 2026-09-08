import type { ReactNode } from "react";
import { Icon } from "../ui/Icon";

// Shared 36px panel header — label-caps title, right-aligned icon actions.
export function PanelHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-outline-variant px-3">
      <span className="label-caps text-on-surface-variant">{title}</span>
      <div className="flex items-center gap-2 text-outline">{right}</div>
    </div>
  );
}

export function PanelSearch({ placeholder }: { placeholder: string }) {
  return (
    <div className="flex h-8 items-center gap-2 rounded border border-outline-variant bg-surface px-2 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30">
      <Icon name="search" size={13} className="text-outline" />
      <input
        className="w-full bg-transparent font-body text-[13px] text-on-surface placeholder:text-outline focus:outline-none"
        placeholder={placeholder}
      />
    </div>
  );
}

// Small pill-style select stand-in used across filter rows.
export function FilterSelect({ label, icon = "chevron-down", onClick }: { label: string; icon?: string; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex h-6 items-center gap-1 rounded border border-outline-variant px-2 font-sans text-[12px] text-on-surface-variant hover:border-outline hover:text-on-surface"
    >
      {label}
      <Icon name={icon} size={11} />
    </button>
  );
}
