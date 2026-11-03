import type { NextRequest } from "next/server";

import {
  adminError,
  adminJson,
  boundedInteger,
  requireAdmin,
  withTimeout,
} from "@/lib/admin/http";
import {
  parseCreditLedgerFilter,
  type AdminCreditLedgerPage,
  type AdminCreditSummary,
} from "@/lib/admin/console";

export const dynamic = "force-dynamic";

/**
 * ═══ CREDITS LEDGER — READ ══════════════════════════════════════════════════
 *
 * Reads `public.credit_ledger` through `admin_credit_ledger`, which refuses
 * unless the CALLER is an administrator. The route holds no service-role client
 * and adds no arithmetic of its own: the summary cards are the database's own
 * ledger aggregates, so the page cannot drift from the ledger.
 *
 * ⚠️ A HOLD IS NOT A CHARGE. `generation_reserved` writes amount 0 and a
 * reserved delta; the UI labels it "Hold". Nothing here sums holds into spend.
 */

interface RpcLedgerPage {
  rows: AdminCreditLedgerPage["rows"];
  total: number;
  limit: number;
  offset: number;
  operation: string;
  search: string | null;
  summary: AdminCreditSummary;
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  const params = request.nextUrl.searchParams;
  const operation = parseCreditLedgerFilter(params.get("operation"));
  const search = (params.get("q") ?? "").trim().slice(0, 120);
  const limit = boundedInteger(params.get("limit"), 25, 1, 100);
  const offset = boundedInteger(params.get("offset"), 0, 0, 100_000);

  try {
    const { data, error } = await withTimeout(
      auth.supabase.rpc("admin_credit_ledger", {
        p_search: search ? search : null,
        p_operation: operation,
        p_limit: limit,
        p_offset: offset,
      }),
      8_000
    );

    if (error) {
      /**
       * A missing function is a deployment problem, not an empty ledger. Saying
       * so is the difference between "no transactions" and "the migration has
       * not been applied".
       */
      const missing = error.code === "PGRST202" || error.code === "42883";
      return adminError(
        503,
        missing ? "CREDITS_SCHEMA_MISSING" : "CREDITS_UNAVAILABLE",
        missing
           ? "The credit ledger functions are not installed. Apply supabase/migrations/50_admin_console_backend.sql and 59_inr_billing_and_ai_costs.sql."
          : "The credit ledger could not be read."
      );
    }

    const page = (data as RpcLedgerPage | null) ?? null;
    if (!page) {
      return adminError(503, "CREDITS_UNAVAILABLE", "The credit ledger returned no data.");
    }

    const payload: AdminCreditLedgerPage = {
      rows: Array.isArray(page.rows) ? page.rows : [],
      total: Number(page.total) || 0,
      limit,
      offset,
      operation,
      search: search || null,
      summary: page.summary,
    };

    return adminJson({ ok: true, data: payload });
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_TIMEOUT") {
      return adminError(504, "CREDITS_TIMEOUT", "The credit ledger query timed out.");
    }
    return adminError(503, "CREDITS_UNAVAILABLE", "The credit ledger could not be read.");
  }
}
