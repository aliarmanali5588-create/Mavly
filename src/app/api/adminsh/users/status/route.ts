import type { NextRequest } from "next/server";

import {
  accountAdminFailureResponse,
  classifyAuthAdminError,
  describeServiceRoleConfig,
} from "@/lib/admin/account-diagnostics";
import { adminError, adminJson, requireAdmin } from "@/lib/admin/http";
import { SUPABASE_URL } from "@/lib/supabase/config";
import { createSupabaseAccountAdminClient } from "@/lib/supabase/worker";

export const dynamic = "force-dynamic";

/**
 * ═══ ADMIN ACCOUNT STATUS — BLOCK / UNBLOCK ═════════════════════════════════
 *
 * This is a real security control, not a UI toggle. It changes the account's
 * enforced state in Supabase Auth (`banned_until`), which is the same field the
 * Auth server itself refuses to sign in against — so there is no second status
 * system to drift.
 *
 * ═══ THE ORDER OF OPERATIONS MATTERS ═══
 *
 *   1. `requireAdmin()` proves the CALLER is an admin, server-side, from the
 *      database. A client-supplied role is never consulted.
 *   2. The target is validated and the self-block guard runs.
 *   3. The current state is read, so the action can be made idempotent and the
 *      previous state can be recorded.
 *   4. The Auth admin call changes the enforced state.
 *   5. The audit row is written. If it cannot be written, the request reports
 *      that the change was applied but not recorded — it never claims a clean
 *      success it cannot evidence.
 *
 * ⚠️ NO PROJECT, FILE, CREDIT OR BILLING DATA IS TOUCHED. Blocking restricts
 * access; it destroys nothing. Unblocking restores access to exactly what was
 * there.
 */

/** A ban far enough out to be effectively indefinite, but still a real timestamp. */
const INDEFINITE_BAN = "876000h"; // 100 years

type AccountAction = "block" | "unblock";

interface StatusBody {
  userId?: unknown;
  action?: unknown;
  reason?: unknown;
}

function badRequest(message: string) {
  return adminError(400, "INVALID_REQUEST", message);
}

