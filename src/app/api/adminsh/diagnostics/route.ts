import {
  adminError,
  adminJson,
  requireAdmin,
  withTimeout,
} from "@/lib/admin/http";

export const dynamic = "force-dynamic";

/**
 * ═══ "WHICH RELATION IS ACTUALLY MISSING?" ══════════════════════════════════
 *
 * The directory routes can only classify a SQLSTATE. `42P01` says a relation is
 * absent but not WHICH one, and the project directory reads six of them. This
 * route asks the database directly, through migration 46's
 * `admin_directory_schema_report()`, and returns the answer as evidence.
 *
 * ⚠️ READ-ONLY. It creates nothing, fixes nothing and reads no customer row —
 * only `to_regclass` / `to_regprocedure` probes. It is safe to call in
 * production, and it is the first thing to call when a directory fails.
 *
 * ⚠️ IT DOES NOT HIDE A FAILURE. If the report itself cannot be produced (the
 * function is absent, the database is unreachable), this returns an error that
 * says so, rather than an empty object that looks like "everything is fine".
 */
export async function GET() {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  try {
    const { data, error } = await withTimeout(
      auth.supabase.rpc("admin_directory_schema_report"),
      8_000
    );

    if (error) {
      /**
       * `42883` / `PGRST202` here means migration 46 is not applied yet — which
       * is itself the answer to "why is the directory failing", so it is
       * reported as a precise, actionable condition instead of a generic 503.
       */
      const code = error.code ?? "unknown";
      const missingReport = code === "42883" || code === "PGRST202";
      return adminError(
        503,
        missingReport ? "SCHEMA_REPORT_NOT_INSTALLED" : "SCHEMA_REPORT_FAILED",
        missingReport
          ? "admin_directory_schema_report() is not installed. Apply supabase/migrations/46_admin_directory_optional_publication.sql, then retry."
          : `The schema report could not be produced (database code ${code}).`
      );
    }

    if (data === null || typeof data !== "object") {
      return adminError(
        503,
        "SCHEMA_REPORT_INVALID",
        "The schema report returned no usable payload."
      );
    }

    return adminJson({ ok: true, data });
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_TIMEOUT") {
      return adminError(504, "SCHEMA_REPORT_TIMEOUT", "The schema report timed out.");
    }
    return adminError(
      503,
      "SCHEMA_REPORT_UNAVAILABLE",
      "The schema report could not be loaded."
    );
  }
}
