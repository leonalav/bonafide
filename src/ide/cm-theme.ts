/**
 * cm-theme.ts — Bonafide theme for CodeMirror 6.
 *
 * Mirrors the Material 3 dark palette declared in `src/index.css` so the
 * editor chrome, gutter, selection, syntax tokens, lint diagnostics, and
 * merge diffs all feel like part of the same surface as the rest of the
 * app — not a foreign blue blob.
 *
 * CodeMirror 6 themes are a list of `EditorView.theme({...})` style
 * declarations plus a set of `HighlightStyle.define([...])` rules for
 * syntax tokens. We register both as a single extension so callers can
 * pass `bonafideTheme` into the `<CodeMirror extensions={[...]} />` prop.
 *
 * Diagnostics + merge-view styles are appended at the bottom of the theme
 * block so they participate in the same dark palette without leaking into
 * other extensions.
 */

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

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
  // Diagnostic tones
  errorSurface: "rgba(255, 180, 171, 0.10)",
  warningSurface: "rgba(255, 183, 122, 0.10)",
  infoSurface: "rgba(170, 199, 255, 0.10)",
  hintSurface: "rgba(141, 145, 156, 0.10)",
  // Merge diff tones
  insertedSurface: "rgba(170, 199, 255, 0.18)",
  deletedSurface: "rgba(255, 180, 171, 0.18)",
  insertedLine: "rgba(170, 199, 255, 0.30)",
  deletedLine: "rgba(255, 180, 171, 0.30)",
  // Misc
  selection: "#2b5ea7",
  cursor: "#e2e2e9",
} as const;

const bonafideHighlight = HighlightStyle.define([
  // Comments — outline, italic
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: PALETTE.outline, fontStyle: "italic" },

  // Keywords, types, built-ins — tertiary (amber)
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier, t.definitionKeyword], color: PALETTE.tertiary },
  { tag: [t.typeName, t.className, t.namespace], color: PALETTE.tertiary },
  { tag: [t.atom, t.bool, t.number, t.null], color: PALETTE.tertiary },

  // Strings — primary (blue)
  { tag: [t.string, t.special(t.string)], color: PALETTE.primary },
  { tag: t.regexp, color: PALETTE.primary },

  // Functions, methods — secondary (cool gray)
  { tag: [t.function(t.definition(t.variableName)), t.function(t.variableName), t.macroName], color: PALETTE.secondary },
  { tag: [t.propertyName, t.attributeName], color: PALETTE.secondary },

  // Variables, identifiers — on-surface. Function parameter highlight is
  // done by CodeMirror's own parameter-highlight extension; we only
  // style the identifier itself.
  { tag: t.variableName, color: PALETTE.onSurface },

  // Tags (HTML/XML/JSX) — outline-variant by default
  { tag: [t.tagName, t.angleBracket], color: PALETTE.outlineVariant },
  { tag: t.meta, color: PALETTE.onSurfaceVariant },

  // Operators / punctuation — on-surface-variant
  { tag: [t.punctuation, t.bracket, t.operator], color: PALETTE.onSurfaceVariant },

  // Markdown
  { tag: t.heading, color: PALETTE.onSurface, fontWeight: "bold" },
  { tag: [t.emphasis, t.quote], color: PALETTE.outline, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.link, color: PALETTE.primary, textDecoration: "underline" },
  { tag: t.url, color: PALETTE.primary },

  // Invalid tokens — red
  { tag: t.invalid, color: PALETTE.error },
]);

const monospaceFamily =
  "'Manrope', ui-monospace, 'Cascadia Code', 'Fira Code', Menlo, Monaco, Consolas, monospace";

