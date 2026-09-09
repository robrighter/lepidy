export type SearchHas = "file" | "link" | "code";

export type ParsedSearchQuery = {
  text: string;
  from: readonly string[];
  in: readonly string[];
  has: readonly SearchHas[];
  before: number | null;
  after: number | null;
  isThread: boolean;
  errors: readonly string[];
};

const OPERATOR = /(?:^|\s)(from|in|has|before|after|is):([^\s]+)/gi;

/** Parse the complete v1 operator set without ever passing user syntax to FTS5. */
export function parseSearchQuery(input: string): ParsedSearchQuery {
  const from: string[] = [];
  const rooms: string[] = [];
  const has: SearchHas[] = [];
  const errors: string[] = [];
  let before: number | null = null;
  let after: number | null = null;
  let isThread = false;

  const text = input.trim().slice(0, 500).replace(OPERATOR, (_token, operator: string, rawValue: string) => {
    const value = rawValue.trim();
    switch (operator.toLowerCase()) {
      case "from": addDistinct(from, value.replace(/^@/, "").toLowerCase(), "from", errors); break;
      case "in": addDistinct(rooms, value.replace(/^#/, "").toLowerCase(), "in", errors); break;
      case "has": {
        const normalized = value.toLowerCase();
        if (normalized === "file" || normalized === "link" || normalized === "code") addDistinct(has, normalized, "has", errors);
        else errors.push(`has:${value} is not supported`);
        break;
      }
      case "before": {
        const date = day(value);
        if (date === null) errors.push(`before:${value} needs a real YYYY-MM-DD date`);
        else before = date;
        break;
      }
      case "after": {
        const date = day(value);
        if (date === null) errors.push(`after:${value} needs a real YYYY-MM-DD date`);
        else after = date;
        break;
      }
      case "is":
        if (value.toLowerCase() === "thread") isThread = true;
        else errors.push(`is:${value} is not supported`);
        break;
    }
    return " ";
  }).replace(/\s+/g, " ").trim();

  if (before !== null && after !== null && after >= before) errors.push("after: must be earlier than before:");
  return { text, from, in: rooms, has, before, after, isThread, errors };
}

/** A safe deterministic MATCH expression; raw FTS operators never survive. */
export function searchMatch(text: string): string | null {
  const terms = text.normalize("NFKC").match(/[\p{L}\p{N}_]{2,64}/gu)?.slice(0, 16) ?? [];
  return terms.length === 0 ? null : terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
}

export function searchCursor(value: string | null | undefined): number {
  return value && /^\d{1,4}$/.test(value) ? Math.min(Number(value), 1000) : 0;
}

export function nextSearchCursor(offset: number, limit: number, available: number): string | null {
  return available > offset + limit ? String(offset + limit) : null;
}

function day(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return timestamp;
}

function addDistinct<T extends string>(target: T[], value: T, operator: string, errors: string[]): void {
  if (!value || !/^[a-z0-9._-]{1,100}$/i.test(value)) errors.push(`${operator}: has an invalid value`);
  else if (!target.includes(value)) target.push(value);
}
