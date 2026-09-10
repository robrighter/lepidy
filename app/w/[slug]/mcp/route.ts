import type { Actor, McpAttribution, McpPrincipal, Workspace } from "@/src/cloudflare/workspace";
import {
  MCP_TOOL_DEFINITIONS,
  bearerChallenge,
  bearerFromHeader,
  encodeAgentQueueCursor,
  parseAgentQueueCursor,
  parseMcpToolCall,
  protectedResourceMetadataUrl,
  workspaceResourceUri,
  type SupportedScope,
} from "@/src/domain/mcp-oauth";
import { commandHints, mcpInstructions } from "@/src/domain/agent-onboarding";
import { oauthEnvironment, requestOrigin, resolveWorkspaceBySlug } from "@/src/shell/oauth-server";

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  return handle(request, context, undefined, undefined, () =>
    Response.json({ error: "this endpoint answers JSON-RPC over POST" }, { status: 405 }),
  );
}

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return handle(request, context, undefined, undefined, () => jsonRpcError(null, -32700, "the body is not JSON"));
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return handle(request, context, undefined, undefined, () =>
      jsonRpcError(null, -32600, "a JSON-RPC request object is required"),
    );
  }
  const message = body as { id?: unknown; method?: unknown; params?: unknown };
  const id = message.id ?? null;
  const parsedCall = message.method === "tools/call" ? parseMcpToolCall(message.params) : null;
  const requiredScope = parsedCall?.ok ? parsedCall.requiredScope : undefined;

  return handle(request, context, parsedCall?.ok ? parsedCall.call.name : undefined, requiredScope, async (principal, workspace, bearerToken) => {
    switch (message.method) {
      case "initialize":
        return jsonRpcResult(id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "lepidy", version: "0.1.0" },
          // Layer 1 of the onboarding model: the only text every session pays
          // for, carrying the authority this connection acts with and the one
          // vault rule. Everything else is a denial hint, the skill or the
          // hook, none of which cost anything until they are needed.
          instructions: mcpInstructions(
            principal.credentialKind === "session"
              ? {
                  kind: "session",
                  agentHandle: principal.agentHandle,
                  ownerHandle: principal.handle,
                  delegationId: principal.delegationId,
                }
              : { kind: "oauth", handle: principal.handle },
          ),
        });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return jsonRpcResult(id, {
          tools: MCP_TOOL_DEFINITIONS
            .filter((tool) => principal.credentialKind === "oauth" || principal.capabilities.includes(tool.name))
            .map(({ requiredScope: _requiredScope, sessionCapable: _sessionCapable, ...tool }) => tool),
        });
      case "tools/call":
        if (parsedCall === null || !parsedCall.ok) {
          return jsonRpcError(id, -32602, parsedCall?.message ?? "invalid tool call");
        }
        try {
          const data = await dispatchTool(workspace, principal, bearerToken, parsedCall.call.name, parsedCall.call.arguments);
          return jsonRpcResult(id, toolResult(data, attribution(principal)));
        } catch (error) {
          return jsonRpcResult(id, toolResult({ error: toolError(error) }, attribution(principal), true));
        }
      default:
        return jsonRpcError(id, -32601, `unknown method ${String(message.method)}`);
    }
  });
}

type WorkspaceStub = DurableObjectStub<Workspace>;

