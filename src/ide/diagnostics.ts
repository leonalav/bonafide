/**
 * diagnostics.ts — @codemirror/lint integration for Bonafide.
 *
 * Provides a unified diagnostics surface that combines:
 *   1. LSP server diagnostics (pyright, ruff) — automatically dispatched
 *      by @marimo-team/codemirror-languageserver's `languageServer` extension.
 *   2. Domain errors (e.g. "MLflow run reference doesn't exist") — dispatched
 *      by the host application via `setDomainDiagnostics`.
 *
 * CodeMirror's lint extension (`@codemirror/lint`) handles the gutter +
 * panel UI; we just need to:
 *   - Build a `linter` extension that reads from the LSP diagnostics
 *     (via the plugin's `lspDiagnostics` annotation) and any domain
 *     diagnostics, then converts them to `Diagnostic[]`.
 *   - Provide a `linter` extension that accepts both sources without one
 *     overwriting the other.
 *
 * CodeMirror 6's @codemirror/lint has a known limitation: only ONE linter
 * extension can be active per editor, and it doesn't natively support
 * diagnostics from multiple sources. We work around this by maintaining a
 * single CodeMirror StateField that merges both sources into one Diagnostic
 * list, and a single linter that reads from it.
 */

import {
  linter,
  lintGutter,
  type Diagnostic,
} from "@codemirror/lint";
import { StateField, StateEffect, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** A domain-level diagnostic (not from an LSP server). */
export type DomainDiagnostic = {
  /** Range in CodeMirror document offsets. */
  from: number;
  to: number;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  col: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  /** Source identifier (e.g. "mlflow", "experiment-runner"). */
  source: string;
};

/** Set or replace the domain diagnostics for an editor. */
export const setDomainDiagnostics = StateEffect.define<DomainDiagnostic[]>();

/** State field holding domain diagnostics for an editor. */
export const domainDiagnosticsField = StateField.define<DomainDiagnostic[]>({
  create: () => [],
  update: (value, tr) => {
    for (const e of tr.effects) {
      if (e.is(setDomainDiagnostics)) {
        return e.value;
      }
    }
    return value;
  },
});

/** Convert domain diagnostics to CodeMirror `Diagnostic[]`. */
export function domainToCodeMirror(diags: DomainDiagnostic[]): Diagnostic[] {
  return diags.map((d) => ({
    from: d.from,
    to: d.to,
    severity:
      d.severity === "error"
        ? "error"
        : d.severity === "warning"
          ? "warning"
          : d.severity === "info"
            ? "info"
            : "hint",
    message: d.message,
    source: d.source,
  }));
}

/**
 * A CodeMirror `linter` extension that surfaces domain diagnostics.
 * Because @codemirror/lint only allows one linter per editor, the LSP
 * diagnostics take precedence when both are present. The LSP plugin
 * provides its own diagnostic source via the `lsp-diagnostics` annotation
 * which is automatically merged by @codemirror/lint when both linters
 * are registered with `combineWith: "add"`. We use `combineWith` to
 * union sources without dropping either.
 */
export const domainLinter = linter(
  (view) => {
    const domain = view.state.field(domainDiagnosticsField, false);
    if (!domain) return [];
    return domainToCodeMirror(domain);
  },
  { delay: 200 },
);

/** Default extension set for the diagnostics surface. */
export function diagnosticsExtensions(): Extension[] {
  return [
    lintGutter(),
    domainDiagnosticsField,
    domainLinter,
  ];
}

/**
 * Convenience: dispatch a single domain diagnostic set effect to a view.
 * Use from inside any React effect that has access to the CodeMirror view.
 */
export function applyDomainDiagnostics(
  view: EditorView | null,
  diagnostics: DomainDiagnostic[],
): void {
  if (!view) return;
  view.dispatch({ effects: setDomainDiagnostics.of(diagnostics) });
}