export async function POST(request: NextRequest) {
  // 1. Authority: the caller's own verified admin status, from the database.
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  let body: StatusBody;
  try {
    body = (await request.json()) as StatusBody;
  } catch {
    return badRequest("The request body is not valid JSON.");
  }

  // 2. Validate the target and the action.
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return badRequest("A valid target user id is required.");
  }

  const action = body.action;
  if (action !== "block" && action !== "unblock") {
    return badRequest("The action must be 'block' or 'unblock'.");
  }

  const rawReason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (rawReason.length > 500) {
    return badRequest("The reason must be 500 characters or fewer.");
  }
  const reason = rawReason === "" ? null : rawReason;

  /**
   * ⚠️ AN ADMIN CANNOT BLOCK THEMSELVES. Locking the last administrator out of
   * the console is unrecoverable through the UI, so it is refused here rather
   * than left to policy.
   */
  if (action === "block" && userId === auth.user.id) {
    return adminError(
      409,
      "SELF_BLOCK_REFUSED",
      "You cannot block your own account. Ask another administrator to do it."
    );
  }

  // The service-role client is required for a Supabase Auth admin operation.
  const admin = createSupabaseAccountAdminClient();
  if (!admin) {
    /**
     * ⚠️ THIS IS A CONFIGURATION FAILURE, NOT A MISSING USER. It is reported with
     * the diagnostic that says exactly which part of the configuration is wrong,
     * so the operator does not go hunting for an account that is probably fine.
     */
    const report = describeServiceRoleConfig({
      url: SUPABASE_URL,
      key: process.env.SUPABASE_SERVICE_ROLE_KEY,
    });
    console.error("[adminsh] account admin client unavailable", {
      keyLength: report.keyLength,
      urlProjectRef: report.urlProjectRef,
      keyProjectRef: report.keyProjectRef,
      projectMatch: report.projectMatch,
      keyRoleIsServiceRole: report.keyRoleIsServiceRole,
    });
    const response = accountAdminFailureResponse("not_configured");
    return adminError(response.status, response.code, response.error);
  }

  // 3. Read the current enforced state.
  const { data: target, error: readError } = await admin.auth.admin.getUserById(userId);
  if (readError || !target?.user) {
    /**
     * ⚠️ THE ORIGINAL ERROR IS CLASSIFIED, NOT DISCARDED. Converting every lookup
     * failure into USER_NOT_FOUND told the operator an account was missing when
     * the real fault was a bad key, a wrong project, or a network failure.
     *
     * ⚠️ THE LOG CARRIES THE CLASSIFICATION, NEVER THE KEY OR THE RAW MESSAGE. A
     * Supabase AuthError message can echo the request, so only the derived
     * category and the HTTP status are recorded.
     */
    const failure = readError ? classifyAuthAdminError(readError) : "user_not_found";
    console.error("[adminsh] account status read failed", {
      action,
      failure,
      status:
        readError && typeof (readError as { status?: unknown }).status === "number"
          ? (readError as { status: number }).status
          : null,
      code:
        readError && typeof (readError as { code?: unknown }).code === "string"
          ? (readError as { code: string }).code
          : null,
      /** A user object was returned but empty: treat as absent, not as upstream. */
      emptyUser: !readError && !target?.user,
    });
    const response = accountAdminFailureResponse(failure);
    return adminError(response.status, response.code, response.error);
  }

  const previousBannedUntil = target.user.banned_until ?? null;
  const currentlyRestricted =
    previousBannedUntil !== null && new Date(previousBannedUntil).getTime() > Date.now();

  /**
   * ⚠️ IDEMPOTENT. Blocking an already-blocked account and unblocking an
   * unrestricted one are no-ops, not errors — but they write no audit row,
   * because nothing changed and a duplicate event would misrepresent history.
   */
  if (action === "block" && currentlyRestricted) {
    return adminJson({
      ok: true,
      data: {
        userId,
        action,
        changed: false,
        bannedUntil: previousBannedUntil,
        message: "That account was already blocked.",
      },
    });
  }
  if (action === "unblock" && !currentlyRestricted) {
    return adminJson({
      ok: true,
      data: {
        userId,
        action,
        changed: false,
        bannedUntil: null,
        message: "That account was not blocked.",
      },
    });
  }

  // 4. Apply the enforced state through Supabase Auth.
  const banDuration = action === "block" ? INDEFINITE_BAN : "none";
  const { data: updated, error: updateError } = await admin.auth.admin.updateUserById(userId, {
    ban_duration: banDuration,
  });

  if (updateError || !updated?.user) {
    console.error("[adminsh] account status update failed", {
      action,
      reason: updateError?.message ? "auth_admin_error" : "no_user_returned",
    });
    return adminError(
      502,
      "ACCOUNT_UPDATE_FAILED",
      "Supabase Auth did not accept the account status change. The account was not modified."
    );
  }

  const resultingBannedUntil = updated.user.banned_until ?? null;

  /**
   * ⚠️ VERIFY THE STATE ACTUALLY CHANGED. If Auth returned success but the
   * field still reads as unrestricted, the block did not take effect and
   * reporting success would leave a user believing an account is contained when
   * it is not.
   */
  const nowRestricted =
    resultingBannedUntil !== null && new Date(resultingBannedUntil).getTime() > Date.now();
  if (action === "block" && !nowRestricted) {
    return adminError(
      502,
      "ACCOUNT_UPDATE_NOT_EFFECTIVE",
      "Supabase Auth accepted the request but the account does not read as blocked. Treat this account as NOT contained and investigate."
    );
  }

  // 5. Record the audit event.
  const { error: auditError } = await admin.from("account_restriction_events").insert({
    target_user_id: userId,
    actor_user_id: auth.user.id,
    actor_email: auth.user.email ?? null,
    action: action === "block" ? "blocked" : "unblocked",
    reason,
    previous_banned_until: previousBannedUntil,
    resulting_banned_until: resultingBannedUntil,
  });

  if (auditError) {
    /**
     * The change IS applied — say so plainly and flag the missing record. Never
     * report a clean success whose audit trail does not exist.
     */
    console.error("[adminsh] account status audit write failed", {
      action,
      code: auditError.code ?? "unknown",
    });
    return adminJson(
      {
        ok: true,
        data: {
          userId,
          action,
          changed: true,
          bannedUntil: resultingBannedUntil,
          auditRecorded: false,
          message:
            "The account status was changed, but the audit record could not be written. Apply migration 45 and check the server log.",
        },
      },
      200
    );
  }

  return adminJson({
    ok: true,
    data: {
      userId,
      action,
      changed: true,
      bannedUntil: resultingBannedUntil,
      auditRecorded: true,
      message: action === "block" ? "Account blocked." : "Account unblocked.",
    },
  });
}
