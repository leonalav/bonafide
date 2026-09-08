/**
 * monaco-theme.ts — define a Bonafide-branded Monaco theme.
 *
 * Mirrors the Material 3 dark palette declared in `src/index.css` so the
 * editor chrome, gutter, selection, and syntax tokens feel like part of
 * the same surface as the rest of the app — not a foreign blue blob.
 *
 * The theme id is `bonafide-dark`. Callers pass it via the `theme` prop
 * on `<Editor />`.
 */

import type { editor } from "monaco-editor";

export const BONAFIDE_THEME_NAME = "bonafide-dark";

/**
 * Palette mirrors the CSS custom properties under @theme in index.css.
 * Keeping the literal values here (instead of reading CSS vars at runtime)
 * is intentional — Monaco's `defineTheme` takes resolved color strings,
 * and resolving CSS vars from JavaScript would require a getComputedStyle
 * round-trip with no real benefit.
 */
const PALETTE = {
  // Surfaces
  surface: "#111318",
  surfaceContainerLowest: "#0c0e13",
  surfaceContainerLow: "#191c20",
  surfaceContainer: "#1e2024",
  surfaceContainerHigh: "#282a2f",
  // Content
  onSurface: "#e2e2e9",
  onSurfaceVariant: "#c3c6d2",
  outline: "#8d919c",
  outlineVariant: "#424751",
  // Brand
  primary: "#aac7ff",
  onPrimary: "#002f64",
  secondary: "#bfc7d4",
  tertiary: "#ffb77a",
  error: "#ffb4ab",
  // Misc
  selection: "#2b5ea7",
  cursor: "#e2e2e9",
} as const;

