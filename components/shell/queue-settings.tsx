"use client";

import { ChevronDown, Plus, Settings2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { configureQueueAction } from "@/app/(app)/c/[channel]/queue-actions";
import type { FormDefinition, FormField, FormFieldType, QueuePreset, QueueStatus } from "@/src/domain/work-queues";
import { browserCsrfToken } from "@/src/shell/browser-csrf";

const TYPES: readonly { value: FormFieldType; label: string }[] = [
  { value: "short_text", label: "Short text" }, { value: "long_text", label: "Long text" },
  { value: "number", label: "Number" }, { value: "single_select", label: "Single select" },
  { value: "multi_select", label: "Multiple select" }, { value: "person", label: "Person" },
  { value: "date", label: "Date" },
];

export function QueueSettings({ channelId, postMode: initialPostMode, definition: initialDefinition,
  sortMode: initialSortMode, sortEmoji: initialEmoji, statuses: initialStatuses, mainLabel: initialMainLabel }: {
  channelId: string; postMode: "open" | "form"; definition: FormDefinition | null;
  sortMode: "chronological" | "ranked"; sortEmoji: string | null;
  statuses: readonly QueueStatus[]; mainLabel: string;
}) {
  const [postMode, setPostMode] = useState(initialPostMode);
  const [definition, setDefinition] = useState<FormDefinition>(initialDefinition ?? { instructions: "", fields: [] });
  const [sortMode, setSortMode] = useState(initialSortMode);
  const [emoji, setEmoji] = useState(initialEmoji ?? "🔥");
  const [statuses, setStatuses] = useState<QueueStatus[]>([...initialStatuses]);
  const [mainLabel, setMainLabel] = useState(initialMainLabel);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const router = useRouter();

  const save = async () => {
    setSaving(true); setMessage(null);
    const result = await configureQueueAction({ csrfToken: browserCsrfToken(), channelId, postMode,
      ...(postMode === "form" ? { formDefinition: definition } : {}), sortMode,
      sortEmoji: sortMode === "ranked" ? emoji : null, statuses: sortMode === "ranked" ? statuses : [], mainStatusLabel: mainLabel });
    setSaving(false); setMessage(result.ok ? "Queue settings saved." : result.reason);
    if (result.ok) router.refresh();
  };
  const preset = async (value: QueuePreset) => {
    setSaving(true);
    const result = await configureQueueAction({ csrfToken: browserCsrfToken(), channelId, preset: value });
    setSaving(false); setMessage(result.ok ? "Preset applied." : result.reason);
    if (result.ok) router.refresh();
  };
  const updateField = (index: number, patch: Partial<FormField>) => setDefinition((current) => ({ ...current,
    fields: current.fields.map((field, position) => position === index ? { ...field, ...patch } : field) }));

  return <details className="queue-settings panel">
    <summary><span><Settings2 size={16} /> Queue setup</span><ChevronDown size={16} /></summary>
    <div className="queue-settings-body">
      <section><h3>Start with a preset</h3><div className="preset-row">
        <button type="button" onClick={() => void preset("idea_board")}>Idea board</button>
        <button type="button" onClick={() => void preset("support_queue")}>Support queue</button>
        <button type="button" onClick={() => void preset("bug_tracker")}>Bug tracker</button>
      </div></section>
      <section><h3>Posting</h3><div className="segmented">
        <button type="button" aria-pressed={postMode === "open"} onClick={() => setPostMode("open")}>Open</button>
        <button type="button" aria-pressed={postMode === "form"} onClick={() => setPostMode("form")}>Form</button>
      </div>
      {postMode === "form" ? <div className="queue-builder">
        <label><span>Instructions</span><textarea rows={3} value={definition.instructions} onChange={(event) => setDefinition({ ...definition, instructions: event.target.value })} /></label>
        {definition.fields.map((field, index) => <div className="field-builder" key={field.id}>
          <input aria-label="Field label" value={field.label} onChange={(event) => updateField(index, { label: event.target.value })} />
          <select aria-label="Field type" value={field.type} onChange={(event) => updateField(index, { type: event.target.value as FormFieldType })}>{TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select>
          <label className="inline-check"><input type="checkbox" checked={field.required} onChange={(event) => updateField(index, { required: event.target.checked })} />Required</label>
          {field.type === "single_select" || field.type === "multi_select" ? <input aria-label="Options" placeholder="Options, separated by commas" value={field.options.join(", ")} onChange={(event) => updateField(index, { options: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} /> : null}
          <button type="button" aria-label={`Remove ${field.label || "field"}`} onClick={() => setDefinition({ ...definition, fields: definition.fields.filter((_, position) => position !== index) })}><Trash2 size={14} /></button>
        </div>)}
        {definition.fields.length < 12 ? <button type="button" className="builder-add" onClick={() => setDefinition({ ...definition, fields: [...definition.fields, { id: `field-${crypto.randomUUID()}`, label: "", type: "short_text", required: false, options: [] }] })}><Plus size={14} />Add field</button> : null}
      </div> : null}</section>
      <section><h3>Feed order</h3><div className="segmented">
        <button type="button" aria-pressed={sortMode === "chronological"} onClick={() => { setSortMode("chronological"); setStatuses([]); }}>Chronological</button>
        <button type="button" aria-pressed={sortMode === "ranked"} onClick={() => setSortMode("ranked")}>Ranked by reaction</button>
      </div>{sortMode === "ranked" ? <label className="emoji-setting"><span>Voting emoji</span><input value={emoji} onChange={(event) => setEmoji(event.target.value)} maxLength={32} /></label> : null}</section>
      {sortMode === "ranked" ? <section><h3>Statuses</h3><label><span>Main tab name</span><input value={mainLabel} onChange={(event) => setMainLabel(event.target.value)} /></label>
        <div className="queue-builder">{statuses.map((status, index) => <div className="status-builder" key={status.id}>
          <input aria-label="Status label" value={status.label} onChange={(event) => setStatuses((current) => current.map((item, position) => position === index ? { ...item, label: event.target.value } : item))} />
          <select aria-label="Status privacy" value={status.visibility} onChange={(event) => setStatuses((current) => current.map((item, position) => position === index ? { ...item, visibility: event.target.value as "public" | "private" } : item))}><option value="public">Public</option><option value="private">Private</option></select>
          {status.visibility === "private" ? <input aria-label="Allowed member IDs" placeholder="Allowed member IDs, comma separated" value={status.allowedMemberIds.join(", ")} onChange={(event) => setStatuses((current) => current.map((item, position) => position === index ? { ...item, allowedMemberIds: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) } : item))} /> : null}
          <button type="button" aria-label={`Remove ${status.label || "status"}`} onClick={() => setStatuses((current) => current.filter((_, position) => position !== index))}><Trash2 size={14} /></button>
        </div>)}{statuses.length < 12 ? <button type="button" className="builder-add" onClick={() => setStatuses((current) => [...current, { id: `status-${crypto.randomUUID()}`, label: "", visibility: "public", allowedMemberIds: [] }])}><Plus size={14} />Add status</button> : null}</div>
      </section> : null}
      <div className="queue-save"><button className="primary" type="button" disabled={saving} onClick={() => void save()}>{saving ? "Saving" : "Save queue setup"}</button>{message ? <span role="status">{message}</span> : null}</div>
    </div>
  </details>;
}
