import { adminError, adminJson, requireAdmin, withTimeout } from "@/lib/admin/http";
import { adminDirectoryFailure } from "@/lib/admin/directory-errors";

export const dynamic = "force-dynamic";

/**
 * ═══ ONE AUTHORITATIVE USER COUNT ═══════════════════════════════════════════
 *
 * The sidebar badge and the Users page header must never disagree. Both read
 * this route, which reads `public.admin_user_directory`'s `metrics.total` — the
 * same `count(*) over auth.users` the directory table paginates.
 *
 * ⚠️ NO FALLBACK NUMBER. A hardcoded badge (`12.4k`) is what made the console
 * contradict itself. When the count cannot be read this returns an error and
 * the UI renders a loading/unknown state, never a plausible-looking constant.
 *
 * `p_page_size: 1` keeps the payload tiny: the RPC still computes the full
 * aggregate and `total`, but only one row is materialised.
 */
export async function GET() {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  try {
    const { data, error } = await withTimeout(
      auth.supabase.rpc("admin_user_directory", {
        p_search: null,
        p_status: "all",
        p_page: 1,
        p_page_size: 1,
      }),
      8_000
    );

    if (error) {
      console.error("[adminsh] user count RPC failed", {
        databaseCode: error.code ?? "unknown",
      });
      const failure = adminDirectoryFailure("user", error.code);
      return adminError(failure.status, failure.code, failure.message);
    }

    const metrics = (data as { metrics?: { total?: unknown } } | null)?.metrics;
    const total = metrics?.total;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
      return adminError(
        503,
        "USER_COUNT_INVALID_RESPONSE",
        "The user directory returned an invalid total."
      );
    }

    return adminJson({ ok: true, data: { total } });
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_TIMEOUT") {
      return adminError(504, "USER_COUNT_TIMEOUT", "The user count timed out.");
    }
    console.error("[adminsh] user count request failed", {
      reason: error instanceof Error ? "request_error" : "unknown_error",
    });
    return adminError(503, "USER_COUNT_UNAVAILABLE", "The user count could not be loaded.");
  }
}
