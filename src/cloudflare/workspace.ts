import { DurableObject } from "cloudflare:workers";

export type WorkspaceHealth = {
  ok: true;
  schemaVersion: number;
};

export class Workspace extends DurableObject<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS _schema (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO _schema (singleton, version, updated_at)
        VALUES (1, 1, datetime('now'));
      `);
    });
  }

  health(): WorkspaceHealth {
    const row = this.ctx.storage.sql
      .exec<{ version: number }>(
        "SELECT version FROM _schema WHERE singleton = 1",
      )
      .one();

    return { ok: true, schemaVersion: row.version };
  }
}
