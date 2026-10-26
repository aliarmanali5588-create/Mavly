/**
 * Public mapping for a failed Vercel operation.
 *
 * This module is pure so the mapping can be regression-tested without a
 * Supabase client. It deliberately never forwards an upstream 401/403 message:
 * upstream diagnostics belong in server logs, not in a user-facing response.
 */

import type { VercelFailure } from "@/lib/vercel/provider";

export interface PublicDeploymentFailure {
  status: number;
  code: string;
  error: string;
  retryAfterSeconds?: number;
}

export function publicDeploymentFailure(
  failure: VercelFailure,
  action: "publish" | "unpublish" = "publish",
): PublicDeploymentFailure {
  const verb = action === "unpublish" ? "unpublish" : "publish";
  if (failure.status === 429) {
    return {
      status: 429,
      code: "RATE_LIMITED",
      error: `The hosting provider is temporarily rate limiting ${verb} requests. Try again shortly.`,
      ...(failure.retryAfterSeconds
        ? { retryAfterSeconds: failure.retryAfterSeconds }
        : {}),
    };
  }
  if (failure.status === 401) {
    return {
      status: 503,
      code: "BACKEND_NOT_CONFIGURED",
      error:
        "Vercel rejected the publishing token. Replace VERCEL_API_TOKEN with a valid Vercel access token, then redeploy.",
    };
  }
  if (failure.status === 403) {
    return {
      status: 503,
      code: "BACKEND_NOT_CONFIGURED",
      error:
        "Vercel denied access to the publishing account or team. Confirm VERCEL_API_TOKEN can create projects there and that VERCEL_TEAM_ID is the correct team id.",
    };
  }
  if (failure.status === 0) {
    return {
      status: 504,
      code: "UNKNOWN",
      error: "Vercel did not respond in time.",
    };
  }
  if (failure.status === 400 || failure.status === 409 || failure.status === 422) {
    return {
      status: 400,
      code: "VALIDATION",
      error: failure.message || `Vercel rejected the ${verb}.`,
    };
  }
  return {
    status: 502,
    code: "UNKNOWN",
    error: `Vercel could not complete the ${verb}.`,
  };
}