async function dispatchTool(
  workspace: WorkspaceStub,
  principal: McpPrincipal,
  bearerToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const actor = actorFrom(principal);
  switch (name) {
    case "whoami":
      return {
        id: principal.memberId,
        handle: principal.handle,
        name: principal.displayName,
        role: principal.role,
        connection_id: principal.credentialKind === "oauth" ? principal.connectionId : null,
        session_id: principal.credentialKind === "session" ? principal.sessionId : null,
        delegation_id: principal.credentialKind === "session" ? principal.delegationId : null,
        agent_id: principal.credentialKind === "session" ? principal.agentId : null,
        client: principal.clientName ?? principal.clientId,
      };
    case "list_channels": {
      const listed = await workspace.browseChannels({ actor });
      const agent = principal.credentialKind === "session"
        ? delegatedAgent(await workspace.listAgents({ actor }), principal)
        : null;
      const visible = principal.credentialKind === "session" && agent !== null
        ? listed.channels.filter((channel) => channel.isMember && sessionChannelAllowed(principal, agent, channel.id))
        : listed.channels.filter((channel) => channel.isMember);
      return {
        channels: visible
          .filter((channel) => channel.kind === "public" || channel.kind === "private")
          .map((channel) => ({ id: channel.id, name: channel.slug ?? channel.name ?? channel.id, type: channel.kind })),
        conversations:
          args.include_dms === false
            ? []
            : visible
                .filter((channel) => channel.kind === "dm" || channel.kind === "group_dm")
                .map((channel) => ({
                  id: channel.id,
                  name: channel.name ?? channel.id,
                  type: channel.kind,
                  participant_ids: channel.participantIds,
                })),
      };
    }
    case "read_channel": {
      await assertSessionChannel(workspace, principal, actor, args.channel_id as string);
      const page = await workspace.readMcpChannelHistory({
        actor,
        channelId: args.channel_id as string,
        cursor: (args.cursor as string | undefined) ?? null,
        limit: args.limit as number | undefined,
      });
      return messagePage(page);
    }
    case "read_thread": {
      const page = await workspace.readMcpThreadHistory({
        actor,
        threadRootId: args.message_id as string,
        cursor: (args.cursor as string | undefined) ?? null,
        limit: args.limit as number | undefined,
      });
      if (page.messages[0]) await assertSessionChannel(workspace, principal, actor, page.messages[0].channelId);
      return messagePage(page);
    }
    case "post_message": {
      const connectionId = oauthConnectionId(principal);
      const posted = await workspace.postMcpMessage({
        actor,
        connectionId,
        idempotencyKey: args.idempotency_key as string,
        channelId: args.channel_id as string,
        bodyMarkdown: args.content as string,
        threadParentId: (args.parent_id as string | undefined) ?? null,
        now: Date.now(),
      });
      return postResult(posted);
    }
    case "list_queue": {
      await assertSessionChannel(workspace, principal, actor, args.channel_id as string);
      const queue = await workspace.readWorkQueue({
        actor,
        channelId: args.channel_id as string,
        statusId: (args.status_id as string | null | undefined) ?? null,
        limit: args.limit as number | undefined,
      });
      return {
        channel: { id: queue.channel.id, name: queue.channel.slug ?? queue.channel.name ?? queue.channel.id, ranking_emoji: queue.channel.sortEmoji },
        tabs: queue.tabs.map((tab) => ({ status_id: tab.id, label: tab.label, count: tab.count })),
        selected_status_id: queue.selectedStatusId,
        items: queue.page.messages.map((message) => ({
          message_id: message.id,
          author: message.authorDisplaySnapshot,
          content: message.bodyMarkdown,
          vote_count: message.voteCount,
          status_id: message.statusId,
          reply_count: message.replyCount,
          created_at: message.createdAt,
          form: message.formSubmission,
        })),
      };
    }
    case "set_item_status": {
      const readable = await workspace.readMcpThreadHistory({ actor, threadRootId: args.message_id as string, limit: 1 });
      const item = readable.messages[0];
      if (!item) throw new Error("queue item not found");
      await assertSessionChannel(workspace, principal, actor, item.channelId);
      const changed = await workspace.setItemStatus({
        actor, messageId: args.message_id as string, statusId: args.status_id as string | null, now: Date.now(),
      });
      return { message_id: args.message_id, status_id: args.status_id, changed: changed.changed };
    }
    case "submit_form": {
      await assertSessionChannel(workspace, principal, actor, args.channel_id as string);
      const sent = await workspace.submitForm({
        actor, channelId: args.channel_id as string, values: args.values as Record<string, unknown>,
        idempotencyKey: args.idempotency_key as string, now: Date.now(),
      });
      return postResult(sent);
    }
    case "list_agents": {
      const listed = await workspace.listAgents({ actor });
      return {
        agents: listed.agents
          .filter((agent) => agent.isOwner && (principal.credentialKind === "oauth" || agent.id === principal.agentId))
          .map((agent) => ({
          id: agent.id,
          handle: `@${agent.handle}`,
          name: agent.displayName,
          description: agent.description,
          status: agent.status,
          unread: agent.queueDepth,
          owners: agent.ownerIds,
          scope: { mode: agent.scopeMode, channel_ids: agent.scopeChannelIds },
        })),
      };
    }
    case "agent_inbox": {
      assertSessionAgent(principal, args.agent as string);
      const cursorValue = args.cursor;
      const cursor = cursorValue === undefined ? null : parseAgentQueueCursor(cursorValue);
      if (cursorValue !== undefined && cursor === null) throw new Error("invalid queue cursor");
      const page = await workspace.readAgentQueuePage({
        actor,
        agent: args.agent as string,
        limit: args.limit as number | undefined,
        unreadOnly: args.filter !== "all",
        order: (args.order as "oldest" | "newest" | undefined) ?? "newest",
        cursor,
        peek: args.peek === true,
        allowedChannelIds: principal.credentialKind === "session" ? principal.channelIds : null,
        now: Date.now(),
      });
      const brief = await workspace.readAgentBrief({ actor, agentId: page.agent.id });
      return {
        agent: { id: page.agent.id, handle: `@${page.agent.handle}`, name: page.agent.displayName },
        brief: brief.tiers,
        items: page.items.map(queueItem),
        unread: page.depth,
        next_cursor: page.nextCursor ? encodeAgentQueueCursor(page.nextCursor) : null,
      };
    }
    case "agent_next": {
      assertSessionAgent(principal, args.agent as string);
      const claimed = await workspace.claimAgentWork({
        actor,
        ...agentCredential(principal, bearerToken),
        agent: args.agent as string,
        claimId: args.claim_id as string,
        leaseToken: args.lease_token as string,
        sessionId: args.session_id as string,
        peek: args.peek === true,
        now: Date.now(),
      });
      return claimed.lease === null
        ? { item: null, lease: null }
        : { item: queueItem(claimed.item), lease: claimed.lease, replayed: claimed.replayed };
    }
    case "agent_start": {
      assertSessionAgent(principal, args.agent as string);
      const started = await workspace.markAgentExecutionStarted({
        ...leaseProof(actor, principal, bearerToken, args),
        now: Date.now(),
      });
      return { item_id: args.item_id, started_at: started.startedAt };
    }
    case "agent_renew": {
      assertSessionAgent(principal, args.agent as string);
      const renewed = await workspace.renewAgentLease({
        ...leaseProof(actor, principal, bearerToken, args),
        now: Date.now(),
      });
      return { item_id: args.item_id, lease_expires_at: renewed.leaseExpiresAt };
    }
    case "agent_complete": {
      assertSessionAgent(principal, args.agent as string);
      const completed = await workspace.completeAgentWork({
        ...leaseProof(actor, principal, bearerToken, args),
        completionId: args.completion_id as string,
        outputDigest: args.output_digest as string,
        result: (args.result as Record<string, unknown> | undefined) ?? null,
        now: Date.now(),
      });
      return { item_id: args.item_id, completed_at: completed.completedAt, replayed: completed.replayed };
    }
    case "agent_mark_read":
    case "agent_mark_unread": {
      assertSessionAgent(principal, args.agent as string);
      const changed = await workspace.setAgentQueueDisplayState({
        actor,
        agent: args.agent as string,
        itemId: args.item_id as string,
        read: name === "agent_mark_read",
        allowedChannelIds: principal.credentialKind === "session" ? principal.channelIds : null,
        now: Date.now(),
      });
      return { item_id: args.item_id, read: name === "agent_mark_read", changed: changed.changed };
    }
    case "agent_post": {
      assertSessionAgent(principal, args.agent as string);
      await assertSessionChannel(workspace, principal, actor, args.channel_id as string);
      const posted = await workspace.postMcpAgentMessage({
        actor,
        ...agentCredential(principal, bearerToken),
        agent: args.agent as string,
        idempotencyKey: args.idempotency_key as string,
        channelId: args.channel_id as string,
        bodyMarkdown: args.content as string,
        threadParentId: (args.parent_id as string | undefined) ?? null,
        now: Date.now(),
      });
      return postResult(posted);
    }
    case "agent_get_prompt": {
      assertSessionAgent(principal, args.agent as string);
      const listed = await workspace.listAgents({ actor });
      const agent = resolveOwnedAgent(listed.agents, args.agent as string);
      const brief = await workspace.readAgentBrief({ actor, agentId: agent.id });
      return { agent: { id: agent.id, handle: `@${agent.handle}` }, tiers: brief.tiers, preamble_version: brief.preambleVersion };
    }
    case "agent_set_prompt": {
      oauthConnectionId(principal);
      const listed = await workspace.listAgents({ actor });
      const agent = resolveOwnedAgent(listed.agents, args.agent as string);
      const updated = await workspace.setAgentBrief({ actor, agentId: agent.id, prompt: args.prompt as string | null, now: Date.now() });
      return { agent: { id: agent.id, handle: `@${agent.handle}` }, prompt: updated.prompt };
    }
    case "list_credentials": {
      const listed = await workspace.listVaultCredentials({
        actor,
        ...(principal.credentialKind === "session" ? { agentId: principal.agentId, delegationId: principal.delegationId } : {}),
        ...(args.channel_id === undefined ? {} : { originChannelId: args.channel_id as string }),
        now: Date.now(),
      });
      return { credentials: listed.credentials.map(credentialMetadata) };
    }
    case "describe_credential": {
      const listed = await workspace.listVaultCredentials({
        actor,
        ...(principal.credentialKind === "session" ? { agentId: principal.agentId, delegationId: principal.delegationId } : {}),
        ...(args.channel_id === undefined ? {} : { originChannelId: args.channel_id as string }),
        now: Date.now(),
      });
      const credential = listed.credentials.find((item) => item.id === args.credential_id);
      if (!credential) throw new Error("vault credential not found");
      return { credential: credentialMetadata(credential) };
    }
    case "credential_hint": {
      // Which credentials a command needs, and how to write it so the value
      // never reaches the conversation. Metadata in, metadata out: this reads
      // the same listing the connection could already read and adds no
      // authority of its own.
      const listed = await workspace.listVaultCredentials({ actor, now: Date.now() });
      const hints = commandHints(
        args.command as string,
        listed.credentials.map((credential) => ({
          id: credential.id,
          name: credential.name,
          ...(credential.envVar === undefined ? {} : { envVar: credential.envVar }),
          commands: credential.commands,
        })),
      );
      return {
        command: args.command,
        hints: hints.map((hint) => ({
          segment: hint.segment,
          program: hint.program,
          credentials: hint.credentials,
          run: hint.rewrite,
          already_correct: hint.alreadyWrapped,
        })),
        note:
          hints.length === 0
            ? "No credential this member holds is associated with that command. Run it as written."
            : "Run the suggested command. The value goes into that child's environment, not into this conversation.",
      };
    }
    case "proxy_request": {
      if (principal.credentialKind !== "session") throw new Error("this tool requires an unattended agent session");
      const result = await workspace.requestVaultProxy({
        actor,
        credentialId: args.credential_id as string,
        agentId: principal.agentId,
        delegationId: principal.delegationId,
        projectId: args.project_id as string,
        origin: { channelId: args.channel_id as string, messageId: args.message_id as string },
        idempotencyKey: args.idempotency_key as string,
        reason: args.reason as string,
        request: {
          url: args.url,
          method: args.method ?? "GET",
          headers: args.headers ?? {},
          body: args.body ?? null,
        },
        now: Date.now(),
      });
      return result;
    }
    default:
      throw new Error("tool is not implemented");
  }
}

