// src/data/settings.ts — Shared types for the typed settings store.
//
// Mirrors the Rust `commands::settings::Settings` struct
// (src-tauri/src/commands/settings.rs). When you add a field to the
// Rust side, add the matching field here and re-run `cargo check` /
// the renderer build to confirm both ends stay in sync.
//
// The store is keyed by camelCase JSON strings (the Rust struct uses
// `#[serde(rename_all = "camelCase")]`), so `model_endpoints` on the
// Rust side round-trips as `modelEndpoints` here.

/** One entry in the custom model-endpoint registry. Keyed by an
 *  opaque ID the renderer generates. */
export interface ModelEndpoint {
  /** OpenAI-compatible base URL, e.g. "https://api.anthropic.com/v1". */
  url: string
  /** Optional API key sent as Bearer token. `null` for local
   *  endpoints (LM Studio, vLLM, etc.). */
  apiKey: string | null
  /** Set by the last `Test` round-trip — `true` if the URL
   *  responded, `false` otherwise. */
  available: boolean
}

/** Full settings shape — must match the Rust `Settings` struct exactly. */
export interface Settings {
  // Core
  defaultProject: string | null
  syncInterval: string
  formatter: string
  formatOnSave: boolean

  // Decoration toggles
  showRunAnchorDecorations: boolean
  showLiveMetricSparklines: boolean
  showCodeProvenanceBorders: boolean
  animateStatusDots: boolean

  // Notification toggles
  notifyRunFinishToast: boolean
  notifyRunFinishOs: boolean
  notifyRunFinishEmail: boolean
  notifyRunFinishSlack: boolean
  notifyRunFailToast: boolean
  notifyRunFailOs: boolean
  notifyRunFailEmail: boolean
  notifyRunFailSlack: boolean
  notifyBetterRunToast: boolean
  notifyBetterRunOs: boolean

  // Quiet hours
  quietHoursEnabled: boolean
  quietHoursStart: string
  quietHoursEnd: string

  // Tracker options
  detectVenvOnOpen: boolean
  useSystemPython: boolean
  usePythonFromPath: boolean
  deltaChipMetric: string
  reindexOnSave: boolean
  sendGitMetadata: boolean
  runPrecommitHooks: boolean

  // Privacy / updates
  analyticsOptIn: boolean
  crashReportsOptIn: boolean
  updateChannel: string
  autoDownloadUpdates: boolean
  installAutomatically: boolean
  lastUpdateCheck: number | null

  // MLflow connection (Preferences → Account → MLflow card).
  // Both fields are `null` on first run.
  mlflowBaseUrl: string | null
  mlflowProject: string | null

  // Model endpoints registry (Preferences → Models). Empty on first
  // run; the renderer populates as the user adds custom endpoints.
  modelEndpoints: Record<string, ModelEndpoint>

  // Model preferences (Preferences → Models)
  useBuiltInModelsByDefault: boolean
  streamResponses: boolean
}

/** Model endpoint shape stored in the Rust settings store. Keyed by an
 *  opaque ID the renderer generates. Only `url` / `apiKey` /
 *  `available` round-trip through the Rust settings commands — the
 *  full endpoint data (id, label, baseUrl, defaultModel) lives in
 *  `modelsStore.tsx` / localStorage. */
export interface ModelEndpoint {
  url: string
  apiKey: string | null
  available: boolean
}

/** Default settings — mirrors the Rust `Settings::default()` impl.
 *  Kept in sync manually because TypeScript can't share a source of
 *  truth with Rust; if you change one side, change the other. */
export const DEFAULT_SETTINGS: Settings = {
  defaultProject: null,
  syncInterval: "5s",
  formatter: "ruff",
  formatOnSave: true,

  showRunAnchorDecorations: true,
  showLiveMetricSparklines: true,
  showCodeProvenanceBorders: true,
  animateStatusDots: false,

  notifyRunFinishToast: true,
  notifyRunFinishOs: true,
  notifyRunFinishEmail: false,
  notifyRunFinishSlack: false,
  notifyRunFailToast: true,
  notifyRunFailOs: true,
  notifyRunFailEmail: true,
  notifyRunFailSlack: true,
  notifyBetterRunToast: false,
  notifyBetterRunOs: false,

  quietHoursEnabled: true,
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",

  detectVenvOnOpen: true,
  useSystemPython: false,
  usePythonFromPath: true,
  deltaChipMetric: "val_loss",
  reindexOnSave: true,
  sendGitMetadata: true,
  runPrecommitHooks: false,

  analyticsOptIn: true,
  crashReportsOptIn: true,
  updateChannel: "stable",
  autoDownloadUpdates: true,
  installAutomatically: false,
  lastUpdateCheck: null,

  mlflowBaseUrl: null,
  mlflowProject: null,

  modelEndpoints: {},

  useBuiltInModelsByDefault: true,
  streamResponses: false,
}

/** Keys that the Rust `set_setting` Tauri command accepts. Any value
 *  outside this list returns `Err("Unknown setting key: ...")`. The
 *  renderer uses this as a runtime check before calling
 *  `bonafide.settings.setSetting(...)` so we get a useful error
 *  before the IPC round-trip instead of a silent no-op. */
export type SettingKey = keyof Settings

/** Coerce a partial settings payload into a full `Settings` object,
 *  filling missing keys with `DEFAULT_SETTINGS` values. Used by the
 *  React side to handle backwards-compatible settings files where
 *  new fields are absent (the Rust side already does this for
 *  individual fields via `#[serde(default)]`, but the renderer
 *  needs the same shape for its local cache). */
export function mergeSettings(partial: Partial<Settings> | null | undefined): Settings {
  if (!partial || typeof partial !== "object") return { ...DEFAULT_SETTINGS }
  return { ...DEFAULT_SETTINGS, ...partial }
}
