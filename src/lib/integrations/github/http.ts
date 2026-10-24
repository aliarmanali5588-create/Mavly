/**
 * Route-handler helpers for the GitHub integration. Server-only.
 *
 * ⚠️ EVERY FAILURE IS TRANSLATED HERE, ONCE. A route never passes a GitHub
 * message, a status code or a token through to the browser: the user gets a
 * sentence they can act on, and the machine gets a stable code.
 */

import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/supabase/server";
import { githubIntegrationConfig, type GithubIntegrationConfig } from "./config";
import type { GithubUpstreamError } from "./oauth";
import type { GithubServiceError } from "./service";

const NO_STORE = { "cache-control": "private, no-store, max-age=0" } as const;

export function apiData<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, data }, { status, headers: NO_STORE });
}

export function apiError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json(
    { ok: false, error: message, code },
    { status, headers: NO_STORE },
  );
}

export type AuthOk = { ok: true; userId: string };
export type AuthFailure = { ok: false; response: NextResponse };
export type AuthResult = AuthOk | AuthFailure;

export function isAuthFailure(result: AuthResult): result is AuthFailure {
  return result.ok === false;
}

/** The verified Mavly user. Never a client-supplied id. */
export async function requireGithubUser(): Promise<AuthResult> {
  const user = await getCurrentUser();
  if (!user) {
    return {
      ok: false,
      response: apiError(
        "UNAUTHENTICATED",
        "You must be signed in to do that.",
        401,
      ),
    };
  }
  return { ok: true, userId: user.id };
}

export type ConfigOk = { ok: true; config: GithubIntegrationConfig };
export type ConfigFailure = { ok: false; response: NextResponse };
export type ConfigResult = ConfigOk | ConfigFailure;

export function isConfigFailure(result: ConfigResult): result is ConfigFailure {
  return result.ok === false;
}

/**
 * The GitHub configuration.
 *
 * ⚠️ A DEPLOYMENT WITHOUT IT ANSWERS A TRUTHFUL 503. It never pretends the
 * integration works, and it never breaks the rest of Mavly.
 */
export function requireGithubConfig(): ConfigResult {
  const result = githubIntegrationConfig();
  if (!result.ok) {
    return {
      ok: false,
      response: apiError(
        "GITHUB_INTEGRATION_NOT_CONFIGURED",
        "The GitHub integration is not configured on this deployment.",
        503,
      ),
    };
  }
  return { ok: true, config: result.config };
}

const FAILURE_MESSAGES: Record<GithubServiceError, string> = {
  github_unavailable: "GitHub could not be reached. Try again in a moment.",
  github_unauthorized:
    "Your GitHub authorization is no longer valid. Connect GitHub again.",
  github_forbidden: "GitHub refused this request.",
  github_not_found: "That repository or branch could not be found.",
  github_rate_limited: "GitHub is rate-limiting this account. Try again shortly.",
  github_conflict:
    "That branch moved on GitHub. Nothing was overwritten — review and try again.",
  github_invalid_response: "GitHub returned an unexpected response.",
  github_failed: "GitHub rejected the request.",
  github_no_write_permission:
    "Your GitHub authorization is missing the repository permission this action needs.",
  github_app_not_installed:
    "Install the Mavly GitHub App on your personal GitHub account, approve its repository access, then reconnect GitHub.",
  github_repository_creation_denied:
    "The GitHub App is installed but cannot create repositories. Grant its Repository creation (or Administration) read and write permission, approve the update on GitHub, then reconnect.",
  github_empty_repository: "That repository has no commits yet.",
  github_repository_exists:
    "A repository with that name already exists in your account.",
  github_sso_required:
    "Your organization requires SAML SSO. Start an active SSO session on GitHub, then reconnect GitHub.",
  github_policy_blocked:
    "GitHub or your organization's policy blocks repository creation for this account.",
  github_abuse_blocked:
    "GitHub blocked this request as suspected abuse. Check the account status on GitHub.",
  github_email_unverified:
    "Verify your GitHub email address, then try again.",
  github_tree_truncated:
    "GitHub returned an incomplete repository tree. Try again, or use a smaller repository.",
  github_import_too_large:
    "This repository has more files than Mavly can import in one pass. Import a smaller repository.",
  github_too_many_files:
    "This project has more files than Mavly can move in one pass.",
  github_not_connected: "Connect GitHub first.",
  github_not_configured:
    "The GitHub integration is not configured on this deployment.",
  store_unavailable: "The GitHub connection could not be read or saved.",
  project_not_connected: "This project has no repository connected.",
};

const FAILURE_STATUS: Record<GithubServiceError, number> = {
  github_unavailable: 502,
  github_unauthorized: 401,
  github_forbidden: 403,
  github_not_found: 404,
  github_rate_limited: 429,
  github_conflict: 409,
  github_invalid_response: 502,
  github_failed: 502,
  github_no_write_permission: 403,
  github_app_not_installed: 403,
  github_repository_creation_denied: 403,
  github_empty_repository: 409,
  github_repository_exists: 409,
  github_sso_required: 403,
  github_policy_blocked: 403,
  github_abuse_blocked: 403,
  github_email_unverified: 403,
  github_tree_truncated: 502,
  github_import_too_large: 413,
  github_too_many_files: 413,
  github_not_connected: 409,
  github_not_configured: 503,
  store_unavailable: 500,
  project_not_connected: 409,
};

export function githubFailure(
  code: GithubServiceError,
  extra?: { conflict?: unknown; upstream?: GithubUpstreamError },
): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: FAILURE_MESSAGES[code] ?? "The GitHub request failed.",
      code: code.toUpperCase(),
      data: null,
      ...(extra?.conflict ? { conflict: extra.conflict } : {}),
      ...(extra?.upstream
        ? {
            details: {
              status: extra.upstream.status,
              message: extra.upstream.message,
              acceptedPermissions: extra.upstream.acceptedPermissions,
              operation: extra.upstream.operation,
            },
          }
        : {}),
    },
    { status: FAILURE_STATUS[code] ?? 502, headers: NO_STORE },
  );
}
