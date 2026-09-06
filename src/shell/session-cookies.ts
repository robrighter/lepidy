import { cookies } from "next/headers";

import { SESSION_COOKIE } from "./resolve-shell-source";

/**
 * The two cookies a signed-in browser carries.
 *
 * The session token is HttpOnly, so no script in the page can read it. The CSRF
 * token deliberately is not: a mutation echoes it back, and the workspace
 * services compare it against the hash stored beside the session, so a request
 * forged from another origin cannot supply one.
 */
export const CSRF_COOKIE = "lepidy_csrf";

export function isSecureDeployment(): boolean {
  return (process.env.ENVIRONMENT ?? process.env.NODE_ENV) !== "development";
}

export async function setSessionCookies(session: {
  token: string;
  csrfToken: string;
  expiresAt: number;
}): Promise<void> {
  const jar = await cookies();
  const secure = isSecureDeployment();
  const expires = new Date(session.expiresAt);
  jar.set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    expires,
  });
  jar.set(CSRF_COOKIE, session.csrfToken, {
    httpOnly: false,
    sameSite: "lax",
    secure,
    path: "/",
    expires,
  });
}

export async function clearSessionCookies(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  jar.delete(CSRF_COOKIE);
}

export async function readSessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

export async function readCsrfToken(): Promise<string | null> {
  return (await cookies()).get(CSRF_COOKIE)?.value ?? null;
}