function credentialMetadata(credential: Awaited<ReturnType<WorkspaceStub["listVaultCredentials"]>>["credentials"][number]) {
  return {
    id: credential.id,
    name: credential.name,
    description: credential.description,
    env_var: credential.envVar ?? null,
    tags: credential.tags,
    commands: credential.commands,
    proxy_hosts: credential.proxyHosts,
    policy: credential.policy,
    version: credential.version,
    // Layer 2, in the answer rather than in a manual: the shape of the command
    // that uses this credential correctly. An agent that has just listed the
    // vault is exactly the agent about to write the next command.
    use: `lepidy run --with ${credential.name} -- <command>`,
    canary: credential.canary,
    last_accessed_at: credential.lastAccessedAt ?? null,
    access_count: credential.accessCount,
  };
}

function resolveOwnedAgent<T extends { id: string; handle: string; isOwner: boolean }>(agents: readonly T[], argument: string): T {
  const normalized = argument.startsWith("@") ? argument.slice(1) : argument;
  const agent = agents.find((candidate) => candidate.isOwner && (candidate.id === normalized || candidate.handle === normalized));
  if (!agent) throw new Error("agent not found");
  return agent;
}

function messagePage(page: Awaited<ReturnType<WorkspaceStub["readChannelHistory"]>>): unknown {
  return {
    messages: page.messages.map((message) => ({
      id: message.id,
      channel_id: message.channelId,
      parent_id: message.threadRootId,
      author: { kind: message.authorKind, id: message.authorId, name: message.authorDisplaySnapshot },
      content: message.bodyMarkdown,
      created_at: message.createdAt,
      edited_at: message.editedAt,
      reply_count: message.replyCount,
      mcp_attribution: message.mcpAttribution
        ? {
            connection_id: message.mcpAttribution.connectionId,
            session_id: message.mcpAttribution.sessionId,
            delegation_id: message.mcpAttribution.delegationId,
            operating_member_id: message.mcpAttribution.operatingMemberId,
            agent_id: message.mcpAttribution.agentId,
            client: message.mcpAttribution.clientName ?? message.mcpAttribution.clientId,
            device_id: message.mcpAttribution.deviceId,
          }
        : null,
    })),
    next_cursor: page.nextCursor,
  };
}

