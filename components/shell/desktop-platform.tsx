"use client";

import { useEffect } from "react";

/** Whether this page is running inside the Tauri desktop shell. Client-only. */
export function isDesktopShell(): boolean {
  return Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

/**
 * Marks the document with the desktop platform when the app is running inside
 * the Tauri shell, which is what reserves room for the native window controls.
 * In a browser the attribute is never set and the titlebar stays hidden.
 */
export function DesktopPlatform() {
  useEffect(() => {
    if (!isDesktopShell()) return;
    const platform = navigator.userAgent.includes("Mac OS X")
      ? "macos"
      : navigator.userAgent.includes("Windows")
        ? "windows"
        : "linux";
    document.documentElement.dataset.desktopPlatform = platform;
  }, []);

  return null;
}