export const bonafideDarkTheme: editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [
    // Comments — outline, italic
    { token: "comment", foreground: PALETTE.outline, fontStyle: "italic" },
    { token: "comment.line", foreground: PALETTE.outline, fontStyle: "italic" },
    { token: "comment.block", foreground: PALETTE.outline, fontStyle: "italic" },
    { token: "comment.doc", foreground: PALETTE.outline, fontStyle: "italic" },
    { token: "comment.documentation", foreground: PALETTE.outline, fontStyle: "italic" },

    // Keywords, types, built-ins — tertiary (amber)
    { token: "keyword", foreground: PALETTE.tertiary },
    { token: "keyword.control", foreground: PALETTE.tertiary },
    { token: "keyword.other", foreground: PALETTE.tertiary },
    { token: "keyword.operator", foreground: PALETTE.tertiary },
    { token: "storage", foreground: PALETTE.tertiary },
    { token: "storage.type", foreground: PALETTE.tertiary },
    { token: "storage.modifier", foreground: PALETTE.tertiary },
    { token: "support.type", foreground: PALETTE.tertiary },
    { token: "support.class", foreground: PALETTE.tertiary },
    { token: "support.type.primitive", foreground: PALETTE.tertiary },
    { token: "type", foreground: PALETTE.tertiary },
    { token: "type.identifier", foreground: PALETTE.tertiary },

    // Strings — primary (blue)
    { token: "string", foreground: PALETTE.primary },
    { token: "string.quoted", foreground: PALETTE.primary },
    { token: "string.template", foreground: PALETTE.primary },
    { token: "string.regexp", foreground: PALETTE.primary },

    // Numbers, literals, booleans — tertiary (amber)
    { token: "number", foreground: PALETTE.tertiary },
    { token: "number.float", foreground: PALETTE.tertiary },
    { token: "number.hex", foreground: PALETTE.tertiary },
    { token: "constant", foreground: PALETTE.tertiary },
    { token: "constant.language", foreground: PALETTE.tertiary },
    { token: "constant.numeric", foreground: PALETTE.tertiary },
    { token: "constant.character", foreground: PALETTE.tertiary },
    { token: "constant.escape", foreground: PALETTE.tertiary },

    // Functions, methods — secondary (cool gray)
    { token: "entity.name.function", foreground: PALETTE.secondary },
    { token: "support.function", foreground: PALETTE.secondary },
    { token: "meta.function-call", foreground: PALETTE.secondary },
    { token: "variable.function", foreground: PALETTE.secondary },

    // Variables, parameters, identifiers — on-surface
    { token: "variable", foreground: PALETTE.onSurface },
    { token: "variable.parameter", foreground: PALETTE.onSurface },
    { token: "variable.other", foreground: PALETTE.onSurface },
    { token: "variable.readwrite", foreground: PALETTE.onSurface },
    { token: "identifier", foreground: PALETTE.onSurface },
    { token: "entity.name", foreground: PALETTE.onSurface },

    // Properties, attributes — secondary
    { token: "entity.other.attribute-name", foreground: PALETTE.secondary },
    { token: "variable.other.property", foreground: PALETTE.secondary },
    { token: "variable.other.object.property", foreground: PALETTE.secondary },
    { token: "support.type.property-name", foreground: PALETTE.secondary },
    { token: "meta.object-literal.key", foreground: PALETTE.secondary },
    { token: "meta.property-name", foreground: PALETTE.secondary },

    // Tags (HTML/XML/JSX) — outline-variant by default; keys primary
    { token: "tag", foreground: PALETTE.outlineVariant },
    { token: "metatag", foreground: PALETTE.outline },
    { token: "delimiter", foreground: PALETTE.onSurfaceVariant },
    { token: "delimiter.html", foreground: PALETTE.onSurfaceVariant },
    { token: "delimiter.xml", foreground: PALETTE.onSurfaceVariant },

    // Operators / punctuation — on-surface-variant
    { token: "keyword.operator", foreground: PALETTE.onSurfaceVariant },
    { token: "punctuation", foreground: PALETTE.onSurfaceVariant },
    { token: "punctuation.definition", foreground: PALETTE.onSurfaceVariant },
    { token: "punctuation.separator", foreground: PALETTE.onSurfaceVariant },
    { token: "meta.brace", foreground: PALETTE.onSurfaceVariant },
    { token: "meta.bracket", foreground: PALETTE.onSurfaceVariant },

    // Markdown / prose
    { token: "emphasis", fontStyle: "italic" },
    { token: "strong", fontStyle: "bold" },
    { token: "markup.heading", foreground: PALETTE.onSurface, fontStyle: "bold" },
    { token: "markup.inline.raw", foreground: PALETTE.primary },
    { token: "markup.quote", foreground: PALETTE.outline, fontStyle: "italic" },

    // JSON keys
    { token: "support.type.property-name.json", foreground: PALETTE.secondary },

    // Errors / warnings
    { token: "invalid", foreground: PALETTE.error },
    { token: "invalid.illegal", foreground: PALETTE.error },
  ],
  colors: {
    // Editor chrome — surfaces
    "editor.background": PALETTE.surface,
    "editor.foreground": PALETTE.onSurface,
    "editor.lineHighlightBackground": PALETTE.surfaceContainerLow,
    "editor.lineHighlightBorder": PALETTE.surfaceContainerLow,
    "editorLineNumber.foreground": PALETTE.outline,
    "editorLineNumber.activeForeground": PALETTE.onSurfaceVariant,
    "editorCursor.foreground": PALETTE.cursor,
    "editor.selectionBackground": PALETTE.selection,
    "editor.selectionHighlightBackground": "#2b5ea766",
    "editor.wordHighlightBackground": "#aac7ff22",
    "editor.wordHighlightStrongBackground": "#aac7ff33",
    "editor.findMatchBackground": "#ffb77a55",
    "editor.findMatchHighlightBackground": "#ffb77a33",
    "editor.indentGuide.background": PALETTE.outlineVariant,
    "editor.indentGuide.activeBackground": PALETTE.outline,
    "editorWhitespace.foreground": PALETTE.outlineVariant,
    "editorRuler.foreground": PALETTE.outlineVariant,

    // Gutter
    "editorGutter.background": PALETTE.surface,
    "editorGutter.modifiedBackground": PALETTE.tertiary,
    "editorGutter.addedBackground": PALETTE.primary,
    "editorGutter.deletedBackground": PALETTE.error,

    // Scrollbars
    "scrollbar.shadow": "#00000000",
    "scrollbarSlider.background": "#424751aa",
    "scrollbarSlider.hoverBackground": "#8d919caa",
    "scrollbarSlider.activeBackground": "#8d919caa",

    // Widgets (find/replace, suggest, hover)
    "editorWidget.background": PALETTE.surfaceContainerHigh,
    "editorWidget.border": PALETTE.outlineVariant,
    "editorSuggestWidget.background": PALETTE.surfaceContainerHigh,
    "editorSuggestWidget.border": PALETTE.outlineVariant,
    "editorSuggestWidget.selectedBackground": PALETTE.surfaceContainer,
    "editorSuggestWidget.highlightForeground": PALETTE.primary,
    "editorHoverWidget.background": PALETTE.surfaceContainerHigh,
    "editorHoverWidget.border": PALETTE.outlineVariant,

    // Minimap
    "minimap.background": PALETTE.surface,
    "minimap.selectionHighlight": PALETTE.selection,
    "minimap.findMatchHighlight": PALETTE.tertiary,

    // Bracket matching
    "editorBracketMatch.background": "#aac7ff22",
    "editorBracketMatch.border": PALETTE.primary,

    // Overview ruler (right gutter markers)
    "editorOverviewRuler.background": PALETTE.surface,
    "editorOverviewRuler.border": PALETTE.outlineVariant,

    // Diff / in-editor diagnostics gutter
    "editorError.foreground": PALETTE.error,
    "editorWarning.foreground": PALETTE.tertiary,
    "editorInfo.foreground": PALETTE.primary,
  },
};

/**
 * Register the theme on a Monaco instance. Idempotent — calling it more
 * than once on the same instance is safe because Monaco overwrites
 * existing themes with the same name.
 */
export function registerBonafideTheme(monaco: typeof import("monaco-editor")): void {
  monaco.editor.defineTheme(BONAFIDE_THEME_NAME, bonafideDarkTheme);
}
