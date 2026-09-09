import { MessageList } from "@/components/shell/message-list";
import { mentionCards } from "@/src/shell/people-context";
import { savedItems } from "@/src/shell/saved-context";
import { shellState } from "@/src/shell/shell-context";

export default async function SavedPage() {
  const [state, saved, cards] = await Promise.all([shellState(), savedItems(), mentionCards()]);
  const viewerMemberId = state.status === "ready" ? state.snapshot.viewer.memberId : undefined;

  if (saved.status === "unavailable") {
    return (
      <section className="empty-state">
        <h2>Saved items are unavailable</h2>
        <p>{saved.reason}</p>
        <span className="next-step">Nothing was shown because authority could not be confirmed.</span>
      </section>
    );
  }

  if (saved.status === "signed_out" || saved.items.length === 0) {
    return (
      <>
        <section className="empty-state">
          <h2>Nothing saved yet</h2>
          <p>Save a message from any room and it will be waiting here, only for you.</p>
          <span className="next-step">Saved items are private and are never visible to anybody else.</span>
        </section>
        {saved.status === "ready" && saved.unavailable > 0 ? (
          <UnavailableNotice count={saved.unavailable} />
        ) : null}
      </>
    );
  }

  return (
    <>
      <section className="panel">
        <h2>Saved</h2>
        <p>Only you can see this list.</p>
      </section>
      <section className="panel">
        <MessageList
          messages={saved.items.map((item) => item.message)}
          viewerMemberId={viewerMemberId}
          mentionCards={cards}
        />
      </section>
      {saved.unavailable > 0 ? <UnavailableNotice count={saved.unavailable} /> : null}
    </>
  );
}

/**
 * Saving a message does not keep the right to read it. When a room is left or a
 * message deleted, the pointer stops resolving, and saying so is better than
 * quietly showing a shorter list.
 */
function UnavailableNotice({ count }: { count: number }) {
  return (
    <p className="notice" role="status">
      <span>
        <strong>
          {count} saved {count === 1 ? "message is" : "messages are"} no longer available to you.
        </strong>{" "}
        They were deleted, or they live in a room you are no longer in.
      </span>
    </p>
  );
}
