import { describe, expect, it, vi } from "vitest";

import {
  MAX_UNFURL_BYTES,
  externalLinksFromMarkdown,
  fetchLinkUnfurl,
} from "./link-unfurl";

const publicDns = async () => ["93.184.216.34"];

describe("bounded link unfurls", () => {
  it("C08B-RULE-001 finds only three distinct HTTPS links outside code", () => {
    expect(externalLinksFromMarkdown([
      "https://one.example/a#fragment and [two](https://two.example/b)",
      "`https://code.example/no` and http://plain.example/no",
      "```txt",
      "https://fence.example/no",
      "```",
      "https://one.example/a#other https://three.example/c https://four.example/d",
    ].join("\n"))).toEqual([
      "https://one.example/a",
      "https://two.example/b",
      "https://three.example/c",
    ]);
  });

  it("C08B-RULE-002 revalidates a redirect and returns bounded text metadata", async () => {
    const resolve = vi.fn(publicDns);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://docs.example/final" } }))
      .mockResolvedValueOnce(new Response(
        '<html><head><meta content="Lepidy &amp; friends" property="og:title"><meta name="description" content="A <safe> description"><meta property="og:site_name" content="Docs"></head></html>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ));
    await expect(fetchLinkUnfurl({ url: "https://start.example/path#ignored", resolve, fetcher })).resolves.toEqual({
      url: "https://start.example/path",
      finalUrl: "https://docs.example/final",
      title: "Lepidy & friends",
      description: "A description",
      siteName: "Docs",
    });
    expect(resolve).toHaveBeenCalledWith("start.example");
    expect(resolve).toHaveBeenCalledWith("docs.example");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("C08B-RULE-003 refuses private redirects, excessive chains, non-HTML and oversized streams", async () => {
    await expect(fetchLinkUnfurl({
      url: "https://public.example",
      resolve: async (hostname) => hostname === "private.example" ? ["127.0.0.1"] : publicDns(),
      fetcher: async () => new Response(null, { status: 302, headers: { location: "https://private.example/admin" } }),
    })).rejects.toThrow("strictly public");

    await expect(fetchLinkUnfurl({
      url: "https://public.example",
      resolve: publicDns,
      fetcher: async () => new Response("binary", { headers: { "content-type": "application/octet-stream" } }),
    })).rejects.toThrow("not HTML");

    await expect(fetchLinkUnfurl({
      url: "https://public.example",
      resolve: publicDns,
      fetcher: async () => new Response(`<title>x</title>${"a".repeat(MAX_UNFURL_BYTES)}`, { headers: { "content-type": "text/html" } }),
    })).rejects.toThrow("too large");

    let redirect = 0;
    await expect(fetchLinkUnfurl({
      url: "https://public.example",
      resolve: publicDns,
      fetcher: async () => new Response(null, { status: 302, headers: { location: `https://public.example/${redirect++}` } }),
    })).rejects.toThrow("too many");
  });

  it("C08B-RULE-004 shares one deadline across the entire request", async () => {
    await expect(fetchLinkUnfurl({
      url: "https://public.example",
      resolve: publicDns,
      timeoutMs: 5,
      fetcher: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    })).rejects.toMatchObject({ name: "AbortError" });

    await expect(fetchLinkUnfurl({
      url: "https://public.example",
      timeoutMs: 5,
      resolve: async () => new Promise<readonly string[]>(() => undefined),
      fetcher: async () => new Response("<title>never reached</title>"),
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});
