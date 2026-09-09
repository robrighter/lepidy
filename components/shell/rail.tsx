"use client";

import {
  Bookmark,
  CalendarClock,
  Hash,
  Home,
  Inbox,
  KeyRound,
  Lock,
  Plus,
  Search,
  Sparkles,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import type { ShellAgent, ShellChannel, ShellViewer } from "@/src/cloudflare/workspace";
import {
  SHELL_NAV,
  channelHref,
  channelLabel,
  resolveActiveNav,
  type ShellSection,
} from "@/src/shell/shell-model";
import { AgentAvatar, Avatar } from "./avatar";

const NAV_ICONS: Partial<Record<ShellSection, ReactNode>> = {
  home: <Home size={18} />,
  inbox: <Inbox size={18} />,
  saved: <Bookmark size={18} />,
  scheduled: <CalendarClock size={18} />,
  people: <Users size={18} />,
  agents: <Sparkles size={18} />,
  vault: <KeyRound size={18} />,
};

export function Rail({
  workspaceName,
  viewer,
  channels,
  agents,
  unreadCount,
  onNavigate,
}: {
  workspaceName: string;
  viewer: ShellViewer;
  channels: readonly ShellChannel[];
  agents: readonly ShellAgent[];
  unreadCount: number;
  onNavigate: () => void;
}) {
  const pathname = usePathname();
  const active = resolveActiveNav(pathname);

  return (
    <aside className="rail" aria-label="Workspace navigation">
      <Link className="brand" href="/" onClick={onNavigate}>
        <img src="/mark.svg" alt="" width={30} height={30} />
        <span>
          Lepidy
          <span className="workspace-name">{workspaceName}</span>
        </span>
      </Link>

      <button className="search-button" type="button" disabled title="Search arrives with C09">
        <Search size={16} aria-hidden="true" />
        <span>Search</span>
        <kbd>⌘K</kbd>
      </button>

      <div className="rail-scroll">
        <nav aria-label="Primary">
          {SHELL_NAV.map((item) => (
            <Link
              key={item.id}
              className="nav-item"
              href={item.href}
              onClick={onNavigate}
              aria-current={active?.id === item.id ? "page" : undefined}
            >
              {NAV_ICONS[item.id]}
              <span className="lbl">{item.label}</span>
              {item.id === "inbox" && unreadCount > 0 ? (
                <span className="badge" aria-label={`${unreadCount} unread`}>{unreadCount}</span>
              ) : null}
            </Link>
          ))}
        </nav>

        <nav className="nav-group" aria-label="Channels">
          <div className="nav-label">
            <span>Channels</span>
            <Plus size={14} aria-hidden="true" />
          </div>
          {channels.length === 0 ? (
            <p className="nav-item small" style={{ color: "#8f89b1" }}>
              <span className="lbl">No channels yet</span>
            </p>
          ) : (
            channels.map((channel) => {
              const href = channelHref(channel);
              return (
                <Link
                  key={channel.id}
                  className="nav-item small"
                  href={href}
                  onClick={onNavigate}
                  aria-current={pathname === href ? "page" : undefined}
                >
                  {channel.kind === "public" ? <Hash size={15} /> : <Lock size={15} />}
                  <span className="lbl">{channelLabel(channel)}</span>
                </Link>
              );
            })
          )}
        </nav>

        <nav className="nav-group" aria-label="Agents">
          <div className="nav-label">
            <span>Agents</span>
            <Plus size={14} aria-hidden="true" />
          </div>
          {agents.length === 0 ? (
            <p className="nav-item small" style={{ color: "#8f89b1" }}>
              <span className="lbl">No agents yet</span>
            </p>
          ) : (
            agents.map((agent) => (
              <Link key={agent.id} className="nav-item small" href="/agents" onClick={onNavigate}>
                <AgentAvatar size={20} />
                <span className="lbl">@{agent.handle}</span>
                <span className="agent-chip">agent</span>
              </Link>
            ))
          )}
        </nav>
      </div>

      <div className="rail-foot">
        <Link
          className="nav-item"
          href="/profile"
          onClick={onNavigate}
          aria-current={pathname === "/profile" ? "page" : undefined}
        >
          <Avatar name={viewer.displayName} size={26} round />
          <span className="lbl">
            <strong>{viewer.displayName}</strong>
            <span className="role">{viewer.role}</span>
          </span>
        </Link>
      </div>
    </aside>
  );
}