function queueItem(item: { id: string; messageId: string; channelId: string; enqueuedAt: number; readAt: number | null; flags: readonly string[]; bodyMarkdown: string; authorDisplaySnapshot: string }) {
  return {
    item_id: item.id,
    message_id: item.messageId,
    channel_id: item.channelId,
    author: item.authorDisplaySnapshot,
    content: item.bodyMarkdown,
    content_flags: item.flags,
    created_at: item.enqueuedAt,
    read_at: item.readAt,
  };
}

function postResult(posted: { messageId: string; channelId: string; threadRootId: string | null; replayed: boolean }) {
  return { message_id: posted.messageId, channel_id: posted.channelId, parent_id: posted.threadRootId, replayed: posted.replayed };
}

function leaseProof(actor: Actor, principal: McpPrincipal, bearerToken: string, args: Record<string, unknown>) {
  return {
    actor,
    ...agentCredential(principal, bearerToken),
    agent: args.agent as string,
    itemId: args.item_id as string,
    sessionId: args.session_id as string,
    leaseGeneration: args.lease_generation as number,
    leaseToken: args.lease_token as string,
  };
}

function actorFrom(principal: McpPrincipal): Actor {
  return { memberId: principal.memberId, authorizationEpoch: principal.authorizationEpoch };
}

