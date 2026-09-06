import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";
import { cache } from "react";

import { SESSION_COOKIE, loadShellState, type ShellEnvironment } from "./resolve-shell-source";
import type { ShellState } from "./workspace-shell-source";

/**
 * Resolved once per request and shared by the layout and every page in it, so a
 * single navigation never asks the control plane or the workspace object twice.
 *
 * Binding discovery also runs without a cookie so a configured deployment can
 * never mistake a signed-out request for an unbound development preview.
 */
export const shellState = cache(async (): Promise<ShellState> => {
  const environment = process.env.ENVIRONMENT ?? process.env.NODE_ENV;
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;

  let env: ShellEnvironment = {};
  try {
    env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
  } catch {
    env = {};
  }
  return loadShellState({ ...env, ENVIRONMENT: env.ENVIRONMENT ?? environment }, token);
});
