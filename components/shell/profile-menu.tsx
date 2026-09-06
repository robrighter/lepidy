"use client";

import { LogOut, Settings, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type { ShellViewer } from "@/src/cloudflare/workspace";
import { Avatar } from "./avatar";

export function ProfileMenu({ viewer, plan }: { viewer: ShellViewer; plan: string }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="profile-menu" ref={container}>
      <button
        type="button"
        className="icon-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${viewer.displayName}`}
        onClick={() => setOpen((value) => !value)}
      >
        <Avatar name={viewer.displayName} size={24} round />
      </button>
      {open ? (
        <div className="profile-menu-panel" role="menu">
          <div className="who">
            <strong>{viewer.displayName}</strong>
            <span>
              @{viewer.handle} · {viewer.role} · {plan}
            </span>
          </div>
          <Link role="menuitem" href="/profile" onClick={() => setOpen(false)}>
            <UserRound size={16} aria-hidden="true" />
            Profile
          </Link>
          <Link role="menuitem" href="/profile#preferences" onClick={() => setOpen(false)}>
            <Settings size={16} aria-hidden="true" />
            Preferences
          </Link>
          <button role="menuitem" type="button" disabled title="Sign out arrives with C07">
            <LogOut size={16} aria-hidden="true" />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
