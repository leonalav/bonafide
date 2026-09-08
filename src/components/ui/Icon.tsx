import type { SVGProps } from "react";

// Minimal inline icon set (Lucide-style geometry) so we carry no icon dependency.
const PATHS: Record<string, string> = {
  "folder-tree":
    "M3 3v5h5 M3 8l3-3h4l2 2h6a1 1 0 0 1 1 1v3 M3 12v5h5 M3 16l3-3h4l2 2h6a1 1 0 0 1 1 1v3",
  "flask-conical": "M10 2v7.5L4.2 18.4A2 2 0 0 0 5.9 21.5h12.2a2 2 0 0 0 1.7-3.1L14 9.5V2 M8.5 2h7 M7 15h10",
  "line-chart": "M3 3v18h18 M7 15l4-4 3 3 5-6",
  package:
    "M12 2 3 7v10l9 5 9-5V7L12 2 M3 7l9 5 9-5 M12 12v10",
  "git-branch": "M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M18 9a9 9 0 0 1-9 9",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M21 21l-4.3-4.3",
  puzzle:
    "M14 3a2 2 0 0 0-4 0v2H7a1 1 0 0 0-1 1v3H4a2 2 0 1 0 0 4h2v3a1 1 0 0 0 1 1h3v2a2 2 0 1 0 4 0v-2h3a1 1 0 0 0 1-1v-3h2a2 2 0 1 0 0-4h-2V6a1 1 0 0 0-1-1h-3z",
  "user-circle": "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7 M6 19a6 6 0 0 1 12 0",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 7 2.6h.1A1.6 1.6 0 0 0 9 1.1V1a2 2 0 1 1 4 0v.1A1.6 1.6 0 0 0 17 2.6a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.1a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.4 1.6z",
  "chevron-right": "M9 6l6 6-6 6",
  "chevron-down": "M6 9l6 6 6-6",
  "chevron-up": "M6 15l6-6 6 6",
  "chevron-left": "M15 6l-6 6 6 6",
  x: "M18 6 6 18 M6 6l12 12",
  plus: "M12 5v14 M5 12h14",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  "file-plus": "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M12 12v6 M9 15h6",
  "folder-plus": "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M12 10v6 M9 13h6",
  collapse: "M7 20l5-5 5 5 M7 4l5 5 5-5",
  python: "M12 3c-3 0-3 2-3 2v2h6v1H6s-3 0-3 4 3 4 3 4h2v-2s0-3 3-3h4s3 0 3-3V5s0-2-4-2z M9 5.5h.01 M15 18.5h.01",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6",
  "file-code": "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13l-2 2 2 2 M14 13l2 2-2 2",
  layers: "M12 2 2 7l10 5 10-5z M2 12l10 5 10-5 M2 17l10 5 10-5",
  archive: "M3 4h18v4H3z M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8 M9 12h6",
  "corner-down-right": "M4 4v7a4 4 0 0 0 4 4h12 M16 11l4 4-4 4",
  keyboard: "M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1 M7 10h.01 M11 10h.01 M15 10h.01 M8 14h8",
  palette: "M12 2a10 10 0 1 0 0 20 2 2 0 0 0 2-2 2 2 0 0 0-.5-1.3 2 2 0 0 1 1.3-3.4H17a5 5 0 0 0 5-5c0-4.9-4.5-8.7-10-8.7 M7.5 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2 M12 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2 M16.5 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2",
  pin: "M12 17v5 M9 3h6l-1 7 3 3H7l3-3z",
  "log-out": "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9",
  "hard-drive": "M22 12H2 M5.5 5h13l3.5 7v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6z M6 16h.01 M10 16h.01",
  "alert-triangle": "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z M12 9v4 M12 17h.01",
  edit: "M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  download: "M12 3v12 M7 11l5 5 5-5 M5 21h14",
  "external-link": "M15 3h6v6 M10 14 21 3 M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5",
  box: "M12 2 3 7v10l9 5 9-5V7L12 2 M3 7l9 5 9-5 M12 12v10",
  database: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3 M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  image: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3 M21 16l-5-5L5 21",
  bell: "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9 M13.7 21a2 2 0 0 1-3.4 0",
  check: "M20 6 9 17l-5-5",
  "more-horizontal": "M5 12h.01 M12 12h.01 M19 12h.01",
  "more-vertical": "M12 5h.01 M12 12h.01 M12 19h.01",
  filter: "M4 4h16l-6 8v6l-4 2v-8z",
  "arrow-up": "M12 19V5 M6 11l6-6 6 6",
  "arrow-down": "M12 5v14 M6 13l6 6 6-6",
  minimize: "M6 12h12",
  square: "M4 4h16v16H4z",
  "square-minus": "M4 4h16v16H4z M8 12h8",
  "panel-right": "M4 4h16v16H4z M14 4v16",
  refresh: "M21 12a9 9 0 1 1-3-6.7 M21 3v5h-5",
  diamond: "M12 2 22 12 12 22 2 12z",
  "arrow-right-left": "M8 3 4 7l4 4 M4 7h16 M16 21l4-4-4-4 M20 17H4",
  "preview-side": "M3 4h18v16H3z M12 4v16 M15 9h3 M15 13h3",
  "split-square": "M3 4h18v16H3z M12 4v16",
  paperclip: "M21.4 11 12.2 20.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.9-2.9l8.5-8.5",
  send: "M22 2 11 13 M22 2 15 22 11 13 2 9z",
  zap: "M13 2 3 14h7l-1 8 10-12h-7z",
  flag: "M4 21V4 M4 4h13l-2 4 2 4H4",
  circle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18",
  lock: "M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z M8 11V7a4 4 0 0 1 8 0v4",
  "stop-circle": "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18 M9 9h6v6H9z",
  git: "M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M18 9a9 9 0 0 1-9 9",
  copy: "M9 5h11a2 2 0 0 1 2 2v11 M5 9V5a2 2 0 0 1 2-2h11 M5 9h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z",
  clipboard: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M9 4h6a2 2 0 0 1 2 2H7a2 2 0 0 1 2-2z",
  "trash-2": "M3 6h18 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M10 11v6 M14 11v6",
  "edit-2": "M17 3a2.8 2.8 0 1 1 4 4L7 21H3v-4z",
  terminal: "M4 17l6-6-6-6 M12 19h8",
  type: "M4 7V4h16v3 M9 20h6 M12 4v16",
  "arrow-left": "M19 12H5 M12 19l-7-7 7-7",
  "arrow-right": "M5 12h14 M12 5l7 7-7 7",
  undo: "M3 7v6h6 M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13",
  "chevrons-left": "M11 17l-5-5 5-5 M18 17l-5-5 5-5",
  "chevrons-right": "M6 17l5-5-5-5 M13 17l5-5-5-5",
  scissors: "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M20 4 8.12 15.88 M14.47 14.48 20 20 M8.12 8.12 12 12",
  "message-square": "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  "eye": "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7 M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
  corner: "M4 4h6 M4 4v6 M20 20h-6 M20 20v-6",
  "list-ordered": "M10 6h11 M10 12h11 M10 18h11 M4 6h1v4 M4 10h2 M6 18H4c0-1 2-2 2-3s-1-1.5-2-1",
  "replace": "M14 4h6v6 M16 14l-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M14 20h6v-6",
  "search-code": "M11 4a7 7 0 1 0 4.95 11.95 M21 21l-4.3-4.3 M9 10l2 2 4-4",
};

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.75,
  ...props
}: { name: string; size?: number; strokeWidth?: number } & SVGProps<SVGSVGElement>) {
  const d = PATHS[name] ?? "";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {d.split(" M").map((seg, i) => (
        <path key={i} d={(i === 0 ? seg : "M" + seg)} />
      ))}
    </svg>
  );
}
