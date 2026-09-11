"use client";

import { useEffect } from "react";

import { isDesktopShell } from "./desktop-platform";

/**
 * Mirrors the unread count onto the operating system's own chrome — the dock
 * badge, the taskbar, the tray tooltip — when the app is running inside the
 * Tauri shell. In a browser this component does nothing at all.
 *
 * It sends a **number**, because that is the whole interface the shell offers.
 * A badge whose contents came from a message would put a stranger's characters
 * into the dock, where no sanitiser of ours sits between; `presence::badge_label`
 * on the native side is where that decision is written down.
 *
 * Every failure here is swallowed on purpose. A badge is the least important
 * thing on the screen, the shell can legitimately refuse the call — a page that
 * has navigated somewhere unexpected is refused by design — and an unhandled
 * rejection in a layout component would take the workspace down with it.
 */
export function DesktopPresence({ unreadCount }: { unreadCount: number }) {
  useEffect(() => {
    if (!isDesktopShell()) return;
    let cancelled = false;

    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        if (cancelled) return;
        await invoke("set_badge", { unread: Math.max(0, Math.trunc(unreadCount)) });
      } catch {
        // Not in the shell after all, or the shell declined. Either way the
        // badge in the rail is still correct, which is the one that matters.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [unreadCount]);

  return null;
}
