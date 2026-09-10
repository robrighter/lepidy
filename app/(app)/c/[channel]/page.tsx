import { Pin, Search } from "lucide-react";
import Link from "next/link";

import { Composer } from "@/components/shell/composer";
import { MessageList } from "@/components/shell/message-list";
import { FormComposer } from "@/components/shell/form-composer";
import { QueueSettings } from "@/components/shell/queue-settings";
import { channelHistory } from "@/src/shell/channel-context";
import { channelFiles, messageUnfurls } from "@/src/shell/files-context";
import { mentionCards } from "@/src/shell/people-context";
import { shellState } from "@/src/shell/shell-context";
import { channelLabel } from "@/src/shell/shell-model";
import { workQueue } from "@/src/shell/work-queue-context";
import { readCsrfToken } from "@/src/shell/session-cookies";

/** How many messages a room shows before "Show older" is offered. */
const PAGE = 20;

export default async function ChannelPage({
  params,
  searchParams,
}: {
  params: Promise<{ channel: string }>;
  searchParams: Promise<{ show?: string; status?: string; notice?: string }>;
}) {
  const { channel: key } = await params;
  const { show, status, notice } = await searchParams;
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
  const [history, cards, files, queue] = await Promise.all([
    channelHistory(channel.id, PAGE * pages),
    mentionCards(),
    channelFiles(channel.id),
    channel.sortMode === "ranked" ? workQueue(channel.id, status ?? null) : Promise.resolve(null),
  ]);
  const queueSnapshot = queue?.status === "ready" ? queue.snapshot : null;
  const visibleMessages = queueSnapshot?.page.messages ?? (history.status === "ready" ? history.page.messages : []);
  const unfurls = visibleMessages.length > 0
    ? await messageUnfurls(visibleMessages.map((message) => message.id))
    : new Map();
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
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      <section className="panel channel-heading">
        <div><h2>#{channelLabel(channel)}</h2><p>
          {channel.kind === "public" ? "Public" : "Private"} channel ·{" "}
          {channel.isMember ? "you are a member" : "you have not joined this room"}
        </p>{channel.postMode === "form" || channel.sortMode === "ranked" ? <div className="room-mode-tags">{channel.postMode === "form" ? <span className="tag">Form submissions</span> : null}{channel.sortMode === "ranked" ? <span className="tag">Ranked by {channel.sortEmoji}</span> : null}</div> : null}</div>
        <Link className="channel-search-link" href={`/search?${new URLSearchParams({ q: `in:#${channelLabel(channel)}` })}`}><Search size={14} />Search this room</Link>
      </section>

      {channel.canManageQueue ? <QueueSettings key={`${channel.postMode}:${channel.sortMode}:${channel.sortEmoji ?? ""}`} channelId={channel.id} postMode={channel.postMode} definition={channel.formDefinition} sortMode={channel.sortMode} sortEmoji={channel.sortEmoji} statuses={channel.statusDefinitions} mainLabel={channel.mainStatusLabel} /> : null}

      {queueSnapshot && queueSnapshot.tabs.length > 1 ? <nav className="queue-tabs panel" aria-label="Queue statuses">{queueSnapshot.tabs.map((tab) => <Link key={tab.id ?? "main"} aria-current={(status ?? null) === tab.id ? "page" : undefined} href={tab.id ? `?status=${encodeURIComponent(tab.id)}` : "?"}>{tab.label}<span>{tab.count}</span></Link>)}</nav> : null}

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
      ) : history.status === "not_found" || visibleMessages.length === 0 ? (
        <section className="empty-state">
          <h2>No messages yet</h2>
          <p>{channel.postMode === "form" ? "No entries have been submitted here." : "Nothing has been posted in this room."}</p>
          <span className="next-step">{channel.postMode === "form" ? "Use the form below to add the first entry." : "Say something below to start this room off."}</span>
        </section>
      ) : (
        <section className="panel">
          {channel.sortMode !== "ranked" && history.page.nextCursor ? (
            <p className="history-more">
              <a className="show-older" href={`?show=${pages + 1}#older-boundary`}>
                Show older messages
              </a>
            </p>
          ) : channel.sortMode !== "ranked" ? (
            <p className="history-more muted">You have reached the start of this room.</p>
          ) : null}
          <span id="older-boundary" />
          <MessageList
            messages={channel.sortMode === "ranked" ? visibleMessages : [...visibleMessages].reverse()}
            viewerMemberId={viewerMemberId}
            canAct={canPost}
            forwardTargets={forwardTargets}
            mentionCards={cards}
            attachments={files.byMessage}
            unfurls={unfurls}
            rankingEmoji={channel.sortMode === "ranked" ? channel.sortEmoji : null}
            queueStatuses={channel.statusDefinitions}
            mainStatusLabel={channel.mainStatusLabel}
            canManageQueue={channel.canManageQueue}
          />
        </section>
      )}

      {channel.postMode === "form" ? <FormComposer
        channelId={channel.id}
        channelLabel={channelLabel(channel)}
        canPost={canPost}
        definition={channel.formDefinition}
        csrfToken={(await readCsrfToken()) ?? ""}
        requestKey={`form:${channel.id}:${crypto.randomUUID()}`.slice(0, 128)}
      /> : <Composer
        channelId={channel.id}
        channelLabel={channelLabel(channel)}
        canPost={canPost && channel.kind !== "dm"}
        initialDraft={history.status === "ready" ? history.draft : null}
      />}
    </>
  );
}
