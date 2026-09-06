"use client";

import { useEffect } from "react";

/**
 * Marks the document with the desktop platform when the app is running inside
 * the Tauri shell, which is what reserves room for the native window controls.
 * In a browser the attribute is never set and the titlebar stays hidden.
 */
export function DesktopPlatform() {
  useEffect(() => {
    const tauri = (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    if (!tauri) return;
    const platform = navigator.userAgent.includes("Mac OS X")
      ? "macos"
      : navigator.userAgent.includes("Windows")
        ? "windows"
        : "linux";
    document.documentElement.dataset.desktopPlatform = platform;
  }, []);

  return null;
}
