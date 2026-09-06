"use client";

import { Minus, Square, X } from "lucide-react";

async function withWindow(action: "minimize" | "maximize" | "close") {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const window = getCurrentWindow();

  if (action === "minimize") await window.minimize();
  if (action === "maximize") await window.toggleMaximize();
  if (action === "close") await window.close();
}

export function DesktopTitlebar() {
  return (
    <div className="desktop-titlebar" data-tauri-drag-region>
      <div className="desktop-titlebar-brand" data-tauri-drag-region>
        <img src="/mark.svg" alt="" />
        <span>Lepidy</span>
      </div>
      <span className="desktop-titlebar-label" data-tauri-drag-region>
        Human and agent workspace
      </span>
      <div className="window-controls">
        <button type="button" aria-label="Minimize" onClick={() => void withWindow("minimize")}><Minus size={15} /></button>
        <button type="button" aria-label="Maximize" onClick={() => void withWindow("maximize")}><Square size={12} /></button>
        <button className="window-close" type="button" aria-label="Close" onClick={() => void withWindow("close")}><X size={15} /></button>
      </div>
    </div>
  );
}
