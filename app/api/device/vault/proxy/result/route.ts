import { authorizeDeviceRequest, deviceEnvironment, deviceError, deviceJson } from "@/src/shell/device-api";

/**
 * The encrypted response leg of a device-mediated proxy call. The signed
 * device envelope authenticates the release device and burns its nonce before
 * the workspace opens or records anything from the result.
 */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);
  const authorized = await authorizeDeviceRequest(env, request);
  if (authorized instanceof Response) return authorized;
  const body = authorized.body as Record<string, unknown>;
  const response = body.response as Record<string, unknown> | undefined;
  if (
    typeof body.requestId !== "string" ||
    response === undefined ||
    typeof response.suite !== "string" ||
    typeof response.iv !== "string" ||
    typeof response.ciphertext !== "string"
  ) {
    return deviceError("invalid_body", "requestId and an encrypted response envelope are required");
  }
  try {
    const completed = await authorized.workspace.completeVaultProxy({
      actor: { memberId: authorized.memberId, authorizationEpoch: authorized.claims.authorizationEpoch },
      deviceId: authorized.deviceId,
      requestId: body.requestId,
      response: {
        suite: response.suite as "AES-256-GCM",
        iv: response.iv,
        ciphertext: response.ciphertext,
      },
      now: Date.now(),
    });
    return deviceJson(completed);
  } catch {
    return deviceError("proxy_result_refused", "that proxy result was refused", 403);
  }
}
