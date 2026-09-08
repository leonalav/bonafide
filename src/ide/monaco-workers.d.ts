/**
 * Ambient module declarations for monaco-editor worker entry points.
 *
 * Vite's monacoWorkersPlugin resolves bare specifiers like
 * `monaco-editor/esm/vs/editor/editor.worker` to virtual modules
 * exporting the worker source as a string. TypeScript has no way to
 * know about those virtual modules statically, so we declare them
 * here as plain string-typed default exports.
 *
 * This file lives under src/ so it's picked up by tsconfig.json's
 * `include` glob automatically.
 */

declare module "monaco-editor/esm/vs/editor/editor.worker" {
  const source: string;
  export default source;
}

declare module "monaco-editor/esm/vs/language/json/json.worker" {
  const source: string;
  export default source;
}

declare module "monaco-editor/esm/vs/language/css/css.worker" {
  const source: string;
  export default source;
}

declare module "monaco-editor/esm/vs/language/html/html.worker" {
  const source: string;
  export default source;
}

declare module "monaco-editor/esm/vs/language/typescript/ts.worker" {
  const source: string;
  export default source;
}
