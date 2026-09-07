import type { Actor, McpAttribution, OauthPrincipal, Workspace } from "@/src/cloudflare/workspace";
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
import { oauthEnvironment, requestOrigin, resolveWorkspaceBySlug } from "@/src/shell/oauth-server";

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  return handle(request, context, undefined, () =>
    Response.json({ error: "this endpoint answers JSON-RPC over POST" }, { status: 405 }),
  );
}

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return handle(request, context, undefined, () => jsonRpcError(null, -32700, "the body is not JSON"));
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return handle(request, context, undefined, () =>
      jsonRpcError(null, -32600, "a JSON-RPC request object is required"),
    );
  }
  const message = body as { id?: unknown; method?: unknown; params?: unknown };
  const id = message.id ?? null;
  const parsedCall = message.method === "tools/call" ? parseMcpToolCall(message.params) : null;
  const requiredScope = parsedCall?.ok ? parsedCall.requiredScope : undefined;

  return handle(request, context, requiredScope, async (principal, workspace) => {
    switch (message.method) {
      case "initialize":
        return jsonRpcResult(id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "lepidy", version: "0.1.0" },
          instructions:
            `Connected to Lepidy as @${principal.handle}. Agent tools act only for agents you own; ` +
            "room reads and writes always use your current membership.",
        });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return jsonRpcResult(id, {
          tools: MCP_TOOL_DEFINITIONS.map(({ requiredScope: _requiredScope, ...tool }) => tool),
        });
      case "tools/call":
        if (parsedCall === null || !parsedCall.ok) {
          return jsonRpcError(id, -32602, parsedCall?.message ?? "invalid tool call");
        }
        try {
          const data = await dispatchTool(workspace, principal, parsedCall.call.name, parsedCall.call.arguments);
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
  principal: OauthPrincipal,
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
        connection_id: principal.connectionId,
        client: principal.clientName ?? principal.clientId,
      };
    case "list_channels": {
      const listed = await workspace.browseChannels({ actor });
      const visible = listed.channels.filter((channel) => channel.isMember);
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
      return messagePage(page);
    }
    case "post_message": {
      const posted = await workspace.postMcpMessage({
        actor,
        connectionId: principal.connectionId,
        idempotencyKey: args.idempotency_key as string,
        channelId: args.channel_id as string,
        bodyMarkdown: args.content as string,
        threadParentId: (args.parent_id as string | undefined) ?? null,
        now: Date.now(),
      });
      return postResult(posted);
    }
    case "list_agents": {
      const listed = await workspace.listAgents({ actor });
      return {
        agents: listed.agents.filter((agent) => agent.isOwner).map((agent) => ({
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
      const claimed = await workspace.claimAgentWork({
        actor,
        connectionId: principal.connectionId,
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
      const started = await workspace.markAgentExecutionStarted({
        ...leaseProof(actor, principal.connectionId, args),
        now: Date.now(),
      });
      return { item_id: args.item_id, started_at: started.startedAt };
    }
    case "agent_renew": {
      const renewed = await workspace.renewAgentLease({
        ...leaseProof(actor, principal.connectionId, args),
        now: Date.now(),
      });
      return { item_id: args.item_id, lease_expires_at: renewed.leaseExpiresAt };
    }
    case "agent_complete": {
      const completed = await workspace.completeAgentWork({
        ...leaseProof(actor, principal.connectionId, args),
        completionId: args.completion_id as string,
        outputDigest: args.output_digest as string,
        result: (args.result as Record<string, unknown> | undefined) ?? null,
        now: Date.now(),
      });
      return { item_id: args.item_id, completed_at: completed.completedAt, replayed: completed.replayed };
    }
    case "agent_mark_read":
    case "agent_mark_unread": {
      const changed = await workspace.setAgentQueueDisplayState({
        actor,
        agent: args.agent as string,
        itemId: args.item_id as string,
        read: name === "agent_mark_read",
        now: Date.now(),
      });
      return { item_id: args.item_id, read: name === "agent_mark_read", changed: changed.changed };
    }
    case "agent_post": {
      const posted = await workspace.postMcpAgentMessage({
        actor,
        connectionId: principal.connectionId,
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
      const listed = await workspace.listAgents({ actor });
      const agent = resolveOwnedAgent(listed.agents, args.agent as string);
      const brief = await workspace.readAgentBrief({ actor, agentId: agent.id });
      return { agent: { id: agent.id, handle: `@${agent.handle}` }, tiers: brief.tiers, preamble_version: brief.preambleVersion };
    }
    case "agent_set_prompt": {
      const listed = await workspace.listAgents({ actor });
      const agent = resolveOwnedAgent(listed.agents, args.agent as string);
      const updated = await workspace.setAgentBrief({ actor, agentId: agent.id, prompt: args.prompt as string | null, now: Date.now() });
      return { agent: { id: agent.id, handle: `@${agent.handle}` }, prompt: updated.prompt };
    }
    default:
      throw new Error("tool is not implemented");
  }
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
            operating_member_id: message.mcpAttribution.operatingMemberId,
            agent_id: message.mcpAttribution.agentId,
            client: message.mcpAttribution.clientName ?? message.mcpAttribution.clientId,
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

function leaseProof(actor: Actor, connectionId: string, args: Record<string, unknown>) {
  return {
    actor,
    connectionId,
    agent: args.agent as string,
    itemId: args.item_id as string,
    sessionId: args.session_id as string,
    leaseGeneration: args.lease_generation as number,
    leaseToken: args.lease_token as string,
  };
}

function actorFrom(principal: OauthPrincipal): Actor {
  return { memberId: principal.memberId, authorizationEpoch: principal.authorizationEpoch };
}

function attribution(principal: OauthPrincipal): McpAttribution {
  return {
    connectionId: principal.connectionId,
    memberId: principal.memberId,
    memberHandle: principal.handle,
    clientId: principal.clientId,
    clientName: principal.clientName,
  };
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
  requiredScope: SupportedScope | undefined,
  next: (principal: OauthPrincipal, workspace: WorkspaceStub) => Response | Promise<Response>,
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
  const verified = await workspace.stub.authenticateOauthToken({
    accessToken: presented,
    audience: workspaceResourceUri(origin, slug),
    now: Date.now(),
    requiredScope,
  });
  if (!verified.ok) return unauthorized(metadataUrl, verified.error, verified.description);
  return next(verified.principal, workspace.stub);
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
