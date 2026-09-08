import {
  deviceEnvironment,
  deviceError,
  deviceJson,
  readBoundedJson,
  resolveDeviceMembership,
} from "@/src/shell/device-api";
import { VAULT_WRAP_SUITE } from "@/src/domain/vault-envelope";

/**
 * Enrol a local client — the only device endpoint reached without a signature,
 * because this is where the signing key is registered in the first place.
 *
 * The account password is checked here and nowhere else in the flow: what the
 * caller leaves with is a device credential bound to a key pair it generated
 * locally, and every later request proves possession of that key rather than
 * knowledge of the password.
 *
 * The vault wrapping public key travels with the enrolment. Its private half is
 * generated on the client, sealed under a passphrase only the client knows, and
 * never sent — which is what makes the workspace unable to open its own
 * ciphertext. A member who already has a key registered keeps it: re-wrapping
 * existing credentials for a second device is enrolment work that V07 owns, so
 * this reports the refusal instead of silently stranding them.
 */
export async function POST(request: Request) {
  const env = await deviceEnvironment();
  if (env === null) return deviceError("unavailable", "this deployment has no control plane configured", 503);

  const body = await readBoundedJson(request);
  if (body instanceof Response) return body;

  const text = (name: string): string | null => {
    const value = body[name];
    return typeof value === "string" && value.length > 0 && value.length <= 400 ? value : null;
  };
  const email = text("email");
  const password = text("password");
  const workspaceSlug = text("workspaceSlug");
  const label = text("label");
  const vaultPublicKey = text("vaultPublicKey");
  const kind = body.kind === "runner" ? "runner" : "client";
  if (email === null || password === null || workspaceSlug === null || label === null || vaultPublicKey === null) {
    return deviceError("invalid_body", "email, password, workspaceSlug, label and vaultPublicKey are required");
  }

  const accountId = await env.accounts.authenticatePassword(email, password);
  // One answer for an unknown address, a wrong password and a workspace this
  // account is not in. Telling them apart is what enumeration is for.
  if (accountId === null) return deviceError("enrolment_refused", "those sign-in details were refused", 401);
  const membership = await resolveDeviceMembership(env, { accountId, workspaceSlug });
  if (membership === null) return deviceError("enrolment_refused", "those sign-in details were refused", 401);

  let device: { deviceId: string; credential: string; keyEpoch: number };
  try {
    device = await env.authorization.registerDevice({
      accountId,
      kind,
      label,
      signingPublicKey: body.signingPublicKey as JsonWebKey,
      encryptionPublicKey: body.encryptionPublicKey as JsonWebKey,
    });
  } catch {
    return deviceError("invalid_body", "signingPublicKey and encryptionPublicKey must be public P-256 keys");
  }

  const row = await env.db
    .prepare("SELECT durable_object_id FROM workspaces WHERE id = ?")
    .bind(membership.workspaceId)
    .first<{ durable_object_id: string }>();
  if (row === null) return deviceError("workspace_unavailable", "that workspace is not serving requests", 404);
  const workspace = env.workspaces.get(env.workspaces.idFromString(row.durable_object_id));

  let vaultKey: { keyEpoch: number; published: boolean; reason?: string };
  try {
    const published = await workspace.publishVaultMemberKey({
      actor: { memberId: membership.memberId, authorizationEpoch: membership.authorizationEpoch },
      publicKey: vaultPublicKey,
      deviceId: device.deviceId,
      // The password was checked at the top of this request, for this enrolment,
      // and Argon2id is expensive enough that checking it twice would only make
      // the endpoint slower. Nothing staler than this counts as the step-up.
      freshUserVerification: true,
      now: Date.now(),
    });
    vaultKey = published.published
      ? { keyEpoch: published.keyEpoch, published: true }
      : {
          keyEpoch: published.keyEpoch,
          published: false,
          reason: "another client already registered a vault key for this member",
        };
  } catch {
    // Enrolment still succeeded: this device can sign and can read metadata. It
    // just cannot open credentials, and the client is told exactly that rather
    // than the internal reason, which is none of its business.
    vaultKey = { keyEpoch: 0, published: false, reason: "the workspace did not accept this device's vault key" };
  }

  return deviceJson({
    accountId,
    deviceId: device.deviceId,
    deviceCredential: device.credential,
    deviceKeyEpoch: device.keyEpoch,
    workspaceId: membership.workspaceId,
    workspaceSlug: membership.workspaceSlug,
    memberId: membership.memberId,
    authorizationEpoch: membership.authorizationEpoch,
    wrapSuite: VAULT_WRAP_SUITE,
    vaultKey,
  });
}
