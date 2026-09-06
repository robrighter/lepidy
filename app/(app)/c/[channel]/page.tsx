import { MessageList } from "@/components/shell/message-list";
import { channelHistory } from "@/src/shell/channel-context";
import { shellState } from "@/src/shell/shell-context";
import { channelLabel } from "@/src/shell/shell-model";

export default async function ChannelPage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel: key } = await params;
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

  const history = await channelHistory(channel.id);

  return (
    <>
      <section className="panel">
        <h2>#{channelLabel(channel)}</h2>
        <p>
          {channel.kind === "public" ? "Public" : "Private"} channel ·{" "}
          {channel.isMember ? "you are a member" : "you have not joined this room"}
        </p>
      </section>

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
          <span className="next-step">The composer arrives with C04 and live delivery with C03.</span>
        </section>
      ) : (
        <section className="panel">
          <MessageList messages={history.page.messages} />
        </section>
      )}
    </>
  );
}
