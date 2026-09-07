import {
  assertSafeIdentityLink,
  hashOpaqueToken,
  hashPassword,
  normalizeEmail,
  randomToken,
  validateHumanHandle,
  verifyPassword,
  type ExternalIdentityAssertion,
  type LinkAuthorization,
} from "./identity";
import type { Workspace } from "../cloudflare/workspace";
import {
  SimpleWebAuthnPasskeyProvider,
  type PasskeyProvider,
  type RegisteredPasskey,
} from "./passkeys";

type ChallengeKind = "verify_email" | "email_login";
type WorkspaceRole = "owner" | "admin" | "member" | "guest";

export type IssuedChallenge = { id: string; token: string; expiresAt: number };

/** Where a WebAuthn ceremony is happening, when it is not the configured default. */
export type RelyingParty = { rpId: string; origin: string };

export class OnboardingService {
  constructor(
    private readonly db: D1Database,
    private readonly workspaces: DurableObjectNamespace<Workspace>,
    private readonly now: () => number = () => Date.now(),
    private readonly passkeyProvider: PasskeyProvider = new SimpleWebAuthnPasskeyProvider(),
  ) {}

  async beginPasskeyRegistration(
    accountId: string,
    authorization: LinkAuthorization,
  ): Promise<{ id: string; options: Awaited<ReturnType<PasskeyProvider["registrationOptions"]>> }> {
    if (!authorization.freshSession) throw new Error("fresh session required");
    if (!authorization.stepUpVerified) throw new Error("step-up verification required");
    if (!authorization.confirmed) throw new Error("explicit confirmation required");
    const account = await this.db
      .prepare("SELECT primary_email_normalized, display_name FROM accounts WHERE id = ? AND status = 'active'")
      .bind(accountId)
      .first<{ primary_email_normalized: string; display_name: string }>();
    if (!account) throw new Error("account not found");
    const existing = await this.loadPasskeys(accountId);
    const options = await this.passkeyProvider.registrationOptions({
      accountId,
      email: account.primary_email_normalized,
      displayName: account.display_name,
      existing: existing.map(({ id, transports }) => ({ id, transports })),
    });
    const id = crypto.randomUUID();
    const now = this.now();
    await this.db
      .prepare(
        `INSERT INTO auth_challenges(id, kind, account_id, challenge, expires_at, created_at)
         VALUES (?, 'passkey_registration', ?, ?, ?, ?)`,
      )
      .bind(id, accountId, options.challenge, now + 5 * 60_000, now)
      .run();
    return { id, options };
  }

