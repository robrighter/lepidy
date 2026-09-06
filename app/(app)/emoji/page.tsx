import { EmojiAdmin } from "@/components/shell/emoji-admin";
import { customEmoji } from "@/src/shell/emoji-context";
import { shellState } from "@/src/shell/shell-context";

export default async function EmojiPage() {
  const [state, emoji] = await Promise.all([shellState(), customEmoji()]);

  if (emoji.status === "unavailable") {
    return (
      <section className="empty-state">
        <h2>Custom emoji are unavailable</h2>
        <p>{emoji.reason}</p>
        <span className="next-step">Nothing was shown because authority could not be confirmed.</span>
      </section>
    );
  }

  const role = state.status === "ready" ? state.snapshot.viewer.role : "guest";
  const canAdminister = role === "owner" || role === "admin";

  return (
    <>
      <section className="panel">
        <h2>Custom emoji</h2>
        <p>
          One name, one meaning, workspace-wide. A name cannot be redefined, so an old message
          never changes what it meant.
        </p>
      </section>
      <section className="panel">
        <EmojiAdmin
          emoji={emoji.status === "ready" ? emoji.emoji : []}
          canAdminister={canAdminister}
        />
      </section>
    </>
  );
}
