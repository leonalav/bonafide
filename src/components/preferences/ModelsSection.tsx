import { useState } from "react"
import { Icon } from "../ui/Icon"
import { Button } from "../ui/primitives"
import { Card, CardHeader, Checkbox, Field } from "../ui/controls"
import {
  useModelsStore,
  BUILT_IN_MODELS,
  type ModelEndpoint,
  type BuiltInModel,
} from "../../modelsStore"

// ─── Helpers ───────────────────────────────────────────────────────────────────

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

type TestStatus = "idle" | "testing" | "ok" | "error"

function StatusDot({ status }: { status: TestStatus }) {
  if (status === "idle") return null
  const color =
    status === "ok"
      ? "bg-primary"
      : status === "error"
        ? "bg-error"
        : "bg-outline animate-pulse"
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
}

// ─── Endpoint form row ────────────────────────────────────────────────────────

function EndpointForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Partial<ModelEndpoint>
  onSave: (ep: ModelEndpoint) => void
  onCancel: () => void
}) {
  const [label, setLabel] = useState(initial?.label ?? "")
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "")
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "")
  const [defaultModel, setDefaultModel] = useState(
    initial?.defaultModel ?? "claude-3-5-sonnet-20241022",
  )

  const [testStatus, setTestStatus] = useState<TestStatus>("idle")
  const [testMsg, setTestMsg] = useState("")

  async function test() {
    if (!baseUrl) return
    setTestStatus("testing")
    setTestMsg("")
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      })
      if (res.ok) {
        setTestStatus("ok")
        setTestMsg("Connection successful.")
      } else {
        setTestStatus("error")
        setTestMsg(`HTTP ${res.status}: ${res.statusText}`)
      }
    } catch (e) {
      setTestStatus("error")
      setTestMsg(e instanceof Error ? e.message : "Connection failed.")
    }
  }

  function save() {
    if (!label || !baseUrl) return
    onSave({
      id: initial?.id ?? uid(),
      label: label.trim(),
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      defaultModel: defaultModel.trim(),
    })
  }

  const canSave = label.trim() && baseUrl.trim()

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-outline-variant bg-surface-container-low p-4">
      <div className="flex items-center justify-between">
        <span className="label-caps text-on-surface-variant">
          {initial?.id ? "Edit endpoint" : "Add endpoint"}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={test}
            disabled={!baseUrl || testStatus === "testing"}
            className="flex items-center gap-1.5 rounded px-2 py-1 font-sans text-[12px] text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface disabled:opacity-40"
          >
            {testStatus === "idle" && (
              <>
                <Icon name="zap" size={12} />
                Test
              </>
            )}
            {testStatus === "testing" && (
              <>
                <Icon name="refresh" size={12} className="animate-spin" />
                Testing…
              </>
            )}
            {testStatus === "ok" && (
              <>
                <Icon name="check" size={12} className="text-primary" />
                <span className="text-primary">Connected</span>
              </>
            )}
            {testStatus === "error" && (
              <>
                <Icon name="circle-x" size={12} className="text-error" />
                <span className="text-error">Failed</span>
              </>
            )}
          </button>
          <button
            onClick={onCancel}
            className="rounded px-2 py-1 font-sans text-[12px] text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
          >
            Cancel
          </button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSave}
            onClick={save}
          >
            {initial?.id ? "Save" : "Add"}
          </Button>
        </div>
      </div>

      {testMsg && (
        <p
          className={`font-sans text-[12px] ${
            testStatus === "error" ? "text-error" : "text-on-surface-variant"
          }`}
        >
          {testMsg}
        </p>
      )}

      <div className="flex flex-col gap-3">
        <Field label="Label" block>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="My Anthropic Endpoint"
            className="h-7 w-full rounded border border-outline-variant bg-surface px-2 font-sans text-[13px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
          />
        </Field>
        <Field label="Default model ID" block>
          <input
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            placeholder="claude-3-5-sonnet-20241022"
            className="h-7 w-full rounded border border-outline-variant bg-surface px-2 font-sans text-[13px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
          />
        </Field>
        <Field label="Base URL" block>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.anthropic.com/v1  (OpenAI-compatible)"
            className="h-7 w-full rounded border border-outline-variant bg-surface px-2 font-sans text-[13px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
          />
        </Field>
        <Field label="API key" block>
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            type="password"
            placeholder="sk-ant-…"
            className="h-7 w-full rounded border border-outline-variant bg-surface px-2 font-sans text-[13px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
          />
        </Field>
      </div>
    </div>
  )
}

