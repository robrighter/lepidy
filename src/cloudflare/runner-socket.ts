import { authorizeDeviceRequest, deviceEnvironmentFrom, deviceError } from "../shell/device-request";
import type { ShellEnvironment } from "../shell/resolve-shell-source";

/**
 * The runner's outbound socket, served by the Worker entry rather than a route.
 *
 * Next's own guidance is explicit that a Route Handler cannot hold a WebSocket:
 * the connection closes once the response is generated. So this is intercepted
 * before the request reaches Next at all, which is also the honest place for it
 * — nothing about this endpoint is a page, and the whole of its behaviour is a
 * signed upgrade forwarded to one Durable Object.
 *
 * Outbound is the only direction. The runner dials the workspace and the
 * workspace answers on the socket the runner already holds, so a laptop behind
 * NAT needs no open port, no inbound rule and nothing reachable from the
 * internet. There is no path by which the workspace initiates a connection to a
 * machine, and this is why.
 */

export const RUNNER_SOCKET_PATH = "/api/device/runner/socket";

export async function handleRunnerSocketRequest(env: ShellEnvironment, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== RUNNER_SOCKET_PATH) return null;
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return deviceError("upgrade_required", "this endpoint serves a websocket upgrade", 426);
  }

  const deviceEnv = deviceEnvironmentFrom(env);
  if (deviceEnv === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);

  // The same F05 envelope every other device endpoint requires: the signature
  // covers the method, the path and the body hash, so an upgrade signed for
  // this endpoint cannot be replayed against another, and the control plane's
  // nonce table stops it being replayed against this one.
  const authorized = await authorizeDeviceRequest(deviceEnv, request);
  if (authorized instanceof Response) return authorized;

  const runnerEpoch = url.searchParams.get("runner_epoch") ?? "";
  if (!/^[1-9][0-9]{0,15}$/u.test(runnerEpoch)) {
    return deviceError("runner_epoch_invalid", "a positive runner epoch is required", 400);
  }

  const forwarded = new Request(
    `https://workspace.invalid/_internal/runner-socket?runner_epoch=${runnerEpoch}`,
    {
      headers: {
        upgrade: "websocket",
        // Identity comes from the verified claims, never from what the caller
        // put in a header: the signature covers the claims and nothing else.
        "x-lepidy-member-id": authorized.memberId,
        "x-lepidy-authorization-epoch": String(authorized.claims.authorizationEpoch),
        "x-lepidy-device-id": authorized.deviceId,
      },
    },
  );
  return authorized.workspace.fetch(forwarded);
}
