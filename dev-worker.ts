/**
 * The worker the Cloudflare dev proxy runs so `next dev` has real bindings.
 *
 * It exports the workspace Durable Object and nothing else: Next serves the
 * application, and this exists only so local D1, KV, R2 and the object itself
 * are the real local implementations rather than absent.
 */
export { Accounts } from "./src/cloudflare/accounts";
export { Workspace } from "./src/cloudflare/workspace";

export default {
  fetch(): Response {
    return new Response("Lepidy development bindings", { status: 200 });
  },
} satisfies ExportedHandler<CloudflareEnv>;
