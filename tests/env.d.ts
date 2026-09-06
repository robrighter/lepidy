import type { D1Migration } from "@cloudflare/vitest-plugin";

import type { MigrationFixture } from "./fixtures/migration-fixture";

declare global {
  interface CloudflareEnv {
    MIGRATION_FIXTURE: DurableObjectNamespace<MigrationFixture>;
    TEST_CONTROL_MIGRATIONS: D1Migration[];
  }

  namespace Cloudflare {
    interface Env {
      MIGRATION_FIXTURE: DurableObjectNamespace<MigrationFixture>;
      TEST_CONTROL_MIGRATIONS: D1Migration[];
    }
  }
}

declare module "cloudflare:workers" {
  interface ProvidedEnv extends CloudflareEnv {}
}
