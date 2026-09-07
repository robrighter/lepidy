import { getCloudflareContext } from "@opennextjs/cloudflare";

import { deviceEnvironmentFrom, type DeviceEnvironment } from "./device-request";
import type { ShellEnvironment } from "./resolve-shell-source";

/**
 * The signed-device transport as a Route Handler sees it.
 *
 * The mechanism lives in `device-request`; this adds the one thing a route
 * needs and the Worker entry cannot use — the bindings for the request Next is
 * currently serving.
 */
export * from "./device-request";

export async function deviceEnvironment(): Promise<DeviceEnvironment | null> {
  try {
    return deviceEnvironmentFrom((await getCloudflareContext({ async: true })).env as ShellEnvironment);
  } catch {
    return null;
  }
}
