import type { NextRequest } from "next/server";

import {
  adminError,
  adminJson,
  boundedInteger,
  requireAdmin,
  withTimeout,
} from "@/lib/admin/http";
import {
  ANNOUNCEMENT_KINDS,
  ANNOUNCEMENT_STATUSES,
  type AdminAnnouncementsPage,
} from "@/lib/admin/console";

export const dynamic = "force-dynamic";

/**
 * ═══ ANNOUNCEMENTS — READ ═══════════════════════════════════════════════════
 *
 * Reads `public.admin_announcements` through `admin_announcements_page`, which
 * refuses unless the caller is an administrator. There is no other source: the
 * page previously rendered a hardcoded array, and nothing in the product ever
 * persisted an announcement.
 *
 * ⚠️ "PUBLISHED" IS NOT "SEEN". Publishing makes a row eligible for
 * `active_announcements()`. Mavly has no push, email or in-app banner consumer
 * wired to that feed, so the counts here describe publication state, not
 * delivery. The UI says so; this route does not pretend otherwise.
 */

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  const params = request.nextUrl.searchParams;
  const search = (params.get("q") ?? "").trim().slice(0, 120);
  const rawStatus = (params.get("status") ?? "all").trim().toLowerCase();
  const rawKind = (params.get("kind") ?? "all").trim().toLowerCase();

  const status =
    rawStatus === "all" || ANNOUNCEMENT_STATUSES.includes(rawStatus as never)
      ? rawStatus
      : "all";
  const kind =
    rawKind === "all" || ANNOUNCEMENT_KINDS.includes(rawKind as never) ? rawKind : "all";

  const limit = boundedInteger(params.get("limit"), 50, 1, 100);
  const offset = boundedInteger(params.get("offset"), 0, 0, 100_000);

  try {
    const { data, error } = await withTimeout(
      auth.supabase.rpc("admin_announcements_page", {
        p_search: search ? search : null,
        p_status: status,
        p_kind: kind,
        p_limit: limit,
        p_offset: offset,
      }),
      8_000
    );

    if (error) {
      const missing = error.code === "PGRST202" || error.code === "42883";
      return adminError(
        503,
        missing ? "ANNOUNCEMENTS_SCHEMA_MISSING" : "ANNOUNCEMENTS_UNAVAILABLE",
        missing
          ? "Announcements are not installed. Apply supabase/migrations/50_admin_console_backend.sql."
          : "Announcements could not be read."
      );
    }

    const page = (data as unknown as AdminAnnouncementsPage | null) ?? null;
    if (!page) {
      return adminError(503, "ANNOUNCEMENTS_UNAVAILABLE", "Announcements returned no data.");
    }

    return adminJson({
      ok: true,
      data: {
        rows: Array.isArray(page.rows) ? page.rows : [],
        total: Number(page.total) || 0,
        limit,
        offset,
        status,
        kind,
        search: search || null,
        counts: page.counts,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_TIMEOUT") {
      return adminError(504, "ANNOUNCEMENTS_TIMEOUT", "The announcements query timed out.");
    }
    return adminError(503, "ANNOUNCEMENTS_UNAVAILABLE", "Announcements could not be read.");
  }
}