function attribution(principal: McpPrincipal): McpAttribution {
  return {
    connectionId: principal.credentialKind === "oauth" ? principal.connectionId : null,
    sessionId: principal.credentialKind === "session" ? principal.sessionId : null,
    delegationId: principal.credentialKind === "session" ? principal.delegationId : null,
    memberId: principal.memberId,
    memberHandle: principal.handle,
    clientId: principal.clientId,
    clientName: principal.clientName,
    deviceId: principal.credentialKind === "session" ? principal.deviceId : null,
  };
}

function oauthConnectionId(principal: McpPrincipal): string {
  if (principal.credentialKind !== "oauth") throw new Error("this tool is not available to an unattended session");
  return principal.connectionId;
}

function agentCredential(principal: McpPrincipal, bearerToken: string) {
  return principal.credentialKind === "oauth"
    ? { connectionId: principal.connectionId }
    : { connectionId: null, sessionToken: bearerToken };
}

type AgentView = {
  id: string;
  handle: string;
  isOwner: boolean;
  scopeMode: "any" | "listed";
  scopeChannelIds: readonly string[];
};

function delegatedAgent(listed: { agents: readonly AgentView[] }, principal: Extract<McpPrincipal, { credentialKind: "session" }>): AgentView {
  const agent = listed.agents.find((candidate) => candidate.isOwner && candidate.id === principal.agentId);
  if (!agent) throw new Error("session agent is no longer owned by this member");
  return agent;
}

