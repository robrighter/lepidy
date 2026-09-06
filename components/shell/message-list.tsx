import { MessageSquare, Pencil, Trash2 } from "lucide-react";

import type { MessageRow } from "@/src/cloudflare/workspace-rooms";
import { AgentAvatar, Avatar } from "./avatar";
import { Markdown } from "./markdown";

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 16);
}

/**
 * Read-only history. An agent is visibly an agent — a different avatar and a
 * standing badge — because telling a person from an agent at a glance is the
 * whole point of putting them in the same room. Agent output is long and
 * procedural, so a reply that lives in a thread is shown as a thread.
 */
export function MessageList({ messages }: { messages: readonly MessageRow[] }) {
  return (
    <ol className="messages">
      {messages.map((message) => {
        const deleted = message.deletedAt !== null;
        return (
          <li key={message.id} className="message" data-author-kind={message.authorKind}>
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
                {message.editedAt && !deleted ? (
                  <span className="tag" title={`Edited ${message.editCount} time(s)`}>
                    <Pencil size={11} aria-hidden="true" /> edited
                  </span>
                ) : null}
              </p>

              {deleted ? (
                <p className="message-text message-deleted">
                  <Trash2 size={13} aria-hidden="true" /> This message was deleted.
                </p>
              ) : (
                <Markdown body={message.bodyMarkdown} />
              )}

              {message.reactions.length > 0 ? (
                <ul className="reactions">
                  {message.reactions.map((reaction) => (
                    <li key={reaction.emoji}>
                      <span aria-hidden="true">{reaction.emoji}</span>
                      <span className="visually-hidden">
                        {reaction.emoji} reacted by {reaction.memberIds.length}
                      </span>
                      <b>{reaction.memberIds.length}</b>
                    </li>
                  ))}
                </ul>
              ) : null}

              {message.replyCount > 0 ? (
                <p className="message-thread">
                  <MessageSquare size={13} aria-hidden="true" />
                  {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
