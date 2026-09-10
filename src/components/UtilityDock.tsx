import { Icon } from "./ui/Icon";

export type DockId =
  | "explorer"
  | "runs"
  | "experiments"
  | "artifacts"
  | "git"
  | "search"
  | "extensions"
  | "workflow"
  | "account"
  | "settings"
  | "models";

const PRIMARY: { id: DockId; icon: string; label: string; shortcut: string }[] = [
  { id: "explorer", icon: "folder-tree", label: "Explorer", shortcut: "⌘1" },
  { id: "runs", icon: "flask-conical", label: "Runs", shortcut: "⌘2" },
  { id: "experiments", icon: "line-chart", label: "Experiments", shortcut: "⌘3" },
  { id: "artifacts", icon: "package", label: "Artifacts", shortcut: "⌘4" },
  { id: "git", icon: "git-branch", label: "Git", shortcut: "⌘5" },
  { id: "search", icon: "search", label: "Search", shortcut: "⌘6" },
  { id: "extensions", icon: "puzzle", label: "Extensions", shortcut: "⌘7" },
];

const BOTTOM: { id: DockId; icon: string; label: string; shortcut: string }[] = [
  { id: "workflow", icon: "arrow-right-left", label: "Workflow", shortcut: "⌘K" },
  { id: "account", icon: "user-circle", label: "Account", shortcut: "" },
  { id: "settings", icon: "settings", label: "Settings", shortcut: "⌘," },
  { id: "models", icon: "brain", label: "Models", shortcut: "" },
];

function DockButton({
  item,
  active,
  signedIn,
  onClick,
}: {
  item: { id: DockId; icon: string; label: string; shortcut: string };
  active: boolean;
  signedIn?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={`${item.label}${item.shortcut ? `  ${item.shortcut}` : ""}`}
      aria-label={item.label}
      aria-current={active}
      className={`group relative flex h-12 w-12 items-center justify-center transition-colors duration-[120ms] ${
        active ? "bg-surface-container text-on-surface" : "text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
      }`}
    >
      {active && <span className="absolute left-0 top-0 h-full w-0.5 bg-primary" />}
      <Icon name={item.icon} size={20} strokeWidth={1.6} />
      {item.id === "account" && signedIn && (
        <span className="absolute right-2.5 top-2.5 h-1.5 w-1.5 rounded-full bg-primary" />
      )}
    </button>
  );
}

export function UtilityDock({
  active,
  onSelect,
  signedIn,
}: {
  active: DockId;
  onSelect: (id: DockId) => void;
  signedIn: boolean;
}) {
  return (
    <nav className="flex w-12 shrink-0 flex-col border-r border-outline-variant bg-surface-container-low">
      {PRIMARY.map((item) => (
        <DockButton key={item.id} item={item} active={active === item.id} onClick={() => onSelect(item.id)} />
      ))}
      <div className="flex-1" />
      {BOTTOM.map((item) => (
        <DockButton
          key={item.id}
          item={item}
          active={active === item.id}
          signedIn={signedIn}
          onClick={() => onSelect(item.id)}
        />
      ))}
    </nav>
  );
}
