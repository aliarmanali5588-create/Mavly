import type { NextRequest } from "next/server";

import {
  adminError,
  adminJson,
  boundedInteger,
  requireAdmin,
  withTimeout,
} from "@/lib/admin/http";
import { toCsv, type AdminAuditPage } from "@/lib/admin/console";

export const dynamic = "force-dynamic";

/**
 * ═══ AUDIT LOGS — READ ══════════════════════════════════════════════════════
 *
 * One unified trail over three real sources, assembled in the database by
 * `admin_audit_log_page`:
 *
 *   console            admin_audit_log — every mutation made through this panel
 *   account_restriction account_restriction_events — the existing block trail
 *   credit_ledger      grant / admin_adjustment entries
 *
 * ⚠️ NOTHING IS BACKFILLED. The account-restriction and credit sources predate
 * this table; their rows are real and their actor is whatever they actually
 * recorded (often nothing), which is shown as unknown rather than guessed.
 *
 * ⚠️ EXPORT IS THE SAME DATA, NOT A SECOND QUERY. `?format=csv` re-issues the
 * same authorized RPC with a bounded page and escapes every cell against CSV
 * formula injection. It exports what the operator can already see, and the
 * metadata is redacted by key before it leaves the server.
 */

const REDACTED_KEYS = [
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "private_key",
  "rpc_secret",
];

function redact(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object") return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    output[key] = REDACTED_KEYS.some((needle) => key.toLowerCase().includes(needle))
      ? "[redacted]"
      : value;
  }
  return output;
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  const params = request.nextUrl.searchParams;
  const search = (params.get("q") ?? "").trim().slice(0, 120);
  const rawOutcome = (params.get("outcome") ?? "all").trim().toLowerCase();
  const rawSource = (params.get("source") ?? "all").trim().toLowerCase();

  const outcome = ["all", "success", "failure"].includes(rawOutcome) ? rawOutcome : "all";
  const source = ["all", "console", "account_restriction", "credit_ledger"].includes(rawSource)
    ? rawSource
    : "all";

  const wantsCsv = (params.get("format") ?? "").toLowerCase() === "csv";
  /**
   * A CSV export is capped hard. An unbounded export of an audit trail is a data
   * exfiltration path dressed as a convenience, so it reads at most 1000 rows
   * and says so in the response headers.
   */
  const limit = wantsCsv ? 1000 : boundedInteger(params.get("limit"), 50, 1, 100);
  const offset = wantsCsv ? 0 : boundedInteger(params.get("offset"), 0, 0, 100_000);

  try {
    const { data, error } = await withTimeout(
      auth.supabase.rpc("admin_audit_log_page", {
        p_search: search ? search : null,
        p_outcome: outcome,
        p_source: source,
        p_limit: limit,
        p_offset: offset,
      }),
      10_000
    );

    if (error) {
      const missing = error.code === "PGRST202" || error.code === "42883";
      return adminError(
        503,
        missing ? "AUDIT_SCHEMA_MISSING" : "AUDIT_UNAVAILABLE",
        missing
          ? "The audit log is not installed. Apply supabase/migrations/50_admin_console_backend.sql."
          : "The audit log could not be read."
      );
    }

    const page = (data as unknown as AdminAuditPage | null) ?? null;
    if (!page) {
      return adminError(503, "AUDIT_UNAVAILABLE", "The audit log returned no data.");
    }

    const rows = Array.isArray(page.rows) ? page.rows : [];

    if (wantsCsv) {
      const header = [
        "Timestamp",
        "Actor",
        "Action",
        "Target type",
        "Target id",
        "Outcome",
        "Source",
        "Metadata",
      ];
      const body = rows.map((row) => [
        row.createdAt,
        row.actorEmail ?? "unknown",
        row.action,
        row.targetType,
        row.targetId ?? "",
        row.outcome,
        row.source,
        JSON.stringify(redact(row.metadata)),
      ]);

      const csv = toCsv([header, ...body]);
      const stamp = new Date().toISOString().slice(0, 10);

      return new Response(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="mavly-audit-log-${stamp}.csv"`,
          "cache-control": "private, no-store, max-age=0",
          "x-exported-rows": String(rows.length),
          "x-export-truncated": String(rows.length >= limit),
        },
      });
    }

    return adminJson({
      ok: true,
      data: {
        rows: rows.map((row) => ({ ...row, metadata: redact(row.metadata) })),
        total: Number(page.total) || 0,
        limit,
        offset,
        outcome,
        source,
        search: search || null,
        retentionDays: Number(page.retentionDays) || 90,
        counts: page.counts,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_TIMEOUT") {
      return adminError(504, "AUDIT_TIMEOUT", "The audit log query timed out.");
    }
    return adminError(503, "AUDIT_UNAVAILABLE", "The audit log could not be read.");
  }
}
