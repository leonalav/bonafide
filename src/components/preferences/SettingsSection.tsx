import { forwardRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { Button } from "../ui/primitives";
import { Select } from "../ui/Select";
import { Card, CardHeader, Checkbox, Field, RadioGroup, Slider } from "../ui/controls";

const onOff = [
  { value: "on", label: "on" },
  { value: "off", label: "off" },
];

export const SettingsSection = forwardRef<HTMLDivElement, { highlightTrackers?: boolean }>(function SettingsSection(
  { highlightTrackers },
  trackersRef,
) {
  const [font, setFont] = useState("geist");
  const [tab, setTab] = useState("2");
  const [insertSpaces, setInsertSpaces] = useState("spaces");
  const [wordWrap, setWordWrap] = useState("on");
  const [minimap, setMinimap] = useState("on");
  const [cursor, setCursor] = useState("line");
  const [whitespace, setWhitespace] = useState("selection");
  const [interpreter, setInterpreter] = useState("py311");
  const [formatter, setFormatter] = useState("ruff");
  const [syncInterval, setSyncInterval] = useState("5s");
  const [deltaMetric, setDeltaMetric] = useState("val_loss");
  const [channel, setChannel] = useState("stable");
  const [advanced, setAdvanced] = useState(false);

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-8">
      {/* Editor */}
      <Card>
        <CardHeader title="Editor" />
        <div className="flex flex-col gap-2">
          <Field label="Font family">
            <Select value={font} onChange={setFont} align="right" className="w-48" options={[{ value: "geist", label: "Geist Sans" }, { value: "inter", label: "Inter" }, { value: "jetbrains", label: "JetBrains Mono" }, { value: "fira", label: "Fira Code" }]} />
          </Field>
          <Field label="Font size">
            <Slider min={10} max={24} defaultValue={14} />
            <span className="ml-2 font-sans text-[16px]" style={{ fontFamily: "var(--font-sans)" }}>Aa</span>
          </Field>
          <Field label="Tab size">
            <Select value={tab} onChange={setTab} align="right" className="w-20" options={["2", "4", "8"]} />
          </Field>
          <Field label="Insert spaces">
            <RadioGroup variant="segmented" value={insertSpaces} onChange={setInsertSpaces} options={[{ value: "spaces", label: "Spaces" }, { value: "tabs", label: "Tabs" }]} />
          </Field>
          <Field label="Word wrap">
            <RadioGroup variant="segmented" value={wordWrap} onChange={setWordWrap} options={onOff} />
          </Field>
          <Field label="Minimap">
            <RadioGroup variant="segmented" value={minimap} onChange={setMinimap} options={onOff} />
          </Field>
          <Field label="Cursor style">
            <RadioGroup variant="segmented" value={cursor} onChange={setCursor} options={[{ value: "line", label: "Line" }, { value: "block", label: "Block" }, { value: "underline", label: "Underline" }]} />
          </Field>
          <Field label="Render whitespace">
            <RadioGroup variant="segmented" value={whitespace} onChange={setWhitespace} options={[{ value: "off", label: "Off" }, { value: "selection", label: "Selection" }, { value: "all", label: "All" }]} />
          </Field>
        </div>
      </Card>

      {/* Python */}
      <Card>
        <CardHeader title="Python" />
        <div className="flex flex-col gap-2">
          <Field label="Interpreter">
            <Select
              leadingIcon="python"
              value={interpreter}
              onChange={setInterpreter}
              align="right"
              className="w-64"
              options={[
                { value: "py311", label: "/usr/local/bin/python3.11" },
                { value: "venv", label: ".venv/bin/python (bonafide-train)" },
                { value: "conda", label: "conda: ml (3.10.13)" },
                { value: "system", label: "/usr/bin/python3" },
              ]}
            />
            <Button variant="secondary" size="sm">Detect</Button>
          </Field>
          <Field label="Version"><span className="font-sans text-[13px] text-on-surface">3.11.4</span></Field>
          <Field label="Virtual env"><span className="flex items-center gap-1 font-sans text-[13px] text-on-surface">bonafide-train (.venv) <Icon name="check" size={13} className="text-primary" /></span></Field>
          <div className="flex items-center justify-between gap-4">
            <span className="font-body text-[13px] text-on-surface-variant">Packages</span>
            <span className="truncate font-sans text-[12px] text-on-surface-variant">torch 2.2.1 · transformers 4.36 · wandb 0.16</span>
          </div>
        </div>
        <div className="my-3 h-px bg-outline-variant/60" />
        <div className="label-caps mb-1 text-outline">Detect on workspace open</div>
        <Checkbox label="Auto-detect .venv or conda env" defaultChecked />
        <Checkbox label="Always use system Python" />
        <Checkbox label="Use python from $PATH" />
        <div className="my-3 h-px bg-outline-variant/60" />
        <div className="label-caps mb-2 text-outline">Formatting on save</div>
        <Field label="Formatter">
          <Select value={formatter} onChange={setFormatter} align="right" className="w-40" options={[{ value: "ruff", label: "Ruff" }, { value: "black", label: "Black" }, { value: "autopep8", label: "autopep8" }, { value: "yapf", label: "yapf" }, { value: "none", label: "None" }]} />
        </Field>
        <Checkbox label="Format on save" defaultChecked />
      </Card>

      {/* Trackers (deep-link target) */}
      <div ref={trackersRef} className={`rounded-lg transition-shadow ${highlightTrackers ? "ring-2 ring-primary" : ""}`}>
        <Card>
          <CardHeader title="Trackers" />
          <Field label="Default project">
            <input defaultValue="bonafide-train" className="h-7 w-56 rounded border border-outline-variant bg-surface px-2 font-sans text-[13px] text-on-surface focus:border-primary focus:outline-none" />
          </Field>
          <div className="mt-3">
            <div className="label-caps mb-2 text-outline">Sync interval</div>
            <RadioGroup value={syncInterval} onChange={setSyncInterval} options={[{ value: "5s", label: "5s" }, { value: "10s", label: "10s" }, { value: "30s", label: "30s" }, { value: "1m", label: "1m" }, { value: "5m", label: "5m" }]} />
          </div>
          <div className="mt-3">
            <div className="label-caps mb-1 text-outline">On file save</div>
            <Checkbox label="Re-index workspace" defaultChecked />
            <Checkbox label="Send git metadata to trackers" defaultChecked />
            <Checkbox label="Run pre-commit hooks" />
          </div>
          <div className="mt-3">
            <div className="label-caps mb-1 text-outline">Decorations</div>
            <Checkbox label="Show run anchor decorations" defaultChecked />
            <Checkbox label="Show live metric sparklines" defaultChecked />
            <Checkbox label="Show code provenance borders" defaultChecked />
            <Checkbox label="Animate status dots" />
          </div>
          <div className="mt-3">
            <Field label="Delta chip metric">
              <Select value={deltaMetric} onChange={setDeltaMetric} align="right" className="w-40" options={["val_loss", "loss", "acc", "lr"]} />
            </Field>
          </div>
        </Card>
      </div>

      {/* Notifications */}
      <Card>
        <CardHeader title="Notifications" />
        <div className="label-caps mb-1 text-outline">When a run finishes</div>
        <Checkbox label="Toast in app" defaultChecked />
        <Checkbox label="Native OS notification" defaultChecked />
        <Checkbox label="Email" />
        <Checkbox label="Slack (channel: #ml-experiments)" />
        <div className="label-caps mb-1 mt-3 text-outline">When a run fails</div>
        <Checkbox label="Toast in app" defaultChecked />
        <Checkbox label="Native OS notification" defaultChecked />
        <Checkbox label="Email" defaultChecked />
        <Checkbox label="Slack" defaultChecked />
        <div className="label-caps mb-1 mt-3 text-outline">When a better run appears</div>
        <Checkbox label="Toast in app" />
        <Checkbox label="Native OS notification" />
        <div className="mt-3 flex items-center gap-2">
          <span className="font-body text-[13px] text-on-surface-variant">Quiet hours from</span>
          <input type="time" defaultValue="22:00" className="h-7 rounded border border-outline-variant bg-surface px-2 font-sans text-[12px] text-on-surface focus:border-primary focus:outline-none" />
          <span className="font-body text-[13px] text-on-surface-variant">to</span>
          <input type="time" defaultValue="08:00" className="h-7 rounded border border-outline-variant bg-surface px-2 font-sans text-[12px] text-on-surface focus:border-primary focus:outline-none" />
          <Checkbox label="Enabled" defaultChecked />
        </div>
      </Card>

      {/* Privacy */}
      <Card>
        <CardHeader title="Privacy" />
        <Checkbox label="Send anonymous usage analytics" description="Helps improve Bonafide. No code or run data is ever sent." />
        <div className="h-2" />
        <Checkbox label="Send crash reports" description="Includes stack traces only, no file contents." />
        <div className="my-3 h-px bg-outline-variant/60" />
        <div className="label-caps mb-2 text-outline">Data storage</div>
        <Field label="Cache location">
          <span className="font-sans text-[12px] text-on-surface-variant">~/Library/Application Support/Bonafide</span>
        </Field>
        <div className="mt-1 flex gap-2">
          <Button variant="secondary" size="sm">Open in Finder</Button>
          <Button variant="secondary" size="sm">Change location…</Button>
        </div>
        <Field label="Cache size">
          <span aria-live="polite" className="font-sans text-[13px] tabular-nums text-on-surface">247 MB</span>
          <Button variant="secondary" size="sm">Clear cache</Button>
        </Field>
        <div className="my-3 h-px bg-outline-variant/60" />
        <div className="flex items-center justify-between">
          <span className="label-caps text-outline">GDPR</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm">Request data export</Button>
            <Button variant="ghost" size="sm" className="hover:!text-error">Delete account</Button>
          </div>
        </div>
      </Card>

      {/* Updates */}
      <Card>
        <CardHeader title="Updates" />
        <Field label="Current version"><span className="font-sans text-[13px] text-on-surface">Bonafide 0.3.1 (build 7f3a91c)</span></Field>
        <Field label="Channel">
          <Select value={channel} onChange={setChannel} align="right" className="w-32" options={[{ value: "stable", label: "Stable" }, { value: "beta", label: "Beta" }]} />
        </Field>
        <div className="mt-1 flex items-center gap-3">
          <Button variant="secondary" size="sm">Check for updates</Button>
          <span className="font-body text-[12px] text-outline">Last checked 14 minutes ago</span>
        </div>
        <div className="mt-3">
          <Checkbox label="Auto-download updates" defaultChecked />
          <Checkbox label="Install automatically (no prompt)" />
        </div>
      </Card>

      {/* Advanced (collapsible) */}
      <Card>
        <div className="flex items-center justify-between">
          <span className="label-caps text-on-surface-variant">Advanced</span>
          <button onClick={() => setAdvanced((v) => !v)} className="flex items-center gap-1 font-sans text-[12px] text-outline hover:text-on-surface">
            <Icon name={advanced ? "chevron-up" : "chevron-down"} size={13} /> {advanced ? "Collapse" : "Expand"}
          </button>
        </div>
        {advanced && (
          <div className="mt-3 flex flex-col gap-2">
            <Field label="IPC port"><span className="font-sans text-[13px] text-on-surface">7654</span></Field>
            <Field label="Python shim socket"><span className="font-sans text-[12px] text-on-surface-variant">~/.bonafide/shim.sock</span></Field>
            <Field label="Local DB"><span className="font-sans text-[12px] text-on-surface-variant">…/Bonafide/cache.db</span></Field>
            <div className="my-1 h-px bg-outline-variant/60" />
            <Checkbox label="Verbose logging" description="Writes to ~/.bonafide/logs/" />
            <Checkbox label="Enable experimental features" />
            <Checkbox label="Allow Bonafide to write to ~/.bonafide/external/" />
            <div className="mt-2">
              <Button variant="danger" size="sm">Reset all settings to default</Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
});
