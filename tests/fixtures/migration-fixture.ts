import { DurableObject } from "cloudflare:workers";

import {
  migrateWorkspaceSchema,
  prepareWorkspaceSchema,
  readWorkspaceSchema,
  WORKSPACE_MIGRATIONS,
  type WorkspaceMigration,
  type WorkspaceSchemaState,
} from "../../src/cloudflare/workspace-migrations";

const brokenMigration: WorkspaceMigration = {
  version: 2,
  name: "deliberately broken fixture",
  statements: [
    "CREATE TABLE should_roll_back (id TEXT PRIMARY KEY) STRICT",
    "INSERT INTO table_that_does_not_exist(id) VALUES ('failure')",
  ],
};

export class MigrationFixture extends DurableObject<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => prepareWorkspaceSchema(ctx.storage));
  }

  migrateCurrent(): WorkspaceSchemaState {
    return migrateWorkspaceSchema(this.ctx.storage);
  }

  migrateThrough(version: number): WorkspaceSchemaState {
    return migrateWorkspaceSchema(
      this.ctx.storage,
      WORKSPACE_MIGRATIONS.filter((migration) => migration.version <= version),
    );
  }

  migrateBrokenAfterVersionOne(): WorkspaceSchemaState {
    migrateWorkspaceSchema(this.ctx.storage, [WORKSPACE_MIGRATIONS[0]]);
    return migrateWorkspaceSchema(this.ctx.storage, [brokenMigration]);
  }

  health(): WorkspaceSchemaState {
    return readWorkspaceSchema(this.ctx.storage);
  }
}
