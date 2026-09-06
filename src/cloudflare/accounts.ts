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
    const { workspaceId } = await onboarding.createWorkspace({
      accountId,
      name: input.workspaceName,
      slug: input.workspaceSlug,
      handle: input.handle,
      jurisdiction: input.jurisdiction,
      storageMode: input.storageMode,
    });
    return { accountId, workspaceId };
  }
}
