"use client";

import { Bell, PanelLeft } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import type { ShellAgent, ShellChannel, ShellViewer } from "@/src/cloudflare/workspace";
import { sectionTitle } from "@/src/shell/shell-model";
import { ProfileMenu } from "./profile-menu";
import { Rail } from "./rail";
import { ThemeToggle } from "./theme-toggle";

/**
 * The shell's one piece of client state: whether the narrow-viewport rail is
 * open. Everything else the shell shows is resolved on the server.
 */
export function ShellFrame({
  workspaceName,
  plan,
  viewer,
  channels,
  agents,
  unreadCount,
  authenticated,
  children,
}: {
  workspaceName: string;
  plan: string;
  viewer: ShellViewer;
  channels: readonly ShellChannel[];
  agents: readonly ShellAgent[];
  unreadCount: number;
  authenticated: boolean;
  children: ReactNode;
}) {
  const [railOpen, setRailOpen] = useState(false);
  const pathname = usePathname();

  // A route change must never leave the drawer covering the page it opened.
  useEffect(() => setRailOpen(false), [pathname]);

  const title = sectionTitle(pathname, channels);

  return (
    <div className="app-shell" data-rail-open={railOpen ? "true" : "false"}>
      <Rail
        workspaceName={workspaceName}
        viewer={viewer}
        channels={channels}
        agents={agents}
        unreadCount={unreadCount}
        onNavigate={() => setRailOpen(false)}
      />
      <button
        type="button"
        className="rail-backdrop"
        aria-label="Close navigation"
        tabIndex={railOpen ? 0 : -1}
        onClick={() => setRailOpen(false)}
      />
      <div className="workspace-column">
        <header className="topbar">
          <button
            type="button"
            className="icon-button rail-toggle"
            aria-label="Open navigation"
            aria-expanded={railOpen}
            onClick={() => setRailOpen((value) => !value)}
          >
            <PanelLeft size={17} />
          </button>
          <div>
            <h1>{title}</h1>
            <span className="sub">{workspaceName}</span>
          </div>
          <span className="spacer" />
          <ThemeToggle />
          <Link className="icon-button notification-link" href="/inbox" aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ""}`}>
            <Bell size={17} />
            {unreadCount ? <span className="notification-dot" aria-hidden="true" /> : null}
          </Link>
          <ProfileMenu viewer={viewer} plan={plan} />
        </header>
        <main className="content" id="main">
          <div className="content-inner">
            {authenticated ? null : (
              <p className="notice warn" role="status">
                <strong>Development workspace.</strong>&nbsp;No control-plane session is
                signed in, so this content is local fixture data and not a real workspace.
              </p>
            )}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
