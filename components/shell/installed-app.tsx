"use client";

import { useEffect } from "react";

/**
 * Registers the service worker, which is what makes Lepidy installable.
 *
 * Deliberately unconditional and deliberately silent. Registration failing is
 * not something a person can act on — it happens in a private window, behind an
 * enterprise policy, or on a browser that does not have service workers — and
 * the application works without it. The one thing that would be worse than no
 * offline page is a banner about a missing offline page.
 *
 * What a person *can* act on is notification permission, and that has its own
 * surface which says the truth about it rather than assuming this succeeded.
 */
export function InstalledApp() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // After load: registration competes with the first render for the same
    // connection, and the offline page is not needed in the first second.
    const register = () => {
      void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // See above. Nothing here is a failure a person should be told about.
      });
    };
    if (document.readyState === "complete") register();
    else {
      addEventListener("load", register, { once: true });
      return () => removeEventListener("load", register);
    }
  }, []);

  return null;
}
