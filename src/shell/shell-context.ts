import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";
import { cache } from "react";

import { SESSION_COOKIE, loadShellState, type ShellEnvironment } from "./resolve-shell-source";
import type { ShellState } from "./workspace-shell-source";

/**
 * Resolved once per request and shared by the layout and every page in it, so a
 * single navigation never asks the control plane or the workspace object twice.
 *
 * Cloudflare bindings are only reached for when a session cookie is actually
 * present: a signed-out request has nothing to authorise, and starting the local
 * binding proxy for it makes every build worker contend for the same state.
 */
export const shellState = cache(async (): Promise<ShellState> => {
  const environment = process.env.ENVIRONMENT ?? process.env.NODE_ENV;
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  if (!token) return loadShellState({ ENVIRONMENT: environment }, null);

  let env: ShellEnvironment = {};
  try {
    env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
  } catch {
    env = {};
  }
  return loadShellState({ ...env, ENVIRONMENT: env.ENVIRONMENT ?? environment }, token);
});
