import { classifyMentionHandle, type MentionKind } from "./mention-handle";

/**
 * A deliberately small Markdown subset, parsed to a tree.
 *
 * The tree is the point: nothing here ever produces HTML, so there is no
 * sanitiser to get wrong and no path by which a message body becomes markup. A
 * renderer walks these nodes and builds elements. The subset is chosen for the
 * people who use this product — fenced code with a language is the first-class
 * case, not an afterthought.
 */

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "emphasis"; children: InlineNode[] }
  | { type: "strike"; children: InlineNode[] }
  | { type: "link"; href: string; children: InlineNode[] }
  | { type: "mention"; kind: MentionKind; handle: string; label: string };

export type BlockNode =
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "code_block"; language: string | null; value: string }
  | { type: "quote"; children: BlockNode[] }
  | { type: "list"; ordered: boolean; items: InlineNode[][] };

/** Only schemes a message may safely link to. Everything else becomes text. */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export function isSafeLinkHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.length === 0 || trimmed.length > 2_048) return false;
  // A relative link stays inside the app and cannot carry a scheme.
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return true;
  try {
    return SAFE_SCHEMES.has(new URL(trimmed).protocol);
  } catch {
    return false;
  }
}

const CODE_FENCE = /^```([A-Za-z0-9+#._-]{0,24})\s*$/;
const LIST_ITEM = /^\s*([-*]|\d{1,3}[.)])\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

export function parseMarkdown(body: string): BlockNode[] {
  const lines = body.replaceAll("\r\n", "\n").split("\n");
  const blocks: BlockNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    const fence = CODE_FENCE.exec(line);
    if (fence) {
      const language = fence[1].length > 0 ? fence[1].toLowerCase() : null;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      // An unterminated fence still renders as code rather than losing the text.
      index += 1;
      blocks.push({ type: "code_block", language, value: body.join("\n") });
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        quoted.push(QUOTE.exec(lines[index])![1]);
        index += 1;
      }
      blocks.push({ type: "quote", children: parseMarkdown(quoted.join("\n")) });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[1]);
      const items: InlineNode[][] = [];
      while (index < lines.length) {
        const next = LIST_ITEM.exec(lines[index]);
        if (!next || /\d/.test(next[1]) !== ordered) break;
        items.push(parseInline(next[2]));
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      if (
        current.trim().length === 0 ||
        CODE_FENCE.test(current) ||
        QUOTE.test(current) ||
        LIST_ITEM.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
  }

  return blocks;
}

/**
 * Inline scanning is ordered, and the order is the contract: a code span wins
 * over everything inside it, so `@a.deploybot` in backticks is text and can
 * never address an agent.
 */
export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let text = "";
  let index = 0;

  const flush = (): void => {
    if (text.length > 0) {
      nodes.push({ type: "text", value: text });
      text = "";
    }
  };

  while (index < source.length) {
    const rest = source.slice(index);

    const code = /^`([^`\n]+)`/.exec(rest);
    if (code) {
      flush();
      nodes.push({ type: "code", value: code[1] });
      index += code[0].length;
      continue;
    }

    const link = /^\[([^\]\n]{1,200})\]\(([^)\s]{1,2048})\)/.exec(rest);
    if (link) {
      if (isSafeLinkHref(link[2])) {
        flush();
        nodes.push({ type: "link", href: link[2].trim(), children: parseInline(link[1]) });
        index += link[0].length;
        continue;
      }
      // An unsafe scheme is shown as the text somebody typed, never as a link.
      text += link[0];
      index += link[0].length;
      continue;
    }

    const autolink = /^https?:\/\/[^\s<>()]{1,2048}/.exec(rest);
    if (autolink && isSafeLinkHref(autolink[0])) {
      flush();
      nodes.push({ type: "link", href: autolink[0], children: [{ type: "text", value: autolink[0] }] });
      index += autolink[0].length;
      continue;
    }

    // The `@` must start a word, or the domain half of an email address reads
    // as a mention.
    const previous = index === 0 ? "" : source[index - 1];
    const startsWord = previous === "" || !/[A-Za-z0-9._@-]/.test(previous);
    const mention = startsWord ? /^@([a-z0-9][a-z0-9._-]{0,63})/i.exec(rest) : null;
    if (mention) {
      const trimmed = mention[1].replace(/[._-]+$/, "");
      if (trimmed.length > 0) {
        flush();
        const classified = classifyMentionHandle(trimmed);
        nodes.push({
          type: "mention",
          kind: classified.kind,
          handle: classified.handle,
          label: `@${trimmed}`,
        });
        index += trimmed.length + 1;
        continue;
      }
    }

    const strong = /^\*\*([^\n]+?)\*\*/.exec(rest);
    if (strong) {
      flush();
      nodes.push({ type: "strong", children: parseInline(strong[1]) });
      index += strong[0].length;
      continue;
    }

    const strike = /^~~([^\n]+?)~~/.exec(rest);
    if (strike) {
      flush();
      nodes.push({ type: "strike", children: parseInline(strike[1]) });
      index += strike[0].length;
      continue;
    }

    const emphasis = /^(\*|_)([^\n*_]+?)\1/.exec(rest);
    if (emphasis) {
      flush();
      nodes.push({ type: "emphasis", children: parseInline(emphasis[2]) });
      index += emphasis[0].length;
      continue;
    }

    text += source[index];
    index += 1;
  }

  flush();
  return nodes;
}

/** Plain text of a rendered body, for previews and notification summaries. */
export function toPlainText(blocks: readonly BlockNode[]): string {
  const inline = (nodes: readonly InlineNode[]): string =>
    nodes
      .map((node) => {
        switch (node.type) {
          case "text":
          case "code":
            return node.value;
          case "mention":
            return node.label;
          default:
            return inline(node.children);
        }
      })
      .join("");

  return blocks
    .map((block) => {
      switch (block.type) {
        case "paragraph":
          return inline(block.children);
        case "code_block":
          return block.value;
        case "quote":
          return toPlainText(block.children);
        case "list":
          return block.items.map(inline).join("\n");
      }
    })
    .join("\n")
    .trim();
}
