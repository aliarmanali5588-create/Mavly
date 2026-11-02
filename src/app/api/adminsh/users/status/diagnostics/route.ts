import type { NextRequest } from "next/server";

import {
  classifyAuthAdminError,
  describeServiceRoleConfig,
  readKeyClaims,
} from "@/lib/admin/account-diagnostics";
import { adminError, adminJson, requireAdmin } from "@/lib/admin/http";
import { SUPABASE_URL } from "@/lib/supabase/config";
import { createSupabaseAccountAdminClient } from "@/lib/supabase/worker";

export const dynamic = "force-dynamic";

/**
 * ═══ ACCOUNT ADMIN CONFIGURATION DIAGNOSTIC ═════════════════════════════════
 *
 * Answers, from the RUNNING production process rather than from a build log:
 *
 *   1. does the service-role key exist in this runtime?
 *   2. does it belong to the same Supabase project the app talks to?
 *   6. is the variable available server-side after deployment?
 *
 * ═══ WHAT IT NEVER RETURNS ═══
 *
 * The key, any prefix or suffix of it, its JWT signature, or any other claim. The
 * only values that leave this handler are booleans, a coarse length bucket, and
 * the project ref — which is already public, because it is in the URL the browser
 * uses to sign in.
 *
 * ⚠️ ADMIN-ONLY. It is behind `requireAdmin()`, so a non-admin gets the same 404
 * as a missing page. It is a diagnostic, not a status page.
 *
 * ⚠️ IT DOES NOT PROVE THE KEY WORKS. It proves the key is PRESENT and claims the
 * right project. Only an actual Auth call proves validity, which is why `probe`
 * exists: it performs one real, read-only `getUserById` against a caller-supplied
 * id and reports the CLASSIFIED outcome.
 */

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const report = describeServiceRoleConfig({ url: SUPABASE_URL, key });

  /**
   * ⚠️ THE PUBLIC URL IS REPORTED TOO. A service-role key from project A paired
   * with project B's URL is the single most common cause of a 401 here, and it is
   * invisible without both refs side by side.
   */
  const claims = key ? readKeyClaims(key) : { ref: null, role: null };

  return adminJson({
    ok: true,
    data: {
      runtime: {
        nodeEnv: process.env.NODE_ENV ?? null,
        /** Vercel sets this per deployment; it proves which build answered. */
        deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
        gitCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
        region: process.env.VERCEL_REGION ?? null,
      },
      supabase: {
        url: SUPABASE_URL || null,
        urlProjectRef: report.urlProjectRef,
      },
      serviceRole: {
        /** Requirement 1 and 6: present in THIS runtime, server-side. */
        present: report.configured,
        keyLength: report.keyLength,
        keyProjectRef: report.keyProjectRef,
        /** Requirement 2: same project as the URL. `null` means undeterminable. */
        projectMatch: report.projectMatch,
        keyRoleIsServiceRole: report.keyRoleIsServiceRole,
      },
      /**
       * ⚠️ A MISMATCH IS CALLED OUT EXPLICITLY. Leaving the operator to compare
       * two refs by eye is how a wrong-project key survives a "looks fine" check.
       */
      verdict:
        report.keyLength === "missing"
          ? "SUPABASE_SERVICE_ROLE_KEY is not present in this runtime."
          : report.keyLength === "too_short"
            ? "SUPABASE_SERVICE_ROLE_KEY is present but too short to be a key."
            : report.projectMatch === false
              ? "The service-role key belongs to a DIFFERENT Supabase project than NEXT_PUBLIC_SUPABASE_URL."
              : report.keyRoleIsServiceRole === false
                ? "The configured key is not a service_role key. Account administration will be refused."
                : report.projectMatch === null
                  ? "The key is present. Its project could not be compared to the URL; run probe to test it."
                  : "The key is present, server-side, and claims the same project as the URL.",
      probe: "POST a JSON body {\"userId\":\"<auth user uuid>\"} to this endpoint to run one real Auth lookup and see the classified result.",
    },
  });
}

/**
 * ═══ PROBE: ONE REAL AUTH CALL, CLASSIFIED ══════════════════════════════════
 *
 * ⚠️ THIS IS THE ONLY THING THAT PROVES THE KEY WORKS. A present, well-shaped key
 * from the right project can still be revoked. This performs exactly one
 * read-only `getUserById` and reports which of the four conditions applies.
 *
 * ⚠️ IT CHANGES NOTHING. No ban, no update, no write of any kind.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  let body: { userId?: unknown };
  try {
    body = (await request.json()) as { userId?: unknown };
  } catch {
    return adminError(400, "INVALID_REQUEST", "The request body is not valid JSON.");
  }

  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return adminError(400, "INVALID_REQUEST", "A valid Auth user id is required.");
  }

  const admin = createSupabaseAccountAdminClient();
  if (!admin) {
    return adminJson({
      ok: true,
      data: {
        outcome: "not_configured",
        message: "The service-role key is missing from this runtime. No Auth call was made.",
      },
    });
  }

  const started = Date.now();
  const { data, error } = await admin.auth.admin.getUserById(userId);
  const elapsedMs = Date.now() - started;

  if (error) {
    const failure = classifyAuthAdminError(error);
    return adminJson({
      ok: true,
      data: {
        outcome: failure,
        elapsedMs,
        status: typeof (error as { status?: unknown }).status === "number"
          ? (error as { status: number }).status
          : null,
        code: typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : null,
        message:
          failure === "user_not_found"
            ? "Auth answered 404: this id genuinely does not exist in this project."
            : failure === "invalid_credentials"
              ? "Auth rejected the key (401/403). The key is invalid, expired, or from another project."
              : failure === "upstream_unavailable"
                ? "Auth could not be reached. Network or upstream failure."
                : "Auth returned an unexpected error.",
      },
    });
  }

  return adminJson({
    ok: true,
    data: {
      outcome: "ok",
      elapsedMs,
      /** Existence and the enforced state only. No email, no metadata. */
      user: {
        id: data?.user?.id ?? null,
        bannedUntil: data?.user?.banned_until ?? null,
      },
      message: "The key is valid and the account exists in this project.",
    },
  });
}
