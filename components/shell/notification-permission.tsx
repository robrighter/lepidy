"use client";

import { useEffect, useState } from "react";

type State = "unsupported" | "default" | "granted" | "denied" | "insecure";

/**
 * What this browser will actually do with a notification, said plainly.
 *
 * The rule this surface exists to keep is a negative one: **Lepidy never
 * promises a notification will arrive.** Permission belongs to the browser and
 * to the operating system underneath it, both of which can refuse, silence,
 * batch or drop one for reasons this application cannot see and must not
 * pretend to override. A product that said "you'll get a push" and then didn't
 * would be worse than one that never offered, because somebody would stop
 * checking.
 *
 * So every state below names where things wait instead — the Inbox — and the
 * denied state says who has to change it and where, because the one thing this
 * page cannot do is ask again. A browser that has been told "no" does not
 * re-prompt, and a button that appeared to re-ask would do nothing.
 */
/**
 * Register this browser with the push service, and tell the workspace about it.
 *
 * The public VAPID key is fetched rather than embedded: a deployment without one
 * has no push transport, and finding that out from a 503 lets this say so
 * instead of failing inside `pushManager.subscribe` with a message nobody can
 * act on.
 */
async function subscribe(csrfToken: string): Promise<"subscribed" | "unconfigured" | "failed"> {
  const key = await fetch("/api/push/key");
  if (key.status === 503) return "unconfigured";
  if (!key.ok) return "failed";
  const { key: applicationServerKey } = (await key.json()) as { key: string };

  const registration = await navigator.serviceWorker.ready;
  // Reuse whatever this browser already has. Subscribing again would produce a
  // second endpoint for the same browser and leave the first one to fail
  // forever.
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      // Required by every browser: a subscription that anyone could push to
      // would be a subscription anyone could push to.
      userVisibleOnly: true,
      applicationServerKey,
    }));

  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  const response = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      csrfToken,
      endpoint: json.endpoint,
      p256dh: json.keys?.p256dh,
      auth: json.keys?.auth,
    }),
  });
  return response.ok ? "subscribed" : "failed";
}

export function NotificationPermission({ csrfToken }: { csrfToken: string }) {
  const [state, setState] = useState<State | null>(null);
  const [asking, setAsking] = useState(false);
  const [delivery, setDelivery] = useState<"unknown" | "subscribed" | "unconfigured" | "failed">(
    "unknown",
  );

  useEffect(() => {
    if (typeof Notification === "undefined" || !("serviceWorker" in navigator)) {
      // A secure context is required for both. On http this is not a browser
      // limitation to apologise for, it is the wrong URL.
      setState(window.isSecureContext ? "unsupported" : "insecure");
      return;
    }
    setState(Notification.permission as State);
  }, []);

  // Nothing at all until the browser has been asked, so the panel does not
  // flash a wrong answer on the way to the right one.
  if (state === null) return null;

  const ask = async () => {
    setAsking(true);
    try {
      const granted = (await Notification.requestPermission()) as State;
      setState(granted);
      // Permission is only half of it. A browser that granted permission and
      // was never registered with the push service receives nothing, and would
      // sit here looking as though it worked.
      if (granted === "granted") {
        setDelivery(await subscribe(csrfToken).catch(() => "failed"));
      }
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="notification-permission" data-permission={state}>
      {state === "granted" ? (
        <>
          <p className="notice">
            This browser will show Lepidy notifications. Your operating system can still
            silence them — during a focus mode, for example — and Lepidy cannot override
            that. Anything you miss is waiting in the Inbox.
          </p>
          {delivery === "unconfigured" ? (
            <p className="notice warn">
              This deployment has no push service configured, so nothing will be delivered
              to this browser even though it would show one. The Inbox is where things
              wait.
            </p>
          ) : null}
          {delivery === "failed" ? (
            <p className="notice warn">
              This browser could not be registered for delivery. Notifications will not
              arrive until it is; the Inbox is unaffected.
            </p>
          ) : null}
        </>
      ) : null}

      {state === "default" ? (
        <>
          <p>
            Approvals expire after five minutes, so a notification is often the difference
            between answering one and an agent being told to come back later.
          </p>
          <button className="button" type="button" onClick={() => void ask()} disabled={asking}>
            {asking ? "Waiting for the browser…" : "Allow notifications"}
          </button>
        </>
      ) : null}

      {state === "denied" ? (
        <p className="notice warn">
          Notifications are blocked for this site. Lepidy cannot ask again — that is the
          browser&rsquo;s decision, not ours — so it has to be changed in your browser&rsquo;s
          site settings. Until it is, approvals and mentions wait in the Inbox and nothing
          is lost.
        </p>
      ) : null}

      {state === "insecure" ? (
        <p className="notice warn">
          Notifications need a secure connection. Open Lepidy over HTTPS.
        </p>
      ) : null}

      {state === "unsupported" ? (
        <p className="notice warn">
          This browser cannot show notifications. Approvals and mentions wait in the Inbox.
        </p>
      ) : null}
    </div>
  );
}
