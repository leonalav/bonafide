/**
 * modelsStore.ts — Shared state for AI model endpoint configuration.
 *
 * Architecture:
 *   - Plain module-level state (no React dependency) so it can be imported
 *     from anywhere without triggering re-renders.
 *   - A thin React context + provider pattern for components that need to
 *     subscribe to changes.
 *   - Persisted to localStorage under the key "__bonafide_models".
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import { bonafide } from "@/ipc/tauri"
import type { ModelEndpoint as SettingsModelEndpoint } from "@/data/settings"

// ─── Types ────────────────────────────────────────────────────────────────────

export type ModelFamily = "fable" | "sonnet" | "haiku" | "claude-opus" | "claude-sonnet" | "claude-haiku" | "gpt-4o" | "gpt-4o-mini" | "o1-preview" | "o1-mini" | "o3-mini" | "gemini-2.5-pro" | "gemini-2.5-flash" | "deepseek-v3" | "llama-4-sonnet" | "custom"

export type ModelEndpoint = {
  id: string
  /** Human-readable label shown in the picker. */
  label: string
  /** OpenAI-compatible base URL, e.g. "https://api.anthropic.com/v1". */
  baseUrl: string
  /** API key sent as Bearer token. */
  apiKey: string
  /** Default model ID sent to this endpoint, e.g. "claude-3-5-sonnet-20241022". */
  defaultModel: string
}

export type ModelConfig = {
  /** Currently selected endpoint ID (null = use bonafide default). */
  selectedEndpointId: string | null
  /** All configured endpoints. */
  endpoints: ModelEndpoint[]
}

// ─── Built-in model catalogue ──────────────────────────────────────────────────

export type BuiltInModel = {
  id: ModelFamily
  name: string
  /** Short string shown next to the name, e.g. "200k ctx · $0.004/turn". */
  badge: string
  /** Longer description for the preferences panel. */
  description: string
}

export const BUILT_IN_MODELS: BuiltInModel[] = [
  {
    id: "fable",
    name: "Claude Fable 5.1",
    badge: "1M ctx · $0.012/turn",
    description:
      "Flagship model for complex, multi-step reasoning and long-context tasks.",
  },
  {
    id: "sonnet",
    name: "Claude Sonnet 5.1",
    badge: "200k ctx · $0.004/turn",
    description:
      "Strong all-rounder. Ideal balance of speed, capability, and cost.",
  },
  {
    id: "haiku",
    name: "Claude Haiku 5.1",
    badge: "200k ctx · $0.001/turn",
    description:
      "Fast, lightweight model for high-frequency, low-latency tasks.",
  },
]

// ─── Module-level defaults ─────────────────────────────────────────────────────

const DEFAULT_CONFIG: ModelConfig = {
  selectedEndpointId: null,
  endpoints: [],
}

const STORAGE_KEY = "__bonafide_models"

function loadConfig(): ModelConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as ModelConfig
  } catch {
    /* ignore parse errors */
  }
  return DEFAULT_CONFIG
}

/** Bootstrap: read the settings store for the persisted `modelEndpoints`
 *  and merge `available` status back into the local config. The full
 *  endpoint list (id, label, baseUrl, defaultModel) comes from
 *  localStorage; `available` comes from the settings store. Call this
 *  once at module load (ModelsProvider mount) — it fires-and-forgets
 *  the async IPC call so it never blocks render. */
export function bootstrapFromSettings(): void {
  void (async () => {
    try {
      const stored = await bonafide.settings.get("modelEndpoints")
      if (!stored || typeof stored !== "object") return
      const availableMap = stored as Record<string, { url?: string; apiKey?: string | null; available?: boolean }>
      // Merge `available` into the in-memory config. The `available`
      // field reflects the last test result; it's the only field in
      // `modelEndpoints` that survives a settings round-trip.
      _config = {
        ..._config,
        endpoints: _config.endpoints.map((ep) => {
          const storedEp = availableMap[ep.id]
          if (!storedEp) return ep
          return {
            ...ep,
            // Only update fields that the settings store owns
            baseUrl: storedEp.url ?? ep.baseUrl,
            apiKey:
              storedEp.apiKey != null
                ? (storedEp.apiKey ?? ep.apiKey)
                : ep.apiKey,
          }
        }),
      }
      _notify()
    } catch {
      /* ignore — localStorage stays authoritative */
    }
  })()
}

function saveConfig(cfg: ModelConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
  } catch {
    /* ignore quota errors */
  }
}

// ─── Settings store persistence (P0-T6) ──────────────────────────────────────