function sessionChannelAllowed(
  principal: Extract<McpPrincipal, { credentialKind: "session" }>,
  agent: AgentView,
  channelId: string,
): boolean {
  return (
    (principal.channelIds === null || principal.channelIds.includes(channelId)) &&
    (agent.scopeMode === "any" || agent.scopeChannelIds.includes(channelId))
  );
}

async function assertSessionChannel(
  workspace: WorkspaceStub,
  principal: McpPrincipal,
  actor: Actor,
  channelId: string,
): Promise<void> {
  if (principal.credentialKind !== "session") return;
  const agent = delegatedAgent(await workspace.listAgents({ actor }), principal);
  if (!sessionChannelAllowed(principal, agent, channelId)) throw new Error("delegation does not include this room");
}

function assertSessionAgent(principal: McpPrincipal, argument: string): void {
  if (principal.credentialKind !== "session") return;
  const normalized = argument.startsWith("@") ? argument.slice(1) : argument;
  if (normalized !== principal.agentId && normalized !== principal.agentHandle) {
    throw new Error("session token does not match this agent");
  }
}

function toolResult(data: unknown, source: McpAttribution, isError = false) {
  const structuredContent = { ...asObject(data), attribution: source };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

function toolError(error: unknown): string {
  return error instanceof Error ? error.message : "tool failed";
}

async function handle(
  request: Request,
  context: { params: Promise<{ slug: string }> },
  toolName: Parameters<WorkspaceStub["authenticateMcpToken"]>[0]["toolName"],
  requiredScope: SupportedScope | undefined,
  next: (principal: McpPrincipal, workspace: WorkspaceStub, bearerToken: string) => Response | Promise<Response>,
): Promise<Response> {
  const { slug } = await context.params;
  const origin = requestOrigin(request);
  const metadataUrl = protectedResourceMetadataUrl(origin, slug);
  const env = await oauthEnvironment();
  if (env === null) return Response.json({ error: "unavailable" }, { status: 503 });
  const workspace = await resolveWorkspaceBySlug(env, slug);
  if (workspace === null) return new Response(null, { status: 404 });
  const presented = bearerFromHeader(request.headers.get("authorization"));
  if (presented === null) return unauthorized(metadataUrl);
  const verified = await workspace.stub.authenticateMcpToken({
    token: presented,
    audience: workspaceResourceUri(origin, slug),
    now: Date.now(),
    toolName,
    requiredScope,
  });
  if (!verified.ok) return unauthorized(metadataUrl, verified.error, verified.description);
  return next(verified.principal, workspace.stub, presented);
}

function unauthorized(metadataUrl: string, error?: "invalid_token" | "insufficient_scope", description?: string): Response {
  return new Response(null, {
    status: error === "insufficient_scope" ? 403 : 401,
    headers: {
      "WWW-Authenticate": bearerChallenge({ resourceMetadataUrl: metadataUrl, error, description }),
      "Cache-Control": "no-store",
    },
  });
}

function jsonRpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result }, { headers: { "Cache-Control": "no-store" } });
}

function jsonRpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { headers: { "Cache-Control": "no-store" } });
}