const bonafideEditorTheme = EditorView.theme(
  {
    "&": {
      color: PALETTE.onSurface,
      backgroundColor: PALETTE.surface,
      height: "100%",
      fontSize: "14px",
    },
    ".cm-content": {
      caretColor: PALETTE.cursor,
      fontFamily: monospaceFamily,
      fontSize: "14px",
      lineHeight: "22px",
    },
    ".cm-scroller": {
      fontFamily: monospaceFamily,
      lineHeight: "22px",
      // Hide CM's built-in scrollbar; Tauri WebView2 shows its own native one.
      scrollbarWidth: "none",
    },
    ".cm-scroller::-webkit-scrollbar": { display: "none" },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: PALETTE.cursor,
      borderLeftWidth: "2px",
    },
    ".cm-selectionBackground, ::selection": { backgroundColor: PALETTE.selection },
    "&.cm-focused .cm-selectionBackground": { backgroundColor: PALETTE.selection },
    // Active-line highlight: a subtle outline + a very faint band. The
    // previous solid `surfaceContainerLow` (#191c20) fill produced a
    // clearly visible band across the cursor line, which combined with
    // the editor wrapper's `bg-surface` (#111318) to create a noticeable
    // "shadow zone" over the upper code text. A subtle outline keeps the
    // line discoverable without dimming the surrounding text.
    ".cm-activeLine": {
      backgroundColor: "transparent",
      boxShadow: `inset 2px 0 0 0 ${PALETTE.primary}33`,
    },
    "&.cm-focused .cm-activeLine": {
      backgroundColor: "transparent",
      boxShadow: `inset 2px 0 0 0 ${PALETTE.primary}`,
    },
    ".cm-gutters": {
      backgroundColor: PALETTE.surface,
      color: PALETTE.outline,
      border: "none",
      borderRight: `1px solid ${PALETTE.outlineVariant}`,
    },
    ".cm-activeLineGutter": {
      backgroundColor: PALETTE.surface,
      color: PALETTE.onSurfaceVariant,
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "32px" },
    ".cm-indent-guide": { borderLeft: `1px solid ${PALETTE.outlineVariant}` },
    ".cm-indent-guide.active": { borderLeft: `1px solid ${PALETTE.outline}` },
    ".cm-tooltip, .cm-tooltip.cm-tooltip-autocomplete": {
      backgroundColor: PALETTE.surfaceContainerHigh,
      color: PALETTE.onSurface,
      border: `1px solid ${PALETTE.outlineVariant}`,
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: PALETTE.surfaceContainer,
      color: PALETTE.onSurface,
    },
    ".cm-panels": {
      backgroundColor: PALETTE.surfaceContainerHigh,
      color: PALETTE.onSurface,
    },
    ".cm-searchMatch": { backgroundColor: "#ffb77a55" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#ffb77a88" },
    ".cm-matchingBracket": { backgroundColor: "#aac7ff22", outline: `1px solid ${PALETTE.primary}` },
    ".cm-nonmatchingBracket": { color: PALETTE.error },

    // ── Diagnostics gutter + inline indicators ──────────────────────────
    // The lint gutter renders a small colored bar per diagnostic at the
    // start of the affected line. The hover triangle on hover is rendered
    // by the gutter decoration set; we style the glyph.
    ".cm-gutter-lint": {
      width: "8px",
    },
    ".cm-lintRange": {
      backgroundPosition: "left center",
      backgroundRepeat: "no-repeat",
      paddingBottom: "1px",
    },
    // Per-severity colors. The lint module's CSS classes are
    // `.cm-lintRange-error`, `.cm-lintRange-warning`, `.cm-lintRange-info`.
    ".cm-lintRange-error": {
      backgroundImage: `linear-gradient(to right, ${PALETTE.error} 0%, ${PALETTE.error} 30%, transparent 30%)`,
      borderBottom: `2px dotted ${PALETTE.error}`,
    },
    ".cm-lintRange-warning": {
      backgroundImage: `linear-gradient(to right, ${PALETTE.tertiary} 0%, ${PALETTE.tertiary} 30%, transparent 30%)`,
      borderBottom: `2px dotted ${PALETTE.tertiary}`,
    },
    ".cm-lintRange-info": {
      backgroundImage: `linear-gradient(to right, ${PALETTE.primary} 0%, ${PALETTE.primary} 30%, transparent 30%)`,
      borderBottom: `2px dotted ${PALETTE.primary}`,
    },
    ".cm-lintRange-hint": {
      backgroundImage: `linear-gradient(to right, ${PALETTE.outline} 0%, ${PALETTE.outline} 30%, transparent 30%)`,
    },
    ".cm-tooltip-lint": {
      backgroundColor: PALETTE.surfaceContainerHigh,
      color: PALETTE.onSurface,
      border: `1px solid ${PALETTE.outlineVariant}`,
      borderRadius: "6px",
      padding: "8px 10px",
      fontFamily: "'Manrope', ui-monospace, monospace",
      fontSize: "12px",
      maxWidth: "480px",
    },
    ".cm-tooltip-lint .cm-diagnostic": {
      padding: "4px 0",
      borderLeft: `3px solid ${PALETTE.outlineVariant}`,
      paddingLeft: "10px",
      marginLeft: "-13px",
    },
    ".cm-tooltip-lint .cm-diagnostic-error": {
      borderLeftColor: PALETTE.error,
    },
    ".cm-tooltip-lint .cm-diagnostic-warning": {
      borderLeftColor: PALETTE.tertiary,
    },
    ".cm-tooltip-lint .cm-diagnostic-info": {
      borderLeftColor: PALETTE.primary,
    },
    ".cm-tooltip-lint .cm-diagnostic-source": {
      color: PALETTE.outline,
      fontSize: "10px",
      textTransform: "uppercase",
      letterSpacing: "0.05em",
      marginTop: "2px",
    },

    // ── Merge diff inline highlight (unifiedMergeView) ──────────────────
    // Inserted text: primary blue tint over the line.
    ".cm-insertedLine": {
      backgroundColor: PALETTE.insertedLine,
    },
    ".cm-insertedLine .cm-content": {
      backgroundColor: PALETTE.insertedSurface,
    },
    // Deleted text: error red tint. (Rendered as a block above the line.)
    ".cm-deletedLine": {
      backgroundColor: PALETTE.deletedLine,
    },
    ".cm-deletedLine .cm-content": {
      backgroundColor: PALETTE.deletedSurface,
    },
    // Inline character-level changes.
    ".cm-insertedText": {
      backgroundColor: PALETTE.insertedSurface,
      color: PALETTE.onSurface,
    },
    ".cm-deletedText": {
      backgroundColor: PALETTE.deletedSurface,
      textDecoration: "line-through",
      color: PALETTE.onSurface,
    },
    // The merge gutter marker (vertical bar in the gutter).
    ".cm-changedLine": {
      backgroundColor: PALETTE.insertedLine,
    },
    ".cm-changedLineGutter": {
      backgroundColor: "transparent",
      width: "4px",
    },
    // Accept / reject chunk buttons.
    ".cm-merge-revert": {
      backgroundColor: PALETTE.surfaceContainerHigh,
      color: PALETTE.onSurface,
      border: `1px solid ${PALETTE.outlineVariant}`,
      borderRadius: "4px",
      padding: "2px 6px",
      fontSize: "10px",
      cursor: "pointer",
    },
    ".cm-merge-revert:hover": {
      backgroundColor: PALETTE.surfaceContainer,
    },

    // ── Signature help tooltip ──────────────────────────────────────────
    // (Used by pyright via the LSP plugin.)
    ".cm-tooltip.cm-tooltip-signature": {
      backgroundColor: PALETTE.surfaceContainerHigh,
      color: PALETTE.onSurface,
      border: `1px solid ${PALETTE.outlineVariant}`,
      borderRadius: "6px",
      padding: "6px 10px",
      fontFamily: "'Manrope', ui-monospace, monospace",
      fontSize: "12px",
    },
    ".cm-signature-active-parameter": {
      color: PALETTE.tertiary,
      fontWeight: "bold",
    },

    // ── Hover tooltip (pyright type info) ───────────────────────────────
    ".cm-tooltip.cm-tooltip-hover": {
      backgroundColor: PALETTE.surfaceContainerHigh,
      color: PALETTE.onSurface,
      border: `1px solid ${PALETTE.outlineVariant}`,
      borderRadius: "6px",
      padding: "8px 10px",
      maxWidth: "560px",
    },
    ".cm-tooltip-hover code": {
      backgroundColor: PALETTE.surfaceContainerLow,
      padding: "0 4px",
      borderRadius: "3px",
      fontFamily: "'Manrope', ui-monospace, monospace",
      fontSize: "11px",
    },
  },
  { dark: true },
);

/**
 * Combined extension to drop into `<CodeMirror extensions={[...]} />`.
 * Pass exactly once — registering the same theme twice would create a
 * duplicate style sheet.
 */
export const bonafideTheme = [bonafideEditorTheme, syntaxHighlighting(bonafideHighlight)];

/**
 * Theme identifier kept for compatibility with the previous Monaco-based
 * identifier so any future callers can reference it the same way.
 */
export const BONAFIDE_THEME_NAME = "bonafide-dark";
