export { Workspace } from "../../src/cloudflare/workspace";

export default {
  fetch() {
    return new Response("Lepidy workspace fixture");
  },
} satisfies ExportedHandler<CloudflareEnv>;
