import { AuthorizationService } from "../control/authorization";
import { DevelopmentShellSource } from "./development-shell-source";
import { ControlPlaneShellSource, type ShellState } from "./workspace-shell-source";

export const SESSION_COOKIE = "lepidy_session";

export type ShellEnvironment = {
  CONTROL_DB?: D1Database;
  WORKSPACE?: CloudflareEnv["WORKSPACE"];
  ACCOUNTS?: CloudflareEnv["ACCOUNTS"];
  ENVIRONMENT?: string;
};

/**
 * Chooses where the shell's data comes from.
 *
 * A session plus real bindings always wins. The development workspace is used
 * only when this deployment is explicitly a development one and no control-plane
 * session is available; it reports `authenticated: false`, and the shell renders
 * a standing banner from that flag so it can never pass for real data.
 */
export async function loadShellState(
  env: ShellEnvironment,
  sessionToken: string | null,
): Promise<ShellState> {
  if (env.CONTROL_DB && env.WORKSPACE && sessionToken) {
    const authorization = new AuthorizationService(env.CONTROL_DB, env.WORKSPACE);
    const source = new ControlPlaneShellSource(
      {
        db: env.CONTROL_DB,
        workspaces: env.WORKSPACE,
        authenticateSession: (token) => authorization.authenticateBrowserSession(token),
      },
      sessionToken,
    );
    return source.load();
  }

  if (env.ENVIRONMENT === "development") return new DevelopmentShellSource().load();

  return { status: "signed_out" };
}
