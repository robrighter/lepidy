import type { D1Migration } from "@cloudflare/vitest-plugin";

import type { Accounts } from "../src/cloudflare/accounts";
import type { MigrationFixture } from "./fixtures/migration-fixture";

declare global {
  interface CloudflareEnv {
    MIGRATION_FIXTURE: DurableObjectNamespace<MigrationFixture>;
    ACCOUNTS: DurableObjectNamespace<Accounts>;
    TEST_CONTROL_MIGRATIONS: D1Migration[];
    TRANSPORT_SECRET_KEY?: string;
  }

  namespace Cloudflare {
    interface Env {
      MIGRATION_FIXTURE: DurableObjectNamespace<MigrationFixture>;
      ACCOUNTS: DurableObjectNamespace<Accounts>;
      TEST_CONTROL_MIGRATIONS: D1Migration[];
      TRANSPORT_SECRET_KEY?: string;
    }
  }
}

declare module "cloudflare:workers" {
  interface ProvidedEnv extends CloudflareEnv {}
}
