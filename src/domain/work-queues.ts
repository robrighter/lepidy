import { parseReactionEmoji } from "./rooms";

/** Pure form, ranking and private-status rules shared by every reader/writer. */

export const MAX_FORM_FIELDS = 12;
export const MAX_STATUSES = 12;
export const MAX_FORM_INSTRUCTIONS = 4_000;
export const MAX_FORM_VALUE = 8_000;

export type FormFieldType =
  | "short_text"
  | "long_text"
  | "number"
  | "single_select"
  | "multi_select"
  | "person"
  | "date";

export type FormField = {
  id: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  options: readonly string[];
};

export type FormDefinition = {
  instructions: string;
  fields: readonly FormField[];
};

export type FormAnswer = {
  fieldId: string;
  label: string;
  type: FormFieldType;
  value: string | readonly string[];
};

export type FormSubmission = {
  kind: "form_submission";
  formVersion: number;
  answers: readonly FormAnswer[];
};

export type QueueStatus = {
  id: string;
  label: string;
  visibility: "public" | "private";
  allowedMemberIds: readonly string[];
};

export type QueuePreset = "idea_board" | "support_queue" | "bug_tracker";

const FIELD_TYPES = new Set<FormFieldType>([
  "short_text", "long_text", "number", "single_select", "multi_select", "person", "date",
]);

const cleanLine = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const clean = value.trim().normalize("NFC").replaceAll(/\s+/g, " ");
  return clean.length > 0 && clean.length <= max ? clean : null;
};

export function parseFormDefinition(value: unknown): FormDefinition | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as { instructions?: unknown; fields?: unknown };
  if (typeof raw.instructions !== "string" || raw.instructions.length > MAX_FORM_INSTRUCTIONS) return null;
  if (!Array.isArray(raw.fields) || raw.fields.length < 1 || raw.fields.length > MAX_FORM_FIELDS) return null;
  const ids = new Set<string>();
  const labels = new Set<string>();
  const fields: FormField[] = [];
  for (const item of raw.fields) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const field = item as Record<string, unknown>;
    const id = cleanLine(field.id, 64);
    const label = cleanLine(field.label, 120);
    const type = field.type;
    if (id === null || label === null || !FIELD_TYPES.has(type as FormFieldType)) return null;
    if (ids.has(id) || labels.has(label.toLocaleLowerCase())) return null;
    ids.add(id);
    labels.add(label.toLocaleLowerCase());
    const options = Array.isArray(field.options)
      ? field.options.map((option) => cleanLine(option, 120))
      : [];
    if (options.some((option) => option === null) || options.length > 40) return null;
    const cleanOptions = options as string[];
    if (new Set(cleanOptions.map((option) => option.toLocaleLowerCase())).size !== cleanOptions.length) return null;
    if ((type === "single_select" || type === "multi_select") && cleanOptions.length < 1) return null;
    fields.push({ id, label, type: type as FormFieldType, required: field.required === true, options: cleanOptions });
  }
  return { instructions: raw.instructions.trim(), fields };
}

