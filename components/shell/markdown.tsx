import type { ReactNode } from "react";

import type { BlockNode, InlineNode } from "@/src/domain/markdown";
import { parseMarkdown } from "@/src/domain/markdown";

/**
 * Renders the parsed tree as elements.
 *
 * There is no `dangerouslySetInnerHTML` anywhere on this path. A message body
 * becomes React nodes or it becomes text; it never becomes markup, so there is
 * no sanitiser standing between a user's typing and the page.
 */

function renderInline(nodes: readonly InlineNode[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}.${index}`;
    switch (node.type) {
      case "text":
        return <span key={key}>{node.value}</span>;
      case "code":
        return <code key={key}>{node.value}</code>;
      case "strong":
        return <strong key={key}>{renderInline(node.children, key)}</strong>;
      case "emphasis":
        return <em key={key}>{renderInline(node.children, key)}</em>;
      case "strike":
        return <s key={key}>{renderInline(node.children, key)}</s>;
      case "link":
        return (
          <a key={key} href={node.href} rel="noreferrer noopener" target="_blank">
            {renderInline(node.children, key)}
          </a>
        );
      case "mention":
        return (
          <span key={key} className={`mention mention-${node.kind}`} data-mention-kind={node.kind}>
            {node.label}
          </span>
        );
    }
  });
}

function renderBlock(block: BlockNode, key: string): ReactNode {
  switch (block.type) {
    case "paragraph":
      return <p key={key}>{renderInline(block.children, key)}</p>;
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
          {block.children.map((child, index) => renderBlock(child, `${key}.${index}`))}
        </blockquote>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={`${key}.${index}`}>{renderInline(item, `${key}.${index}`)}</li>
      ));
      return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
  }
}

export function Markdown({ body }: { body: string }): ReactNode {
  const blocks = parseMarkdown(body);
  return <div className="markdown">{blocks.map((block, index) => renderBlock(block, `b${index}`))}</div>;
}
