"use client";

import { ChevronDown, ChevronRight, FileCode2 } from "lucide-react";
import { useState } from "react";

import type { SnippetRow } from "@/src/cloudflare/workspace-rooms";

/** Beyond this a snippet is collapsed, because a room is not a file viewer. */
const PREVIEW_LINES = 12;

export function Snippet({ snippet }: { snippet: SnippetRow }) {
  const [open, setOpen] = useState(snippet.lineCount <= PREVIEW_LINES);
  const lines = snippet.body.split("\n");
  const shown = open ? lines : lines.slice(0, PREVIEW_LINES);

  return (
    <figure className="snippet">
      <figcaption>
        <FileCode2 size={13} aria-hidden="true" />
        <strong>{snippet.title}</strong>
        {snippet.language ? <span className="tag">{snippet.language}</span> : null}
        <span className="snippet-lines">
          {snippet.lineCount} {snippet.lineCount === 1 ? "line" : "lines"}
        </span>
      </figcaption>
      <pre data-language={snippet.language ?? undefined}>
        <code>{shown.join("\n")}</code>
      </pre>
      {snippet.lineCount > PREVIEW_LINES ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
          {open ? "Show less" : `Show all ${snippet.lineCount} lines`}
        </button>
      ) : null}
    </figure>
  );
}
