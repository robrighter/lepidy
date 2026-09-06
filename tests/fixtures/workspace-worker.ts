export { Workspace } from "../../src/cloudflare/workspace";
export { MigrationFixture } from "./migration-fixture";

export default {
  fetch() {
    return new Response("Lepidy workspace fixture");
  },
} satisfies ExportedHandler<CloudflareEnv>;