/** Fire-and-forget persist the `modelEndpoints` subset to the Rust
 *  settings store (`~/.bonafide/settings.json`). The full endpoint
 *  data (id, label, baseUrl, defaultModel) is already in localStorage;
 *  we only push the `available` status and URL/API key so the Rust
 *  side can track the persisted state. Errors are logged but never
 *  throw — a settings-store failure must never break the UI. */
function persistToSettings(endpoints: ModelConfig["endpoints"]) {
  const asSettings: Record<string, SettingsModelEndpoint> = {}
  for (const ep of endpoints) {
    asSettings[ep.id] = {
      url: ep.baseUrl,
      apiKey: ep.apiKey || null,
      available: false,
    }
  }
  void bonafide.settings
    .set("modelEndpoints", asSettings)
    .catch((e) =>
      console.warn("[modelsStore] setSetting modelEndpoints failed:", e),
    )
}

// ─── Plain helpers (no React) ───────────────────────────────────────────────

let _config = loadConfig()
type Listener = () => void
const _listeners = new Set<Listener>()

function _notify() {
  _listeners.forEach((l) => l())
}

export const modelsStore = {
  getConfig() {
    return _config
  },

  setEndpoints(endpoints: ModelEndpoint[]) {
    _config = { ..._config, endpoints }
    saveConfig(_config)
    persistToSettings(endpoints)
    _notify()
  },

  addEndpoint(ep: ModelEndpoint) {
    _config = { ..._config, endpoints: [..._config.endpoints, ep] }
    saveConfig(_config)
    persistToSettings(_config.endpoints)
    _notify()
  },

  removeEndpoint(id: string) {
    _config = {
      ..._config,
      endpoints: _config.endpoints.filter((e) => e.id !== id),
      selectedEndpointId:
        _config.selectedEndpointId === id ? null : _config.selectedEndpointId,
    }
    saveConfig(_config)
    persistToSettings(_config.endpoints)
    _notify()
  },

  updateEndpoint(id: string, patch: Partial<ModelEndpoint>) {
    _config = {
      ..._config,
      endpoints: _config.endpoints.map((e) =>
        e.id === id ? { ...e, ...patch } : e,
      ),
    }
    saveConfig(_config)
    persistToSettings(_config.endpoints)
    _notify()
  },

  selectEndpoint(id: string | null) {
    _config = { ..._config, selectedEndpointId: id }
    saveConfig(_config)
    _notify()
  },

  subscribe(listener: Listener): () => void {
    _listeners.add(listener)
    return () => {
      _listeners.delete(listener)
    }
  },
}

// ─── React context ────────────────────────────────────────────────────────────

type ModelsStoreValue = {
  config: ModelConfig
  selectedEndpoint: ModelEndpoint | null
  selectEndpoint: (id: string | null) => void
  addEndpoint: (ep: ModelEndpoint) => void
  removeEndpoint: (id: string) => void
  updateEndpoint: (id: string, patch: Partial<ModelEndpoint>) => void
}

const ModelsContext = createContext<ModelsStoreValue | null>(null)

export function ModelsProvider({ children }: { children: ReactNode }) {
  // Re-render whenever the store notifies. Components that consume the hook
  // re-render with us. The value is computed inline (no useMemo) because the
  // bound-action references are stable — the shallow copy on `selectedEndpoint`
  // prevents accidental store mutation by consumers.
  const [, forceUpdate] = useState(0)

  useEffect(() => {
    // Bootstrap from the Rust settings store on first mount.
    // `bootstrapFromSettings` is fire-and-forget — it merges the
    // persisted `available` field into the in-memory config and
    // calls `_notify()` so all subscribers re-render with the
    // updated state.
    bootstrapFromSettings()
    return modelsStore.subscribe(() => forceUpdate((n) => n + 1))
  }, [])

  const config = modelsStore.getConfig()
  const selectedEndpoint =
    config.endpoints.find((e) => e.id === config.selectedEndpointId) ?? null

  const value: ModelsStoreValue = {
    config,
    selectedEndpoint,
    selectEndpoint: modelsStore.selectEndpoint.bind(modelsStore),
    addEndpoint: modelsStore.addEndpoint.bind(modelsStore),
    removeEndpoint: modelsStore.removeEndpoint.bind(modelsStore),
    updateEndpoint: modelsStore.updateEndpoint.bind(modelsStore),
  }

  return (
    <ModelsContext.Provider value={value}>{children}</ModelsContext.Provider>
  )
}

export function useModelsStore(): ModelsStoreValue {
  const ctx = useContext(ModelsContext)
  if (!ctx)
    throw new Error("useModelsStore must be used inside <ModelsProvider>")
  return ctx
}

/** Returns the currently-active endpoint (custom) or null if using the default. */
export function useSelectedEndpoint(): ModelEndpoint | null {
  return useModelsStore().selectedEndpoint
}
