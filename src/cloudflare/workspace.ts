import { DurableObject } from "cloudflare:workers";

import {
  migrateWorkspaceSchema,
  readWorkspaceSchema,
  type WorkspaceSchemaState,
} from "./workspace-migrations";

export type WorkspaceHealth = {
  ok: boolean;
  schemaVersion: number;
  status: WorkspaceSchemaState["status"];
  error: string | null;
};

export class Workspace extends DurableObject<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      migrateWorkspaceSchema(ctx.storage);
    });
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
}
