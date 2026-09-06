"use server";

import { redirect } from "next/navigation";

import {
  accountServices,
  deploymentEnvironment,
  selfServiceSignUpAllowed,
} from "@/src/shell/account-services";
import {
  clearSessionCookies,
  readSessionToken,
  setSessionCookies,
} from "@/src/shell/session-cookies";
import { shellErrorReason } from "@/src/shell/workspace-shell-source";

export type AuthResult = { ok: true } | { ok: false; reason: string };

function formText(form: FormData, field: string, max: number): string {
  const value = form.get(field);
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * Sign in with a password.
 *
 * The failure message never distinguishes an unknown address from a wrong
 * password, because the difference is exactly what an attacker enumerating
 * accounts is looking for.
 */
export async function signInWithPassword(
  _previous: AuthResult | null,
  form: FormData,
): Promise<AuthResult> {
  const services = await accountServices();
  if ("unavailable" in services) return { ok: false, reason: services.unavailable };

  const email = formText(form, "email", 320);
  const password = formText(form, "password", 512);
  if (email.length === 0 || password.length === 0) {
    return { ok: false, reason: "Enter your email address and password." };
  }

  let accountId: string | null;
  try {
    accountId = await services.accounts.authenticatePassword(email, password);
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
  if (accountId === null) return { ok: false, reason: "That email and password do not match." };

  const session = await services.authorization.issueBrowserSession({
    accountId,
    deviceLabel: "Browser",
    platform: "web",
  });
  await setSessionCookies(session);
  redirect("/");
}

/**
 * Create the first account and its workspace.
 *
 * Email-delivered verification is not connected yet, so this completes the
 * verification challenge inline and is refused outside a development
 * deployment rather than quietly treating an unverified address as verified.
 */
export async function signUpWithPassword(
  _previous: AuthResult | null,
  form: FormData,
): Promise<AuthResult> {
  if (!selfServiceSignUpAllowed(deploymentEnvironment())) {
    return {
      ok: false,
      reason: "Self-service sign-up needs email verification, which is not connected yet.",
    };
  }
  const services = await accountServices();
  if ("unavailable" in services) return { ok: false, reason: services.unavailable };

  const email = formText(form, "email", 320);
  const password = formText(form, "password", 512);
  const displayName = formText(form, "displayName", 120);
  const workspaceName = formText(form, "workspaceName", 120) || "My workspace";
  const handle = formText(form, "handle", 32);
  if (email.length === 0 || password.length < 12 || displayName.length === 0 || handle.length === 0) {
    return {
      ok: false,
      reason: "Enter a name, a handle, an email address and a password of at least 12 characters.",
    };
  }

  let accountId: string;
  try {
    ({ accountId } = await services.accounts.signUpWithWorkspace({
      email,
      password,
      displayName,
      handle,
      workspaceName,
      workspaceSlug: slugify(workspaceName),
      jurisdiction: "global",
      storageMode: "cloud",
    }));
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }

  const session = await services.authorization.issueBrowserSession({
    accountId,
    deviceLabel: "Browser",
    platform: "web",
  });
  await setSessionCookies(session);
  redirect("/");
}

/** Revokes the session server-side, not just the cookie in this browser. */
export async function signOut(csrfToken: string): Promise<AuthResult> {
  const token = await readSessionToken();
  const services = await accountServices();
  if (token && !("unavailable" in services)) {
    try {
      await services.authorization.authenticateBrowserSession(token, csrfToken ?? "");
    } catch {
      return { ok: false, reason: "Unable to sign out. Refresh and try again." };
    }
    await services.authorization.revokeBrowserSession(token);
  }
  await clearSessionCookies();
  redirect("/signin");
}

function slugify(value: string): string {
  const base = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base.length >= 3 ? base : `workspace-${Date.now().toString(36)}`;
}
