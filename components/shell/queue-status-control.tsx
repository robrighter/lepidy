"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { setItemStatusAction } from "@/app/(app)/c/[channel]/queue-actions";
import type { QueueStatus } from "@/src/domain/work-queues";
import { browserCsrfToken } from "@/src/shell/browser-csrf";

export function QueueStatusControl({ messageId, current, statuses, mainLabel }: {
  messageId: string; current: string | null; statuses: readonly QueueStatus[]; mainLabel: string;
}) {
  const [saving, setSaving] = useState(false);
  const router = useRouter();
  return <select className="queue-status-control" aria-label="Item status" value={current ?? ""} disabled={saving} onChange={async (event) => {
    setSaving(true);
    const result = await setItemStatusAction({ csrfToken: browserCsrfToken(), messageId, statusId: event.target.value || null });
    setSaving(false);
    if (result.ok) router.refresh();
  }}>
    <option value="">{mainLabel}</option>
    {statuses.map((status) => <option key={status.id} value={status.id}>{status.label}{status.visibility === "private" ? " · private" : ""}</option>)}
  </select>;
}
