/**
 * File rules: names, keys, quota arithmetic and the upload lifecycle.
 *
 * Everything decidable about a file lives here rather than in the Durable
 * Object method that happens to call it, so the tenancy assertion in a key and
 * the arithmetic behind "you are out of space" are table-tested without a
 * workspace.
 */

export type FileState = "reserved" | "stored" | "deleted";

/** Gibibytes, because a quota the user was sold in GB should not drift by 7%. */
const GIB = 1024 * 1024 * 1024;

export const TEAM_BASE_QUOTA_BYTES = 25 * GIB;
export const TEAM_INCLUDED_SEATS = 5;
export const TEAM_BYTES_PER_EXTRA_SEAT = 5 * GIB;
export const STORAGE_PACK_BYTES = 100 * GIB;

/** One upload's ceiling. Larger than this belongs in a bucket the user owns. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Warn here, block at the quota itself (PRD §11: warn, then refuse; never delete). */
export const QUOTA_WARN_FRACTION = 0.8;

/**
 * A reservation that never gets confirmed is a hole in the quota, so it expires
 * and is swept rather than counted forever.
 */
export const RESERVATION_TTL_MS = 60 * 60 * 1000;

/**
 * Team storage allowance (PRD §11.3): 25 GiB, plus 5 GiB for every paid seat
 * above the five the plan includes, plus any explicitly purchased 100 GiB pack.
 */
export function teamStorageQuotaBytes(input: { seatQuantity: number; storagePackCount: number }): number {
  if (!Number.isSafeInteger(input.seatQuantity) || input.seatQuantity < 1) throw new Error("seat quantity is invalid");
  if (!Number.isSafeInteger(input.storagePackCount) || input.storagePackCount < 0) throw new Error("storage pack count is invalid");
  const extraSeats = Math.max(0, input.seatQuantity - TEAM_INCLUDED_SEATS);
  return TEAM_BASE_QUOTA_BYTES + extraSeats * TEAM_BYTES_PER_EXTRA_SEAT + input.storagePackCount * STORAGE_PACK_BYTES;
}

export type QuotaDecision =
  | { outcome: "allow"; usedAfterBytes: number; warn: boolean }
  | { outcome: "refuse"; reason: string };

/**
 * Whether one more upload fits.
 *
 * Refusing is the only correct answer at the ceiling: the accepted commercial
 * boundary says to block new uploads rather than delete anything to make room,
 * so nothing here ever proposes eviction.
 */
export function quotaDecision(input: {
  quotaBytes: number;
  usedBytes: number;
  incomingBytes: number;
}): QuotaDecision {
  if (!Number.isSafeInteger(input.incomingBytes) || input.incomingBytes <= 0) {
    return { outcome: "refuse", reason: "a file must have a positive byte length" };
  }
  if (input.incomingBytes > MAX_FILE_BYTES) {
    return { outcome: "refuse", reason: `a single file is limited to ${MAX_FILE_BYTES} bytes` };
  }
  const usedAfterBytes = input.usedBytes + input.incomingBytes;
  if (usedAfterBytes > input.quotaBytes) {
    return { outcome: "refuse", reason: "this workspace is out of attachment storage" };
  }
  return { outcome: "allow", usedAfterBytes, warn: usedAfterBytes >= input.quotaBytes * QUOTA_WARN_FRACTION };
}

// Control characters and both path separators. Written with explicit escapes:
// `[ -/]` reads like "space or slash" and is really every character between.
const UNSAFE_NAME = /[\u0000-\u001f\u007f/\\]/;

/**
 * A stored file name that is safe to put in a key, a header and a page.
 *
 * Path separators and control characters are refused rather than stripped: a
 * name that had to be rewritten to be safe is a name the uploader should see
 * refused, not one silently turned into something else.
 */
export function parseFileName(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("a file needs a name");
  const name = raw.trim().normalize("NFC");
  if (name.length === 0 || name.length > 200) throw new Error("a file name must be 1-200 characters");
  if (UNSAFE_NAME.test(name)) throw new Error("a file name cannot contain path separators or control characters");
  if (name === "." || name === "..") throw new Error("that file name is reserved");
  return name;
}

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

export function parseMediaType(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("a file needs a media type");
  // Parameters (`; charset=…`) are dropped: nothing downstream reads them and
  // they are the half of the header that carries surprises.
  const value = raw.split(";")[0]!.trim().toLowerCase();
  if (!MEDIA_TYPE.test(value)) throw new Error("that media type is not valid");
  return value;
}

/** Images are the only type rendered inline; everything else is offered as a download. */
export function isInlineRenderable(mediaType: string): boolean {
  return ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(mediaType);
}

/**
 * The object key, whose prefix is itself the tenancy assertion (HLD §5.4). A
 * listing scoped to `ws/<id>/` cannot span tenants, so the workspace id is not
 * decoration here — it is the boundary.
 */
export function fileObjectKey(input: {
  workspaceId: string;
  fileId: string;
  fileName: string;
  now: number;
}): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.workspaceId)) throw new Error("workspace id is not key-safe");
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.fileId)) throw new Error("file id is not key-safe");
  const name = parseFileName(input.fileName);
  const at = new Date(input.now);
  if (Number.isNaN(at.getTime())) throw new Error("upload time is invalid");
  const year = String(at.getUTCFullYear()).padStart(4, "0");
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `ws/${input.workspaceId}/${year}/${month}/${input.fileId}/${encodeURIComponent(name)}`;
}

/**
 * Every read of a key checks it against the workspace that asked, so a stored
 * key can never be replayed against another tenant's object even if a row were
 * somehow wrong.
 */
export function assertKeyBelongsToWorkspace(key: string, workspaceId: string): void {
  if (!key.startsWith(`ws/${workspaceId}/`)) throw new Error("that object does not belong to this workspace");
}

export function fileStateTransition(from: FileState, to: FileState): void {
  const allowed: Record<FileState, readonly FileState[]> = {
    reserved: ["stored", "deleted"],
    stored: ["deleted"],
    deleted: [],
  };
  if (!allowed[from].includes(to)) throw new Error(`a ${from} file cannot become ${to}`);
}
