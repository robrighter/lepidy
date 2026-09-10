import { DurableObject } from "cloudflare:workers";

import {
  migrateWorkspaceSchema,
  readWorkspaceSchema,
  type WorkspaceSchemaState,
} from "./workspace-migrations";
import {
  appendAuditEntry,
  appendReplayEvents,
  claimDueWork,
  claimOutboxBatch,
  completeDueWork,
  deferDueWork,
  enqueueOutbox,
  ensureRecurringWork,
  listDueWork,
  nextDueAt,
  nextPendingOutboxAt,
  readAuditEntries,
  scheduleDueWork,
  settleOutbox,
  sweepRetention,
  verifyStoredAuditChain,
  writeAuditAnchor,
  type AppendedAudit,
  type AuditAnchor,
  type DueWorkInput,
  type DueWorkRow,
  type MutationEffects,
  type OutboxDispatcher,
  type OutboxEntry,
  type OutboxOutcome,
  type RetentionSweepReport,
} from "./workspace-scheduler";
import type { AuditChainVerification, AuditEntryInput, StoredAuditEntry } from "../domain/audit-chain";
import {
  DAY_MS,
  DUE_WORK_BATCH_SIZE,
  OUTBOX_BATCH_SIZE,
  RETENTION_MS,
  redactedError,
} from "../domain/due-work";
import { parseIdempotencyKey } from "../domain/idempotency-key";
import {
  ACCESS_TOKEN_TTL_MS,
  AUTHORIZATION_CODE_TTL_MS,
  checkCodeExchange,
  checkPresentedToken,
  constantTimeEquals,
  decideRefresh,
  formatToken,
  hashSecret,
  nextMcpWriteWindow,
  parseToken,
  parseTokenOfKind,
  randomSecret,
  verifyCodeVerifier,
  workspaceSlugFromResource,
  type McpToolName,
  type SupportedScope,
} from "../domain/mcp-oauth";
import {
  SESSION_HARD_TTL_MS,
  delegationAllowsChannel,
  normalizeBoundedIds,
  normalizeSessionCapabilities,
  sessionAllowsTool,
  sessionTokenExpiresAt,
  validDelegationExpiry,
  type SessionCapability,
} from "../domain/agent-session";
import {
  directMessageIdentity,
  parseChannelName,
  parseChannelSlug,
  parseChannelTopic,
  MAX_MESSAGE_LENGTH,
  clampHistoryLimit,
  parseMessageBody,
  parseReactionEmoji,
  parseSnippet,
  resolveThreadPlacement,
  snippetMessageBody,
  type ChannelKind,
} from "../domain/rooms";
import {
  canReceiveChannelEvent,
  canSeeChannel,
  type ChannelVisibility,
} from "../domain/visibility";
import {
  PRESENCE_TTL_MS,
  advanceReadCursor,
  summariseUnread,
  type UnreadSummary,
} from "../domain/read-state";
import {
  SOCKET_PING,
  SOCKET_PONG,
  encodeServerFrame,
  parseClientFrame,
  type ServerFrame,
} from "../domain/socket-protocol";
import { parseMentions } from "../domain/mentions";
import {
  decideMessageNotification,
  homeRank,
  isDndActive,
  mayUseBroadcast,
  notificationIsVisible,
  parseNotifyLevel,
  type NotificationKind,
  type NotifyLevel,
} from "../domain/notifications";
import {
  assertKeyBelongsToWorkspace,
  fileObjectKey,
  fileStateTransition,
  isInlineRenderable,
  parseFileName,
  parseMediaType,
  quotaDecision,
  QUOTA_WARN_FRACTION,
  RESERVATION_TTL_MS,
} from "../domain/files";
import {
  MAX_UNFURL_FETCHES_PER_READ,
  UNFURL_CACHE_TTL_MS,
  UNFURL_FAILURE_TTL_MS,
  externalLinksFromMarkdown,
  fetchLinkUnfurl,
  type LinkUnfurl,
} from "../domain/link-unfurl";
import {
  nextSearchCursor,
  parseSearchQuery,
  searchCursor,
  searchMatch,
  type ParsedSearchQuery,
} from "../domain/search";
import {
  parseAvailability,
  parseGroupHandle,
  parseProfile,
  planGroupMention,
  resolvePresence,
  type Availability,
  type Presence,
} from "../domain/people";
import {
  callManagedAgents,
  customWake,
  decryptTransportSecret,
  deliverCustomWake,
  encryptTransportSecret,
  exchangeWifAssertion,
  mintWifAssertion,
  validateBudgetChange,
  validateProviderSchedule,
  validatePublicCallbackUrl,
  validateWifAuthority,
  type AnthropicThinEvent,
  type WifAuthority,
} from "../domain/cloud-custom-runtime";
import { isEmojiToken, parseCustomEmojiName } from "../domain/emoji";
import {
  agentMayPostIn,
  decideEnqueue,
  flagSuspiciousContent,
  mayRemoveOwner,
  type AgentScope,
} from "../domain/agent-scope";
import {
  SECURITY_PREAMBLE_VERSION,
  assembleBrief,
  parseAgentBrief,
  type BriefTier,
} from "../domain/agent-preamble";
import {
  canaryRefusalHint,
  findCanaryMarkers,
  normalizeCanaryMarker,
  normalizeScanTarget,
} from "../domain/vault-canary";
import { commandMessageBody, parseComposerInput } from "../domain/slash-commands";
import { parseAgentHandle } from "../domain/mention-handle";
import {
  buildFormSubmission,
  maySeeQueueStatus,
  parseFormDefinition,
  parseQueueStatuses,
  queuePreset,
  renderFormSubmission,
  type FormDefinition,
  type FormSubmission,
  type QueuePreset,
  type QueueStatus,
} from "../domain/work-queues";
import {
  addChannelMembers,
  addReaction,
  annotateMessages,
  applyMessageDelete,
  applyMessageEdit,
  archiveChannel,
  channelMemberIds,
  insertChannel,
  insertMessage,
  insertMcpMessageAttribution,
  insertAgentSessionMessageAttribution,
  isChannelMember,
  listChannelHistory,
  listQueueHistory,
  listThreadHistory,
  agentOwnerIds,
  visibleAgentQueueDepth,
  agentScopeChannelIds,
  claimDueScheduledMessages,
  customEmojiExists,
  deleteCustomEmoji,
  deleteDraft,
  insertCustomEmoji,
  insertSnippet,
  enqueueAgentWork,
  pageAgentQueue,
  listAgentRows,
  listCustomEmoji,
  insertScheduledMessage,
  listDraftsForMember,
  listPinnedMessages,
  listSavedPointers,
  listScheduledForMember,
  nextScheduledSendAt,
  readAgent,
  readAgentByHandle,
  readDraft,
  readScheduledMessage,
  replaceAgentScope,
  readSnippets,
  readMcpMessageAttributions,
  settleScheduledMessage,
  updateScheduledMessage,
  writeDraft,
  consumeOauthCode,
  deleteExpiredOauthCodes,
  insertOauthCode,
  insertOauthConnection,
  listOauthConnectionsForMember,
  readConnectionByAccessHash,
  readConnectionByRefreshHash,
  readOauthCode,
  readOauthConnection,
  revokeOauthConnectionRow,
  rotateOauthConnection,
  touchOauthConnection,
  listVisibleChannels,
  nextChannelSequence,
  pinMessage,
  pinnedMessageIds,
  saveMessageForMember,
  savedMessageIds,
  unpinMessage,
  unsaveMessageForMember,
  readChannel,
  readChannelByDirectMessageKey,
  readChannelBySlug,
  latestChannelSequence,
  latestThreadSequence,
  readChannelCursor,
  readMessage,
  readThreadCursor,
  readUnreadFacts,
  removeChannelMember,
  removeReaction,
  replaceMentions,
  resolveMentionTargets,
  writeChannelCursor,
  writeThreadCursor,
  setAgentQueueReadState,
  type AgentRow,
  type ChannelRow,
  type CustomEmojiRow,
  type QueueItemRow,
  type AgentQueueCursor,
  type DraftRow,
  type MessagePage,
  type MessageRow,
  type ScheduledMessageRow,
} from "./workspace-rooms";
import { verifySoloSnapshot, type SoloContentSnapshot } from "../domain/solo-snapshot";
import {
  decideVaultAuthorization,
  vaultDenialHint,
  type VaultDecision,
  type VaultDelivery,
  type VaultScope,
} from "../domain/vault-authorization";
import { parseRemoteLocalAgentTrigger, type LocalAgentTrigger } from "../domain/local-agent-trigger";
import {
  decideLocalStart,
  delegationSentence,
  isLocalPresetIntent,
  isLocalStartPolicy,
  localPresetRequestIsConfirmed,
  type LocalPresetIntent,
  type LocalStartPolicy,
  type RuntimeKind,
  type SelfServeRuntimeKind,
} from "../domain/runtime-config";
import {
  VAULT_PROXY_REQUEST_TTL_MS,
  normalizeVaultProxyRequest,
  openVaultProxyResponse,
  sealVaultProxyRequest,
  validateVaultProxyResult,
  type VaultProxyRelayEnvelope,
  type VaultProxyRequest as ProxyHttpRequest,
  type VaultProxyResponseEnvelope,
  type VaultProxyResult,
} from "../domain/vault-proxy";
import {
  VAULT_WRAP_SUITE,
  assertOpaqueId,
  decodeVaultBytes,
  encodeVaultBytes,
  validateVaultEnvelope,
  validateVaultKeyWrap,
  validateVaultPublicKey,
  type VaultCiphertextEnvelope,
  type VaultKeyWrap,
} from "../domain/vault-envelope";
import {
  MAX_APPROVAL_CREDENTIALS,
  VAULT_AGENT_HANDLE,
  VAULT_APPROVAL_TTL_MS,
  approvalAnswerMarkdown,
  approvalCardMarkdown,
  approvalExpiredMarkdown,
  approvalGrantExpiry,
  approvalPendingHint,
  approvalTimeoutHint,
  availableApprovalWindows,
  canonicalApprovalDigest,
  decideApprovalTransition,
  isApprovalExpired,
  killSwitchAnnouncement,
  validateApprovalItems,
  validateApprovalTuple,
  vaultDirectMessageKey,
  type ApprovalDecisionInput,
  type ApprovalOutcome,
  type ApprovalRequestTuple,
  type ApprovalStatus,
  type ApprovalWindow,
  type KillSwitchScope,
} from "../domain/vault-approval";
import {
  normalizeCapturedFrom,
  normalizeVaultMetadata,
  normalizeVaultPolicy,
  rotationState,
  validateVaultAcl,
  type VaultAclEntry,
  type RotationState,
  type VaultCredentialKind,
  type VaultCredentialMetadata,
  type VaultPolicy,
} from "../domain/vault-policy";

export type WorkspaceHealth = {
  ok: boolean;
  schemaVersion: number;
  status: WorkspaceSchemaState["status"];
  error: string | null;
};

export type MemberProjection = {
  operationId: string;
  memberId: string;
  accountId: string;
  handle: string;
  displayName: string;
  role: "owner" | "admin" | "member" | "guest";
  status: "pending" | "active" | "suspended" | "removed";
  authorizationEpoch: number;
  version: number;
  now: number;
};

export type WorkspaceStorageMode = "local_host" | "cloud";

export type OpaqueRelayFrameMetadata = {
  workspaceId: string;
  hostEpoch: number;
  sequence: number;
  requestId: string;
  direction: "to_host" | "from_host";
  ciphertextBytes: number;
};

export type MutationOutcome<T> = {
  replayed: boolean;
  result: T;
  audit: AppendedAudit | null;
  outboxQueued: number;
  alarmAt: number | null;
};

export type DueWorkReport = {
  now: number;
  processed: readonly string[];
  failed: readonly { id: string; kind: string; error: string; retried: boolean }[];
  outbox: { attempted: number; delivered: number; retried: number; dead: number };
  retention: RetentionSweepReport | null;
  anchor: AuditAnchor | null;
  scheduledSends: { sent: number; failed: number };
  approvals: { expired: number };
  alarmAt: number | null;
};

export type SchedulerState = {
  alarmAt: number | null;
  dueWork: readonly DueWorkRow[];
  pendingOutbox: number;
  deadOutbox: number;
  auditSequence: number;
};

/** Recurring work every workspace owns from the moment it exists. */
export const RETENTION_SWEEP_WORK_ID = "system:retention_sweep";
export const AUDIT_ANCHOR_WORK_ID = "system:audit_anchor";
export const OUTBOX_FLUSH_WORK_ID = "system:outbox_flush";
/** One row for every pending card, re-armed at the earliest expiry. */
export const VAULT_APPROVAL_EXPIRY_WORK_ID = "system:vault_approval_expiry";

export type ShellChannel = {
  id: string;
  kind: "public" | "private" | "dm" | "group_dm";
  slug: string | null;
  name: string | null;
  isMember: boolean;
  postMode: "open" | "form";
  formDefinition: FormDefinition | null;
  sortMode: "chronological" | "ranked";
  sortEmoji: string | null;
  statusDefinitions: readonly QueueStatus[];
  mainStatusLabel: string;
  canManageQueue: boolean;
};

export type ShellAgent = {
  id: string;
  handle: string;
  displayName: string;
  status: "active" | "paused" | "archived";
};

export type ShellViewer = {
  memberId: string;
  handle: string;
  displayName: string;
  role: MemberProjection["role"];
  authorizationEpoch: number;
};

export type WorkspaceShellSnapshot = {
  viewer: ShellViewer;
  channels: readonly ShellChannel[];
  agents: readonly ShellAgent[];
  storageMode: WorkspaceStorageMode | null;
  schemaVersion: number;
};

export type WorkQueueSnapshot = {
  channel: ChannelRow;
  canManage: boolean;
  tabs: readonly { id: string | null; label: string; count: number }[];
  selectedStatusId: string | null;
  page: MessagePage;
};

export type NotificationActivityItem = {
  id: string;
  kind: NotificationKind;
  messageId: string;
  channelId: string;
  channelLabel: string;
  authorKind: "member" | "agent";
  authorLabel: string;
  bodyMarkdown: string;
  threadRootId: string | null;
  createdAt: number;
  readAt: number | null;
  badge: boolean;
  pushAllowed: boolean;
  rank: number;
};

export type NotificationActivity = {
  items: readonly NotificationActivityItem[];
  unread: { total: number; mentions: number; threads: number; dms: number };
};

export type NotificationPreferencesSnapshot = {
  channels: readonly { channelId: string; level: NotifyLevel }[];
  keywords: readonly string[];
  dndStartMinute: number | null;
  dndEndMinute: number | null;
  dndManualUntil: number | null;
};

export type Actor = { memberId: string; authorizationEpoch: number };

export type ActiveMember = {
  id: string;
  handle: string;
  displayName: string;
  role: MemberProjection["role"];
};

export type DirectoryMember = {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  role: MemberProjection["role"];
  status: MemberProjection["status"];
  title: string | null;
  timezone: string | null;
  workingStartMinute: number | null;
  workingEndMinute: number | null;
  customStatus: string | null;
  /** What this member declared; `auto` means they left it to their connections. */
  availability: Availability;
  /** What a reader should show: the declaration if there is one, else live state. */
  presence: Presence;
  ownedAgentCount: number;
};

export type DirectoryGroup = {
  id: string;
  handle: string;
  displayName: string;
  description: string | null;
  createdByMemberId: string | null;
  memberIds: readonly string[];
};

type FileRow = {
  id: string; object_key: string; file_name: string; media_type: string; byte_length: number;
  sha256: string | null; uploaded_by_member_id: string | null; channel_id: string; message_id: string | null;
  state: "reserved" | "stored" | "deleted"; created_at: number; expires_at: number | null;
  confirmed_at: number | null; deleted_at: number | null;
  uploader_display_name?: string | null; uploader_handle?: string | null;
  channel_name?: string | null; channel_slug?: string | null;
};

export type FileListFilters = {
  query?: string | null;
  mediaTypePrefix?: string | null;
  uploaderMemberId?: string | null;
  channelId?: string | null;
  createdAtOrAfter?: number | null;
  createdBefore?: number | null;
};

export type StoredFile = {
  id: string;
  fileName: string;
  mediaType: string;
  byteLength: number;
  channelId: string;
  messageId: string | null;
  uploadedByMemberId: string | null;
  uploadedByDisplayName: string | null;
  uploadedByHandle: string | null;
  channelName: string | null;
  channelSlug: string | null;
  createdAt: number;
  /** Only images render inline; everything else is offered as a download. */
  inlineRenderable: boolean;
};

export type MessageLinkUnfurl = LinkUnfurl & { messageId: string; position: number };

export type WorkspaceSearchHit =
  | { kind: "message"; id: string; channelId: string; channelLabel: string; threadRootId: string | null; authorKind: string; authorDisplayName: string; bodyMarkdown: string; createdAt: number }
  | { kind: "file"; id: string; channelId: string; channelLabel: string; fileName: string; mediaType: string; byteLength: number; uploaderDisplayName: string | null; createdAt: number }
  | { kind: "credential"; id: string; name: string; description: string; createdAt: number };

export type WorkspaceSearchPage = {
  query: ParsedSearchQuery;
  hits: readonly WorkspaceSearchHit[];
  nextCursor: string | null;
};

export type SavedSearch = { id: string; name: string; query: string; createdAt: number; updatedAt: number };

export type PeopleDirectory = {
  people: readonly DirectoryMember[];
  groups: readonly DirectoryGroup[];
};

export type VaultCredentialSummary = VaultCredentialMetadata & {
  id: string;
  policy: VaultPolicy;
  /**
   * A deliberately fake value that exists to be stolen (PRD §8.8). Said out
   * loud in every listing, because a person looking at the vault should never
   * wonder whether a credential is the real one.
   */
  canary: boolean;
  version: number;
  keyEpoch: number;
  policyEpoch: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt?: number;
  accessCount: number;
};

/**
 * One credential's leak-detection facts, as a client receives them.
 *
 * `digest` and `length` are absent when the client that sealed the value chose
 * not to publish a verifier, or the value was too short for one to be worth
 * having. `canaryMarker` is present only for a canary and is not a secret.
 */
export type VaultScanTarget = {
  credentialId: string;
  name: string;
  digest: string | null;
  length: number | null;
  canaryMarker: string | null;
};

export type VaultMemberKey = {
  memberId: string;
  keyEpoch: number;
  wrapSuite: string;
  publicKey: string;
};

export type VaultApprovalSummary = {
  approvalId: string;
  expiresAt: number;
  credentialIds: readonly string[];
  credentialNames: readonly string[];
  approverMemberIds: readonly string[];
  /** What the agent is told while it waits, in the product's own words. */
  hint: string;
};

export type VaultApprovalRequestResult = {
  approvals: readonly VaultApprovalSummary[];
  /** Credentials that needed no card: already allowed, or already refused. */
  decisions: readonly { credentialId: string; decision: VaultDecision; hint?: string }[];
};

export type VaultApprovalCard = {
  approvalId: string;
  status: ApprovalStatus;
  requesterMemberId: string;
  requesterHandle: string;
  agentHandle: string | null;
  deviceId: string;
  projectId: string;
  delivery: VaultDelivery;
  reason: string;
  createdAt: number;
  expiresAt: number;
  viewerMayDecide: boolean;
  items: readonly {
    credentialId: string;
    name: string;
    description: string;
    highRisk: boolean;
    version: number;
    policyEpoch: number;
    windows: readonly ApprovalWindow[];
  }[];
};

export type VaultApprovalDecisionResult = {
  status: ApprovalStatus;
  accepted: boolean;
  reason?: string;
  decidedByMemberId?: string;
  decisions: readonly { credentialId: string; name: string; outcome: ApprovalOutcome; window: ApprovalWindow; grantId?: string }[];
};

type VaultApprovalRow = {
  id: string; status: ApprovalStatus; requester_member_id: string; agent_id: string | null; delegation_id: string | null;
  device_id: string; project_id: string; origin_channel_id: string; origin_message_id: string;
  delivery: VaultDelivery; reason: string; access_epoch: number; created_at: number; expires_at: number;
  decided_at: number | null; decided_by_member_id: string | null; decision_digest: string | null;
};

type VaultApprovalItemRow = {
  approval_id: string; credential_id: string; credential_version: number; policy_epoch: number;
  outcome: ApprovalOutcome | null; grant_window: ApprovalWindow | null; grant_id: string | null;
  name: string; description: string; high_risk: number; grant_ttl_ms: number | null;
};

export type VaultGrantRow = {
  grantId: string;
  credentialId: string;
  credentialName: string;
  memberId: string;
  memberHandle: string;
  agentId: string | null;
  agentHandle: string | null;
  approverMemberId: string;
  approverHandle: string;
  deviceId: string;
  projectId: string;
  delivery: VaultDelivery;
  expiresAt: number | null;
  singleUse: boolean;
  createdAt: number;
  viewerMayRevoke: boolean;
};

export type VaultAclSubject = {
  subjectType: VaultAclEntry["subjectType"];
  subjectId: string;
  /** Ready to render: `@handle` or `#slug`, resolved inside the tenant. */
  label: string;
};

export type VaultCredentialDetail = {
  credential: VaultCredentialSummary;
  frozen: boolean;
  frozenAt: number | null;
  frozenByHandle: string | null;
  /** Switched off because nobody has confirmed the capture that made it yet. */
  awaitingCaptureReview: boolean;
  /** The program whose output became this value, if one did. */
  capturedFrom: string | null;
  rotation: RotationState;
  createdByHandle: string;
  use: readonly VaultAclSubject[];
  reveal: readonly VaultAclSubject[];
  manage: readonly VaultAclSubject[];
  viewer: { mayUse: boolean; mayReveal: boolean; mayManage: boolean };
};

export type VaultActivityRow = {
  kind: "used" | "asked" | "decided" | "timed_out";
  at: number;
  credentialId: string;
  credentialName: string;
  delivery: VaultDelivery;
  deviceId: string;
  projectId: string;
  /** The member the request was made for; an agent operates under this person. */
  memberId: string;
  memberHandle: string;
  agentId: string | null;
  agentHandle: string | null;
  /** Whoever answered, kept separate from whoever asked. */
  approverHandle: string | null;
  detail: string;
  outcome?: "allowed" | "denied";
};

export type AgentDetail = {
  id: string;
  handle: string;
  displayName: string;
  description: string | null;
  status: "active" | "paused" | "archived";
  vaultAccessOff: boolean;
  vaultAccessOffAt: number | null;
  isOwner: boolean;
  ownerHandles: readonly string[];
  scopeMode: "any" | "listed";
  scopeChannelIds: readonly string[];
  scopeChannelCount: number;
};

/**
 * Everything the runtime screen reads, in one shape.
 *
 * Note what is not here, and cannot be added: no executable, no argument, no
 * working directory, no environment mapping, no permission posture, no resource
 * limit. A local preset appears as the opaque name and the revision number the
 * machine itself reported, which is the whole of what the cloud is allowed to
 * know about it (D05a).
 */
export type AgentRuntimeView = {
  agentId: string;
  handle: string;
  agentStatus: "active" | "paused" | "archived";
  kind: RuntimeKind;
  /** Whether somebody chose this runtime, or it is only the default. */
  chosen: boolean;
  providerStatus: "pending" | "active" | "disconnected" | null;
  local: {
    startOnMention: boolean;
    whoMayStart: LocalStartPolicy;
    device: {
      deviceId: string;
      presetId: string;
      presetRevision: number;
      runnerEpoch: number;
      connected: boolean;
      lastSeenAt: number | null;
      assignedAt: number;
    } | null;
    waiting: number;
    needsAttention: number;
    presetRequests: readonly {
      id: string;
      intent: LocalPresetIntent;
      requestedByHandle: string;
      revisionAtRequest: number;
      state: "pending" | "confirmed" | "withdrawn";
      createdAt: number;
      resolvedAt: number | null;
      resolvedRevision: number | null;
    }[];
  };
  cloud: {
    organizationId: string | null;
    providerWorkspaceId: string | null;
    providerAgentId: string | null;
    providerEnvironmentId: string | null;
    providerDeploymentId: string | null;
    wifSubject: string | null;
    wifAudience: string | null;
    budgetCents: number | null;
    resourceProvedAt: number | null;
    webhookProvedAt: number | null;
    wifFailures: number;
  } | null;
  custom: {
    callbackUrl: string;
    deliveries: readonly {
      deliveryId: string;
      state: "pending" | "delivered" | "dead";
      attempts: number;
      lastError: string | null;
      createdAt: number;
    }[];
  } | null;
  delegation: {
    id: string;
    ownerHandle: string;
    channelNames: readonly string[] | null;
    credentialNames: readonly string[];
    expiresAt: number;
    spendCapDailyCents: number | null;
    deliveryModes: readonly string[];
    sentence: string;
  } | null;
  sessions: readonly {
    sessionId: string;
    deviceId: string;
    presetRevision: number;
    startedAt: number;
    hardExpiresAt: number;
    lastUsedAt: number | null;
    endedAt: number | null;
    endedReason: string | null;
    live: boolean;
  }[];
  runs: readonly {
    id: string;
    kind: "mention" | "scheduled" | "manual";
    state: "queued" | "starting" | "running" | "idle" | "succeeded" | "failed" | "terminated";
    failureCode: string | null;
    budgetCents: number | null;
    hasProviderSession: boolean;
    createdAt: number;
    updatedAt: number;
  }[];
};

export type VaultAccessRequest = {
  actor: Actor;
  credentialId: string;
  device: { id: string; active: boolean; ownedByMember: boolean; signatureVerified: boolean; nonceFresh: boolean };
  origin: { channelId: string; messageId: string };
  projectId: string;
  delivery: VaultDelivery;
  agentId?: string;
  delegationId?: string;
  now: number;
};

type VaultCredentialRow = {
  id: string; name: string; description: string; env_var: string | null;
  tags_json: string; commands_json: string; proxy_hosts_json: string;
  cipher_suite: "AES-256-GCM"; aad_version: 1; ciphertext: string; iv: string;
  key_epoch: number; version: number; policy_epoch: number;
  mode: VaultPolicy["mode"]; allowed_deliveries_json: string; project_ids_json: string;
  grant_ttl_ms: number | null; available_until: number | null; max_uses_per_hour: number | null;
  high_risk: number; created_by_member_id: string; created_at: number; updated_at: number;
  last_accessed_at: number | null; access_count: number;
  frozen_at: number | null; frozen_by_member_id: string | null;
  kind: VaultCredentialKind; fields_json: string; rotate_at: number | null;
  frozen_reason: "switched_off" | "awaiting_capture_review" | null; captured_from: string | null;
  scan_digest: string | null; scan_length: number | null; canary_marker: string | null;
};

export type CreatedChannel = { channelId: string; kind: ChannelKind; created: boolean };

export type SentMessage = {
  messageId: string;
  channelId: string;
  threadRootId: string | null;
  channelSequence: number;
  createdAt: number;
  replayed: boolean;
};

/** What a hibernated socket remembers about itself. */
export type SocketAttachment = {
  memberId: string;
  authorizationEpoch: number;
  /** Highest replay sequence this socket has been sent. */
  cursor: number;
  connectedAt: number;
};

/**
 * What a hibernated *runner* socket remembers about itself (R01).
 *
 * Deliberately a different shape from a member's. A runner is a machine, not a
 * person: it has no read cursor, no replay, and it must never appear in
 * presence — an owner's laptop showing as online because a headless daemon
 * reconnected would be a lie about who is at the keyboard.
 */
export type RunnerAttachment = {
  kind: "runner";
  deviceId: string;
  memberId: string;
  authorizationEpoch: number;
  /**
   * The registration this socket belongs to. A runner that reregisters gets a
   * higher epoch, and the older connection is closed rather than left to race
   * the new one for the same queue.
   */
  runnerEpoch: number;
  connectedAt: number;
};

/** The tag a runner socket is found by after hibernation. */
export function runnerSocketTag(deviceId: string): string {
  return `runner:${deviceId}`;
}

/**
 * What the workspace is allowed to say to a runner.
 *
 * `wake` carries the D05a remote trigger and nothing else: a workspace id, an
 * agent id, a device id, the *name* of a preset the machine already holds, that
 * preset's revision, and a request id. There is no field for an executable, an
 * argument, a path, an environment or a permission posture, so there is no
 * remote launch configuration to smuggle. `stop` carries a reason a person
 * could read.
 */
export type RunnerFrame =
  | { type: "wake"; trigger: LocalAgentTrigger }
  | { type: "stop"; agentId: string; reason: string }
  | { type: "welcome"; deviceId: string; runnerEpoch: number; agentIds: readonly string[] }
  | {
      type: "proxy_request";
      requestId: string;
      workspaceId: string;
      credentialId: string;
      credentialVersion: number;
      credentialKeyEpoch: number;
      allowedHosts: readonly string[];
      relay: VaultProxyRelayEnvelope;
      envelope: VaultCiphertextEnvelope;
      wrap: VaultKeyWrap;
    };

export type VaultProxyRequestResult =
  | { state: "pending"; requestId: string; expiresAt: number }
  | { state: "completed"; requestId: string; result: VaultProxyResult }
  | { state: "needs_approval"; approvalId: string; expiresAt: number; hint: string }
  | { state: "refused" | "uncertain"; requestId?: string; error: string };

export type AgentSummary = {
  id: string;
  handle: string;
  displayName: string;
  description: string | null;
  status: "active" | "paused" | "archived";
  scopeMode: "any" | "listed";
  /** Only the scoped rooms this reader may see. */
  scopeChannelIds: readonly string[];
  scopeChannelCount: number;
  ownerIds: readonly string[];
  isOwner: boolean;
  /** Only an owner sees a queue depth. */
  queueDepth: number | null;
};

export type ComposerOutcome =
  | { kind: "sent"; messageId: string }
  | { kind: "acted"; command: "join" | "leave" | "archive" }
  | { kind: "rejected"; reason: string };

export type DraftSaveResult =
  | { status: "saved"; draft: DraftRow }
  | { status: "cleared"; draft: null }
  /** Another device moved the draft on; this is what is actually stored. */
  | { status: "conflict"; draft: DraftRow };

/**
 * OAuth protocol answers are values, not exceptions.
 *
 * An OAuth endpoint has to reply with a specific error code in a JSON body, so
 * the object decides the code once and the route reports it. Turning an
 * exception's message back into a code at the route would be a second place
 * where the refusal is decided, and the two would eventually disagree.
 */
export type OauthCodeResult =
  | { ok: true; code: string }
  | { ok: false; error: string; description: string };

export type OauthGrant = {
  connectionId: string;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scope: string;
};

export type OauthGrantResult =
  | { ok: true; grant: OauthGrant }
  | { ok: false; error: string; description: string };

/** Who a verified access token acts as. Derived from the token and nowhere else. */
export type OauthPrincipal = {
  connectionId: string;
  memberId: string;
  handle: string;
  displayName: string;
  role: MemberProjection["role"];
  authorizationEpoch: number;
  scope: string;
  clientId: string;
  clientName: string | null;
};

export type OauthPrincipalResult =
  | { ok: true; principal: OauthPrincipal }
  | { ok: false; error: "invalid_token" | "insufficient_scope"; description: string };

export type AgentSessionPrincipal = {
  credentialKind: "session";
  sessionId: string;
  delegationId: string;
  agentId: string;
  agentHandle: string;
  memberId: string;
  handle: string;
  displayName: string;
  role: MemberProjection["role"];
  authorizationEpoch: number;
  capabilities: readonly SessionCapability[];
  channelIds: readonly string[] | null;
  deviceId: string;
  runnerEpoch: number;
  presetRevision: number;
  clientId: string;
  clientName: string;
};

export type McpPrincipal = (OauthPrincipal & { credentialKind: "oauth" }) | AgentSessionPrincipal;

export type McpPrincipalResult =
  | { ok: true; principal: McpPrincipal }
  | { ok: false; error: "invalid_token" | "insufficient_scope"; description: string };

export type AgentDelegation = {
  id: string;
  agentId: string;
  ownerMemberId: string;
  ownerAuthorizationEpoch: number;
  channelIds: readonly string[] | null;
  credentialIds: readonly string[];
  deliveryModes: readonly string[];
  projectIds: readonly string[];
  spendCapDailyCents: number | null;
  spendCapMonthlyCents: number | null;
  rateLimitPerHour: number | null;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
};

export type AgentSessionGrant = {
  sessionId: string;
  delegationId: string;
  agentId: string;
  token: string;
  tokenExpiresAt: number;
  hardExpiresAt: number;
  capabilities: readonly SessionCapability[];
};

type AgentSessionRow = {
  id: string;
  delegationId: string;
  agentId: string;
  ownerMemberId: string;
  deviceId: string;
  runnerEpoch: number;
  presetRevision: number;
  capabilities: readonly SessionCapability[];
  tokenHash: string;
  tokenExpiresAt: number;
  hardExpiresAt: number;
  revokedAt: number | null;
};

export type McpAttribution = {
  connectionId: string | null;
  sessionId: string | null;
  delegationId: string | null;
  memberId: string;
  memberHandle: string;
  clientId: string;
  clientName: string | null;
  deviceId: string | null;
};

export type AgentLease = {
  itemId: string;
  agentId: string;
  messageId: string;
  channelId: string;
  sessionId: string;
  leaseGeneration: number;
  leaseExpiresAt: number;
  attemptCount: number;
  claimId: string;
};

export type AgentLeaseResult =
  | { ok: true; lease: AgentLease; item: QueueItemRow; replayed: boolean }
  | { ok: true; lease: null; item: null; replayed: false };

export type AgentLeaseProof = {
  actor: Actor;
  connectionId?: string | null;
  sessionToken?: string | null;
  agent: string;
  itemId: string;
  sessionId: string;
  leaseGeneration: number;
  leaseToken: string;
};

type AgentToolCredential =
  | { kind: "oauth"; connectionId: string; sessionId: null; delegationId: null; deviceId: null; channelIds: null }
  | { kind: "session"; connectionId: null; sessionId: string; delegationId: string; deviceId: string; channelIds: readonly string[] | null };

export type OauthConnectionSummary = {
  id: string;
  clientId: string;
  clientName: string | null;
  scope: string;
  createdAt: number;
  lastUsedAt: number | null;
  rotationCount: number;
};

/** One multiplexed deadline covers every pending scheduled send. */
export const SCHEDULED_SEND_WORK_ID = "system:scheduled_send";
export const RUNTIME_RECONCILIATION_WORK_ID = "system:runtime_reconciliation";
const SCHEDULED_SEND_BATCH = 25;
/** A year is already further ahead than anybody means; beyond it is a mistake. */
const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * How many agents one machine may answer for.
 *
 * Not a licence limit: a bound on how much one registration can move at once,
 * so a mistaken or hostile call cannot reassign an entire workspace's agents to
 * one device in a single request.
 */
const MAX_RUNNER_AGENTS = 64;

/**
 * What a runner's session may do, and nothing more.
 *
 * Exactly the tools a harness needs to work a queue item and answer in the
 * room it came from. No `post_message` as a person, no agent administration,
 * no vault verb: a session that could widen itself is not a boundary.
 */
const RUNNER_SESSION_CAPABILITIES = [
  "whoami",
  "list_channels",
  "read_channel",
  "read_thread",
  "agent_inbox",
  "agent_next",
  "agent_start",
  "agent_renew",
  "agent_complete",
  "agent_post",
  "proxy_request",
] as const;

/**
 * How a run ended, as the machine saw it.
 *
 * `blocked` is the one that matters: the harness refused to do something under
 * its own safe default permission posture, which is a person's decision waiting
 * to be made rather than an error.
 */
export const RUNNER_RUN_OUTCOMES = ["completed", "blocked", "failed"] as const;
export type RunnerRunOutcome = (typeof RUNNER_RUN_OUTCOMES)[number];

type RunnerDeviceRow = {
  device_id: string;
  member_id: string;
  runner_epoch: number;
  preset_revision: number;
  registered_at: number;
  last_seen_at: number | null;
};

type VaultProxyRequestRow = {
  id: string; idempotency_key: string; request_hash: string; requester_member_id: string;
  agent_id: string; delegation_id: string; release_device_id: string; project_id: string;
  origin_channel_id: string; origin_message_id: string; credential_id: string;
  credential_version: number; policy_epoch: number; access_epoch: number;
  relay_suite: string; relay_ephemeral_public_key: string; relay_iv: string; relay_ciphertext: string;
  response_key: string; state: "pending" | "completed" | "refused" | "uncertain";
  delivered_at: number | null; completed_at: number | null; result_json: string | null;
  created_at: number; expires_at: number;
};

type AgentRuntimeConfigRow = {
  agent_id: string; kind: RuntimeKind; status: "pending" | "active" | "disconnected";
  organization_id: string | null; provider_workspace_id: string | null; provider_agent_id: string | null;
  provider_environment_id: string | null; provider_deployment_id: string | null; wif_issuer: string | null;
  wif_audience: string | null; wif_subject: string | null; service_account_id: string | null;
  federation_rule_id: string | null; callback_url: string | null; secret_envelope: string | null;
  budget_cents: number | null; resource_proved_at: number | null; webhook_proved_at: number | null;
  wif_failures: number;
  created_at: number; updated_at: number;
};

/** A wake that has committed and is waiting to be handed to a socket. */
type StagedRunnerWake = { deviceId: string; agentId: string; presetId: string; requestId: string };

/** Roles that may create rooms. A guest joins what they are invited to. */
const ROOM_CREATOR_ROLES: ReadonlySet<MemberProjection["role"]> = new Set(["owner", "admin", "member"]);

export class Workspace extends DurableObject<CloudflareEnv> {
  /**
   * Wakes that a transaction has written and not yet handed to a socket.
   *
   * In memory on purpose, and short-lived: it lives only between the durable
   * write and the send that follows it. The durable row in `runner_wakes` is
   * the record; this is just the list of sends owed for the transaction that is
   * committing. Losing it to an eviction costs nothing, because a runner
   * collects whatever is undelivered the moment it reconnects.
   */
  private readonly stagedRunnerWakes = new Map<string, StagedRunnerWake>();

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      const schema = migrateWorkspaceSchema(ctx.storage);
      if (schema.status !== "ready") return;
      const now = Date.now();
      ctx.storage.transactionSync(() => {
        ensureRecurringWork(
          ctx.storage,
          [
            { id: RETENTION_SWEEP_WORK_ID, kind: "retention_sweep", dueAt: now + DAY_MS, intervalMs: DAY_MS },
            { id: AUDIT_ANCHOR_WORK_ID, kind: "audit_anchor", dueAt: now + DAY_MS, intervalMs: DAY_MS },
            { id: RUNTIME_RECONCILIATION_WORK_ID, kind: "runtime_reconciliation", dueAt: now + DAY_MS, intervalMs: DAY_MS },
          ],
          now,
        );
      });
      // An evicted object loses nothing: the alarm is rebuilt from durable state.
      await this.armAlarm();
    });

    // Keepalives are answered by the runtime without waking this object, so a
    // room full of idle tabs costs nothing and writes nothing.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(SOCKET_PING, SOCKET_PONG));
  }

  health(): WorkspaceHealth {
    const state = readWorkspaceSchema(this.ctx.storage);

    return {
      ok: state.status === "ready",
      schemaVersion: state.version,
      status: state.status,
      error: state.error,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Not found", { status: 404 });
    }
    if (url.pathname === "/_internal/runner-socket") return this.acceptRunnerSocket(request);
    if (url.pathname !== "/_internal/member-socket") {
      return new Response("Not found", { status: 404 });
    }
    const memberId = request.headers.get("x-lepidy-member-id") ?? "";
    const authorizationEpoch = Number(request.headers.get("x-lepidy-authorization-epoch"));
    if (!this.authorizeMember(memberId, authorizationEpoch)) {
      return new Response("Forbidden", { status: 403 });
    }
    const since = Number(url.searchParams.get("since") ?? "0");
    const now = Date.now();
    const pair = new WebSocketPair();
    // The tag is how a woken socket is recognised after hibernation; the
    // attachment carries the rest and survives with it.
    this.ctx.acceptWebSocket(pair[1], [memberId]);
    const attachment: SocketAttachment = {
      memberId,
      authorizationEpoch,
      cursor: Number.isSafeInteger(since) && since >= 0 ? since : 0,
      connectedAt: now,
    };
    pair[1].serializeAttachment(attachment);

    this.sendFrame(pair[1], {
      type: "welcome",
      memberId,
      sequence: this.latestReplaySequence(),
      presence: this.onlineMemberIds(),
    });
    if (attachment.cursor > 0) this.replayForSocket(pair[1], attachment, attachment.cursor);
    this.broadcastPresence(memberId, true);

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  initializeWorkspace(input: {
    storageMode: WorkspaceStorageMode;
    hostEpoch: number;
    routingEpoch: number;
    /**
     * The workspace's own slug, so the object can later refuse an OAuth
     * audience naming somebody else. It is written once and never changed:
     * the slug is what routes, and a workspace that could rename itself could
     * take over another workspace's tokens.
     */
    workspaceSlug?: string;
    now: number;
  }): void {
    const schema = readWorkspaceSchema(this.ctx.storage);
    if (schema.status !== "ready") throw new Error("workspace is quarantined");
    this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<{ storage_mode: WorkspaceStorageMode }>(
          "SELECT storage_mode FROM workspace_config WHERE singleton = 1",
        )
        .toArray()[0];
      if (existing && existing.storage_mode !== input.storageMode) {
        throw new Error("workspace storage mode requires a routed migration");
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO workspace_config(
           singleton, storage_mode, host_epoch, routing_epoch, workspace_slug, initialized_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           host_epoch = excluded.host_epoch,
           routing_epoch = excluded.routing_epoch,
           workspace_slug = COALESCE(workspace_config.workspace_slug, excluded.workspace_slug),
           updated_at = excluded.updated_at`,
        input.storageMode,
        input.hostEpoch,
        input.routingEpoch,
        input.workspaceSlug ?? null,
        input.now,
        input.now,
      );
    });
  }

  async applyMembership(member: MemberProjection): Promise<{ applied: boolean; version: number }> {
    const schema = readWorkspaceSchema(this.ctx.storage);
    if (schema.status !== "ready") throw new Error("workspace is quarantined");

    const outcome = await this.commitMutation({ scope: "membership", now: member.now }, () => {
      const replay = this.ctx.storage.sql
        .exec<{ version: number }>(
          "SELECT version FROM applied_control_operations WHERE operation_id = ?",
          member.operationId,
        )
        .toArray()[0];
      if (replay) return { result: { applied: false, version: replay.version } };

      const existing = this.ctx.storage.sql
        .exec<{ authorization_epoch: number; control_version: number; status: MemberProjection["status"] }>(
          "SELECT authorization_epoch, control_version, status FROM members WHERE id = ?",
          member.memberId,
        )
        .toArray()[0];
      if (existing && existing.control_version >= member.version) {
        throw new Error("membership projection version is stale");
      }

      this.ctx.storage.sql.exec(
        `INSERT INTO members(
           id, account_id, handle, display_name, role, status,
           authorization_epoch, control_version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           handle = excluded.handle,
           display_name = excluded.display_name,
           role = excluded.role,
           status = excluded.status,
           authorization_epoch = excluded.authorization_epoch,
           control_version = excluded.control_version,
           updated_at = excluded.updated_at`,
        member.memberId,
        member.accountId,
        member.handle,
        member.displayName,
        member.role,
        member.status,
        member.authorizationEpoch,
        member.version,
        member.now,
        member.now,
      );
      if (
        existing !== undefined
        && (member.authorizationEpoch !== existing.authorization_epoch || member.status !== "active")
      ) {
        this.ctx.storage.sql.exec(
          `UPDATE agent_sessions SET revoked_at = ?, revoked_reason = 'owner_authority_changed'
           WHERE owner_member_id = ? AND revoked_at IS NULL`,
          member.now,
          member.memberId,
        );
        this.ctx.storage.sql.exec(
          `UPDATE agent_delegations SET revoked_at = ?, revoked_reason = 'owner_authority_changed'
           WHERE owner_member_id = ? AND revoked_at IS NULL`,
          member.now,
          member.memberId,
        );
        this.ctx.storage.sql.exec(
          `UPDATE vault_grants SET revoked_at = ?, revoked_reason = 'member_authority_changed'
           WHERE member_id = ? AND revoked_at IS NULL`,
          member.now,
          member.memberId,
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_control_operations(operation_id, kind, aggregate_id, version, applied_at)
         VALUES (?, 'membership_upsert', ?, ?, ?)`,
        member.operationId,
        member.memberId,
        member.version,
        member.now,
      );
      const projection = {
        memberId: member.memberId,
        handle: member.handle,
        role: member.role,
        status: member.status,
        authorizationEpoch: member.authorizationEpoch,
        version: member.version,
      };
      return {
        result: { applied: true, version: member.version },
        effects: {
          audit: {
            eventType: "membership.projected",
            outcome: "allowed",
            requesterKind: "system",
            subjectKind: "member",
            subjectId: member.memberId,
            metadata: {
              role: member.role,
              member_status: member.status,
              authorization_epoch: member.authorizationEpoch,
              control_version: member.version,
              operation_id: member.operationId,
            },
          },
          outbox: [
            {
              id: `member_projection.${member.operationId}`,
              kind: "member_projection_changed",
              dedupeKey: `member:${member.memberId}:${member.version}`,
              payload: projection,
            },
          ],
          replay: [{ kind: "member.updated", audience: ["workspace"], payload: projection }],
        } satisfies MutationEffects,
      };
    });
    if (outcome.result.applied && (member.authorizationEpoch > 1 || member.status !== "active")) {
      this.closeMemberSockets(member.memberId);
    }
    return outcome.result;
  }

  getMember(memberId: string): {
    id: string;
    handle: string;
    role: MemberProjection["role"];
    status: MemberProjection["status"];
    controlVersion: number;
  } | null {
    const row = this.ctx.storage.sql
      .exec<{
        id: string;
        handle: string;
        role: MemberProjection["role"];
        status: MemberProjection["status"];
        control_version: number;
      }>("SELECT id, handle, role, status, control_version FROM members WHERE id = ?", memberId)
      .toArray()[0];
    return row
      ? {
          id: row.id,
          handle: row.handle,
          role: row.role,
          status: row.status,
          controlVersion: row.control_version,
        }
      : null;
  }

  authorizeMember(memberId: string, authorizationEpoch: number): boolean {
    const row = this.ctx.storage.sql
      .exec<{ allowed: number }>(
        `SELECT 1 AS allowed FROM members
         WHERE id = ? AND status = 'active' AND authorization_epoch = ?`,
        memberId,
        authorizationEpoch,
      )
      .toArray()[0];
    return row?.allowed === 1;
  }

  closeMemberSockets(memberId: string, reason = "membership authority changed"): number {
    const sockets = this.ctx.getWebSockets(memberId);
    for (const socket of sockets) socket.close(4003, reason.slice(0, 123));
    return sockets.length;
  }

  designateSoloHost(input: { deviceId: string; newHostEpoch: number; now: number }): void {
    this.ctx.storage.transactionSync(() => {
      const config = this.workspaceConfig();
      if (config.storage_mode !== "local_host") throw new Error("workspace is not local-hosted");
      if (input.newHostEpoch !== config.host_epoch + 1) throw new Error("host epoch must advance by one");
      this.ctx.storage.sql.exec(
        `UPDATE workspace_config
         SET designated_host_device_id = ?, host_epoch = ?, host_lease_expires_at = NULL,
             relay_sequence_to_host = 0, relay_sequence_from_host = 0, updated_at = ?
         WHERE singleton = 1`,
        input.deviceId,
        input.newHostEpoch,
        input.now,
      );
    });
  }

  renewSoloHostLease(input: { deviceId: string; hostEpoch: number; now: number; ttlMs: number }): number {
    if (input.ttlMs < 1_000 || input.ttlMs > 120_000) throw new Error("invalid host lease duration");
    return this.ctx.storage.transactionSync(() => {
      const config = this.workspaceConfig();
      if (
        config.storage_mode !== "local_host" ||
        config.designated_host_device_id !== input.deviceId ||
        config.host_epoch !== input.hostEpoch
      ) {
        throw new Error("stale or unauthorized solo host");
      }
      const expiresAt = input.now + input.ttlMs;
      this.ctx.storage.sql.exec(
        "UPDATE workspace_config SET host_lease_expires_at = ?, updated_at = ? WHERE singleton = 1",
        expiresAt,
        input.now,
      );
      return expiresAt;
    });
  }

  routeOpaqueFrame(input: OpaqueRelayFrameMetadata, now: number): { routed: true; sequence: number } {
    if (
      input.sequence < 1 ||
      input.ciphertextBytes < 17 ||
      input.ciphertextBytes > 1_048_576 ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId)
    ) {
      throw new Error("invalid opaque relay frame metadata");
    }
    return this.ctx.storage.transactionSync(() => {
      const config = this.workspaceConfig();
      if (
        config.storage_mode !== "local_host" ||
        !config.designated_host_device_id ||
        config.host_epoch !== input.hostEpoch ||
        config.host_lease_expires_at === null ||
        config.host_lease_expires_at <= now
      ) {
        throw new Error("host_offline");
      }
      const currentSequence =
        input.direction === "to_host" ? config.relay_sequence_to_host : config.relay_sequence_from_host;
      if (input.sequence <= currentSequence) throw new Error("stale relay sequence");
      const column = input.direction === "to_host" ? "relay_sequence_to_host" : "relay_sequence_from_host";
      this.ctx.storage.sql.exec(
        `UPDATE workspace_config SET ${column} = ?, updated_at = ? WHERE singleton = 1`,
        input.sequence,
        now,
      );
      return { routed: true as const, sequence: input.sequence };
    });
  }

  async stageSoloUpgrade(input: {
    importId: string;
    snapshot: SoloContentSnapshot;
    now: number;
  }): Promise<{ staged: true; replayed: boolean }> {
    await verifySoloSnapshot(input.snapshot);
    return this.ctx.storage.transactionSync(() => {
      const config = this.workspaceConfig();
      if (config.storage_mode !== "local_host") throw new Error("workspace is not local-hosted");
      if (config.host_epoch !== input.snapshot.hostEpoch) throw new Error("stale host epoch");
      const existing = this.ctx.storage.sql
        .exec<{ snapshot_checksum: string; status: string }>(
          "SELECT snapshot_checksum, status FROM solo_upgrade_imports WHERE import_id = ?",
          input.importId,
        )
        .toArray()[0];
      if (existing) {
        if (existing.snapshot_checksum !== input.snapshot.checksum) throw new Error("import id conflict");
        return { staged: true as const, replayed: true };
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO solo_upgrade_imports(import_id, snapshot_checksum, workspace_id, host_epoch, status, started_at)
         VALUES (?, ?, ?, ?, 'staged', ?)`,
        input.importId,
        input.snapshot.checksum,
        input.snapshot.workspaceId,
        input.snapshot.hostEpoch,
        input.now,
      );
      for (const record of input.snapshot.channels) {
        this.ctx.storage.sql.exec(
          "INSERT INTO solo_upgrade_channels(import_id, record_id, record_json) VALUES (?, ?, ?)",
          input.importId,
          record.id,
          JSON.stringify(record),
        );
      }
      for (const record of input.snapshot.messages) {
        this.ctx.storage.sql.exec(
          "INSERT INTO solo_upgrade_messages(import_id, record_id, record_json) VALUES (?, ?, ?)",
          input.importId,
          record.id,
          JSON.stringify(record),
        );
      }
      for (const record of input.snapshot.attachments) {
        this.ctx.storage.sql.exec(
          "INSERT INTO solo_upgrade_attachments(import_id, record_id, record_json) VALUES (?, ?, ?)",
          input.importId,
          record.id,
          JSON.stringify(record),
        );
      }
      return { staged: true as const, replayed: false };
    });
  }

  async finalizeSoloUpgrade(input: {
    importId: string;
    expectedWorkspaceId: string;
    now: number;
  }): Promise<{ storageMode: "cloud"; routingEpoch: number; replayed: boolean }> {
    const staged = this.readStagedSnapshot(input.importId);
    if (staged.workspaceId !== input.expectedWorkspaceId) throw new Error("snapshot workspace mismatch");
    await verifySoloSnapshot(staged);
    return this.ctx.storage.transactionSync(() => {
      const config = this.workspaceConfig();
      const record = this.ctx.storage.sql
        .exec<{ status: "staged" | "complete"; snapshot_checksum: string }>(
          "SELECT status, snapshot_checksum FROM solo_upgrade_imports WHERE import_id = ?",
          input.importId,
        )
        .one();
      if (record.status === "complete") {
        return { storageMode: "cloud" as const, routingEpoch: config.routing_epoch, replayed: true };
      }
      if (config.storage_mode !== "local_host" || config.host_epoch !== staged.hostEpoch) {
        throw new Error("workspace authority changed during import");
      }
      for (const channel of staged.channels) {
        this.ctx.storage.sql.exec(
          `INSERT INTO channels(id, kind, slug, name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, slug=excluded.slug,
             name=excluded.name, updated_at=excluded.updated_at`,
          channel.id,
          channel.kind,
          channel.slug,
          channel.name,
          channel.createdAt,
          channel.updatedAt,
        );
      }
      for (const message of staged.messages) {
        this.ctx.storage.sql.exec(
          `INSERT INTO messages(id, channel_id, author_kind, author_id, author_display_snapshot, body_markdown, created_at)
           VALUES (?, ?, 'imported', ?, ?, ?, ?)`,
          message.id,
          message.channelId,
          message.authorId,
          message.authorId,
          message.bodyMarkdown,
          message.createdAt,
        );
      }
      for (const attachment of staged.attachments) {
        // Imported attachments arrive already stored, and their room comes from
        // the message they belong to. A Solo snapshot records no uploader, so
        // that column stays null rather than being attributed to whoever ran
        // the upgrade.
        const owner = this.ctx.storage.sql
          .exec<{ channel_id: string }>("SELECT channel_id FROM messages WHERE id = ?", attachment.messageId)
          .toArray()[0];
        if (!owner) continue;
        this.ctx.storage.sql.exec(
          `INSERT INTO files(id, object_key, file_name, media_type, byte_length, sha256,
             uploaded_by_member_id, channel_id, message_id, state, created_at, confirmed_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'stored', ?, ?)`,
          attachment.id,
          attachment.relativePath,
          attachment.fileName,
          attachment.mediaType,
          attachment.byteLength,
          attachment.sha256,
          owner.channel_id,
          attachment.messageId,
          input.now,
          input.now,
        );
      }
      const routingEpoch = config.routing_epoch + 1;
      this.ctx.storage.sql.exec(
        `UPDATE workspace_config SET storage_mode = 'cloud', routing_epoch = ?,
           designated_host_device_id = NULL, host_lease_expires_at = NULL, updated_at = ?
         WHERE singleton = 1`,
        routingEpoch,
        input.now,
      );
      this.ctx.storage.sql.exec(
        "UPDATE solo_upgrade_imports SET status = 'complete', completed_at = ? WHERE import_id = ?",
        input.now,
        input.importId,
      );
      return { storageMode: "cloud" as const, routingEpoch, replayed: false };
    });
  }

  /**
   * The navigation and profile data one member may see. Visibility is applied
   * here, in the object, rather than trusted from the caller: a private room is
   * returned only to a member of that room, and the caller's membership epoch
   * must still match the projection this workspace holds.
   */
  shellSnapshot(input: { memberId: string; authorizationEpoch: number }): WorkspaceShellSnapshot {
    const schema = readWorkspaceSchema(this.ctx.storage);
    if (schema.status !== "ready") throw new Error("workspace is quarantined");
    if (!this.authorizeMember(input.memberId, input.authorizationEpoch)) {
      throw new Error("member is not authorized for this workspace");
    }

    const viewerRow = this.ctx.storage.sql
      .exec<{
        id: string;
        handle: string;
        display_name: string;
        role: MemberProjection["role"];
        authorization_epoch: number;
      }>(
        "SELECT id, handle, display_name, role, authorization_epoch FROM members WHERE id = ?",
        input.memberId,
      )
      .one();

    const channels = this.ctx.storage.sql
      .exec<{
        id: string;
        kind: ShellChannel["kind"];
        slug: string | null;
        name: string | null;
        is_member: number;
        post_mode: "open" | "form";
        form_definition_json: string | null;
        sort_mode: "chronological" | "ranked";
        sort_emoji: string | null;
        status_definitions_json: string;
        main_status_label: string;
        created_by_member_id: string | null;
      }>(
        `SELECT c.id, c.kind, c.slug, c.name, c.post_mode, c.form_definition_json,
                c.sort_mode, c.sort_emoji, c.status_definitions_json, c.main_status_label, c.created_by_member_id,
                CASE WHEN cm.member_id IS NULL THEN 0 ELSE 1 END AS is_member
         FROM channels c
         LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id = ?
         WHERE c.archived_at IS NULL AND (c.kind = 'public' OR cm.member_id IS NOT NULL)
         ORDER BY c.kind, COALESCE(c.slug, c.name, c.id)`,
        input.memberId,
      )
      .toArray()
      .map((row) => {
        const roomOwner = viewerRow.role === "owner" || row.created_by_member_id === viewerRow.id;
        const statuses = (JSON.parse(row.status_definitions_json) as QueueStatus[])
          .filter((status) => maySeeQueueStatus(status, viewerRow.id, roomOwner));
        return {
          id: row.id,
          kind: row.kind,
          slug: row.slug,
          name: row.name,
          isMember: row.is_member === 1,
          postMode: row.post_mode,
          formDefinition: row.form_definition_json === null ? null : JSON.parse(row.form_definition_json) as FormDefinition,
          sortMode: row.sort_mode,
          sortEmoji: row.sort_emoji,
          statusDefinitions: statuses,
          mainStatusLabel: row.main_status_label,
          canManageQueue: viewerRow.role === "owner" || viewerRow.role === "admin" || row.created_by_member_id === viewerRow.id,
        };
      });

    const agents = this.ctx.storage.sql
      .exec<{ id: string; handle: string; display_name: string; status: ShellAgent["status"] }>(
        "SELECT id, handle, display_name, status FROM agents WHERE status <> 'archived' ORDER BY handle",
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        handle: row.handle,
        displayName: row.display_name,
        status: row.status,
      }));

    const config = this.ctx.storage.sql
      .exec<{ storage_mode: WorkspaceStorageMode }>(
        "SELECT storage_mode FROM workspace_config WHERE singleton = 1",
      )
      .toArray()[0];

    return {
      viewer: {
        memberId: viewerRow.id,
        handle: viewerRow.handle,
        displayName: viewerRow.display_name,
        role: viewerRow.role,
        authorizationEpoch: viewerRow.authorization_epoch,
      },
      channels,
      agents,
      storageMode: config?.storage_mode ?? null,
      schemaVersion: schema.version,
    };
  }

  listPeople(input: { actor: Actor }): PeopleDirectory {
    const actor = this.authorizeActor(input.actor);
    const maySeeInactive = actor.role === "owner" || actor.role === "admin";
    const online = new Set(this.onlineMemberIds());
    const people = this.ctx.storage.sql
      .exec<{
        id: string; handle: string; display_name: string; avatar_url: string | null;
        role: MemberProjection["role"]; status: MemberProjection["status"]; title: string | null;
        timezone: string | null; working_start_minute: number | null; working_end_minute: number | null;
        custom_status: string | null; availability: Availability; owned_agent_count: number;
      }>(
        `SELECT m.id, m.handle, m.display_name, m.avatar_url, m.role, m.status, m.title, m.timezone,
                m.working_start_minute, m.working_end_minute, m.custom_status, m.availability,
                COUNT(ao.agent_id) AS owned_agent_count
         FROM members m LEFT JOIN agent_owners ao ON ao.member_id = m.id
         WHERE m.status ${maySeeInactive ? "<> 'pending'" : "= 'active'"}
         GROUP BY m.id ORDER BY m.display_name COLLATE NOCASE, m.id`,
      )
      .toArray()
      .map((row) => ({
        id: row.id, handle: row.handle, displayName: row.display_name, avatarUrl: row.avatar_url,
        role: row.role, status: row.status, title: row.title, timezone: row.timezone,
        workingStartMinute: row.working_start_minute, workingEndMinute: row.working_end_minute,
        customStatus: row.custom_status, availability: row.availability,
        presence: resolvePresence(row.availability, online.has(row.id)),
        ownedAgentCount: row.owned_agent_count,
      }));
    const groups = this.ctx.storage.sql
      .exec<{
        id: string; handle: string; display_name: string; description: string | null;
        created_by_member_id: string | null; member_ids_json: string;
      }>(
        `SELECT g.id, g.handle, g.display_name, g.description, g.created_by_member_id,
                COALESCE(json_group_array(gm.member_id) FILTER (WHERE m.status = 'active'), '[]') AS member_ids_json
         FROM groups g
         LEFT JOIN group_members gm ON gm.group_id = g.id
         LEFT JOIN members m ON m.id = gm.member_id
         WHERE g.archived_at IS NULL
         GROUP BY g.id ORDER BY g.handle COLLATE NOCASE`,
      )
      .toArray()
      .map((row) => ({
        id: row.id, handle: row.handle, displayName: row.display_name, description: row.description,
        createdByMemberId: row.created_by_member_id,
        memberIds: (JSON.parse(row.member_ids_json) as string[]).filter((id) => id !== null).sort(),
      }));
    return { people, groups };
  }

  async updateOwnProfile(input: {
    actor: Actor;
    displayName: string;
    title?: string | null;
    timezone?: string | null;
    workingStartMinute?: number | null;
    workingEndMinute?: number | null;
    customStatus?: string | null;
    availability?: Availability | string | null;
    now: number;
  }): Promise<{ profile: DirectoryMember }> {
    const actor = this.authorizeActor(input.actor);
    const profile = parseProfile(input);
    const availability = parseAvailability(input.availability);
    await this.commitMutation({ scope: "people.profile", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        `UPDATE members SET display_name = ?, title = ?, timezone = ?, working_start_minute = ?,
           working_end_minute = ?, custom_status = ?, availability = ?, updated_at = ? WHERE id = ?`,
        profile.displayName, profile.title, profile.timezone, profile.workingStartMinute,
        profile.workingEndMinute, profile.customStatus, availability, input.now, actor.id,
      );
      return {
        result: { updated: true },
        effects: {
          audit: { eventType: "member.profile_updated", outcome: "allowed", requesterKind: "member", requesterId: actor.id, subjectKind: "member", subjectId: actor.id, metadata: {} },
          replay: [{ kind: "member.profile_updated", audience: ["workspace"], payload: { memberId: actor.id } }],
        },
      };
    });
    const updated = this.listPeople({ actor: input.actor }).people.find((member) => member.id === actor.id);
    if (!updated) throw new Error("profile is unavailable");
    return { profile: updated };
  }

  /* ------------------------------------------------------------------ */
  /* Attachments: reservation, confirmation, listing and download (C08)   */
  /* ------------------------------------------------------------------ */

  /**
   * The storage allowance, decided in D1 and mirrored here.
   *
   * Projected rather than queried because the object cannot reach D1 and must
   * not try: an upload decision that needed a cross-database read would be a
   * decision that fails open when the control plane is slow. A workspace that
   * has never been projected has a zero quota and refuses every upload, which
   * is the safe direction.
   */
  async applyStorageEntitlement(input: { quotaBytes: number; version: number; now: number }): Promise<{ applied: boolean }> {
    if (!Number.isSafeInteger(input.quotaBytes) || input.quotaBytes < 0) throw new Error("storage quota is invalid");
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error("entitlement version is invalid");
    const outcome = await this.commitMutation<{ applied: boolean }>({ scope: "files.entitlement", now: input.now }, () => {
      const current = this.ctx.storage.sql
        .exec<{ storage_entitlement_version: number }>("SELECT storage_entitlement_version FROM workspace_config WHERE singleton = 1")
        .toArray()[0];
      // An older projection arriving late must not undo a newer one.
      if (current && current.storage_entitlement_version >= input.version) return { result: { applied: false } };
      this.ctx.storage.sql.exec(
        "UPDATE workspace_config SET storage_quota_bytes = ?, storage_entitlement_version = ?, updated_at = ? WHERE singleton = 1",
        input.quotaBytes, input.version, input.now,
      );
      return { result: { applied: true } };
    });
    return outcome.result;
  }

  /** Quota, live usage and the warning threshold, for the uploader and the admin screen. */
  storageStatus(input: { actor: Actor }): { quotaBytes: number; usedBytes: number; warn: boolean } {
    this.authorizeActor(input.actor);
    return this.readStorageStatus();
  }

  private readStorageStatus(): { quotaBytes: number; usedBytes: number; warn: boolean } {
    const config = this.ctx.storage.sql
      .exec<{ storage_quota_bytes: number }>("SELECT storage_quota_bytes FROM workspace_config WHERE singleton = 1")
      .toArray()[0];
    // Reservations count against the quota until they expire, so a burst of
    // parallel uploads cannot each be told there is room for all of them.
    const used = this.ctx.storage.sql
      .exec<{ total: number | null }>(
        `SELECT SUM(byte_length) AS total FROM files
         WHERE state = 'stored' OR (state = 'reserved' AND expires_at > ?)`,
        Date.now(),
      )
      .toArray()[0];
    const quotaBytes = config?.storage_quota_bytes ?? 0;
    const usedBytes = used?.total ?? 0;
    return { quotaBytes, usedBytes, warn: quotaBytes > 0 && usedBytes >= quotaBytes * QUOTA_WARN_FRACTION };
  }

  /**
   * Step one of an upload: check authority and quota, then hand back a key.
   *
   * The bytes are not here and never will be — a 2 MB row limit and a 30-second
   * CPU budget are not where file transfer belongs (HLD §5.4). This reserves
   * the space and names the object; a Worker route streams the bytes to R2 and
   * calls {@link confirmUpload} afterwards.
   */
  async reserveUpload(input: {
    actor: Actor;
    idempotencyKey: string;
    channelId: string;
    fileName: string;
    mediaType: string;
    byteLength: number;
    now: number;
  }): Promise<{ fileId: string; objectKey: string; expiresAt: number; warn: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const config = this.ctx.storage.sql
      .exec<{ storage_mode: WorkspaceStorageMode }>("SELECT storage_mode FROM workspace_config WHERE singleton = 1")
      .toArray()[0];
    // Solo attachments live on the designated host and are bounded by its own
    // local quota; the cloud relay must never become their store, so this path
    // refuses rather than quietly accepting bytes the contract forbids.
    if (config?.storage_mode !== "cloud") throw new Error("this workspace stores attachments on its own host");

    const channel = readChannel(this.ctx.storage, input.channelId);
    if (channel === null || !canSeeChannel(this.channelVisibility(channel, actor.id))) throw new Error("channel not found");
    if (!isChannelMember(this.ctx.storage, channel.id, actor.id)) throw new Error("join this channel before attaching a file");

    const fileName = parseFileName(input.fileName);
    const mediaType = parseMediaType(input.mediaType);
    const status = this.readStorageStatus();
    const decision = quotaDecision({ quotaBytes: status.quotaBytes, usedBytes: status.usedBytes, incomingBytes: input.byteLength });
    if (decision.outcome === "refuse") throw new Error(decision.reason);

    const outcome = await this.commitMutation<{ fileId: string; objectKey: string; expiresAt: number; warn: boolean }>(
      { scope: "files.reserve", idempotencyKey: input.idempotencyKey, now: input.now },
      () => {
        const fileId = crypto.randomUUID().replaceAll("-", "");
        const objectKey = fileObjectKey({ workspaceId: this.workspaceKeyId(), fileId, fileName, now: input.now });
        const expiresAt = input.now + RESERVATION_TTL_MS;
        this.ctx.storage.sql.exec(
          `INSERT INTO files(id, object_key, file_name, media_type, byte_length, uploaded_by_member_id,
             channel_id, state, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
          fileId, objectKey, fileName, mediaType, input.byteLength, actor.id, channel.id, input.now, expiresAt,
        );
        return {
          result: { fileId, objectKey, expiresAt, warn: decision.warn },
          effects: {
            audit: {
              eventType: "file.reserved", outcome: "allowed", requesterKind: "member", requesterId: actor.id,
              subjectKind: "file", subjectId: fileId, metadata: { channel_id: channel.id, byte_length: input.byteLength },
            },
          },
        };
      },
    );
    return outcome.result;
  }

  /**
   * Says whether a transfer may start and where it goes.
   *
   * Read-only on purpose: the Worker needs the key before it has bytes, and a
   * transfer that never completes must leave the reservation to expire on its
   * own rather than having been mutated into some half state.
   */
  beginTransfer(input: { actor: Actor; fileId: string; byteLength: number }): { objectKey: string } {
    const actor = this.authorizeActor(input.actor);
    const row = this.readFileRow(input.fileId);
    if (row === null || row.state !== "reserved") throw new Error("upload not found");
    if (row.uploaded_by_member_id !== actor.id) throw new Error("upload not found");
    if (row.expires_at !== null && row.expires_at <= Date.now()) throw new Error("that upload reservation expired");
    if (row.byte_length !== input.byteLength) throw new Error("the transfer does not match its reservation");
    assertKeyBelongsToWorkspace(row.object_key, this.workspaceKeyId());
    return { objectKey: row.object_key };
  }

  /**
   * Step two: the bytes are in R2, so the reservation becomes a stored file.
   *
   * The verified length and digest come from whatever actually wrote the
   * object, not from the client's original claim, so a reservation for one byte
   * cannot be spent on a hundred megabytes.
   */
  async confirmUpload(input: {
    actor: Actor; fileId: string; byteLength: number; sha256?: string | null; now: number;
  }): Promise<{ confirmed: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const outcome = await this.commitMutation<{ confirmed: boolean }>({ scope: "files.confirm", now: input.now }, () => {
      const row = this.readFileRow(input.fileId);
      if (row === null || row.uploaded_by_member_id !== actor.id) throw new Error("upload not found");
      if (row.state === "stored") return { result: { confirmed: true } };
      fileStateTransition(row.state, "stored");
      if (row.expires_at !== null && row.expires_at <= input.now) throw new Error("that upload reservation expired");
      if (input.byteLength !== row.byte_length) throw new Error("the stored object does not match its reservation");
      this.ctx.storage.sql.exec(
        "UPDATE files SET state = 'stored', sha256 = ?, confirmed_at = ?, expires_at = NULL WHERE id = ?",
        input.sha256 ?? null, input.now, row.id,
      );
      return {
        result: { confirmed: true },
        effects: {
          audit: {
            eventType: "file.stored", outcome: "allowed", requesterKind: "member", requesterId: actor.id,
            subjectKind: "file", subjectId: row.id, metadata: { channel_id: row.channel_id, byte_length: row.byte_length },
          },
        },
      };
    });
    return outcome.result;
  }

  /** Binds stored files to the message that carries them, once it exists. */
  async attachFilesToMessage(input: {
    actor: Actor; messageId: string; fileIds: readonly string[]; now: number;
  }): Promise<{ attached: number }> {
    const actor = this.authorizeActor(input.actor);
    const outcome = await this.commitMutation<{ attached: number }>({ scope: "files.attach", now: input.now }, () => {
      const message = this.ctx.storage.sql
        .exec<{ id: string; channel_id: string; author_kind: string; author_id: string }>(
          "SELECT id, channel_id, author_kind, author_id FROM messages WHERE id = ?", input.messageId,
        )
        .toArray()[0];
      // Only the human who wrote the message may hang files on it; an agent's
      // message is not a place to park somebody else's upload.
      if (!message || message.author_kind !== "member" || message.author_id !== actor.id) {
        throw new Error("message not found");
      }
      let attached = 0;
      for (const fileId of input.fileIds) {
        const row = this.readFileRow(fileId);
        // A file may only join a message in the room it was uploaded to, by the
        // person who uploaded it: otherwise a message becomes a way to move an
        // attachment into a room its uploader could not post in.
        if (row === null || row.state !== "stored" || row.uploaded_by_member_id !== actor.id) continue;
        if (row.channel_id !== message.channel_id || row.message_id !== null) continue;
        this.ctx.storage.sql.exec("UPDATE files SET message_id = ? WHERE id = ?", message.id, row.id);
        attached += 1;
      }
      return { result: { attached } };
    });
    return outcome.result;
  }

  /** Files in rooms this reader may see, newest first. */
  listFiles(input: { actor: Actor; channelId?: string | null; limit?: number } & FileListFilters): { files: readonly StoredFile[] } {
    const actor = this.authorizeActor(input.actor);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const where = ["f.state = 'stored'"];
    const values: (string | number)[] = [];
    // Visibility belongs in the query as well as the projection loop. Without
    // it, a run of newer private files could consume the bounded candidate
    // window and hide older files the reader is allowed to see.
    where.push(`(c.kind = 'public' OR EXISTS (
      SELECT 1 FROM channel_members cm WHERE cm.channel_id = f.channel_id AND cm.member_id = ?
    ))`);
    values.push(actor.id);
    where.push(`(queue_message.status_id IS NULL OR c.created_by_member_id = ? OR ? = 'owner' OR EXISTS (
      SELECT 1 FROM json_each(c.status_definitions_json) status
      WHERE json_extract(status.value, '$.id') = queue_message.status_id
        AND (json_extract(status.value, '$.visibility') = 'public' OR EXISTS (
          SELECT 1 FROM json_each(status.value, '$.allowedMemberIds') allowed WHERE allowed.value = ?
        ))
    ))`);
    values.push(actor.id, actor.role, actor.id);
    const query = input.query?.trim().slice(0, 200) ?? "";
    const mediaTypePrefix = input.mediaTypePrefix?.trim().toLowerCase().slice(0, 100) ?? "";
    if (query) { where.push("instr(lower(f.file_name), lower(?)) > 0"); values.push(query); }
    if (mediaTypePrefix) { where.push("f.media_type LIKE ?"); values.push(`${mediaTypePrefix}%`); }
    if (input.uploaderMemberId) { where.push("f.uploaded_by_member_id = ?"); values.push(input.uploaderMemberId); }
    const channelId = input.channelId ?? null;
    if (channelId) { where.push("f.channel_id = ?"); values.push(channelId); }
    if (Number.isSafeInteger(input.createdAtOrAfter)) { where.push("f.created_at >= ?"); values.push(input.createdAtOrAfter!); }
    if (Number.isSafeInteger(input.createdBefore)) { where.push("f.created_at < ?"); values.push(input.createdBefore!); }
    const rows = this.ctx.storage.sql
      .exec<FileRow>(
        `SELECT f.*, m.display_name AS uploader_display_name, m.handle AS uploader_handle,
                c.name AS channel_name, c.slug AS channel_slug
         FROM files f
         LEFT JOIN members m ON m.id = f.uploaded_by_member_id
         LEFT JOIN messages queue_message ON queue_message.id = f.message_id
         JOIN channels c ON c.id = f.channel_id
         WHERE ${where.join(" AND ")}
         ORDER BY f.created_at DESC, f.id LIMIT ?`,
        ...values, limit,
      )
      .toArray();
    const files: StoredFile[] = [];
    for (const row of rows) {
      if (files.length >= limit) break;
      const channel = readChannel(this.ctx.storage, row.channel_id);
      // Visibility is rechecked per row at read time rather than trusted from
      // the upload, because room membership changes after a file is stored.
      if (channel === null || !canSeeChannel(this.channelVisibility(channel, actor.id))) continue;
      files.push(this.projectFile(row));
    }
    return { files };
  }

  /**
   * Resolve previews for visible messages. Remote markup is reduced to bounded
   * text before it is persisted; failures are short-cached and never break the
   * room. At most three uncached destinations are contacted by one read.
   */
  async listMessageUnfurls(input: {
    actor: Actor; messageIds: readonly string[]; now: number;
  }): Promise<{ unfurls: readonly MessageLinkUnfurl[] }> {
    const actor = this.authorizeActor(input.actor);
    const messageIds = [...new Set(input.messageIds)].filter((id) => /^[A-Za-z0-9_-]{1,200}$/.test(id)).slice(0, 40);
    const visible = new Map<string, readonly string[]>();
    for (const messageId of messageIds) {
      const message = this.ctx.storage.sql.exec<{ id: string; channel_id: string; body_markdown: string }>(
        "SELECT id, channel_id, body_markdown FROM messages WHERE id = ? AND deleted_at IS NULL", messageId,
      ).toArray()[0];
      if (!message) continue;
      const channel = readChannel(this.ctx.storage, message.channel_id);
      if (channel === null || !canSeeChannel(this.channelVisibility(channel, actor.id))) continue;
      visible.set(message.id, externalLinksFromMarkdown(message.body_markdown));
    }

    const fetches: Promise<void>[] = [];
    let remaining = MAX_UNFURL_FETCHES_PER_READ;
    for (const [messageId, urls] of visible) {
      // The message may have been edited since its last read. Rebuild only the
      // cheap association rows so removed links and changed order disappear;
      // the destination cache itself remains reusable across messages.
      this.ctx.storage.sql.exec("DELETE FROM message_unfurls WHERE message_id = ?", messageId);
      for (const [position, url] of urls.entries()) {
        const cached = this.ctx.storage.sql.exec<{ state: "ready" | "failed"; fetched_at: number }>(
          "SELECT state, fetched_at FROM link_unfurls WHERE url = ?", url,
        ).toArray()[0];
        const ttl = cached?.state === "ready" ? UNFURL_CACHE_TTL_MS : UNFURL_FAILURE_TTL_MS;
        const fresh = cached && cached.fetched_at + ttl > input.now;
        if (!cached) {
          this.ctx.storage.sql.exec(
            "INSERT INTO link_unfurls(url, state, fetched_at) VALUES (?, 'failed', ?)", url, 0,
          );
        }
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO message_unfurls(message_id, url, position) VALUES (?, ?, ?)",
          messageId, url, position,
        );
        if (fresh || remaining <= 0) continue;
        remaining -= 1;
        fetches.push((async () => {
          try {
            const preview = await fetchLinkUnfurl({ url, resolve: (hostname) => this.resolvePublicDns(hostname) });
            this.ctx.storage.sql.exec(
              `UPDATE link_unfurls SET final_url = ?, title = ?, description = ?, site_name = ?,
                 state = 'ready', fetched_at = ? WHERE url = ?`,
              preview.finalUrl, preview.title, preview.description, preview.siteName, input.now, url,
            );
          } catch {
            this.ctx.storage.sql.exec(
              `UPDATE link_unfurls SET final_url = NULL, title = NULL, description = NULL,
                 site_name = NULL, state = 'failed', fetched_at = ? WHERE url = ?`, input.now, url,
            );
          }
        })());
      }
    }
    await Promise.all(fetches);

    const unfurls: MessageLinkUnfurl[] = [];
    for (const [messageId] of visible) {
      const rows = this.ctx.storage.sql.exec<{
        url: string; final_url: string; title: string; description: string | null; site_name: string; position: number;
      }>(
        `SELECT u.url, u.final_url, u.title, u.description, u.site_name, mu.position
         FROM message_unfurls mu JOIN link_unfurls u ON u.url = mu.url
         WHERE mu.message_id = ? AND u.state = 'ready'
         ORDER BY mu.position`, messageId,
      ).toArray();
      for (const row of rows) unfurls.push({
        messageId, position: row.position, url: row.url, finalUrl: row.final_url,
        title: row.title, description: row.description, siteName: row.site_name,
      });
    }
    return { unfurls };
  }

  /** Tenant-local deterministic search. Every result kind applies authority in SQL before ranking. */
  searchWorkspace(input: { actor: Actor; query: string; cursor?: string | null; limit?: number }): WorkspaceSearchPage {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const query = parseSearchQuery(input.query);
    const match = searchMatch(query.text);
    const hasFilters = query.from.length > 0 || query.in.length > 0 || query.has.length > 0
      || query.before !== null || query.after !== null || query.isThread;
    if (query.errors.length > 0 || (match === null && !hasFilters)) return { query, hits: [], nextCursor: null };

    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const offset = searchCursor(input.cursor);
    const fetchLimit = offset + limit + 1;
    const placeholders = (values: readonly string[]) => values.map(() => "?").join(", ");
    type Ranked = { score: number; hit: WorkspaceSearchHit };
    const ranked: Ranked[] = [];

    const messageWhere = ["m.deleted_at IS NULL", "c.archived_at IS NULL", `(c.kind = 'public' OR EXISTS (
      SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.member_id = ?
    ))`, `(m.status_id IS NULL OR c.created_by_member_id = ? OR ? = 'owner' OR EXISTS (
      SELECT 1 FROM json_each(c.status_definitions_json) status
      WHERE json_extract(status.value, '$.id') = m.status_id
        AND (json_extract(status.value, '$.visibility') = 'public' OR EXISTS (
          SELECT 1 FROM json_each(status.value, '$.allowedMemberIds') allowed WHERE allowed.value = ?
        ))
    ))`];
    const messageValues: (string | number)[] = [actor.id, actor.id, actor.role, actor.id];
    if (match) { messageWhere.push("workspace_search MATCH ?"); messageValues.push(match); }
    if (query.from.length > 0) {
      messageWhere.push(`lower(COALESCE(author_member.handle, author_agent.handle, m.author_display_snapshot, m.author_id)) IN (${placeholders(query.from)})`);
      messageValues.push(...query.from);
    }
    if (query.in.length > 0) {
      messageWhere.push(`lower(COALESCE(c.slug, c.name, c.id)) IN (${placeholders(query.in)})`);
      messageValues.push(...query.in);
    }
    if (query.has.includes("file")) messageWhere.push("EXISTS (SELECT 1 FROM files f WHERE f.message_id = m.id AND f.state = 'stored')");
    if (query.has.includes("link")) messageWhere.push("(instr(lower(m.body_markdown), 'https://') > 0 OR instr(lower(m.body_markdown), 'http://') > 0)");
    if (query.has.includes("code")) messageWhere.push("instr(m.body_markdown, '`') > 0");
    if (query.isThread) messageWhere.push("m.thread_root_id IS NOT NULL");
    if (query.after !== null) { messageWhere.push("m.created_at >= ?"); messageValues.push(query.after); }
    if (query.before !== null) { messageWhere.push("m.created_at < ?"); messageValues.push(query.before); }
    const messageRows = this.ctx.storage.sql.exec<{
      id: string; channel_id: string; channel_label: string; thread_root_id: string | null; author_kind: string;
      author_display_snapshot: string; body_markdown: string; created_at: number; score: number;
    }>(
      `SELECT m.id, m.channel_id, COALESCE(c.slug, c.name, c.id) AS channel_label, m.thread_root_id,
              m.author_kind, m.author_display_snapshot, m.body_markdown, m.created_at,
              ${match ? "bm25(workspace_search)" : "0"} AS score
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       LEFT JOIN members author_member ON m.author_kind = 'member' AND author_member.id = m.author_id
       LEFT JOIN agents author_agent ON m.author_kind = 'agent' AND author_agent.id = m.author_id
       ${match ? "JOIN workspace_search ON workspace_search.rowid = m.rowid" : ""}
       WHERE ${messageWhere.join(" AND ")}
       ORDER BY score, m.created_at DESC, m.id LIMIT ?`,
      ...messageValues, fetchLimit,
    ).toArray();
    for (const row of messageRows) ranked.push({ score: row.score, hit: {
      kind: "message", id: row.id, channelId: row.channel_id, channelLabel: row.channel_label,
      threadRootId: row.thread_root_id, authorKind: row.author_kind, authorDisplayName: row.author_display_snapshot,
      bodyMarkdown: row.body_markdown, createdAt: row.created_at,
    } });

    // A file satisfies has:file; message-only structure filters deliberately exclude it.
    if (!query.isThread && !query.has.includes("link") && !query.has.includes("code")) {
      const fileWhere = ["f.state = 'stored'", `(c.kind = 'public' OR EXISTS (
        SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.member_id = ?
      ))`, `(f.message_id IS NULL OR message.status_id IS NULL OR c.created_by_member_id = ? OR ? = 'owner' OR EXISTS (
        SELECT 1 FROM json_each(c.status_definitions_json) status
        WHERE json_extract(status.value, '$.id') = message.status_id
          AND (json_extract(status.value, '$.visibility') = 'public' OR EXISTS (
            SELECT 1 FROM json_each(status.value, '$.allowedMemberIds') allowed WHERE allowed.value = ?
          ))
      ))`];
      const fileValues: (string | number)[] = [actor.id, actor.id, actor.role, actor.id];
      if (match) { fileWhere.push("file_search MATCH ?"); fileValues.push(match); }
      if (query.from.length > 0) {
        fileWhere.push(`lower(COALESCE(u.handle, f.uploaded_by_member_id, '')) IN (${placeholders(query.from)})`);
        fileValues.push(...query.from);
      }
      if (query.in.length > 0) {
        fileWhere.push(`lower(COALESCE(c.slug, c.name, c.id)) IN (${placeholders(query.in)})`);
        fileValues.push(...query.in);
      }
      if (query.after !== null) { fileWhere.push("f.created_at >= ?"); fileValues.push(query.after); }
      if (query.before !== null) { fileWhere.push("f.created_at < ?"); fileValues.push(query.before); }
      const fileRows = this.ctx.storage.sql.exec<{
        id: string; channel_id: string; channel_label: string; file_name: string; media_type: string;
        byte_length: number; uploader_display_name: string | null; created_at: number; score: number;
      }>(
        `SELECT f.id, f.channel_id, COALESCE(c.slug, c.name, c.id) AS channel_label, f.file_name, f.media_type,
                f.byte_length, u.display_name AS uploader_display_name, f.created_at,
                ${match ? "bm25(file_search)" : "0"} AS score
         FROM files f JOIN channels c ON c.id = f.channel_id
         LEFT JOIN messages message ON message.id = f.message_id
         LEFT JOIN members u ON u.id = f.uploaded_by_member_id
         ${match ? "JOIN file_search ON file_search.rowid = f.rowid" : ""}
         WHERE ${fileWhere.join(" AND ")}
         ORDER BY score, f.created_at DESC, f.id LIMIT ?`,
        ...fileValues, fetchLimit,
      ).toArray();
      for (const row of fileRows) ranked.push({ score: row.score, hit: {
        kind: "file", id: row.id, channelId: row.channel_id, channelLabel: row.channel_label,
        fileName: row.file_name, mediaType: row.media_type, byteLength: row.byte_length,
        uploaderDisplayName: row.uploader_display_name, createdAt: row.created_at,
      } });
    }

    // A browser search has no agent/origin context, so discoverability is the
    // exact member/group subset of vaultCanDiscover, expressed in this query.
    if (!query.isThread && query.in.length === 0 && query.has.length === 0) {
      const credentialWhere = [`EXISTS (
        SELECT 1 FROM vault_credential_acl acl
        WHERE acl.credential_id = credential.id
          AND (acl.subject_type = 'member' AND acl.subject_id = ?
            OR acl.subject_type = 'group' AND EXISTS (
              SELECT 1 FROM group_members gm WHERE gm.group_id = acl.subject_id AND gm.member_id = ?
            ))
      )`];
      const credentialValues: (string | number)[] = [actor.id, actor.id];
      if (match) { credentialWhere.push("credential_search MATCH ?"); credentialValues.push(match); }
      if (query.from.length > 0) {
        credentialWhere.push(`lower(COALESCE(creator.handle, credential.created_by_member_id)) IN (${placeholders(query.from)})`);
        credentialValues.push(...query.from);
      }
      if (query.after !== null) { credentialWhere.push("credential.created_at >= ?"); credentialValues.push(query.after); }
      if (query.before !== null) { credentialWhere.push("credential.created_at < ?"); credentialValues.push(query.before); }
      const credentialRows = this.ctx.storage.sql.exec<{
        id: string; name: string; description: string; created_at: number; score: number;
      }>(
        `SELECT credential.id, credential.name, credential.description, credential.created_at,
                ${match ? "bm25(credential_search)" : "0"} AS score
         FROM vault_credentials credential
         LEFT JOIN members creator ON creator.id = credential.created_by_member_id
         ${match ? "JOIN credential_search ON credential_search.rowid = credential.rowid" : ""}
         WHERE ${credentialWhere.join(" AND ")}
         ORDER BY score, credential.created_at DESC, credential.id LIMIT ?`,
        ...credentialValues, fetchLimit,
      ).toArray();
      for (const row of credentialRows) ranked.push({ score: row.score, hit: {
        kind: "credential", id: row.id, name: row.name, description: row.description, createdAt: row.created_at,
      } });
    }

    ranked.sort((left, right) => left.score - right.score || right.hit.createdAt - left.hit.createdAt
      || left.hit.kind.localeCompare(right.hit.kind) || left.hit.id.localeCompare(right.hit.id));
    const hits = ranked.slice(offset, offset + limit).map((entry) => entry.hit);
    return { query, hits, nextCursor: nextSearchCursor(offset, limit, ranked.length) };
  }

  listSavedSearches(input: { actor: Actor }): { searches: readonly SavedSearch[] } {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    return { searches: this.ctx.storage.sql.exec<{
      id: string; name: string; query: string; created_at: number; updated_at: number;
    }>("SELECT id, name, query, created_at, updated_at FROM saved_searches WHERE member_id = ? ORDER BY updated_at DESC, id", actor.id)
      .toArray().map((row) => ({ id: row.id, name: row.name, query: row.query, createdAt: row.created_at, updatedAt: row.updated_at })) };
  }

  async saveSearch(input: { actor: Actor; idempotencyKey: string; name: string; query: string; now: number }): Promise<{ search: SavedSearch; replayed: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const name = input.name.replace(/\s+/g, " ").trim();
    const query = input.query.replace(/\s+/g, " ").trim();
    if (name.length < 1 || name.length > 80) throw new Error("saved search name is empty or too long");
    if (query.length < 1 || query.length > 500) throw new Error("saved search query is empty or too long");
    const parsed = parseSearchQuery(query);
    if (parsed.errors.length > 0 || (searchMatch(parsed.text) === null && parsed.from.length === 0 && parsed.in.length === 0
      && parsed.has.length === 0 && parsed.before === null && parsed.after === null && !parsed.isThread)) {
      throw new Error(parsed.errors[0] ?? "saved search query has no searchable terms");
    }
    const outcome = await this.commitMutation({
      scope: "search.save", idempotencyKey: input.idempotencyKey, requestHash: `${actor.id}|${name}|${query}`, now: input.now,
    }, () => {
      const existing = this.ctx.storage.sql.exec<{ id: string; created_at: number }>(
        "SELECT id, created_at FROM saved_searches WHERE member_id = ? AND name = ? COLLATE NOCASE", actor.id, name,
      ).toArray()[0];
      if (!existing) {
        const count = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM saved_searches WHERE member_id = ?", actor.id).one().count;
        if (count >= 20) throw new Error("saved search limit reached");
      }
      const id = existing?.id ?? crypto.randomUUID();
      const createdAt = existing?.created_at ?? input.now;
      this.ctx.storage.sql.exec(
        `INSERT INTO saved_searches(id, member_id, name, query, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(member_id, name) DO UPDATE SET query = excluded.query, updated_at = excluded.updated_at`,
        id, actor.id, name, query, createdAt, input.now,
      );
      return { result: { search: { id, name, query, createdAt, updatedAt: input.now } } };
    });
    return { ...outcome.result, replayed: outcome.replayed };
  }

  deleteSavedSearch(input: { actor: Actor; searchId: string }): { removed: boolean } {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    return { removed: this.ctx.storage.sql.exec("DELETE FROM saved_searches WHERE id = ? AND member_id = ?", input.searchId, actor.id).rowsWritten > 0 };
  }

  /**
   * Authorizes one download and returns the key to stream.
   *
   * The key is rechecked against this workspace even though it was read from
   * this workspace's own table, because a tenancy assertion that is only made
   * at write time is one bad row away from not being made at all.
   */
  authorizeDownload(input: { actor: Actor; fileId: string }): { objectKey: string; file: StoredFile } {
    const actor = this.authorizeActor(input.actor);
    const row = this.readFileRow(input.fileId);
    if (row === null || row.state !== "stored") throw new Error("file not found");
    const channel = readChannel(this.ctx.storage, row.channel_id);
    if (channel === null || !canSeeChannel(this.channelVisibility(channel, actor.id))) throw new Error("file not found");
    if (row.message_id !== null) {
      const message = readMessage(this.ctx.storage, row.message_id);
      if (message === null || !this.mayReadQueueItem(message, channel, actor.id)) throw new Error("file not found");
    }
    assertKeyBelongsToWorkspace(row.object_key, this.workspaceKeyId());
    return { objectKey: row.object_key, file: this.projectFile(row) };
  }

  /**
   * Deletes a file. Access ends in this transaction; the bytes are swept
   * afterwards (D07: reads revoked immediately, object removed within 24 hours).
   */
  async deleteFile(input: { actor: Actor; fileId: string; now: number }): Promise<{ objectKey: string }> {
    const actor = this.authorizeActor(input.actor);
    const outcome = await this.commitMutation<{ objectKey: string }>({ scope: "files.delete", now: input.now }, () => {
      const row = this.readFileRow(input.fileId);
      if (row === null || row.state === "deleted") throw new Error("file not found");
      // Visibility before authority: telling somebody who cannot see the room
      // that they merely lack permission would confirm the file exists.
      const channel = readChannel(this.ctx.storage, row.channel_id);
      if (channel === null || !canSeeChannel(this.channelVisibility(channel, actor.id))) throw new Error("file not found");
      if (row.message_id !== null) {
        const message = readMessage(this.ctx.storage, row.message_id);
        if (message === null || !this.mayReadQueueItem(message, channel, actor.id)) throw new Error("file not found");
      }
      const isUploader = row.uploaded_by_member_id === actor.id;
      if (!isUploader && actor.role !== "owner" && actor.role !== "admin") throw new Error("only the uploader or an administrator may delete this file");
      fileStateTransition(row.state, "deleted");
      this.ctx.storage.sql.exec("UPDATE files SET state = 'deleted', deleted_at = ?, expires_at = NULL WHERE id = ?", input.now, row.id);
      return {
        result: { objectKey: row.object_key },
        effects: {
          audit: {
            eventType: "file.deleted", outcome: "allowed", requesterKind: "member", requesterId: actor.id,
            subjectKind: "file", subjectId: row.id, metadata: { channel_id: row.channel_id },
          },
        },
      };
    });
    return outcome.result;
  }

  /**
   * Reservations nobody completed. Returns their keys so the caller can remove
   * any bytes that did land, which is the case an abandoned upload leaves.
   */
  async sweepAbandonedUploads(input: { now: number; limit?: number }): Promise<{ objectKeys: readonly string[] }> {
    const outcome = await this.commitMutation<{ objectKeys: readonly string[] }>({ scope: "files.sweep", now: input.now }, () => {
      const rows = this.ctx.storage.sql
        .exec<{ id: string; object_key: string }>(
          "SELECT id, object_key FROM files WHERE state = 'reserved' AND expires_at IS NOT NULL AND expires_at <= ? LIMIT ?",
          input.now, Math.min(Math.max(input.limit ?? 100, 1), 500),
        )
        .toArray();
      for (const row of rows) {
        this.ctx.storage.sql.exec("UPDATE files SET state = 'deleted', deleted_at = ?, expires_at = NULL WHERE id = ?", input.now, row.id);
      }
      return { result: { objectKeys: rows.map((row) => row.object_key) } };
    });
    return outcome.result;
  }

  private readFileRow(fileId: string): FileRow | null {
    return this.ctx.storage.sql.exec<FileRow>("SELECT * FROM files WHERE id = ?", fileId).toArray()[0] ?? null;
  }

  private projectFile(row: FileRow): StoredFile {
    return {
      id: row.id, fileName: row.file_name, mediaType: row.media_type, byteLength: row.byte_length,
      channelId: row.channel_id, messageId: row.message_id, uploadedByMemberId: row.uploaded_by_member_id,
      uploadedByDisplayName: row.uploader_display_name ?? null, uploadedByHandle: row.uploader_handle ?? null,
      channelName: row.channel_name ?? null, channelSlug: row.channel_slug ?? null,
      createdAt: row.created_at, inlineRenderable: isInlineRenderable(row.media_type),
    };
  }

  /** The tenant id used in object keys; stable for the life of the workspace. */
  private workspaceKeyId(): string {
    return this.ctx.id.toString();
  }

  async createGroup(input: {
    actor: Actor; idempotencyKey: string; handle: string; displayName: string;
    description?: string | null; memberIds?: readonly string[]; now: number;
  }): Promise<{ groupId: string }> {
    const actor = this.authorizeActor(input.actor);
    const key = parseIdempotencyKey(input.idempotencyKey);
    if (key === null) throw new Error("invalid idempotency key");
    const handle = parseGroupHandle(input.handle);
    const displayName = input.displayName.trim();
    if (displayName.length < 1 || displayName.length > 120) throw new Error("group name must be 1-120 characters");
    const description = input.description?.trim() || null;
    if (description !== null && description.length > 250) throw new Error("group description is too long");
    const memberIds = this.resolveActiveMemberIds(input.memberIds ?? []);
    const groupId = crypto.randomUUID();
    const outcome = await this.commitMutation({
      scope: "group.create",
      idempotencyKey: key,
      requestHash: JSON.stringify({ handle, displayName, description, memberIds }),
      now: input.now,
    }, () => {
      this.ctx.storage.sql.exec(
        `INSERT INTO groups(id, handle, display_name, description, created_by_member_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        groupId, handle, displayName, description, actor.id, input.now, input.now,
      );
      for (const memberId of memberIds) {
        this.ctx.storage.sql.exec(
          "INSERT INTO group_members(group_id, member_id, added_at, added_by_member_id) VALUES (?, ?, ?, ?)",
          groupId, memberId, input.now, actor.id,
        );
      }
      return {
        result: { groupId },
        effects: {
          audit: { eventType: "group.created", outcome: "allowed", requesterKind: "member", requesterId: actor.id, subjectKind: "group", subjectId: groupId, metadata: { handle, member_count: memberIds.length } },
          replay: [{ kind: "group.created", audience: ["workspace"], payload: { groupId, handle } }],
        },
      };
    });
    return outcome.result;
  }

  async replaceGroupMembers(input: { actor: Actor; groupId: string; memberIds: readonly string[]; now: number }): Promise<{ memberIds: readonly string[] }> {
    const actor = this.authorizeActor(input.actor);
    this.requireGroupEditor(input.groupId, actor);
    const memberIds = this.resolveActiveMemberIds(input.memberIds);
    await this.commitMutation({ scope: "group.members", now: input.now }, () => {
      this.ctx.storage.sql.exec("DELETE FROM group_members WHERE group_id = ?", input.groupId);
      for (const memberId of memberIds) this.ctx.storage.sql.exec(
        "INSERT INTO group_members(group_id, member_id, added_at, added_by_member_id) VALUES (?, ?, ?, ?)",
        input.groupId, memberId, input.now, actor.id,
      );
      this.ctx.storage.sql.exec("UPDATE groups SET updated_at = ? WHERE id = ?", input.now, input.groupId);
      return {
        result: { memberIds },
        effects: { audit: { eventType: "group.members_replaced", outcome: "allowed", requesterKind: "member", requesterId: actor.id, subjectKind: "group", subjectId: input.groupId, metadata: { member_count: memberIds.length } }, replay: [{ kind: "group.updated", audience: ["workspace"], payload: { groupId: input.groupId } }] },
      };
    });
    return { memberIds };
  }

  async archiveGroup(input: { actor: Actor; groupId: string; now: number }): Promise<{ archived: true }> {
    const actor = this.authorizeActor(input.actor);
    this.requireGroupEditor(input.groupId, actor);
    await this.commitMutation({ scope: "group.archive", now: input.now }, () => {
      this.ctx.storage.sql.exec("UPDATE groups SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL", input.now, input.now, input.groupId);
      return { result: { archived: true as const }, effects: { audit: { eventType: "group.archived", outcome: "allowed", requesterKind: "member", requesterId: actor.id, subjectKind: "group", subjectId: input.groupId, metadata: {} }, replay: [{ kind: "group.archived", audience: ["workspace"], payload: { groupId: input.groupId } }] } };
    });
    return { archived: true };
  }

  private requireGroupEditor(groupId: string, actor: ActiveMember): void {
    const row = this.ctx.storage.sql.exec<{ created_by_member_id: string | null }>(
      "SELECT created_by_member_id FROM groups WHERE id = ? AND archived_at IS NULL", groupId,
    ).toArray()[0];
    if (!row) throw new Error("group not found");
    if (row.created_by_member_id !== actor.id && actor.role !== "owner" && actor.role !== "admin") {
      throw new Error("only the group creator or an administrator may change it");
    }
  }

  configureNotifications(input: {
    actor: Actor;
    channelId?: string;
    notifyLevel?: NotifyLevel;
    keywords?: readonly string[];
    dndStartMinute?: number | null;
    dndEndMinute?: number | null;
    dndManualUntil?: number | null;
    now: number;
  }): { updated: true } {
    const actor = this.authorizeActor(input.actor);
    if (input.channelId !== undefined) {
      this.requireVisibleChannel(input.channelId, actor.id);
      const level = parseNotifyLevel(input.notifyLevel);
      if (level === null) throw new Error("invalid notification level");
      this.ctx.storage.sql.exec(
        `INSERT INTO channel_notification_preferences(channel_id, member_id, notify_level, updated_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(channel_id, member_id) DO UPDATE SET
         notify_level = excluded.notify_level, updated_at = excluded.updated_at`,
        input.channelId, actor.id, level, input.now,
      );
    }
    if (input.keywords !== undefined) {
      const keywords = [...new Set(input.keywords.map((value) => value.trim().toLocaleLowerCase()).filter((value) => value.length >= 2 && value.length <= 64))];
      if (keywords.length > 20 || keywords.length !== input.keywords.length) throw new Error("invalid notification keywords");
      this.ctx.storage.sql.exec("DELETE FROM notification_keywords WHERE member_id = ?", actor.id);
      for (const keyword of keywords) {
        this.ctx.storage.sql.exec(
          "INSERT INTO notification_keywords(member_id, keyword, created_at) VALUES (?, ?, ?)",
          actor.id, keyword, input.now,
        );
      }
    }
    if (input.dndStartMinute !== undefined || input.dndEndMinute !== undefined || input.dndManualUntil !== undefined) {
      const start = input.dndStartMinute ?? null;
      const end = input.dndEndMinute ?? null;
      if ((start === null) !== (end === null) || (start !== null && (!Number.isInteger(start) || start < 0 || start > 1439)) || (end !== null && (!Number.isInteger(end) || end < 0 || end > 1439))) {
        throw new Error("invalid do-not-disturb window");
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO notification_preferences(member_id, dnd_start_minute, dnd_end_minute, dnd_manual_until, updated_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET
         dnd_start_minute = excluded.dnd_start_minute, dnd_end_minute = excluded.dnd_end_minute,
         dnd_manual_until = excluded.dnd_manual_until, updated_at = excluded.updated_at`,
        actor.id, start, end, input.dndManualUntil ?? null, input.now,
      );
    }
    return { updated: true };
  }

  notificationPreferences(input: { actor: Actor }): NotificationPreferencesSnapshot {
    const actor = this.authorizeActor(input.actor);
    const settings = this.ctx.storage.sql.exec<{
      dnd_start_minute: number | null; dnd_end_minute: number | null; dnd_manual_until: number | null;
    }>("SELECT dnd_start_minute, dnd_end_minute, dnd_manual_until FROM notification_preferences WHERE member_id = ?", actor.id).toArray()[0];
    return {
      channels: this.ctx.storage.sql.exec<{ channel_id: string; notify_level: NotifyLevel }>(
        "SELECT channel_id, notify_level FROM channel_notification_preferences WHERE member_id = ? ORDER BY channel_id", actor.id,
      ).toArray().map((row) => ({ channelId: row.channel_id, level: row.notify_level })),
      keywords: this.ctx.storage.sql.exec<{ keyword: string }>(
        "SELECT keyword FROM notification_keywords WHERE member_id = ? ORDER BY keyword", actor.id,
      ).toArray().map((row) => row.keyword),
      dndStartMinute: settings?.dnd_start_minute ?? null,
      dndEndMinute: settings?.dnd_end_minute ?? null,
      dndManualUntil: settings?.dnd_manual_until ?? null,
    };
  }

  setThreadSubscription(input: { actor: Actor; threadRootId: string; subscribed: boolean; now: number }): { subscribed: boolean } {
    const actor = this.authorizeActor(input.actor);
    const root = readMessage(this.ctx.storage, input.threadRootId);
    if (root === null || root.threadRootId !== null || root.deletedAt !== null) throw new Error("thread not found");
    const channel = this.requireVisibleChannel(root.channelId, actor.id);
    this.requireReadableQueueItem(root, channel, actor.id);
    if (input.subscribed) {
      this.ctx.storage.sql.exec(
        `INSERT INTO thread_subscriptions(thread_root_id, member_id, subscribed_at) VALUES (?, ?, ?)
         ON CONFLICT(thread_root_id, member_id) DO NOTHING`,
        root.id, actor.id, input.now,
      );
    } else {
      this.ctx.storage.sql.exec("DELETE FROM thread_subscriptions WHERE thread_root_id = ? AND member_id = ?", root.id, actor.id);
    }
    return { subscribed: input.subscribed };
  }

  listNotificationActivity(input: { actor: Actor; unreadOnly?: boolean; limit?: number }): NotificationActivity {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
    const rows = this.ctx.storage.sql.exec<{
      id: string; kind: NotificationKind; message_id: string; channel_id: string; channel_label: string;
      author_kind: "member" | "agent"; author_label: string; body_markdown: string; thread_root_id: string | null;
      created_at: number; read_at: number | null; badge: number; push_allowed: number;
      channel_kind: ShellChannel["kind"]; is_member: number; private_item: number; allowed_member_ids_json: string;
    }>(
      `SELECT n.id, n.kind, n.message_id, n.channel_id, COALESCE(c.slug, c.name, c.id) AS channel_label,
              n.author_kind, m.author_display_snapshot AS author_label, m.body_markdown, m.thread_root_id,
              n.created_at, n.read_at, n.badge, n.push_allowed, c.kind AS channel_kind,
              CASE WHEN cm.member_id IS NULL THEN 0 ELSE 1 END AS is_member,
              n.private_item, n.allowed_member_ids_json
       FROM notifications n
       JOIN messages m ON m.id = n.message_id AND m.deleted_at IS NULL
       JOIN channels c ON c.id = n.channel_id AND c.archived_at IS NULL
       LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id = ?
       WHERE n.member_id = ? AND (? = 0 OR n.read_at IS NULL)
       ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
      actor.id, actor.id, input.unreadOnly ? 1 : 0, limit,
    ).toArray();
    const items = rows.filter((row) => notificationIsVisible({
      channelKind: row.channel_kind,
      isCurrentMember: row.is_member === 1,
      privateItem: row.private_item === 1,
      privateItemAllowed: JSON.parse(row.allowed_member_ids_json).includes(actor.id),
    })).map((row) => ({
      id: row.id, kind: row.kind, messageId: row.message_id, channelId: row.channel_id,
      channelLabel: row.channel_label, authorKind: row.author_kind, authorLabel: row.author_label,
      bodyMarkdown: row.body_markdown, threadRootId: row.thread_root_id, createdAt: row.created_at,
      readAt: row.read_at, badge: row.badge === 1, pushAllowed: row.push_allowed === 1,
      rank: homeRank({ kind: row.kind, unread: row.read_at === null, createdAt: row.created_at }),
    }));
    // The page is bounded; the badge is not. Count every currently visible
    // unread item instead of silently capping a busy member at the page size.
    const unread = this.ctx.storage.sql.exec<{
      total: number;
      mentions: number;
      threads: number;
      dms: number;
    }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN n.kind = 'mention' THEN 1 ELSE 0 END), 0) AS mentions,
              COALESCE(SUM(CASE WHEN n.kind = 'thread_reply' THEN 1 ELSE 0 END), 0) AS threads,
              COALESCE(SUM(CASE WHEN n.kind = 'dm' THEN 1 ELSE 0 END), 0) AS dms
       FROM notifications n
       JOIN messages m ON m.id = n.message_id AND m.deleted_at IS NULL
       JOIN channels c ON c.id = n.channel_id AND c.archived_at IS NULL
       LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id = ?
       WHERE n.member_id = ? AND n.read_at IS NULL AND n.badge = 1
         AND (c.kind = 'public' OR cm.member_id IS NOT NULL)
         AND (n.private_item = 0 OR EXISTS (
           SELECT 1 FROM json_each(n.allowed_member_ids_json) allowed WHERE allowed.value = ?
         ))`,
      actor.id,
      actor.id,
      actor.id,
    ).one();
    return {
      items,
      unread,
    };
  }

  markNotification(input: { actor: Actor; notificationId: string; unread: boolean; now: number }): { unread: boolean } {
    const actor = this.authorizeActor(input.actor);
    const changed = this.ctx.storage.sql.exec(
      "UPDATE notifications SET read_at = ? WHERE id = ? AND member_id = ?",
      input.unread ? null : input.now, input.notificationId, actor.id,
    );
    if (changed.rowsWritten === 0) throw new Error("notification not found");
    return { unread: input.unread };
  }

  /* ------------------------------------------------------------------ */
  /* Live delivery, read state and presence (C03)                        */
  /* ------------------------------------------------------------------ */

  /**
   * Frames arrive after authentication but decide nothing about who is acting:
   * the actor comes from the socket's own attachment, never from the payload.
   * Nothing here writes storage except an actual read-cursor advance.
   */
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const runner = this.runnerAttachmentOf(socket);
    if (runner !== null) {
      this.runnerSocketMessage(socket, runner, typeof message === "string" ? message : null);
      return;
    }
    const attachment = this.attachmentOf(socket);
    if (attachment === null) {
      socket.close(4001, "socket has no identity");
      return;
    }
    // Authority is rechecked live, so a revoked member's open tab stops working.
    if (!this.authorizeMember(attachment.memberId, attachment.authorizationEpoch)) {
      socket.close(4003, "membership authority changed");
      return;
    }

    const frame = parseClientFrame(typeof message === "string" ? message : null);
    switch (frame.type) {
      case "invalid":
        this.sendFrame(socket, { type: "error", reason: frame.reason });
        return;
      case "resume":
        this.replayForSocket(socket, attachment, frame.since);
        return;
      case "read":
        this.applyChannelRead(socket, attachment, frame.channelId, frame.sequence, Date.now());
        return;
      case "thread_read":
        this.applyThreadRead(socket, attachment, frame.threadRootId, frame.sequence, Date.now());
        return;
      case "typing":
        // Ephemeral by design: typing is relayed and never stored.
        this.relayTyping(attachment, frame.channelId, Date.now());
        return;
    }
  }

  webSocketClose(socket: WebSocket): void {
    // A runner going away is not a presence change; it is a machine that will
    // collect its pending wakes when it comes back.
    if (this.runnerAttachmentOf(socket) !== null) return;
    const attachment = this.attachmentOf(socket);
    if (attachment === null) return;
    if (this.socketsFor(attachment.memberId).length <= 1) {
      this.broadcastPresence(attachment.memberId, false);
    }
  }

  webSocketError(socket: WebSocket): void {
    this.webSocketClose(socket);
  }

  /** Members with at least one live socket. Derived, never written down. */
  onlineMemberIds(): string[] {
    const ids = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.attachmentOf(socket);
      if (attachment) ids.add(attachment.memberId);
    }
    return [...ids].sort();
  }

  presence(): { memberIds: readonly string[]; ttlMs: number } {
    return { memberIds: this.onlineMemberIds(), ttlMs: PRESENCE_TTL_MS };
  }

  /** A cursor per member per room: reading on the phone reads on the laptop. */
  markChannelRead(input: {
    actor: Actor;
    channelId: string;
    sequence: number;
    now: number;
  }): { sequence: number } {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireVisibleChannel(input.channelId, actor.id);
    const sequence = this.advanceChannelCursor(channel.id, actor.id, input.sequence, input.now);
    this.broadcastToMember(actor.id, { type: "read", channelId: channel.id, sequence });
    return { sequence };
  }

  /** Thread read state is separate from the channel's, as the product promises. */
  markThreadRead(input: {
    actor: Actor;
    threadRootId: string;
    sequence: number;
    now: number;
  }): { sequence: number } {
    const actor = this.authorizeActor(input.actor);
    const root = readMessage(this.ctx.storage, input.threadRootId);
    if (root === null || root.threadRootId !== null) throw new Error("thread not found");
    const channel = this.requireVisibleChannel(root.channelId, actor.id);
    this.requireReadableQueueItem(root, channel, actor.id);
    const sequence = this.advanceThreadCursor(root.id, actor.id, input.sequence, input.now);
    this.broadcastToMember(actor.id, { type: "thread_read", threadRootId: root.id, sequence });
    return { sequence };
  }

  unreadSummary(input: { actor: Actor }): UnreadSummary {
    const actor = this.authorizeActor(input.actor);
    return summariseUnread(readUnreadFacts(this.ctx.storage, actor.id));
  }

  /* -- realtime internals ---------------------------------------------- */

  private attachmentOf(socket: WebSocket): SocketAttachment | null {
    const raw = socket.deserializeAttachment() as (SocketAttachment & { kind?: string }) | null;
    // A runner carries a member id too, and must not be mistaken for one of
    // that member's tabs: it would show up in presence, be sent replay frames
    // and be counted as somebody being online.
    if (raw !== null && raw.kind === "runner") return null;
    return raw && typeof raw.memberId === "string" ? raw : null;
  }

  private runnerAttachmentOf(socket: WebSocket): RunnerAttachment | null {
    const raw = socket.deserializeAttachment() as (RunnerAttachment & { kind?: string }) | null;
    if (raw === null || raw.kind !== "runner" || typeof raw.deviceId !== "string") return null;
    return raw;
  }

  private socketsFor(memberId: string): WebSocket[] {
    return this.ctx.getWebSockets(memberId);
  }

  private sendFrame(socket: WebSocket, frame: ServerFrame): void {
    try {
      socket.send(encodeServerFrame(frame));
    } catch {
      // A socket that has gone away is not an error worth failing a write for.
    }
  }

  private latestReplaySequence(): number {
    return (
      this.ctx.storage.sql
        .exec<{ sequence: number | null }>("SELECT MAX(sequence) AS sequence FROM replay_events")
        .one().sequence ?? 0
    );
  }

  private oldestReplaySequence(): number {
    return (
      this.ctx.storage.sql
        .exec<{ sequence: number | null }>("SELECT MIN(sequence) AS sequence FROM replay_events")
        .one().sequence ?? 0
    );
  }

  /**
   * Replay from the client's cursor, filtered through the same visibility rule
   * the query path uses. A cursor older than the retention window is answered
   * with a reset rather than a silent gap.
   */
  private replayForSocket(socket: WebSocket, attachment: SocketAttachment, since: number): void {
    const oldest = this.oldestReplaySequence();
    if (oldest > 0 && since > 0 && since < oldest - 1) {
      this.sendFrame(socket, { type: "reset", reason: "replay window has expired" });
      this.updateAttachment(socket, { ...attachment, cursor: this.latestReplaySequence() });
      return;
    }

    const rows = this.ctx.storage.sql
      .exec<{ sequence: number; kind: string; audience_json: string; payload_json: string }>(
        "SELECT sequence, kind, audience_json, payload_json FROM replay_events WHERE sequence > ? ORDER BY sequence",
        since,
      )
      .toArray();

    let cursor = Math.max(attachment.cursor, since);
    for (const row of rows) {
      const audience = JSON.parse(row.audience_json) as string[];
      const channelId = audience[0] ?? "";
      // Re-check now, against current membership: an event stored while the
      // member could see the room must not be replayed after they left it.
      if (!this.socketMaySee(channelId, attachment.memberId)) {
        cursor = Math.max(cursor, row.sequence);
        continue;
      }
      this.sendFrame(socket, {
        type: "event",
        sequence: row.sequence,
        kind: row.kind,
        channelId,
        payload: JSON.parse(row.payload_json) as unknown,
      });
      cursor = Math.max(cursor, row.sequence);
    }
    this.updateAttachment(socket, { ...attachment, cursor });
  }

  private updateAttachment(socket: WebSocket, attachment: SocketAttachment): void {
    try {
      socket.serializeAttachment(attachment);
    } catch {
      // A closing socket cannot carry state forward, and does not need to.
    }
  }

  private socketMaySee(channelId: string, memberId: string): boolean {
    const channel = readChannel(this.ctx.storage, channelId);
    if (channel === null) return false;
    return canReceiveChannelEvent(this.channelVisibility(channel, memberId));
  }

  private channelVisibility(channel: ChannelRow, memberId: string): ChannelVisibility {
    return {
      kind: channel.kind,
      archivedAt: channel.archivedAt,
      isMember: isChannelMember(this.ctx.storage, channel.id, memberId),
    };
  }

  /**
   * Persist, then broadcast, filtered per socket. A client can never be told
   * about a message that is not already durable.
   */
  private broadcastChannelEvent(
    channel: ChannelRow,
    sequence: number,
    kind: string,
    payload: unknown,
  ): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.attachmentOf(socket);
      if (attachment === null) continue;
      if (!this.authorizeMember(attachment.memberId, attachment.authorizationEpoch)) continue;
      if (!canReceiveChannelEvent(this.channelVisibility(channel, attachment.memberId))) continue;
      this.sendFrame(socket, { type: "event", sequence, kind, channelId: channel.id, payload });
      this.updateAttachment(socket, { ...attachment, cursor: Math.max(attachment.cursor, sequence) });
    }
  }

  private broadcastToMember(memberId: string, frame: ServerFrame): void {
    for (const socket of this.socketsFor(memberId)) this.sendFrame(socket, frame);
  }

  private broadcastPresence(memberId: string, online: boolean): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.attachmentOf(socket);
      if (attachment === null || attachment.memberId === memberId) continue;
      this.sendFrame(socket, { type: "presence", memberId, online });
    }
  }

  private relayTyping(attachment: SocketAttachment, channelId: string, now: number): void {
    const channel = readChannel(this.ctx.storage, channelId);
    if (channel === null) return;
    if (!canSeeChannel(this.channelVisibility(channel, attachment.memberId))) return;
    for (const socket of this.ctx.getWebSockets()) {
      const other = this.attachmentOf(socket);
      if (other === null || other.memberId === attachment.memberId) continue;
      if (!canReceiveChannelEvent(this.channelVisibility(channel, other.memberId))) continue;
      this.sendFrame(socket, {
        type: "typing",
        channelId: channel.id,
        memberId: attachment.memberId,
        at: now,
      });
    }
  }

  private applyChannelRead(
    socket: WebSocket,
    attachment: SocketAttachment,
    channelId: string,
    requested: number,
    now: number,
  ): void {
    const channel = readChannel(this.ctx.storage, channelId);
    if (channel === null || !canSeeChannel(this.channelVisibility(channel, attachment.memberId))) {
      this.sendFrame(socket, { type: "error", reason: "channel not found" });
      return;
    }
    const sequence = this.advanceChannelCursor(channel.id, attachment.memberId, requested, now);
    this.broadcastToMember(attachment.memberId, { type: "read", channelId: channel.id, sequence });
  }

  private applyThreadRead(
    socket: WebSocket,
    attachment: SocketAttachment,
    threadRootId: string,
    requested: number,
    now: number,
  ): void {
    const root = readMessage(this.ctx.storage, threadRootId);
    if (root === null || root.threadRootId !== null) {
      this.sendFrame(socket, { type: "error", reason: "thread not found" });
      return;
    }
    const channel = readChannel(this.ctx.storage, root.channelId);
    if (channel === null || !canSeeChannel(this.channelVisibility(channel, attachment.memberId))) {
      this.sendFrame(socket, { type: "error", reason: "thread not found" });
      return;
    }
    const sequence = this.advanceThreadCursor(root.id, attachment.memberId, requested, now);
    this.broadcastToMember(attachment.memberId, {
      type: "thread_read",
      threadRootId: root.id,
      sequence,
    });
  }

  private advanceChannelCursor(
    channelId: string,
    memberId: string,
    requested: number,
    now: number,
  ): number {
    return this.ctx.storage.transactionSync(() => {
      const current = readChannelCursor(this.ctx.storage, channelId, memberId);
      const latest = latestChannelSequence(this.ctx.storage, channelId);
      const next = advanceReadCursor(current, requested, latest);
      if (next !== current) writeChannelCursor(this.ctx.storage, channelId, memberId, next, now);
      return next;
    });
  }

  private advanceThreadCursor(
    threadRootId: string,
    memberId: string,
    requested: number,
    now: number,
  ): number {
    return this.ctx.storage.transactionSync(() => {
      const current = readThreadCursor(this.ctx.storage, threadRootId, memberId);
      const latest = latestThreadSequence(this.ctx.storage, threadRootId);
      const next = advanceReadCursor(current, requested, latest);
      if (next !== current) writeThreadCursor(this.ctx.storage, threadRootId, memberId, next, now);
      return next;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Rooms, direct messages and message writes (C02)                     */
  /* ------------------------------------------------------------------ */

  /**
   * Create a named room. The slug is normalised before it is stored, so two
   * spellings of the same name cannot become two rooms that look identical in a
   * sidebar, and a repeated request under the same idempotency key returns the
   * room the first one made rather than a second room.
   */
  async createChannel(input: {
    actor: Actor;
    idempotencyKey: string;
    kind: "public" | "private";
    slug: string;
    name?: string | null;
    topic?: string | null;
    memberIds?: readonly string[];
    now: number;
  }): Promise<CreatedChannel> {
    const actor = this.authorizeActor(input.actor);
    if (!ROOM_CREATOR_ROLES.has(actor.role)) throw new Error("this role cannot create rooms");
    if (input.kind !== "public" && input.kind !== "private") throw new Error("unknown room kind");

    const slug = parseChannelSlug(input.slug);
    if (slug === null) throw new Error("invalid channel slug");
    const name = parseChannelName(input.name, slug);
    const topic = parseChannelTopic(input.topic);
    const invited = this.resolveActiveMemberIds(input.memberIds ?? []);

    const outcome = await this.commitMutation(
      {
        scope: "channel.create",
        idempotencyKey: input.idempotencyKey,
        requestHash: `${actor.id}|${input.kind}|${slug}`,
        now: input.now,
      },
      () => {
        const existing = readChannelBySlug(this.ctx.storage, slug);
        if (existing) throw new Error("channel slug is already taken");

        const channelId = crypto.randomUUID();
        insertChannel(this.ctx.storage, {
          id: channelId,
          kind: input.kind,
          slug,
          name,
          topic,
          dmKey: null,
          createdByMemberId: actor.id,
          now: input.now,
        });
        const members = [...new Set([actor.id, ...invited])];
        addChannelMembers(this.ctx.storage, channelId, members, input.now);

        return {
          result: { channelId, kind: input.kind as ChannelKind, created: true },
          effects: this.channelEffects("channel.created", channelId, actor, {
            channel_kind: input.kind,
            member_count: members.length,
          }),
        };
      },
    );
    return { ...outcome.result, created: !outcome.replayed };
  }

  /**
   * Open the conversation between a set of people. The same set always resolves
   * to the same room, whoever opens it and in whatever order, so two people
   * cannot end up in two parallel copies of one conversation.
   */
  async openDirectMessage(input: {
    actor: Actor;
    idempotencyKey: string;
    participantMemberIds: readonly string[];
    now: number;
  }): Promise<CreatedChannel> {
    const actor = this.authorizeActor(input.actor);
    const identity = directMessageIdentity([actor.id, ...input.participantMemberIds]);
    if (identity === null) throw new Error("invalid direct message participants");

    const others = identity.participantIds.filter((id) => id !== actor.id);
    if (this.resolveActiveMemberIds(others).length !== others.length) {
      throw new Error("every participant must be an active member");
    }

    const outcome = await this.commitMutation(
      {
        scope: "channel.direct",
        idempotencyKey: input.idempotencyKey,
        requestHash: identity.key,
        now: input.now,
      },
      () => {
        const existing = readChannelByDirectMessageKey(this.ctx.storage, identity.key);
        if (existing) {
          return { result: { channelId: existing.id, kind: existing.kind, created: false } };
        }
        const channelId = crypto.randomUUID();
        insertChannel(this.ctx.storage, {
          id: channelId,
          kind: identity.kind,
          slug: null,
          name: null,
          topic: null,
          dmKey: identity.key,
          createdByMemberId: actor.id,
          now: input.now,
        });
        addChannelMembers(this.ctx.storage, channelId, identity.participantIds, input.now);
        return {
          result: { channelId, kind: identity.kind as ChannelKind, created: true },
          effects: this.channelEffects("channel.direct_opened", channelId, actor, {
            channel_kind: identity.kind,
            member_count: identity.participantIds.length,
          }),
        };
      },
    );
    return { ...outcome.result, created: outcome.replayed ? false : outcome.result.created };
  }

  /** Anyone in the workspace may join an open room; a closed one needs an invite. */
  async joinChannel(input: { actor: Actor; channelId: string; now: number }): Promise<{ joined: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireVisibleChannel(input.channelId, actor.id);
    if (channel.kind !== "public") throw new Error("this room is joined by invitation only");
    if (channel.archivedAt !== null) throw new Error("this room is archived");

    const outcome = await this.commitMutation({ scope: "channel.join", now: input.now }, () => {
      const added = addChannelMembers(this.ctx.storage, channel.id, [actor.id], input.now);
      if (added.length === 0) return { result: { joined: false } };
      return {
        result: { joined: true },
        effects: this.channelEffects("channel.member_joined", channel.id, actor, {
          channel_kind: channel.kind,
        }),
      };
    });
    return outcome.result;
  }

  /** Adding someone else requires already being in the room you are adding them to. */
  async addChannelMember(input: {
    actor: Actor;
    channelId: string;
    memberId: string;
    now: number;
  }): Promise<{ added: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireChannelParticipant(input.channelId, actor.id);
    if (channel.kind === "dm" || channel.kind === "group_dm") {
      throw new Error("a conversation's participants are fixed when it is opened");
    }
    if (channel.archivedAt !== null) throw new Error("this room is archived");
    if (this.resolveActiveMemberIds([input.memberId]).length !== 1) {
      throw new Error("member is not active in this workspace");
    }

    const outcome = await this.commitMutation({ scope: "channel.add_member", now: input.now }, () => {
      const added = addChannelMembers(this.ctx.storage, channel.id, [input.memberId], input.now);
      if (added.length === 0) return { result: { added: false } };
      return {
        result: { added: true },
        effects: this.channelEffects("channel.member_added", channel.id, actor, {
          channel_kind: channel.kind,
          subject_member_id: input.memberId,
        }),
      };
    });
    return outcome.result;
  }

  /** Leaving is idempotent: a retry after a lost response is not an error. */
  async leaveChannel(input: { actor: Actor; channelId: string; now: number }): Promise<{ left: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireVisibleChannel(input.channelId, actor.id);
    if (channel.kind === "dm" || channel.kind === "group_dm") {
      throw new Error("a conversation cannot be left, only muted");
    }

    const outcome = await this.commitMutation({ scope: "channel.leave", now: input.now }, () => {
      const removed = removeChannelMember(this.ctx.storage, channel.id, actor.id);
      if (!removed) return { result: { left: false } };
      return {
        result: { left: true },
        effects: this.channelEffects("channel.member_left", channel.id, actor, {
          channel_kind: channel.kind,
        }),
      };
    });
    return outcome.result;
  }

  async archiveChannel(input: { actor: Actor; channelId: string; now: number }): Promise<{ archived: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireVisibleChannel(input.channelId, actor.id);
    if (channel.kind === "dm" || channel.kind === "group_dm") {
      throw new Error("a conversation cannot be archived");
    }
    const permitted =
      actor.role === "owner" || actor.role === "admin" || channel.createdByMemberId === actor.id;
    if (!permitted) throw new Error("only an admin or the room's creator may archive it");
    if (channel.archivedAt !== null) return { archived: false };

    const outcome = await this.commitMutation({ scope: "channel.archive", now: input.now }, () => {
      archiveChannel(this.ctx.storage, channel.id, input.now);
      return {
        result: { archived: true },
        effects: this.channelEffects("channel.archived", channel.id, actor, {
          channel_kind: channel.kind,
        }),
      };
    });
    return outcome.result;
  }

  /** Replace a room's queue definition atomically; old form definitions survive disabling. */
  async configureWorkQueue(input: {
    actor: Actor;
    channelId: string;
    postMode?: "open" | "form";
    formDefinition?: unknown;
    sortMode?: "chronological" | "ranked";
    sortEmoji?: string | null;
    statuses?: unknown;
    mainStatusLabel?: string;
    preset?: QueuePreset;
    now: number;
  }): Promise<{ channel: ChannelRow }> {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireVisibleChannel(input.channelId, actor.id);
    this.requireQueueManager(channel, actor);
    if (channel.kind !== "public" && channel.kind !== "private") throw new Error("work queues require a named room");
    if (channel.archivedAt !== null) throw new Error("this room is archived");

    const preset = input.preset ? queuePreset(input.preset) : null;
    const postMode = preset ? "form" : input.postMode ?? channel.postMode;
    const sortMode = preset ? "ranked" : input.sortMode ?? channel.sortMode;
    const formDefinition = preset?.form ?? (input.formDefinition === undefined ? channel.formDefinition : parseFormDefinition(input.formDefinition));
    if (postMode === "form" && formDefinition === null) throw new Error("form mode needs a valid form definition");
    const sortEmoji = preset?.rankingEmoji ?? input.sortEmoji ?? channel.sortEmoji ?? "🔥";
    if (sortMode === "ranked" && parseReactionEmoji(sortEmoji) === null) throw new Error("ranked mode needs one emoji");
    const statuses = preset?.statuses ?? (input.statuses === undefined ? [...channel.statusDefinitions] : parseQueueStatuses(input.statuses));
    if (statuses === null) throw new Error("invalid status definitions");
    if (statuses.length > 0 && sortMode !== "ranked") throw new Error("statuses require a ranked room");
    const mainStatusLabel = parseChannelName(input.mainStatusLabel, channel.mainStatusLabel);
    const formChanged = JSON.stringify(formDefinition) !== JSON.stringify(channel.formDefinition);
    const removed = new Set(channel.statusDefinitions.map((status) => status.id));
    for (const status of statuses) removed.delete(status.id);

    await this.commitMutation({ scope: "queue.configure", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        `UPDATE channels SET post_mode = ?, form_definition_json = ?,
           form_version = form_version + ?, sort_mode = ?, sort_emoji = ?,
           status_definitions_json = ?, main_status_label = ?, updated_at = ? WHERE id = ?`,
        postMode,
        formDefinition === null ? null : JSON.stringify(formDefinition),
        formChanged ? 1 : 0,
        sortMode,
        sortMode === "ranked" ? sortEmoji : null,
        JSON.stringify(statuses),
        mainStatusLabel,
        input.now,
        channel.id,
      );
      if (removed.size > 0) {
        const placeholders = [...removed].map(() => "?").join(",");
        this.ctx.storage.sql.exec(
          `UPDATE notifications SET private_item = 0, allowed_member_ids_json = '[]'
           WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ? AND status_id IN (${placeholders}))`,
          channel.id,
          ...removed,
        );
        this.ctx.storage.sql.exec(
          `UPDATE messages SET status_id = NULL, status_set_by_member_id = NULL, status_set_at = NULL
           WHERE channel_id = ? AND status_id IN (${placeholders})`,
          channel.id,
          ...removed,
        );
      }
      const ownerIds = this.ctx.storage.sql.exec<{ id: string }>(
        "SELECT id FROM members WHERE role = 'owner' AND status = 'active'",
      ).toArray().map((row) => row.id);
      for (const status of statuses) {
        const allowed = status.visibility === "private"
          ? [...new Set([...status.allowedMemberIds, ...ownerIds])]
          : [];
        this.ctx.storage.sql.exec(
          `UPDATE notifications SET private_item = ?, allowed_member_ids_json = ?
           WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ? AND status_id = ?)`,
          status.visibility === "private" ? 1 : 0,
          JSON.stringify(allowed), channel.id, status.id,
        );
      }
      return {
        result: { channel: readChannel(this.ctx.storage, channel.id)! },
        effects: this.channelEffects("queue.configured", channel.id, actor, {
          post_mode: postMode,
          sort_mode: sortMode,
          status_count: statuses.length,
          preset: input.preset ?? null,
        }),
      };
    });
    return { channel: readChannel(this.ctx.storage, channel.id)! };
  }

  /** Form submissions remain ordinary messages with an immutable structured snapshot. */
  async submitForm(input: {
    actor: Actor;
    idempotencyKey: string;
    channelId: string;
    values: Readonly<Record<string, unknown>>;
    now: number;
  }): Promise<SentMessage> {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireChannelParticipant(input.channelId, actor.id);
    if (channel.postMode !== "form" || channel.formDefinition === null) throw new Error("this room is not accepting form entries");
    const definition = parseFormDefinition(channel.formDefinition);
    if (definition === null) throw new Error("this form is not ready");
    const submission = buildFormSubmission(definition, channel.formVersion, input.values);
    for (const answer of submission.answers) {
      if (answer.type !== "person" || typeof answer.value !== "string" || answer.value.length === 0) continue;
      const person = answer.value.startsWith("@") ? answer.value.slice(1) : answer.value;
      const exists = this.ctx.storage.sql.exec<{ present: number }>(
        `SELECT 1 AS present FROM members
         WHERE status = 'active' AND (id = ? OR handle = ? COLLATE NOCASE)`,
        person, person,
      ).toArray()[0]?.present === 1;
      if (!exists) throw new Error(`${answer.label} must name an active member`);
    }
    return this.sendMessage({
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      channelId: channel.id,
      bodyMarkdown: renderFormSubmission(submission),
      contentJson: submission,
      viaForm: true,
      now: input.now,
    });
  }

  /** Read one visible bucket. Private-status filtering occurs before rows leave SQLite. */
  readWorkQueue(input: {
    actor: Actor;
    channelId: string;
    statusId?: string | null;
    limit?: number;
  }): WorkQueueSnapshot {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireVisibleChannel(input.channelId, actor.id);
    if (channel.sortMode !== "ranked" || channel.sortEmoji === null) throw new Error("this room is not ranked");
    const owner = actor.role === "owner" || channel.createdByMemberId === actor.id;
    const visible = channel.statusDefinitions.filter((status) => maySeeQueueStatus(status, actor.id, owner));
    const visibleIds = visible.map((status) => status.id);
    const selected = input.statusId ?? null;
    const counts = this.ctx.storage.sql.exec<{ status_id: string | null; total: number }>(
      `SELECT status_id, COUNT(*) AS total FROM messages
       WHERE channel_id = ? AND thread_root_id IS NULL AND deleted_at IS NULL
         AND (status_id IS NULL OR status_id IN (SELECT value FROM json_each(?)))
       GROUP BY status_id`,
      channel.id,
      JSON.stringify(visibleIds),
    ).toArray();
    const count = new Map(counts.map((row) => [row.status_id, row.total]));
    const populatedStatuses = visible.filter((status) => (count.get(status.id) ?? 0) > 0);
    const tabs = [
      { id: null, label: channel.mainStatusLabel, count: count.get(null) ?? 0 },
      ...populatedStatuses.map((status) => ({ id: status.id, label: status.label, count: count.get(status.id) ?? 0 })),
    ];
    return {
      channel,
      canManage: this.mayManageQueue(channel, actor),
      tabs,
      selectedStatusId: selected,
      page: this.decorateMessages(
        listQueueHistory(this.ctx.storage, channel.id, channel.sortEmoji, visibleIds, selected, input.limit).messages,
        actor.id,
      ),
    };
  }

  async setItemStatus(input: {
    actor: Actor;
    messageId: string;
    statusId: string | null;
    now: number;
  }): Promise<{ changed: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const message = readMessage(this.ctx.storage, input.messageId);
    if (message === null || message.deletedAt !== null || message.threadRootId !== null) throw new Error("queue item not found");
    const channel = this.requireVisibleChannel(message.channelId, actor.id);
    this.requireQueueManager(channel, actor);
    if (channel.sortMode !== "ranked") throw new Error("statuses require a ranked room");
    const status = input.statusId === null ? null : channel.statusDefinitions.find((candidate) => candidate.id === input.statusId);
    if (input.statusId !== null && status === undefined) throw new Error("queue status not found");
    if (message.statusId === input.statusId) return { changed: false };
    await this.commitMutation({ scope: "queue.status", now: input.now }, () => {
      if (status?.visibility === "private" && !status.allowedMemberIds.includes(actor.id)) {
        const next = channel.statusDefinitions.map((candidate) => candidate.id === status.id
          ? { ...candidate, allowedMemberIds: [...candidate.allowedMemberIds, actor.id] }
          : candidate);
        this.ctx.storage.sql.exec(
          "UPDATE channels SET status_definitions_json = ?, updated_at = ? WHERE id = ?",
          JSON.stringify(next), input.now, channel.id,
        );
      }
      this.ctx.storage.sql.exec(
        `UPDATE messages SET status_id = ?, status_set_by_member_id = ?, status_set_at = ? WHERE id = ?`,
        input.statusId, input.statusId === null ? null : actor.id, input.statusId === null ? null : input.now, message.id,
      );
      const ownerIds = this.ctx.storage.sql.exec<{ id: string }>(
        "SELECT id FROM members WHERE role = 'owner' AND status = 'active'",
      ).toArray().map((row) => row.id);
      const allowed = status?.visibility === "private"
        ? [...new Set([...status.allowedMemberIds, actor.id, ...ownerIds])]
        : [];
      this.ctx.storage.sql.exec(
        "UPDATE notifications SET private_item = ?, allowed_member_ids_json = ? WHERE message_id = ?",
        status?.visibility === "private" ? 1 : 0,
        JSON.stringify(allowed),
        message.id,
      );
      return {
        result: { changed: true },
        effects: this.channelEffects("queue.status_changed", channel.id, actor, {
          message_id: message.id,
          status_id: input.statusId,
        }),
      };
    });
    return { changed: true };
  }

  /**
   * Write a message. This is the plan authority check: on a Solo workspace the
   * designated host owns content and this object must refuse, because storing
   * the body here is exactly what the free-plan contract forbids.
   *
   * On a Team workspace the row, the channel and thread aggregates, the audit
   * entry, the realtime replay entry and the delivery record commit in one
   * transaction, and a retry under the same idempotency key returns the first
   * message rather than writing a second one.
   */
  async sendMessage(input: {
    actor: Actor;
    idempotencyKey: string;
    channelId: string;
    bodyMarkdown: string;
    threadParentId?: string | null;
    /** Internal form path only; browser composer and integrations never set it. */
    viaForm?: boolean;
    contentJson?: FormSubmission | null;
    confirmedBroadcastRecipients?: number;
    now: number;
  }): Promise<SentMessage> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();

    const channel = this.requireChannelParticipant(input.channelId, actor.id);
    if (channel.archivedAt !== null) throw new Error("this room is archived");

    const body = parseMessageBody(input.bodyMarkdown);
    if (body === null) throw new Error("message body is empty or too long");
    // A canary in a person's message means it already escaped: something put it
    // in front of them, and pasting it into a room would spread it further.
    this.refuseCanaryContent(body, {
      surface: "message", memberId: actor.id, agentId: null, channelId: channel.id, now: input.now,
    });

    const parent = input.threadParentId ? readMessage(this.ctx.storage, input.threadParentId) : null;
    if (input.threadParentId && parent === null) throw new Error("thread parent not found");
    const placement = resolveThreadPlacement(parent, channel.id);
    if (placement.kind === "invalid") throw new Error(placement.reason);
    const threadRootId = placement.kind === "reply" ? placement.threadRootId : null;
    if (channel.postMode === "form" && threadRootId === null && input.viaForm !== true) {
      throw new Error("this room only accepts form entries");
    }

    const outcome = await this.commitMutation(
      {
        scope: "message.send",
        idempotencyKey: input.idempotencyKey,
        requestHash: `${actor.id}|${channel.id}|${threadRootId ?? ""}|${body.length}`,
        now: input.now,
      },
      () => {
        const messageId = crypto.randomUUID();
        const channelSequence = nextChannelSequence(this.ctx.storage, channel.id);
        const mentions = resolveMentionTargets(this.ctx.storage, parseMentions(body));
        if (mentions.some((mention) => mention.kind === "channel" || mention.kind === "here")) {
          const policy = this.ctx.storage.sql.exec<{ broadcast_policy: "admins" | "members" }>(
            "SELECT broadcast_policy FROM channels WHERE id = ?", channel.id,
          ).one();
          const recipientCount = channelMemberIds(this.ctx.storage, channel.id).filter(
            (memberId) => memberId !== actor.id,
          ).length;
          const permitted = actor.role === "owner" || actor.role === "admin" || policy.broadcast_policy === "members";
          if (!permitted) throw new Error("broadcast requires permission");
          if (recipientCount === 0) throw new Error("broadcast has no recipients");
          if (!mayUseBroadcast({
            actorRole: actor.role,
            channelAllowsMembers: policy.broadcast_policy === "members",
            confirmedRecipientCount: input.confirmedBroadcastRecipients ?? null,
            actualRecipientCount: recipientCount,
          })) throw new Error(`broadcast requires confirmation for ${recipientCount} recipients`);
        }
        insertMessage(this.ctx.storage, {
          id: messageId,
          channelId: channel.id,
          threadRootId,
          authorKind: "member",
          authorId: actor.id,
          authorDisplaySnapshot: actor.displayName,
          bodyMarkdown: body,
          channelSequence,
          contentJson: input.contentJson ? JSON.stringify(input.contentJson) : null,
          now: input.now,
        });
        if (input.contentJson?.kind === "form_submission") {
          const searchable = input.contentJson.answers
            .map((answer) => `${answer.label} ${Array.isArray(answer.value) ? answer.value.join(" ") : answer.value}`)
            .join("\n");
          this.ctx.storage.sql.exec(
            "INSERT INTO form_submission_content(message_id, searchable_text) VALUES (?, ?)",
            messageId,
            searchable,
          );
        }
        replaceMentions(this.ctx.storage, messageId, mentions, input.now);
        // A mention becomes work in the same transaction as the message, so a
        // queue item can never exist for a message that was rolled back.
        const enqueued = this.enqueueAgentMentions({
          messageId,
          channelId: channel.id,
          authorKind: "member",
          authorId: actor.id,
          bodyMarkdown: body,
          mentions,
          isHistorical: false,
          now: input.now,
        });
        const notified = this.recordMessageNotifications({
          messageId, channel, threadRootId, authorKind: "member", authorId: actor.id,
          bodyMarkdown: body, mentions, now: input.now,
        });

        return {
          result: {
            messageId,
            channelId: channel.id,
            threadRootId,
            channelSequence,
            createdAt: input.now,
            replayed: false,
          },
          effects: {
            // No body, anywhere: an audit record explains who acted, not what
            // they said, and it is retained far longer than the message is.
            audit: {
              eventType: "message.created",
              outcome: "allowed" as const,
              requesterKind: "member" as const,
              requesterId: actor.id,
              subjectKind: "message",
              subjectId: messageId,
              metadata: {
                channel_id: channel.id,
                channel_kind: channel.kind,
                in_thread: threadRootId !== null,
                channel_sequence: channelSequence,
                mention_count: mentions.length,
                agent_work_enqueued: enqueued,
                notification_count: notified.created,
                push_count: notified.pushMemberIds.length,
              },
            },
            // Delivery carries identifiers; a reader fetches the message it is
            // authorised for rather than receiving a copy in the event.
            replay: [
              {
                kind: "message.created",
                audience: [channel.id],
                payload: {
                  messageId,
                  channelId: channel.id,
                  threadRootId,
                  channelSequence,
                  authorId: actor.id,
                  createdAt: input.now,
                },
              },
            ],
            outbox: [
              {
                id: `message.${messageId}`,
                kind: "message_created",
                dedupeKey: `message:${messageId}`,
                payload: { messageId, channelId: channel.id, threadRootId },
              },
              ...notified.pushMemberIds.map((memberId) => ({
                id: `notification.${messageId}.${memberId}`,
                kind: "notification_push",
                dedupeKey: `notification:${messageId}:${memberId}`,
                payload: { memberId, messageId, channelId: channel.id },
              })),
            ],
          } satisfies MutationEffects,
        };
      },
    );

    // Persist, then broadcast: the write is already durable, and the ordering
    // clients observe is the ordering the database has.
    if (!outcome.replayed) {
      this.broadcastChannelEvent(channel, this.latestReplaySequence(), "message.created", {
        messageId: outcome.result.messageId,
        channelId: channel.id,
        threadRootId: outcome.result.threadRootId,
        channelSequence: outcome.result.channelSequence,
        authorId: actor.id,
        createdAt: input.now,
      });
    }
    return { ...outcome.result, replayed: outcome.replayed };
  }

  /**
   * Only the author may rewrite what they said. An edit keeps the message's
   * place in the room and its sequence, re-derives who it addresses, and leaves
   * a visible marker rather than changing the record silently.
   */
  async editMessage(input: {
    actor: Actor;
    messageId: string;
    bodyMarkdown: string;
    now: number;
  }): Promise<{ messageId: string; editedAt: number }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const { message, channel } = this.requireOwnMessage(input.messageId, actor.id, "edit");

    const body = parseMessageBody(input.bodyMarkdown);
    if (body === null) throw new Error("message body is empty or too long");

    const outcome = await this.commitMutation({ scope: "message.edit", now: input.now }, () => {
      applyMessageEdit(this.ctx.storage, message.id, body, input.now);
      const mentions = resolveMentionTargets(this.ctx.storage, parseMentions(body));
      replaceMentions(this.ctx.storage, message.id, mentions, input.now);
      return {
        result: { messageId: message.id, editedAt: input.now },
        effects: this.messageEffects("message.edited", message.id, channel, actor, {
          mention_count: mentions.length,
        }),
      };
    });

    this.broadcastChannelEvent(channel, this.latestReplaySequence(), "message.edited", {
      messageId: message.id,
      channelId: channel.id,
      editedAt: input.now,
    });
    return outcome.result;
  }

  /**
   * A delete removes the content, not the row. The tombstone keeps the thread
   * readable and the sequence intact; the body, its mentions and its reactions
   * leave every read immediately. An admin may delete somebody else's message,
   * and the audit record says who did.
   */
  async deleteMessage(input: {
    actor: Actor;
    messageId: string;
    now: number;
  }): Promise<{ messageId: string; deletedAt: number }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const message = readMessage(this.ctx.storage, input.messageId);
    if (message === null || message.deletedAt !== null) throw new Error("message not found");
    const channel = this.requireVisibleChannel(message.channelId, actor.id);
    const moderator = actor.role === "owner" || actor.role === "admin";
    if (message.authorId !== actor.id && !moderator) {
      throw new Error("only the author or an admin may delete a message");
    }

    const outcome = await this.commitMutation({ scope: "message.delete", now: input.now }, () => {
      applyMessageDelete(this.ctx.storage, message.id, actor.id, input.now);
      return {
        result: { messageId: message.id, deletedAt: input.now },
        effects: this.messageEffects("message.deleted", message.id, channel, actor, {
          by_author: message.authorId === actor.id,
        }),
      };
    });

    this.broadcastChannelEvent(channel, this.latestReplaySequence(), "message.deleted", {
      messageId: message.id,
      channelId: channel.id,
      deletedAt: input.now,
    });
    return outcome.result;
  }

  /** Reacting is idempotent: one person and one emoji is one reaction. */
  async reactToMessage(input: {
    actor: Actor;
    messageId: string;
    emoji: string;
    now: number;
  }): Promise<{ added: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const { message, channel } = this.requireReactableMessage(input.messageId, actor.id);
    const emoji = this.requireUsableReaction(input.emoji);

    const outcome = await this.commitMutation({ scope: "message.react", now: input.now }, () => {
      const added = addReaction(this.ctx.storage, message.id, actor.id, emoji, input.now);
      if (!added) return { result: { added: false } };
      return {
        result: { added: true },
        effects: this.messageEffects("message.reacted", message.id, channel, actor, {
          reaction_length: emoji.length,
        }),
      };
    });

    if (outcome.result.added) {
      this.broadcastChannelEvent(channel, this.latestReplaySequence(), "message.reacted", {
        messageId: message.id,
        channelId: channel.id,
        emoji,
        memberId: actor.id,
        added: true,
      });
    }
    return outcome.result;
  }

  async unreactToMessage(input: {
    actor: Actor;
    messageId: string;
    emoji: string;
    now: number;
  }): Promise<{ removed: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const { message, channel } = this.requireReactableMessage(input.messageId, actor.id);
    // Removing is allowed even for a name since withdrawn, so a reaction cannot
    // be stranded by an admin deleting the emoji.
    const emoji = parseReactionEmoji(input.emoji);
    if (emoji === null) throw new Error("invalid reaction");

    const removed = this.ctx.storage.transactionSync(() =>
      removeReaction(this.ctx.storage, message.id, actor.id, emoji),
    );
    if (removed) {
      this.broadcastChannelEvent(channel, this.latestReplaySequence(), "message.reacted", {
        messageId: message.id,
        channelId: channel.id,
        emoji,
        memberId: actor.id,
        added: false,
      });
    }
    return { removed };
  }

  /**
   * A reaction is a literal emoji, or the name of one this workspace has
   * defined. An unnamed `:token:` is refused rather than stored, or the column
   * becomes a second message body nobody indexed.
   */
  private requireUsableReaction(value: string): string {
    const emoji = parseReactionEmoji(value);
    if (emoji === null) throw new Error("invalid reaction");
    if (!isEmojiToken(emoji)) return emoji;
    const name = parseCustomEmojiName(emoji);
    if (name === null || !customEmojiExists(this.ctx.storage, name)) {
      throw new Error("no custom emoji by that name");
    }
    return emoji;
  }

  private requireOwnMessage(
    messageId: string,
    memberId: string,
    verb: string,
  ): { message: MessageRow; channel: ChannelRow } {
    const message = readMessage(this.ctx.storage, messageId);
    if (message === null || message.deletedAt !== null) throw new Error("message not found");
    const channel = this.requireVisibleChannel(message.channelId, memberId);
    if (message.authorId !== memberId || message.authorKind !== "member") {
      throw new Error(`only the author may ${verb} a message`);
    }
    if (channel.archivedAt !== null) throw new Error("this room is archived");
    return { message, channel };
  }

  private requireReactableMessage(
    messageId: string,
    memberId: string,
  ): { message: MessageRow; channel: ChannelRow } {
    const message = readMessage(this.ctx.storage, messageId);
    if (message === null || message.deletedAt !== null) throw new Error("message not found");
    const channel = this.requireChannelParticipant(message.channelId, memberId);
    this.requireReadableQueueItem(message, channel, memberId);
    if (channel.archivedAt !== null) throw new Error("this room is archived");
    return { message, channel };
  }

  private messageEffects(
    eventType: string,
    messageId: string,
    channel: ChannelRow,
    actor: ActiveMember,
    metadata: Record<string, string | number | boolean | null>,
  ): MutationEffects {
    return {
      audit: {
        eventType,
        outcome: "allowed",
        requesterKind: "member",
        requesterId: actor.id,
        subjectKind: "message",
        subjectId: messageId,
        metadata: { channel_id: channel.id, ...metadata },
      },
      replay: [
        {
          kind: eventType,
          audience: [channel.id],
          payload: { messageId, channelId: channel.id, actorId: actor.id },
        },
      ],
    };
  }

  /* ------------------------------------------------------------------ */
  /* Pins, saved items and forwarding (C05a)                             */
  /* ------------------------------------------------------------------ */

  /** A pin belongs to the room, so pinning requires being in it. */
  async pinMessage(input: {
    actor: Actor;
    messageId: string;
    now: number;
  }): Promise<{ pinned: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const { message, channel } = this.requireReactableMessage(input.messageId, actor.id);

    const outcome = await this.commitMutation({ scope: "message.pin", now: input.now }, () => {
      const pinned = pinMessage(this.ctx.storage, channel.id, message.id, actor.id, input.now);
      if (!pinned) return { result: { pinned: false } };
      return {
        result: { pinned: true },
        effects: this.messageEffects("message.pinned", message.id, channel, actor, {}),
      };
    });

    if (outcome.result.pinned) {
      this.broadcastChannelEvent(channel, this.latestReplaySequence(), "message.pinned", {
        messageId: message.id,
        channelId: channel.id,
        pinned: true,
      });
    }
    return outcome.result;
  }

  async unpinMessage(input: {
    actor: Actor;
    messageId: string;
    now: number;
  }): Promise<{ unpinned: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const { message, channel } = this.requireReactableMessage(input.messageId, actor.id);

    const unpinned = this.ctx.storage.transactionSync(() =>
      unpinMessage(this.ctx.storage, channel.id, message.id),
    );
    if (unpinned) {
      this.broadcastChannelEvent(channel, this.latestReplaySequence(), "message.pinned", {
        messageId: message.id,
        channelId: channel.id,
        pinned: false,
      });
    }
    return { unpinned };
  }

  /** The room's pins, for anybody the room is visible to. */
  listPins(input: { actor: Actor; channelId: string; limit?: number }): { messages: readonly MessageRow[] } {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireVisibleChannel(input.channelId, actor.id);
    const messages = listPinnedMessages(this.ctx.storage, channel.id, clampHistoryLimit(input.limit))
      .filter((message) => this.mayReadQueueItem(message, channel, actor.id));
    return {
      messages: this.decorateMessages(messages, actor.id).messages,
    };
  }

  /**
   * Saving is private and requires being able to read the message now. It saves
   * a pointer, not a copy and not a permission.
   */
  async saveMessage(input: {
    actor: Actor;
    messageId: string;
    now: number;
  }): Promise<{ saved: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const message = readMessage(this.ctx.storage, input.messageId);
    if (message === null || message.deletedAt !== null) throw new Error("message not found");
    // Visible, not necessarily joined: you may save something from an open room.
    const channel = this.requireVisibleChannel(message.channelId, actor.id);
    this.requireReadableQueueItem(message, channel, actor.id);

    const saved = this.ctx.storage.transactionSync(() =>
      saveMessageForMember(this.ctx.storage, actor.id, message.id, input.now),
    );
    return { saved };
  }

  async unsaveMessage(input: {
    actor: Actor;
    messageId: string;
  }): Promise<{ removed: boolean }> {
    const actor = this.authorizeActor(input.actor);
    // Removing a pointer needs no visibility: it is this member's own list, and
    // refusing would strand a saved item in a room they can no longer see.
    const removed = this.ctx.storage.transactionSync(() =>
      unsaveMessageForMember(this.ctx.storage, actor.id, input.messageId),
    );
    return { removed };
  }

  /**
   * This member's saved messages.
   *
   * Every pointer is rechecked against the room as it stands now. A message
   * saved from a room the member has since left, or that has since been
   * deleted, is not returned — the saved list is not a way to keep reading
   * something you can no longer read.
   */
  listSavedItems(input: { actor: Actor; limit?: number }): {
    items: readonly { message: MessageRow; savedAt: number }[];
    /** Pointers dropped because the member may no longer read them. */
    unavailable: number;
  } {
    const actor = this.authorizeActor(input.actor);
    const limit = clampHistoryLimit(input.limit);
    const pointers = listSavedPointers(this.ctx.storage, actor.id, limit);

    const readable: { message: MessageRow; savedAt: number }[] = [];
    let unavailable = 0;
    for (const pointer of pointers) {
      if (pointer.message.deletedAt !== null) {
        unavailable += 1;
        continue;
      }
      const channel = readChannel(this.ctx.storage, pointer.message.channelId);
      if (channel === null || !canSeeChannel(this.channelVisibility(channel, actor.id))
        || !this.mayReadQueueItem(pointer.message, channel, actor.id)) {
        unavailable += 1;
        continue;
      }
      readable.push(pointer);
    }

    const decorated = this.decorateMessages(
      readable.map((entry) => entry.message),
      actor.id,
    ).messages;
    return {
      items: decorated.map((message, index) => ({ message, savedAt: readable[index].savedAt })),
      unavailable,
    };
  }

  /**
   * Forward a message into another room.
   *
   * A forward is a new message carrying a copy, not a window into the room it
   * came from: the copy is made by somebody who can read the original, and it
   * is written into a room they may post in. Both are checked here, and the
   * provenance is resolved for each reader separately when it is displayed.
   */
  async forwardMessage(input: {
    actor: Actor;
    idempotencyKey: string;
    messageId: string;
    targetChannelId: string;
    comment?: string | null;
    now: number;
  }): Promise<SentMessage> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();

    const source = readMessage(this.ctx.storage, input.messageId);
    if (source === null || source.deletedAt !== null) throw new Error("message not found");
    // Readable by this member right now, not merely once.
    const sourceChannel = this.requireVisibleChannel(source.channelId, actor.id);
    const target = this.requireChannelParticipant(input.targetChannelId, actor.id);
    if (target.archivedAt !== null) throw new Error("this room is archived");

    const comment = input.comment ? parseMessageBody(input.comment) : null;
    if (input.comment && comment === null) throw new Error("message body is empty or too long");
    const body = parseMessageBody(comment ? `${comment}\n\n${source.bodyMarkdown}` : source.bodyMarkdown);
    if (body === null) throw new Error("message body is empty or too long");

    const outcome = await this.commitMutation(
      {
        scope: "message.forward",
        idempotencyKey: input.idempotencyKey,
        requestHash: `${actor.id}|${source.id}|${target.id}`,
        now: input.now,
      },
      () => {
        const messageId = crypto.randomUUID();
        const channelSequence = nextChannelSequence(this.ctx.storage, target.id);
        const mentions = resolveMentionTargets(this.ctx.storage, parseMentions(body));
        insertMessage(this.ctx.storage, {
          id: messageId,
          channelId: target.id,
          threadRootId: null,
          authorKind: "member",
          authorId: actor.id,
          authorDisplaySnapshot: actor.displayName,
          bodyMarkdown: body,
          channelSequence,
          forwardedFrom: {
            messageId: source.id,
            channelId: sourceChannel.id,
            authorDisplaySnapshot: source.authorDisplaySnapshot,
          },
          now: input.now,
        });
        replaceMentions(this.ctx.storage, messageId, mentions, input.now);

        return {
          result: {
            messageId,
            channelId: target.id,
            threadRootId: null,
            channelSequence,
            createdAt: input.now,
            replayed: false,
          },
          effects: {
            audit: {
              eventType: "message.forwarded",
              outcome: "allowed" as const,
              requesterKind: "member" as const,
              requesterId: actor.id,
              subjectKind: "message",
              subjectId: messageId,
              metadata: {
                channel_id: target.id,
                source_channel_id: sourceChannel.id,
                source_message_id: source.id,
              },
            },
            replay: [
              {
                kind: "message.created",
                audience: [target.id],
                payload: {
                  messageId,
                  channelId: target.id,
                  threadRootId: null,
                  channelSequence,
                  authorId: actor.id,
                  createdAt: input.now,
                },
              },
            ],
            outbox: [
              {
                id: `message.${messageId}`,
                kind: "message_created",
                dedupeKey: `message:${messageId}`,
                payload: { messageId, channelId: target.id, threadRootId: null },
              },
            ],
          } satisfies MutationEffects,
        };
      },
    );

    if (!outcome.replayed) {
      this.broadcastChannelEvent(target, this.latestReplaySequence(), "message.created", {
        messageId: outcome.result.messageId,
        channelId: target.id,
        threadRootId: null,
        channelSequence: outcome.result.channelSequence,
        authorId: actor.id,
        createdAt: input.now,
      });
    }
    return { ...outcome.result, replayed: outcome.replayed };
  }

  /**
   * Attach per-reader state to a page: reactions, mentions, whether this member
   * pinned or saved each message, and whether they may see where a forward came
   * from. Provenance is resolved per reader because the room a copy came from
   * may be one this reader cannot see.
   */
  private decorateMessages(messages: readonly MessageRow[], memberId: string): MessagePage {
    const annotated = annotateMessages(this.ctx.storage, { messages, nextCursor: null });
    const saved = savedMessageIds(this.ctx.storage, memberId);
    const snippets = readSnippets(
      this.ctx.storage,
      messages.map((message) => message.id),
    );
    const mcpAttributions = readMcpMessageAttributions(
      this.ctx.storage,
      messages.map((message) => message.id),
    );
    const pinsByChannel = new Map<string, Set<string>>();

    const decorated = annotated.messages.map((message) => {
      if (!pinsByChannel.has(message.channelId)) {
        pinsByChannel.set(message.channelId, pinnedMessageIds(this.ctx.storage, message.channelId));
      }
      let forwardedFrom = message.forwardedFrom;
      if (forwardedFrom !== null) {
        const sourceChannel = readChannel(this.ctx.storage, forwardedFrom.channelId);
        const visible =
          sourceChannel !== null && canSeeChannel(this.channelVisibility(sourceChannel, memberId));
        forwardedFrom = {
          ...forwardedFrom,
          sourceVisible: visible,
          // The room's name is withheld from a reader who cannot see the room.
          sourceChannelLabel:
            visible && sourceChannel ? (sourceChannel.slug ?? sourceChannel.name ?? sourceChannel.id) : null,
          channelId: visible ? forwardedFrom.channelId : "",
        };
      }
      return {
        ...message,
        forwardedFrom,
        isSaved: saved.has(message.id),
        isPinned: pinsByChannel.get(message.channelId)!.has(message.id),
        snippet: snippets.get(message.id) ?? null,
        mcpAttribution: mcpAttributions.get(message.id) ?? null,
      };
    });

    return { messages: decorated, nextCursor: annotated.nextCursor };
  }

  /* ------------------------------------------------------------------ */
  /* Synced drafts and scheduled messages (C05b)                         */
  /* ------------------------------------------------------------------ */

  /**
   * Save a draft for this member and this composing surface.
   *
   * Drafts follow a person between devices, which means two devices can edit
   * one draft. The caller sends the revision it was editing from; if the stored
   * draft has moved on, this refuses and hands back what is actually stored
   * rather than silently overwriting whatever the other device typed.
   */
  saveDraft(input: {
    actor: Actor;
    channelId: string;
    threadRootId?: string | null;
    bodyMarkdown: string;
    baseRevision?: number;
    now: number;
  }): DraftSaveResult {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    this.requireChannelParticipant(input.channelId, actor.id);
    const threadKey = this.requireThreadKey(input.channelId, input.threadRootId ?? null);

    const body = input.bodyMarkdown.slice(0, MAX_MESSAGE_LENGTH);

    return this.ctx.storage.transactionSync(() => {
      const existing = readDraft(this.ctx.storage, actor.id, input.channelId, threadKey);

      // An empty body clears the draft rather than storing nothing.
      if (body.trim().length === 0) {
        if (existing && input.baseRevision !== undefined && existing.revision !== input.baseRevision) {
          return { status: "conflict" as const, draft: existing };
        }
        deleteDraft(this.ctx.storage, actor.id, input.channelId, threadKey);
        return { status: "cleared" as const, draft: null };
      }

      if (existing && input.baseRevision !== undefined && existing.revision !== input.baseRevision) {
        return { status: "conflict" as const, draft: existing };
      }

      const revision = (existing?.revision ?? 0) + 1;
      writeDraft(this.ctx.storage, actor.id, input.channelId, threadKey, body, revision, input.now);
      return {
        status: "saved" as const,
        draft: {
          channelId: input.channelId,
          threadRootId: threadKey === "" ? null : threadKey,
          bodyMarkdown: body,
          revision,
          updatedAt: input.now,
        },
      };
    });
  }

  getDraft(input: {
    actor: Actor;
    channelId: string;
    threadRootId?: string | null;
  }): { draft: DraftRow | null } {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireVisibleChannel(input.channelId, actor.id);
    const threadKey = input.threadRootId ?? "";
    return { draft: readDraft(this.ctx.storage, actor.id, channel.id, threadKey) };
  }

  /**
   * Every draft this member has, filtered to rooms they can still see. A draft
   * left in a room they have since left is not handed back to them.
   */
  listDrafts(input: { actor: Actor }): { drafts: readonly DraftRow[]; unavailable: number } {
    const actor = this.authorizeActor(input.actor);
    const all = listDraftsForMember(this.ctx.storage, actor.id);
    const drafts: DraftRow[] = [];
    let unavailable = 0;
    for (const draft of all) {
      const channel = readChannel(this.ctx.storage, draft.channelId);
      if (channel === null || !canSeeChannel(this.channelVisibility(channel, actor.id))) {
        unavailable += 1;
        continue;
      }
      drafts.push(draft);
    }
    return { drafts, unavailable };
  }

  /**
   * Schedule a message for later.
   *
   * The body is validated now so a scheduled send cannot become a surprise
   * failure at three in the morning, and the deadline rides the object's one
   * alarm through the F06 scheduler rather than a timer of its own.
   */
  async scheduleMessage(input: {
    actor: Actor;
    idempotencyKey: string;
    channelId: string;
    bodyMarkdown: string;
    threadParentId?: string | null;
    sendAt: number;
    now: number;
  }): Promise<{ id: string; sendAt: number; replayed: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const channel = this.requireChannelParticipant(input.channelId, actor.id);
    if (channel.archivedAt !== null) throw new Error("this room is archived");

    const sendAt = this.requireSendAt(input.sendAt, input.now);
    const body = parseMessageBody(input.bodyMarkdown);
    if (body === null) throw new Error("message body is empty or too long");
    const threadRootId = this.resolveScheduledThreadRoot(input.threadParentId ?? null, channel.id);

    const outcome = await this.commitMutation(
      {
        scope: "message.schedule",
        idempotencyKey: input.idempotencyKey,
        requestHash: `${actor.id}|${channel.id}|${sendAt}`,
        now: input.now,
      },
      () => {
        const id = crypto.randomUUID();
        insertScheduledMessage(this.ctx.storage, {
          id,
          memberId: actor.id,
          channelId: channel.id,
          threadRootId,
          bodyMarkdown: body,
          sendAt,
          now: input.now,
        });
        return {
          result: { id, sendAt },
          effects: {
            audit: {
              eventType: "message.scheduled",
              outcome: "allowed" as const,
              requesterKind: "member" as const,
              requesterId: actor.id,
              subjectKind: "scheduled_message",
              subjectId: id,
              metadata: { channel_id: channel.id, send_at: sendAt },
            },
            dueWork: [{ id: SCHEDULED_SEND_WORK_ID, kind: "scheduled_send", dueAt: sendAt }],
          } satisfies MutationEffects,
        };
      },
    );

    await this.armScheduledSends(input.now);
    return { ...outcome.result, replayed: outcome.replayed };
  }

  /** Only the person who scheduled it may change it, and only before it fires. */
  async updateScheduledMessage(input: {
    actor: Actor;
    id: string;
    bodyMarkdown?: string;
    sendAt?: number;
    now: number;
  }): Promise<{ updated: boolean; sendAt: number }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const scheduled = this.requireOwnScheduledMessage(input.id, actor.id);

    const changes: { bodyMarkdown?: string; sendAt?: number } = {};
    if (input.bodyMarkdown !== undefined) {
      const body = parseMessageBody(input.bodyMarkdown);
      if (body === null) throw new Error("message body is empty or too long");
      changes.bodyMarkdown = body;
    }
    if (input.sendAt !== undefined) changes.sendAt = this.requireSendAt(input.sendAt, input.now);

    const updated = this.ctx.storage.transactionSync(() =>
      updateScheduledMessage(this.ctx.storage, scheduled.id, changes, input.now),
    );
    await this.armScheduledSends(input.now);
    return { updated, sendAt: changes.sendAt ?? scheduled.sendAt };
  }

  async cancelScheduledMessage(input: {
    actor: Actor;
    id: string;
    now: number;
  }): Promise<{ cancelled: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const scheduled = this.requireOwnScheduledMessage(input.id, actor.id);
    const cancelled = this.ctx.storage.transactionSync(() =>
      settleScheduledMessage(this.ctx.storage, scheduled.id, { status: "cancelled" }, input.now),
    );
    await this.armScheduledSends(input.now);
    return { cancelled };
  }

  listScheduledMessages(input: { actor: Actor; limit?: number }): {
    scheduled: readonly ScheduledMessageRow[];
  } {
    const actor = this.authorizeActor(input.actor);
    return {
      scheduled: listScheduledForMember(this.ctx.storage, actor.id, clampHistoryLimit(input.limit)),
    };
  }

  /**
   * Send everything that has come due.
   *
   * Authority is rechecked at the moment of sending, not at the moment of
   * scheduling: somebody suspended, removed from the room, or whose room was
   * archived in the meantime does not get a message posted in their name. A
   * refusal settles the row with a reason instead of retrying forever.
   *
   * The send itself is keyed on the scheduled id, so a duplicate alarm returns
   * the message the first one wrote rather than posting a second.
   */
  async deliverDueScheduledMessages(now: number): Promise<{
    sent: number;
    failed: number;
    considered: number;
  }> {
    const due = claimDueScheduledMessages(this.ctx.storage, now, SCHEDULED_SEND_BATCH);
    let sent = 0;
    let failed = 0;

    for (const scheduled of due) {
      const refusal = this.scheduledSendRefusal(scheduled);
      if (refusal !== null) {
        this.ctx.storage.transactionSync(() =>
          settleScheduledMessage(
            this.ctx.storage,
            scheduled.id,
            { status: "failed", reason: refusal },
            now,
          ),
        );
        failed += 1;
        continue;
      }

      try {
        const result = await this.sendMessage({
          actor: {
            memberId: scheduled.memberId,
            authorizationEpoch: this.memberAuthorizationEpoch(scheduled.memberId),
          },
          // Keyed on the scheduled row, so a duplicate alarm cannot post twice.
          idempotencyKey: `scheduled:${scheduled.id}`,
          channelId: scheduled.channelId,
          bodyMarkdown: scheduled.bodyMarkdown,
          threadParentId: scheduled.threadRootId,
          now,
        });
        this.ctx.storage.transactionSync(() =>
          settleScheduledMessage(
            this.ctx.storage,
            scheduled.id,
            { status: "sent", messageId: result.messageId },
            now,
          ),
        );
        sent += 1;
      } catch (error) {
        this.ctx.storage.transactionSync(() =>
          settleScheduledMessage(
            this.ctx.storage,
            scheduled.id,
            { status: "failed", reason: redactedError(error) },
            now,
          ),
        );
        failed += 1;
      }
    }

    await this.armScheduledSends(now);
    return { sent, failed, considered: due.length };
  }

  /* -- scheduling helpers ---------------------------------------------- */

  /** Why this scheduled message must not be sent, or null if it may be. */
  private scheduledSendRefusal(scheduled: ScheduledMessageRow): string | null {
    const member = this.ctx.storage.sql
      .exec<{ status: string }>("SELECT status FROM members WHERE id = ?", scheduled.memberId)
      .toArray()[0];
    if (!member || member.status !== "active") return "author is no longer an active member";

    const channel = readChannel(this.ctx.storage, scheduled.channelId);
    if (channel === null) return "channel no longer exists";
    if (channel.archivedAt !== null) return "channel was archived before the send time";
    if (!isChannelMember(this.ctx.storage, channel.id, scheduled.memberId)) {
      return "author is no longer in the channel";
    }
    return null;
  }

  private memberAuthorizationEpoch(memberId: string): number {
    return (
      this.ctx.storage.sql
        .exec<{ authorization_epoch: number }>(
          "SELECT authorization_epoch FROM members WHERE id = ?",
          memberId,
        )
        .toArray()[0]?.authorization_epoch ?? 0
    );
  }

  /** Keep the object's one alarm pointed at the next scheduled send. */
  private async armScheduledSends(now: number): Promise<void> {
    const next = nextScheduledSendAt(this.ctx.storage);
    if (next === null) return;
    this.ctx.storage.transactionSync(() =>
      scheduleDueWork(
        this.ctx.storage,
        [{ id: SCHEDULED_SEND_WORK_ID, kind: "scheduled_send", dueAt: next }],
        now,
      ),
    );
    await this.armAlarm();
  }

  private requireSendAt(sendAt: number, now: number): number {
    if (!Number.isSafeInteger(sendAt)) throw new Error("send time must be a whole timestamp");
    if (sendAt <= now) throw new Error("send time must be in the future");
    if (sendAt - now > MAX_SCHEDULE_AHEAD_MS) throw new Error("send time is too far ahead");
    return sendAt;
  }

  private requireOwnScheduledMessage(id: string, memberId: string): ScheduledMessageRow {
    const scheduled = readScheduledMessage(this.ctx.storage, id);
    // Somebody else's scheduled message is reported as missing, not forbidden.
    if (scheduled === null || scheduled.memberId !== memberId) {
      throw new Error("scheduled message not found");
    }
    if (scheduled.status !== "scheduled") throw new Error("this message has already been settled");
    return scheduled;
  }

  private resolveScheduledThreadRoot(parentId: string | null, channelId: string): string | null {
    if (parentId === null) return null;
    const parent = readMessage(this.ctx.storage, parentId);
    if (parent === null) throw new Error("thread parent not found");
    const placement = resolveThreadPlacement(parent, channelId);
    if (placement.kind === "invalid") throw new Error(placement.reason);
    return placement.kind === "reply" ? placement.threadRootId : null;
  }

  /** A draft's thread key must name a real thread root in that same room. */
  private requireThreadKey(channelId: string, threadRootId: string | null): string {
    if (threadRootId === null || threadRootId === "") return "";
    const root = readMessage(this.ctx.storage, threadRootId);
    if (root === null || root.channelId !== channelId || root.threadRootId !== null) {
      throw new Error("thread not found");
    }
    return root.id;
  }

  /* ------------------------------------------------------------------ */
  /* Snippets, slash commands and custom emoji (C05c)                    */
  /* ------------------------------------------------------------------ */

  /**
   * Post a snippet: a message whose real content is too long to be one.
   *
   * The message itself carries a one-line summary so history stays readable;
   * the body travels beside it and is loaded with the page that shows it.
   */
  async sendSnippet(input: {
    actor: Actor;
    idempotencyKey: string;
    channelId: string;
    title?: string | null;
    language?: string | null;
    body: string;
    threadParentId?: string | null;
    now: number;
  }): Promise<SentMessage> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const channel = this.requireChannelParticipant(input.channelId, actor.id);
    if (channel.archivedAt !== null) throw new Error("this room is archived");

    const snippet = parseSnippet({
      title: input.title,
      language: input.language,
      body: input.body,
    });
    if (snippet === null) throw new Error("snippet is empty or too long");

    const parent = input.threadParentId ? readMessage(this.ctx.storage, input.threadParentId) : null;
    if (input.threadParentId && parent === null) throw new Error("thread parent not found");
    const placement = resolveThreadPlacement(parent, channel.id);
    if (placement.kind === "invalid") throw new Error(placement.reason);
    const threadRootId = placement.kind === "reply" ? placement.threadRootId : null;

    const summary = snippetMessageBody(snippet);

    const outcome = await this.commitMutation(
      {
        scope: "message.snippet",
        idempotencyKey: input.idempotencyKey,
        requestHash: `${actor.id}|${channel.id}|${snippet.body.length}`,
        now: input.now,
      },
      () => {
        const messageId = crypto.randomUUID();
        const channelSequence = nextChannelSequence(this.ctx.storage, channel.id);
        insertMessage(this.ctx.storage, {
          id: messageId,
          channelId: channel.id,
          threadRootId,
          authorKind: "member",
          authorId: actor.id,
          authorDisplaySnapshot: actor.displayName,
          bodyMarkdown: summary,
          channelSequence,
          now: input.now,
        });
        insertSnippet(this.ctx.storage, { messageId, ...snippet });

        return {
          result: {
            messageId,
            channelId: channel.id,
            threadRootId,
            channelSequence,
            createdAt: input.now,
            replayed: false,
          },
          effects: {
            audit: {
              eventType: "message.snippet_created",
              outcome: "allowed" as const,
              requesterKind: "member" as const,
              requesterId: actor.id,
              subjectKind: "message",
              subjectId: messageId,
              // Counts and a language, never the snippet itself.
              metadata: {
                channel_id: channel.id,
                line_count: snippet.lineCount,
                language: snippet.language,
              },
            },
            replay: [
              {
                kind: "message.created",
                audience: [channel.id],
                payload: {
                  messageId,
                  channelId: channel.id,
                  threadRootId,
                  channelSequence,
                  authorId: actor.id,
                  createdAt: input.now,
                },
              },
            ],
            outbox: [
              {
                id: `message.${messageId}`,
                kind: "message_created",
                dedupeKey: `message:${messageId}`,
                payload: { messageId, channelId: channel.id, threadRootId },
              },
            ],
          } satisfies MutationEffects,
        };
      },
    );

    if (!outcome.replayed) {
      this.broadcastChannelEvent(channel, this.latestReplaySequence(), "message.created", {
        messageId: outcome.result.messageId,
        channelId: channel.id,
        threadRootId,
        channelSequence: outcome.result.channelSequence,
        authorId: actor.id,
        createdAt: input.now,
      });
    }
    return { ...outcome.result, replayed: outcome.replayed };
  }

  /**
   * Run what somebody typed into the composer.
   *
   * Parsing decided only what was meant. Everything a command does goes through
   * the same authorized method the button would have called, so a command can
   * never reach further than the person typing it already could.
   */
  async runComposerInput(input: {
    actor: Actor;
    idempotencyKey: string;
    channelId: string;
    raw: string;
    threadParentId?: string | null;
    confirmedBroadcastRecipients?: number;
    now: number;
  }): Promise<ComposerOutcome> {
    const parsed = parseComposerInput(input.raw);

    switch (parsed.kind) {
      case "empty":
        return { kind: "rejected", reason: "There is nothing to send." };

      case "unknown_command":
        // Refused, not posted: somebody who mistypes a command did not mean to
        // say it out loud to the room.
        return {
          kind: "rejected",
          reason: `${parsed.typed} is not a command. Start a message with // to say it literally.`,
        };

      case "message": {
        const sent = await this.sendMessage({
          actor: input.actor,
          idempotencyKey: input.idempotencyKey,
          channelId: input.channelId,
          bodyMarkdown: parsed.bodyMarkdown,
          threadParentId: input.threadParentId ?? null,
          confirmedBroadcastRecipients: input.confirmedBroadcastRecipients,
          now: input.now,
        });
        return { kind: "sent", messageId: sent.messageId };
      }

      case "command": {
        const body = commandMessageBody(parsed.name, parsed.argument);
        if (body !== null) {
          const sent = await this.sendMessage({
            actor: input.actor,
            idempotencyKey: input.idempotencyKey,
            channelId: input.channelId,
            bodyMarkdown: body,
            threadParentId: input.threadParentId ?? null,
            now: input.now,
          });
          return { kind: "sent", messageId: sent.messageId };
        }

        switch (parsed.name) {
          case "join":
            await this.joinChannel({
              actor: input.actor,
              channelId: input.channelId,
              now: input.now,
            });
            return { kind: "acted", command: "join" };
          case "leave":
            await this.leaveChannel({
              actor: input.actor,
              channelId: input.channelId,
              now: input.now,
            });
            return { kind: "acted", command: "leave" };
          case "archive":
            await this.archiveChannel({
              actor: input.actor,
              channelId: input.channelId,
              now: input.now,
            });
            return { kind: "acted", command: "archive" };
          default:
            return { kind: "rejected", reason: "That command needs something to say." };
        }
      }
    }
  }

  /** Naming an emoji is workspace administration, not an ordinary member action. */
  async createCustomEmoji(input: {
    actor: Actor;
    name: string;
    aliasEmoji: string;
    now: number;
  }): Promise<{ created: boolean; name: string }> {
    const actor = this.authorizeActor(input.actor);
    if (actor.role !== "owner" && actor.role !== "admin") {
      throw new Error("only an admin may name a custom emoji");
    }
    const name = parseCustomEmojiName(input.name);
    if (name === null) throw new Error("invalid custom emoji name");
    const alias = parseReactionEmoji(input.aliasEmoji);
    if (alias === null || isEmojiToken(alias)) throw new Error("a custom emoji needs a real emoji");

    const outcome = await this.commitMutation({ scope: "emoji.create", now: input.now }, () => {
      const created = insertCustomEmoji(this.ctx.storage, name, alias, actor.id, input.now);
      if (!created) return { result: { created: false, name } };
      return {
        result: { created: true, name },
        effects: {
          audit: {
            eventType: "emoji.created",
            outcome: "allowed" as const,
            requesterKind: "member" as const,
            requesterId: actor.id,
            subjectKind: "custom_emoji",
            subjectId: name,
            metadata: {},
          },
        } satisfies MutationEffects,
      };
    });
    return outcome.result;
  }

  async deleteCustomEmoji(input: {
    actor: Actor;
    name: string;
    now: number;
  }): Promise<{ deleted: boolean }> {
    const actor = this.authorizeActor(input.actor);
    if (actor.role !== "owner" && actor.role !== "admin") {
      throw new Error("only an admin may remove a custom emoji");
    }
    const name = parseCustomEmojiName(input.name);
    if (name === null) throw new Error("invalid custom emoji name");

    const outcome = await this.commitMutation({ scope: "emoji.delete", now: input.now }, () => {
      const deleted = deleteCustomEmoji(this.ctx.storage, name);
      if (!deleted) return { result: { deleted: false } };
      return {
        result: { deleted: true },
        effects: {
          audit: {
            eventType: "emoji.deleted",
            outcome: "allowed" as const,
            requesterKind: "member" as const,
            requesterId: actor.id,
            subjectKind: "custom_emoji",
            subjectId: name,
            metadata: {},
          },
        } satisfies MutationEffects,
      };
    });
    return outcome.result;
  }

  /** Every member can read the workspace's emoji; only admins can change them. */
  listCustomEmoji(input: { actor: Actor }): { emoji: readonly CustomEmojiRow[] } {
    this.authorizeActor(input.actor);
    return { emoji: listCustomEmoji(this.ctx.storage) };
  }

  /* ------------------------------------------------------------------ */
  /* Agent identities, ownership, briefs and scope (A01)                 */
  /* ------------------------------------------------------------------ */

  /**
   * Create an agent.
   *
   * Anyone in the workspace may create one, and whoever does becomes its first
   * owner, because an agent nobody owns is an agent nobody is accountable for.
   * An agent is not a login: it has no account, no session and no membership
   * row, and it can never be an actor.
   */
  async createAgent(input: {
    actor: Actor;
    idempotencyKey: string;
    handle: string;
    displayName?: string | null;
    description?: string | null;
    prompt?: string | null;
    scopeMode?: "any" | "listed";
    scopeChannelIds?: readonly string[];
    now: number;
  }): Promise<{ agentId: string; handle: string; created: boolean }> {
    const actor = this.authorizeActor(input.actor);
    if (actor.role === "guest") throw new Error("this role cannot create agents");

    const handle = parseAgentHandle(input.handle);
    if (handle === null) throw new Error("an agent handle must be in the a. namespace");
    const displayName = parseChannelName(input.displayName, handle.slice(2));
    const description = parseChannelTopic(input.description);
    const prompt = parseAgentBrief(input.prompt);
    const scopeMode = input.scopeMode === "listed" ? "listed" : "any";
    const scopeChannelIds =
      scopeMode === "listed" ? this.resolveScopeChannels(input.scopeChannelIds ?? [], actor.id) : [];

    const outcome = await this.commitMutation(
      {
        scope: "agent.create",
        idempotencyKey: input.idempotencyKey,
        requestHash: `${actor.id}|${handle}`,
        now: input.now,
      },
      () => {
        if (readAgentByHandle(this.ctx.storage, handle) !== null) {
          throw new Error("that agent handle is already taken");
        }
        const agentId = crypto.randomUUID();
        this.ctx.storage.sql.exec(
          `INSERT INTO agents(id, handle, display_name, description, status, prompt, scope_mode,
                              created_by_member_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
          agentId,
          handle,
          displayName,
          description,
          prompt,
          scopeMode,
          actor.id,
          input.now,
          input.now,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO agent_owners(agent_id, member_id, added_by_member_id, added_at) VALUES (?, ?, ?, ?)",
          agentId,
          actor.id,
          actor.id,
          input.now,
        );
        replaceAgentScope(this.ctx.storage, agentId, scopeChannelIds, input.now);

        return {
          result: { agentId, handle, created: true },
          effects: {
            audit: {
              eventType: "agent.created",
              outcome: "allowed" as const,
              requesterKind: "member" as const,
              requesterId: actor.id,
              subjectKind: "agent",
              subjectId: agentId,
              metadata: { agent_handle: handle, scope_mode: scopeMode, scope_size: scopeChannelIds.length },
            },
          } satisfies MutationEffects,
        };
      },
    );
    return { ...outcome.result, created: !outcome.replayed };
  }

  /** Configure provider authority without ever accepting a static Anthropic API key. */
  async configureClaudeRuntime(input: {
    actor: Actor;
    agentId: string;
    authority: WifAuthority;
    providerAgentId: string;
    providerEnvironmentId: string;
    providerDeploymentId?: string | null;
    webhookSigningSecret: string;
    budgetCents: number;
    now: number;
  }): Promise<{ status: "pending"; subject: string }> {
    const actor = this.authorizeActor(input.actor);
    this.requireOwnedAgent(input.agentId, actor.id);
    const authority = validateWifAuthority(input.authority);
    if (!input.webhookSigningSecret.startsWith("whsec_") || input.webhookSigningSecret.length < 32) throw new Error("invalid webhook signing secret");
    if (!Number.isSafeInteger(input.budgetCents) || input.budgetCents < 1) throw new Error("cloud runtime needs a positive budget");
    for (const value of [input.providerAgentId, input.providerEnvironmentId, input.providerDeploymentId ?? "ok"]) {
      if (!/^[A-Za-z0-9_-]{2,200}$/.test(value)) throw new Error("invalid provider resource id");
    }
    const key = this.transportSecretKey();
    const context = `anthropic:${this.workspaceKey()}:${authority.organizationId}:${authority.workspaceId}`;
    const envelope = await encryptTransportSecret(input.webhookSigningSecret, key, context);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO agent_runtime_configs(
           agent_id, kind, status, organization_id, provider_workspace_id, provider_agent_id,
           provider_environment_id, provider_deployment_id, wif_issuer, wif_audience, wif_subject,
           service_account_id, federation_rule_id, secret_envelope, budget_cents, created_at, updated_at)
         VALUES (?, 'claude_cloud', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET kind = 'claude_cloud', status = 'pending',
           organization_id = excluded.organization_id, provider_workspace_id = excluded.provider_workspace_id,
           provider_agent_id = excluded.provider_agent_id, provider_environment_id = excluded.provider_environment_id,
           provider_deployment_id = excluded.provider_deployment_id, wif_issuer = excluded.wif_issuer,
           wif_audience = excluded.wif_audience, wif_subject = excluded.wif_subject,
           service_account_id = excluded.service_account_id, federation_rule_id = excluded.federation_rule_id,
           callback_url = NULL, secret_envelope = excluded.secret_envelope, budget_cents = excluded.budget_cents,
           resource_proved_at = NULL, webhook_proved_at = NULL, updated_at = excluded.updated_at`,
        input.agentId, authority.organizationId, authority.workspaceId, input.providerAgentId,
        input.providerEnvironmentId, input.providerDeploymentId ?? null, authority.issuer, authority.audience,
        authority.subject, authority.serviceAccountId, authority.federationRuleId, envelope,
        input.budgetCents, input.now, input.now,
      );
    });
    if (this.env.CONTROL_DB) {
      const workspace = await this.env.CONTROL_DB.prepare(
        "SELECT id FROM workspaces WHERE durable_object_id = ? AND status = 'active'",
      ).bind(this.workspaceKey()).first<{ id: string }>();
      if (workspace) {
        await this.env.CONTROL_DB.prepare(
          `INSERT INTO runtime_webhook_routes(organization_id, provider_workspace_id, workspace_id, durable_object_id,
             secret_envelope, transport_context, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
           ON CONFLICT(organization_id, provider_workspace_id) DO UPDATE SET workspace_id = excluded.workspace_id,
             durable_object_id = excluded.durable_object_id, secret_envelope = excluded.secret_envelope,
             transport_context = excluded.transport_context, status = 'pending', updated_at = excluded.updated_at`,
        ).bind(authority.organizationId, authority.workspaceId, workspace.id, this.workspaceKey(), envelope, context,
          input.now, input.now).run();
      }
    }
    return { status: "pending", subject: authority.subject };
  }

  /** Authenticated GET proof for the exact configured agent and environment. */
  async proveClaudeRuntimeResources(input: { actor: Actor; agentId: string; now: number }): Promise<{ status: "pending" | "active" }> {
    const actor = this.authorizeActor(input.actor);
    this.requireOwnedAgent(input.agentId, actor.id);
    const config = this.requireRuntimeConfig(input.agentId, "claude_cloud");
    const accessToken = await this.providerAccessToken(config, input.now);
    await callManagedAgents({ accessToken, path: `/v1/agents/${config.provider_agent_id!}` });
    await callManagedAgents({ accessToken, path: `/v1/environments/${config.provider_environment_id!}` });
    const status = config.webhook_proved_at === null ? "pending" : "active";
    this.ctx.storage.sql.exec(
      "UPDATE agent_runtime_configs SET resource_proved_at = ?, status = ?, updated_at = ? WHERE agent_id = ?",
      input.now, status, input.now, input.agentId,
    );
    return { status };
  }

  /** Store and test one metadata-only custom wake endpoint. */
  async configureCustomRuntime(input: {
    actor: Actor; agentId: string; callbackUrl: string; signingSecret: string; now: number;
  }): Promise<{ status: "active" }> {
    const actor = this.authorizeActor(input.actor);
    this.requireOwnedAgent(input.agentId, actor.id);
    if (input.signingSecret.length < 32) throw new Error("custom callback secret is too short");
    const url = await validatePublicCallbackUrl(input.callbackUrl, (hostname) => this.resolvePublicDns(hostname));
    const context = `custom:${this.workspaceKey()}:${input.agentId}`;
    const envelope = await encryptTransportSecret(input.signingSecret, this.transportSecretKey(), context);
    const probe = customWake({ type: "custom.test", delivery_id: crypto.randomUUID(), created_at: new Date(input.now).toISOString(),
      workspace_id: this.workspaceKey(), agent_id: input.agentId, queue_depth: 0 });
    const result = await deliverCustomWake({ url: url.toString(), wake: probe, secret: input.signingSecret,
      resolve: (hostname) => this.resolvePublicDns(hostname), now: input.now });
    if (result.status !== "delivered") throw new Error(`custom callback test failed: ${result.error}`);
    this.ctx.storage.sql.exec(
      `INSERT INTO agent_runtime_configs(agent_id, kind, status, callback_url, secret_envelope, created_at, updated_at)
       VALUES (?, 'custom', 'active', ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET kind = 'custom', status = 'active', callback_url = excluded.callback_url,
         secret_envelope = excluded.secret_envelope, organization_id = NULL, provider_workspace_id = NULL,
         provider_agent_id = NULL, provider_environment_id = NULL, provider_deployment_id = NULL,
         budget_cents = NULL, resource_proved_at = NULL, webhook_proved_at = NULL, updated_at = excluded.updated_at`,
      input.agentId, url.toString(), envelope, input.now, input.now,
    );
    return { status: "active" };
  }

  /** Called only by the exact Worker gateway after SDK verification. */
  async acceptAnthropicWebhook(input: { event: AnthropicThinEvent; now: number }): Promise<{ duplicate: boolean }> {
    const config = this.ctx.storage.sql.exec<AgentRuntimeConfigRow>(
      `SELECT * FROM agent_runtime_configs WHERE kind = 'claude_cloud' AND organization_id = ?
       AND provider_workspace_id = ? AND status IN ('pending', 'active')`,
      input.event.data.organization_id, input.event.data.workspace_id,
    ).toArray()[0];
    if (!config) throw new Error("webhook authority does not match this workspace");
    const result = this.ctx.storage.transactionSync(() => {
      const duplicate = this.ctx.storage.sql.exec<{ present: number }>(
        "SELECT 1 AS present FROM anthropic_webhook_receipts WHERE event_id = ?", input.event.id,
      ).toArray()[0] !== undefined;
      if (duplicate) return { duplicate: true };
      this.ctx.storage.sql.exec(
        `INSERT INTO anthropic_webhook_receipts(event_id, event_type, resource_id, organization_id,
           provider_workspace_id, received_at) VALUES (?, ?, ?, ?, ?, ?)`,
        input.event.id, input.event.data.type, input.event.data.id, input.event.data.organization_id,
        input.event.data.workspace_id, input.now,
      );
      const status = config.resource_proved_at === null ? "pending" : "active";
      this.ctx.storage.sql.exec(
        "UPDATE agent_runtime_configs SET webhook_proved_at = COALESCE(webhook_proved_at, ?), status = ?, updated_at = ? WHERE agent_id = ?",
        input.now, status, input.now, config.agent_id,
      );
      enqueueOutbox(this.ctx.storage, [{ id: `anthropic_event.${input.event.id}`, kind: "anthropic_resource_fetch",
        dedupeKey: `anthropic_resource_fetch:${input.event.id}`, payload: {
          eventId: input.event.id, eventType: input.event.data.type, resourceId: input.event.data.id, agentId: config.agent_id,
        } }], input.now);
      scheduleDueWork(this.ctx.storage, [{ id: OUTBOX_FLUSH_WORK_ID, kind: "outbox_flush", dueAt: input.now }], input.now);
      return { duplicate: false };
    });
    await this.armAlarm();
    return result;
  }

  runtimeSummary(input: { actor: Actor; agentId: string }): Omit<AgentRuntimeConfigRow, "secret_envelope"> | null {
    const actor = this.authorizeActor(input.actor);
    this.requireOwnedAgent(input.agentId, actor.id);
    const row = this.ctx.storage.sql.exec<AgentRuntimeConfigRow>("SELECT * FROM agent_runtime_configs WHERE agent_id = ?", input.agentId).toArray()[0];
    if (!row) return null;
    const { secret_envelope: _secret, ...summary } = row;
    return summary;
  }

  async createClaudeSchedule(input: {
    actor: Actor; agentId: string; cron: string; timezone: string; budgetCents: number; now: number;
  }): Promise<{ deploymentId: string; upcomingRunsAt: readonly string[] }> {
    const actor = this.authorizeActor(input.actor);
    this.requireOwnedAgent(input.agentId, actor.id);
    const config = this.requireRuntimeConfig(input.agentId, "claude_cloud");
    if (config.status !== "active") throw new Error("cloud runtime setup is not complete");
    if (!Number.isSafeInteger(input.budgetCents) || input.budgetCents < 1) throw new Error("scheduled runs need a positive budget");
    const schedule = validateProviderSchedule(input.cron, input.timezone);
    const accessToken = await this.providerAccessToken(config, input.now);
    const response = await callManagedAgents({ accessToken, path: "/v1/deployments", body: {
      agent_id: config.provider_agent_id, environment_id: config.provider_environment_id,
      schedule: { cron: schedule.cron, timezone: schedule.timezone },
      budget: { amount: String(input.budgetCents), currency: "USD" },
    } });
    if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("unknown deployment response");
    const resource = response as Record<string, unknown>;
    if (typeof resource.id !== "string") throw new Error("unknown deployment response");
    const upcomingRunsAt = Array.isArray(resource.upcoming_runs_at)
      ? resource.upcoming_runs_at.filter((value): value is string => typeof value === "string").slice(0, 100) : [];
    this.ctx.storage.sql.exec(
      "UPDATE agent_runtime_configs SET provider_deployment_id = ?, budget_cents = ?, updated_at = ? WHERE agent_id = ?",
      resource.id, input.budgetCents, input.now, input.agentId,
    );
    return { deploymentId: resource.id, upcomingRunsAt };
  }

  async startManualClaudeRun(input: {
    actor: Actor; agentId: string; delegationId?: string | null; budgetCents: number; now: number;
  }): Promise<{ runId: string; providerRunId: string }> {
    const actor = this.authorizeActor(input.actor);
    this.requireOwnedAgent(input.agentId, actor.id);
    const config = this.requireRuntimeConfig(input.agentId, "claude_cloud");
    if (config.status !== "active" || !config.provider_deployment_id) throw new Error("cloud deployment is not configured");
    if (!Number.isSafeInteger(input.budgetCents) || input.budgetCents < 1) throw new Error("manual runs need a positive budget");
    const accessToken = await this.providerAccessToken(config, input.now);
    const response = await callManagedAgents({ accessToken,
      path: `/v1/deployments/${config.provider_deployment_id}/runs`, body: {
        budget: { amount: String(input.budgetCents), currency: "USD" },
      } });
    if (!response || typeof response !== "object" || Array.isArray(response) || typeof (response as Record<string, unknown>).id !== "string") {
      throw new Error("unknown deployment run response");
    }
    const providerRunId = (response as Record<string, unknown>).id as string;
    const runId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO runtime_runs(id, agent_id, kind, delegation_id, provider_deployment_run_id, budget_cents,
         state, created_at, updated_at) VALUES (?, ?, 'manual', ?, ?, ?, 'running', ?, ?)`,
      runId, input.agentId, input.delegationId ?? null, providerRunId, input.budgetCents, input.now, input.now,
    );
    return { runId, providerRunId };
  }

  async updateClaudeSessionBudget(input: {
    actor: Actor; runId: string; nextBudgetCents: number | null; consumedCents: number; now: number;
  }): Promise<{ budgetCents: number | null }> {
    const actor = this.authorizeActor(input.actor);
    const run = this.ctx.storage.sql.exec<{ agent_id: string; provider_session_id: string | null; budget_cents: number | null }>(
      "SELECT agent_id, provider_session_id, budget_cents FROM runtime_runs WHERE id = ?", input.runId,
    ).toArray()[0];
    if (!run?.provider_session_id) throw new Error("cloud session run does not exist");
    this.requireOwnedAgent(run.agent_id, actor.id);
    const next = validateBudgetChange(run.budget_cents, input.nextBudgetCents, input.consumedCents);
    const config = this.requireRuntimeConfig(run.agent_id, "claude_cloud");
    const accessToken = await this.providerAccessToken(config, input.now);
    await callManagedAgents({ accessToken, method: "PATCH", path: `/v1/sessions/${run.provider_session_id}`,
      body: { budget: next === null ? null : { amount: String(next), currency: "USD" } } });
    this.ctx.storage.sql.exec("UPDATE runtime_runs SET budget_cents = ?, updated_at = ? WHERE id = ?", next, input.now, input.runId);
    return { budgetCents: next };
  }

  /* ------------------------------------------------------------------ */
  /* The runtime configuration surface (R05)                             */
  /* ------------------------------------------------------------------ */

  /**
   * Pick a runtime that needs no provider behind it.
   *
   * `connected` and `local` are the two an owner can choose outright, so they
   * are the two this method takes. `claude_cloud` and `custom` arrive through
   * their own configure methods, because neither is a choice until the thing it
   * points at has been proved to exist — and offering them as a radio button
   * that silently does nothing is how a half-configured integration gets built.
   *
   * Moving away from a cloud or custom runtime drops that runtime's provider
   * identifiers and its transport secret in the same write. Leaving them behind
   * would keep a webhook route alive for a runtime nobody is using.
   */
  async selectAgentRuntime(input: {
    actor: Actor;
    agentId: string;
    kind: SelfServeRuntimeKind;
    now: number;
  }): Promise<{ kind: SelfServeRuntimeKind }> {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    if (input.kind !== "connected" && input.kind !== "local") throw new Error("unknown runtime");
    const previous = this.readRuntimeConfig(agent.id);

    await this.commitMutation({ scope: "agent.runtime.select", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        `INSERT INTO agent_runtime_configs(agent_id, kind, status, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET kind = excluded.kind, status = 'active',
           organization_id = NULL, provider_workspace_id = NULL, provider_agent_id = NULL,
           provider_environment_id = NULL, provider_deployment_id = NULL, wif_issuer = NULL,
           wif_audience = NULL, wif_subject = NULL, service_account_id = NULL,
           federation_rule_id = NULL, callback_url = NULL, secret_envelope = NULL,
           budget_cents = NULL, resource_proved_at = NULL, webhook_proved_at = NULL,
           wif_failures = 0, updated_at = excluded.updated_at`,
        agent.id, input.kind, input.now, input.now,
      );
      return {
        result: undefined,
        effects: this.agentEffects("agent.runtime_selected", agent, actor, {
          runtime_kind: input.kind,
          previous_kind: previous?.kind ?? "none",
        }),
      };
    });

    // A machine that was answering for an agent whose runtime has moved
    // elsewhere finds out now, rather than starting a harness for work that
    // will never be routed to it again.
    if (input.kind !== "local" && previous?.kind === "local") {
      this.stopRunnersForAgent(agent.id, "runtime_changed");
    }
    if (previous !== null && previous.kind !== input.kind && previous.kind === "claude_cloud") {
      await this.forgetRuntimeWebhookRoute(previous);
    }
    return { kind: input.kind };
  }

  /**
   * Who may cause a process to start on somebody's computer.
   *
   * This is cloud authority and it belongs here, because it decides what the
   * workspace *sends*: whether a mention produces a wake at all, and whose
   * mention counts. It is not launch configuration and it deliberately reads
   * nothing about one — the machine still decides what runs, how often and for
   * how long, and it can refuse a wake this setting allowed.
   */
  async setLocalRuntimePolicy(input: {
    actor: Actor;
    agentId: string;
    startOnMention: boolean;
    whoMayStart: LocalStartPolicy;
    now: number;
  }): Promise<{ startOnMention: boolean; whoMayStart: LocalStartPolicy }> {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    if (typeof input.startOnMention !== "boolean") throw new Error("start on mention is invalid");
    if (!isLocalStartPolicy(input.whoMayStart)) throw new Error("unknown start policy");

    await this.commitMutation({ scope: "agent.runtime.local_policy", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        `INSERT INTO agent_local_policies(agent_id, start_on_mention, who_may_start, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET start_on_mention = excluded.start_on_mention,
           who_may_start = excluded.who_may_start, updated_at = excluded.updated_at`,
        agent.id, input.startOnMention ? 1 : 0, input.whoMayStart, input.now,
      );
      return {
        result: undefined,
        effects: this.agentEffects("agent.runtime_local_policy_set", agent, actor, {
          start_on_mention: input.startOnMention,
          who_may_start: input.whoMayStart,
        }),
      };
    });
    return { startOnMention: input.startOnMention, whoMayStart: input.whoMayStart };
  }

  /**
   * Ask the machine to look at its own launch configuration.
   *
   * This is the entire remote authority over a local preset, and it is an ask
   * rather than a change: an intent from a closed set, addressed to the device
   * that already answers for this agent, with no field for a path, an argument,
   * a limit or a note. It stays pending — visibly — until that machine reports
   * a preset revision higher than the one it had when the ask was made, which
   * is the only evidence available here that a person was physically at that
   * computer and completed the operating-system verification the change needs.
   */
  async requestLocalPresetChange(input: {
    actor: Actor;
    agentId: string;
    intent: LocalPresetIntent;
    now: number;
  }): Promise<{ requestId: string; state: "pending"; deviceId: string }> {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    if (!isLocalPresetIntent(input.intent)) throw new Error("unknown local preset intent");
    const assignment = this.ctx.storage.sql
      .exec<{ device_id: string }>("SELECT device_id FROM runner_agents WHERE agent_id = ?", agent.id)
      .toArray()[0];
    if (assignment === undefined) throw new Error("no machine answers for this agent");
    const device = this.readRunnerDevice(assignment.device_id);
    if (device === null) throw new Error("no machine answers for this agent");

    const existing = this.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM runner_preset_requests
         WHERE agent_id = ? AND device_id = ? AND intent = ? AND state = 'pending'`,
        agent.id, device.device_id, input.intent,
      )
      .toArray()[0];
    // Asking twice is one ask. A second row would show the same machine two
    // identical pending items and neither would clear before the other.
    if (existing !== undefined) return { requestId: existing.id, state: "pending", deviceId: device.device_id };

    const requestId = crypto.randomUUID();
    await this.commitMutation({ scope: "agent.runtime.preset_request", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        `INSERT INTO runner_preset_requests(id, agent_id, device_id, intent, requested_by_member_id,
           revision_at_request, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        requestId, agent.id, device.device_id, input.intent, actor.id, device.preset_revision, input.now,
      );
      return {
        result: undefined,
        effects: this.agentEffects("agent.local_preset_requested", agent, actor, {
          request_id: requestId,
          device_id: device.device_id,
          intent: input.intent,
          revision_at_request: device.preset_revision,
        }),
      };
    });
    return { requestId, state: "pending", deviceId: device.device_id };
  }

  /** Take an ask back. The machine may already have acted; that is fine. */
  async withdrawLocalPresetChange(input: {
    actor: Actor;
    requestId: string;
    now: number;
  }): Promise<{ withdrawn: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const row = this.ctx.storage.sql
      .exec<{ agent_id: string }>("SELECT agent_id FROM runner_preset_requests WHERE id = ?", input.requestId)
      .toArray()[0];
    if (row === undefined) throw new Error("that request does not exist");
    const agent = this.requireOwnedAgent(row.agent_id, actor.id);
    const outcome = await this.commitMutation({ scope: "agent.runtime.preset_withdraw", now: input.now }, () => {
      const changed = this.ctx.storage.sql.exec(
        `UPDATE runner_preset_requests SET state = 'withdrawn', resolved_at = ?
         WHERE id = ? AND state = 'pending'`,
        input.now, input.requestId,
      );
      return {
        result: { withdrawn: changed.rowsWritten > 0 },
        effects: changed.rowsWritten > 0
          ? this.agentEffects("agent.local_preset_withdrawn", agent, actor, { request_id: input.requestId })
          : undefined,
      };
    });
    return outcome.result;
  }

  /**
   * Start a session by hand.
   *
   * The wake it records is the same wake a mention produces — an agent id and
   * nothing else — so this button cannot do anything a mention could not. It
   * exists because "start on mention" being off has to leave a way to work, and
   * because it is the honest test of a runner somebody has just set up.
   */
  async startLocalRuntimeNow(input: {
    actor: Actor;
    agentId: string;
    now: number;
  }): Promise<{ deviceId: string; delivered: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    if (agent.status !== "active") throw new Error("agent is not active");
    const config = this.readRuntimeConfig(agent.id);
    if (config !== null && config.kind !== "local") throw new Error("this agent does not run locally");
    const assignment = this.ctx.storage.sql
      .exec<{ device_id: string }>("SELECT device_id FROM runner_agents WHERE agent_id = ?", agent.id)
      .toArray()[0];
    if (assignment === undefined) throw new Error("no machine answers for this agent");

    await this.commitMutation({ scope: "agent.runtime.start", now: input.now }, () => {
      this.recordRunnerWake(agent.id, input.now);
      return {
        result: undefined,
        effects: this.agentEffects("agent.runtime_start_requested", agent, actor, {
          device_id: assignment.device_id,
        }),
      };
    });
    return {
      deviceId: assignment.device_id,
      delivered: this.ctx.getWebSockets(runnerSocketTag(assignment.device_id)).length > 0,
    };
  }

  /**
   * Stop whatever this agent has running, everywhere.
   *
   * Every live session for the agent is revoked in one transaction and the
   * machine is told, so a harness that is mid-run finds out rather than
   * finishing the work anyway. The durable half is the revocation: the next
   * bounded call the harness makes is refused whether or not the frame landed,
   * which is what makes this work when the socket is the thing that is wrong.
   */
  async stopAgentRuntime(input: {
    actor: Actor;
    agentId: string;
    reason?: string | null;
    now: number;
  }): Promise<{ sessionsStopped: number }> {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    const reason = (input.reason ?? "owner_stopped").slice(0, 200);
    const outcome = await this.commitMutation({ scope: "agent.runtime.stop", now: input.now }, () => {
      // Counted before the write rather than from `rowsWritten`, which includes
      // index entries and would report a number nobody could explain.
      const live = this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM agent_sessions WHERE agent_id = ? AND revoked_at IS NULL", agent.id,
        )
        .one().count;
      this.ctx.storage.sql.exec(
        `UPDATE agent_sessions SET revoked_at = ?, revoked_reason = ?
         WHERE agent_id = ? AND revoked_at IS NULL`,
        input.now, reason, agent.id,
      );
      // A wake nobody has collected must not outlive the stop that overtook it.
      this.ctx.storage.sql.exec("DELETE FROM runner_wakes WHERE agent_id = ?", agent.id);
      return {
        result: { sessionsStopped: live },
        effects: this.agentEffects("agent.runtime_stopped", agent, actor, {
          sessions_stopped: live,
          reason,
        }),
      };
    });
    this.stopRunnersForAgent(agent.id, reason);
    return outcome.result;
  }

  /**
   * Re-affirm a delegation that is about to expire.
   *
   * One click, and it is deliberately not automatic: an agent running unattended
   * for a year on a permission somebody granted in a hurry is the failure the
   * expiry exists to prevent, and a renewal nobody performs is the same thing
   * with extra steps. The owner's authority is re-checked here, so a delegation
   * made by somebody who has since lost access cannot be extended.
   */
  async reaffirmAgentDelegation(input: {
    actor: Actor;
    delegationId: string;
    expiresAt: number;
    now: number;
  }): Promise<{ expiresAt: number }> {
    const actor = this.authorizeActor(input.actor);
    const delegation = this.requireLiveDelegation(input.delegationId, input.now);
    if (delegation.ownerMemberId !== actor.id) throw new Error("delegation not found");
    const agent = this.requireOwnedAgent(delegation.agentId, actor.id);
    if (!validDelegationExpiry(input.now, input.expiresAt)) throw new Error("delegation expiry is invalid");
    if (input.expiresAt <= delegation.expiresAt) throw new Error("that is not later than the current expiry");

    await this.commitMutation({ scope: "agent.delegation.reaffirm", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        "UPDATE agent_delegations SET expires_at = ? WHERE id = ? AND revoked_at IS NULL",
        input.expiresAt, delegation.id,
      );
      return {
        result: undefined,
        effects: this.agentEffects("agent.delegation_reaffirmed", agent, actor, {
          delegation_id: delegation.id,
          previous_expires_at: delegation.expiresAt,
          expires_at: input.expiresAt,
        }),
      };
    });
    return { expiresAt: input.expiresAt };
  }

  /**
   * Everything the runtime screen shows, in one authorized read.
   *
   * Only an owner sees it, because everything on it — which machine, which
   * delegation, which credentials, what failed — is the configuration of
   * somebody's own computer and somebody's own authority. What it can never
   * carry is what that machine runs: there is no field here for an executable,
   * an argument, a directory, an environment value or a limit, and the preset
   * appears as the name and revision the machine itself reported.
   */
  describeAgentRuntime(input: { actor: Actor; agentId: string; now: number }): AgentRuntimeView {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    const config = this.readRuntimeConfig(agent.id);
    const kind: RuntimeKind = config?.kind ?? "connected";

    const policy = this.ctx.storage.sql
      .exec<{ start_on_mention: number; who_may_start: LocalStartPolicy }>(
        "SELECT start_on_mention, who_may_start FROM agent_local_policies WHERE agent_id = ?", agent.id,
      )
      .toArray()[0];

    const assignment = this.ctx.storage.sql
      .exec<{ device_id: string; preset_id: string; assigned_at: number }>(
        "SELECT device_id, preset_id, assigned_at FROM runner_agents WHERE agent_id = ?", agent.id,
      )
      .toArray()[0];
    const device = assignment === undefined ? null : this.readRunnerDevice(assignment.device_id);

    const queue = this.ctx.storage.sql
      .exec<{ waiting: number; attention: number }>(
        `SELECT
           SUM(CASE WHEN execution_state IN ('pending', 'claimed') THEN 1 ELSE 0 END) AS waiting,
           SUM(CASE WHEN execution_state = 'needs_attention' THEN 1 ELSE 0 END) AS attention
         FROM agent_queue WHERE agent_id = ?`,
        agent.id,
      )
      .one();

    const requests = this.ctx.storage.sql
      .exec<{
        id: string; intent: LocalPresetIntent; requested_by_member_id: string;
        revision_at_request: number; state: "pending" | "confirmed" | "withdrawn";
        created_at: number; resolved_at: number | null; resolved_revision: number | null;
      }>(
        `SELECT id, intent, requested_by_member_id, revision_at_request, state, created_at,
                resolved_at, resolved_revision
         FROM runner_preset_requests WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20`,
        agent.id,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        intent: row.intent,
        requestedByHandle: this.memberHandle(row.requested_by_member_id),
        revisionAtRequest: row.revision_at_request,
        // Pending is the honest default. A request whose machine has since
        // moved its revision on is only reported confirmed once that machine
        // has actually said so through a signed registration.
        state: row.state,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
        resolvedRevision: row.resolved_revision,
      }));

    const delegationRow = this.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM agent_delegations
         WHERE agent_id = ? AND revoked_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`,
        agent.id, input.now,
      )
      .toArray()[0];
    const delegation = delegationRow === undefined ? null : this.readAgentDelegation(delegationRow.id);

    const sessions = this.ctx.storage.sql
      .exec<{
        id: string; device_id: string; preset_revision: number; created_at: number;
        hard_expires_at: number; last_used_at: number | null; revoked_at: number | null;
        revoked_reason: string | null;
      }>(
        `SELECT id, device_id, preset_revision, created_at, hard_expires_at, last_used_at,
                revoked_at, revoked_reason
         FROM agent_sessions WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20`,
        agent.id,
      )
      .toArray()
      .map((row) => ({
        sessionId: row.id,
        deviceId: row.device_id,
        presetRevision: row.preset_revision,
        startedAt: row.created_at,
        hardExpiresAt: row.hard_expires_at,
        lastUsedAt: row.last_used_at,
        endedAt: row.revoked_at,
        endedReason: row.revoked_reason,
        live: row.revoked_at === null && row.hard_expires_at > input.now,
      }));

    const runs = this.ctx.storage.sql
      .exec<{
        id: string; kind: "mention" | "scheduled" | "manual";
        state: "queued" | "starting" | "running" | "idle" | "succeeded" | "failed" | "terminated";
        failure_code: string | null; budget_cents: number | null;
        provider_session_id: string | null; created_at: number; updated_at: number;
      }>(
        `SELECT id, kind, state, failure_code, budget_cents, provider_session_id, created_at, updated_at
         FROM runtime_runs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20`,
        agent.id,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        state: row.state,
        failureCode: row.failure_code,
        budgetCents: row.budget_cents,
        hasProviderSession: row.provider_session_id !== null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

    const deliveries = this.ctx.storage.sql
      .exec<{ delivery_id: string; state: "pending" | "delivered" | "dead"; attempts: number; last_error: string | null; created_at: number }>(
        `SELECT delivery_id, state, attempts, last_error, created_at
         FROM custom_runtime_deliveries WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20`,
        agent.id,
      )
      .toArray()
      .map((row) => ({
        deliveryId: row.delivery_id,
        state: row.state,
        attempts: row.attempts,
        // Bounded, and it came from a remote endpoint, so it is shown as a note
        // and never as anything the page trusts.
        lastError: row.last_error === null ? null : row.last_error.slice(0, 200),
        createdAt: row.created_at,
      }));

    return {
      agentId: agent.id,
      handle: agent.handle,
      agentStatus: agent.status,
      kind,
      chosen: config !== null,
      providerStatus: config?.status ?? null,
      local: {
        startOnMention: policy === undefined ? true : policy.start_on_mention === 1,
        whoMayStart: policy?.who_may_start ?? "scope",
        device:
          device === null || assignment === undefined
            ? null
            : {
                deviceId: device.device_id,
                presetId: assignment.preset_id,
                presetRevision: device.preset_revision,
                runnerEpoch: device.runner_epoch,
                connected: this.ctx.getWebSockets(runnerSocketTag(device.device_id)).length > 0,
                lastSeenAt: device.last_seen_at,
                assignedAt: assignment.assigned_at,
              },
        waiting: queue.waiting ?? 0,
        needsAttention: queue.attention ?? 0,
        presetRequests: requests,
      },
      cloud:
        config === null || config.kind !== "claude_cloud"
          ? null
          : {
              organizationId: config.organization_id,
              providerWorkspaceId: config.provider_workspace_id,
              providerAgentId: config.provider_agent_id,
              providerEnvironmentId: config.provider_environment_id,
              providerDeploymentId: config.provider_deployment_id,
              wifSubject: config.wif_subject,
              wifAudience: config.wif_audience,
              budgetCents: config.budget_cents,
              resourceProvedAt: config.resource_proved_at,
              webhookProvedAt: config.webhook_proved_at,
              wifFailures: config.wif_failures,
            },
      custom:
        config === null || config.kind !== "custom" || config.callback_url === null
          ? null
          : { callbackUrl: config.callback_url, deliveries },
      delegation:
        delegation === null
          ? null
          : {
              id: delegation.id,
              ownerHandle: this.memberHandle(delegation.ownerMemberId),
              channelNames:
                delegation.channelIds === null
                  ? null
                  : delegation.channelIds.map((channelId) => readChannel(this.ctx.storage, channelId)?.slug ?? channelId),
              credentialNames: delegation.credentialIds.map((credentialId) => this.vaultCredentialName(credentialId)),
              expiresAt: delegation.expiresAt,
              spendCapDailyCents: delegation.spendCapDailyCents,
              deliveryModes: delegation.deliveryModes,
              sentence: delegationSentence({
                ownerHandle: this.memberHandle(delegation.ownerMemberId),
                channelNames:
                  delegation.channelIds === null
                    ? null
                    : delegation.channelIds.map((channelId) => readChannel(this.ctx.storage, channelId)?.slug ?? channelId),
                credentialNames: delegation.credentialIds.map((credentialId) => this.vaultCredentialName(credentialId)),
                expiresAt: delegation.expiresAt,
                spendCapDailyCents: delegation.spendCapDailyCents,
              }),
            },
      sessions,
      runs,
    };
  }

  /** The cloud half of "may this mention start a process on that machine". */
  private localStartDecision(agentId: string, requesterMemberId: string) {
    const policy = this.ctx.storage.sql
      .exec<{ start_on_mention: number; who_may_start: LocalStartPolicy }>(
        "SELECT start_on_mention, who_may_start FROM agent_local_policies WHERE agent_id = ?", agentId,
      )
      .toArray()[0];
    return decideLocalStart({
      startOnMention: policy === undefined ? true : policy.start_on_mention === 1,
      whoMayStart: policy?.who_may_start ?? "scope",
      requesterMemberId,
      ownerMemberIds: agentOwnerIds(this.ctx.storage, agentId),
    });
  }

  private readRuntimeConfig(agentId: string): AgentRuntimeConfigRow | null {
    return (
      this.ctx.storage.sql
        .exec<AgentRuntimeConfigRow>("SELECT * FROM agent_runtime_configs WHERE agent_id = ?", agentId)
        .toArray()[0] ?? null
    );
  }

  private vaultCredentialName(credentialId: string): string {
    return (
      this.ctx.storage.sql
        .exec<{ name: string }>("SELECT name FROM vault_credentials WHERE id = ?", credentialId)
        .toArray()[0]?.name ?? credentialId
    );
  }

  /** A workspace that stops using a cloud runtime stops owning its webhook route. */
  private async forgetRuntimeWebhookRoute(config: AgentRuntimeConfigRow): Promise<void> {
    if (!this.env.CONTROL_DB || config.organization_id === null || config.provider_workspace_id === null) return;
    // Only if no other agent in this workspace still uses that provider pair.
    const remaining = this.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM agent_runtime_configs
         WHERE kind = 'claude_cloud' AND organization_id = ? AND provider_workspace_id = ?`,
        config.organization_id, config.provider_workspace_id,
      )
      .one().count;
    if (remaining > 0) return;
    await this.env.CONTROL_DB.prepare(
      "DELETE FROM runtime_webhook_routes WHERE organization_id = ? AND provider_workspace_id = ? AND durable_object_id = ?",
    ).bind(config.organization_id, config.provider_workspace_id, this.workspaceKey()).run();
  }

  /**
   * Answer the pending asks this registration confirms.
   *
   * Called from `registerRunner`, inside its transaction: the machine has just
   * signed for a preset revision, and every ask made against a lower one has
   * been answered by whatever the person at that computer did. Nothing here
   * reads what changed, only that the machine's own counter moved.
   */
  private confirmLocalPresetRequests(deviceId: string, presetRevision: number, now: number): number {
    const pending = this.ctx.storage.sql
      .exec<{ id: string; revision_at_request: number }>(
        "SELECT id, revision_at_request FROM runner_preset_requests WHERE device_id = ? AND state = 'pending'",
        deviceId,
      )
      .toArray()
      .filter((row) =>
        localPresetRequestIsConfirmed({ revisionAtRequest: row.revision_at_request, currentRevision: presetRevision }),
      );
    for (const row of pending) {
      this.ctx.storage.sql.exec(
        "UPDATE runner_preset_requests SET state = 'confirmed', resolved_at = ?, resolved_revision = ? WHERE id = ?",
        now, presetRevision, row.id,
      );
    }
    return pending.length;
  }

  /** What this device still owes a person, reported where it already asks for work. */
  private pendingLocalPresetIntents(deviceId: string, agentId: string): readonly LocalPresetIntent[] {
    return this.ctx.storage.sql
      .exec<{ intent: LocalPresetIntent }>(
        `SELECT intent FROM runner_preset_requests
         WHERE device_id = ? AND agent_id = ? AND state = 'pending' ORDER BY created_at`,
        deviceId, agentId,
      )
      .toArray()
      .map((row) => row.intent);
  }

  /** Owners are the agent's accountable humans, so only an owner may add one. */
  async addAgentOwner(input: {
    actor: Actor;
    agentId: string;
    memberId: string;
    now: number;
  }): Promise<{ added: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    if (this.resolveActiveMemberIds([input.memberId]).length !== 1) {
      throw new Error("member is not active in this workspace");
    }

    const outcome = await this.commitMutation({ scope: "agent.add_owner", now: input.now }, () => {
      const result = this.ctx.storage.sql.exec(
        `INSERT INTO agent_owners(agent_id, member_id, added_by_member_id, added_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(agent_id, member_id) DO NOTHING`,
        agent.id,
        input.memberId,
        actor.id,
        input.now,
      );
      if (result.rowsWritten === 0) return { result: { added: false } };
      return {
        result: { added: true },
        effects: this.agentEffects("agent.owner_added", agent, actor, {
          subject_member_id: input.memberId,
        }),
      };
    });
    return outcome.result;
  }

  /**
   * Remove an owner, unless they are the last one.
   *
   * The database enforces this too, but refusing here means the caller gets a
   * sentence rather than a constraint violation.
   */
  async removeAgentOwner(input: {
    actor: Actor;
    agentId: string;
    memberId: string;
    now: number;
  }): Promise<{ removed: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    const owners = agentOwnerIds(this.ctx.storage, agent.id);
    if (!owners.includes(input.memberId)) return { removed: false };
    if (!mayRemoveOwner(owners, input.memberId)) {
      throw new Error("an agent must keep at least one owner");
    }

    const outcome = await this.commitMutation({ scope: "agent.remove_owner", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        `UPDATE agent_sessions SET revoked_at = ?, revoked_reason = 'owner_removed'
         WHERE delegation_id IN (
           SELECT id FROM agent_delegations WHERE agent_id = ? AND owner_member_id = ?
         ) AND revoked_at IS NULL`,
        input.now,
        agent.id,
        input.memberId,
      );
      this.ctx.storage.sql.exec(
        `UPDATE agent_delegations SET revoked_at = ?, revoked_reason = 'owner_removed'
         WHERE agent_id = ? AND owner_member_id = ? AND revoked_at IS NULL`,
        input.now,
        agent.id,
        input.memberId,
      );
      this.revokeVaultGrants("agent_owner_removed", input.now, "agent_id = ? AND member_id = ?", agent.id, input.memberId);
      this.ctx.storage.sql.exec(
        "DELETE FROM agent_owners WHERE agent_id = ? AND member_id = ?",
        agent.id,
        input.memberId,
      );
      return {
        result: { removed: true },
        effects: this.agentEffects("agent.owner_removed", agent, actor, {
          subject_member_id: input.memberId,
        }),
      };
    });
    return outcome.result;
  }

  /** The brief is tier two. Owners write it; the ceiling above it is not theirs. */
  async setAgentBrief(input: {
    actor: Actor;
    agentId: string;
    prompt: string | null;
    now: number;
  }): Promise<{ prompt: string | null }> {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    const prompt = parseAgentBrief(input.prompt);

    const outcome = await this.commitMutation({ scope: "agent.set_brief", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        "UPDATE agents SET prompt = ?, updated_at = ? WHERE id = ?",
        prompt,
        input.now,
        agent.id,
      );
      return {
        result: { prompt },
        // The brief's length is recorded; its text is not, because an audit
        // record outlives the thing it describes.
        effects: this.agentEffects("agent.brief_set", agent, actor, {
          brief_length: prompt?.length ?? 0,
        }),
      };
    });
    return outcome.result;
  }

  /**
   * Set the agent's scope.
   *
   * There is deliberately no path to this from an agent's own tools: a boundary
   * an agent can widen is advisory. Only an owner, acting as themselves, may
   * change it, and only to rooms that owner can actually reach.
   */
  async setAgentScope(input: {
    actor: Actor;
    agentId: string;
    mode: "any" | "listed";
    channelIds?: readonly string[];
    now: number;
  }): Promise<{ mode: "any" | "listed"; channelIds: readonly string[] }> {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    const mode: "any" | "listed" = input.mode === "listed" ? "listed" : "any";
    const channelIds = mode === "listed" ? this.resolveScopeChannels(input.channelIds ?? [], actor.id) : [];

    const outcome = await this.commitMutation({ scope: "agent.set_scope", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        "UPDATE agents SET scope_mode = ?, updated_at = ? WHERE id = ?",
        mode,
        input.now,
        agent.id,
      );
      replaceAgentScope(this.ctx.storage, agent.id, channelIds, input.now);
      return {
        result: { mode, channelIds },
        effects: this.agentEffects("agent.scope_set", agent, actor, {
          scope_mode: mode,
          scope_size: channelIds.length,
        }),
      };
    });
    return outcome.result;
  }

  async setAgentStatus(input: {
    actor: Actor;
    agentId: string;
    status: "active" | "paused" | "archived";
    now: number;
  }): Promise<{ status: string }> {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    if (!["active", "paused", "archived"].includes(input.status)) throw new Error("unknown agent status");

    const outcome = await this.commitMutation({ scope: "agent.set_status", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        "UPDATE agents SET status = ?, updated_at = ? WHERE id = ?",
        input.status,
        input.now,
        agent.id,
      );
      if (input.status !== "active") {
        this.ctx.storage.sql.exec(
          `UPDATE agent_sessions SET revoked_at = ?, revoked_reason = 'agent_status_changed'
           WHERE agent_id = ? AND revoked_at IS NULL`,
          input.now,
          agent.id,
        );
        this.revokeVaultGrants("agent_status_changed", input.now, "agent_id = ?", agent.id);
      }
      return {
        result: { status: input.status },
        effects: this.agentEffects("agent.status_set", agent, actor, { agent_status: input.status }),
      };
    });
    // A machine that is mid-session finds out, rather than finishing the work
    // anyway. The durable half of the stop is that the agent's next bounded
    // call is refused; this is the half that arrives without waiting for one.
    if (input.status !== "active") this.stopRunnersForAgent(agent.id, `agent_${input.status}`);
    return outcome.result;
  }

  /* ------------------------------------------------------------------ */
  /* Delegations and scoped runner sessions (A04)                        */
  /* ------------------------------------------------------------------ */

  async createAgentDelegation(input: {
    actor: Actor;
    agent: string;
    channelIds?: readonly string[] | null;
    credentialIds?: readonly string[];
    deliveryModes?: readonly string[];
    projectIds?: readonly string[];
    spendCapDailyCents?: number | null;
    spendCapMonthlyCents?: number | null;
    rateLimitPerHour?: number | null;
    expiresAt: number;
    now: number;
  }): Promise<AgentDelegation> {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgentArgument(input.agent, actor.id);
    if (agent.status !== "active") throw new Error("agent is not active");
    if (!validDelegationExpiry(input.now, input.expiresAt)) throw new Error("delegation expiry is invalid");

    const channelIds = normalizeBoundedIds(input.channelIds, { nullable: true });
    if (channelIds !== null) {
      for (const channelId of channelIds) {
        this.requireVisibleChannel(channelId, actor.id);
        if (!agentMayPostIn({ agentStatus: agent.status, scope: this.agentScope(agent), channelId })) {
          throw new Error("delegation channel is outside the agent scope");
        }
      }
    }
    const credentialIds = normalizeBoundedIds(input.credentialIds, { nullable: false }) as readonly string[];
    const projectIds = normalizeBoundedIds(input.projectIds, { nullable: false }) as readonly string[];
    const deliveryModes = normalizeBoundedIds(input.deliveryModes, { nullable: false, maximum: 8 }) as readonly string[];
    if (deliveryModes.some((mode) => !["inject", "file", "device_proxy"].includes(mode))) {
      throw new Error("delegation delivery mode is invalid");
    }
    for (const value of [input.spendCapDailyCents, input.spendCapMonthlyCents]) {
      if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error("delegation spend cap is invalid");
      }
    }
    if (
      input.rateLimitPerHour !== undefined &&
      input.rateLimitPerHour !== null &&
      (!Number.isSafeInteger(input.rateLimitPerHour) || input.rateLimitPerHour <= 0)
    ) {
      throw new Error("delegation rate limit is invalid");
    }

    const id = crypto.randomUUID();
    const delegation: AgentDelegation = {
      id,
      agentId: agent.id,
      ownerMemberId: actor.id,
      ownerAuthorizationEpoch: input.actor.authorizationEpoch,
      channelIds,
      credentialIds,
      deliveryModes,
      projectIds,
      spendCapDailyCents: input.spendCapDailyCents ?? null,
      spendCapMonthlyCents: input.spendCapMonthlyCents ?? null,
      rateLimitPerHour: input.rateLimitPerHour ?? null,
      createdAt: input.now,
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    await this.commitMutation({ scope: "agent.delegation.create", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        `INSERT INTO agent_delegations(
           id, agent_id, owner_member_id, owner_authorization_epoch, channel_ids_json,
           credential_ids_json, delivery_modes_json, project_ids_json,
           spend_cap_daily_cents, spend_cap_monthly_cents, rate_limit_per_hour,
           created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        agent.id,
        actor.id,
        input.actor.authorizationEpoch,
        channelIds === null ? null : JSON.stringify(channelIds),
        JSON.stringify(credentialIds),
        JSON.stringify(deliveryModes),
        JSON.stringify(projectIds),
        delegation.spendCapDailyCents,
        delegation.spendCapMonthlyCents,
        delegation.rateLimitPerHour,
        input.now,
        input.expiresAt,
      );
      return {
        result: undefined,
        effects: this.agentEffects("agent.delegation_created", agent, actor, {
          delegation_id: id,
          expires_at: input.expiresAt,
          channel_count: channelIds?.length ?? -1,
          project_count: projectIds.length,
        }),
      };
    });
    return delegation;
  }

  async revokeAgentDelegation(input: {
    actor: Actor;
    delegationId: string;
    reason?: string | null;
    now: number;
  }): Promise<{ revoked: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const delegation = this.readAgentDelegation(input.delegationId);
    if (delegation === null) throw new Error("delegation not found");
    const agent = this.requireOwnedAgent(delegation.agentId, actor.id);
    const reason = (input.reason ?? "owner_revoked").slice(0, 200);
    const outcome = await this.commitMutation({ scope: "agent.delegation.revoke", now: input.now }, () => {
      const changed = this.ctx.storage.sql.exec(
        `UPDATE agent_delegations SET revoked_at = ?, revoked_reason = ?
         WHERE id = ? AND revoked_at IS NULL`,
        input.now,
        reason,
        delegation.id,
      );
      if (changed.rowsWritten > 0) {
        this.ctx.storage.sql.exec(
          `UPDATE agent_sessions SET revoked_at = ?, revoked_reason = 'delegation_revoked'
           WHERE delegation_id = ? AND revoked_at IS NULL`,
          input.now,
          delegation.id,
        );
        this.revokeVaultGrants("delegation_revoked", input.now, "delegation_id = ?", delegation.id);
      }
      return {
        result: { revoked: changed.rowsWritten > 0 },
        effects: changed.rowsWritten > 0
          ? this.agentEffects("agent.delegation_revoked", agent, actor, { delegation_id: delegation.id, reason })
          : undefined,
      };
    });
    if (outcome.result.revoked) this.stopRunnersForAgent(agent.id, "delegation_revoked");
    return outcome.result;
  }

  async startAgentSession(input: {
    actor: Actor;
    delegationId: string;
    deviceId: string;
    runnerEpoch: number;
    presetRevision: number;
    capabilities: readonly string[];
    now: number;
  }): Promise<AgentSessionGrant> {
    const actor = this.authorizeActor(input.actor);
    const delegation = this.requireLiveDelegation(input.delegationId, input.now);
    if (delegation.ownerMemberId !== actor.id) throw new Error("delegation not found");
    const agent = this.requireOwnedAgent(delegation.agentId, actor.id);
    if (agent.status !== "active") throw new Error("agent is not active");
    if (input.deviceId.length === 0 || input.deviceId.length > 200) throw new Error("runner device is invalid");
    if (!Number.isSafeInteger(input.runnerEpoch) || input.runnerEpoch < 0) throw new Error("runner epoch is invalid");
    if (!Number.isSafeInteger(input.presetRevision) || input.presetRevision < 0) throw new Error("preset revision is invalid");
    const capabilities = normalizeSessionCapabilities(input.capabilities);
    const storedSlug = this.workspaceSlug();
    if (storedSlug === null) throw new Error("workspace is not initialized");
    const token = formatToken("st", storedSlug, randomSecret());
    const tokenHash = await hashSecret(token);
    // Everything below is re-read after the hashing yield so owner and
    // delegation authority cannot go stale before the transaction commits.
    const liveActor = this.authorizeActor(input.actor);
    const liveDelegation = this.requireLiveDelegation(input.delegationId, input.now);
    if (liveDelegation.ownerMemberId !== liveActor.id) throw new Error("delegation not found");
    const liveAgent = this.requireOwnedAgent(liveDelegation.agentId, liveActor.id);
    if (liveAgent.status !== "active") throw new Error("agent is not active");
    const hardExpiresAt = Math.min(input.now + SESSION_HARD_TTL_MS, liveDelegation.expiresAt);
    const tokenExpiresAt = sessionTokenExpiresAt({ now: input.now, sessionHardExpiresAt: hardExpiresAt, delegationExpiresAt: liveDelegation.expiresAt });
    const sessionId = crypto.randomUUID();

    await this.commitMutation({ scope: "agent.session.start", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        `UPDATE agent_sessions SET revoked_at = ?, revoked_reason = 'replaced'
         WHERE agent_id = ? AND revoked_at IS NULL`,
        input.now,
        liveAgent.id,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO agent_sessions(
           id, delegation_id, agent_id, owner_member_id, device_id, runner_epoch,
           preset_revision, capabilities_json, token_hash, token_expires_at,
           hard_expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sessionId,
        liveDelegation.id,
        liveAgent.id,
        liveActor.id,
        input.deviceId,
        input.runnerEpoch,
        input.presetRevision,
        JSON.stringify(capabilities),
        tokenHash,
        tokenExpiresAt,
        hardExpiresAt,
        input.now,
      );
      return {
        result: undefined,
        effects: this.agentEffects("agent.session_started", liveAgent, liveActor, {
          session_id: sessionId,
          delegation_id: liveDelegation.id,
          device_id: input.deviceId,
          runner_epoch: input.runnerEpoch,
          preset_revision: input.presetRevision,
          capability_count: capabilities.length,
          hard_expires_at: hardExpiresAt,
        }),
      };
    });
    return { sessionId, delegationId: liveDelegation.id, agentId: liveAgent.id, token, tokenExpiresAt, hardExpiresAt, capabilities };
  }

  async rotateAgentSessionToken(input: {
    sessionId: string;
    currentToken: string;
    agentId: string;
    ownerMemberId: string;
    delegationId: string;
    deviceId: string;
    runnerEpoch: number;
    presetRevision: number;
    now: number;
  }): Promise<AgentSessionGrant> {
    const currentHash = await hashSecret(input.currentToken);
    const session = this.requireLiveAgentSessionById(input.sessionId, input.now);
    this.requireExactAgentSessionTuple(session, input, currentHash);
    const delegation = this.requireLiveDelegation(session.delegationId, input.now);
    this.requireLiveSessionOwner(session, delegation);
    const storedSlug = this.workspaceSlug();
    if (storedSlug === null) throw new Error("workspace is not initialized");
    const token = formatToken("st", storedSlug, randomSecret());
    const tokenHash = await hashSecret(token);
    // Re-read after the second hashing yield, then rotate with a CAS on the old hash.
    const fresh = this.requireLiveAgentSessionById(input.sessionId, input.now);
    this.requireExactAgentSessionTuple(fresh, input, currentHash);
    const freshDelegation = this.requireLiveDelegation(fresh.delegationId, input.now);
    this.requireLiveSessionOwner(fresh, freshDelegation);
    const tokenExpiresAt = sessionTokenExpiresAt({ now: input.now, sessionHardExpiresAt: fresh.hardExpiresAt, delegationExpiresAt: freshDelegation.expiresAt });
    const changed = this.ctx.storage.sql.exec(
      `UPDATE agent_sessions SET token_hash = ?, token_expires_at = ?, rotation_count = rotation_count + 1
       WHERE id = ? AND revoked_at IS NULL`,
      tokenHash,
      tokenExpiresAt,
      fresh.id,
    );
    if (changed.rowsWritten === 0) throw new Error("stale session token");
    return { sessionId: fresh.id, delegationId: fresh.delegationId, agentId: fresh.agentId, token, tokenExpiresAt, hardExpiresAt: fresh.hardExpiresAt, capabilities: fresh.capabilities };
  }

  async stopAgentSession(input: { actor: Actor; sessionId: string; reason?: string | null; now: number }): Promise<{ stopped: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const session = this.readAgentSession(input.sessionId);
    if (session === null) throw new Error("session not found");
    const agent = this.requireOwnedAgent(session.agentId, actor.id);
    const reason = (input.reason ?? "owner_stopped").slice(0, 200);
    const outcome = await this.commitMutation({ scope: "agent.session.stop", now: input.now }, () => {
      const changed = this.ctx.storage.sql.exec(
        `UPDATE agent_sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL`,
        input.now,
        reason,
        session.id,
      );
      return {
        result: { stopped: changed.rowsWritten > 0 },
        effects: changed.rowsWritten > 0
          ? this.agentEffects("agent.session_stopped", agent, actor, {
              session_id: session.id,
              delegation_id: session.delegationId,
              reason,
            })
          : undefined,
      };
    });
    return outcome.result;
  }

  /** The directory: every live agent, its owners, its scope and its queue depth. */
  listAgents(input: { actor: Actor }): { agents: readonly AgentSummary[] } {
    const actor = this.authorizeActor(input.actor);
    const agents = listAgentRows(this.ctx.storage).map((agent) => {
      const ownerIds = agentOwnerIds(this.ctx.storage, agent.id);
      const scopeChannelIds = agentScopeChannelIds(this.ctx.storage, agent.id);
      return {
        id: agent.id,
        handle: agent.handle,
        displayName: agent.displayName,
        description: agent.description,
        status: agent.status,
        scopeMode: agent.scopeMode,
        // Only rooms this reader may see; an agent's scope is not a way to
        // learn that a private room exists.
        scopeChannelIds: scopeChannelIds.filter((channelId) => {
          const channel = readChannel(this.ctx.storage, channelId);
          return channel !== null && canSeeChannel(this.channelVisibility(channel, actor.id));
        }),
        scopeChannelCount: scopeChannelIds.length,
        ownerIds,
        isOwner: ownerIds.includes(actor.id),
        queueDepth: ownerIds.includes(actor.id)
          ? visibleAgentQueueDepth(this.ctx.storage, agent.id, actor.id)
          : null,
      };
    });
    return { agents };
  }

  /**
   * The three tiers, as an owner sees them on the agent's page.
   *
   * The preamble is returned read-only. An owner who cannot see the ceiling will
   * eventually write a brief that argues with it and wonder why the agent
   * refuses.
   */
  readAgentBrief(input: { actor: Actor; agentId: string }): {
    tiers: readonly BriefTier[];
    preambleVersion: number;
  } {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    const owners = agentOwnerIds(this.ctx.storage, agent.id).map(
      (memberId) =>
        this.ctx.storage.sql
          .exec<{ display_name: string }>("SELECT display_name FROM members WHERE id = ?", memberId)
          .toArray()[0]?.display_name ?? memberId,
    );
    return {
      tiers: assembleBrief({ agentBrief: agent.prompt, messageBody: "", ownerNames: owners }),
      preambleVersion: SECURITY_PREAMBLE_VERSION,
    };
  }

  /** An owner's view of what has been queued for their agent. */
  readAgentQueue(input: {
    actor: Actor;
    agentId: string;
    limit?: number;
    unreadOnly?: boolean;
  }): { items: readonly QueueItemRow[]; depth: number } {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    return {
      items: pageAgentQueue(this.ctx.storage, {
        agentId: agent.id,
        memberId: actor.id,
        limit: clampHistoryLimit(input.limit),
        unreadOnly: input.unreadOnly !== false,
        order: "oldest",
        cursor: null,
      }).items,
      depth: visibleAgentQueueDepth(this.ctx.storage, agent.id, actor.id),
    };
  }

  /** MCP inbox paging is keyset-based and delivery state is explicit. */
  readAgentQueuePage(input: {
    actor: Actor;
    agent: string;
    limit?: number;
    unreadOnly?: boolean;
    order?: "oldest" | "newest";
    cursor?: AgentQueueCursor | null;
    peek?: boolean;
    allowedChannelIds?: readonly string[] | null;
    now: number;
  }): { agent: AgentRow; items: readonly QueueItemRow[]; nextCursor: AgentQueueCursor | null; depth: number } {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const agent = this.requireOwnedAgentArgument(input.agent, actor.id);
    const page = pageAgentQueue(this.ctx.storage, {
      agentId: agent.id,
      memberId: actor.id,
      limit: clampHistoryLimit(input.limit),
      unreadOnly: input.unreadOnly !== false,
      order: input.order ?? "newest",
      cursor: input.cursor ?? null,
      allowedChannelIds: input.allowedChannelIds ?? null,
    });
    if (input.peek !== true && page.items.length > 0) {
      this.ctx.storage.transactionSync(() => {
        for (const item of page.items) {
          setAgentQueueReadState(this.ctx.storage, { agentId: agent.id, itemId: item.id, readAt: input.now });
        }
      });
    }
    return {
      agent,
      ...page,
      depth: visibleAgentQueueDepth(this.ctx.storage, agent.id, actor.id, input.allowedChannelIds ?? null),
    };
  }

  setAgentQueueDisplayState(input: {
    actor: Actor;
    agent: string;
    itemId: string;
    read: boolean;
    allowedChannelIds?: readonly string[] | null;
    now: number;
  }): { changed: boolean } {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgentArgument(input.agent, actor.id);
    if (input.allowedChannelIds !== undefined && input.allowedChannelIds !== null) {
      const row = this.ctx.storage.sql
        .exec<{ channel_id: string }>("SELECT channel_id FROM agent_queue WHERE id = ? AND agent_id = ?", input.itemId, agent.id)
        .toArray()[0];
      if (row === undefined || !input.allowedChannelIds.includes(row.channel_id)) throw new Error("queue item not found");
    }
    const changed = this.ctx.storage.transactionSync(() =>
      setAgentQueueReadState(this.ctx.storage, {
        agentId: agent.id,
        itemId: input.itemId,
        readAt: input.read ? input.now : null,
      }),
    );
    if (!changed) throw new Error("queue item not found");
    return { changed };
  }

  /**
   * Claim one item without changing its human display state. The caller brings
   * a random lease secret; only its digest is persisted, which also makes a
   * lost response safely replayable under the same claim id and secret.
   */
  async claimAgentWork(input: {
    actor: Actor;
    connectionId?: string | null;
    sessionToken?: string | null;
    agent: string;
    claimId: string;
    leaseToken: string;
    sessionId: string;
    peek?: boolean;
    now: number;
  }): Promise<AgentLeaseResult> {
    if (input.claimId.length < 8 || input.claimId.length > 200) throw new Error("invalid claim id");
    if (input.sessionId.length < 1 || input.sessionId.length > 200) throw new Error("invalid session id");
    if (input.leaseToken.length < 32 || input.leaseToken.length > 512) throw new Error("invalid lease token");
    const leaseTokenHash = await hashSecret(input.leaseToken);
    let actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    let agent = this.requireOwnedAgentArgument(input.agent, actor.id);
    if (agent.status !== "active") throw new Error("agent is not active");
    const credential = await this.authorizeAgentToolCredential({
      actor: input.actor,
      agentId: agent.id,
      connectionId: input.connectionId,
      sessionToken: input.sessionToken,
      toolName: "agent_next",
      now: input.now,
    });
    actor = this.authorizeActor(input.actor);
    agent = this.requireOwnedAgentArgument(input.agent, actor.id);
    if (agent.status !== "active") throw new Error("agent is not active");
    if (credential.kind === "session" && input.sessionId !== credential.sessionId) {
      throw new Error("runner session id does not match the session token");
    }

    return this.ctx.storage.transactionSync(() => {
      this.expireAgentClaims(agent.id, input.now);

      const replay = this.ctx.storage.sql
        .exec<{
          id: string;
          message_id: string;
          channel_id: string;
          enqueued_at: number;
          read_at: number | null;
          flags_json: string;
          body_markdown: string;
          author_display_snapshot: string;
          lease_generation: number;
          lease_expires_at: number;
          attempt_count: number;
          lease_token_hash: string;
        }>(
          `SELECT q.id, q.message_id, q.channel_id, q.enqueued_at, q.read_at, q.flags_json,
                  m.body_markdown, m.author_display_snapshot, q.lease_generation,
                  q.lease_expires_at, q.attempt_count, q.lease_token_hash
           FROM agent_queue q JOIN messages m ON m.id = q.message_id
           WHERE q.agent_id = ? AND q.claim_id = ? AND q.execution_state = 'claimed'
             AND q.lease_connection_id IS ? AND q.lease_agent_session_id IS ?
             AND q.lease_session_id = ?`,
          agent.id,
          input.claimId,
          credential.connectionId,
          credential.sessionId,
          input.sessionId,
        )
        .toArray()[0];
      if (replay !== undefined) {
        if (replay.lease_token_hash !== leaseTokenHash) throw new Error("claim id was reused with another lease token");
        if (input.peek !== true) {
          setAgentQueueReadState(this.ctx.storage, { agentId: agent.id, itemId: replay.id, readAt: input.now });
        }
        return {
          ok: true as const,
          lease: this.leaseFromRow(agent.id, input.claimId, input.sessionId, replay),
          item: this.queueItemFromRow(replay),
          replayed: true,
        };
      }

      const row = this.ctx.storage.sql
        .exec<{
          id: string;
          message_id: string;
          channel_id: string;
          enqueued_at: number;
          read_at: number | null;
          flags_json: string;
          body_markdown: string;
          author_display_snapshot: string;
          lease_generation: number;
          attempt_count: number;
        }>(
          `SELECT q.id, q.message_id, q.channel_id, q.enqueued_at, q.read_at, q.flags_json,
                  m.body_markdown, m.author_display_snapshot, q.lease_generation, q.attempt_count
           FROM agent_queue q
           JOIN messages m ON m.id = q.message_id
           JOIN channels c ON c.id = q.channel_id
           WHERE q.agent_id = ? AND q.execution_state = 'pending' AND q.not_before <= ?
             AND m.deleted_at IS NULL
             AND (? IS NULL OR q.channel_id IN (SELECT value FROM json_each(?)))
             AND (c.kind = 'public' OR EXISTS (
               SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.member_id = ?
             ))
           ORDER BY q.enqueued_at, q.id LIMIT 1`,
          agent.id,
          input.now,
          credential.channelIds === null ? null : JSON.stringify(credential.channelIds),
          credential.channelIds === null ? null : JSON.stringify(credential.channelIds),
          actor.id,
        )
        .toArray()[0];
      if (row === undefined) return { ok: true as const, lease: null, item: null, replayed: false as const };

      const leaseGeneration = row.lease_generation + 1;
      const attemptCount = row.attempt_count + 1;
      const leaseExpiresAt = input.now + 60_000;
      const claimed = this.ctx.storage.sql.exec(
        `UPDATE agent_queue SET execution_state = 'claimed', attempt_count = ?,
           lease_generation = ?, lease_connection_id = ?, lease_agent_session_id = ?, lease_session_id = ?,
           lease_token_hash = ?, lease_expires_at = ?, execution_started_at = NULL,
           claim_id = ?, completion_id = NULL, completion_digest = NULL,
           completion_result_json = NULL, completed_at = NULL
         WHERE id = ? AND agent_id = ? AND execution_state = 'pending'`,
        attemptCount,
        leaseGeneration,
        credential.connectionId,
        credential.sessionId,
        input.sessionId,
        leaseTokenHash,
        leaseExpiresAt,
        input.claimId,
        row.id,
        agent.id,
      );
      if (claimed.rowsWritten === 0) throw new Error("queue claim raced");
      appendAuditEntry(
        this.ctx.storage,
        this.workspaceKey(),
        {
          eventType: "agent.work_claimed",
          outcome: "allowed",
          requesterKind: "member",
          requesterId: actor.id,
          subjectKind: "agent_queue_item",
          subjectId: row.id,
          metadata: {
            agent_id: agent.id,
            connection_id: credential.connectionId,
            agent_session_id: credential.sessionId,
            delegation_id: credential.delegationId,
            session_id: input.sessionId,
            lease_generation: leaseGeneration,
            attempt_count: attemptCount,
          },
        },
        input.now,
      );
      if (input.peek !== true) {
        setAgentQueueReadState(this.ctx.storage, { agentId: agent.id, itemId: row.id, readAt: input.now });
      }
      const leaseRow = { ...row, lease_generation: leaseGeneration, lease_expires_at: leaseExpiresAt, attempt_count: attemptCount };
      return {
        ok: true as const,
        lease: this.leaseFromRow(agent.id, input.claimId, input.sessionId, leaseRow),
        item: this.queueItemFromRow(row),
        replayed: false,
      };
    });
  }

  async renewAgentLease(input: AgentLeaseProof & { now: number }): Promise<{ leaseExpiresAt: number }> {
    const proof = await this.authorizeAgentLease(input, "agent_renew");
    const leaseExpiresAt = input.now + 60_000;
    const changed = this.ctx.storage.sql.exec(
      `UPDATE agent_queue SET lease_expires_at = ?
       WHERE id = ? AND agent_id = ? AND execution_state = 'claimed'
         AND lease_connection_id IS ? AND lease_agent_session_id IS ?
         AND lease_session_id = ? AND lease_generation = ?
         AND lease_token_hash = ? AND lease_expires_at > ?`,
      leaseExpiresAt,
      input.itemId,
      proof.agent.id,
      proof.credential.connectionId,
      proof.credential.sessionId,
      input.sessionId,
      input.leaseGeneration,
      proof.leaseTokenHash,
      input.now,
    );
    if (changed.rowsWritten === 0) throw new Error("stale agent lease");
    return { leaseExpiresAt };
  }

  async markAgentExecutionStarted(input: AgentLeaseProof & { now: number }): Promise<{ startedAt: number }> {
    const proof = await this.authorizeAgentLease(input, "agent_start");
    const changed = this.ctx.storage.sql.exec(
      `UPDATE agent_queue SET execution_started_at = COALESCE(execution_started_at, ?)
       WHERE id = ? AND agent_id = ? AND execution_state = 'claimed'
         AND lease_connection_id IS ? AND lease_agent_session_id IS ?
         AND lease_session_id = ? AND lease_generation = ?
         AND lease_token_hash = ? AND lease_expires_at > ?`,
      input.now,
      input.itemId,
      proof.agent.id,
      proof.credential.connectionId,
      proof.credential.sessionId,
      input.sessionId,
      input.leaseGeneration,
      proof.leaseTokenHash,
      input.now,
    );
    if (changed.rowsWritten === 0) throw new Error("stale agent lease");
    const startedAt = this.ctx.storage.sql
      .exec<{ execution_started_at: number }>("SELECT execution_started_at FROM agent_queue WHERE id = ?", input.itemId)
      .one().execution_started_at;
    return { startedAt };
  }

  async completeAgentWork(input: AgentLeaseProof & {
    completionId: string;
    outputDigest: string;
    result?: Record<string, unknown> | null;
    now: number;
  }): Promise<{ completedAt: number; replayed: boolean }> {
    if (input.completionId.length === 0 || input.completionId.length > 200) {
      throw new Error("completion id is invalid");
    }
    if (input.outputDigest.length === 0 || input.outputDigest.length > 256) {
      throw new Error("output digest is invalid");
    }
    const resultJson = JSON.stringify(input.result ?? {});
    if (resultJson.length > 16_000) throw new Error("completion result is too large");
    const proof = await this.authorizeAgentLease(input, "agent_complete", true);
    return this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<{ completion_id: string | null; completion_digest: string | null; completed_at: number | null }>(
          "SELECT completion_id, completion_digest, completed_at FROM agent_queue WHERE id = ? AND agent_id = ?",
          input.itemId,
          proof.agent.id,
        )
        .one();
      if (existing.completed_at !== null) {
        if (existing.completion_id === input.completionId && existing.completion_digest === input.outputDigest) {
          return { completedAt: existing.completed_at, replayed: true };
        }
        throw new Error("completion id or digest conflicts with the recorded result");
      }
      const changed = this.ctx.storage.sql.exec(
        `UPDATE agent_queue SET execution_state = 'completed', completion_id = ?, completion_digest = ?,
           completion_result_json = ?, completed_at = ?, lease_expires_at = NULL
         WHERE id = ? AND agent_id = ? AND execution_state = 'claimed'
           AND lease_connection_id IS ? AND lease_agent_session_id IS ?
           AND lease_session_id = ? AND lease_generation = ?
           AND lease_token_hash = ? AND lease_expires_at > ?`,
        input.completionId,
        input.outputDigest,
        resultJson,
        input.now,
        input.itemId,
        proof.agent.id,
        proof.credential.connectionId,
        proof.credential.sessionId,
        input.sessionId,
        input.leaseGeneration,
        proof.leaseTokenHash,
        input.now,
      );
      if (changed.rowsWritten === 0) throw new Error("stale agent lease");
      appendAuditEntry(
        this.ctx.storage,
        this.workspaceKey(),
        {
          eventType: "agent.work_completed",
          outcome: "allowed",
          requesterKind: "member",
          requesterId: input.actor.memberId,
          subjectKind: "agent_queue_item",
          subjectId: input.itemId,
          metadata: {
            agent_id: proof.agent.id,
            connection_id: proof.credential.connectionId,
            agent_session_id: proof.credential.sessionId,
            delegation_id: proof.credential.delegationId,
            session_id: input.sessionId,
            lease_generation: input.leaseGeneration,
            completion_id: input.completionId,
            output_digest: input.outputDigest,
          },
        },
        input.now,
      );
      return { completedAt: input.now, replayed: false };
    });
  }

  async postMcpMessage(input: {
    actor: Actor;
    connectionId: string;
    idempotencyKey: string;
    channelId: string;
    bodyMarkdown: string;
    threadParentId?: string | null;
    now: number;
  }): Promise<SentMessage> {
    return this.sendAttributedMcpMessage({ ...input, agentArgument: null });
  }

  async postMcpAgentMessage(input: {
    actor: Actor;
    connectionId?: string | null;
    sessionToken?: string | null;
    agent: string;
    idempotencyKey: string;
    channelId: string;
    bodyMarkdown: string;
    threadParentId?: string | null;
    now: number;
  }): Promise<SentMessage> {
    return this.sendAttributedMcpMessage({ ...input, agentArgument: input.agent });
  }

  /**
   * Whether this agent may write into this room.
   *
   * The same rule the enqueue side uses. A01 wires the read side; the write
   * side calls this from the agent's own tools in A03.
   */
  agentMayPost(input: { agentId: string; channelId: string }): boolean {
    const agent = readAgent(this.ctx.storage, input.agentId);
    if (agent === null) return false;
    return agentMayPostIn({
      agentStatus: agent.status,
      scope: this.agentScope(agent),
      channelId: input.channelId,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Encrypted credential vault (V01)                                   */
  /* ------------------------------------------------------------------ */

  async createVaultCredential(input: {
    actor: Actor;
    idempotencyKey: string;
    credentialId: string;
    metadata: VaultCredentialMetadata;
    policy: VaultPolicy;
    envelope: VaultCiphertextEnvelope;
    wraps: readonly VaultKeyWrap[];
    acl: readonly VaultAclEntry[];
    /**
     * The seal-time facts that make leak detection possible, both computed by
     * the client that encrypted the value. Optional: a credential with no scan
     * target simply never matches, and a credential with no marker is not a
     * canary.
     */
    scan?: { digest: string; length: number };
    canaryMarker?: string;
    freshUserVerification: boolean;
    localVaultUnlocked: boolean;
    /**
     * Present when a command's output became this value. The program's name
     * only — arguments stay on the machine that ran them, because that is where
     * a path or another secret would be.
     */
    capturedFrom?: string;
    now: number;
  }): Promise<{ credential: VaultCredentialSummary; created: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    this.requireVaultStepUp(input.freshUserVerification, input.localVaultUnlocked);
    const metadata = normalizeVaultMetadata(input.metadata);
    const policy = normalizeVaultPolicy(input.policy, input.now);
    const scan = normalizeScanTarget(input.scan);
    const canaryMarker = input.canaryMarker === undefined ? null : normalizeCanaryMarker(input.canaryMarker);
    const envelope = validateVaultEnvelope(input.envelope, { version: 1, keyEpoch: 1 });
    const wraps = input.wraps.map(validateVaultKeyWrap);
    const acl = validateVaultAcl(input.acl, wraps);
    if (!acl.some((entry) => entry.subjectType === "member" && entry.subjectId === actor.id && entry.verb === "manage")) {
      throw new Error("the creator must remain a managing custodian");
    }
    if (this.resolveActiveMemberIds(wraps.map((wrap) => wrap.custodianMemberId)).length !== wraps.length) {
      throw new Error("every vault custodian must be an active member");
    }

    const outcome = await this.commitMutation(
      { scope: "vault.create", idempotencyKey: input.idempotencyKey, requestHash: `${actor.id}|${input.credentialId}|${metadata.name}`, now: input.now },
      () => {
        if (this.readVaultCredential(input.credentialId) !== null) throw new Error("vault credential already exists");
        if (this.ctx.storage.sql.exec<{ present: number }>("SELECT 1 AS present FROM vault_credential_deletions WHERE credential_id = ?", input.credentialId).toArray()[0]) {
          throw new Error("a deleted vault credential id cannot be reused");
        }
        if (canaryMarker !== null && this.readCanaryMarkers().some((entry) => entry.marker === canaryMarker)) {
          throw new Error("that canary marker is already in use");
        }
        this.insertVaultCredential(
          input.credentialId, actor.id, metadata, policy, envelope, wraps, acl, input.now,
          input.capturedFrom === undefined ? null : normalizeCapturedFrom(input.capturedFrom),
          scan, canaryMarker,
        );
        return {
          result: { credential: this.vaultSummary(this.readVaultCredential(input.credentialId)!), created: true },
          effects: this.vaultEffects("vault.credential_created", input.credentialId, actor, {
            version: 1, policy_epoch: 1, custodian_count: wraps.length,
            captured: input.capturedFrom !== undefined, item_kind: metadata.kind ?? "opaque",
            canary: canaryMarker !== null, scannable: scan !== null,
          }),
        };
      },
    );
    return { ...outcome.result, created: !outcome.replayed };
  }

  async updateVaultCredential(input: {
    actor: Actor;
    credentialId: string;
    metadata: VaultCredentialMetadata;
    policy: VaultPolicy;
    envelope: VaultCiphertextEnvelope;
    wraps: readonly VaultKeyWrap[];
    acl: readonly VaultAclEntry[];
    /**
     * A new value is a new digest. Absent means the caller computed none, and
     * the stored target is cleared rather than left pointing at the value this
     * rotation replaced — a stale target would report the old secret as still
     * live and miss the new one.
     */
    scan?: { digest: string; length: number };
    freshUserVerification: boolean;
    localVaultUnlocked: boolean;
    now: number;
  }): Promise<{ credential: VaultCredentialSummary }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    this.requireVaultManager(input.credentialId, actor.id);
    this.requireVaultStepUp(input.freshUserVerification, input.localVaultUnlocked);
    const current = this.requireVaultCredential(input.credentialId);
    const metadata = normalizeVaultMetadata(input.metadata);
    const policy = normalizeVaultPolicy(input.policy, input.now);
    const scan = normalizeScanTarget(input.scan);
    const envelope = validateVaultEnvelope(input.envelope, { version: current.version + 1, keyEpoch: current.key_epoch + 1 });
    const wraps = input.wraps.map(validateVaultKeyWrap);
    const acl = validateVaultAcl(input.acl, wraps);
    if (this.resolveActiveMemberIds(wraps.map((wrap) => wrap.custodianMemberId)).length !== wraps.length) {
      throw new Error("every vault custodian must be an active member");
    }
    const outcome = await this.commitMutation({ scope: "vault.update", now: input.now }, () => {
      const live = this.requireVaultCredential(input.credentialId);
      if (live.version !== current.version || live.policy_epoch !== current.policy_epoch) throw new Error("vault credential changed concurrently");
      this.ctx.storage.sql.exec(
        `UPDATE vault_credentials SET kind = ?, fields_json = ?, rotate_at = ?, name = ?, description = ?, env_var = ?, tags_json = ?, commands_json = ?, proxy_hosts_json = ?,
          cipher_suite = ?, aad_version = ?, ciphertext = ?, iv = ?, key_epoch = ?, version = ?, policy_epoch = ?, mode = ?,
          allowed_deliveries_json = ?, project_ids_json = ?, grant_ttl_ms = ?, available_until = ?, max_uses_per_hour = ?, high_risk = ?,
          scan_digest = ?, scan_length = ?, updated_at = ?
         WHERE id = ?`,
        metadata.kind ?? "opaque", JSON.stringify(metadata.fields ?? []), metadata.rotateAt ?? null,
        metadata.name, metadata.description, metadata.envVar ?? null, JSON.stringify(metadata.tags), JSON.stringify(metadata.commands), JSON.stringify(metadata.proxyHosts),
        envelope.cipherSuite, envelope.aadVersion, envelope.ciphertext, envelope.iv, envelope.keyEpoch, envelope.version, live.policy_epoch + 1,
        policy.mode, JSON.stringify(policy.allowedDeliveries), JSON.stringify(policy.projectIds), policy.grantTtlMs ?? null, policy.availableUntil ?? null,
        policy.maxUsesPerHour ?? null, policy.highRisk ? 1 : 0,
        scan?.digest ?? null, scan?.length ?? null, input.now, input.credentialId,
      );
      this.ctx.storage.sql.exec("DELETE FROM vault_credential_key_wraps WHERE credential_id = ?", input.credentialId);
      this.ctx.storage.sql.exec("DELETE FROM vault_credential_acl WHERE credential_id = ?", input.credentialId);
      this.insertVaultWrapsAndAcl(input.credentialId, envelope.version, wraps, acl, input.now);
      this.revokeVaultGrants("credential_changed", input.now, "credential_id = ?", input.credentialId);
      return {
        result: { credential: this.vaultSummary(this.requireVaultCredential(input.credentialId)) },
        effects: this.vaultEffects("vault.credential_updated", input.credentialId, actor, { version: envelope.version, policy_epoch: live.policy_epoch + 1, custodian_count: wraps.length }),
      };
    });
    return outcome.result;
  }

  /**
   * Add one cryptographic custodian without rotating the credential value.
   * The unlocked current custodian has already opened the DEK and sealed this
   * one additional wrap to the recipient's published current key. The server
   * can validate that ceremony's public facts but never sees the DEK.
   */
  async addVaultCustodian(input: {
    actor: Actor;
    credentialId: string;
    recipientMemberId: string;
    wrap: VaultKeyWrap;
    freshUserVerification: boolean;
    localVaultUnlocked: boolean;
    confirmed: boolean;
    now: number;
  }): Promise<{ credential: VaultCredentialSummary; added: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    this.requireVaultManager(input.credentialId, actor.id);
    this.requireVaultStepUp(input.freshUserVerification, input.localVaultUnlocked);
    if (!input.confirmed) throw new Error("explicit custodian confirmation is required");
    const current = this.requireVaultCredential(input.credentialId);
    const wrap = validateVaultKeyWrap(input.wrap);
    if (wrap.custodianMemberId !== input.recipientMemberId) throw new Error("custodian wrap recipient does not match");
    if (this.resolveActiveMemberIds([input.recipientMemberId]).length !== 1) throw new Error("vault custodian must be an active member");
    const recipientKey = this.readVaultMemberKey(input.recipientMemberId);
    if (recipientKey === null || recipientKey.keyEpoch !== wrap.recipientKeyEpoch || recipientKey.wrapSuite !== wrap.wrapSuite) {
      throw new Error("custodian wrap does not use the recipient's current key");
    }
    if (this.readVaultWraps(current.id, current.version).some((candidate) => candidate.custodianMemberId === input.recipientMemberId)) {
      return { credential: this.vaultSummary(current), added: false };
    }
    const outcome = await this.commitMutation({ scope: "vault.custodian.add", now: input.now }, () => {
      const live = this.requireVaultCredential(input.credentialId);
      if (live.version !== current.version || live.policy_epoch !== current.policy_epoch) throw new Error("vault credential changed concurrently");
      this.ctx.storage.sql.exec(
        `INSERT INTO vault_credential_key_wraps(
           credential_id, credential_version, custodian_member_id, recipient_key_epoch,
           wrap_suite, ephemeral_public_key, iv, wrapped_dek, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        live.id, live.version, input.recipientMemberId, wrap.recipientKeyEpoch,
        wrap.wrapSuite, wrap.ephemeralPublicKey, wrap.iv, wrap.wrappedDek, input.now,
      );
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO vault_credential_acl(credential_id, subject_type, subject_id, verb, created_at)
         VALUES (?, 'member', ?, 'manage', ?)`,
        live.id, input.recipientMemberId, input.now,
      );
      this.ctx.storage.sql.exec(
        "UPDATE vault_credentials SET policy_epoch = policy_epoch + 1, updated_at = ? WHERE id = ?",
        input.now, live.id,
      );
      this.revokeVaultGrants("custodian_added", input.now, "credential_id = ?", live.id);
      this.cancelPendingApprovals(
        input.now,
        "id IN (SELECT approval_id FROM vault_approval_items WHERE credential_id = ?)",
        live.id,
      );
      return {
        result: { credential: this.vaultSummary(this.requireVaultCredential(live.id)), added: true },
        effects: this.vaultEffects("vault.custodian_added", live.id, actor, {
          custodian_member_id: input.recipientMemberId,
          item_version: live.version,
          recipient_key_epoch: wrap.recipientKeyEpoch,
        }),
      };
    });
    return outcome.result;
  }

  /**
   * Remove a custodian only as a full client-side re-encryption. A fresh DEK,
   * ciphertext version and exact wrap set for every remaining custodian arrive
   * together and commit atomically, so an interrupted attempt leaves the old
   * version and all of its valid user-held paths intact.
   */
  async removeVaultCustodian(input: {
    actor: Actor;
    credentialId: string;
    removedMemberId: string;
    envelope: VaultCiphertextEnvelope;
    wraps: readonly VaultKeyWrap[];
    freshUserVerification: boolean;
    localVaultUnlocked: boolean;
    confirmed: boolean;
    now: number;
  }): Promise<{ credential: VaultCredentialSummary; revokedGrants: number; expiredApprovals: number }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    this.requireVaultManager(input.credentialId, actor.id);
    this.requireVaultStepUp(input.freshUserVerification, input.localVaultUnlocked);
    if (!input.confirmed) throw new Error("explicit custodian confirmation is required");
    const current = this.requireVaultCredential(input.credentialId);
    const currentCustodians = this.readVaultWraps(current.id, current.version).map((wrap) => wrap.custodianMemberId);
    if (!currentCustodians.includes(input.removedMemberId)) throw new Error("vault custodian not found");
    const remaining = currentCustodians.filter((memberId) => memberId !== input.removedMemberId);
    if (remaining.length === 0) throw new Error("the final vault custodian cannot be removed");
    const envelope = validateVaultEnvelope(input.envelope, { version: current.version + 1, keyEpoch: current.key_epoch + 1 });
    const wraps = input.wraps.map(validateVaultKeyWrap);
    const wrappedMembers = [...new Set(wraps.map((wrap) => wrap.custodianMemberId))].sort();
    if (wraps.length !== remaining.length || wrappedMembers.join("\n") !== [...remaining].sort().join("\n")) {
      throw new Error("replacement wraps must exactly match remaining custodians");
    }
    for (const wrap of wraps) {
      const memberKey = this.readVaultMemberKey(wrap.custodianMemberId);
      if (memberKey === null || memberKey.keyEpoch !== wrap.recipientKeyEpoch || memberKey.wrapSuite !== wrap.wrapSuite) {
        throw new Error("replacement wrap does not use the custodian's current key");
      }
    }
    const outcome = await this.commitMutation({ scope: "vault.custodian.remove", now: input.now }, () => {
      const live = this.requireVaultCredential(input.credentialId);
      if (live.version !== current.version || live.policy_epoch !== current.policy_epoch) throw new Error("vault credential changed concurrently");
      const revokedGrants = this.countLiveVaultGrants("credential_id = ?", live.id);
      this.ctx.storage.sql.exec(
        `UPDATE vault_credentials
         SET cipher_suite = ?, aad_version = ?, ciphertext = ?, iv = ?, key_epoch = ?, version = ?,
             policy_epoch = policy_epoch + 1, updated_at = ?
         WHERE id = ?`,
        envelope.cipherSuite, envelope.aadVersion, envelope.ciphertext, envelope.iv,
        envelope.keyEpoch, envelope.version, input.now, live.id,
      );
      this.ctx.storage.sql.exec("DELETE FROM vault_credential_key_wraps WHERE credential_id = ?", live.id);
      for (const wrap of wraps) this.ctx.storage.sql.exec(
        `INSERT INTO vault_credential_key_wraps(
           credential_id, credential_version, custodian_member_id, recipient_key_epoch,
           wrap_suite, ephemeral_public_key, iv, wrapped_dek, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        live.id, envelope.version, wrap.custodianMemberId, wrap.recipientKeyEpoch,
        wrap.wrapSuite, wrap.ephemeralPublicKey, wrap.iv, wrap.wrappedDek, input.now,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM vault_credential_acl WHERE credential_id = ? AND subject_type = 'member' AND subject_id = ? AND verb = 'manage'",
        live.id, input.removedMemberId,
      );
      this.revokeVaultGrants("custodian_removed", input.now, "credential_id = ?", live.id);
      const expiredApprovals = this.cancelPendingApprovals(
        input.now,
        "id IN (SELECT approval_id FROM vault_approval_items WHERE credential_id = ?)",
        live.id,
      );
      this.ctx.storage.sql.exec(
        `UPDATE vault_proxy_requests
         SET state = 'refused', completed_at = ?, result_json = ?
         WHERE credential_id = ? AND state = 'pending'`,
        input.now, JSON.stringify({ error: "credential custodians changed" }), live.id,
      );
      return {
        result: {
          credential: this.vaultSummary(this.requireVaultCredential(live.id)),
          revokedGrants,
          expiredApprovals,
        },
        effects: this.vaultEffects("vault.custodian_removed", live.id, actor, {
          removed_member_id: input.removedMemberId,
          item_version: envelope.version,
          key_epoch: envelope.keyEpoch,
          revoked_grants: revokedGrants,
          expired_approvals: expiredApprovals,
        }),
      };
    });
    return outcome.result;
  }

  async deleteVaultCredential(input: { actor: Actor; credentialId: string; freshUserVerification: boolean; localVaultUnlocked: boolean; now: number }): Promise<{ deleted: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const row = this.readVaultCredential(input.credentialId);
    if (row === null) return { deleted: false };
    const manager = this.vaultHasAcl(input.credentialId, actor.id, undefined, undefined, "manage");
    if (!manager && actor.role !== "owner" && actor.role !== "admin") throw new Error("vault credential not found");
    this.requireVaultStepUp(input.freshUserVerification, input.localVaultUnlocked);
    const outcome = await this.commitMutation({ scope: "vault.delete", now: input.now }, () => {
      const deleted = this.ctx.storage.sql.exec("DELETE FROM vault_credentials WHERE id = ?", input.credentialId).rowsWritten > 0;
      if (!deleted) return { result: { deleted: false } };
      this.ctx.storage.sql.exec(
        `INSERT INTO vault_credential_deletions(credential_id, deletion_epoch, deleted_by_member_id, deleted_at)
         VALUES (?, ?, ?, ?)`, input.credentialId, row.version + 1, actor.id, input.now,
      );
      return { result: { deleted: true }, effects: this.vaultEffects("vault.credential_deleted", input.credentialId, actor, { deletion_epoch: row.version + 1 }) };
    });
    return outcome.result;
  }

  listVaultCredentials(input: { actor: Actor; agentId?: string; delegationId?: string; originChannelId?: string; now: number }): { credentials: readonly VaultCredentialSummary[] } {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    if (input.originChannelId !== undefined) this.requireVisibleChannel(input.originChannelId, actor.id);
    let delegation: AgentDelegation | null = null;
    if (input.agentId !== undefined) {
      this.requireOwnedAgent(input.agentId, actor.id);
      if (input.delegationId !== undefined) {
        delegation = this.requireLiveDelegation(input.delegationId, input.now);
        if (delegation.agentId !== input.agentId || delegation.ownerMemberId !== actor.id) throw new Error("delegation is not active");
      }
    }
    const rows = this.ctx.storage.sql.exec<VaultCredentialRow>("SELECT * FROM vault_credentials ORDER BY name COLLATE NOCASE, id").toArray();
    return {
      credentials: rows
        .filter((row) => (delegation === null || delegation.credentialIds.includes(row.id)))
        .filter((row) => this.vaultCanDiscover(row.id, actor.id, input.agentId, input.originChannelId))
        .map((row) => this.vaultSummary(row)),
    };
  }

  getVaultCredentialCiphertext(input: { actor: Actor; credentialId: string; freshUserVerification: boolean; localVaultUnlocked: boolean }): { envelope: VaultCiphertextEnvelope; wraps: readonly VaultKeyWrap[] } {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    this.requireVaultManager(input.credentialId, actor.id);
    this.requireVaultStepUp(input.freshUserVerification, input.localVaultUnlocked);
    const row = this.requireVaultCredential(input.credentialId);
    return { envelope: this.vaultEnvelope(row), wraps: this.readVaultWraps(row.id, row.version) };
  }

  /** Whether agents may use the vault at all, for a page that shows the switch. */
  getVaultAgentAccess(input: { actor: Actor }): { enabled: boolean; accessEpoch: number } {
    this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const settings = this.vaultSettings();
    return { enabled: settings.enabled, accessEpoch: settings.access_epoch };
  }

  /**
   * Publish this member's vault wrapping public key.
   *
   * Only the member's own key, and only when no key is registered yet: once
   * credentials are wrapped to a key, replacing it silently would strand every
   * one of them. Enrolling a second device onto an existing key, and rotating a
   * key with the re-wrapping that implies, are V07's.
   */
  async publishVaultMemberKey(input: {
    actor: Actor;
    publicKey: string;
    deviceId: string;
    freshUserVerification: boolean;
    now: number;
  }): Promise<{ memberId: string; keyEpoch: number; published: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    if (!input.freshUserVerification) throw new Error("fresh user verification is required");
    const publicKey = validateVaultPublicKey(input.publicKey, "vault public key");
    const existing = this.readVaultMemberKey(actor.id);
    if (existing !== null) {
      return { memberId: actor.id, keyEpoch: existing.keyEpoch, published: existing.publicKey === publicKey };
    }
    const outcome = await this.commitMutation({ scope: "vault.member_key", now: input.now }, () => {
      if (this.readVaultMemberKey(actor.id) !== null) throw new Error("a vault key is already registered for this member");
      this.ctx.storage.sql.exec(
        `INSERT INTO vault_member_keys(member_id, key_epoch, wrap_suite, public_key, device_id, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?, ?)`,
        actor.id, VAULT_WRAP_SUITE, publicKey, input.deviceId, input.now, input.now,
      );
      return {
        result: { memberId: actor.id, keyEpoch: 1, published: true },
        effects: this.vaultEffects("vault.member_key_published", "member_key", actor, { key_epoch: 1, device_id: input.deviceId }),
      };
    });
    return outcome.result;
  }

  /**
   * Move a member to a new wrapping key after recovery or device loss. Every
   * current credential wrap for that custodian must be replaced in the same
   * transaction. A missing or stale replacement rejects before the key epoch
   * moves, so interruption cannot strand the remaining device/recovery path.
   */
  async rotateVaultMemberKey(input: {
    actor: Actor;
    expectedKeyEpoch: number;
    publicKey: string;
    deviceId: string;
    replacements: readonly { credentialId: string; credentialVersion: number; wrap: VaultKeyWrap }[];
    freshUserVerification: boolean;
    localVaultUnlocked: boolean;
    confirmed: boolean;
    now: number;
  }): Promise<{ memberId: string; keyEpoch: number; replacedCredentials: number }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    this.requireVaultStepUp(input.freshUserVerification, input.localVaultUnlocked);
    if (!input.confirmed) throw new Error("vault key rotation confirmation is required");
    const publicKey = validateVaultPublicKey(input.publicKey, "vault public key");
    const currentKey = this.readVaultMemberKey(actor.id);
    if (
      currentKey !== null
      && currentKey.keyEpoch === input.expectedKeyEpoch + 1
      && currentKey.publicKey === publicKey
      && currentKey.wrapSuite === VAULT_WRAP_SUITE
    ) {
      return { memberId: actor.id, keyEpoch: currentKey.keyEpoch, replacedCredentials: input.replacements.length };
    }
    if (currentKey === null || currentKey.keyEpoch !== input.expectedKeyEpoch) throw new Error("vault member key epoch changed concurrently");
    if (publicKey === currentKey.publicKey) throw new Error("vault key rotation requires a new public key");
    const expected = this.ctx.storage.sql.exec<{ credential_id: string; version: number }>(
      `SELECT c.id AS credential_id, c.version
       FROM vault_credentials c
       JOIN vault_credential_key_wraps w
         ON w.credential_id = c.id AND w.credential_version = c.version
       WHERE w.custodian_member_id = ?
       ORDER BY c.id`,
      actor.id,
    ).toArray();
    const replacements = input.replacements.map((replacement) => ({
      ...replacement,
      wrap: validateVaultKeyWrap(replacement.wrap),
    })).sort((left, right) => left.credentialId.localeCompare(right.credentialId));
    if (replacements.length !== expected.length) throw new Error("vault key rotation requires every current credential wrap");
    for (let index = 0; index < expected.length; index += 1) {
      const wanted = expected[index];
      const replacement = replacements[index];
      if (
        replacement.credentialId !== wanted.credential_id
        || replacement.credentialVersion !== wanted.version
        || replacement.wrap.custodianMemberId !== actor.id
        || replacement.wrap.recipientKeyEpoch !== currentKey.keyEpoch + 1
      ) {
        throw new Error("vault key rotation replacement set is stale or incomplete");
      }
    }
    const outcome = await this.commitMutation({ scope: "vault.member_key.rotate", now: input.now }, () => {
      const liveKey = this.readVaultMemberKey(actor.id);
      if (liveKey === null || liveKey.keyEpoch !== currentKey.keyEpoch) throw new Error("vault member key epoch changed concurrently");
      this.ctx.storage.sql.exec(
        `UPDATE vault_member_keys
         SET key_epoch = key_epoch + 1, public_key = ?, device_id = ?, updated_at = ?
         WHERE member_id = ? AND key_epoch = ?`,
        publicKey, input.deviceId, input.now, actor.id, currentKey.keyEpoch,
      );
      for (const replacement of replacements) {
        const wrap = replacement.wrap;
        this.ctx.storage.sql.exec(
          `DELETE FROM vault_credential_key_wraps
           WHERE credential_id = ? AND credential_version = ? AND custodian_member_id = ?`,
          replacement.credentialId, replacement.credentialVersion, actor.id,
        );
        this.ctx.storage.sql.exec(
          `INSERT INTO vault_credential_key_wraps(
             credential_id, credential_version, custodian_member_id, recipient_key_epoch,
             wrap_suite, ephemeral_public_key, iv, wrapped_dek, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          replacement.credentialId, replacement.credentialVersion, actor.id, wrap.recipientKeyEpoch,
          wrap.wrapSuite, wrap.ephemeralPublicKey, wrap.iv, wrap.wrappedDek, input.now,
        );
        this.ctx.storage.sql.exec(
          "UPDATE vault_credentials SET policy_epoch = policy_epoch + 1, updated_at = ? WHERE id = ?",
          input.now, replacement.credentialId,
        );
        this.revokeVaultGrants("vault_key_rotated", input.now, "credential_id = ?", replacement.credentialId);
        this.cancelPendingApprovals(
          input.now,
          "id IN (SELECT approval_id FROM vault_approval_items WHERE credential_id = ?)",
          replacement.credentialId,
        );
        this.ctx.storage.sql.exec(
          `UPDATE vault_proxy_requests SET state = 'refused', completed_at = ?, result_json = ?
           WHERE credential_id = ? AND state = 'pending'`,
          input.now, JSON.stringify({ error: "custodian key rotated" }), replacement.credentialId,
        );
      }
      return {
        result: { memberId: actor.id, keyEpoch: currentKey.keyEpoch + 1, replacedCredentials: replacements.length },
        effects: this.vaultEffects("vault.member_key_rotated", "member_key", actor, {
          key_epoch: currentKey.keyEpoch + 1,
          item_count: replacements.length,
          device_id: input.deviceId,
        }),
      };
    });
    return outcome.result;
  }

  /**
   * The published wrapping keys a client needs to seal a DEK for custodians.
   * Public halves only; a member with no enrolled client is simply absent, and
   * the caller must then refuse rather than invent a custodian.
   */
  getVaultMemberKeys(input: { actor: Actor; memberIds: readonly string[] }): { keys: readonly VaultMemberKey[] } {
    const requester = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const wanted = new Set(input.memberIds.length === 0 ? [requester.id] : input.memberIds);
    return {
      keys: [...wanted]
        .map((memberId) => this.readVaultMemberKey(memberId))
        .filter((key): key is VaultMemberKey => key !== null),
    };
  }

  /** Ciphertext and this member's wraps needed for an all-or-nothing client rekey. */
  getVaultMemberRekeyMaterial(input: {
    actor: Actor;
    freshUserVerification: boolean;
    localVaultUnlocked: boolean;
  }): { key: VaultMemberKey; credentials: readonly { credentialId: string; envelope: VaultCiphertextEnvelope; wrap: VaultKeyWrap }[] } {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    this.requireVaultStepUp(input.freshUserVerification, input.localVaultUnlocked);
    const key = this.readVaultMemberKey(actor.id);
    if (key === null) throw new Error("vault member key is not registered");
    const rows = this.ctx.storage.sql.exec<VaultCredentialRow>(
      `SELECT c.* FROM vault_credentials c
       JOIN vault_credential_key_wraps w
         ON w.credential_id = c.id AND w.credential_version = c.version
       WHERE w.custodian_member_id = ? ORDER BY c.id`,
      actor.id,
    ).toArray();
    return {
      key,
      credentials: rows.map((row) => ({
        credentialId: row.id,
        envelope: this.vaultEnvelope(row),
        wrap: this.readVaultWraps(row.id, row.version).find((candidate) => candidate.custodianMemberId === actor.id)!,
      })),
    };
  }

  /**
   * The same-device local release path: one authorization decision, and the
   * ciphertext only when it says allow.
   *
   * The wrap returned is the requester's own. A use-authorized requester who is
   * not a custodian is told there is nothing here they can open, rather than
   * being handed somebody else's sealed key.
   */
  async releaseVaultCredential(
    input: VaultAccessRequest,
  ): Promise<{ decision: VaultDecision; hint?: string; envelope?: VaultCiphertextEnvelope; wrap?: VaultKeyWrap }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    // Before the decision, not after: a requester with no wrap is going to be
    // refused whatever the policy says, and letting the authorization run first
    // would spend a single-use grant and a slot in the hourly ceiling on a
    // release that could never have been delivered.
    //
    // The check is skipped for a requester who cannot see this credential at
    // all, so that the reason they are told is "no such credential", not "you
    // are not one of its custodians".
    const known = this.readVaultCredential(input.credentialId);
    const visible =
      known !== null
      && this.vaultCanDiscover(known.id, actor.id, input.agentId, input.origin.channelId);
    if (known !== null && visible) {
      const held = this.readVaultWraps(known.id, known.version).some(
        (candidate) => candidate.custodianMemberId === actor.id,
      );
      if (!held) {
        return {
          decision: { kind: "deny", reason: "no_custodian_wrap" },
          hint: vaultDenialHint("no_custodian_wrap", known.name),
        };
      }
    }

    const authorized = await this.authorizeVaultUse(input);
    if (authorized.decision.kind !== "allow") return authorized;
    const row = this.requireVaultCredential(input.credentialId);
    const wrap = this.readVaultWraps(row.id, row.version).find(
      (candidate) => candidate.custodianMemberId === actor.id,
    );
    if (wrap === undefined) {
      return { decision: { kind: "deny", reason: "no_custodian_wrap" }, hint: vaultDenialHint("no_custodian_wrap", row.name) };
    }
    return { decision: authorized.decision, envelope: this.vaultEnvelope(row), wrap };
  }

  /**
   * Queue one credential-bearing HTTP request for an online unlocked release
   * device. The request is encrypted before it is persisted or put on the
   * socket; the device is the only holder of the private key that can open it.
   * A retry reads the durable state under the same idempotency key and never
   * repeats an already accepted external request.
   */
  async requestVaultProxy(input: {
    actor: Actor;
    credentialId: string;
    agentId: string;
    delegationId: string;
    projectId: string;
    origin: { channelId: string; messageId: string };
    idempotencyKey: string;
    reason: string;
    request: unknown;
    now: number;
  }): Promise<VaultProxyRequestResult> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    if (parseIdempotencyKey(input.idempotencyKey) === null) throw new Error("invalid idempotency key");
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > 500) throw new Error("proxy reason is invalid");
    const request = normalizeVaultProxyRequest(input.request);
    // A canary in the URL, a header or the body means the agent is sending a
    // credential out through the one path that reaches the public internet.
    // Refused before an idempotency row exists, so the retry is refused too.
    this.refuseCanaryContent(JSON.stringify(request), {
      surface: "proxy_request", memberId: actor.id, agentId: input.agentId,
      channelId: input.origin.channelId, now: input.now,
    });
    const requestHash = await hashSecret(JSON.stringify({
      actor: actor.id, item: input.credentialId, agent: input.agentId, delegation: input.delegationId,
      project: input.projectId, origin: input.origin, reason, request,
    }));
    const prior = this.readVaultProxyByIdempotency(input.idempotencyKey);
    if (prior !== null) {
      if (!constantTimeEquals(prior.request_hash, requestHash)) throw new Error("proxy idempotency key was reused for a different request");
      return this.vaultProxyResult(prior, input.now);
    }

    const release = this.selectVaultReleaseDevice(actor.id);
    if (release === null) return { state: "refused", error: "vault_device_unavailable" };
    const row = this.readVaultCredential(input.credentialId);
    if (row === null) return { state: "refused", error: "vault credential not found" };
    const hostname = new URL(request.url).hostname.toLowerCase();
    if (!this.vaultSummary(row).proxyHosts.map((host) => host.toLowerCase()).includes(hostname)) {
      return { state: "refused", error: "proxy destination is not allowlisted for this credential" };
    }
    const wrap = this.readVaultWraps(row.id, row.version).find((candidate) => candidate.custodianMemberId === actor.id);
    if (wrap === undefined) return { state: "refused", error: "vault_device_unavailable" };

    const access: VaultAccessRequest = {
      actor: input.actor,
      credentialId: row.id,
      device: { id: release.deviceId, active: true, ownedByMember: true, signatureVerified: true, nonceFresh: true },
      origin: input.origin,
      projectId: input.projectId,
      delivery: "device_proxy",
      agentId: input.agentId,
      delegationId: input.delegationId,
      now: input.now,
    };
    const evaluated = this.evaluateVaultAccess(access, actor);
    if (evaluated.decision.kind === "deny") {
      return { state: "refused", error: vaultDenialHint(evaluated.decision.reason, row.name, evaluated.retryAfter) };
    }
    if (evaluated.decision.kind === "needs_approval") {
      const asked = await this.requestVaultApproval({
        actor: input.actor,
        credentialIds: [row.id],
        device: access.device,
        origin: input.origin,
        projectId: input.projectId,
        delivery: "device_proxy",
        reason,
        agentId: input.agentId,
        delegationId: input.delegationId,
        now: input.now,
      });
      const approval = asked.approvals[0];
      if (approval === undefined) return { state: "refused", error: "credential approval could not be created" };
      return { state: "needs_approval", approvalId: approval.approvalId, expiresAt: approval.expiresAt, hint: approval.hint };
    }

    const requestId = crypto.randomUUID();
    const responseKey = crypto.getRandomValues(new Uint8Array(32));
    const relay = await sealVaultProxyRequest({
      workspaceId: this.workspaceKey(), requestId, recipientPublicKey: release.publicKey, request, responseKey,
    });
    const expiresAt = input.now + VAULT_PROXY_REQUEST_TTL_MS;
    await this.commitMutation({ scope: "vault.proxy.request", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        `INSERT INTO vault_proxy_requests(
          id, idempotency_key, request_hash, requester_member_id, agent_id, delegation_id,
          release_device_id, project_id, origin_channel_id, origin_message_id,
          credential_id, credential_version, policy_epoch, access_epoch,
          relay_suite, relay_ephemeral_public_key, relay_iv, relay_ciphertext, response_key,
          state, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        requestId, input.idempotencyKey, requestHash, actor.id, input.agentId, input.delegationId,
        release.deviceId, input.projectId, input.origin.channelId, input.origin.messageId,
        row.id, row.version, row.policy_epoch, this.vaultSettings().access_epoch,
        relay.suite, relay.ephemeralPublicKey, relay.iv, relay.ciphertext, encodeVaultBytes(responseKey),
        input.now, expiresAt,
      );
      return {
        result: null,
        effects: this.vaultEffects("vault.proxy_requested", row.id, actor, {
          proxy_id: requestId, agent_id: input.agentId, delivery: "device_proxy", method: request.method,
        }),
      };
    });

    const sent = this.sendRunnerFrame(release.deviceId, {
      type: "proxy_request",
      requestId,
      workspaceId: this.workspaceKey(),
      credentialId: row.id,
      credentialVersion: row.version,
      credentialKeyEpoch: row.key_epoch,
      allowedHosts: this.vaultSummary(row).proxyHosts,
      relay,
      envelope: this.vaultEnvelope(row),
      wrap,
    });
    if (!sent) {
      this.ctx.storage.sql.exec(
        "UPDATE vault_proxy_requests SET state = 'refused', completed_at = ?, result_json = ? WHERE id = ? AND state = 'pending'",
        input.now, JSON.stringify({ error: "vault_device_unavailable" }), requestId,
      );
      return { state: "refused", requestId, error: "vault_device_unavailable" };
    }
    this.ctx.storage.sql.exec("UPDATE vault_proxy_requests SET delivered_at = ? WHERE id = ?", input.now, requestId);
    return { state: "pending", requestId, expiresAt };
  }

  /** Accept the one encrypted answer owed by the exact release device. */
  async completeVaultProxy(input: {
    actor: Actor;
    deviceId: string;
    requestId: string;
    response: VaultProxyResponseEnvelope;
    now: number;
  }): Promise<{ accepted: boolean; state: VaultProxyRequestRow["state"] }> {
    const actor = this.authorizeActor(input.actor);
    this.requireRunnerDevice(input.deviceId, actor.id);
    const row = this.readVaultProxy(input.requestId);
    if (row === null || row.release_device_id !== input.deviceId || row.requester_member_id !== actor.id) {
      throw new Error("proxy request not found");
    }
    if (row.state !== "pending") return { accepted: false, state: row.state };
    if (row.expires_at <= input.now) {
      this.ctx.storage.sql.exec(
        "UPDATE vault_proxy_requests SET state = 'uncertain', completed_at = ?, result_json = ? WHERE id = ? AND state = 'pending'",
        input.now, JSON.stringify({ error: "proxy result arrived after its deadline" }), row.id,
      );
      return { accepted: false, state: "uncertain" };
    }
    const result = validateVaultProxyResult(await openVaultProxyResponse({
      workspaceId: this.workspaceKey(),
      requestId: row.id,
      responseKey: decodeVaultBytes(row.response_key, "proxy response key"),
      envelope: input.response,
    }));

    const outcome = await this.commitMutation<{ accepted: boolean; state: "refused" | "completed" }>(
      { scope: "vault.proxy.complete", now: input.now }, () => {
      const live = this.readVaultProxy(row.id);
      if (live === null || live.state !== "pending") throw new Error("proxy request was already completed");
      const access: VaultAccessRequest = {
        actor: input.actor,
        credentialId: live.credential_id,
        device: { id: input.deviceId, active: true, ownedByMember: true, signatureVerified: true, nonceFresh: true },
        origin: { channelId: live.origin_channel_id, messageId: live.origin_message_id },
        projectId: live.project_id,
        delivery: "device_proxy",
        agentId: live.agent_id,
        delegationId: live.delegation_id,
        now: input.now,
      };
      const checked = this.evaluateVaultAccess(access, actor);
      if (
        checked.decision.kind !== "allow" || checked.row === null ||
        checked.row.version !== live.credential_version || checked.row.policy_epoch !== live.policy_epoch ||
        this.vaultSettings().access_epoch !== live.access_epoch
      ) {
        this.ctx.storage.sql.exec(
          "UPDATE vault_proxy_requests SET state = 'refused', completed_at = ?, result_json = ? WHERE id = ?",
          input.now, JSON.stringify({ error: "proxy authority changed before completion" }), live.id,
        );
        return { result: { accepted: false, state: "refused" as const } };
      }
      if (checked.grantId !== null) {
        const consumed = this.ctx.storage.sql.exec(
          `UPDATE vault_grants SET remaining_uses = CASE WHEN remaining_uses IS NULL THEN NULL ELSE remaining_uses - 1 END
           WHERE id = ? AND revoked_at IS NULL AND (remaining_uses IS NULL OR remaining_uses > 0)`, checked.grantId,
        );
        if (consumed.rowsWritten !== 1) throw new Error("vault grant was already consumed");
      }
      const usageId = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT INTO vault_usage_events(id, credential_id, grant_id, member_id, device_id, project_id, agent_id, delegation_id, delivery, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'device_proxy', ?)`,
        usageId, live.credential_id, checked.grantId, actor.id, input.deviceId, live.project_id,
        live.agent_id, live.delegation_id, input.now,
      );
      this.ctx.storage.sql.exec(
        "UPDATE vault_credentials SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?",
        input.now, live.credential_id,
      );
      this.ctx.storage.sql.exec(
        "UPDATE vault_proxy_requests SET state = 'completed', completed_at = ?, result_json = ? WHERE id = ?",
        input.now, JSON.stringify({ result }), live.id,
      );
      return {
        result: { accepted: true, state: "completed" as const },
        effects: this.vaultEffects("vault.proxy_completed", live.credential_id, actor, {
          proxy_id: live.id, status: result.status, response_bytes: new TextEncoder().encode(result.body).byteLength,
        }),
      };
      },
    );
    return outcome.result;
  }

  async setVaultAgentAccess(input: { actor: Actor; enabled: boolean; freshUserVerification: boolean; now: number }): Promise<{ enabled: boolean; accessEpoch: number }> {
    const actor = this.authorizeActor(input.actor);
    if (actor.role !== "owner" && actor.role !== "admin") throw new Error("only an admin may change vault agent access");
    if (input.enabled && !input.freshUserVerification) throw new Error("fresh user verification is required");
    const outcome = await this.commitMutation({ scope: "vault.agent_access", now: input.now }, () => {
      const current = this.ctx.storage.sql.exec<{ agent_access_on: number; access_epoch: number }>("SELECT agent_access_on, access_epoch FROM vault_settings WHERE singleton = 1").one();
      if ((current.agent_access_on === 1) === input.enabled) return { result: { enabled: input.enabled, accessEpoch: current.access_epoch } };
      const accessEpoch = current.access_epoch + 1;
      this.ctx.storage.sql.exec("UPDATE vault_settings SET agent_access_on = ?, access_epoch = ?, updated_by_member_id = ?, updated_at = ? WHERE singleton = 1", input.enabled ? 1 : 0, accessEpoch, actor.id, input.now);
      const revokedGrants = this.countLiveVaultGrants("1 = 1");
      this.revokeVaultGrants("workspace_access_changed", input.now, "1 = 1");
      // A card answered after the switch was thrown would hand out exactly what
      // the switch was thrown to stop, so every pending one ends with it.
      const expiredApprovals = input.enabled ? 0 : this.cancelPendingApprovals(input.now, "1 = 1");
      this.announceVaultKillSwitch({ kind: "workspace" }, !input.enabled, actor, revokedGrants, input.now);
      return {
        result: { enabled: input.enabled, accessEpoch },
        effects: this.vaultEffects("vault.agent_access_changed", "workspace", actor, {
          enabled: input.enabled, access_epoch: accessEpoch, revoked_grants: revokedGrants, expired_approvals: expiredApprovals,
        }),
      };
    });
    return outcome.result;
  }

  async issueVaultGrant(input: {
    actor: Actor; credentialId: string; memberId: string; deviceId: string; projectId: string;
    delivery: VaultDelivery; agentId?: string; delegationId?: string; originChannelId: string; originMessageId: string;
    expiresAt?: number; approvalVerified: boolean; freshUserVerification: boolean; now: number;
  }): Promise<{ grantId: string; expiresAt?: number; remainingUses?: number }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    this.requireVaultManager(input.credentialId, actor.id);
    if (!input.approvalVerified || !input.freshUserVerification) throw new Error("verified approval is required");
    const row = this.requireVaultCredential(input.credentialId);
    const policy = this.vaultPolicy(row);
    if (!policy.allowedDeliveries.includes(input.delivery)) throw new Error("vault delivery is not allowed");
    if (input.expiresAt !== undefined) {
      if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.now) throw new Error("grant expiry is invalid");
      if (policy.grantTtlMs === undefined || input.expiresAt > input.now + policy.grantTtlMs) throw new Error("grant exceeds the credential TTL");
    }
    if ((input.agentId === undefined) !== (input.delegationId === undefined)) throw new Error("agent grants require an exact delegation");
    if (input.delegationId !== undefined) {
      const delegation = this.requireLiveDelegation(input.delegationId, input.now);
      if (delegation.agentId !== input.agentId || delegation.ownerMemberId !== input.memberId || !delegation.credentialIds.includes(row.id)) {
        throw new Error("delegation does not permit this credential");
      }
    }
    const target = this.resolveActiveMemberIds([input.memberId]);
    if (target.length !== 1) throw new Error("grant member is not active");
    const remainingUses = input.expiresAt === undefined ? 1 : undefined;
    let grantId = "";
    const outcome = await this.commitMutation({ scope: "vault.grant.issue", now: input.now }, () => {
      grantId = this.insertVaultGrant({
        row, memberId: input.memberId, deviceId: input.deviceId, projectId: input.projectId, delivery: input.delivery,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        ...(input.delegationId === undefined ? {} : { delegationId: input.delegationId }),
        originChannelId: input.originChannelId, originMessageId: input.originMessageId,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        approverMemberId: actor.id, now: input.now,
      });
      return {
        result: { grantId, ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }), ...(remainingUses === undefined ? {} : { remainingUses }) },
        effects: this.vaultEffects("vault.grant_issued", row.id, actor, { grant_id: grantId, item_version: row.version, policy_epoch: row.policy_epoch, delivery: input.delivery }),
      };
    });
    return outcome.result;
  }

  async revokeVaultGrantsForDevice(input: { deviceId: string; now: number }): Promise<{ revoked: number }> {
    const outcome = await this.commitMutation({ scope: "vault.device_revoke", now: input.now }, () => {
      const count = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM vault_grants WHERE device_id = ? AND revoked_at IS NULL", input.deviceId,
      ).one().count;
      this.ctx.storage.sql.exec(
        "UPDATE vault_grants SET revoked_at = ?, revoked_reason = 'device_revoked' WHERE device_id = ? AND revoked_at IS NULL",
        input.now, input.deviceId,
      );
      return {
        result: { revoked: count },
        effects: count === 0 ? undefined : {
          audit: { eventType: "vault.device_grants_revoked", outcome: "allowed", requesterKind: "system", subjectKind: "device", subjectId: input.deviceId, metadata: { grant_count: count } },
        },
      };
    });
    return outcome.result;
  }

  async authorizeVaultUse(input: VaultAccessRequest): Promise<{ decision: VaultDecision; hint?: string }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const initial = this.evaluateVaultAccess(input, actor);
    if (initial.decision.kind !== "allow") {
      return initial.decision.kind === "deny"
        ? { decision: initial.decision, hint: vaultDenialHint(initial.decision.reason, initial.row?.name ?? "credential", initial.retryAfter) }
        : { decision: initial.decision };
    }
    const outcome = await this.commitMutation({ scope: "vault.use", now: input.now }, () => {
      const checked = this.evaluateVaultAccess(input, actor);
      if (checked.decision.kind !== "allow" || checked.row === null) throw new Error("vault authorization changed before use");
      if (checked.grantId !== null) {
        const consumed = this.ctx.storage.sql.exec(
          `UPDATE vault_grants SET remaining_uses = CASE WHEN remaining_uses IS NULL THEN NULL ELSE remaining_uses - 1 END
           WHERE id = ? AND revoked_at IS NULL AND (remaining_uses IS NULL OR remaining_uses > 0)`, checked.grantId,
        );
        if (consumed.rowsWritten !== 1) throw new Error("vault grant was already consumed");
      }
      const usageId = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT INTO vault_usage_events(id, credential_id, grant_id, member_id, device_id, project_id, agent_id, delegation_id, delivery, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        usageId, checked.row.id, checked.grantId, actor.id, input.device.id, input.projectId, input.agentId ?? null, input.delegationId ?? null, input.delivery, input.now,
      );
      this.ctx.storage.sql.exec("UPDATE vault_credentials SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?", input.now, checked.row.id);
      return {
        result: { decision: checked.decision },
        effects: this.vaultEffects("vault.access_authorized", checked.row.id, actor, { usage_id: usageId, delivery: input.delivery, via: checked.decision.via }),
      };
    });
    return outcome.result;
  }

  /* -------------------------------------------------------------------- */
  /* Conversational approvals and the kill switch (V03)                    */
  /* -------------------------------------------------------------------- */

  /**
   * Ask the people who own these credentials.
   *
   * Every credential is evaluated first, because most requests never need to
   * bother anybody: a denial is returned as a denial and an automatic allow as
   * an allow. Only what the policy genuinely leaves to a human becomes a card.
   *
   * Cards are grouped by their eligible approver set rather than by the
   * request, because a card is answered once by one person. Two credentials
   * owned by different people are two questions however close together they
   * were asked, and coalescing them would let one owner's gesture stand for
   * another owner's credential.
   */
  async requestVaultApproval(input: {
    actor: Actor;
    credentialIds: readonly string[];
    device: VaultAccessRequest["device"];
    origin: { channelId: string; messageId: string };
    projectId: string;
    delivery: VaultDelivery;
    reason: string;
    agentId?: string;
    delegationId?: string;
    now: number;
  }): Promise<VaultApprovalRequestResult> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const tuple = validateApprovalTuple({
      requesterMemberId: actor.id,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.delegationId === undefined ? {} : { delegationId: input.delegationId }),
      deviceId: input.device.id,
      projectId: input.projectId,
      originChannelId: input.origin.channelId,
      originMessageId: input.origin.messageId,
      delivery: input.delivery,
      reason: input.reason,
    });
    const requested = [...new Set(input.credentialIds)];
    validateApprovalItems(
      requested.map((credentialId) => ({ credentialId, name: "", version: 1, policyEpoch: 1 })),
    );

    const decided: { credentialId: string; decision: VaultDecision; hint?: string }[] = [];
    const pending: { row: VaultCredentialRow; approvers: readonly string[] }[] = [];
    for (const credentialId of requested) {
      const request: VaultAccessRequest = {
        actor: input.actor, credentialId, device: input.device, origin: input.origin,
        projectId: input.projectId, delivery: input.delivery,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        ...(input.delegationId === undefined ? {} : { delegationId: input.delegationId }),
        now: input.now,
      };
      const evaluated = this.evaluateVaultAccess(request, actor);
      if (evaluated.decision.kind !== "needs_approval" || evaluated.row === null) {
        decided.push({
          credentialId,
          decision: evaluated.decision,
          ...(evaluated.decision.kind === "deny"
            ? { hint: vaultDenialHint(evaluated.decision.reason, evaluated.row?.name ?? "credential", evaluated.retryAfter) }
            : {}),
        });
        continue;
      }
      const approvers = this.vaultApproverMemberIds(evaluated.row.id);
      if (approvers.length === 0) {
        // Nobody can answer, so waiting five minutes would only waste them. A
        // credential whose last manager left is a state a human has to fix.
        decided.push({
          credentialId,
          decision: { kind: "deny", reason: "no_eligible_approver" },
          hint: vaultDenialHint("no_eligible_approver", evaluated.row.name),
        });
        continue;
      }
      pending.push({ row: evaluated.row, approvers });
    }
    if (pending.length === 0) return { approvals: [], decisions: decided };

    const groups = new Map<string, { approvers: readonly string[]; rows: VaultCredentialRow[] }>();
    for (const item of pending) {
      const key = [...item.approvers].sort().join("|");
      const group = groups.get(key) ?? { approvers: [...item.approvers].sort(), rows: [] };
      group.rows.push(item.row);
      groups.set(key, group);
    }

    const approvals: VaultApprovalSummary[] = [];
    for (const group of groups.values()) {
      for (let index = 0; index < group.rows.length; index += MAX_APPROVAL_CREDENTIALS) {
        approvals.push(
          await this.createVaultApproval(
            actor,
            tuple,
            group.rows.slice(index, index + MAX_APPROVAL_CREDENTIALS),
            group.approvers,
            input.now,
          ),
        );
      }
    }
    return { approvals, decisions: decided };
  }

  private async createVaultApproval(
    actor: ActiveMember,
    tuple: ApprovalRequestTuple,
    rows: readonly VaultCredentialRow[],
    approvers: readonly string[],
    now: number,
  ): Promise<VaultApprovalSummary> {
    const approvalId = crypto.randomUUID();
    const expiresAt = now + VAULT_APPROVAL_TTL_MS;
    const settings = this.vaultSettings();
    const agent = tuple.agentId === undefined ? null : readAgent(this.ctx.storage, tuple.agentId);
    const originChannel = readChannel(this.ctx.storage, tuple.originChannelId);
    const card = approvalCardMarkdown({
      requesterHandle: actor.handle,
      ...(agent === null ? {} : { agentHandle: agent.handle }),
      // The device and project are shown by the opaque labels the request was
      // signed with. Paths, commands and environment values stay on the runner:
      // the cloud has never seen them and an approval card is not where that
      // changes.
      deviceLabel: `device ${tuple.deviceId}`,
      projectLabel: tuple.projectId,
      originChannelLabel: originChannel?.slug ? `#${originChannel.slug}` : "a conversation",
      delivery: tuple.delivery,
      reason: tuple.reason,
      expiresAt,
      items: rows.map((row) => {
        const usage = this.vaultRecentUsage(row.id, now);
        return {
          name: row.name,
          description: row.description,
          highRisk: row.high_risk === 1,
          recentUses: usage.count,
          ...(usage.lastUsedAt === null ? {} : { lastUsedAt: usage.lastUsedAt }),
        };
      }),
    });

    const outcome = await this.commitMutation({ scope: "vault.approval.request", now }, () => {
      this.ctx.storage.sql.exec(
        `INSERT INTO vault_approvals(id, status, requester_member_id, agent_id, delegation_id, device_id, project_id,
           origin_channel_id, origin_message_id, delivery, reason, access_epoch, created_at, expires_at)
         VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        approvalId, actor.id, tuple.agentId ?? null, tuple.delegationId ?? null, tuple.deviceId, tuple.projectId,
        tuple.originChannelId, tuple.originMessageId, tuple.delivery, tuple.reason, settings.access_epoch, now, expiresAt,
      );
      for (const row of rows) {
        this.ctx.storage.sql.exec(
          `INSERT INTO vault_approval_items(approval_id, credential_id, credential_version, policy_epoch)
           VALUES (?, ?, ?, ?)`,
          approvalId, row.id, row.version, row.policy_epoch,
        );
      }
      // The card is a real message in a real conversation, so it can be read on
      // a phone, quoted, and answered by whichever owner gets there first.
      for (const memberId of approvers) {
        const posted = this.postVaultMessage(memberId, card, null, now);
        this.ctx.storage.sql.exec(
          `INSERT INTO vault_approval_approvers(approval_id, member_id, card_channel_id, card_message_id)
           VALUES (?, ?, ?, ?)`,
          approvalId, memberId, posted.channelId, posted.messageId,
        );
      }
      return {
        result: { approvalId, expiresAt },
        effects: {
          audit: {
            eventType: "vault.approval_requested", outcome: "allowed", requesterKind: "member", requesterId: actor.id,
            subjectKind: "vault_approval", subjectId: approvalId,
            metadata: {
              item_count: rows.length, approver_count: approvers.length, delivery: tuple.delivery,
              agent_id: tuple.agentId ?? null, delegation_id: tuple.delegationId ?? null, project_id: tuple.projectId,
            },
          },
          // Push is the whole point: the card has five minutes to reach a person
          // who is not looking at the app. Approvals are the one thing in the
          // product that notify regardless of Do Not Disturb.
          outbox: approvers.map((memberId) => ({
            id: `vault_approval.${approvalId}.${memberId}`,
            kind: "vault_approval_requested",
            dedupeKey: `vault_approval:${approvalId}:${memberId}`,
            payload: {
              approvalId, memberId, expiresAt, delivery: tuple.delivery, reason: tuple.reason,
              credentialNames: rows.map((row) => row.name), highRisk: rows.some((row) => row.high_risk === 1),
              requesterHandle: actor.handle, agentHandle: agent?.handle ?? null, urgent: true,
            },
          })),
          dueWork: [{ id: VAULT_APPROVAL_EXPIRY_WORK_ID, kind: "vault_approval_expiry", dueAt: expiresAt }],
        } satisfies MutationEffects,
      };
    });
    for (const memberId of approvers) {
      this.broadcastToMember(memberId, {
        type: "vault", kind: "approval_requested", approvalId,
        payload: { expiresAt, credentialNames: rows.map((row) => row.name) },
      });
    }
    return {
      approvalId: outcome.result.approvalId,
      expiresAt: outcome.result.expiresAt,
      credentialIds: rows.map((row) => row.id),
      credentialNames: rows.map((row) => row.name),
      approverMemberIds: approvers,
      hint: approvalPendingHint(rows.map((row) => row.name), outcome.result.expiresAt),
    };
  }

  /**
   * The approvals this member is being asked about, plus the ones they are
   * waiting on. Metadata only: an approval has never held ciphertext or a key.
   */
  listVaultApprovals(input: { actor: Actor; now: number }): { approvals: readonly VaultApprovalCard[] } {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const rows = this.ctx.storage.sql.exec<VaultApprovalRow>(
      `SELECT a.* FROM vault_approvals a
       WHERE a.status = 'pending' AND a.expires_at > ?
         AND (a.requester_member_id = ? OR EXISTS (
           SELECT 1 FROM vault_approval_approvers p WHERE p.approval_id = a.id AND p.member_id = ?))
       ORDER BY a.created_at`,
      input.now, actor.id, actor.id,
    ).toArray();
    return { approvals: rows.map((row) => this.vaultApprovalCard(row, actor.id)) };
  }

  /**
   * Answer a card. The first terminal answer wins.
   *
   * Allowing is a step-up: the approver's verified gesture is bound to this
   * approval and this exact ordered set of decisions, so it cannot be replayed
   * onto another card or onto the same card after a credential changed.
   * Denying takes no step-up at all — a protective action must never be the
   * harder one.
   */
  async decideVaultApproval(input: {
    actor: Actor;
    approvalId: string;
    decisions: readonly ApprovalDecisionInput[];
    stepUp?: { verified: boolean; digest: string };
    now: number;
  }): Promise<VaultApprovalDecisionResult> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const approval = this.readVaultApproval(input.approvalId);
    if (approval === null) throw new Error("that approval does not exist");
    if (!this.vaultApprovalApprovers(approval.id).includes(actor.id)) {
      // Reported as missing rather than forbidden, the same as a room somebody
      // cannot see: whether a credential they do not own is being requested is
      // not their business.
      throw new Error("that approval does not exist");
    }

    const items = this.readVaultApprovalItems(approval.id);
    const digest = canonicalApprovalDigest({
      approvalId: approval.id,
      items: items.map((item) => ({
        credentialId: item.credential_id, name: item.name, version: item.credential_version, policyEpoch: item.policy_epoch,
      })),
      decisions: input.decisions,
    });
    const allowing = input.decisions.some((decision) => decision.outcome === "allowed");
    if (allowing) {
      if (input.stepUp === undefined || !input.stepUp.verified) {
        throw new Error("allowing a credential needs a verified approval gesture");
      }
      if (input.stepUp.digest !== digest) {
        throw new Error("that approval gesture authorises a different decision");
      }
    }

    if (isApprovalExpired({ status: approval.status, expiresAt: approval.expires_at }, input.now)) {
      await this.expireVaultApprovals(input.now);
      return { status: "expired", accepted: false, reason: "that request timed out before it was answered", decisions: [] };
    }
    const transition = decideApprovalTransition(
      approval.status,
      allowing && input.decisions.every((decision) => decision.outcome === "allowed") ? "allowed" : allowing ? "allowed" : "denied",
    );
    if (!transition.ok) {
      const answered = this.readVaultApproval(approval.id);
      return {
        status: answered?.status ?? approval.status, accepted: false, reason: transition.reason,
        ...(answered?.decided_by_member_id ? { decidedByMemberId: answered.decided_by_member_id } : {}),
        decisions: [],
      };
    }

    const outcome = await this.commitMutation({ scope: "vault.approval.decide", now: input.now }, () => {
      // One conditional write is what makes first-answer-wins true: a second
      // approver's transaction finds nothing left in `pending` to update. The
      // claim is confirmed by reading the row back rather than by counting
      // written rows, because a write that touches an indexed column writes the
      // index entries too and the count is not the number of rows matched.
      this.ctx.storage.sql.exec(
        `UPDATE vault_approvals SET status = ?, decided_at = ?, decided_by_member_id = ?, decision_digest = ?
         WHERE id = ? AND status = 'pending'`,
        transition.status, input.now, actor.id, digest, approval.id,
      );
      const claimed = this.ctx.storage.sql.exec<{ status: ApprovalStatus; decided_by_member_id: string | null }>(
        "SELECT status, decided_by_member_id FROM vault_approvals WHERE id = ?", approval.id,
      ).one();
      if (claimed.status !== transition.status || claimed.decided_by_member_id !== actor.id) {
        throw new Error("that request was already answered");
      }

      const applied: { credentialId: string; name: string; outcome: ApprovalOutcome; window: ApprovalWindow; grantId?: string }[] = [];
      for (const decision of input.decisions) {
        const item = items.find((candidate) => candidate.credential_id === decision.credentialId)!;
        let grantId: string | undefined;
        if (decision.outcome === "allowed") {
          const row = this.readVaultCredential(item.credential_id);
          // A credential that changed after the card was written is a different
          // credential than the one the approver read. It needs a new request,
          // not a grant issued against a version nobody agreed to.
          if (row === null || row.version !== item.credential_version || row.policy_epoch !== item.policy_epoch) {
            throw new Error("that credential changed after the request was made");
          }
          if (row.frozen_at !== null) throw new Error("that credential was switched off after the request was made");
          grantId = this.insertVaultGrant({
            row,
            memberId: approval.requester_member_id,
            deviceId: approval.device_id,
            projectId: approval.project_id,
            delivery: approval.delivery,
            ...(approval.agent_id === null ? {} : { agentId: approval.agent_id }),
            ...(approval.delegation_id === null ? {} : { delegationId: approval.delegation_id }),
            originChannelId: approval.origin_channel_id,
            originMessageId: approval.origin_message_id,
            expiresAt: approvalGrantExpiry(decision.window, this.vaultPolicy(row), input.now),
            approverMemberId: actor.id,
            now: input.now,
          });
        }
        this.ctx.storage.sql.exec(
          "UPDATE vault_approval_items SET outcome = ?, grant_window = ?, grant_id = ? WHERE approval_id = ? AND credential_id = ?",
          decision.outcome, decision.window, grantId ?? null, approval.id, decision.credentialId,
        );
        applied.push({ credentialId: decision.credentialId, name: item.name, outcome: decision.outcome, window: decision.window, ...(grantId === undefined ? {} : { grantId }) });
      }

      // The answer goes back into the same conversation, on every approver's
      // copy, so a second owner sees who answered rather than an open card.
      const answer = approvalAnswerMarkdown({
        approverHandle: actor.handle,
        decisions: applied.map((item) => ({ name: item.name, outcome: item.outcome, window: item.window })),
      });
      this.postVaultApprovalAnswer(approval.id, answer, input.now);

      return {
        result: { status: transition.status as VaultApprovalDecisionResult["status"], accepted: true, decisions: applied },
        effects: {
          audit: {
            eventType: "vault.approval_decided", outcome: "allowed", requesterKind: "member", requesterId: actor.id,
            subjectKind: "vault_approval", subjectId: approval.id,
            metadata: {
              status: transition.status, allowed: applied.filter((item) => item.outcome === "allowed").length,
              denied: applied.filter((item) => item.outcome === "denied").length,
              requester_member_id: approval.requester_member_id, digest,
            },
          },
          outbox: [{
            id: `vault_approval_decided.${approval.id}`,
            kind: "vault_approval_decided",
            dedupeKey: `vault_approval_decided:${approval.id}`,
            payload: { approvalId: approval.id, status: transition.status, decidedByMemberId: actor.id },
          }],
        } satisfies MutationEffects,
      };
    });

    for (const memberId of [...this.vaultApprovalApprovers(approval.id), approval.requester_member_id]) {
      this.broadcastToMember(memberId, {
        type: "vault", kind: "approval_decided", approvalId: approval.id,
        payload: { status: outcome.result.status, decidedByMemberId: actor.id },
      });
    }
    return { ...outcome.result, decidedByMemberId: actor.id };
  }

  /**
   * Time out every card nobody answered.
   *
   * A timeout is a denial. It is written as one, announced as one, and reported
   * to the agent as one, because an approval that simply goes quiet is how a
   * person learns to ignore the next card.
   */
  async expireVaultApprovals(now: number): Promise<{ expired: number }> {
    const due = this.ctx.storage.sql.exec<VaultApprovalRow>(
      "SELECT * FROM vault_approvals WHERE status = 'pending' AND expires_at <= ? ORDER BY expires_at LIMIT 64", now,
    ).toArray();
    if (due.length === 0) {
      await this.armVaultApprovalExpiry(now);
      return { expired: 0 };
    }

    for (const approval of due) {
      const names = this.readVaultApprovalItems(approval.id).map((item) => item.name);
      await this.commitMutation({ scope: "vault.approval.expire", now }, () => {
        this.ctx.storage.sql.exec(
          "UPDATE vault_approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'",
          now, approval.id,
        );
        const claimed = this.ctx.storage.sql.exec<{ status: ApprovalStatus }>(
          "SELECT status FROM vault_approvals WHERE id = ?", approval.id,
        ).one();
        if (claimed.status !== "expired") return { result: { expired: false } };
        this.ctx.storage.sql.exec(
          "UPDATE vault_approval_items SET outcome = 'denied' WHERE approval_id = ? AND outcome IS NULL",
          approval.id,
        );
        this.postVaultApprovalAnswer(approval.id, approvalExpiredMarkdown(names), now);
        return {
          result: { expired: true },
          effects: {
            audit: {
              eventType: "vault.approval_expired", outcome: "denied", requesterKind: "system",
              subjectKind: "vault_approval", subjectId: approval.id,
              metadata: { item_count: names.length, requester_member_id: approval.requester_member_id },
            },
            outbox: [{
              id: `vault_approval_expired.${approval.id}`,
              kind: "vault_approval_expired",
              dedupeKey: `vault_approval_expired:${approval.id}`,
              payload: { approvalId: approval.id, status: "expired", hint: approvalTimeoutHint(names) },
            }],
          } satisfies MutationEffects,
        };
      });
      this.broadcastToMember(approval.requester_member_id, {
        type: "vault", kind: "approval_expired", approvalId: approval.id,
        payload: { hint: approvalTimeoutHint(names) },
      });
    }
    await this.armVaultApprovalExpiry(now);
    return { expired: due.length };
  }

  /* -- the three kill-switch scopes ------------------------------------- */

  /**
   * Switch one credential off for everybody.
   *
   * No step-up: a protective action has to be the easy one. It outranks every
   * policy, revokes every live grant, and ends any card still waiting on it,
   * because an approval answered after the switch was thrown would hand out
   * exactly what the switch was thrown to stop.
   */
  async setVaultCredentialFreeze(input: {
    actor: Actor;
    credentialId: string;
    frozen: boolean;
    now: number;
  }): Promise<{ frozen: boolean; revokedGrants: number; expiredApprovals: number }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const row = this.readVaultCredential(input.credentialId);
    if (row === null || !this.vaultCanDiscover(row.id, actor.id)) throw new Error("vault credential not found");
    if ((row.frozen_at !== null) === input.frozen) {
      return { frozen: input.frozen, revokedGrants: 0, expiredApprovals: 0 };
    }

    const outcome = await this.commitMutation({ scope: "vault.credential.freeze", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        "UPDATE vault_credentials SET frozen_at = ?, frozen_by_member_id = ?, frozen_reason = ?, updated_at = ? WHERE id = ?",
        input.frozen ? input.now : null, input.frozen ? actor.id : null,
        input.frozen ? "switched_off" : null, input.now, row.id,
      );
      let revokedGrants = 0;
      let expiredApprovals = 0;
      if (input.frozen) {
        revokedGrants = this.countLiveVaultGrants("credential_id = ?", row.id);
        this.revokeVaultGrants("credential_switched_off", input.now, "credential_id = ?", row.id);
        expiredApprovals = this.cancelPendingApprovals(
          input.now,
          "id IN (SELECT approval_id FROM vault_approval_items WHERE credential_id = ?)",
          row.id,
        );
      }
      this.announceVaultKillSwitch(
        { kind: "credential", name: row.name }, input.frozen, actor, revokedGrants, input.now,
      );
      return {
        result: { frozen: input.frozen, revokedGrants, expiredApprovals },
        effects: this.vaultEffects("vault.credential_switch", row.id, actor, {
          off: input.frozen, revoked_grants: revokedGrants, expired_approvals: expiredApprovals,
        }),
      };
    });
    return outcome.result;
  }

  /**
   * Cut one agent off from the vault without silencing it.
   *
   * Pausing an agent stops it doing anything at all, which is a bigger hammer
   * than "stop this one using credentials" and is often not what the person
   * reaching for the switch means. Keeping the two separate means neither has
   * to be abused to get the other.
   */
  async setAgentVaultAccess(input: {
    actor: Actor;
    agentId: string;
    enabled: boolean;
    now: number;
  }): Promise<{ enabled: boolean; revokedGrants: number; expiredApprovals: number }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const agent = readAgent(this.ctx.storage, input.agentId);
    if (agent === null) throw new Error("agent not found");
    // Turning access back on is the only direction that needs authority, and it
    // is the owner's or an admin's. Anyone in the workspace may switch an agent
    // off: that is the point of a kill switch.
    if (input.enabled && actor.role !== "owner" && actor.role !== "admin") {
      this.requireOwnedAgent(agent.id, actor.id);
    }
    if ((agent.vaultAccessOffAt === null) === input.enabled) {
      return { enabled: input.enabled, revokedGrants: 0, expiredApprovals: 0 };
    }

    const outcome = await this.commitMutation({ scope: "vault.agent.switch", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        "UPDATE agents SET vault_access_off_at = ?, vault_access_off_by_member_id = ?, updated_at = ? WHERE id = ?",
        input.enabled ? null : input.now, input.enabled ? null : actor.id, input.now, agent.id,
      );
      let revokedGrants = 0;
      let expiredApprovals = 0;
      if (!input.enabled) {
        revokedGrants = this.countLiveVaultGrants("agent_id = ?", agent.id);
        this.revokeVaultGrants("agent_vault_access_off", input.now, "agent_id = ?", agent.id);
        expiredApprovals = this.cancelPendingApprovals(input.now, "agent_id = ?", agent.id);
      }
      this.announceVaultKillSwitch(
        { kind: "agent", handle: agent.handle }, !input.enabled, actor, revokedGrants, input.now,
      );
      return {
        result: { enabled: input.enabled, revokedGrants, expiredApprovals },
        effects: this.vaultEffects("vault.agent_switch", agent.id, actor, {
          off: !input.enabled, revoked_grants: revokedGrants, expired_approvals: expiredApprovals,
        }),
      };
    });
    return outcome.result;
  }

  /* -- approval helpers -------------------------------------------------- */

  private vaultApproverMemberIds(credentialId: string): readonly string[] {
    const managers = this.ctx.storage.sql.exec<{ subject_id: string }>(
      "SELECT subject_id FROM vault_credential_acl WHERE credential_id = ? AND verb = 'manage' AND subject_type = 'member'",
      credentialId,
    ).toArray().map((row) => row.subject_id);
    return this.resolveActiveMemberIds(managers);
  }

  private vaultRecentUsage(credentialId: string, now: number): { count: number; lastUsedAt: number | null } {
    const row = this.ctx.storage.sql.exec<{ count: number; last_used_at: number | null }>(
      "SELECT COUNT(*) AS count, MAX(used_at) AS last_used_at FROM vault_usage_events WHERE credential_id = ? AND used_at > ?",
      credentialId, now - DAY_MS,
    ).one();
    return { count: row.count, lastUsedAt: row.last_used_at };
  }

  private readVaultApproval(approvalId: string): VaultApprovalRow | null {
    return this.ctx.storage.sql.exec<VaultApprovalRow>("SELECT * FROM vault_approvals WHERE id = ?", approvalId).toArray()[0] ?? null;
  }

  private readVaultApprovalItems(approvalId: string): readonly VaultApprovalItemRow[] {
    return this.ctx.storage.sql.exec<VaultApprovalItemRow>(
      `SELECT i.approval_id, i.credential_id, i.credential_version, i.policy_epoch, i.outcome, i.grant_window, i.grant_id,
              COALESCE(c.name, i.credential_id) AS name, COALESCE(c.description, '') AS description,
              COALESCE(c.high_risk, 0) AS high_risk, c.grant_ttl_ms AS grant_ttl_ms
       FROM vault_approval_items i LEFT JOIN vault_credentials c ON c.id = i.credential_id
       WHERE i.approval_id = ? ORDER BY i.credential_id`,
      approvalId,
    ).toArray();
  }

  private vaultApprovalApprovers(approvalId: string): readonly string[] {
    return this.ctx.storage.sql.exec<{ member_id: string }>(
      "SELECT member_id FROM vault_approval_approvers WHERE approval_id = ? ORDER BY member_id", approvalId,
    ).toArray().map((row) => row.member_id);
  }

  private vaultApprovalCard(row: VaultApprovalRow, viewerId: string): VaultApprovalCard {
    const items = this.readVaultApprovalItems(row.id);
    const requester = this.ctx.storage.sql.exec<{ handle: string }>("SELECT handle FROM members WHERE id = ?", row.requester_member_id).toArray()[0];
    const agent = row.agent_id === null ? null : readAgent(this.ctx.storage, row.agent_id);
    return {
      approvalId: row.id,
      status: row.status,
      requesterMemberId: row.requester_member_id,
      requesterHandle: requester?.handle ?? row.requester_member_id,
      agentHandle: agent?.handle ?? null,
      deviceId: row.device_id,
      projectId: row.project_id,
      delivery: row.delivery,
      reason: row.reason,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      viewerMayDecide: this.vaultApprovalApprovers(row.id).includes(viewerId),
      items: items.map((item) => ({
        credentialId: item.credential_id,
        name: item.name,
        description: item.description,
        highRisk: item.high_risk === 1,
        version: item.credential_version,
        policyEpoch: item.policy_epoch,
        windows: availableApprovalWindows(item.grant_ttl_ms === null ? {} : { grantTtlMs: item.grant_ttl_ms }),
      })),
    };
  }

  /** Cancel every pending card matching a predicate, as part of the caller's transaction. */
  private cancelPendingApprovals(now: number, predicate: string, ...values: (string | number)[]): number {
    const affected = this.ctx.storage.sql.exec<{ id: string }>(
      `SELECT id FROM vault_approvals WHERE status = 'pending' AND ${predicate}`, ...values,
    ).toArray();
    for (const approval of affected) {
      this.ctx.storage.sql.exec(
        "UPDATE vault_approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'", now, approval.id,
      );
      this.ctx.storage.sql.exec(
        "UPDATE vault_approval_items SET outcome = 'denied' WHERE approval_id = ? AND outcome IS NULL", approval.id,
      );
      const names = this.readVaultApprovalItems(approval.id).map((item) => item.name);
      this.postVaultApprovalAnswer(approval.id, approvalExpiredMarkdown(names), now);
    }
    return affected.length;
  }

  private countLiveVaultGrants(predicate: string, ...values: (string | number)[]): number {
    return this.ctx.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM vault_grants WHERE revoked_at IS NULL AND ${predicate}`, ...values,
    ).one().count;
  }

  private async armVaultApprovalExpiry(now: number): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ due: number | null }>(
      "SELECT MIN(expires_at) AS due FROM vault_approvals WHERE status = 'pending'",
    ).one().due;
    if (next === null) return;
    this.ctx.storage.transactionSync(() =>
      scheduleDueWork(this.ctx.storage, [{ id: VAULT_APPROVAL_EXPIRY_WORK_ID, kind: "vault_approval_expiry", dueAt: next }], now),
    );
    await this.armAlarm();
  }

  /* -- the vault's own voice --------------------------------------------- */

  /**
   * The reserved `a.vault` identity, created on first use.
   *
   * It has no owners on purpose: nobody administers it, nobody can rename it
   * into something that impersonates a person, and the last-owner guard has
   * nothing to protect. It exists so an approval can arrive as a message from
   * somebody rather than as a system notice from nowhere.
   */
  private vaultAgent(now: number): AgentRow {
    const existing = readAgentByHandle(this.ctx.storage, VAULT_AGENT_HANDLE);
    if (existing !== null) return existing;
    this.ctx.storage.sql.exec(
      `INSERT INTO agents(id, handle, display_name, description, status, created_by_member_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', NULL, ?, ?)`,
      crypto.randomUUID(), VAULT_AGENT_HANDLE, VAULT_AGENT_HANDLE,
      "Delivers credential approvals and announces the kill switch.", now, now,
    );
    return readAgentByHandle(this.ctx.storage, VAULT_AGENT_HANDLE)!;
  }

  /**
   * The conversation between one member and the vault, created on first use.
   *
   * It is an ordinary direct message with one human in it, so every rule that
   * already governs a DM — visibility, unread, read state, live delivery,
   * history — governs this too. Its key lives in a namespace of its own, so it
   * can never collide with a conversation between people.
   */
  private vaultDirectMessage(memberId: string, agent: AgentRow, now: number): ChannelRow {
    const key = vaultDirectMessageKey(memberId);
    const existing = readChannelByDirectMessageKey(this.ctx.storage, key);
    if (existing !== null) return existing;
    const channelId = crypto.randomUUID();
    insertChannel(this.ctx.storage, {
      id: channelId, kind: "dm", slug: null, name: agent.handle, topic: null,
      dmKey: key, createdByMemberId: memberId, now,
    });
    addChannelMembers(this.ctx.storage, channelId, [memberId], now);
    return readChannel(this.ctx.storage, channelId)!;
  }

  private postVaultMessage(
    memberId: string,
    body: string,
    threadRootId: string | null,
    now: number,
  ): { channelId: string; messageId: string } {
    const agent = this.vaultAgent(now);
    const channel = this.vaultDirectMessage(memberId, agent, now);
    const messageId = crypto.randomUUID();
    const channelSequence = nextChannelSequence(this.ctx.storage, channel.id);
    insertMessage(this.ctx.storage, {
      id: messageId, channelId: channel.id, threadRootId,
      authorKind: "agent", authorId: agent.id, authorDisplaySnapshot: agent.handle,
      bodyMarkdown: body, channelSequence, now,
    });
    this.broadcastChannelEvent(channel, channelSequence, "message.created", {
      messageId, channelId: channel.id, threadRootId, authorKind: "agent", authorId: agent.id,
      authorDisplaySnapshot: agent.handle, bodyMarkdown: body, createdAt: now,
    });
    return { channelId: channel.id, messageId };
  }

  /** Write the answer into every copy of the card, as a reply to that copy. */
  private postVaultApprovalAnswer(approvalId: string, body: string, now: number): void {
    const copies = this.ctx.storage.sql.exec<{ member_id: string; card_message_id: string | null }>(
      "SELECT member_id, card_message_id FROM vault_approval_approvers WHERE approval_id = ?", approvalId,
    ).toArray();
    for (const copy of copies) this.postVaultMessage(copy.member_id, body, copy.card_message_id, now);
  }

  private announceVaultKillSwitch(
    scope: KillSwitchScope,
    off: boolean,
    actor: ActiveMember,
    revokedGrants: number,
    now: number,
  ): void {
    const body = killSwitchAnnouncement({ scope, off, actorHandle: actor.handle, revokedGrants });
    // Everyone who could be surprised by the change hears about it: a switch
    // that flips silently produces an hour of mysterious agent failures.
    for (const member of this.ctx.storage.sql.exec<{ id: string }>(
      "SELECT id FROM members WHERE status = 'active'",
    ).toArray()) {
      this.postVaultMessage(member.id, body, null, now);
    }
  }

  /* -------------------------------------------------------------------- */
  /* Vault and agent activity (V04)                                        */
  /* -------------------------------------------------------------------- */

  /**
   * The grants that are live right now, with a countdown and who holds them.
   *
   * Only for credentials this member can already see, so the list never
   * discloses that a credential exists. Each row names the three parties
   * separately — the member the grant is for, the agent operating under it, and
   * whoever approved it — because "who has this" and "who let them" are
   * different questions and a log that blurs them is no use in an incident.
   */
  listVaultGrants(input: {
    actor: Actor;
    credentialId?: string;
    agentId?: string;
    now: number;
  }): { grants: readonly VaultGrantRow[] } {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const rows = this.ctx.storage.sql.exec<{
      id: string; credential_id: string; member_id: string; device_id: string; project_id: string;
      agent_id: string | null; delegation_id: string | null; delivery: VaultDelivery;
      expires_at: number | null; remaining_uses: number | null; approved_by_member_id: string; created_at: number;
      name: string;
    }>(
      `SELECT g.id, g.credential_id, g.member_id, g.device_id, g.project_id, g.agent_id, g.delegation_id,
              g.delivery, g.expires_at, g.remaining_uses, g.approved_by_member_id, g.created_at, c.name
       FROM vault_grants g JOIN vault_credentials c ON c.id = g.credential_id
       WHERE g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > ?)
         AND (g.remaining_uses IS NULL OR g.remaining_uses > 0)
       ORDER BY g.created_at DESC LIMIT 200`,
      input.now,
    ).toArray();

    return {
      grants: rows
        .filter((row) => input.credentialId === undefined || row.credential_id === input.credentialId)
        .filter((row) => input.agentId === undefined || row.agent_id === input.agentId)
        .filter((row) => this.vaultCanDiscover(row.credential_id, actor.id))
        .map((row) => ({
          grantId: row.id,
          credentialId: row.credential_id,
          credentialName: row.name,
          memberId: row.member_id,
          memberHandle: this.memberHandle(row.member_id),
          agentId: row.agent_id,
          agentHandle: row.agent_id === null ? null : (readAgent(this.ctx.storage, row.agent_id)?.handle ?? null),
          approverMemberId: row.approved_by_member_id,
          approverHandle: this.memberHandle(row.approved_by_member_id),
          deviceId: row.device_id,
          projectId: row.project_id,
          delivery: row.delivery,
          expiresAt: row.expires_at,
          // A grant with no expiry is spent by one use; the UI says so rather
          // than showing a countdown that would never move.
          singleUse: row.expires_at === null,
          createdAt: row.created_at,
          viewerMayRevoke: this.mayRevokeVaultGrant(actor, row.member_id, row.credential_id),
        })),
    };
  }

  /**
   * Take one grant back.
   *
   * No step-up, and deliberately wide: the credential's managers, an admin, and
   * the person the grant was issued to may all revoke it. Making somebody find
   * the right owner before they can close a hole is how holes stay open.
   */
  async revokeVaultGrant(input: { actor: Actor; grantId: string; now: number }): Promise<{ revoked: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const row = this.ctx.storage.sql.exec<{ credential_id: string; member_id: string; revoked_at: number | null }>(
      "SELECT credential_id, member_id, revoked_at FROM vault_grants WHERE id = ?", input.grantId,
    ).toArray()[0];
    // Reported as missing rather than forbidden when the member cannot see the
    // credential at all, the same as a room they are not in.
    if (row === undefined || !this.vaultCanDiscover(row.credential_id, actor.id)) throw new Error("grant not found");
    if (!this.mayRevokeVaultGrant(actor, row.member_id, row.credential_id)) throw new Error("grant not found");
    if (row.revoked_at !== null) return { revoked: false };

    const outcome = await this.commitMutation({ scope: "vault.grant.revoke", now: input.now }, () => {
      this.revokeVaultGrants("revoked_by_member", input.now, "id = ?", input.grantId);
      return {
        result: { revoked: true },
        effects: this.vaultEffects("vault.grant_revoked", row.credential_id, actor, {
          grant_id: input.grantId, subject_member_id: row.member_id,
        }),
      };
    });
    return outcome.result;
  }

  /**
   * One credential's page: what it is, what it permits, and who may do what.
   *
   * Metadata and policy only. There is no field on this result for ciphertext,
   * a wrap or a value, so no future caller can accidentally serialise one.
   */
  describeVaultCredential(input: { actor: Actor; credentialId: string; now: number }): VaultCredentialDetail {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const row = this.readVaultCredential(input.credentialId);
    if (row === null || !this.vaultCanDiscover(row.id, actor.id)) throw new Error("vault credential not found");
    const scope = (verb: "use" | "reveal" | "manage") =>
      this.ctx.storage.sql.exec<{ subject_type: VaultAclEntry["subjectType"]; subject_id: string }>(
        "SELECT subject_type, subject_id FROM vault_credential_acl WHERE credential_id = ? AND verb = ? ORDER BY subject_type, subject_id",
        row.id, verb,
      ).toArray().map((entry) => ({
        subjectType: entry.subject_type,
        subjectId: entry.subject_id,
        label: this.vaultSubjectLabel(entry.subject_type, entry.subject_id),
      }));

    return {
      credential: this.vaultSummary(row),
      frozen: row.frozen_at !== null,
      frozenAt: row.frozen_at,
      frozenByHandle: row.frozen_by_member_id === null ? null : this.memberHandle(row.frozen_by_member_id),
      // A captured credential is switched off until somebody has seen what
      // produced it, which is a different state from one a human switched off.
      awaitingCaptureReview: row.frozen_reason === "awaiting_capture_review",
      capturedFrom: row.captured_from,
      rotation: rotationState(row.rotate_at ?? undefined, input.now),
      createdByHandle: this.memberHandle(row.created_by_member_id),
      use: scope("use"),
      reveal: scope("reveal"),
      manage: scope("manage"),
      viewer: {
        mayUse: this.vaultHasAcl(row.id, actor.id, undefined, undefined, "use"),
        mayReveal: this.vaultHasAcl(row.id, actor.id, undefined, undefined, "reveal"),
        mayManage: this.vaultHasAcl(row.id, actor.id, undefined, undefined, "manage"),
      },
    };
  }

  /**
   * What has happened to a credential, or to an agent's use of credentials.
   *
   * Assembled from the durable records rather than from the audit chain, so a
   * reader sees the same facts the authorization path acted on. Every row keeps
   * the requester, the operating owner and the approver in separate fields; the
   * value has never been in any of these tables and cannot appear here.
   */
  listVaultActivity(input: {
    actor: Actor;
    credentialId?: string;
    agentId?: string;
    limit?: number;
    now: number;
  }): { activity: readonly VaultActivityRow[] } {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const visible = (credentialId: string) =>
      (input.credentialId === undefined || credentialId === input.credentialId)
      && this.vaultCanDiscover(credentialId, actor.id);

    const rows: VaultActivityRow[] = [];
    for (const use of this.ctx.storage.sql.exec<{
      credential_id: string; member_id: string; device_id: string; project_id: string; agent_id: string | null;
      delivery: VaultDelivery; used_at: number; grant_id: string | null; name: string; approved_by_member_id: string | null;
    }>(
      `SELECT u.credential_id, u.member_id, u.device_id, u.project_id, u.agent_id, u.delivery, u.used_at, u.grant_id,
              c.name, g.approved_by_member_id
       FROM vault_usage_events u JOIN vault_credentials c ON c.id = u.credential_id
       LEFT JOIN vault_grants g ON g.id = u.grant_id
       ORDER BY u.used_at DESC LIMIT ?`, limit * 2,
    ).toArray()) {
      if (!visible(use.credential_id)) continue;
      if (input.agentId !== undefined && use.agent_id !== input.agentId) continue;
      rows.push({
        kind: "used", at: use.used_at, credentialId: use.credential_id, credentialName: use.name,
        delivery: use.delivery, deviceId: use.device_id, projectId: use.project_id,
        memberId: use.member_id, memberHandle: this.memberHandle(use.member_id),
        agentId: use.agent_id, agentHandle: use.agent_id === null ? null : (readAgent(this.ctx.storage, use.agent_id)?.handle ?? null),
        approverHandle: use.approved_by_member_id === null ? null : this.memberHandle(use.approved_by_member_id),
        detail: use.grant_id === null ? "automatic" : "under a grant",
      });
    }

    for (const approval of this.ctx.storage.sql.exec<VaultApprovalRow>(
      "SELECT * FROM vault_approvals ORDER BY created_at DESC LIMIT ?", limit * 2,
    ).toArray()) {
      const items = this.readVaultApprovalItems(approval.id);
      for (const item of items) {
        if (!visible(item.credential_id)) continue;
        if (input.agentId !== undefined && approval.agent_id !== input.agentId) continue;
        rows.push({
          kind: approval.status === "pending" ? "asked" : approval.status === "expired" ? "timed_out" : "decided",
          at: approval.decided_at ?? approval.created_at,
          credentialId: item.credential_id, credentialName: item.name,
          delivery: approval.delivery, deviceId: approval.device_id, projectId: approval.project_id,
          memberId: approval.requester_member_id, memberHandle: this.memberHandle(approval.requester_member_id),
          agentId: approval.agent_id,
          agentHandle: approval.agent_id === null ? null : (readAgent(this.ctx.storage, approval.agent_id)?.handle ?? null),
          approverHandle: approval.decided_by_member_id === null ? null : this.memberHandle(approval.decided_by_member_id),
          // The reason is the requester's own words, which is the whole point of
          // making it mandatory.
          detail: approval.reason,
          ...(item.outcome === null ? {} : { outcome: item.outcome }),
        });
      }
    }

    return { activity: rows.sort((left, right) => right.at - left.at).slice(0, limit) };
  }

  /**
   * One agent's page, including what it may do with credentials.
   *
   * Somebody else's agent is reported as missing rather than forbidden, the
   * same as everywhere else an agent is addressed.
   */
  describeAgent(input: { actor: Actor; agentId: string; now: number }): AgentDetail {
    const actor = this.authorizeActor(input.actor);
    const agent = readAgent(this.ctx.storage, input.agentId);
    if (agent === null || agent.status === "archived") throw new Error("agent not found");
    const owners = this.ctx.storage.sql.exec<{ member_id: string }>(
      "SELECT member_id FROM agent_owners WHERE agent_id = ? ORDER BY member_id", agent.id,
    ).toArray().map((row) => row.member_id);
    const scope = this.agentScope(agent);
    return {
      id: agent.id,
      handle: agent.handle,
      displayName: agent.displayName,
      description: agent.description,
      status: agent.status,
      vaultAccessOff: agent.vaultAccessOffAt !== null,
      vaultAccessOffAt: agent.vaultAccessOffAt,
      isOwner: owners.includes(actor.id),
      ownerHandles: owners.map((memberId) => this.memberHandle(memberId)),
      scopeMode: scope.mode,
      // Only the scoped rooms this reader may see, the same rule the directory
      // already uses: a private room in a scope is not disclosed by listing it.
      scopeChannelIds:
        scope.mode === "listed"
          ? scope.channelIds.filter((channelId) => {
              const channel = readChannel(this.ctx.storage, channelId);
              return channel !== null && canSeeChannel(this.channelVisibility(channel, actor.id));
            })
          : [],
      scopeChannelCount: scope.mode === "listed" ? scope.channelIds.length : 0,
    };
  }

  private memberHandle(memberId: string): string {
    return (
      this.ctx.storage.sql
        .exec<{ handle: string }>("SELECT handle FROM members WHERE id = ?", memberId)
        .toArray()[0]?.handle ?? memberId
    );
  }

  private vaultSubjectLabel(subjectType: VaultAclEntry["subjectType"], subjectId: string): string {
    switch (subjectType) {
      case "member":
        return `@${this.memberHandle(subjectId)}`;
      case "agent":
        return `@${readAgent(this.ctx.storage, subjectId)?.handle ?? subjectId}`;
      case "group":
        return `@${this.ctx.storage.sql.exec<{ handle: string }>("SELECT handle FROM groups WHERE id = ?", subjectId).toArray()[0]?.handle ?? subjectId}`;
      case "channel":
        return `#${readChannel(this.ctx.storage, subjectId)?.slug ?? subjectId}`;
    }
  }

  /** Managers, admins, and the person the grant is for. */
  private mayRevokeVaultGrant(actor: ActiveMember, grantMemberId: string, credentialId: string): boolean {
    return (
      actor.role === "owner"
      || actor.role === "admin"
      || grantMemberId === actor.id
      || this.vaultHasAcl(credentialId, actor.id, undefined, undefined, "manage")
    );
  }

  /* -- agent helpers ---------------------------------------------------- */

  private readVaultCredential(id: string): VaultCredentialRow | null {
    return this.ctx.storage.sql.exec<VaultCredentialRow>("SELECT * FROM vault_credentials WHERE id = ?", id).toArray()[0] ?? null;
  }

  private requireVaultCredential(id: string): VaultCredentialRow {
    const row = this.readVaultCredential(id);
    if (row === null) throw new Error("vault credential not found");
    return row;
  }

  private vaultPolicy(row: VaultCredentialRow): VaultPolicy {
    return {
      mode: row.mode,
      allowedDeliveries: JSON.parse(row.allowed_deliveries_json) as VaultDelivery[],
      projectIds: JSON.parse(row.project_ids_json) as string[],
      ...(row.grant_ttl_ms === null ? {} : { grantTtlMs: row.grant_ttl_ms }),
      ...(row.available_until === null ? {} : { availableUntil: row.available_until }),
      ...(row.max_uses_per_hour === null ? {} : { maxUsesPerHour: row.max_uses_per_hour }),
      highRisk: row.high_risk === 1,
    };
  }

  private vaultSummary(row: VaultCredentialRow): VaultCredentialSummary {
    return {
      id: row.id, name: row.name, description: row.description,
      ...(row.env_var === null ? {} : { envVar: row.env_var }),
      tags: JSON.parse(row.tags_json) as string[], commands: JSON.parse(row.commands_json) as string[], proxyHosts: JSON.parse(row.proxy_hosts_json) as string[],
      kind: row.kind, fields: JSON.parse(row.fields_json) as string[],
      ...(row.rotate_at === null ? {} : { rotateAt: row.rotate_at }),
      policy: this.vaultPolicy(row), version: row.version, keyEpoch: row.key_epoch, policyEpoch: row.policy_epoch,
      // Whether it is a canary, never the marker that identifies one: a listing
      // is metadata for planning, and the marker belongs with the scan targets
      // a device asks for deliberately.
      canary: row.canary_marker !== null,
      createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.last_accessed_at === null ? {} : { lastAccessedAt: row.last_accessed_at }), accessCount: row.access_count,
    };
  }

  private vaultEnvelope(row: VaultCredentialRow): VaultCiphertextEnvelope {
    return { cipherSuite: row.cipher_suite, aadVersion: row.aad_version, version: row.version, keyEpoch: row.key_epoch, iv: row.iv, ciphertext: row.ciphertext };
  }

  /**
   * Write one grant row. Shared by the direct issue path and by an approval
   * being answered, so a grant means the same thing however it came to exist —
   * including that a grant with no expiry is spent by a single use.
   */
  private insertVaultGrant(input: {
    row: VaultCredentialRow;
    memberId: string;
    deviceId: string;
    projectId: string;
    delivery: VaultDelivery;
    agentId?: string;
    delegationId?: string;
    originChannelId: string;
    originMessageId: string;
    expiresAt?: number;
    approverMemberId: string;
    now: number;
  }): string {
    const grantId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO vault_grants(id, credential_id, credential_version, policy_epoch, access_epoch, member_id, device_id,
        project_id, agent_id, delegation_id, delivery, origin_channel_id, expires_at, remaining_uses,
        origin_message_id, approved_by_member_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      grantId, input.row.id, input.row.version, input.row.policy_epoch, this.vaultSettings().access_epoch,
      input.memberId, input.deviceId, input.projectId, input.agentId ?? null, input.delegationId ?? null,
      input.delivery, input.originChannelId, input.expiresAt ?? null, input.expiresAt === undefined ? 1 : null,
      input.originMessageId, input.approverMemberId, input.now,
    );
    return grantId;
  }

  private readVaultProxy(id: string): VaultProxyRequestRow | null {
    return this.ctx.storage.sql
      .exec<VaultProxyRequestRow>("SELECT * FROM vault_proxy_requests WHERE id = ?", id)
      .toArray()[0] ?? null;
  }

  private readVaultProxyByIdempotency(idempotencyKey: string): VaultProxyRequestRow | null {
    return this.ctx.storage.sql
      .exec<VaultProxyRequestRow>("SELECT * FROM vault_proxy_requests WHERE idempotency_key = ?", idempotencyKey)
      .toArray()[0] ?? null;
  }

  private vaultProxyResult(row: VaultProxyRequestRow, now: number): VaultProxyRequestResult {
    if (row.state === "pending" && row.expires_at <= now) {
      this.ctx.storage.sql.exec(
        "UPDATE vault_proxy_requests SET state = 'uncertain', completed_at = ?, result_json = ? WHERE id = ? AND state = 'pending'",
        now, JSON.stringify({ error: "proxy result was not confirmed before its deadline" }), row.id,
      );
      return { state: "uncertain", requestId: row.id, error: "the release device did not confirm whether the request completed" };
    }
    if (row.state === "pending") return { state: "pending", requestId: row.id, expiresAt: row.expires_at };
    const stored = row.result_json === null ? {} : JSON.parse(row.result_json) as { result?: VaultProxyResult; error?: string };
    if (row.state === "completed" && stored.result !== undefined) {
      return { state: "completed", requestId: row.id, result: validateVaultProxyResult(stored.result) };
    }
    if (row.state === "completed") throw new Error("completed proxy request has no result");
    return { state: row.state, requestId: row.id, error: stored.error ?? "the proxy request was refused" };
  }

  /**
   * V06 initially uses the enrolled runner device that published this member's
   * vault wrapping key. V07 may add more device wraps; until then, selecting a
   * different online device would produce a request it cannot decrypt.
   */
  private selectVaultReleaseDevice(memberId: string): { deviceId: string; publicKey: string } | null {
    const row = this.ctx.storage.sql.exec<{ device_id: string; public_key: string }>(
      `SELECT k.device_id, k.public_key
       FROM vault_member_keys k JOIN runner_devices d ON d.device_id = k.device_id AND d.member_id = k.member_id
       WHERE k.member_id = ?`,
      memberId,
    ).toArray()[0];
    if (row === undefined || this.ctx.getWebSockets(runnerSocketTag(row.device_id)).length === 0) return null;
    return { deviceId: row.device_id, publicKey: row.public_key };
  }

  private readVaultMemberKey(memberId: string): VaultMemberKey | null {
    const row = this.ctx.storage.sql.exec<{ member_id: string; key_epoch: number; wrap_suite: string; public_key: string }>(
      "SELECT member_id, key_epoch, wrap_suite, public_key FROM vault_member_keys WHERE member_id = ?", memberId,
    ).toArray()[0];
    return row === undefined ? null : { memberId: row.member_id, keyEpoch: row.key_epoch, wrapSuite: row.wrap_suite, publicKey: row.public_key };
  }

  private readVaultWraps(credentialId: string, version: number): VaultKeyWrap[] {
    return this.ctx.storage.sql.exec<{
      custodian_member_id: string; recipient_key_epoch: number; wrap_suite: string; ephemeral_public_key: string; iv: string; wrapped_dek: string;
    }>(
      `SELECT custodian_member_id, recipient_key_epoch, wrap_suite, ephemeral_public_key, iv, wrapped_dek
       FROM vault_credential_key_wraps WHERE credential_id = ? AND credential_version = ? ORDER BY custodian_member_id`, credentialId, version,
    ).toArray().map((row) => ({ custodianMemberId: row.custodian_member_id, recipientKeyEpoch: row.recipient_key_epoch, wrapSuite: row.wrap_suite, ephemeralPublicKey: row.ephemeral_public_key, iv: row.iv, wrappedDek: row.wrapped_dek }));
  }

  private insertVaultCredential(id: string, creatorId: string, metadata: VaultCredentialMetadata, policy: VaultPolicy, envelope: VaultCiphertextEnvelope, wraps: readonly VaultKeyWrap[], acl: readonly VaultAclEntry[], now: number, capturedFrom: string | null = null, scan: { digest: string; length: number } | null = null, canaryMarker: string | null = null): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO vault_credentials(id, name, description, env_var, tags_json, commands_json, proxy_hosts_json,
       cipher_suite, aad_version, ciphertext, iv, key_epoch, version, policy_epoch, mode, allowed_deliveries_json,
       project_ids_json, grant_ttl_ms, available_until, max_uses_per_hour, high_risk, created_by_member_id, created_at, updated_at,
       kind, fields_json, rotate_at, frozen_at, frozen_reason, captured_from, scan_digest, scan_length, canary_marker)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, metadata.name, metadata.description, metadata.envVar ?? null, JSON.stringify(metadata.tags), JSON.stringify(metadata.commands), JSON.stringify(metadata.proxyHosts),
      envelope.cipherSuite, envelope.aadVersion, envelope.ciphertext, envelope.iv, envelope.keyEpoch, envelope.version, policy.mode,
      JSON.stringify(policy.allowedDeliveries), JSON.stringify(policy.projectIds), policy.grantTtlMs ?? null, policy.availableUntil ?? null,
      policy.maxUsesPerHour ?? null, policy.highRisk ? 1 : 0, creatorId, now, now,
      metadata.kind ?? "opaque", JSON.stringify(metadata.fields ?? []), metadata.rotateAt ?? null,
      // A captured credential arrives switched off. Nothing can use it until a
      // custodian has seen what produced it and turned it on, which is what
      // makes an agent-initiated write safe to have at all.
      capturedFrom === null ? null : now, capturedFrom === null ? null : "awaiting_capture_review", capturedFrom,
      scan?.digest ?? null, scan?.length ?? null, canaryMarker,
    );
    this.insertVaultWrapsAndAcl(id, envelope.version, wraps, acl, now);
  }

  private insertVaultWrapsAndAcl(id: string, version: number, wraps: readonly VaultKeyWrap[], acl: readonly VaultAclEntry[], now: number): void {
    for (const wrap of wraps) this.ctx.storage.sql.exec(
      `INSERT INTO vault_credential_key_wraps(credential_id, credential_version, custodian_member_id, recipient_key_epoch, wrap_suite, ephemeral_public_key, iv, wrapped_dek, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, version, wrap.custodianMemberId, wrap.recipientKeyEpoch, wrap.wrapSuite, wrap.ephemeralPublicKey, wrap.iv, wrap.wrappedDek, now,
    );
    for (const entry of acl) this.ctx.storage.sql.exec(
      "INSERT INTO vault_credential_acl(credential_id, subject_type, subject_id, verb, created_at) VALUES (?, ?, ?, ?, ?)",
      id, entry.subjectType, entry.subjectId, entry.verb, now,
    );
  }

  private requireVaultManager(credentialId: string, memberId: string): void {
    if (!this.vaultHasAcl(credentialId, memberId, undefined, undefined, "manage")) throw new Error("vault credential not found");
  }

  private requireVaultStepUp(fresh: boolean, unlocked: boolean): void {
    if (!fresh) throw new Error("fresh user verification is required");
    if (!unlocked) throw new Error("the local vault must be unlocked");
  }

  private vaultHasAcl(credentialId: string, memberId: string, agentId: string | undefined, channelId: string | undefined, verb: VaultAclEntry["verb"]): boolean {
    const groups = this.ctx.storage.sql.exec<{ group_id: string }>("SELECT group_id FROM group_members WHERE member_id = ?", memberId).toArray().map((row) => row.group_id);
    const entries = this.ctx.storage.sql.exec<{ subject_type: VaultAclEntry["subjectType"]; subject_id: string }>(
      "SELECT subject_type, subject_id FROM vault_credential_acl WHERE credential_id = ? AND verb = ?", credentialId, verb,
    ).toArray();
    return entries.some((entry) =>
      (entry.subject_type === "member" && entry.subject_id === memberId)
      || (entry.subject_type === "group" && groups.includes(entry.subject_id))
      || (entry.subject_type === "agent" && entry.subject_id === agentId)
      || (entry.subject_type === "channel" && entry.subject_id === channelId));
  }

  private vaultCanDiscover(credentialId: string, memberId: string, agentId?: string, channelId?: string): boolean {
    return (["use", "reveal", "manage"] as const).some((verb) => this.vaultHasAcl(credentialId, memberId, agentId, channelId, verb));
  }

  /* -------------------------------------------------------------------- */
  /* Scan targets and canaries (V08)                                       */
  /* -------------------------------------------------------------------- */

  /**
   * What a device may compare its own text against — `lepidy scan` and the
   * `PreToolUse` hook behind it.
   *
   * A digest and a length, never a value and never a wrap. The client walks its
   * text a window at a time and matches locally, which is the only shape that
   * answers "does this file contain a secret" without the secret leaving the
   * vault.
   *
   * Two limits are deliberate and are stated in the product's own words rather
   * than implied. It finds an **exact whole unencoded value**: a base64'd or
   * line-split secret goes straight through, because one hash per value cannot
   * detect a substring. And a digest is a **verifier**, so it is served only to
   * a member who already holds a verb on that credential, and a credential
   * whose client chose not to publish one simply has no target here.
   */
  listVaultScanTargets(input: { actor: Actor; now: number }): { targets: readonly VaultScanTarget[] } {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    // Deliberately independent of the agent-access switch: refusing to say what
    // a leak looks like because agents are switched off would disable the
    // detector at exactly the moment somebody is investigating one.
    return {
      targets: this.ctx.storage.sql
        .exec<VaultCredentialRow>("SELECT * FROM vault_credentials ORDER BY name COLLATE NOCASE, id")
        .toArray()
        .filter((row) => this.vaultCanDiscover(row.id, actor.id))
        .filter((row) => row.scan_digest !== null || row.canary_marker !== null)
        .map((row) => ({
          credentialId: row.id,
          name: row.name,
          digest: row.scan_digest,
          length: row.scan_length,
          canaryMarker: row.canary_marker,
        })),
    };
  }

  /** Every canary this workspace holds, as public markers. */
  private readCanaryMarkers(): readonly { credentialId: string; name: string; marker: string }[] {
    return this.ctx.storage.sql
      .exec<{ id: string; name: string; canary_marker: string }>(
        "SELECT id, name, canary_marker FROM vault_credentials WHERE canary_marker IS NOT NULL",
      )
      .toArray()
      .map((row) => ({ credentialId: row.id, name: row.name, marker: row.canary_marker }));
  }

  /**
   * Refuse a write that carries a canary, and tell the people who own it.
   *
   * This runs before anything is written, so the tripwire prevents the leak it
   * detects rather than merely recording it. The trip itself is committed in
   * its own transaction and the refusal is thrown afterwards: an alert that
   * disappeared because the operation it describes failed would be useless.
   *
   * It is not a general secret detector. It finds the fake credential that
   * exists to be found, which is why it costs one substring search and needs no
   * key. A real credential leaving through the same path is caught by the
   * client-side scan, the injection scrubber, or not at all.
   */
  private refuseCanaryContent(
    text: string,
    context: { surface: "message" | "mcp_message" | "proxy_request"; memberId: string | null; agentId: string | null; channelId: string | null; now: number },
  ): void {
    const hits = findCanaryMarkers(text, this.readCanaryMarkers());
    if (hits.length === 0) return;
    this.ctx.storage.transactionSync(() => {
      for (const hit of hits) {
        this.ctx.storage.sql.exec(
          `INSERT INTO vault_canary_trips(id, credential_id, surface, member_id, agent_id, channel_id, detected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          crypto.randomUUID(), hit.credentialId, context.surface, context.memberId, context.agentId, context.channelId, context.now,
        );
        // Custodians, because they are the people who can rotate whatever else
        // travelled the same route. No body and no excerpt in the message: the
        // alert says what tripped and where, not what the text said.
        const body =
          `**${hit.name} tripped.** A canary credential appeared in a ${context.surface.replace("_", " ")}, so something carried ` +
          "a credential out of the injection path. The write was refused. Nothing legitimate ever sends a canary — check the " +
          "agent's recent activity and rotate anything that shares its route.";
        for (const custodian of this.ctx.storage.sql.exec<{ subject_id: string }>(
          "SELECT subject_id FROM vault_credential_acl WHERE credential_id = ? AND verb = 'manage' AND subject_type = 'member'",
          hit.credentialId,
        ).toArray()) {
          this.postVaultMessage(custodian.subject_id, body, null, context.now);
        }
        appendAuditEntry(this.ctx.storage, this.workspaceKey(), {
          eventType: "vault.canary_tripped",
          outcome: "denied",
          requesterKind: context.agentId === null ? "member" : "agent",
          requesterId: context.agentId ?? context.memberId,
          operatingOwnerId: context.memberId,
          subjectKind: "vault_item",
          subjectId: hit.credentialId,
          metadata: { surface: context.surface, channel_id: context.channelId, agent_id: context.agentId },
        }, context.now);
      }
    });
    throw new Error(canaryRefusalHint(hits.map((hit) => hit.name)));
  }

  private vaultScope(credentialId: string, verb: "use" | "reveal"): VaultScope {
    const scope: { members: string[]; groups: string[]; agents: string[]; channels: string[] } = { members: [], groups: [], agents: [], channels: [] };
    const plural = { member: "members", group: "groups", agent: "agents", channel: "channels" } as const;
    for (const row of this.ctx.storage.sql.exec<{ subject_type: keyof typeof plural; subject_id: string }>(
      "SELECT subject_type, subject_id FROM vault_credential_acl WHERE credential_id = ? AND verb = ?", credentialId, verb,
    ).toArray()) scope[plural[row.subject_type]].push(row.subject_id);
    return scope;
  }

  private vaultSettings(): { enabled: boolean; access_epoch: number } {
    const row = this.ctx.storage.sql.exec<{ agent_access_on: number; access_epoch: number }>("SELECT agent_access_on, access_epoch FROM vault_settings WHERE singleton = 1").one();
    return { enabled: row.agent_access_on === 1, access_epoch: row.access_epoch };
  }

  private evaluateVaultAccess(input: VaultAccessRequest, actor: ActiveMember): { decision: VaultDecision; row: VaultCredentialRow | null; grantId: string | null; retryAfter?: number } {
    const row = this.readVaultCredential(input.credentialId);
    if (row === null) return { decision: { kind: "deny", reason: "credential_inactive" }, row: null, grantId: null };
    const settings = this.vaultSettings();
    const channel = readChannel(this.ctx.storage, input.origin.channelId);
    const message = readMessage(this.ctx.storage, input.origin.messageId);
    const originVerified = channel !== null && message !== null && message.channelId === input.origin.channelId;
    const memberCanAccess = channel !== null && canSeeChannel(this.channelVisibility(channel, actor.id));
    const policy = this.vaultPolicy(row);
    const groupIds = this.ctx.storage.sql.exec<{ group_id: string }>("SELECT group_id FROM group_members WHERE member_id = ?", actor.id).toArray().map((item) => item.group_id);
    const windowStart = input.now - 60 * 60 * 1_000;
    const usage = this.ctx.storage.sql.exec<{ count: number; first_used_at: number | null }>(
      "SELECT COUNT(*) AS count, MIN(used_at) AS first_used_at FROM vault_usage_events WHERE credential_id = ? AND used_at > ?", row.id, windowStart,
    ).one();
    let delegationInput: Parameters<typeof decideVaultAuthorization>[0]["delegation"];
    // The switch answers only for an agent that exists. An agent that does not
    // is still refused, one step later and for the accurate reason: it has no
    // live delegation. Reporting it as "switched off" would send whoever is
    // debugging to a control nobody touched.
    let agentVaultAccessOff = false;
    if (input.agentId !== undefined) {
      const delegation = input.delegationId === undefined ? null : this.readAgentDelegation(input.delegationId);
      const agent = readAgent(this.ctx.storage, input.agentId);
      agentVaultAccessOff = agent !== null && agent.vaultAccessOffAt !== null;
      delegationInput = {
        active: delegation !== null && delegation.revokedAt === null && input.now < delegation.expiresAt && agent?.status === "active",
        ownerIsMember: delegation?.ownerMemberId === actor.id && delegation.ownerAuthorizationEpoch === input.actor.authorizationEpoch,
        agentMatches: delegation?.agentId === input.agentId,
        channelAllowed: delegation !== null && delegationAllowsChannel(delegation.channelIds, input.origin.channelId),
        credentialAllowed: delegation?.credentialIds.includes(row.id) ?? false,
        deliveryAllowed: delegation?.deliveryModes.includes(input.delivery) ?? false,
        projectAllowed: delegation?.projectIds.includes(input.projectId) ?? false,
      };
    }
    const grant = this.ctx.storage.sql.exec<{ id: string }>(
      `SELECT id FROM vault_grants WHERE credential_id = ? AND credential_version = ? AND policy_epoch = ? AND access_epoch = ?
       AND member_id = ? AND device_id = ? AND project_id = ? AND agent_id IS ? AND delegation_id IS ? AND delivery = ?
       AND origin_channel_id = ? AND origin_message_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       AND (remaining_uses IS NULL OR remaining_uses > 0) ORDER BY created_at DESC LIMIT 1`,
      row.id, row.version, row.policy_epoch, settings.access_epoch, actor.id, input.device.id, input.projectId,
      input.agentId ?? null, input.delegationId ?? null, input.delivery, input.origin.channelId, input.origin.messageId, input.now,
    ).toArray()[0] ?? null;
    const decision = decideVaultAuthorization({
      now: input.now, workspaceAccessOn: input.agentId === undefined || settings.enabled,
      member: { id: actor.id, active: true, authorizationEpochCurrent: true, groupIds },
      device: input.device,
      origin: { verified: originVerified, channelId: input.origin.channelId, memberCanAccess },
      credential: { active: true, frozen: row.frozen_at !== null, mode: policy.mode, use: this.vaultScope(row.id, "use"), reveal: this.vaultScope(row.id, "reveal"),
        allowedDeliveries: policy.allowedDeliveries, projectAllowed: policy.projectIds.length === 0 || policy.projectIds.includes(input.projectId),
        ...(policy.availableUntil === undefined ? {} : { availableUntil: policy.availableUntil }),
        rateAvailable: policy.maxUsesPerHour === undefined || usage.count < policy.maxUsesPerHour },
      request: {
        delivery: input.delivery,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId, agentVaultAccessOff }),
      },
      ...(delegationInput === undefined ? {} : { delegation: delegationInput }), grantMatchesExactly: grant !== null,
    });
    return { decision, row, grantId: grant?.id ?? null, ...(usage.first_used_at === null ? {} : { retryAfter: usage.first_used_at + 60 * 60 * 1_000 }) };
  }

  private revokeVaultGrants(reason: string, now: number, predicate: string, ...values: (string | number)[]): void {
    this.ctx.storage.sql.exec(`UPDATE vault_grants SET revoked_at = ?, revoked_reason = ? WHERE revoked_at IS NULL AND ${predicate}`, now, reason, ...values);
  }

  private vaultEffects(eventType: string, credentialId: string, actor: ActiveMember, metadata: Record<string, string | number | boolean | null>): MutationEffects {
    return { audit: { eventType, outcome: "allowed", requesterKind: "member", requesterId: actor.id, subjectKind: "vault_item", subjectId: credentialId, metadata } };
  }

  private agentScope(agent: AgentRow): AgentScope {
    return agent.scopeMode === "any"
      ? { mode: "any" }
      : { mode: "listed", channelIds: agentScopeChannelIds(this.ctx.storage, agent.id) };
  }

  /**
   * An agent an owner may administer. Somebody else's agent is reported as
   * missing rather than forbidden, the same as a room they cannot see.
   */
  private requireOwnedAgent(agentId: string, memberId: string): AgentRow {
    const agent = readAgent(this.ctx.storage, agentId);
    if (agent === null) throw new Error("agent not found");
    if (!agentOwnerIds(this.ctx.storage, agent.id).includes(memberId)) {
      throw new Error("agent not found");
    }
    return agent;
  }

  private requireOwnedAgentArgument(agentArgument: string, memberId: string): AgentRow {
    const normalized = agentArgument.startsWith("@") ? agentArgument.slice(1) : agentArgument;
    const agent = normalized.startsWith("a.")
      ? readAgentByHandle(this.ctx.storage, normalized)
      : readAgent(this.ctx.storage, normalized);
    if (agent === null || !agentOwnerIds(this.ctx.storage, agent.id).includes(memberId)) {
      throw new Error("agent not found");
    }
    return agent;
  }

  private requireLiveMcpConnection(connectionId: string, memberId: string): void {
    const connection = readOauthConnection(this.ctx.storage, connectionId);
    if (connection === null || connection.revokedAt !== null || connection.memberId !== memberId) {
      throw new Error("MCP connection is no longer active");
    }
  }

  private async authorizeAgentToolCredential(input: {
    actor: Actor;
    agentId: string;
    connectionId?: string | null;
    sessionToken?: string | null;
    toolName: McpToolName;
    now: number;
  }): Promise<AgentToolCredential> {
    if (input.sessionToken) {
      const authenticated = await this.authenticateMcpToken({
        token: input.sessionToken,
        audience: "",
        now: input.now,
        toolName: input.toolName,
      });
      if (!authenticated.ok || authenticated.principal.credentialKind !== "session") {
        throw new Error(authenticated.ok ? "session token required" : authenticated.description);
      }
      const principal = authenticated.principal;
      if (
        principal.agentId !== input.agentId ||
        principal.memberId !== input.actor.memberId ||
        principal.authorizationEpoch !== input.actor.authorizationEpoch
      ) {
        throw new Error("session token does not match this agent or owner");
      }
      return {
        kind: "session",
        connectionId: null,
        sessionId: principal.sessionId,
        delegationId: principal.delegationId,
        deviceId: principal.deviceId,
        channelIds: principal.channelIds,
      };
    }
    if (!input.connectionId) throw new Error("MCP credential is required");
    this.requireLiveMcpConnection(input.connectionId, input.actor.memberId);
    return { kind: "oauth", connectionId: input.connectionId, sessionId: null, delegationId: null, deviceId: null, channelIds: null };
  }

  private readAgentDelegation(id: string): AgentDelegation | null {
    const row = this.ctx.storage.sql
      .exec<{
        id: string;
        agent_id: string;
        owner_member_id: string;
        owner_authorization_epoch: number;
        channel_ids_json: string | null;
        credential_ids_json: string;
        delivery_modes_json: string;
        project_ids_json: string;
        spend_cap_daily_cents: number | null;
        spend_cap_monthly_cents: number | null;
        rate_limit_per_hour: number | null;
        created_at: number;
        expires_at: number;
        revoked_at: number | null;
      }>(
        `SELECT id, agent_id, owner_member_id, owner_authorization_epoch,
                channel_ids_json, credential_ids_json, delivery_modes_json, project_ids_json,
                spend_cap_daily_cents, spend_cap_monthly_cents, rate_limit_per_hour,
                created_at, expires_at, revoked_at
         FROM agent_delegations WHERE id = ?`,
        id,
      )
      .toArray()[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      agentId: row.agent_id,
      ownerMemberId: row.owner_member_id,
      ownerAuthorizationEpoch: row.owner_authorization_epoch,
      channelIds: row.channel_ids_json === null ? null : (JSON.parse(row.channel_ids_json) as string[]),
      credentialIds: JSON.parse(row.credential_ids_json) as string[],
      deliveryModes: JSON.parse(row.delivery_modes_json) as string[],
      projectIds: JSON.parse(row.project_ids_json) as string[],
      spendCapDailyCents: row.spend_cap_daily_cents,
      spendCapMonthlyCents: row.spend_cap_monthly_cents,
      rateLimitPerHour: row.rate_limit_per_hour,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  }

  private requireLiveDelegation(id: string, now: number): AgentDelegation {
    const delegation = this.readAgentDelegation(id);
    if (delegation === null || delegation.revokedAt !== null || delegation.expiresAt <= now) {
      throw new Error("delegation is not active");
    }
    const owner = this.ctx.storage.sql
      .exec<{ status: string; authorization_epoch: number }>(
        "SELECT status, authorization_epoch FROM members WHERE id = ?",
        delegation.ownerMemberId,
      )
      .toArray()[0];
    if (
      owner === undefined ||
      owner.status !== "active" ||
      owner.authorization_epoch !== delegation.ownerAuthorizationEpoch ||
      !agentOwnerIds(this.ctx.storage, delegation.agentId).includes(delegation.ownerMemberId)
    ) {
      throw new Error("delegation authority is no longer current");
    }
    return delegation;
  }

  private readAgentSession(id: string): AgentSessionRow | null {
    const row = this.ctx.storage.sql
      .exec<{
        id: string;
        delegation_id: string;
        agent_id: string;
        owner_member_id: string;
        device_id: string;
        runner_epoch: number;
        preset_revision: number;
        capabilities_json: string;
        token_hash: string;
        token_expires_at: number;
        hard_expires_at: number;
        revoked_at: number | null;
      }>(
        `SELECT id, delegation_id, agent_id, owner_member_id, device_id, runner_epoch,
                preset_revision, capabilities_json, token_hash, token_expires_at,
                hard_expires_at, revoked_at
         FROM agent_sessions WHERE id = ?`,
        id,
      )
      .toArray()[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          delegationId: row.delegation_id,
          agentId: row.agent_id,
          ownerMemberId: row.owner_member_id,
          deviceId: row.device_id,
          runnerEpoch: row.runner_epoch,
          presetRevision: row.preset_revision,
          capabilities: JSON.parse(row.capabilities_json) as SessionCapability[],
          tokenHash: row.token_hash,
          tokenExpiresAt: row.token_expires_at,
          hardExpiresAt: row.hard_expires_at,
          revokedAt: row.revoked_at,
        };
  }

  private requireLiveAgentSessionById(id: string, now: number): AgentSessionRow {
    const session = this.readAgentSession(id);
    if (
      session === null ||
      session.revokedAt !== null ||
      session.tokenExpiresAt <= now ||
      session.hardExpiresAt <= now
    ) {
      throw new Error("session token is not active");
    }
    return session;
  }

  private requireLiveSessionOwner(session: AgentSessionRow, delegation: AgentDelegation): ActiveMember {
    if (
      session.delegationId !== delegation.id ||
      session.agentId !== delegation.agentId ||
      session.ownerMemberId !== delegation.ownerMemberId
    ) {
      throw new Error("session binding is invalid");
    }
    const agent = this.requireOwnedAgent(session.agentId, session.ownerMemberId);
    if (agent.status !== "active") throw new Error("agent is not active");
    return this.authorizeActor({
      memberId: session.ownerMemberId,
      authorizationEpoch: delegation.ownerAuthorizationEpoch,
    });
  }

  private requireExactAgentSessionTuple(
    session: AgentSessionRow,
    input: {
      agentId: string;
      ownerMemberId: string;
      delegationId: string;
      deviceId: string;
      runnerEpoch: number;
      presetRevision: number;
    },
    tokenHash: string,
  ): void {
    if (
      session.agentId !== input.agentId ||
      session.ownerMemberId !== input.ownerMemberId ||
      session.delegationId !== input.delegationId ||
      session.deviceId !== input.deviceId ||
      session.runnerEpoch !== input.runnerEpoch ||
      session.presetRevision !== input.presetRevision ||
      !constantTimeEquals(session.tokenHash, tokenHash)
    ) {
      throw new Error("session token binding does not match");
    }
  }

  private expireAgentClaims(agentId: string, now: number): void {
    const expired = this.ctx.storage.sql
      .exec<{ id: string; attempt_count: number; execution_started_at: number | null }>(
        `SELECT id, attempt_count, execution_started_at FROM agent_queue
         WHERE agent_id = ? AND execution_state = 'claimed' AND lease_expires_at <= ?`,
        agentId,
        now,
      )
      .toArray();
    const backoff = [5_000, 30_000, 120_000, 600_000] as const;
    for (const item of expired) {
      if (item.execution_started_at !== null) {
        this.ctx.storage.sql.exec(
          `UPDATE agent_queue SET execution_state = 'needs_attention', lease_token_hash = NULL,
             lease_expires_at = NULL WHERE id = ? AND execution_state = 'claimed'`,
          item.id,
        );
      } else if (item.attempt_count >= 5) {
        this.ctx.storage.sql.exec(
          `UPDATE agent_queue SET execution_state = 'dead_letter', lease_token_hash = NULL,
             lease_expires_at = NULL WHERE id = ? AND execution_state = 'claimed'`,
          item.id,
        );
      } else {
        const retryAt = now + (backoff[Math.min(item.attempt_count - 1, backoff.length - 1)] ?? 600_000);
        this.ctx.storage.sql.exec(
          `UPDATE agent_queue SET execution_state = 'pending', not_before = ?,
             lease_connection_id = NULL, lease_agent_session_id = NULL,
             lease_session_id = NULL, lease_token_hash = NULL,
             lease_expires_at = NULL, execution_started_at = NULL, claim_id = NULL
           WHERE id = ? AND execution_state = 'claimed'`,
          retryAt,
          item.id,
        );
      }
    }
  }

  private queueItemFromRow(row: {
    id: string;
    message_id: string;
    channel_id: string;
    enqueued_at: number;
    read_at: number | null;
    flags_json: string;
    body_markdown: string;
    author_display_snapshot: string;
  }): QueueItemRow {
    return {
      id: row.id,
      messageId: row.message_id,
      channelId: row.channel_id,
      enqueuedAt: row.enqueued_at,
      readAt: row.read_at,
      flags: JSON.parse(row.flags_json) as string[],
      bodyMarkdown: row.body_markdown,
      authorDisplaySnapshot: row.author_display_snapshot,
    };
  }

  private leaseFromRow(
    agentId: string,
    claimId: string,
    sessionId: string,
    row: {
      id: string;
      message_id: string;
      channel_id: string;
      lease_generation: number;
      lease_expires_at: number;
      attempt_count: number;
    },
  ): AgentLease {
    return {
      itemId: row.id,
      agentId,
      messageId: row.message_id,
      channelId: row.channel_id,
      sessionId,
      leaseGeneration: row.lease_generation,
      leaseExpiresAt: row.lease_expires_at,
      attemptCount: row.attempt_count,
      claimId,
    };
  }

  private async authorizeAgentLease(
    input: AgentLeaseProof & { now: number },
    toolName: "agent_start" | "agent_renew" | "agent_complete",
    allowCompleted = false,
  ): Promise<{ agent: AgentRow; leaseTokenHash: string; credential: AgentToolCredential }> {
    const leaseTokenHash = await hashSecret(input.leaseToken);
    const actor = this.authorizeActor(input.actor);
    let agent = this.requireOwnedAgentArgument(input.agent, actor.id);
    if (agent.status !== "active") throw new Error("agent is not active");
    const credential = await this.authorizeAgentToolCredential({
      actor: input.actor,
      agentId: agent.id,
      connectionId: input.connectionId,
      sessionToken: input.sessionToken,
      toolName,
      now: input.now,
    });
    this.authorizeActor(input.actor);
    agent = this.requireOwnedAgentArgument(input.agent, actor.id);
    if (agent.status !== "active") throw new Error("agent is not active");
    if (credential.kind === "session" && input.sessionId !== credential.sessionId) {
      throw new Error("runner session id does not match the session token");
    }
    const row = this.ctx.storage.sql
      .exec<{
        execution_state: string;
        lease_connection_id: string | null;
        lease_agent_session_id: string | null;
        lease_session_id: string | null;
        lease_generation: number;
        lease_token_hash: string | null;
        lease_expires_at: number | null;
      }>(
        `SELECT execution_state, lease_connection_id, lease_agent_session_id, lease_session_id, lease_generation,
                lease_token_hash, lease_expires_at
         FROM agent_queue WHERE id = ? AND agent_id = ?`,
        input.itemId,
        agent.id,
      )
      .toArray()[0];
    if (row === undefined || (row.execution_state !== "claimed" && !(allowCompleted && row.execution_state === "completed"))) {
      throw new Error("stale agent lease");
    }
    if (
      row.lease_connection_id !== credential.connectionId ||
      row.lease_agent_session_id !== credential.sessionId ||
      row.lease_session_id !== input.sessionId ||
      row.lease_generation !== input.leaseGeneration ||
      row.lease_token_hash === null ||
      !constantTimeEquals(row.lease_token_hash, leaseTokenHash) ||
      (row.execution_state === "claimed" && (row.lease_expires_at === null || row.lease_expires_at <= input.now))
    ) {
      throw new Error("stale agent lease");
    }
    return { agent, leaseTokenHash, credential };
  }

  private async sendAttributedMcpMessage(input: {
    actor: Actor;
    connectionId?: string | null;
    sessionToken?: string | null;
    agentArgument: string | null;
    idempotencyKey: string;
    channelId: string;
    bodyMarkdown: string;
    threadParentId?: string | null;
    now: number;
  }): Promise<SentMessage> {
    this.requireCloudContentAuthority();
    const body = parseMessageBody(input.bodyMarkdown);
    if (body === null) throw new Error("message body is empty or too long");
    // Digest before the authority checks: SubtleCrypto yields. Every live
    // membership, owner, connection and scope decision below is therefore made
    // after the last await and cannot go stale before the transaction commits.
    const bodyDigest = await hashSecret(body);
    let actor = this.authorizeActor(input.actor);
    let agent = input.agentArgument === null ? null : this.requireOwnedAgentArgument(input.agentArgument, actor.id);
    if (agent !== null && agent.status !== "active") throw new Error("agent is not active");
    const credential = agent === null
      ? await this.authorizeAgentToolCredential({
          actor: input.actor,
          agentId: "",
          connectionId: input.connectionId,
          toolName: "post_message",
          now: input.now,
        })
      : await this.authorizeAgentToolCredential({
          actor: input.actor,
          agentId: agent.id,
          connectionId: input.connectionId,
          sessionToken: input.sessionToken,
          toolName: "agent_post",
          now: input.now,
        });
    actor = this.authorizeActor(input.actor);
    agent = input.agentArgument === null ? null : this.requireOwnedAgentArgument(input.agentArgument, actor.id);
    if (agent !== null && agent.status !== "active") throw new Error("agent is not active");
    const connection = credential.kind === "oauth"
      ? readOauthConnection(this.ctx.storage, credential.connectionId)
      : null;
    if (credential.kind === "oauth" && connection === null) throw new Error("MCP connection is no longer active");
    if (credential.kind === "session") {
      const delegation = this.requireLiveDelegation(credential.delegationId, input.now);
      if (!delegationAllowsChannel(delegation.channelIds, input.channelId)) {
        throw new Error("delegation does not include this room");
      }
    }
    const channel = this.requireChannelParticipant(input.channelId, actor.id);
    if (channel.archivedAt !== null) throw new Error("this room is archived");
    if (
      agent !== null &&
      !agentMayPostIn({
        agentStatus: agent.status,
        scope: this.agentScope(agent),
        channelId: channel.id,
      })
    ) {
      throw new Error("agent cannot post in this room");
    }
    // The case the canary exists for: an agent putting a credential into a room.
    // Refused before the write, so the tripwire prevents the leak rather than
    // reporting it afterwards.
    this.refuseCanaryContent(body, {
      surface: "mcp_message", memberId: actor.id, agentId: agent?.id ?? null, channelId: channel.id, now: input.now,
    });
    const parent = input.threadParentId ? readMessage(this.ctx.storage, input.threadParentId) : null;
    if (input.threadParentId && parent === null) throw new Error("thread parent not found");
    const placement = resolveThreadPlacement(parent, channel.id);
    if (placement.kind === "invalid") throw new Error(placement.reason);
    const threadRootId = placement.kind === "reply" ? placement.threadRootId : null;
    if (channel.postMode === "form" && threadRootId === null) {
      throw new Error("this room only accepts form entries; use submit_form");
    }

    const outcome = await this.commitMutation(
      {
        scope: agent === null ? "mcp.message.send" : "mcp.agent.send",
        idempotencyKey: input.idempotencyKey,
        requestHash: `${actor.id}|${agent?.id ?? "member"}|${channel.id}|${threadRootId ?? ""}|${bodyDigest}`,
        now: input.now,
      },
      () => {
        if (credential.kind === "oauth") {
          this.consumeMcpWrite(credential.connectionId, agent?.id ?? "", input.now);
        } else {
          this.consumeAgentSessionWrite(credential.sessionId, agent!.id, input.now);
        }
        const messageId = crypto.randomUUID();
        const channelSequence = nextChannelSequence(this.ctx.storage, channel.id);
        const mentions = resolveMentionTargets(this.ctx.storage, parseMentions(body));
        const authorKind = agent === null ? "member" : "agent";
        const authorId = agent?.id ?? actor.id;
        insertMessage(this.ctx.storage, {
          id: messageId,
          channelId: channel.id,
          threadRootId,
          authorKind,
          authorId,
          authorDisplaySnapshot: agent?.displayName ?? actor.displayName,
          bodyMarkdown: body,
          channelSequence,
          now: input.now,
        });
        replaceMentions(this.ctx.storage, messageId, mentions, input.now);
        // Deliberately call the shared enqueue rule even for an agent post: it
        // is the single brake that prevents any agent-authored message from
        // starting another agent loop.
        const enqueued = this.enqueueAgentMentions({
          messageId,
          channelId: channel.id,
          authorKind,
          authorId,
          bodyMarkdown: body,
          mentions,
          isHistorical: false,
          now: input.now,
        });
        const notified = this.recordMessageNotifications({
          messageId, channel, threadRootId, authorKind, authorId,
          bodyMarkdown: body, mentions, now: input.now,
        });
        if (credential.kind === "oauth" && connection !== null) {
          insertMcpMessageAttribution(this.ctx.storage, {
            messageId,
            connectionId: connection.id,
            sessionId: null,
            delegationId: null,
            operatingMemberId: actor.id,
            agentId: agent?.id ?? null,
            clientId: connection.clientId,
            clientName: connection.clientName,
            deviceId: null,
            createdAt: input.now,
          });
        } else if (credential.kind === "session") {
          insertAgentSessionMessageAttribution(this.ctx.storage, {
            messageId,
            sessionId: credential.sessionId,
            delegationId: credential.delegationId,
            operatingMemberId: actor.id,
            agentId: agent!.id,
            deviceId: credential.deviceId,
            createdAt: input.now,
          });
        }
        return {
          result: {
            messageId,
            channelId: channel.id,
            threadRootId,
            channelSequence,
            createdAt: input.now,
            replayed: false,
          },
          effects: {
            audit: {
              eventType: "mcp.message_created",
              outcome: "allowed" as const,
              requesterKind: "member" as const,
              requesterId: actor.id,
              subjectKind: "message",
              subjectId: messageId,
              metadata: {
                channel_id: channel.id,
                in_thread: threadRootId !== null,
                connection_id: credential.connectionId,
                agent_session_id: credential.sessionId,
                delegation_id: credential.delegationId,
                client_id: connection?.clientId ?? `runner:${credential.deviceId}`,
                operating_agent_id: agent?.id ?? null,
                agent_work_enqueued: enqueued,
                notification_count: notified.created,
                push_count: notified.pushMemberIds.length,
              },
            },
            replay: [
              {
                kind: "message.created",
                audience: [channel.id],
                payload: {
                  messageId,
                  channelId: channel.id,
                  threadRootId,
                  channelSequence,
                  authorId,
                  createdAt: input.now,
                },
              },
            ],
            outbox: [
              {
                id: `message.${messageId}`,
                kind: "message_created",
                dedupeKey: `message:${messageId}`,
                payload: { messageId, channelId: channel.id, threadRootId },
              },
              ...notified.pushMemberIds.map((memberId) => ({
                id: `notification.${messageId}.${memberId}`,
                kind: "notification_push",
                dedupeKey: `notification:${messageId}:${memberId}`,
                payload: { memberId, messageId, channelId: channel.id },
              })),
            ],
          } satisfies MutationEffects,
        };
      },
    );

    if (!outcome.replayed) {
      this.broadcastChannelEvent(channel, this.latestReplaySequence(), "message.created", {
        messageId: outcome.result.messageId,
        channelId: channel.id,
        threadRootId: outcome.result.threadRootId,
        channelSequence: outcome.result.channelSequence,
        authorId: agent?.id ?? actor.id,
        createdAt: input.now,
      });
    }
    return { ...outcome.result, replayed: outcome.replayed };
  }

  private recordMessageNotifications(input: {
    messageId: string;
    channel: ChannelRow;
    threadRootId: string | null;
    authorKind: "member" | "agent";
    authorId: string;
    bodyMarkdown: string;
    mentions: readonly { kind: string; resolvedId: string | null }[];
    now: number;
  }): { created: number; pushMemberIds: readonly string[] } {
    const memberIds = new Set(channelMemberIds(this.ctx.storage, input.channel.id));
    const groupIds = input.mentions
      .filter((mention) => mention.kind === "group" && mention.resolvedId !== null)
      .map((mention) => mention.resolvedId!);
    const allGroupMembers = new Set<string>();
    for (const groupId of groupIds) {
      const groupMembers = this.ctx.storage.sql.exec<{ member_id: string }>(
        `SELECT gm.member_id FROM group_members gm JOIN members m ON m.id = gm.member_id
         WHERE gm.group_id = ? AND m.status = 'active' ORDER BY gm.member_id`, groupId,
      ).toArray().map((row) => row.member_id);
      // Each named group must be real and non-empty; one populated group must
      // not conceal a second empty token that looked like it notified people.
      planGroupMention({ memberIds: groupMembers, senderId: input.authorKind === "member" ? input.authorId : "" });
      for (const memberId of groupMembers) allGroupMembers.add(memberId);
    }
    const groupTargets = groupIds.length === 0 ? [] : planGroupMention({
      memberIds: [...allGroupMembers], senderId: input.authorKind === "member" ? input.authorId : "",
    });
    if (input.channel.kind === "public") {
      for (const mention of input.mentions) if (mention.kind === "member" && mention.resolvedId !== null) memberIds.add(mention.resolvedId);
      for (const memberId of groupTargets) memberIds.add(memberId);
    }
    memberIds.delete(input.authorKind === "member" ? input.authorId : "");

    if (input.authorKind === "member") {
      const rootId = input.threadRootId ?? input.messageId;
      this.ctx.storage.sql.exec(
        `INSERT INTO thread_subscriptions(thread_root_id, member_id, subscribed_at) VALUES (?, ?, ?)
         ON CONFLICT(thread_root_id, member_id) DO NOTHING`,
        rootId, input.authorId, input.now,
      );
    }

    const directlyMentioned = new Set([
      ...input.mentions.filter((mention) => mention.kind === "member" && mention.resolvedId !== null).map((mention) => mention.resolvedId!),
      ...groupTargets,
    ]);
    const broadcast = input.mentions.some(
      (mention) => mention.kind === "channel" || mention.kind === "here" || mention.kind === "group",
    );
    const subscribers = input.threadRootId === null ? new Set<string>() : new Set(
      this.ctx.storage.sql.exec<{ member_id: string }>(
        "SELECT member_id FROM thread_subscriptions WHERE thread_root_id = ?", input.threadRootId,
      ).toArray().map((row) => row.member_id),
    );
    const bodyLower = input.bodyMarkdown.toLocaleLowerCase();
    let created = 0;
    const pushMemberIds: string[] = [];
    for (const memberId of memberIds) {
      const pref = this.ctx.storage.sql.exec<{
        notify_level: NotifyLevel | null; dnd_start_minute: number | null; dnd_end_minute: number | null; dnd_manual_until: number | null;
      }>(
        `SELECT cnp.notify_level, np.dnd_start_minute, np.dnd_end_minute, np.dnd_manual_until
         FROM members m
         LEFT JOIN channel_notification_preferences cnp ON cnp.member_id = m.id AND cnp.channel_id = ?
         LEFT JOIN notification_preferences np ON np.member_id = m.id WHERE m.id = ? AND m.status = 'active'`,
        input.channel.id, memberId,
      ).toArray()[0];
      if (pref === undefined) continue;
      const keywordMatched = this.ctx.storage.sql.exec<{ keyword: string }>(
        "SELECT keyword FROM notification_keywords WHERE member_id = ?", memberId,
      ).toArray().some((row) => bodyLower.includes(row.keyword.toLocaleLowerCase()));
      const kind: NotificationKind = directlyMentioned.has(memberId)
        ? "mention"
        : subscribers.has(memberId)
          ? "thread_reply"
          : input.channel.kind === "dm" || input.channel.kind === "group_dm"
            ? "dm"
            : keywordMatched
              ? "keyword"
              : "channel";
      const date = new Date(input.now);
      const decision = decideMessageNotification({
        level: pref.notify_level ?? "mentions",
        kind,
        authorKind: input.authorKind,
        keywordMatched,
        broadcast,
        dndActive: isDndActive({
          minuteOfDay: date.getUTCHours() * 60 + date.getUTCMinutes(),
          startMinute: pref.dnd_start_minute,
          endMinute: pref.dnd_end_minute,
          manualUntil: pref.dnd_manual_until,
          now: input.now,
        }),
      });
      if (!decision.inbox) continue;
      const result = this.ctx.storage.sql.exec(
        `INSERT INTO notifications(id, member_id, message_id, channel_id, kind, author_kind, author_id,
          badge, push_allowed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(member_id, message_id) DO NOTHING`,
        crypto.randomUUID(), memberId, input.messageId, input.channel.id, kind, input.authorKind, input.authorId,
        decision.badge ? 1 : 0, decision.push ? 1 : 0, input.now,
      );
      created += result.rowsWritten;
      if (decision.push && result.rowsWritten > 0) pushMemberIds.push(memberId);
      if (kind === "mention" && input.threadRootId !== null) {
        this.ctx.storage.sql.exec(
          `INSERT INTO thread_subscriptions(thread_root_id, member_id, subscribed_at) VALUES (?, ?, ?)
           ON CONFLICT(thread_root_id, member_id) DO NOTHING`,
          input.threadRootId, memberId, input.now,
        );
      }
    }
    return { created, pushMemberIds };
  }

  private consumeMcpWrite(connectionId: string, agentId: string, now: number): void {
    const current = this.ctx.storage.sql
      .exec<{ window_started_at: number; write_count: number }>(
        "SELECT window_started_at, write_count FROM mcp_write_limits WHERE connection_id = ? AND agent_id = ?",
        connectionId,
        agentId,
      )
      .toArray()[0];
    const next = nextMcpWriteWindow({
      now,
      windowStartedAt: current?.window_started_at ?? null,
      writeCount: current?.write_count ?? 0,
    });
    if (!next.allowed) throw new Error(`rate limited; retry after ${next.retryAfterMs} ms`);
    this.ctx.storage.sql.exec(
      `INSERT INTO mcp_write_limits(connection_id, agent_id, window_started_at, write_count)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(connection_id, agent_id) DO UPDATE SET
         window_started_at = excluded.window_started_at, write_count = excluded.write_count`,
      connectionId,
      agentId,
      next.windowStartedAt,
      next.writeCount,
    );
  }

  private consumeAgentSessionWrite(sessionId: string, agentId: string, now: number): void {
    const current = this.ctx.storage.sql
      .exec<{ window_started_at: number; write_count: number }>(
        `SELECT window_started_at, write_count FROM agent_session_write_limits
         WHERE session_id = ? AND agent_id = ?`,
        sessionId,
        agentId,
      )
      .toArray()[0];
    const next = nextMcpWriteWindow({
      now,
      windowStartedAt: current?.window_started_at ?? null,
      writeCount: current?.write_count ?? 0,
    });
    if (!next.allowed) throw new Error(`rate limited; retry after ${next.retryAfterMs} ms`);
    this.ctx.storage.sql.exec(
      `INSERT INTO agent_session_write_limits(session_id, agent_id, window_started_at, write_count)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, agent_id) DO UPDATE SET
         window_started_at = excluded.window_started_at, write_count = excluded.write_count`,
      sessionId,
      agentId,
      next.windowStartedAt,
      next.writeCount,
    );
  }

  /** An owner cannot scope an agent to a room they cannot reach themselves. */
  private resolveScopeChannels(channelIds: readonly string[], memberId: string): string[] {
    const unique = [...new Set(channelIds)];
    return unique.map((channelId) => this.requireVisibleChannel(channelId, memberId).id);
  }

  private agentEffects(
    eventType: string,
    agent: AgentRow,
    actor: ActiveMember,
    metadata: Record<string, string | number | boolean | null>,
  ): MutationEffects {
    return {
      audit: {
        eventType,
        outcome: "allowed",
        requesterKind: "member",
        requesterId: actor.id,
        subjectKind: "agent",
        subjectId: agent.id,
        metadata: { agent_handle: agent.handle, ...metadata },
      },
    };
  }

  /**
   * Turn the agent mentions on a message into queued work.
   *
   * Every brake lives in `decideEnqueue`, so this only supplies the facts and
   * records what came back. An out-of-scope or agent-authored mention leaves no
   * queue row at all: the message never reaches the agent's context and never
   * reaches an owner's view.
   */
  private enqueueAgentMentions(input: {
    messageId: string;
    channelId: string;
    authorKind: "member" | "agent" | "imported";
    authorId: string;
    bodyMarkdown: string;
    mentions: readonly { kind: string; handle: string; resolvedId: string | null }[];
    isHistorical: boolean;
    now: number;
  }): number {
    let enqueued = 0;
    const flags = flagSuspiciousContent(input.bodyMarkdown);

    for (const mention of input.mentions) {
      if (mention.kind !== "agent" || mention.resolvedId === null) continue;
      const agent = readAgent(this.ctx.storage, mention.resolvedId);
      if (agent === null) continue;

      const decision = decideEnqueue({
        authorKind: input.authorKind,
        authorId: input.authorId,
        agentId: agent.id,
        agentStatus: agent.status,
        scope: this.agentScope(agent),
        channelId: input.channelId,
        isHistorical: input.isHistorical,
      });
      if (!decision.enqueue) continue;

      if (
        enqueueAgentWork(this.ctx.storage, {
          id: crypto.randomUUID(),
          agentId: agent.id,
          messageId: input.messageId,
          channelId: input.channelId,
          flags,
          now: input.now,
        })
      ) {
        enqueued += 1;
        // The wake commits with the queue row it announces (R01). Delivery
        // happens after this transaction, and a wake nobody was listening for
        // stays pending until a runner reconnects and collects it.
        this.recordRuntimeWake({
          agentId: agent.id,
          messageId: input.messageId,
          requesterMemberId: input.authorKind === "member" ? input.authorId : "",
          now: input.now,
        });
      }
    }
    return enqueued;
  }

  /** Newest-first channel history, refused outright for a room the caller cannot see. */
  readChannelHistory(input: {
    actor: Actor;
    channelId: string;
    cursor?: string | null;
    limit?: number;
  }): MessagePage {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireVisibleChannel(input.channelId, actor.id);
    if (channel.sortMode === "ranked" && channel.sortEmoji !== null) {
      return this.readWorkQueue({ actor: input.actor, channelId: channel.id, statusId: null, limit: input.limit }).page;
    }
    const page = listChannelHistory(this.ctx.storage, channel.id, input.cursor ?? null, input.limit);
    return { ...this.decorateMessages(page.messages, actor.id), nextCursor: page.nextCursor };
  }

  readThreadHistory(input: {
    actor: Actor;
    threadRootId: string;
    cursor?: string | null;
    limit?: number;
  }): MessagePage {
    const actor = this.authorizeActor(input.actor);
    const root = readMessage(this.ctx.storage, input.threadRootId);
    if (root === null || root.threadRootId !== null) throw new Error("thread not found");
    const channel = this.requireVisibleChannel(root.channelId, actor.id);
    this.requireReadableQueueItem(root, channel, actor.id);
    const page = listThreadHistory(this.ctx.storage, root.id, input.cursor ?? null, input.limit);
    return { ...this.decorateMessages(page.messages, actor.id), nextCursor: page.nextCursor };
  }

  /** MCP never auto-joins or treats a public-room id as membership. */
  readMcpChannelHistory(input: {
    actor: Actor;
    channelId: string;
    cursor?: string | null;
    limit?: number;
  }): MessagePage {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireChannelParticipant(input.channelId, actor.id);
    if (channel.sortMode === "ranked" && channel.sortEmoji !== null) {
      return this.readWorkQueue({ actor: input.actor, channelId: channel.id, statusId: null, limit: input.limit }).page;
    }
    const page = listChannelHistory(this.ctx.storage, channel.id, input.cursor ?? null, input.limit);
    return { ...this.decorateMessages(page.messages, actor.id), nextCursor: page.nextCursor };
  }

  readMcpThreadHistory(input: {
    actor: Actor;
    threadRootId: string;
    cursor?: string | null;
    limit?: number;
  }): MessagePage {
    const actor = this.authorizeActor(input.actor);
    const root = readMessage(this.ctx.storage, input.threadRootId);
    if (root === null || root.threadRootId !== null) throw new Error("thread not found");
    const channel = this.requireChannelParticipant(root.channelId, actor.id);
    this.requireReadableQueueItem(root, channel, actor.id);
    const page = listThreadHistory(this.ctx.storage, root.id, input.cursor ?? null, input.limit);
    return {
      ...this.decorateMessages([root, ...page.messages], actor.id),
      nextCursor: page.nextCursor,
    };
  }

  browseChannels(input: { actor: Actor; includeArchived?: boolean }): {
    channels: readonly (ChannelRow & { isMember: boolean; participantIds: readonly string[] })[];
  } {
    const actor = this.authorizeActor(input.actor);
    const channels = listVisibleChannels(
      this.ctx.storage,
      actor.id,
      input.includeArchived === true,
    ).map((channel) => ({
      ...channel,
      isMember: isChannelMember(this.ctx.storage, channel.id, actor.id),
      participantIds:
        channel.kind === "dm" || channel.kind === "group_dm"
          ? channelMemberIds(this.ctx.storage, channel.id)
          : [],
    }));
    return { channels };
  }

  /* ------------------------------------------------------------------ */
  /* MCP OAuth authorization and connections (A02)                       */
  /* ------------------------------------------------------------------ */

  /**
   * The tenant is the authorization server's storage for everything that names
   * one of its people: codes and connections. Only the client registry lives in
   * the control plane, because a client registers before a workspace is known.
   *
   * Protocol failures are returned rather than thrown. An OAuth endpoint has to
   * answer with a specific error code in a JSON body, and turning an exception
   * message back into a code at the route would be a second place where the
   * refusal is decided.
   */
  async beginOauthAuthorization(input: {
    actor: Actor;
    workspaceSlug: string;
    clientId: string;
    clientName: string | null;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
    resource: string;
    now: number;
  }): Promise<OauthCodeResult> {
    const actor = this.authorizeActor(input.actor);
    const slug = this.requireWorkspaceSlug(input.workspaceSlug);
    if (workspaceSlugFromResource(input.resource) !== slug) {
      return {
        ok: false,
        error: "invalid_target",
        description: "resource does not name this workspace",
      };
    }

    const code = formatToken("code", slug, randomSecret());
    const codeHash = await hashSecret(code);
    const expiresAt = input.now + AUTHORIZATION_CODE_TTL_MS;

    const outcome = await this.commitMutation(
      { scope: "oauth.authorize", now: input.now },
      () => {
        // Codes are swept on the way past rather than by their own alarm: the
        // only time an expired code matters is when a new one is written.
        deleteExpiredOauthCodes(this.ctx.storage, input.now);
        insertOauthCode(this.ctx.storage, {
          codeHash,
          clientId: input.clientId,
          memberId: actor.id,
          redirectUri: input.redirectUri,
          codeChallenge: input.codeChallenge,
          resource: input.resource,
          scope: input.scope,
          now: input.now,
          expiresAt,
        });
        return {
          result: { code },
          effects: {
            audit: {
              eventType: "oauth.authorized",
              outcome: "allowed" as const,
              requesterKind: "member" as const,
              requesterId: actor.id,
              subjectKind: "oauth_client",
              subjectId: input.clientId,
              // The code never reaches the audit; what is worth keeping is who
              // agreed to what, not the credential it produced.
              metadata: { scope: input.scope, client_name: input.clientName ?? "" },
            },
          } satisfies MutationEffects,
        };
      },
    );
    return { ok: true, code: outcome.result.code };
  }

  async exchangeOauthCode(input: {
    workspaceSlug: string;
    code: string;
    clientId: string;
    clientName: string | null;
    redirectUri: unknown;
    codeVerifier: unknown;
    resource?: unknown;
    now: number;
  }): Promise<OauthGrantResult> {
    const slug = this.requireWorkspaceSlug(input.workspaceSlug);
    const parsed = parseTokenOfKind(input.code, "code");
    // A code that names another workspace is refused here rather than looked
    // up, so one tenant never probes another's storage even by absence.
    if (parsed === null || parsed.workspaceSlug !== slug) {
      return { ok: false, error: "invalid_grant", description: "unknown or already used code" };
    }

    const codeHash = await hashSecret(input.code);
    const stored = readOauthCode(this.ctx.storage, codeHash);
    const check = checkCodeExchange({
      stored:
        stored === null
          ? null
          : {
              clientId: stored.clientId,
              redirectUri: stored.redirectUri,
              codeChallenge: stored.codeChallenge,
              resource: stored.resource,
              expiresAt: stored.expiresAt,
              consumedAt: stored.consumedAt,
            },
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      resource: input.resource,
      now: input.now,
    });
    if (!check.ok) return { ok: false, error: check.error, description: check.description };
    if (stored === null) {
      return { ok: false, error: "invalid_grant", description: "unknown or already used code" };
    }
    if (!(await verifyCodeVerifier(input.codeVerifier, stored.codeChallenge))) {
      return { ok: false, error: "invalid_grant", description: "the PKCE verifier does not match" };
    }

    // Consent and redemption are separate moments. Somebody suspended in
    // between does not get a connection out of a code they were still entitled
    // to when they clicked.
    if (!this.memberIsActive(stored.memberId)) {
      return { ok: false, error: "invalid_grant", description: "this person is no longer a member" };
    }

    const accessToken = formatToken("at", slug, randomSecret());
    const refreshToken = formatToken("rt", slug, randomSecret());
    const accessTokenHash = await hashSecret(accessToken);
    const refreshTokenHash = await hashSecret(refreshToken);
    const connectionId = crypto.randomUUID();
    const accessExpiresAt = input.now + ACCESS_TOKEN_TTL_MS;

    const outcome = await this.commitMutation<{ spent: boolean }>({ scope: "oauth.exchange", now: input.now }, () => {
      // One conditional UPDATE decides the race: two clients redeeming the same
      // code cannot both win, because only one of them writes a row.
      if (!consumeOauthCode(this.ctx.storage, codeHash, input.now)) {
        return { result: { spent: false } };
      }
      insertOauthConnection(this.ctx.storage, {
        id: connectionId,
        clientId: stored.clientId,
        clientName: input.clientName,
        memberId: stored.memberId,
        resource: stored.resource,
        scope: stored.scope,
        accessTokenHash,
        refreshTokenHash,
        accessExpiresAt,
        now: input.now,
      });
      return {
        result: { spent: true },
        effects: {
          audit: {
            eventType: "oauth.connected",
            outcome: "allowed" as const,
            requesterKind: "member" as const,
            requesterId: stored.memberId,
            subjectKind: "oauth_connection",
            subjectId: connectionId,
            metadata: { client_id: stored.clientId, scope: stored.scope },
          },
        } satisfies MutationEffects,
      };
    });
    if (!outcome.result.spent) {
      return { ok: false, error: "invalid_grant", description: "unknown or already used code" };
    }

    return {
      ok: true,
      grant: {
        connectionId,
        accessToken,
        refreshToken,
        expiresInSeconds: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        scope: stored.scope,
      },
    };
  }

  async refreshOauthTokens(input: {
    workspaceSlug: string;
    refreshToken: string;
    clientId: string;
    now: number;
  }): Promise<OauthGrantResult> {
    const slug = this.requireWorkspaceSlug(input.workspaceSlug);
    const parsed = parseTokenOfKind(input.refreshToken, "rt");
    if (parsed === null || parsed.workspaceSlug !== slug) {
      return { ok: false, error: "invalid_grant", description: "unknown refresh token" };
    }

    const presentedHash = await hashSecret(input.refreshToken);
    const connection = readConnectionByRefreshHash(this.ctx.storage, presentedHash);
    const decision = decideRefresh({
      connection:
        connection === null
          ? null
          : {
              refreshTokenHash: connection.refreshTokenHash,
              previousRefreshTokenHash: connection.previousRefreshTokenHash,
              clientId: connection.clientId,
              revokedAt: connection.revokedAt,
            },
      presentedHash,
      clientId: input.clientId,
    });

    if (decision.kind === "replay" && connection !== null) {
      // The rotated token came back. A lost response and a stolen token look
      // the same from here, so the connection dies and the person reconnects.
      await this.commitMutation({ scope: "oauth.replay", now: input.now }, () => {
        revokeOauthConnectionRow(this.ctx.storage, connection.id, "refresh_token_replayed", input.now);
        return {
          result: undefined,
          effects: {
            audit: {
              eventType: "oauth.revoked",
              outcome: "denied" as const,
              requesterKind: "system" as const,
              requesterId: null,
              subjectKind: "oauth_connection",
              subjectId: connection.id,
              metadata: { reason: "refresh_token_replayed", client_id: connection.clientId },
            },
          } satisfies MutationEffects,
        };
      });
      return { ok: false, error: "invalid_grant", description: decision.description };
    }
    if (decision.kind !== "rotate" || connection === null) {
      const refusal = decision.kind === "refuse" ? decision : null;
      return {
        ok: false,
        error: refusal?.error ?? "invalid_grant",
        description: refusal?.description ?? "unknown refresh token",
      };
    }

    if (!this.memberIsActive(connection.memberId)) {
      return { ok: false, error: "invalid_grant", description: "this person is no longer a member" };
    }

    const accessToken = formatToken("at", slug, randomSecret());
    const refreshToken = formatToken("rt", slug, randomSecret());
    const rotated = rotateOauthConnection(this.ctx.storage, {
      connectionId: connection.id,
      accessTokenHash: await hashSecret(accessToken),
      refreshTokenHash: await hashSecret(refreshToken),
      previousRefreshTokenHash: presentedHash,
      accessExpiresAt: input.now + ACCESS_TOKEN_TTL_MS,
      now: input.now,
    });
    if (!rotated) {
      return { ok: false, error: "invalid_grant", description: "unknown refresh token" };
    }

    return {
      ok: true,
      grant: {
        connectionId: connection.id,
        accessToken,
        refreshToken,
        expiresInSeconds: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        scope: connection.scope,
      },
    };
  }

  /**
   * The resource server's whole authority decision.
   *
   * Membership is re-checked live on every call, so removing somebody from the
   * workspace cuts their connection off at its next request. There is nothing
   * to revoke and no cache to wait out.
   */
  async authenticateOauthToken(input: {
    accessToken: string;
    audience: string;
    now: number;
    requiredScope?: SupportedScope;
  }): Promise<OauthPrincipalResult> {
    const slug = this.workspaceSlug();
    const parsed = parseTokenOfKind(input.accessToken, "at");
    if (slug === null || parsed === null || parsed.workspaceSlug !== slug) {
      return { ok: false, error: "invalid_token", description: "unknown token" };
    }

    const connection = readConnectionByAccessHash(this.ctx.storage, await hashSecret(input.accessToken));
    const verdict = checkPresentedToken({
      token:
        connection === null
          ? null
          : {
              connectionId: connection.id,
              resource: connection.resource,
              accessExpiresAt: connection.accessExpiresAt,
              revokedAt: connection.revokedAt,
              scope: connection.scope,
            },
      audience: input.audience,
      now: input.now,
      requiredScope: input.requiredScope,
    });
    if (!verdict.ok) return { ok: false, error: verdict.error, description: verdict.description };
    if (connection === null) {
      return { ok: false, error: "invalid_token", description: "unknown token" };
    }

    const member = this.ctx.storage.sql
      .exec<{ id: string; handle: string; display_name: string; role: MemberProjection["role"]; status: string; authorization_epoch: number }>(
        "SELECT id, handle, display_name, role, status, authorization_epoch FROM members WHERE id = ?",
        connection.memberId,
      )
      .toArray()[0];
    if (member === undefined || member.status !== "active") {
      return {
        ok: false,
        error: "invalid_token",
        description: "this person is no longer a member of the workspace",
      };
    }

    touchOauthConnection(this.ctx.storage, connection.id, input.now);
    return {
      ok: true,
      principal: {
        connectionId: connection.id,
        memberId: member.id,
        handle: member.handle,
        displayName: member.display_name,
        role: member.role,
        authorizationEpoch: member.authorization_epoch,
        scope: connection.scope,
        clientId: connection.clientId,
        clientName: connection.clientName,
      },
    };
  }

  /** Authenticate either an attended OAuth connection or an unattended session. */
  async authenticateMcpToken(input: {
    token: string;
    audience: string;
    now: number;
    toolName?: McpToolName;
    requiredScope?: SupportedScope;
  }): Promise<McpPrincipalResult> {
    const parsed = parseToken(input.token);
    if (parsed?.kind === "at") {
      const authenticated = await this.authenticateOauthToken({
        accessToken: input.token,
        audience: input.audience,
        now: input.now,
        requiredScope: input.requiredScope,
      });
      return authenticated.ok
        ? { ok: true, principal: { ...authenticated.principal, credentialKind: "oauth" } }
        : authenticated;
    }
    const slug = this.workspaceSlug();
    if (slug === null || parsed?.kind !== "st" || parsed.workspaceSlug !== slug) {
      return { ok: false, error: "invalid_token", description: "unknown token" };
    }
    const tokenHash = await hashSecret(input.token);
    const stored = this.ctx.storage.sql
      .exec<{ id: string }>("SELECT id FROM agent_sessions WHERE token_hash = ?", tokenHash)
      .toArray()[0];
    if (stored === undefined) return { ok: false, error: "invalid_token", description: "unknown token" };
    let session: AgentSessionRow;
    let delegation: AgentDelegation;
    let owner: ActiveMember;
    try {
      session = this.requireLiveAgentSessionById(stored.id, input.now);
      delegation = this.requireLiveDelegation(session.delegationId, input.now);
      owner = this.requireLiveSessionOwner(session, delegation);
    } catch {
      return { ok: false, error: "invalid_token", description: "session authority is no longer current" };
    }
    if (!constantTimeEquals(session.tokenHash, tokenHash)) {
      return { ok: false, error: "invalid_token", description: "unknown token" };
    }
    if (input.toolName !== undefined && !sessionAllowsTool(session.capabilities, input.toolName)) {
      return { ok: false, error: "insufficient_scope", description: `session cannot call ${input.toolName}` };
    }
    const agent = readAgent(this.ctx.storage, session.agentId);
    if (agent === null) return { ok: false, error: "invalid_token", description: "session agent no longer exists" };
    this.ctx.storage.sql.exec("UPDATE agent_sessions SET last_used_at = ? WHERE id = ?", input.now, session.id);
    return {
      ok: true,
      principal: {
        credentialKind: "session",
        sessionId: session.id,
        delegationId: delegation.id,
        agentId: agent.id,
        agentHandle: agent.handle,
        memberId: owner.id,
        handle: owner.handle,
        displayName: owner.displayName,
        role: owner.role,
        authorizationEpoch: delegation.ownerAuthorizationEpoch,
        capabilities: session.capabilities,
        channelIds: delegation.channelIds,
        deviceId: session.deviceId,
        runnerEpoch: session.runnerEpoch,
        presetRevision: session.presetRevision,
        clientId: `runner:${session.deviceId}`,
        clientName: "Lepidy runner",
      },
    };
  }

  /**
   * RFC 7009. Presenting either half of a connection's pair revokes the
   * connection, and the answer is the same whether anything was revoked or not:
   * the endpoint is unauthenticated, so it must not report whether a token
   * existed.
   */
  async revokeOauthToken(input: { token: string; now: number }): Promise<{ revoked: boolean }> {
    const slug = this.workspaceSlug();
    const parsed = parseToken(input.token);
    if (slug === null || parsed === null || parsed.workspaceSlug !== slug || parsed.kind === "code") {
      return { revoked: false };
    }
    const hash = await hashSecret(input.token);
    const connection =
      parsed.kind === "rt"
        ? readConnectionByRefreshHash(this.ctx.storage, hash)
        : readConnectionByAccessHash(this.ctx.storage, hash);
    if (connection === null || connection.revokedAt !== null) return { revoked: false };

    await this.commitMutation({ scope: "oauth.revoke", now: input.now }, () => {
      revokeOauthConnectionRow(this.ctx.storage, connection.id, "token_revoked", input.now);
      return {
        result: undefined,
        effects: {
          audit: {
            eventType: "oauth.revoked",
            outcome: "allowed" as const,
            requesterKind: "member" as const,
            requesterId: connection.memberId,
            subjectKind: "oauth_connection",
            subjectId: connection.id,
            metadata: { reason: "token_revoked", client_id: connection.clientId },
          },
        } satisfies MutationEffects,
      };
    });
    return { revoked: true };
  }

  listOauthConnections(input: { actor: Actor }): { connections: readonly OauthConnectionSummary[] } {
    const actor = this.authorizeActor(input.actor);
    // A connection acts as one person, so it is theirs to see and theirs to
    // end. Nobody else's is listed here, not even an admin's view.
    return {
      connections: listOauthConnectionsForMember(this.ctx.storage, actor.id).map((row) => ({
        id: row.id,
        clientId: row.clientId,
        clientName: row.clientName,
        scope: row.scope,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        rotationCount: row.rotationCount,
      })),
    };
  }

  async revokeOauthConnection(input: {
    actor: Actor;
    connectionId: string;
    now: number;
  }): Promise<{ revoked: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const connection = readOauthConnection(this.ctx.storage, input.connectionId);
    // Somebody else's connection is reported as missing, the same answer a
    // connection that never existed gets.
    if (connection === null || connection.memberId !== actor.id) {
      throw new Error("connection not found");
    }
    if (connection.revokedAt !== null) return { revoked: false };

    await this.commitMutation({ scope: "oauth.revoke", now: input.now }, () => {
      revokeOauthConnectionRow(this.ctx.storage, connection.id, "disconnected_by_owner", input.now);
      return {
        result: undefined,
        effects: {
          audit: {
            eventType: "oauth.revoked",
            outcome: "allowed" as const,
            requesterKind: "member" as const,
            requesterId: actor.id,
            subjectKind: "oauth_connection",
            subjectId: connection.id,
            metadata: { reason: "disconnected_by_owner", client_id: connection.clientId },
          },
        } satisfies MutationEffects,
      };
    });
    return { revoked: true };
  }

  private workspaceSlug(): string | null {
    return (
      this.ctx.storage.sql
        .exec<{ workspace_slug: string | null }>(
          "SELECT workspace_slug FROM workspace_config WHERE singleton = 1",
        )
        .toArray()[0]?.workspace_slug ?? null
    );
  }

  /**
   * Learn the workspace's slug once, then hold the caller to it.
   *
   * A workspace provisioned before this column existed has none yet, so the
   * first OAuth request teaches it. After that the slug is what routes every
   * token, and a caller naming a different one is refused rather than believed.
   */
  private requireWorkspaceSlug(claimed: string): string {
    const known = this.workspaceSlug();
    if (known === null) {
      this.ctx.storage.sql.exec(
        "UPDATE workspace_config SET workspace_slug = ? WHERE singleton = 1 AND workspace_slug IS NULL",
        claimed,
      );
      return claimed;
    }
    if (known !== claimed) throw new Error("workspace slug does not match this workspace");
    return known;
  }

  private memberIsActive(memberId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ status: string }>("SELECT status FROM members WHERE id = ?", memberId)
        .toArray()[0]?.status === "active"
    );
  }

  /* -- authorization helpers ------------------------------------------- */

  private authorizeActor(actor: Actor): ActiveMember {
    const schema = readWorkspaceSchema(this.ctx.storage);
    if (schema.status !== "ready") throw new Error("workspace is quarantined");
    if (!this.authorizeMember(actor.memberId, actor.authorizationEpoch)) {
      throw new Error("member is not authorized for this workspace");
    }
    const row = this.ctx.storage.sql
      .exec<{ id: string; handle: string; display_name: string; role: MemberProjection["role"] }>(
        "SELECT id, handle, display_name, role FROM members WHERE id = ?",
        actor.memberId,
      )
      .one();
    return { id: row.id, handle: row.handle, displayName: row.display_name, role: row.role };
  }

  /**
   * On a Solo workspace the designated host is the authority for content; the
   * relay must never hold a message body. Callers route through the encrypted
   * relay instead.
   */
  private requireCloudContentAuthority(): void {
    const config = this.ctx.storage.sql
      .exec<{ storage_mode: WorkspaceStorageMode }>(
        "SELECT storage_mode FROM workspace_config WHERE singleton = 1",
      )
      .toArray()[0];
    if (!config) throw new Error("workspace is not initialized");
    if (config.storage_mode !== "cloud") throw new Error("content_is_host_owned");
  }

  /**
   * A room the caller may not see is reported as missing rather than forbidden:
   * the two answers together would tell them a private room exists.
   */
  private requireVisibleChannel(channelId: string, memberId: string): ChannelRow {
    const channel = readChannel(this.ctx.storage, channelId);
    if (channel === null) throw new Error("channel not found");
    if (!canSeeChannel(this.channelVisibility(channel, memberId))) throw new Error("channel not found");
    return channel;
  }

  private requireChannelParticipant(channelId: string, memberId: string): ChannelRow {
    const channel = this.requireVisibleChannel(channelId, memberId);
    if (!isChannelMember(this.ctx.storage, channel.id, memberId)) {
      throw new Error("join this room before posting in it");
    }
    return channel;
  }

  private mayManageQueue(channel: ChannelRow, actor: ActiveMember): boolean {
    return actor.role === "owner" || actor.role === "admin" || channel.createdByMemberId === actor.id;
  }

  private requireQueueManager(channel: ChannelRow, actor: ActiveMember): void {
    if (!this.mayManageQueue(channel, actor)) throw new Error("only room or workspace admins may manage this queue");
  }

  private mayReadQueueItem(message: MessageRow, channel: ChannelRow, memberId: string): boolean {
    if (message.statusId === null) return true;
    const status = channel.statusDefinitions.find((candidate) => candidate.id === message.statusId);
    if (status === undefined) return true;
    const role = this.ctx.storage.sql.exec<{ role: MemberProjection["role"] }>(
      "SELECT role FROM members WHERE id = ?", memberId,
    ).toArray()[0]?.role;
    return maySeeQueueStatus(status, memberId, role === "owner" || channel.createdByMemberId === memberId);
  }

  private requireReadableQueueItem(message: MessageRow, channel: ChannelRow, memberId: string): void {
    if (!this.mayReadQueueItem(message, channel, memberId)) throw new Error("message not found");
  }

  private resolveActiveMemberIds(memberIds: readonly string[]): string[] {
    const unique = [...new Set(memberIds)];
    return unique.filter(
      (id) =>
        this.ctx.storage.sql
          .exec<{ present: number }>(
            "SELECT 1 AS present FROM members WHERE id = ? AND status = 'active'",
            id,
          )
          .toArray()[0]?.present === 1,
    );
  }

  private channelEffects(
    eventType: string,
    channelId: string,
    actor: ActiveMember,
    metadata: Record<string, string | number | boolean | null>,
  ): MutationEffects {
    return {
      audit: {
        eventType,
        outcome: "allowed",
        requesterKind: "member",
        requesterId: actor.id,
        subjectKind: "channel",
        subjectId: channelId,
        metadata,
      },
      replay: [{ kind: eventType, audience: [channelId], payload: { channelId, actorId: actor.id } }],
    };
  }

  /* ------------------------------------------------------------------ */
  /* The designated runner (R01)                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Declare which agents this device answers for, and under which local preset.
   *
   * One device per agent, deliberately. Two machines both deciding they are the
   * one that answers is how a single mention gets worked twice, and the queue's
   * leases would then be the only thing standing between a duplicate and a
   * duplicated side effect. Registering *moves* an agent to this device and says
   * so; it never quietly shares one.
   *
   * The preset id is an opaque local name and the revision is that preset's own
   * version. Neither describes anything: the workspace stores what the machine
   * called its preset so it can name it back, and a name the machine no longer
   * recognises is refused there rather than here.
   */
  async registerRunner(input: {
    actor: Actor;
    deviceId: string;
    runnerEpoch: number;
    presetRevision: number;
    agents: readonly { agentId: string; presetId: string }[];
    now: number;
  }): Promise<{
    deviceId: string;
    runnerEpoch: number;
    agentIds: readonly string[];
    displacedDeviceIds: readonly string[];
    confirmedLocalReviews: number;
  }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    assertOpaqueId(input.deviceId, "device id");
    if (!Number.isSafeInteger(input.runnerEpoch) || input.runnerEpoch < 1) throw new Error("runner epoch is invalid");
    if (!Number.isSafeInteger(input.presetRevision) || input.presetRevision < 1) {
      throw new Error("preset revision is invalid");
    }
    if (input.agents.length > MAX_RUNNER_AGENTS) throw new Error("that is more agents than one runner may claim");

    // Only agents this member owns. A runner acts for its owner; a device may
    // not volunteer to answer for somebody else's agent.
    const seen = new Set<string>();
    const claims = input.agents
      .filter((claim) => !seen.has(claim.agentId) && seen.add(claim.agentId) !== undefined)
      .map((claim) => {
        assertOpaqueId(claim.presetId, "preset id");
        return { agent: this.requireOwnedAgent(claim.agentId, actor.id), presetId: claim.presetId };
      });

    // A device that registers again with an epoch it has already used would let
    // a stale process reclaim agents a newer one took.
    const existing = this.readRunnerDevice(input.deviceId);
    if (existing !== null) {
      if (existing.member_id !== actor.id) throw new Error("device is registered to another member");
      if (input.runnerEpoch < existing.runner_epoch) throw new Error("runner epoch has already moved on");
    }

    const outcome = await this.commitMutation({ scope: "runner.register", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        `INSERT INTO runner_devices(device_id, member_id, runner_epoch, preset_revision, registered_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           runner_epoch = excluded.runner_epoch,
           preset_revision = excluded.preset_revision,
           last_seen_at = excluded.last_seen_at`,
        input.deviceId, actor.id, input.runnerEpoch, input.presetRevision, input.now, input.now,
      );

      // A signed registration carrying a higher preset revision is the machine
      // reporting that somebody at that computer completed a local change, so
      // every ask made against a lower revision is answered here (R05).
      const confirmedRequests = this.confirmLocalPresetRequests(input.deviceId, input.presetRevision, input.now);

      const displaced = new Set<string>();
      for (const claim of claims) {
        const current = this.ctx.storage.sql
          .exec<{ device_id: string }>("SELECT device_id FROM runner_agents WHERE agent_id = ?", claim.agent.id)
          .toArray()[0];
        if (current !== undefined && current.device_id !== input.deviceId) displaced.add(current.device_id);
        this.ctx.storage.sql.exec(
          `INSERT INTO runner_agents(agent_id, device_id, assigned_at, preset_id) VALUES (?, ?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             device_id = excluded.device_id, assigned_at = excluded.assigned_at, preset_id = excluded.preset_id`,
          claim.agent.id, input.deviceId, input.now, claim.presetId,
        );
        // A wake still addressed to the machine that just lost this agent would
        // wake a runner that is no longer responsible for it.
        this.ctx.storage.sql.exec(
          "DELETE FROM runner_wakes WHERE agent_id = ? AND device_id <> ?", claim.agent.id, input.deviceId,
        );
      }

      // Agents this device used to answer for and no longer claims are released
      // rather than left pointing at a process that has stopped watching them.
      const released = this.ctx.storage.sql
        .exec<{ agent_id: string }>("SELECT agent_id FROM runner_agents WHERE device_id = ?", input.deviceId)
        .toArray()
        .map((row) => row.agent_id)
        .filter((agentId) => !claims.some((claim) => claim.agent.id === agentId));
      for (const agentId of released) {
        this.ctx.storage.sql.exec("DELETE FROM runner_agents WHERE agent_id = ?", agentId);
        this.ctx.storage.sql.exec("DELETE FROM runner_wakes WHERE agent_id = ?", agentId);
      }

      return {
        result: {
          deviceId: input.deviceId,
          runnerEpoch: input.runnerEpoch,
          agentIds: claims.map((claim) => claim.agent.id),
          displacedDeviceIds: [...displaced].sort(),
          releasedAgentIds: released,
          confirmedRequests,
        },
        effects: {
          audit: {
            eventType: "runner.registered",
            outcome: "allowed",
            requesterKind: "member",
            requesterId: actor.id,
            subjectKind: "device",
            subjectId: input.deviceId,
            // Counts and revisions only. What the presets are is the machine's
            // business, and an audit record outlives the thing it describes.
            metadata: {
              agent_count: claims.length,
              released_count: released.length,
              runner_epoch: input.runnerEpoch,
              config_revision: input.presetRevision,
              local_reviews_confirmed: confirmedRequests,
            },
          },
        } satisfies MutationEffects,
      };
    });

    // Whatever was already connected for a displaced agent is told to stop, so
    // two machines are never both working the same queue.
    for (const deviceId of outcome.result.displacedDeviceIds) {
      for (const agentId of outcome.result.agentIds) {
        this.sendRunnerFrame(deviceId, { type: "stop", agentId, reason: "reassigned_to_another_device" });
      }
    }
    for (const agentId of outcome.result.releasedAgentIds) {
      this.sendRunnerFrame(input.deviceId, { type: "stop", agentId, reason: "released_by_runner" });
    }
    // An older process on this same device is no longer the runner.
    this.closeSupersededRunnerSockets(input.deviceId, input.runnerEpoch);
    return {
      deviceId: outcome.result.deviceId,
      runnerEpoch: outcome.result.runnerEpoch,
      agentIds: outcome.result.agentIds,
      displacedDeviceIds: outcome.result.displacedDeviceIds,
      confirmedLocalReviews: outcome.result.confirmedRequests,
    };
  }

  /**
   * How much work is waiting for the agents this device answers for.
   *
   * The runner asks on every connection and after every process exit, and that
   * is what closes the lost-wake race without anything being held open. D03
   * measured the cost: one bounded call is the entire price of a wake that
   * never arrived, which is why this design does not need a parked request to
   * avoid losing work.
   */
  runnerQueueDepth(input: { actor: Actor; deviceId: string; now: number }): {
    runnerEpoch: number;
    agents: readonly {
      agentId: string;
      handle: string;
      presetId: string;
      depth: number;
      status: AgentRow["status"];
      /**
       * What an owner has asked somebody to do at this computer, so the daemon
       * can say it out loud. Intents from a closed set and nothing else: this
       * field can never carry an instruction, a path or a value (R05).
       */
      localReviews: readonly LocalPresetIntent[];
    }[];
  } {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const device = this.requireRunnerDevice(input.deviceId, actor.id);
    this.ctx.storage.sql.exec(
      "UPDATE runner_devices SET last_seen_at = ? WHERE device_id = ?", input.now, input.deviceId,
    );

    const agents: {
      agentId: string; handle: string; presetId: string; depth: number;
      status: AgentRow["status"]; localReviews: readonly LocalPresetIntent[];
    }[] = [];
    const rows = this.ctx.storage.sql
      .exec<{ agent_id: string; preset_id: string }>(
        "SELECT agent_id, preset_id FROM runner_agents WHERE device_id = ? ORDER BY agent_id", input.deviceId,
      )
      .toArray();
    for (const row of rows) {
      const agent = readAgent(this.ctx.storage, row.agent_id);
      if (agent === null) continue;
      // A paused or archived agent reports no depth. Its queue may not be
      // empty, but nothing on this machine should start a process for it.
      const depth = agent.status === "active"
        ? this.ctx.storage.sql
            .exec<{ depth: number }>(
              // Work a runner could actually claim right now. A leased item is
              // somebody else's turn, and counting it would have the runner
              // start a process for work it is about to be refused.
              `SELECT COUNT(*) AS depth FROM agent_queue
               WHERE agent_id = ? AND execution_state IN ('pending', 'needs_attention') AND not_before <= ?`,
              agent.id,
              input.now,
            )
            .one().depth
        : 0;
      agents.push({
        agentId: agent.id, handle: agent.handle, presetId: row.preset_id, depth, status: agent.status,
        localReviews: this.pendingLocalPresetIntents(input.deviceId, agent.id),
      });
    }
    return { runnerEpoch: device.runner_epoch, agents };
  }

  /** What a runner sees of its own registration, for a status command. */
  describeRunner(input: { actor: Actor; deviceId: string }): {
    deviceId: string;
    runnerEpoch: number;
    presetRevision: number;
    connected: boolean;
    pendingWakes: number;
    agentIds: readonly string[];
  } {
    const actor = this.authorizeActor(input.actor);
    const device = this.requireRunnerDevice(input.deviceId, actor.id);
    return {
      deviceId: device.device_id,
      runnerEpoch: device.runner_epoch,
      presetRevision: device.preset_revision,
      connected: this.ctx.getWebSockets(runnerSocketTag(device.device_id)).length > 0,
      pendingWakes: this.ctx.storage.sql
        .exec<{ pending: number }>(
          "SELECT COUNT(*) AS pending FROM runner_wakes WHERE device_id = ? AND delivered_at IS NULL", device.device_id,
        )
        .one().pending,
      agentIds: this.ctx.storage.sql
        .exec<{ agent_id: string }>("SELECT agent_id FROM runner_agents WHERE device_id = ? ORDER BY agent_id", device.device_id)
        .toArray()
        .map((row) => row.agent_id),
    };
  }

  /**
   * Stop answering for these agents, and stop anything already running.
   *
   * This is the offline half of the stop story: an owner turning a runner off
   * from anywhere, without needing the machine to be reachable. The rows go
   * away, so nothing new is queued for it; the frames are best effort, because
   * a machine that is not listening is exactly the case this must still work in.
   */
  async releaseRunner(input: { actor: Actor; deviceId: string; reason?: string | null; now: number }): Promise<{ released: number }> {
    const actor = this.authorizeActor(input.actor);
    const device = this.requireRunnerDevice(input.deviceId, actor.id);
    const reason = (input.reason ?? "released_by_owner").slice(0, 200);
    const outcome = await this.commitMutation({ scope: "runner.release", now: input.now }, () => {
      const agentIds = this.ctx.storage.sql
        .exec<{ agent_id: string }>("SELECT agent_id FROM runner_agents WHERE device_id = ?", device.device_id)
        .toArray()
        .map((row) => row.agent_id);
      this.ctx.storage.sql.exec("DELETE FROM runner_agents WHERE device_id = ?", device.device_id);
      this.ctx.storage.sql.exec("DELETE FROM runner_wakes WHERE device_id = ?", device.device_id);
      this.ctx.storage.sql.exec("DELETE FROM runner_devices WHERE device_id = ?", device.device_id);
      return {
        result: { agentIds },
        effects: {
          audit: {
            eventType: "runner.released", outcome: "allowed", requesterKind: "member", requesterId: actor.id,
            subjectKind: "device", subjectId: device.device_id,
            metadata: { agent_count: agentIds.length, reason },
          },
        } satisfies MutationEffects,
      };
    });
    for (const agentId of outcome.result.agentIds) {
      this.sendRunnerFrame(device.device_id, { type: "stop", agentId, reason });
    }
    for (const socket of this.ctx.getWebSockets(runnerSocketTag(device.device_id))) {
      try {
        socket.close(4004, "runner released");
      } catch {
        // Already gone, which is the outcome this was asking for.
      }
    }
    return { released: outcome.result.agentIds.length };
  }

  /* -- runner internals ------------------------------------------------ */

  /**
   * Accept a runner's outbound connection.
   *
   * Outbound, and only outbound: nothing listens on the machine, no port is
   * opened, and the workspace never dials a home network. The runner connects
   * to the workspace and the workspace answers on the socket the runner already
   * holds — which is what makes this work from a laptop behind NAT without any
   * of it being reachable from the internet.
   */
  private acceptRunnerSocket(request: Request): Response {
    const url = new URL(request.url);
    const memberId = request.headers.get("x-lepidy-member-id") ?? "";
    const authorizationEpoch = Number(request.headers.get("x-lepidy-authorization-epoch"));
    const deviceId = request.headers.get("x-lepidy-device-id") ?? "";
    const runnerEpoch = Number(url.searchParams.get("runner_epoch") ?? "");
    if (!this.authorizeMember(memberId, authorizationEpoch)) {
      return new Response("Forbidden", { status: 403 });
    }
    const device = this.readRunnerDevice(deviceId);
    // A socket is not a registration. A device that has not registered, or that
    // has been released, or whose epoch has moved on, has nothing to listen for.
    if (device === null || device.member_id !== memberId) {
      return new Response("Runner is not registered", { status: 409 });
    }
    if (!Number.isSafeInteger(runnerEpoch) || runnerEpoch !== device.runner_epoch) {
      return new Response("Runner epoch is stale", { status: 409 });
    }

    const now = Date.now();
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [runnerSocketTag(deviceId)]);
    const attachment: RunnerAttachment = { kind: "runner", deviceId, memberId, authorizationEpoch, runnerEpoch, connectedAt: now };
    pair[1].serializeAttachment(attachment);
    this.ctx.storage.sql.exec("UPDATE runner_devices SET last_seen_at = ? WHERE device_id = ?", now, deviceId);

    const agentIds = this.ctx.storage.sql
      .exec<{ agent_id: string }>("SELECT agent_id FROM runner_agents WHERE device_id = ? ORDER BY agent_id", deviceId)
      .toArray()
      .map((row) => row.agent_id);
    this.sendRunnerFrame(pair[1], { type: "welcome", deviceId, runnerEpoch, agentIds });
    // Whatever was queued while nobody was listening is delivered now. This is
    // the reconnect path, and it is the only path: the same code runs on a
    // first connection and after an eviction, so it is exercised constantly
    // rather than only during an incident.
    this.flushRunnerWakes(deviceId, now);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * A runner has nothing it needs to tell the workspace over this socket.
   *
   * Everything a runner *does* — claiming, starting, completing — happens over
   * signed MCP calls that carry their own authority. Accepting instructions
   * here would be a second, weaker path to the same effects, so there isn't one.
   */
  private runnerSocketMessage(socket: WebSocket, attachment: RunnerAttachment, message: string | null): void {
    if (!this.authorizeMember(attachment.memberId, attachment.authorizationEpoch)) {
      socket.close(4003, "membership authority changed");
      return;
    }
    const device = this.readRunnerDevice(attachment.deviceId);
    if (device === null || device.runner_epoch !== attachment.runnerEpoch) {
      socket.close(4004, "runner registration has moved on");
      return;
    }
    // One frame is accepted, and it says nothing: a keepalive the runtime's
    // auto-response cannot cover because the runner sends it on its own timer.
    if (message !== null && message.length <= 64 && message.includes("ping")) {
      try {
        socket.send(JSON.stringify({ type: "pong" }));
      } catch {
        // Gone; the next connection collects whatever is pending.
      }
      return;
    }
    socket.close(4002, "runner sockets receive only");
  }

  /**
   * Record that an agent has work, inside the caller's transaction.
   *
   * The wake commits with the queue row it announces, so it cannot be lost by a
   * delivery that failed, and delivery is staged rather than done here: a
   * transaction that rolls back must not leave a runner having been told about
   * work that does not exist.
   */
  private recordRunnerWake(agentId: string, now: number): void {
    const assignment = this.ctx.storage.sql
      .exec<{ device_id: string; preset_id: string }>(
        "SELECT device_id, preset_id FROM runner_agents WHERE agent_id = ?", agentId,
      )
      .toArray()[0];
    if (assignment === undefined) return;
    const requestId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO runner_wakes(agent_id, device_id, request_id, enqueued_at, delivered_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(agent_id, device_id) DO UPDATE SET
         request_id = excluded.request_id, enqueued_at = excluded.enqueued_at, delivered_at = NULL`,
      agentId, assignment.device_id, requestId, now,
    );
    this.stagedRunnerWakes.set(`${assignment.device_id} ${agentId}`, {
      deviceId: assignment.device_id,
      agentId,
      presetId: assignment.preset_id,
      requestId,
    });
  }

  /** Select exactly one configured execution lane for a committed queue item. */
  private recordRuntimeWake(input: {
    agentId: string;
    messageId: string;
    requesterMemberId: string;
    now: number;
  }): void {
    const { agentId, messageId, now } = input;
    const config = this.ctx.storage.sql.exec<AgentRuntimeConfigRow>(
      "SELECT * FROM agent_runtime_configs WHERE agent_id = ?", agentId,
    ).toArray()[0];
    // An agent whose owners run it from their own MCP client has no machine to
    // wake and no provider to call. The queue row still exists; the client
    // reads it the next time it asks.
    if (config?.kind === "connected") return;
    if (!config || config.kind === "local") {
      // The work is queued either way. What this decides is only whether a
      // process starts on somebody's computer without them asking for it, and
      // a refusal here leaves the item for an owner to start by hand rather
      // than dropping it (R05).
      if (this.localStartDecision(agentId, input.requesterMemberId).start) this.recordRunnerWake(agentId, now);
      return;
    }
    if (config.status !== "active") return;
    if (config.kind === "custom") {
      const deliveryId = crypto.randomUUID();
      const depth = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM agent_queue WHERE agent_id = ? AND execution_state = 'pending'", agentId,
      ).one().count;
      this.ctx.storage.sql.exec(
        `INSERT INTO custom_runtime_deliveries(delivery_id, agent_id, queue_depth, state, created_at)
         VALUES (?, ?, ?, 'pending', ?)`, deliveryId, agentId, depth, now,
      );
      enqueueOutbox(this.ctx.storage, [{ id: `custom_wake.${deliveryId}`, kind: "custom_runtime_wake",
        dedupeKey: `custom_runtime_wake:${deliveryId}`, payload: { deliveryId, agentId } }], now);
    } else {
      const runId = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT INTO runtime_runs(id, agent_id, kind, origin_message_id, budget_cents, state, created_at, updated_at)
         VALUES (?, ?, 'mention', ?, ?, 'queued', ?, ?)`,
        runId, agentId, messageId, config.budget_cents, now, now,
      );
      enqueueOutbox(this.ctx.storage, [{ id: `cloud_run.${runId}`, kind: "cloud_runtime_mention",
        dedupeKey: `cloud_runtime_mention:${runId}`, payload: { runId, agentId } }], now);
    }
    scheduleDueWork(this.ctx.storage, [{ id: OUTBOX_FLUSH_WORK_ID, kind: "outbox_flush", dueAt: now }], now);
  }

  /**
   * Deliver the wakes a committed transaction produced.
   *
   * Called by `commitMutation` after the durable write and never before it, so
   * a runner is only ever woken for work that actually exists.
   */
  private flushStagedRunnerWakes(now: number): void {
    if (this.stagedRunnerWakes.size === 0) return;
    const staged = [...this.stagedRunnerWakes.values()];
    this.stagedRunnerWakes.clear();
    for (const wake of staged) {
      if (this.deliverRunnerWake(wake)) {
        this.ctx.storage.sql.exec(
          "UPDATE runner_wakes SET delivered_at = ? WHERE agent_id = ? AND device_id = ?", now, wake.agentId, wake.deviceId,
        );
      }
    }
  }

  /** Hand a device every wake it has not been given, oldest first. */
  private flushRunnerWakes(deviceId: string, now: number): number {
    const pending = this.ctx.storage.sql
      .exec<{ agent_id: string; request_id: string }>(
        `SELECT agent_id, request_id FROM runner_wakes
         WHERE device_id = ? AND delivered_at IS NULL ORDER BY enqueued_at`,
        deviceId,
      )
      .toArray();
    let delivered = 0;
    for (const row of pending) {
      const assignment = this.ctx.storage.sql
        .exec<{ preset_id: string }>("SELECT preset_id FROM runner_agents WHERE agent_id = ? AND device_id = ?", row.agent_id, deviceId)
        .toArray()[0];
      if (assignment === undefined) continue;
      const sent = this.deliverRunnerWake({ deviceId, agentId: row.agent_id, presetId: assignment.preset_id, requestId: row.request_id });
      if (!sent) continue;
      this.ctx.storage.sql.exec(
        "UPDATE runner_wakes SET delivered_at = ? WHERE agent_id = ? AND device_id = ?", now, row.agent_id, deviceId,
      );
      delivered += 1;
    }
    return delivered;
  }

  /**
   * Build and send one wake.
   *
   * The frame is run through the same D05a parser the runner will use, here, on
   * the way out. It is not defensive theatre: it means a field added to this
   * frame in future has to be added to the trigger schema deliberately, in a
   * file whose whole purpose is to refuse remote launch configuration, rather
   * than arriving quietly on a socket.
   */
  private deliverRunnerWake(wake: { deviceId: string; agentId: string; presetId: string; requestId: string }): boolean {
    let trigger: LocalAgentTrigger;
    try {
      trigger = parseRemoteLocalAgentTrigger({
        workspaceId: this.workspaceKey(),
        agentId: wake.agentId,
        deviceId: wake.deviceId,
        presetId: wake.presetId,
        configRevision: this.readRunnerDevice(wake.deviceId)?.preset_revision ?? 1,
        requestId: wake.requestId,
      });
    } catch {
      return false;
    }
    return this.sendRunnerFrame(wake.deviceId, { type: "wake", trigger });
  }

  /** Send one frame to every socket a device holds. */
  private sendRunnerFrame(target: string | WebSocket, frame: RunnerFrame): boolean {
    const sockets = typeof target === "string" ? this.ctx.getWebSockets(runnerSocketTag(target)) : [target];
    let sent = false;
    for (const socket of sockets) {
      try {
        socket.send(JSON.stringify(frame));
        sent = true;
      } catch {
        // A socket that cannot be written to is gone. The durable wake stays
        // where it is and the next connection collects it.
      }
    }
    return sent;
  }

  /**
   * Stop whichever runner is working this agent.
   *
   * Called wherever an agent's authority ends — paused, archived, its delegation
   * revoked — so a machine that is mid-session finds out rather than finishing
   * the work anyway. It is best effort by design: the durable refusal is that
   * the agent's next bounded call is denied, which D03 measured at one call.
   */
  private stopRunnersForAgent(agentId: string, reason: string): void {
    const assignment = this.ctx.storage.sql
      .exec<{ device_id: string }>("SELECT device_id FROM runner_agents WHERE agent_id = ?", agentId)
      .toArray()[0];
    if (assignment === undefined) return;
    // A wake nobody has collected yet must not survive the stop that overtook it.
    this.ctx.storage.sql.exec("DELETE FROM runner_wakes WHERE agent_id = ?", agentId);
    this.sendRunnerFrame(assignment.device_id, { type: "stop", agentId, reason });
  }

  /** Close connections left over from an earlier registration of this device. */
  private closeSupersededRunnerSockets(deviceId: string, runnerEpoch: number): void {
    for (const socket of this.ctx.getWebSockets(runnerSocketTag(deviceId))) {
      const attachment = this.runnerAttachmentOf(socket);
      if (attachment === null || attachment.runnerEpoch >= runnerEpoch) continue;
      try {
        socket.close(4004, "runner registration has moved on");
      } catch {
        // Already gone.
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* The first local harness workflow (R02)                              */
  /* ------------------------------------------------------------------ */

  /**
   * Issue the session a harness on this device will speak MCP with.
   *
   * The runner asks for an agent it already answers for; the workspace finds
   * that agent's live delegation itself. The daemon never names a delegation,
   * so it cannot ask for authority it was not given — and because the token is
   * bound to this device, this runner epoch and this preset revision, a session
   * cannot outlive the configuration it was started under.
   *
   * A session is deliberately *reused* across runs. Starting a harness is
   * expensive, and a workspace that forced a new session per mention would
   * spend more on process startup than on work; the ceiling stays where A04 put
   * it — the delegation's lifetime and the eight-hour session cap.
   */
  async startRunnerSession(input: {
    actor: Actor;
    deviceId: string;
    agentId: string;
    capabilities?: readonly string[];
    now: number;
  }): Promise<AgentSessionGrant & { mcpPath: string }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const device = this.requireRunnerDevice(input.deviceId, actor.id);
    const assignment = this.ctx.storage.sql
      .exec<{ agent_id: string }>(
        "SELECT agent_id FROM runner_agents WHERE agent_id = ? AND device_id = ?",
        input.agentId,
        device.device_id,
      )
      .toArray()[0];
    // A device may only ask for the agents it is the designated runner for.
    // Anything else is reported the same way an unknown agent is.
    if (assignment === undefined) throw new Error("agent not found");

    const delegation = this.liveDelegationForAgent(assignment.agent_id, actor.id, input.now);
    if (delegation === null) throw new Error("this agent has no live delegation");
    const grant = await this.startAgentSession({
      actor: input.actor,
      delegationId: delegation,
      deviceId: device.device_id,
      runnerEpoch: device.runner_epoch,
      presetRevision: device.preset_revision,
      capabilities: input.capabilities ?? RUNNER_SESSION_CAPABILITIES,
      now: input.now,
    });
    const slug = this.workspaceSlug();
    if (slug === null) throw new Error("workspace is not initialized");
    return { ...grant, mcpPath: `/w/${slug}/mcp` };
  }

  /**
   * What happened to a run, as the machine saw it.
   *
   * A harness that was blocked by its own permission posture is the case this
   * exists for. It is not a failure and it is not a refusal by the workspace:
   * it is a person's decision waiting to be made, and it has to be visible as
   * one. Anything the stopped run had claimed goes to `needs_attention` rather
   * than back to `pending`, because retrying work that was blocked by policy
   * just blocks again — and the item is where an owner will look.
   *
   * Reported by the daemon rather than the harness, deliberately. A harness that
   * dies, hangs or is killed reports nothing, and those are exactly the cases
   * where somebody needs to be told.
   */
  async reportRunnerOutcome(input: {
    actor: Actor;
    deviceId: string;
    agentId: string;
    sessionId: string;
    outcome: RunnerRunOutcome;
    reason?: string | null;
    now: number;
  }): Promise<{ agentId: string; outcome: RunnerRunOutcome; itemsNeedingAttention: number }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const device = this.requireRunnerDevice(input.deviceId, actor.id);
    if (!RUNNER_RUN_OUTCOMES.includes(input.outcome)) throw new Error("unknown runner outcome");
    const assignment = this.ctx.storage.sql
      .exec<{ agent_id: string }>(
        "SELECT agent_id FROM runner_agents WHERE agent_id = ? AND device_id = ?",
        input.agentId,
        device.device_id,
      )
      .toArray()[0];
    if (assignment === undefined) throw new Error("agent not found");
    const agent = this.requireOwnedAgent(assignment.agent_id, actor.id);
    // Free text from the machine, and it is shown to a person, so it is bounded
    // and never trusted to be anything but a note.
    const reason = (input.reason ?? input.outcome).slice(0, 200);

    const outcome = await this.commitMutation({ scope: "runner.outcome", now: input.now }, () => {
      let itemsNeedingAttention = 0;
      if (input.outcome !== "completed") {
        // Only what *this* session had claimed. A run reporting an outcome must
        // not be able to disturb another runner's in-flight work.
        const stranded = this.ctx.storage.sql
          .exec<{ id: string }>(
            `SELECT id FROM agent_queue
             WHERE agent_id = ? AND lease_agent_session_id = ? AND execution_state = 'claimed'`,
            agent.id,
            input.sessionId,
          )
          .toArray();
        for (const item of stranded) {
          this.ctx.storage.sql.exec(
            `UPDATE agent_queue SET execution_state = 'needs_attention', lease_token_hash = NULL,
               lease_expires_at = NULL WHERE id = ? AND execution_state = 'claimed'`,
            item.id,
          );
        }
        itemsNeedingAttention = stranded.length;
      }
      return {
        result: { agentId: agent.id, outcome: input.outcome, itemsNeedingAttention },
        effects: this.agentEffects("runner.run_reported", agent, actor, {
          device_id: device.device_id,
          session_id: input.sessionId,
          run_outcome: input.outcome,
          items_needing_attention: itemsNeedingAttention,
          reason,
        }),
      };
    });

    // An owner finds out where they already are. A blocked harness that only
    // showed up in a log is a harness nobody unblocks.
    if (input.outcome !== "completed") {
      for (const memberId of agentOwnerIds(this.ctx.storage, agent.id)) {
        this.broadcastToMember(memberId, {
          type: "agent",
          kind: "run_reported",
          agentId: agent.id,
          payload: { outcome: input.outcome, reason, itemsNeedingAttention: outcome.result.itemsNeedingAttention },
        });
      }
    }
    return outcome.result;
  }

  /** The agent's one live delegation from this owner, if it has one. */
  private liveDelegationForAgent(agentId: string, ownerMemberId: string, now: number): string | null {
    return (
      this.ctx.storage.sql
        .exec<{ id: string }>(
          `SELECT id FROM agent_delegations
           WHERE agent_id = ? AND owner_member_id = ? AND revoked_at IS NULL AND expires_at > ?
           ORDER BY created_at DESC LIMIT 1`,
          agentId,
          ownerMemberId,
          now,
        )
        .toArray()[0]?.id ?? null
    );
  }

  private readRunnerDevice(deviceId: string): RunnerDeviceRow | null {
    if (deviceId.length === 0) return null;
    return (
      this.ctx.storage.sql
        .exec<RunnerDeviceRow>(
          `SELECT device_id, member_id, runner_epoch, preset_revision, registered_at, last_seen_at
           FROM runner_devices WHERE device_id = ?`,
          deviceId,
        )
        .toArray()[0] ?? null
    );
  }

  /** Somebody else's device is reported as unregistered, not as forbidden. */
  private requireRunnerDevice(deviceId: string, memberId: string): RunnerDeviceRow {
    const device = this.readRunnerDevice(deviceId);
    if (device === null || device.member_id !== memberId) throw new Error("runner is not registered");
    return device;
  }

  /* ------------------------------------------------------------------ */
  /* Alarm scheduler, transactional outbox and audit baseline (F06)      */
  /* ------------------------------------------------------------------ */

  /**
   * Run one mutation transaction, discarding any wake it staged if it fails.
   */
  private runTransactionOrDiscardWakes<T>(apply: () => T): T {
    try {
      return this.ctx.storage.transactionSync(apply);
    } catch (error) {
      this.stagedRunnerWakes.clear();
      throw error;
    }
  }

  /**
   * The single durable transaction envelope every workspace mutation uses.
   * The caller's rows, the audit entry, the outbox records, the realtime replay
   * entries, the follow-up deadlines and the idempotency receipt all commit
   * together or not at all. Delivery happens afterwards, on the alarm.
   */
  async commitMutation<T>(
    input: {
      scope: string;
      idempotencyKey?: string | null;
      requestHash?: string;
      now: number;
      idempotencyTtlMs?: number;
    },
    apply: () => { result: T; effects?: MutationEffects },
  ): Promise<MutationOutcome<T>> {
    const schema = readWorkspaceSchema(this.ctx.storage);
    if (schema.status !== "ready") throw new Error("workspace is quarantined");

    const key = input.idempotencyKey ? parseIdempotencyKey(input.idempotencyKey) : null;
    if (input.idempotencyKey && key === null) throw new Error("invalid idempotency key");
    const requestHash = input.requestHash ?? "";

    // A rolled-back transaction leaves nothing owed. Without this, a wake
    // staged by a mutation that failed would be delivered by whichever mutation
    // committed next, waking a runner for work that was never written.
    this.stagedRunnerWakes.clear();
    const committed = this.runTransactionOrDiscardWakes(() => {
      if (key !== null) {
        const stored = this.ctx.storage.sql
          .exec<{ request_hash: string; response_json: string }>(
            "SELECT request_hash, response_json FROM idempotency_keys WHERE scope = ? AND key = ?",
            input.scope,
            key,
          )
          .toArray()[0];
        if (stored) {
          if (stored.request_hash !== requestHash) {
            throw new Error("idempotency key reuse with a different request");
          }
          return {
            replayed: true,
            result: (JSON.parse(stored.response_json) as { value: T }).value,
            audit: null,
            outboxQueued: 0,
          };
        }
      }

      const { result, effects } = apply();
      const audit = effects?.audit
        ? appendAuditEntry(this.ctx.storage, this.workspaceKey(), effects.audit, input.now)
        : null;
      const outboxQueued = enqueueOutbox(this.ctx.storage, effects?.outbox ?? [], input.now);
      appendReplayEvents(this.ctx.storage, effects?.replay ?? [], input.now);

      const due: DueWorkInput[] = [...(effects?.dueWork ?? [])];
      if (outboxQueued > 0) {
        due.push({ id: OUTBOX_FLUSH_WORK_ID, kind: "outbox_flush", dueAt: input.now });
      }
      scheduleDueWork(this.ctx.storage, due, input.now);

      if (key !== null) {
        this.ctx.storage.sql.exec(
          `INSERT INTO idempotency_keys(scope, key, request_hash, response_json, status_code, created_at, expires_at)
           VALUES (?, ?, ?, ?, 200, ?, ?)`,
          input.scope,
          key,
          requestHash,
          JSON.stringify({ value: result }),
          input.now,
          input.now + (input.idempotencyTtlMs ?? RETENTION_MS.idempotencyResult),
        );
      }

      return { replayed: false, result, audit, outboxQueued };
    });

    // Runner wakes are sent here and nowhere else: after the transaction has
    // committed, never inside it. A rolled-back transaction must not leave a
    // machine having been told about work that does not exist.
    this.flushStagedRunnerWakes(input.now);
    return { ...committed, alarmAt: await this.armAlarm() };
  }

  /** Add or advance multiplexed deadlines and re-point the object's one alarm. */
  async scheduleWork(items: readonly DueWorkInput[], now: number): Promise<{ alarmAt: number | null }> {
    this.ctx.storage.transactionSync(() => scheduleDueWork(this.ctx.storage, items, now));
    return { alarmAt: await this.armAlarm() };
  }

  async schedulerState(): Promise<SchedulerState> {
    const counts = this.ctx.storage.sql
      .exec<{ status: string; count: number }>(
        "SELECT status, COUNT(*) AS count FROM pending_events GROUP BY status",
      )
      .toArray();
    const auditSequence =
      this.ctx.storage.sql
        .exec<{ sequence: number | null }>("SELECT MAX(sequence) AS sequence FROM audit_events")
        .one().sequence ?? 0;
    return {
      alarmAt: await this.ctx.storage.getAlarm(),
      dueWork: listDueWork(this.ctx.storage),
      pendingOutbox: counts.find((row) => row.status === "pending")?.count ?? 0,
      deadOutbox: counts.find((row) => row.status === "dead")?.count ?? 0,
      auditSequence,
    };
  }

  async alarm(): Promise<void> {
    await this.runDueWork(Date.now());
  }

  /**
   * Drain everything due at `now`. A handler that throws backs its own item off
   * without stalling the other deadlines sharing this alarm.
   */
  async runDueWork(now: number, dispatcher?: OutboxDispatcher): Promise<DueWorkReport> {
    const claimed = claimDueWork(this.ctx.storage, now, DUE_WORK_BATCH_SIZE);
    const processed: string[] = [];
    const failed: { id: string; kind: string; error: string; retried: boolean }[] = [];
    let outbox = { attempted: 0, delivered: 0, retried: 0, dead: 0 };
    let retention: RetentionSweepReport | null = null;
    let anchor: AuditAnchor | null = null;
    let scheduledSends = { sent: 0, failed: 0 };
    let approvals = { expired: 0 };

    for (const item of claimed) {
      try {
        switch (item.kind) {
          case "outbox_flush": {
            const report = await this.drainOutbox(now, dispatcher);
            outbox = {
              attempted: outbox.attempted + report.attempted,
              delivered: outbox.delivered + report.delivered,
              retried: outbox.retried + report.retried,
              dead: outbox.dead + report.dead,
            };
            break;
          }
          case "retention_sweep": {
            const swept = this.ctx.storage.transactionSync(() => sweepRetention(this.ctx.storage, now));
            // Several sweep deadlines can come due together; report their sum
            // rather than letting the last one hide the others.
            retention =
              retention === null
                ? swept
                : (Object.fromEntries(
                    Object.entries(swept).map(([key, value]) => [
                      key,
                      value + retention![key as keyof RetentionSweepReport],
                    ]),
                  ) as RetentionSweepReport);
            break;
          }
          case "scheduled_send": {
            const report = await this.deliverDueScheduledMessages(now);
            scheduledSends = {
              sent: scheduledSends.sent + report.sent,
              failed: scheduledSends.failed + report.failed,
            };
            break;
          }
          case "vault_approval_expiry": {
            const report = await this.expireVaultApprovals(now);
            approvals = { expired: approvals.expired + report.expired };
            break;
          }
          case "runtime_reconciliation":
            await this.reconcileCloudRuntimes(now);
            break;
          case "audit_anchor":
            anchor = this.ctx.storage.transactionSync(() =>
              writeAuditAnchor(this.ctx.storage, this.workspaceKey(), now),
            );
            break;
          default:
            throw new Error(`no handler for due work kind ${item.kind}`);
        }
        this.ctx.storage.transactionSync(() => completeDueWork(this.ctx.storage, item, now));
        processed.push(item.id);
      } catch (error) {
        const deferred = this.ctx.storage.transactionSync(() =>
          deferDueWork(this.ctx.storage, item, now, error),
        );
        failed.push({
          id: item.id,
          kind: item.kind,
          error: redactedError(error),
          retried: deferred.retried,
        });
      }
    }

    const stillPending = nextPendingOutboxAt(this.ctx.storage);
    if (stillPending !== null) {
      this.ctx.storage.transactionSync(() =>
        scheduleDueWork(
          this.ctx.storage,
          [{ id: OUTBOX_FLUSH_WORK_ID, kind: "outbox_flush", dueAt: stillPending }],
          now,
        ),
      );
    }

    return {
      now,
      processed,
      failed,
      outbox,
      retention,
      anchor,
      scheduledSends,
      approvals,
      alarmAt: await this.armAlarm(),
    };
  }

  /**
   * Attempt delivery for every outbox entry whose backoff has elapsed. Delivery
   * is at-least-once: `dedupeKey` travels with the payload so a consumer can
   * discard a duplicate produced by a lost acknowledgement.
   */
  async drainOutbox(
    now: number,
    dispatcher: OutboxDispatcher = (entry) => this.dispatchToQueue(entry),
    limit = OUTBOX_BATCH_SIZE,
  ): Promise<{ attempted: number; delivered: number; retried: number; dead: number }> {
    const batch = claimOutboxBatch(this.ctx.storage, now, limit);
    let delivered = 0;
    let retried = 0;
    let dead = 0;

    for (const entry of batch) {
      let outcome: OutboxOutcome;
      try {
        outcome = await dispatcher(entry);
      } catch (error) {
        outcome = { status: "retry", error: redactedError(error) };
      }
      const settled = this.ctx.storage.transactionSync(() =>
        settleOutbox(this.ctx.storage, entry, outcome, now),
      );
      if (settled === "delivered") delivered += 1;
      else if (settled === "dead") {
        dead += 1;
        if (entry.kind === "custom_runtime_wake") {
          const payload = entry.payload as { deliveryId?: unknown };
          if (typeof payload.deliveryId === "string") {
            this.ctx.storage.sql.exec(
              "UPDATE custom_runtime_deliveries SET state = 'dead', completed_at = ? WHERE delivery_id = ?",
              now, payload.deliveryId,
            );
          }
        }
      }
      else retried += 1;
    }

    return { attempted: batch.length, delivered, retried, dead };
  }

  recordAuditEvent(entry: AuditEntryInput, now: number): AppendedAudit {
    const schema = readWorkspaceSchema(this.ctx.storage);
    if (schema.status !== "ready") throw new Error("workspace is quarantined");
    return this.ctx.storage.transactionSync(() =>
      appendAuditEntry(this.ctx.storage, this.workspaceKey(), entry, now),
    );
  }

  auditTrail(fromSequence = 0, limit = 200): StoredAuditEntry[] {
    return readAuditEntries(this.ctx.storage, this.workspaceKey(), fromSequence, limit);
  }

  verifyAuditTrail(): AuditChainVerification {
    return verifyStoredAuditChain(this.ctx.storage, this.workspaceKey());
  }

  /** Stable per-tenant binding for the audit chain: the object's own id. */
  private workspaceKey(): string {
    return this.ctx.id.toString();
  }

  private transportSecretKey(): string {
    const key = this.env.TRANSPORT_SECRET_KEY;
    if (!key || key.length < 32) throw new Error("platform transport-secret key is unavailable");
    return key;
  }

  private requireRuntimeConfig(agentId: string, kind: AgentRuntimeConfigRow["kind"]): AgentRuntimeConfigRow {
    const row = this.ctx.storage.sql.exec<AgentRuntimeConfigRow>(
      "SELECT * FROM agent_runtime_configs WHERE agent_id = ? AND kind = ?", agentId, kind,
    ).toArray()[0];
    if (!row) throw new Error(`${kind} runtime is not configured`);
    return row;
  }

  private async providerAccessToken(config: AgentRuntimeConfigRow, now: number): Promise<string> {
    if (!this.env.WIF_SIGNING_JWK) throw new Error("platform WIF signing key is unavailable");
    let jwk: JsonWebKey;
    try {
      jwk = JSON.parse(this.env.WIF_SIGNING_JWK) as JsonWebKey;
    } catch {
      throw new Error("platform WIF signing key is invalid");
    }
    const required = [config.wif_issuer, config.wif_audience, config.wif_subject, config.organization_id,
      config.provider_workspace_id, config.service_account_id, config.federation_rule_id];
    if (required.some((value) => !value)) throw new Error("cloud runtime authority is incomplete");
    const keyId = (jwk as JsonWebKey & { kid?: unknown }).kid;
    const assertion = await mintWifAssertion({ authority: {
      issuer: config.wif_issuer!, audience: config.wif_audience!, subject: config.wif_subject!,
      organizationId: config.organization_id!, workspaceId: config.provider_workspace_id!,
      serviceAccountId: config.service_account_id!, federationRuleId: config.federation_rule_id!,
    }, privateJwk: jwk, keyId: typeof keyId === "string" ? keyId : "current", now });
    try {
      const accessToken = (await exchangeWifAssertion({ assertion })).accessToken;
      if (config.wif_failures > 0) {
        this.ctx.storage.sql.exec("UPDATE agent_runtime_configs SET wif_failures = 0 WHERE agent_id = ?", config.agent_id);
      }
      return accessToken;
    } catch {
      const failures = config.wif_failures + 1;
      this.ctx.storage.sql.exec(
        "UPDATE agent_runtime_configs SET wif_failures = ?, status = CASE WHEN ? >= 3 THEN 'disconnected' ELSE status END, updated_at = ? WHERE agent_id = ?",
        failures, failures, now, config.agent_id,
      );
      throw new Error(failures >= 3 ? "cloud runtime authority was revoked or repeatedly refused" : "cloud runtime authentication failed");
    }
  }

  /** Resolve both address families and reject the whole name if either query fails. */
  private async resolvePublicDns(hostname: string): Promise<readonly string[]> {
    const lookup = async (type: "A" | "AAAA") => {
      const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
        headers: { accept: "application/dns-json" }, redirect: "manual", signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error("public egress DNS lookup failed");
      const body = await response.json() as { Answer?: { type?: unknown; data?: unknown }[] };
      const expectedType = type === "A" ? 1 : 28;
      return (body.Answer ?? []).filter((answer) => answer.type === expectedType).map((answer) => answer.data)
        .filter((value): value is string => typeof value === "string");
    };
    const [v4, v6] = await Promise.all([lookup("A"), lookup("AAAA")]);
    return [...v4, ...v6];
  }

  /** Point the object's one alarm at the earliest deadline it owns. */
  private async armAlarm(): Promise<number | null> {
    const due = nextDueAt(this.ctx.storage);
    const current = await this.ctx.storage.getAlarm();
    if (due === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return null;
    }
    // A deadline recovered from storage can be in the past; the runtime still
    // refuses a non-positive alarm time.
    const target = Math.max(due, 1);
    if (current !== target) await this.ctx.storage.setAlarm(target);
    return target;
  }

  private async dispatchToQueue(entry: OutboxEntry): Promise<OutboxOutcome> {
    if (entry.kind === "custom_runtime_wake") return this.dispatchCustomRuntimeWake(entry);
    if (entry.kind === "cloud_runtime_mention") return this.dispatchCloudRuntimeMention(entry);
    if (entry.kind === "anthropic_resource_fetch") return this.dispatchAnthropicResourceFetch(entry);
    const queue = this.env.EVENTS;
    if (!queue) return { status: "retry", error: "events queue binding is unavailable" };
    try {
      await queue.send({
        workspace: this.workspaceKey(),
        id: entry.id,
        kind: entry.kind,
        dedupeKey: entry.dedupeKey,
        attempt: entry.attempts + 1,
        payload: entry.payload,
      });
      return { status: "delivered" };
    } catch (error) {
      return { status: "retry", error: redactedError(error) };
    }
  }

  private async dispatchAnthropicResourceFetch(entry: OutboxEntry): Promise<OutboxOutcome> {
    const payload = entry.payload as { eventType?: unknown; resourceId?: unknown; agentId?: unknown };
    if (typeof payload.eventType !== "string" || typeof payload.resourceId !== "string" || typeof payload.agentId !== "string") {
      return { status: "permanent", error: "invalid provider event payload" };
    }
    const config = this.ctx.storage.sql.exec<AgentRuntimeConfigRow>(
      "SELECT * FROM agent_runtime_configs WHERE agent_id = ? AND kind = 'claude_cloud' AND status IN ('pending', 'active')",
      payload.agentId,
    ).toArray()[0];
    if (!config) return { status: "permanent", error: "cloud runtime is disconnected" };
    try {
      const deleted = payload.eventType.endsWith(".deleted");
      let resource: Record<string, unknown> = { id: payload.resourceId, status: "terminated" };
      if (!deleted) {
        const family = payload.eventType.startsWith("session.") ? "sessions" :
          payload.eventType.startsWith("deployment_run.") ? "deployment_runs" :
          payload.eventType.startsWith("deployment.") ? "deployments" : null;
        if (!family) return { status: "delivered" };
        const response = await callManagedAgents({ accessToken: await this.providerAccessToken(config, Date.now()),
          path: `/v1/${family}/${payload.resourceId}` });
        if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("unknown provider resource response");
        resource = response as Record<string, unknown>;
      }
      const providerState = typeof resource.status === "string" ? resource.status :
        payload.eventType.includes("failed") ? "failed" : payload.eventType.includes("succeeded") ? "succeeded" : "running";
      const state = providerState === "idle" ? "idle" : providerState === "succeeded" ? "succeeded" :
        providerState === "failed" ? "failed" : providerState === "terminated" || providerState === "archived" ? "terminated" : "running";
      this.ctx.storage.sql.exec(
        `UPDATE runtime_runs SET state = ?, failure_code = CASE WHEN ? = 'failed' THEN 'provider_failed' ELSE failure_code END,
           updated_at = ? WHERE agent_id = ? AND (provider_session_id = ? OR provider_deployment_run_id = ?)`,
        state, state, Date.now(), payload.agentId, payload.resourceId, payload.resourceId,
      );
      return { status: "delivered" };
    } catch (error) {
      return { status: "retry", error: redactedError(error) };
    }
  }

  private async dispatchCustomRuntimeWake(entry: OutboxEntry): Promise<OutboxOutcome> {
    const payload = entry.payload as { deliveryId?: unknown; agentId?: unknown };
    if (typeof payload.deliveryId !== "string" || typeof payload.agentId !== "string") {
      return { status: "permanent", error: "invalid custom runtime outbox payload" };
    }
    const config = this.ctx.storage.sql.exec<AgentRuntimeConfigRow>(
      "SELECT * FROM agent_runtime_configs WHERE agent_id = ? AND kind = 'custom' AND status = 'active'", payload.agentId,
    ).toArray()[0];
    const delivery = this.ctx.storage.sql.exec<{ queue_depth: number; created_at: number }>(
      "SELECT queue_depth, created_at FROM custom_runtime_deliveries WHERE delivery_id = ? AND agent_id = ?",
      payload.deliveryId, payload.agentId,
    ).toArray()[0];
    if (!config || !delivery || !config.callback_url || !config.secret_envelope) {
      return { status: "permanent", error: "custom runtime is no longer active" };
    }
    const secret = await decryptTransportSecret(config.secret_envelope, this.transportSecretKey(),
      `custom:${this.workspaceKey()}:${payload.agentId}`);
    const wake = customWake({ delivery_id: payload.deliveryId, created_at: new Date(delivery.created_at).toISOString(),
      workspace_id: this.workspaceKey(), agent_id: payload.agentId, queue_depth: delivery.queue_depth });
    const result = await deliverCustomWake({ url: config.callback_url, wake, secret,
      resolve: (hostname) => this.resolvePublicDns(hostname), now: Date.now() });
    if (result.status === "delivered") {
      this.ctx.storage.sql.exec(
        "UPDATE custom_runtime_deliveries SET state = 'delivered', attempts = attempts + 1, completed_at = ? WHERE delivery_id = ?",
        Date.now(), payload.deliveryId,
      );
      return result;
    }
    this.ctx.storage.sql.exec(
      "UPDATE custom_runtime_deliveries SET attempts = attempts + 1, last_error = ? WHERE delivery_id = ?",
      redactedError(result.error), payload.deliveryId,
    );
    return result;
  }

  private async dispatchCloudRuntimeMention(entry: OutboxEntry): Promise<OutboxOutcome> {
    const payload = entry.payload as { runId?: unknown; agentId?: unknown };
    if (typeof payload.runId !== "string" || typeof payload.agentId !== "string") {
      return { status: "permanent", error: "invalid cloud runtime outbox payload" };
    }
    const config = this.ctx.storage.sql.exec<AgentRuntimeConfigRow>(
      "SELECT * FROM agent_runtime_configs WHERE agent_id = ? AND kind = 'claude_cloud' AND status = 'active'", payload.agentId,
    ).toArray()[0];
    const run = this.ctx.storage.sql.exec<{ origin_message_id: string | null; provider_session_id: string | null }>(
      "SELECT origin_message_id, provider_session_id FROM runtime_runs WHERE id = ? AND agent_id = ?", payload.runId, payload.agentId,
    ).toArray()[0];
    if (!config || !run?.origin_message_id) return { status: "permanent", error: "cloud runtime is no longer active" };
    if (run.provider_session_id) return { status: "delivered" };
    const message = this.ctx.storage.sql.exec<{ body_markdown: string }>(
      "SELECT body_markdown FROM messages WHERE id = ? AND deleted_at IS NULL", run.origin_message_id,
    ).toArray()[0];
    if (!message) return { status: "permanent", error: "originating work no longer exists" };
    try {
      this.ctx.storage.sql.exec("UPDATE runtime_runs SET state = 'starting', updated_at = ? WHERE id = ?", Date.now(), payload.runId);
      const accessToken = await this.providerAccessToken(config, Date.now());
      const response = await callManagedAgents({ accessToken, path: "/v1/sessions", body: {
        agent_id: config.provider_agent_id!, environment_id: config.provider_environment_id!,
        budget: { amount: String(config.budget_cents), currency: "USD" },
        events: [{ type: "user.message", content: message.body_markdown }],
        metadata: { lepidy_run_id: payload.runId },
      } });
      if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("unknown session response");
      const result = response as Record<string, unknown>;
      if (typeof result.id !== "string") throw new Error("unknown session response");
      const version = typeof result.agent_version === "string" ? result.agent_version : null;
      this.ctx.storage.sql.exec(
        `UPDATE runtime_runs SET provider_session_id = ?, resolved_agent_version = ?, state = 'running', updated_at = ?
         WHERE id = ? AND provider_session_id IS NULL`, result.id, version, Date.now(), payload.runId,
      );
      return { status: "delivered" };
    } catch (error) {
      this.ctx.storage.sql.exec(
        "UPDATE runtime_runs SET state = 'queued', failure_code = ?, updated_at = ? WHERE id = ?",
        redactedError(error), Date.now(), payload.runId,
      );
      return { status: "retry", error: redactedError(error) };
    }
  }

  private async reconcileCloudRuntimes(now: number): Promise<void> {
    const runs = this.ctx.storage.sql.exec<{ id: string; agent_id: string; provider_session_id: string | null; provider_deployment_run_id: string | null }>(
      `SELECT id, agent_id, provider_session_id, provider_deployment_run_id FROM runtime_runs
       WHERE state IN ('starting', 'running', 'idle') ORDER BY updated_at LIMIT 100`,
    ).toArray();
    for (const run of runs) {
      const config = this.requireRuntimeConfig(run.agent_id, "claude_cloud");
      const accessToken = await this.providerAccessToken(config, now);
      const path = run.provider_session_id
        ? `/v1/sessions/${run.provider_session_id}`
        : `/v1/deployment_runs/${run.provider_deployment_run_id}`;
      const response = await callManagedAgents({ accessToken, path });
      if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("unknown reconciliation response");
      const resource = response as Record<string, unknown>;
      const providerState = typeof resource.status === "string" ? resource.status : "running";
      const state = providerState === "idle" ? "idle" : providerState === "succeeded" ? "succeeded" :
        providerState === "failed" ? "failed" : providerState === "terminated" || providerState === "archived" ? "terminated" : "running";
      this.ctx.storage.sql.exec("UPDATE runtime_runs SET state = ?, updated_at = ? WHERE id = ?", state, now, run.id);
    }
  }

  private readStagedSnapshot(importId: string): SoloContentSnapshot {
    const header = this.ctx.storage.sql
      .exec<{ workspace_id: string; host_epoch: number; snapshot_checksum: string }>(
        "SELECT workspace_id, host_epoch, snapshot_checksum FROM solo_upgrade_imports WHERE import_id = ?",
        importId,
      )
      .one();
    const records = <T>(table: string): T[] =>
      this.ctx.storage.sql
        .exec<{ record_json: string }>(`SELECT record_json FROM ${table} WHERE import_id = ? ORDER BY record_id`, importId)
        .toArray()
        .map(({ record_json }) => JSON.parse(record_json) as T);
    return {
      version: 1,
      workspaceId: header.workspace_id,
      hostEpoch: header.host_epoch,
      channels: records("solo_upgrade_channels"),
      messages: records("solo_upgrade_messages"),
      attachments: records("solo_upgrade_attachments"),
      checksum: header.snapshot_checksum,
    };
  }

  private workspaceConfig(): {
    storage_mode: WorkspaceStorageMode;
    designated_host_device_id: string | null;
    host_epoch: number;
    host_lease_expires_at: number | null;
    relay_sequence_to_host: number;
    relay_sequence_from_host: number;
    routing_epoch: number;
  } {
    return this.ctx.storage.sql
      .exec<{
        storage_mode: WorkspaceStorageMode;
        designated_host_device_id: string | null;
        host_epoch: number;
        host_lease_expires_at: number | null;
        relay_sequence_to_host: number;
        relay_sequence_from_host: number;
        routing_epoch: number;
      }>(
        `SELECT storage_mode, designated_host_device_id, host_epoch,
                host_lease_expires_at, relay_sequence_to_host, relay_sequence_from_host, routing_epoch
         FROM workspace_config WHERE singleton = 1`,
      )
      .one();
  }
}
