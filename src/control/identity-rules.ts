export function normalizeEmail(email: string): string {
  return email.trim().normalize("NFKC").toLowerCase();
}

export function validateHumanHandle(handle: string): string {
  const normalized = handle.trim().normalize("NFKC").toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(normalized)) {
    throw new Error("handle must be 2-32 letters, numbers, dots, underscores or hyphens");
  }
  if (normalized.startsWith("a.") || normalized.startsWith("g.")) {
    throw new Error("human handles cannot use the a. or g. namespace");
  }
  return normalized;
}
