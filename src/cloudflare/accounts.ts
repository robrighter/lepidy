import { DurableObject } from "cloudflare:workers";

import { OnboardingService } from "../control/onboarding";
import type { Workspace } from "./workspace";

/**
 * The control-plane account object.
 *
 * Password work lives here for two reasons. The practical one: Argon2id is
 * WebAssembly whose imports are supplied at instantiation, the Workers runtime
 * refuses to compile wasm at request time, and the Next.js bundler cannot
 * compile these modules at all — so the hasher must live in a bundle wrangler
 * builds. The better one: hashing a password is deliberately expensive CPU work,
 * and it does not belong inline in a request-scoped server action.
 *
 * There is exactly one of these objects, addressed by a fixed name. It holds no
 * durable state of its own; accounts live in D1.
 */
export { ACCOUNTS_OBJECT_NAME } from "./accounts-address";

/**
 * The assertion options as they cross RPC and then the network.
 *
 * Spelled out rather than passed through as the library's own type: this value
 * is serialised twice before a browser rebuilds a `PublicKeyCredentialRequestOptions`
 * from it, and only plain JSON survives that trip.
 */
export type ApprovalAssertionOptions = {
  challenge: string;
  timeout?: number;
  rpId?: string;
  userVerification?: string;
  allowCredentials?: { id: string; type: string; transports?: string[] }[];
};

export type SignUpInput = {
  email: string;
  password: string;
  displayName: string;
  handle: string;
  workspaceName: string;
  workspaceSlug: string;
  jurisdiction: "global" | "eu";
  storageMode: "local_host" | "cloud";
};

export class Accounts extends DurableObject<CloudflareEnv> {
  private get onboarding(): OnboardingService {
    return new OnboardingService(
      this.env.CONTROL_DB,
      this.env.WORKSPACE as DurableObjectNamespace<Workspace>,
    );
  }

  /**
   * Null for both an unknown address and a wrong password: telling them apart
   * is precisely what an attacker enumerating accounts is after.
   */
  async authenticatePassword(email: string, password: string): Promise<string | null> {
    return this.onboarding.authenticatePassword(email, password);
  }

  /**
   * The approver's gesture for one credential approval.
   *
   * It lives here for the same reason password work does: the ceremony belongs
   * with the account, and the verification libraries belong in a bundle
   * Wrangler builds rather than in the Next.js one. The digest travels with the
   * challenge so the assertion authorises one exact decision and nothing else.
   */
  async beginVaultApprovalAssertion(input: {
    accountId: string;
    digest: string;
    relyingParty?: { rpId: string; origin: string };
  }): Promise<{ id: string; options: ApprovalAssertionOptions }> {
    const begun = await this.onboarding.beginVaultApprovalAssertion(input);
    return { id: begun.id, options: begun.options as unknown as ApprovalAssertionOptions };
  }

  async verifyVaultApprovalAssertion(input: {
    accountId: string;
    challengeId: string;
    credentialId: string;
    response: unknown;
    digest: string;
    relyingParty?: { rpId: string; origin: string };
  }): Promise<boolean> {
    return this.onboarding.verifyVaultApprovalAssertion(input);
  }

  /**
   * Verify an address, create the account and provision its first workspace.
   *
   * The verification challenge is issued and consumed here rather than emailed,
   * so this is only reachable where the caller has established that self-service
   * sign-up is permitted — see `selfServiceSignUpAllowed`.
   */
  async signUpWithWorkspace(input: SignUpInput): Promise<{ accountId: string; workspaceId: string }> {
    const onboarding = this.onboarding;
    const challenge = await onboarding.issueEmailChallenge(input.email, "verify_email");
    const { accountId } = await onboarding.registerPassword({
      challengeId: challenge.id,
      token: challenge.token,
      displayName: input.displayName,
      password: input.password,
    });
    const { workspaceId, memberId } = await onboarding.createWorkspace({
      accountId,
      name: input.workspaceName,
      slug: input.workspaceSlug,
      handle: input.handle,
      jurisdiction: input.jurisdiction,
      storageMode: input.storageMode,
    });

    // A workspace with nowhere to talk is not a workspace. The starter room is
    // created through the same authorized path anyone else would use.
    const row = await this.env.CONTROL_DB.prepare(
      "SELECT durable_object_id FROM workspaces WHERE id = ?",
    )
      .bind(workspaceId)
      .first<{ durable_object_id: string }>();
    if (row) {
      const workspaces = this.env.WORKSPACE as DurableObjectNamespace<Workspace>;
      await workspaces.get(workspaces.idFromString(row.durable_object_id)).createChannel({
        actor: { memberId, authorizationEpoch: 1 },
        idempotencyKey: `workspace:starter:${workspaceId}`.slice(0, 128),
        kind: "public",
        slug: "general",
        name: "General",
        topic: "Everything that does not have a room of its own yet.",
        now: Date.now(),
      });
    }
    return { accountId, workspaceId };
  }
}
