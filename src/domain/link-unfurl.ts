import { validatePublicCallbackUrl } from "./cloud-custom-runtime";

/** A preview is deliberately text-only. Remote markup and image URLs never enter the UI. */
export type LinkUnfurl = {
  url: string;
  finalUrl: string;
  title: string;
  description: string | null;
  siteName: string;
};

export const MAX_UNFURL_BYTES = 64 * 1024;
export const MAX_UNFURL_REDIRECTS = 3;
export const UNFURL_TIMEOUT_MS = 4_000;
export const UNFURL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const UNFURL_FAILURE_TTL_MS = 60 * 60 * 1000;
export const MAX_UNFURLS_PER_MESSAGE = 3;
export const MAX_UNFURL_FETCHES_PER_READ = 3;

/**
 * External HTTPS links in rendered Markdown, in appearance order.
 *
 * Code spans/blocks are intentionally absent because the Markdown parser has
 * already classified them as code rather than links. Relative and mail links
 * may render, but do not cause server egress.
 */
export function externalLinksFromMarkdown(body: string): readonly string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    try {
      const url = new URL(raw.trim());
      if (url.protocol !== "https:") return;
      url.hash = "";
      const value = url.toString();
      if (!seen.has(value) && urls.length < MAX_UNFURLS_PER_MESSAGE) {
        seen.add(value);
        urls.push(value);
      }
    } catch {
      // The Markdown renderer will show an invalid URL as text.
    }
  };

  let inFence = false;
  for (const line of body.replaceAll("\r\n", "\n").split("\n")) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const withoutCode = line.replace(/`[^`\n]+`/g, "");
    for (const match of withoutCode.matchAll(/\[[^\]\n]{1,200}\]\((https:\/\/[^)\s]{1,2048})\)|https:\/\/[^\s<>()]{1,2048}/g)) {
      add(match[1] ?? match[0]);
    }
  }
  return urls;
}

/**
 * Fetch one text-only link preview under the same public-egress guard used by
 * custom callbacks. Every redirect is resolved and validated again, the whole
 * chain shares one deadline, and the decoded response is bounded while read.
 */
export async function fetchLinkUnfurl(input: {
  url: string;
  resolve: (hostname: string) => Promise<readonly string[]>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): Promise<LinkUnfurl> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? UNFURL_TIMEOUT_MS);

  try {
    const original = await withAbort(validateWithoutFragment(input.url, input.resolve), controller.signal);
    let current = original;
    for (let redirects = 0; redirects <= MAX_UNFURL_REDIRECTS; redirects += 1) {
      const response = await (input.fetcher ?? fetch)(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "text/html,application/xhtml+xml;q=0.9",
          "user-agent": "Lepidy-Link-Preview/1.0",
        },
      });

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        if (redirects === MAX_UNFURL_REDIRECTS) throw new Error("link preview redirected too many times");
        const location = response.headers.get("location");
        if (!location) throw new Error("link preview redirect had no location");
        current = await withAbort(validateWithoutFragment(new URL(location, current).toString(), input.resolve), controller.signal);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`link preview returned ${response.status}`);
      }

      const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (type !== "text/html" && type !== "application/xhtml+xml") {
        await response.body?.cancel();
        throw new Error("link preview is not HTML");
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_UNFURL_BYTES) {
        await response.body?.cancel();
        throw new Error("link preview is too large");
      }
      const html = await readBoundedText(response, MAX_UNFURL_BYTES);
      const title = cleanText(metadata(html, "property", "og:title") ?? titleText(html) ?? "", 200);
      if (!title) throw new Error("link preview has no title");
      const description = metadata(html, "property", "og:description") ?? metadata(html, "name", "description");
      const siteName = metadata(html, "property", "og:site_name") ?? current.hostname;
      return {
        url: original.toString(),
        finalUrl: current.toString(),
        title,
        description: description ? cleanText(description, 320) : null,
        siteName: cleanText(siteName, 100),
      };
    }
    throw new Error("link preview redirected too many times");
  } finally {
    clearTimeout(timeout);
  }
}

async function validateWithoutFragment(
  value: string,
  resolve: (hostname: string) => Promise<readonly string[]>,
): Promise<URL> {
  const url = new URL(value);
  url.hash = "";
  return validatePublicCallbackUrl(url.toString(), resolve);
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error("link preview is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function metadata(html: string, attribute: "name" | "property", expected: string): string | null {
  for (const tag of html.match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) ?? []) {
    const attrs = attributes(tag);
    if (attrs.get(attribute)?.toLowerCase() === expected && attrs.get("content")) return attrs.get("content")!;
  }
  return null;
}

function titleText(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return match?.[1] ?? null;
}

function attributes(tag: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    result.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

function cleanText(value: string, limit: number): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " ")).replaceAll(/\s+/g, " ").trim().slice(0, limit);
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"', nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === "#") {
      const point = body[1]?.toLowerCase() === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return named[body.toLowerCase()] ?? entity;
  });
}
