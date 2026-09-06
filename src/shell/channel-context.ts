import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";
import { cache } from "react";

import { loadChannelHistory, type ChannelHistoryState } from "./channel-history";
import { developmentChannelHistory } from "./development-shell-source";
import { SESSION_COOKIE, type ShellEnvironment } from "./resolve-shell-source";

/**
 * History for one room, resolved once per request. Mirrors the shell's own
 * resolution: real bindings when a session is present, the development
 * workspace only when this deployment is explicitly a development one.
 */
export const channelHistory = cache(
  async (channelId: string, limit?: number): Promise<ChannelHistoryState> => {
    const environment = process.env.ENVIRONMENT ?? process.env.NODE_ENV;
    const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;

    if (!token) {
      return environment === "development"
        ? { status: "ready", page: developmentChannelHistory(channelId), pins: [] }
        : { status: "not_found" };
    }

    let env: ShellEnvironment = {};
    try {
      env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
    } catch {
      env = {};
    }
    return loadChannelHistory(
      { ...env, ENVIRONMENT: env.ENVIRONMENT ?? environment },
      token,
      channelId,
      { limit },
    );
  },
);