  async finishPasskeyRegistration(input: {
    accountId: string;
    challengeId: string;
    response: unknown;
  }): Promise<string> {
    const challenge = await this.consumePasskeyChallenge(input.challengeId, input.accountId, "passkey_registration");
    const credential = await this.passkeyProvider.verifyRegistration(input.response, challenge);
    if (!credential) throw new Error("passkey registration could not be verified");
    const now = this.now();
    await this.db
      .prepare(
          `INSERT INTO passkeys(id, account_id, credential_id, public_key, sign_count, transports_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        input.accountId,
        new TextEncoder().encode(credential.id),
        credential.publicKey,
        credential.counter,
        JSON.stringify(credential.transports ?? []),
        now,
      )
      .run();
    return credential.id;
  }

  async beginPasskeyAuthentication(accountId: string): Promise<{ id: string; options: Awaited<ReturnType<PasskeyProvider["authenticationOptions"]>> }> {
    const existing = await this.loadPasskeys(accountId);
    if (existing.length === 0) throw new Error("account has no passkey");
    const options = await this.passkeyProvider.authenticationOptions(
      existing.map(({ id, transports }) => ({ id, transports })),
    );
    const id = crypto.randomUUID();
    const now = this.now();
    await this.db
      .prepare(
        `INSERT INTO auth_challenges(id, kind, account_id, challenge, expires_at, created_at)
         VALUES (?, 'passkey_authentication', ?, ?, ?, ?)`,
      )
      .bind(id, accountId, options.challenge, now + 5 * 60_000, now)
      .run();
    return { id, options };
  }

  async finishPasskeyAuthentication(input: {
    accountId: string;
    challengeId: string;
    credentialId: string;
    response: unknown;
  }): Promise<string> {
    const challenge = await this.consumePasskeyChallenge(input.challengeId, input.accountId, "passkey_authentication");
    const credential = (await this.loadPasskeys(input.accountId)).find(({ id }) => id === input.credentialId);
    if (!credential) throw new Error("passkey not found");
    const counter = await this.passkeyProvider.verifyAuthentication(input.response, challenge, credential);
    if (counter === null || counter < credential.counter) throw new Error("passkey authentication could not be verified");
    const now = this.now();
    await this.db
      .prepare("UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE account_id = ? AND credential_id = ?")
      .bind(counter, now, input.accountId, new TextEncoder().encode(input.credentialId))
      .run();
    return input.accountId;
  }

  /**
   * Begin the gesture that authorises one approval decision.
   *
   * It is an ordinary passkey assertion with user verification, and what makes
   * it an *approval* gesture is the digest recorded beside the challenge: the
   * decision the approver is about to authorise, in full. At the end of the
   * ceremony the caller must present the same digest, so an assertion collected
   * for one card cannot be spent on another, or on the same card after a
   * credential in it changed.
   */
  /**
   * The relying party a ceremony runs under.
   *
   * A passkey is bound to the origin that created it, so a deployment serving a
   * different host has to say so or every assertion fails verification for a
   * reason nobody can see. Callers that know the host they were addressed on
   * pass it; everything else keeps the configured default.
   */
  private providerFor(relyingParty?: RelyingParty): PasskeyProvider {
    if (relyingParty === undefined) return this.passkeyProvider;
    return new SimpleWebAuthnPasskeyProvider(relyingParty.rpId, [relyingParty.origin]);
  }

  async beginVaultApprovalAssertion(input: {
    accountId: string;
    digest: string;
    relyingParty?: RelyingParty;
  }): Promise<{ id: string; options: Awaited<ReturnType<PasskeyProvider["authenticationOptions"]>> }> {
    const existing = await this.loadPasskeys(input.accountId);
    // Fail closed and say why. An account with no passkey cannot allow a
    // credential — which is the documented consequence of the step-up matrix,
    // not an accident of this code path.
    if (existing.length === 0) throw new Error("account has no passkey");
    const options = await this.providerFor(input.relyingParty).authenticationOptions(
      existing.map(({ id, transports }) => ({ id, transports })),
    );
    const id = crypto.randomUUID();
    const now = this.now();
    await this.db
      .prepare(
        `INSERT INTO auth_challenges(id, kind, account_id, challenge, payload_json, expires_at, created_at)
         VALUES (?, 'passkey_authentication', ?, ?, ?, ?, ?)`,
      )
      // Five minutes, the same ceiling the approval itself lives under.
      .bind(id, input.accountId, options.challenge, JSON.stringify({ approvalDigest: input.digest }), now + 5 * 60_000, now)
      .run();
    return { id, options };
  }

  /**
   * Finish it, and answer one question: may this account authorise exactly this
   * decision, right now? Anything else is a refusal.
   */
  async verifyVaultApprovalAssertion(input: {
    accountId: string;
    challengeId: string;
    credentialId: string;
    response: unknown;
    digest: string;
    relyingParty?: RelyingParty;
  }): Promise<boolean> {
    const row = await this.db
      .prepare(
        `UPDATE auth_challenges SET consumed_at = ?
         WHERE id = ? AND account_id = ? AND kind = 'passkey_authentication' AND consumed_at IS NULL AND expires_at > ?
         RETURNING challenge, payload_json`,
      )
      .bind(this.now(), input.challengeId, input.accountId, this.now())
      .first<{ challenge: string; payload_json: string }>();
    if (!row) throw new Error("that approval gesture is invalid, expired or already used");
    const bound = (JSON.parse(row.payload_json) as { approvalDigest?: string }).approvalDigest;
    if (bound === undefined || bound !== input.digest) {
      throw new Error("that approval gesture authorises a different decision");
    }
    const credential = (await this.loadPasskeys(input.accountId)).find(({ id }) => id === input.credentialId);
    if (!credential) throw new Error("passkey not found");
    const counter = await this.providerFor(input.relyingParty).verifyAuthentication(
      input.response,
      row.challenge,
      credential,
    );
    if (counter === null || counter < credential.counter) throw new Error("that approval gesture could not be verified");
    await this.db
      .prepare("UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE account_id = ? AND credential_id = ?")
      .bind(counter, this.now(), input.accountId, new TextEncoder().encode(input.credentialId))
      .run();
    return true;
  }

  async issueEmailChallenge(email: string, kind: ChallengeKind): Promise<IssuedChallenge> {
    const id = crypto.randomUUID();
    const token = randomToken();
    const tokenHash = await hashOpaqueToken(token);
    const createdAt = this.now();
    const expiresAt = createdAt + 15 * 60_000;
    await this.db
      .prepare(
        `INSERT INTO auth_challenges(id, kind, email_normalized, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, kind, normalizeEmail(email), tokenHash, expiresAt, createdAt)
      .run();
    return { id, token, expiresAt };
  }

  async registerPassword(input: {
    challengeId: string;
    token: string;
    displayName: string;
    password: string;
  }): Promise<{ accountId: string }> {
    const encodedHash = await hashPassword(input.password);
    const challenge = await this.consumeChallenge(input.challengeId, input.token, "verify_email");
    const accountId = crypto.randomUUID();
    const identityId = crypto.randomUUID();
    const now = this.now();

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO accounts(id, primary_email_normalized, display_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(accountId, challenge.email, input.displayName.trim(), now, now),
      this.db
        .prepare(
          `INSERT INTO login_identities(id, account_id, provider, provider_subject, email_normalized, email_verified, created_at)
           VALUES (?, ?, 'password', ?, ?, 1, ?)`,
        )
        .bind(identityId, accountId, challenge.email, challenge.email, now),
      this.db
        .prepare("INSERT INTO password_credentials(account_id, encoded_hash, updated_at) VALUES (?, ?, ?)")
        .bind(accountId, encodedHash, now),
    ]);
    return { accountId };
  }