// ─── Endpoint list row ────────────────────────────────────────────────────────

function EndpointRow({
  ep,
  isSelected,
  onSelect,
  onEdit,
  onDelete,
}: {
  ep: ModelEndpoint
  isSelected: boolean
  onSelect: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`relative flex items-center gap-3 rounded px-3 py-2.5 transition-colors ${
        isSelected
          ? "bg-surface-container-high"
          : hovered
            ? "bg-surface-container"
            : ""
      }`}
    >
      {isSelected && (
        <span className="absolute left-0 top-0 h-full w-[3px] rounded-full bg-primary" />
      )}
      {/* Radio */}
      <button
        onClick={onSelect}
        className="flex h-5 w-5 shrink-0 items-center justify-center"
        aria-label={isSelected ? "Selected as default" : "Set as default"}
      >
        {isSelected ? (
          <Icon name="check-circle" size={16} className="text-primary" />
        ) : (
          <Icon name="circle" size={16} className="text-outline" />
        )}
      </button>

      {/* Info */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-body text-[13px] font-medium text-on-surface">
          {ep.label}
        </span>
        <span className="truncate font-sans text-[11px] text-outline">
          {ep.baseUrl.replace(/\/$/, "")} · {ep.defaultModel}
        </span>
      </div>

      {/* Actions */}
      {hovered && (
        <div className="flex items-center gap-1">
          <button
            onClick={onEdit}
            className="flex h-6 items-center gap-1 rounded px-2 font-sans text-[12px] text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
          >
            <Icon name="edit-2" size={12} /> Edit
          </button>
          <button
            onClick={onDelete}
            className="flex h-6 items-center gap-1 rounded px-2 font-sans text-[12px] text-on-surface-variant hover:bg-surface-container-high hover:text-error"
          >
            <Icon name="trash-2" size={12} /> Delete
          </button>
        </div>
      )}
    </div>
  )
}

// ─── ModelsSection ─────────────────────────────────────────────────────────────

