import { MessageSquare } from "lucide-react";

import type { MessageRow } from "@/src/cloudflare/workspace-rooms";
import { AgentAvatar, Avatar } from "./avatar";

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 16);
}

/**
 * Read-only history. An agent is visibly an agent — a different avatar and a
 * standing badge — because telling a person from an agent at a glance is the
 * whole point of putting them in the same room.
 */
export function MessageList({ messages }: { messages: readonly MessageRow[] }) {
  return (
    <ol className="messages">
      {messages.map((message) => (
        <li key={message.id} className="message">
          {message.authorKind === "agent" ? (
            <AgentAvatar size={32} />
          ) : (
            <Avatar name={message.authorDisplaySnapshot} size={32} round />
          )}
          <div className="message-body">
            <p className="message-meta">
              <strong>{message.authorDisplaySnapshot}</strong>
              {message.authorKind === "agent" ? <span className="tag">agent</span> : null}
              <time dateTime={new Date(message.createdAt).toISOString()}>
                {formatTime(message.createdAt)}
              </time>
              {message.editedAt ? <span className="tag">edited</span> : null}
            </p>
            <p className="message-text">{message.bodyMarkdown}</p>
            {message.replyCount > 0 ? (
              <p className="message-thread">
                <MessageSquare size={13} aria-hidden="true" />
                {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
