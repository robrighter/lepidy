import { Pin } from "lucide-react";

import { Composer } from "@/components/shell/composer";
import { MessageList } from "@/components/shell/message-list";
import { channelHistory } from "@/src/shell/channel-context";
import { shellState } from "@/src/shell/shell-context";
import { channelLabel } from "@/src/shell/shell-model";

/** How many messages a room shows before "Show older" is offered. */
const PAGE = 20;

export default async function ChannelPage({
  params,
  searchParams,
}: {
  params: Promise<{ channel: string }>;
  searchParams: Promise<{ show?: string }>;
}) {
  const { channel: key } = await params;
  const { show } = await searchParams;
  const state = await shellState();
  const channel =
    state.status === "ready"
      ? state.snapshot.channels.find((item) => item.slug === key || item.id === key)
      : undefined;

  // A room the viewer cannot see is reported as missing, never as forbidden.
  if (!channel) {
    return (
      <section className="empty-state">
        <h2>Channel not available</h2>
        <p>No channel here is visible to you under that name.</p>
        <span className="next-step">A private room is only listed for its own members.</span>
      </section>
    );
  }

  // Paging widens the window rather than replacing it, so revealing older
  // messages leaves everything already on screen exactly where it was.
  const pages = Math.min(Math.max(Number(show ?? "1") || 1, 1), 20);
  const history = await channelHistory(channel.id, PAGE * pages);
  const viewerMemberId = state.status === "ready" ? state.snapshot.viewer.memberId : undefined;
  const canPost = channel.isMember;
  const forwardTargets =
    state.status === "ready"
      ? state.snapshot.channels
          .filter((item) => item.id !== channel.id && item.isMember)
          .map((item) => ({ id: item.id, label: channelLabel(item) }))
      : [];

  return (
    <>
      <section className="panel">
        <h2>#{channelLabel(channel)}</h2>
        <p>
          {channel.kind === "public" ? "Public" : "Private"} channel ·{" "}
          {channel.isMember ? "you are a member" : "you have not joined this room"}
        </p>
      </section>

      {history.status === "ready" && history.pins.length > 0 ? (
        <section className="panel pinned" aria-label="Pinned messages">
          <h2>
            <Pin size={14} aria-hidden="true" /> Pinned
          </h2>
          <ul className="pinned-list">
            {history.pins.map((message) => (
              <li key={message.id}>
                <strong>{message.authorDisplaySnapshot}</strong>
                <span>{message.bodyMarkdown.slice(0, 160)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {history.status === "unavailable" ? (
        <section className="empty-state">
          <h2>History is unavailable</h2>
          <p>{history.reason}</p>
          <span className="next-step">Nothing was shown because authority could not be confirmed.</span>
        </section>
      ) : history.status === "not_found" || history.page.messages.length === 0 ? (
        <section className="empty-state">
          <h2>No messages yet</h2>
          <p>Nothing has been posted in this room.</p>
          <span className="next-step">Say something below to start this room off.</span>
        </section>
      ) : (
        <section className="panel">
          {history.page.nextCursor ? (
            <p className="history-more">
              <a className="show-older" href={`?show=${pages + 1}#older-boundary`}>
                Show older messages
              </a>
            </p>
          ) : (
            <p className="history-more muted">You have reached the start of this room.</p>
          )}
          <span id="older-boundary" />
          <MessageList
            messages={[...history.page.messages].reverse()}
            viewerMemberId={viewerMemberId}
            canAct={canPost}
            forwardTargets={forwardTargets}
          />
        </section>
      )}

      <Composer
        channelId={channel.id}
        channelLabel={channelLabel(channel)}
        canPost={canPost && channel.kind !== "dm"}
      />
    </>
  );
}