export function ModelsSection() {
  const {
    config,
    selectedEndpoint,
    selectEndpoint,
    addEndpoint,
    removeEndpoint,
    updateEndpoint,
  } = useModelsStore()

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  function handleSave(ep: ModelEndpoint) {
    if (editingId) {
      updateEndpoint(ep.id, ep)
      setEditingId(null)
    } else {
      addEndpoint(ep)
    }
    setShowForm(false)
  }

  function handleSelect(id: string | null) {
    selectEndpoint(id)
  }

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-8">
      {/* Built-in models */}
      <Card>
        <CardHeader title="Built-in models" />
        <p className="mb-3 font-body text-[13px] text-on-surface-variant">
          Bonafide ships with a default endpoint. No configuration needed.
        </p>
        <div className="flex flex-col gap-1">
          {BUILT_IN_MODELS.map((m) => (
            <BuiltInModelRow
              key={m.id}
              model={m}
              active={selectedEndpoint === null}
            />
          ))}
        </div>
        <div className="my-3 h-px bg-outline-variant/60" />
        <div className="label-caps mb-2 text-outline">
          Model selection behaviour
        </div>
        <Checkbox
          label="Use built-in models by default"
          description="When no custom endpoint is selected, route all agent requests to Bonafide's default endpoint."
          defaultChecked
        />
      </Card>

      {/* Custom endpoints */}
      <Card>
        <CardHeader
          title="Custom endpoints"
          right={
            !showForm && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setEditingId(null)
                  setShowForm(true)
                }}
              >
                <Icon name="plus" size={13} />
                Add endpoint
              </Button>
            )
          }
        />
        <p className="mb-3 font-body text-[13px] text-on-surface-variant">
          Add OpenAI-compatible endpoints for self-hosted or third-party model
          providers (LM Studio, vLLM, Groq, Fireworks AI, etc.).
        </p>

        {config.endpoints.length === 0 && !showForm && (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-outline-variant py-8 text-center">
            <Icon name="cpu" size={28} className="text-outline-variant" />
            <p className="font-body text-[13px] text-on-surface-variant">
              No custom endpoints configured.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setEditingId(null)
                setShowForm(true)
              }}
            >
              <Icon name="plus" size={13} />
              Add your first endpoint
            </Button>
          </div>
        )}

        {config.endpoints.map((ep) => {
          if (editingId === ep.id) {
            return (
              <EndpointForm
                key={ep.id}
                initial={ep}
                onSave={handleSave}
                onCancel={() => {
                  setEditingId(null)
                  setShowForm(false)
                }}
              />
            )
          }
          return (
            <EndpointRow
              key={ep.id}
              ep={ep}
              isSelected={config.selectedEndpointId === ep.id}
              onSelect={() =>
                handleSelect(config.selectedEndpointId === ep.id ? null : ep.id)
              }
              onEdit={() => {
                setEditingId(ep.id)
                setShowForm(true)
              }}
              onDelete={() => setDeleteConfirm(ep.id)}
            />
          )
        })}

        {showForm && !editingId && (
          <div className="mt-2">
            <EndpointForm
              onSave={handleSave}
              onCancel={() => {
                setShowForm(false)
                setEditingId(null)
              }}
            />
          </div>
        )}

        {config.endpoints.length > 0 && !showForm && (
          <>
            <div className="my-3 h-px bg-outline-variant/60" />
            <p className="font-body text-[12px] text-outline">
              Selected endpoint is used for all agent requests. Deselect to fall
              back to the built-in default.
            </p>
          </>
        )}
      </Card>

      {/* Request format */}
      <Card>
        <CardHeader title="Request format" />
        <p className="mb-3 font-body text-[13px] text-on-surface-variant">
          Bonafide sends chat completions requests to the configured endpoint
          using the OpenAI Chat Completions API shape:
        </p>
        <pre className="overflow-x-auto rounded border border-outline-variant bg-surface-container-low p-3 font-mono text-[12px] leading-5 text-on-surface-variant">
          {`POST {base_url}/chat/completions
Authorization: Bearer {api_key}
Content-Type: application/json

{
  "model": "{default_model}",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user",   "content": "..." }
  ],
  "stream": false
}`}
        </pre>
        <div className="mt-3 flex gap-2">
          <Checkbox
            label="Stream responses (SSE)"
            description="Not yet supported — responses are always buffered."
            defaultChecked
          />
        </div>
      </Card>

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="w-[380px] rounded-xl border border-outline-variant bg-surface-container p-5 shadow-2xl">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-error/10">
                <Icon name="trash-2" size={20} className="text-error" />
              </div>
              <div>
                <p className="font-body text-[15px] font-medium text-on-surface">
                  Delete endpoint?
                </p>
                <p className="font-body text-[13px] text-outline">
                  This action cannot be undone.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => setDeleteConfirm(null)}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  removeEndpoint(deleteConfirm)
                  setDeleteConfirm(null)
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Built-in model row (inside preferences panel) ─────────────────────────────

function BuiltInModelRow({
  model,
  active,
}: {
  model: BuiltInModel
  active: boolean
}) {
  return (
    <div
      className={`relative flex items-start gap-3 rounded px-3 py-2.5 ${
        active ? "bg-surface-container-high" : "hover:bg-surface-container"
      }`}
    >
      {active && (
        <span className="absolute left-0 top-0 h-full w-[3px] rounded-full bg-primary" />
      )}
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
        {active ? (
          <Icon name="check-circle" size={16} className="text-primary" />
        ) : (
          <Icon name="circle" size={16} className="text-outline" />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-body text-[13px] font-medium text-on-surface">
          {model.name}
        </span>
        <span className="font-sans text-[11px] text-outline">
          {model.badge}
        </span>
        <span className="mt-0.5 font-body text-[12px] text-outline">
          {model.description}
        </span>
      </div>
    </div>
  )
}