  async authenticatePassword(email: string, password: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT a.id AS account_id, p.encoded_hash
         FROM accounts a JOIN password_credentials p ON p.account_id = a.id
         WHERE a.primary_email_normalized = ? AND a.status = 'active'`,
      )
      .bind(normalizeEmail(email))
      .first<{ account_id: string; encoded_hash: string }>();
    if (!row) return null;
    return (await verifyPassword(password, row.encoded_hash)) ? row.account_id : null;
  }

  async authenticateEmailLink(challengeId: string, token: string): Promise<string> {
    const challenge = await this.consumeChallenge(challengeId, token, "email_login");
    const account = await this.db
      .prepare("SELECT id FROM accounts WHERE primary_email_normalized = ? AND status = 'active'")
      .bind(challenge.email)
      .first<{ id: string }>();
    if (!account) throw new Error("account not found");
    return account.id;
  }

  async authenticateGoogle(
    assertion: ExternalIdentityAssertion,
  ): Promise<{ status: "authenticated"; accountId: string } | { status: "link_required" }> {
    if (!assertion.emailVerified) throw new Error("provider email is not verified");
    const existing = await this.db
      .prepare("SELECT account_id FROM login_identities WHERE provider = ? AND provider_subject = ?")
      .bind(assertion.provider, assertion.subject)
      .first<{ account_id: string }>();
    if (existing) return { status: "authenticated", accountId: existing.account_id };

    const collision = await this.db
      .prepare("SELECT id FROM accounts WHERE primary_email_normalized = ?")
      .bind(normalizeEmail(assertion.email))
      .first<{ id: string }>();
    if (collision) return { status: "link_required" };

    const accountId = crypto.randomUUID();
    const now = this.now();
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO accounts(id, primary_email_normalized, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(accountId, normalizeEmail(assertion.email), assertion.email.split("@")[0], now, now),
      this.db
        .prepare(
          `INSERT INTO login_identities(id, account_id, provider, provider_subject, email_normalized, email_verified, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          accountId,
          assertion.provider,
          assertion.subject,
          normalizeEmail(assertion.email),
          now,
        ),
    ]);
    return { status: "authenticated", accountId };
  }

  async linkGoogle(
    accountId: string,
    assertion: ExternalIdentityAssertion,
    authorization: LinkAuthorization,
  ): Promise<void> {
    assertSafeIdentityLink(assertion, authorization);
    const account = await this.db
      .prepare("SELECT primary_email_normalized FROM accounts WHERE id = ? AND status = 'active'")
      .bind(accountId)
      .first<{ primary_email_normalized: string }>();
    if (!account || account.primary_email_normalized !== normalizeEmail(assertion.email)) {
      throw new Error("verified email does not match account");
    }
    await this.db
      .prepare(
        `INSERT INTO login_identities(id, account_id, provider, provider_subject, email_normalized, email_verified, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        accountId,
        assertion.provider,
        assertion.subject,
        normalizeEmail(assertion.email),
        this.now(),
      )
      .run();
  }

  async createWorkspace(input: {
    accountId: string;
    name: string;
    slug: string;
    handle: string;
    jurisdiction: "global" | "eu";
    storageMode?: "local_host" | "cloud";
  }): Promise<{ workspaceId: string; memberId: string }> {
    const workspaceId = crypto.randomUUID();
    const memberId = crypto.randomUUID();
    const doId = this.workspaces.newUniqueId();
    const now = this.now();
    const version = 1;
    const operationId = crypto.randomUUID();
    const storageMode = input.storageMode ?? "local_host";
    const account = await this.db
      .prepare("SELECT display_name FROM accounts WHERE id = ? AND status = 'active'")
      .bind(input.accountId)
      .first<{ display_name: string }>();
    if (!account) throw new Error("account not found");
    const slug = input.slug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,47}[a-z0-9]$/.test(slug)) {
      throw new Error("workspace slug must be 3-49 lowercase letters, numbers or hyphens");
    }
    const member = {
      operationId,
      memberId,
      accountId: input.accountId,
      handle: validateHumanHandle(input.handle),
      displayName: account.display_name,
      role: "owner" as const,
      status: "active" as const,
      authorizationEpoch: 1,
      version,
      now,
    };

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO workspaces(id, slug, durable_object_id, name, jurisdiction, status, membership_version, storage_mode, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?)`,
        )
        .bind(workspaceId, slug, doId.toString(), input.name.trim(), input.jurisdiction, version, storageMode, now, now),
      this.db
        .prepare(
          `INSERT INTO memberships(member_id, workspace_id, account_id, role, status, authorization_epoch, version, created_at, updated_at)
           VALUES (?, ?, ?, 'owner', 'pending', 1, ?, ?, ?)`,
        )
        .bind(memberId, workspaceId, input.accountId, version, now, now),
      this.operationStatement(workspaceId, operationId, "membership_upsert", memberId, version, member, now),
    ]);

    const workspace = this.workspaces.get(doId);
    await workspace.initializeWorkspace({
      storageMode,
      hostEpoch: 0,
      routingEpoch: 1,
      workspaceSlug: slug,
      now,
    });
    await workspace.applyMembership(member);
    await this.db.batch([
      this.db.prepare("UPDATE memberships SET status = 'active', updated_at = ? WHERE member_id = ?").bind(now, memberId),
      this.db.prepare("UPDATE workspaces SET status = 'active', updated_at = ? WHERE id = ?").bind(now, workspaceId),
      this.db.prepare("UPDATE control_operations SET status = 'applied', applied_at = ? WHERE id = ?").bind(now, operationId),
    ]);
    return { workspaceId, memberId };
  }

  async inviteMember(input: {
    workspaceId: string;
    invitedByMemberId: string;
    email: string;
    role: Exclude<WorkspaceRole, "owner">;
  }): Promise<IssuedChallenge> {
    const inviter = await this.db
      .prepare(
        `SELECT role, status FROM memberships
         WHERE workspace_id = ? AND member_id = ?`,
      )
      .bind(input.workspaceId, input.invitedByMemberId)
      .first<{ role: WorkspaceRole; status: string }>();
    if (!inviter || inviter.status !== "active" || !["owner", "admin"].includes(inviter.role)) {
      throw new Error("active owner or admin required to invite");
    }
    const id = crypto.randomUUID();
    const token = randomToken();
    const tokenHash = await hashOpaqueToken(token);
    const createdAt = this.now();
    const expiresAt = createdAt + 7 * 24 * 60 * 60_000;
    await this.db
      .prepare(
        `INSERT INTO invitations(id, workspace_id, email_normalized, token_hash, role, invited_by_member_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, input.workspaceId, normalizeEmail(input.email), tokenHash, input.role, input.invitedByMemberId, expiresAt, createdAt)
      .run();
    return { id, token, expiresAt };
  }

  async acceptInvitation(input: {
    invitationId: string;
    token: string;
    accountId: string;
    handle: string;
  }): Promise<{ memberId: string }> {
    const tokenHash = await hashOpaqueToken(input.token);
    const invitation = await this.db
      .prepare(
        `SELECT i.workspace_id, i.email_normalized, i.role, w.durable_object_id, w.membership_version,
                a.primary_email_normalized, a.display_name
         FROM invitations i JOIN workspaces w ON w.id = i.workspace_id JOIN accounts a ON a.id = ?
         WHERE i.id = ? AND i.token_hash = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?`,
      )
      .bind(input.accountId, input.invitationId, tokenHash, this.now())
      .first<{
        workspace_id: string;
        email_normalized: string;
        role: Exclude<WorkspaceRole, "owner">;
        durable_object_id: string;
        membership_version: number;
        primary_email_normalized: string;
        display_name: string;
      }>();
    if (!invitation) throw new Error("invitation is invalid or expired");
    if (invitation.email_normalized !== invitation.primary_email_normalized) {
      throw new Error("invitation email is not verified by this account");
    }

    const memberId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const version = invitation.membership_version + 1;
    const now = this.now();
    const member = {
      operationId,
      memberId,
      accountId: input.accountId,
      handle: validateHumanHandle(input.handle),
      displayName: invitation.display_name,
      role: invitation.role,
      status: "active" as const,
      authorizationEpoch: 1,
      version,
      now,
    };
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO memberships(member_id, workspace_id, account_id, role, status, authorization_epoch, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, ?)`,
        )
        .bind(memberId, invitation.workspace_id, input.accountId, invitation.role, version, now, now),
      this.db.prepare("UPDATE workspaces SET membership_version = ?, updated_at = ? WHERE id = ?").bind(version, now, invitation.workspace_id),
      this.db.prepare("UPDATE invitations SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL").bind(now, input.invitationId),
      this.operationStatement(invitation.workspace_id, operationId, "membership_upsert", memberId, version, member, now),
    ]);
    await this.workspaces.get(this.workspaces.idFromString(invitation.durable_object_id)).applyMembership(member);
    await this.db.batch([
      this.db.prepare("UPDATE memberships SET status = 'active', updated_at = ? WHERE member_id = ?").bind(now, memberId),
      this.db.prepare("UPDATE control_operations SET status = 'applied', applied_at = ? WHERE id = ?").bind(now, operationId),
    ]);
    return { memberId };
  }

  async changeMemberRole(workspaceId: string, memberId: string, role: WorkspaceRole): Promise<void> {
    const now = this.now();
    const current = await this.db
      .prepare(
        `SELECT m.account_id, m.role, m.status, m.authorization_epoch, m.version,
                a.display_name, w.durable_object_id, w.membership_version
         FROM memberships m
         JOIN accounts a ON a.id = m.account_id
         JOIN workspaces w ON w.id = m.workspace_id
         WHERE m.workspace_id = ? AND m.member_id = ?`,
      )
      .bind(workspaceId, memberId)
      .first<{
        account_id: string;
        role: WorkspaceRole;
        status: "pending" | "active" | "suspended" | "removed";
        authorization_epoch: number;
        version: number;
        display_name: string;
        durable_object_id: string;
        membership_version: number;
      }>();
    if (!current) throw new Error("membership not found");
    const local = await this.workspaces
      .get(this.workspaces.idFromString(current.durable_object_id))
      .getMember(memberId);
    if (!local) throw new Error("workspace membership projection not found");
    const version = current.membership_version + 1;
    const operationId = crypto.randomUUID();
    const member = {
      operationId,
      memberId,
      accountId: current.account_id,
      handle: local.handle,
      displayName: current.display_name,
      role,
      status: current.status,
      authorizationEpoch: current.authorization_epoch + 1,
      version,
      now,
    };
    await this.db.batch([
      this.db.prepare("UPDATE workspaces SET membership_version = ?, updated_at = ? WHERE id = ?").bind(version, now, workspaceId),
      this.db
        .prepare(
          "UPDATE memberships SET role = ?, version = ?, authorization_epoch = ?, updated_at = ? WHERE workspace_id = ? AND member_id = ?",
        )
        .bind(role, version, member.authorizationEpoch, now, workspaceId, memberId),
      this.operationStatement(workspaceId, operationId, "membership_upsert", memberId, version, member, now),
    ]);
    await this.workspaces.get(this.workspaces.idFromString(current.durable_object_id)).applyMembership(member);
    await this.db
      .prepare("UPDATE control_operations SET status = 'applied', applied_at = ? WHERE id = ?")
      .bind(now, operationId)
      .run();
  }

  private async consumeChallenge(id: string, token: string, kind: ChallengeKind): Promise<{ email: string }> {
    const tokenHash = await hashOpaqueToken(token);
    const challenge = await this.db
      .prepare(
        `UPDATE auth_challenges SET consumed_at = ?
         WHERE id = ? AND kind = ? AND token_hash = ? AND consumed_at IS NULL AND expires_at > ?
         RETURNING email_normalized`,
      )
      .bind(this.now(), id, kind, tokenHash, this.now())
      .first<{ email_normalized: string }>();
    if (!challenge) throw new Error("challenge is invalid, expired or already used");
    return { email: challenge.email_normalized };
  }

  private async consumePasskeyChallenge(
    id: string,
    accountId: string,
    kind: "passkey_registration" | "passkey_authentication",
  ): Promise<string> {
    const consumed = await this.db
      .prepare(
        `UPDATE auth_challenges SET consumed_at = ?
         WHERE id = ? AND account_id = ? AND kind = ? AND consumed_at IS NULL AND expires_at > ?
         RETURNING challenge`,
      )
      .bind(this.now(), id, accountId, kind, this.now())
      .first<{ challenge: string }>();
    if (!consumed) throw new Error("passkey challenge is invalid, expired or already used");
    return consumed.challenge;
  }

  private async loadPasskeys(accountId: string): Promise<RegisteredPasskey[]> {
    const rows = await this.db
      .prepare("SELECT credential_id, public_key, sign_count, transports_json FROM passkeys WHERE account_id = ?")
      .bind(accountId)
      .all<{
        credential_id: ArrayBuffer | number[];
        public_key: ArrayBuffer | number[];
        sign_count: number;
        transports_json: string;
      }>();
    const decoder = new TextDecoder();
    return rows.results.map((row) => ({
      id: decoder.decode(toBytes(row.credential_id)),
      publicKey: toBytes(row.public_key),
      counter: row.sign_count,
      transports: JSON.parse(row.transports_json) as string[],
    }));
  }

  private operationStatement(
    workspaceId: string,
    operationId: string,
    kind: "membership_upsert",
    aggregateId: string,
    version: number,
    payload: unknown,
    now: number,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO control_operations(id, workspace_id, kind, aggregate_id, version, payload_json, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(operationId, workspaceId, kind, aggregateId, version, JSON.stringify(payload), now, now);
  }
}

function toBytes(value: ArrayBuffer | number[]): Uint8Array<ArrayBuffer> {
  const source = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  const copy = new Uint8Array(new ArrayBuffer(source.length));
  copy.set(source);
  return copy;
}
