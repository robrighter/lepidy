import type { ReactNode } from "react";

import type { BlockNode, InlineNode } from "@/src/domain/markdown";
import { parseMarkdown } from "@/src/domain/markdown";
import type { MentionCard } from "@/src/domain/people";

/** Cards keyed by the mention handle they belong to; empty is a valid answer. */
type CardIndex = ReadonlyMap<string, MentionCard>;

const NO_CARDS: CardIndex = new Map();

/**
 * Renders the parsed tree as elements.
 *
 * There is no `dangerouslySetInnerHTML` anywhere on this path. A message body
 * becomes React nodes or it becomes text; it never becomes markup, so there is
 * no sanitiser standing between a user's typing and the page.
 */

function renderInline(nodes: readonly InlineNode[], keyPrefix: string, cards: CardIndex, idPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}.${index}`;
    switch (node.type) {
      case "text":
        return <span key={key}>{node.value}</span>;
      case "code":
        return <code key={key}>{node.value}</code>;
      case "strong":
        return <strong key={key}>{renderInline(node.children, key, cards, idPrefix)}</strong>;
      case "emphasis":
        return <em key={key}>{renderInline(node.children, key, cards, idPrefix)}</em>;
      case "strike":
        return <s key={key}>{renderInline(node.children, key, cards, idPrefix)}</s>;
      case "link":
        return (
          <a key={key} href={node.href} rel="noreferrer noopener" target="_blank">
            {renderInline(node.children, key, cards, idPrefix)}
          </a>
        );
      case "mention": {
        const card = node.handle ? cards.get(node.handle) : undefined;
        if (!card) {
          return (
            <span key={key} className={`mention mention-${node.kind}`} data-mention-kind={node.kind}>
              {node.label}
            </span>
          );
        }
        // The card is a sibling of the name inside one hover/focus target, so
        // it opens on pointer and on keyboard alike with no client script. The
        // id carries the caller's prefix because every message restarts its own
        // key numbering, and two cards sharing a DOM id would leave
        // `aria-describedby` pointing at whichever one came first.
        const cardId = `card-${idPrefix}-${keyPrefix}-${index}`;
        return (
          <span key={key} className="mention-anchor">
            <span
              aria-describedby={cardId}
              className={`mention mention-${node.kind}`}
              data-mention-kind={node.kind}
              tabIndex={0}
            >
              {node.label}
            </span>
            <MentionHovercard card={card} id={cardId} />
          </span>
        );
      }
    }
  });
}

function MentionHovercard({ card, id }: { card: MentionCard; id: string }): ReactNode {
  return (
    <span className="mention-card" id={id} role="tooltip">
      <span className="mention-card-name">{card.title}</span>
      <span className="mention-card-handle">@{card.handle}</span>
      <span className="mention-card-subtitle">{card.subtitle}</span>
      {card.status ? <span className="mention-card-status">{card.status}</span> : null}
      <span className="mention-card-facts">
        {card.facts.map((fact) => (
          <span key={fact}>{fact}</span>
        ))}
      </span>
    </span>
  );
}

function renderBlock(block: BlockNode, key: string, cards: CardIndex, idPrefix: string): ReactNode {
  switch (block.type) {
    case "paragraph":
      return <p key={key}>{renderInline(block.children, key, cards, idPrefix)}</p>;
    case "code_block":
      return (
        <pre key={key} data-language={block.language ?? undefined}>
          {block.language ? <span className="code-language">{block.language}</span> : null}
          <code>{block.value}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote key={key}>
          {block.children.map((child, index) => renderBlock(child, `${key}.${index}`, cards, idPrefix))}
        </blockquote>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={`${key}.${index}`}>{renderInline(item, `${key}.${index}`, cards, idPrefix)}</li>
      ));
      return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
  }
}

export function Markdown({
  body,
  cards = NO_CARDS,
  /** Distinguishes this body's hovercard ids from every other body on the page. */
  idPrefix = "m",
}: {
  body: string;
  cards?: CardIndex;
  idPrefix?: string;
}): ReactNode {
  const blocks = parseMarkdown(body);
  return (
    <div className="markdown">
      {blocks.map((block, index) => renderBlock(block, `b${index}`, cards, idPrefix))}
    </div>
  );
}

