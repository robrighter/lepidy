import { authorizeDeviceRequest, deviceEnvironment, deviceError, deviceJson } from "@/src/shell/device-api";

/**
 * What `lepidy scan` and the `PreToolUse` hook compare text against.
 *
 * A digest of each value and its length, plus the public marker of each canary.
 * No ciphertext, no wrap and no value: the client walks its own text and
 * matches locally, which is the only shape that can answer "does this file
 * contain a secret" without the secret leaving the vault.
 *
 * It is served over the same signed-device transport as everything else, to a
 * member who already holds a verb on the credential, because a digest is a
 * verifier for one exact value and handing verifiers to anyone who asks would
 * make a low-entropy credential guessable offline. That trade is stated in the
 * sharing contract rather than buried here.
 */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);
  const authorized = await authorizeDeviceRequest(env, request);
  if (authorized instanceof Response) return authorized;

  try {
    const listed = await authorized.workspace.listVaultScanTargets({
      actor: { memberId: authorized.memberId, authorizationEpoch: authorized.claims.authorizationEpoch },
      now: Date.now(),
    });
    return deviceJson({ workspaceId: authorized.workspaceId, targets: listed.targets });
  } catch {
    return deviceError("scan_refused", "that scan listing was refused", 403);
  }
}
