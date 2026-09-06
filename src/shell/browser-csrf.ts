/** Read at submission time, so rotation in another tab is respected. */
export function browserCsrfToken(): string {
  return document.cookie.split("; ").find((cookie) => cookie.startsWith("lepidy_csrf="))?.slice(12) ?? "";
}