export function buildFormSubmission(
  definition: FormDefinition,
  formVersion: number,
  raw: Readonly<Record<string, unknown>>,
): FormSubmission {
  const known = new Set(definition.fields.map((field) => field.id));
  if (Object.keys(raw).some((id) => !known.has(id))) throw new Error("form contains an unknown field");
  const answers: FormAnswer[] = definition.fields.map((field) => {
    const candidate = raw[field.id];
    const values = field.type === "multi_select"
      ? (Array.isArray(candidate) ? candidate : candidate === undefined ? [] : [candidate])
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
    const value = field.type === "multi_select"
      ? [...new Set(values)]
      : typeof candidate === "string" ? candidate.trim().normalize("NFC") : "";
    const empty = Array.isArray(value) ? value.length === 0 : value.length === 0;
    if (field.required && empty) throw new Error(`${field.label} is required`);
    if ((Array.isArray(value) ? value.join("\n") : value).length > MAX_FORM_VALUE) {
      throw new Error(`${field.label} is too long`);
    }
    if (field.type === "number" && !empty && !Number.isFinite(Number(value))) throw new Error(`${field.label} must be a number`);
    if (field.type === "date" && !empty && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new Error(`${field.label} must be a date`);
    if (field.type === "single_select" && !empty && !field.options.includes(String(value))) throw new Error(`${field.label} has an invalid option`);
    if (field.type === "multi_select" && (value as readonly string[]).some((item) => !field.options.includes(item))) {
      throw new Error(`${field.label} has an invalid option`);
    }
    return { fieldId: field.id, label: field.label, type: field.type, value };
  });
  if (answers.every((answer) => Array.isArray(answer.value) ? answer.value.length === 0 : answer.value.length === 0)) {
    throw new Error("fill out at least one field");
  }
  return { kind: "form_submission", formVersion, answers };
}

const escapeLabel = (value: string): string => value.replaceAll("*", "\\*").replaceAll("_", "\\_");

export function renderFormSubmission(submission: FormSubmission): string {
  return submission.answers
    .filter((answer) => Array.isArray(answer.value) ? answer.value.length > 0 : answer.value.length > 0)
    .map((answer) => {
      const value = Array.isArray(answer.value) ? answer.value.join(", ") : answer.value;
      return answer.type === "long_text"
        ? `**${escapeLabel(answer.label)}:**\n${value}`
        : `**${escapeLabel(answer.label)}:** ${value}`;
    })
    .join("\n\n");
}

export function parseQueueStatuses(value: unknown): QueueStatus[] | null {
  if (!Array.isArray(value) || value.length > MAX_STATUSES) return null;
  const ids = new Set<string>();
  const labels = new Set<string>();
  const statuses: QueueStatus[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const raw = item as Record<string, unknown>;
    const id = cleanLine(raw.id, 64);
    const label = cleanLine(raw.label, 80);
    if (id === null || label === null || (raw.visibility !== "public" && raw.visibility !== "private")) return null;
    if (ids.has(id) || labels.has(label.toLocaleLowerCase())) return null;
    if (!Array.isArray(raw.allowedMemberIds) || raw.allowedMemberIds.some((member) => typeof member !== "string")) return null;
    ids.add(id);
    labels.add(label.toLocaleLowerCase());
    statuses.push({ id, label, visibility: raw.visibility, allowedMemberIds: [...new Set(raw.allowedMemberIds as string[])] });
  }
  return statuses;
}

export function maySeeQueueStatus(status: QueueStatus | null, memberId: string, isOwner: boolean): boolean {
  return status === null || status.visibility === "public" || isOwner || status.allowedMemberIds.includes(memberId);
}

export function rankQueueItems<T extends { voteCount: number; createdAt: number; id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => b.voteCount - a.voteCount || b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

export function queuePreset(preset: QueuePreset): {
  rankingEmoji: string;
  form: FormDefinition;
  statuses: QueueStatus[];
} {
  const title: FormField = { id: "title", label: "Title", type: "short_text", required: true, options: [] };
  const definitions = {
    idea_board: {
      rankingEmoji: "🔥",
      form: { instructions: "Share an idea and the outcome it would create.", fields: [title, { id: "details", label: "Details", type: "long_text", required: true, options: [] }] },
      statuses: ["Triage", "Planned", "In progress", "Shipped", "Won't do"],
    },
    support_queue: {
      rankingEmoji: "🆘",
      form: { instructions: "Tell the team what is blocked and how urgent it is.", fields: [title, { id: "urgency", label: "Urgency", type: "single_select", required: true, options: ["Low", "Normal", "High", "Urgent"] }, { id: "details", label: "Details", type: "long_text", required: true, options: [] }] },
      statuses: ["New", "Investigating", "Waiting", "Resolved"],
    },
    bug_tracker: {
      rankingEmoji: "🐛",
      form: { instructions: "Describe the problem and include a reproducible path.", fields: [title, { id: "steps", label: "Steps to reproduce", type: "long_text", required: true, options: [] }, { id: "severity", label: "Severity", type: "single_select", required: true, options: ["Low", "Medium", "High", "Critical"] }] },
      statuses: ["Triage", "Confirmed", "In progress", "Fixed"],
    },
  } as const;
  const selected = definitions[preset];
  if (parseReactionEmoji(selected.rankingEmoji) === null) throw new Error("preset has invalid emoji");
  return {
    rankingEmoji: selected.rankingEmoji,
    form: selected.form,
    statuses: selected.statuses.map((label, index) => ({ id: `status-${index + 1}`, label, visibility: "public" as const, allowedMemberIds: [] })),
  };
}
