import { shellState } from "@/src/shell/shell-context";
import { channelLabel } from "@/src/shell/shell-model";

export default async function ChannelPage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel: key } = await params;
  const state = await shellState();
  const channel =
    state.status === "ready"
      ? state.snapshot.channels.find((item) => item.slug === key || item.id === key)
      : undefined;

  if (!channel) {
    return (
      <section className="empty-state">
        <h2>Channel not available</h2>
        <p>No channel here is visible to you under that name.</p>
        <span className="next-step">A private room is only listed for its own members.</span>
      </section>
    );
  }

  return (
    <section className="empty-state">
      <h2>#{channelLabel(channel)} has no messages yet</h2>
      <p>This is a {channel.kind === "public" ? "public" : "private"} channel in this workspace.</p>
      <span className="next-step">Message writes, history and live delivery arrive with C02 and C03.</span>
    </section>
  );
}
