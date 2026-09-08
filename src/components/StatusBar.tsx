import { Icon } from "./ui/Icon";

export function StatusBar({ workspaceName }: { workspaceName: string | null }) {
  return (
    <div className="flex h-6 shrink-0 items-center border-t border-outline-variant bg-surface-container-low px-3 font-sans text-[12px] text-on-surface-variant">
      {/* left: workspace */}
      <div className="flex items-center gap-2">
        {workspaceName ? (
          <>
            <Icon name="folder-open" size={12} className="text-secondary" />
            <span>{workspaceName}</span>
          </>
        ) : (
          <span className="text-outline">No folder open</span>
        )}
      </div>

      <div className="mx-3 h-3 w-px bg-outline-variant" />

      {/* center: status */}
      <div className="flex items-center gap-3">
        <span className="text-outline">Ready</span>
      </div>

      <div className="flex-1" />

      {/* right: version */}
      <div className="flex items-center gap-3">
        <span className="text-outline">Bonafide v1.0</span>
      </div>
    </div>
  );
}
