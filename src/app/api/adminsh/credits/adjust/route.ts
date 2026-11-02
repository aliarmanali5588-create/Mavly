import type { NextRequest } from "next/server";

import { adminError, adminJson, requireAdmin } from "@/lib/admin/http";

export const dynamic = "force-dynamic";

/**
 * ═══ CREDITS LEDGER — ADMIN ADJUSTMENT ══════════════════════════════════════
 *
 * The only write path the Credits section offers, and it is deliberately narrow.
 *
 * ⚠️ IT DOES NOT TOUCH A BALANCE. It calls `admin_adjust_credits`, which is the
 * same atomic sequence the credit engine uses: per-user advisory lock, account
 * row lock, balance move, exactly one ledger row, one audit row — all in one
 * transaction. Writing `credit_accounts` from a route would break the ledger's
 * claim to be the authority, so the route never does.
 *
 * ⚠️ THE IDEMPOTENCY KEY IS REQUIRED. A double-submitted form must not grant
 * twice, and the database returns the existing row for a repeated key rather
 * than applying the amount again.
 *
 * ⚠️ A NEGATIVE ADJUSTMENT CANNOT EAT A HELD RESERVATION. The database refuses a
 * debit that would push the balance below `reserved_credits`; that refusal is
 * surfaced verbatim instead of being retried with a smaller number.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AdjustBody {
  userId?: unknown;
  amount?: unknown;
  operation?: unknown;
  reason?: unknown;
  idempotencyKey?: unknown;
}

function badRequest(message: string) {
  return adminError(400, "INVALID_REQUEST", message);
}

/** Map the database's structured refusals onto honest HTTP answers. */
function adjustmentFailure(code: string | undefined, message: string) {
  switch (code) {
    case "P0002":
      return adminError(404, "USER_NOT_FOUND", "That user does not exist.");
    case "22023":
      return adminError(400, "INVALID_ADJUSTMENT", "The adjustment amount or operation is not valid.");
    case "22000":
      return adminError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "That idempotency key was already used for a different amount."
      );
    case "42501":
      return adminError(403, "FORBIDDEN", "You are not allowed to adjust credits.");
    default:
      if (message.includes("INSUFFICIENT_CREDITS_FOR_ADJUSTMENT")) {
        return adminError(
          409,
          "INSUFFICIENT_CREDITS",
          "That debit would take the balance below the credits currently held for a running generation. Release or wait for the hold first."
        );
      }
      if (message.includes("CREDIT_ADJUSTMENT_TOO_LARGE")) {
        return adminError(
          400,
          "ADJUSTMENT_TOO_LARGE",
          "That amount exceeds the configured maximum single adjustment."
        );
      }
      return adminError(503, "ADJUSTMENT_FAILED", "The credit adjustment could not be applied.");
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  let body: AdjustBody;
  try {
    body = (await request.json()) as AdjustBody;
  } catch {
    return badRequest("The request body is not valid JSON.");
  }

  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!UUID_PATTERN.test(userId)) {
    return badRequest("A valid target user id is required.");
  }

  const amount = typeof body.amount === "number" ? body.amount : Number(body.amount);
  if (!Number.isInteger(amount) || amount === 0) {
    return badRequest("The amount must be a non-zero whole number of credits.");
  }

  const operation = body.operation === "admin_adjustment" ? "admin_adjustment" : "grant";
  if (operation === "grant" && amount < 1) {
    return badRequest("A grant must be a positive number of credits.");
  }

  const rawReason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (rawReason.length > 500) {
    return badRequest("The reason must be 500 characters or fewer.");
  }

  /**
   * ⚠️ A REASON IS REQUIRED FOR A DEBIT. Removing credits from an account
   * without a recorded justification is exactly the kind of change an auditor
   * will ask about, so the operator has to write it down at the time.
   */
  if (amount < 0 && rawReason === "") {
    return badRequest("A reason is required when removing credits.");
  }

  const idempotencyKey =
    typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim().slice(0, 200) : "";
  if (idempotencyKey === "") {
    return badRequest("An idempotency key is required.");
  }

  const { data, error } = await auth.supabase.rpc("admin_adjust_credits", {
    p_user_id: userId,
    p_amount_credits: amount,
    p_operation: operation,
    p_reason: rawReason === "" ? null : rawReason,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    console.error("[adminsh] credit adjustment failed", {
      code: error.code ?? "unknown",
      operation,
    });
    return adjustmentFailure(error.code, error.message ?? "");
  }

  const result = (data ?? {}) as {
    status?: string;
    ledgerId?: string;
    balance?: number;
    reserved?: number;
  };

  return adminJson({
    ok: true,
    data: {
      status: result.status === "existing" ? "existing" : "applied",
      ledgerId: result.ledgerId ?? null,
      balance: typeof result.balance === "number" ? result.balance : null,
      reserved: typeof result.reserved === "number" ? result.reserved : null,
      message:
        result.status === "existing"
          ? "That adjustment was already applied; no credits were moved twice."
          : amount > 0
            ? `${amount.toLocaleString()} credits granted.`
            : `${Math.abs(amount).toLocaleString()} credits removed.`,
    },
  });
}
