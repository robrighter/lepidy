import { getCloudflareContext } from "@opennextjs/cloudflare";

import { AuthorizationService } from "../control/authorization";
import { ACCOUNTS_OBJECT_NAME } from "../cloudflare/accounts-address";
import type { Accounts } from "../cloudflare/accounts";
import type { ShellEnvironment } from "./resolve-shell-source";

export type AccountServices = {
  env: ShellEnvironment & { CONTROL_DB: D1Database; WORKSPACE: NonNullable<ShellEnvironment["WORKSPACE"]> };
  authorization: AuthorizationService;
  /**
   * Password work runs inside the account object, not here. Only a stub crosses
   * this boundary, so the Argon2id WebAssembly never enters the Next.js bundle.
   */
  accounts: DurableObjectStub<Accounts>;
};

/**
 * The account services, or an honest reason there are none.
 *
 * A deployment without control-plane bindings cannot sign anybody in, and says
 * so rather than failing halfway through a form submission.
 */
export async function accountServices(): Promise<AccountServices | { unavailable: string }> {
  let env: ShellEnvironment = {};
  try {
    env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
  } catch {
    env = {};
  }
  if (!env.CONTROL_DB || !env.WORKSPACE || !env.ACCOUNTS) {
    return { unavailable: "This deployment has no account storage configured." };
  }
  const bound = { ...env, CONTROL_DB: env.CONTROL_DB, WORKSPACE: env.WORKSPACE };
  return {
    env: bound,
    authorization: new AuthorizationService(bound.CONTROL_DB, bound.WORKSPACE),
    accounts: env.ACCOUNTS.getByName(ACCOUNTS_OBJECT_NAME),
  };
}

/**
 * Verification is delivered by email, and no email provider is connected yet.
 * Rather than pretend, sign-up completes inline only where that is explicitly a
 * development deployment, and refuses everywhere else.
 */
export function selfServiceSignUpAllowed(environment: string | undefined): boolean {
  return environment === "development";
}

export function deploymentEnvironment(): string | undefined {
  return process.env.ENVIRONMENT ?? process.env.NODE_ENV;
}
