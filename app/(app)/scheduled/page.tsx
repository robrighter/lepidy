import { ScheduledList } from "@/components/shell/scheduled-list";
import { scheduledMessages } from "@/src/shell/scheduled-context";

export default async function ScheduledPage() {
  const state = await scheduledMessages();
  // A cancelled message is gone by the person's own choice and a sent one is in
  // its room. What is worth a list is what is still coming, and what was
  // refused — because a scheduled send that quietly never happened is the worst
  // of the outcomes.
  const pending =
    state.status === "ready"
      ? state.scheduled.filter((entry) => entry.status === "scheduled" || entry.status === "failed")
      : [];

  if (state.status === "unavailable") {
    return (
      <section className="empty-state">
        <h2>Scheduled messages are unavailable</h2>
        <p>{state.reason}</p>
        <span className="next-step">Nothing was shown because authority could not be confirmed.</span>
      </section>
    );
  }

  if (state.status === "signed_out" || pending.length === 0) {
    return (
      <section className="empty-state">
        <h2>Nothing scheduled</h2>
        <p>Messages you schedule for later will wait here until their time.</p>
        <span className="next-step">
          Authority is rechecked when a scheduled message is sent, not when it is written.
        </span>
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        <h2>Scheduled</h2>
        <p>Only you can see this list.</p>
      </section>
      <section className="panel">
        <ScheduledList scheduled={pending} />
      </section>
    </>
  );
}
