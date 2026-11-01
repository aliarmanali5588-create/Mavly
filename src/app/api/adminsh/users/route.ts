import type { NextRequest } from "next/server";

import {
  adminError,
  adminJson,
  boundedInteger,
  requireAdmin,
  withTimeout,
} from "@/lib/admin/http";
import type { AdminUserDirectoryResponse } from "@/lib/admin/directory";

export const dynamic = "force-dynamic";

const USER_STATUSES = new Set(["all", "not_banned", "banned"]);

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  const search = request.nextUrl.searchParams.get("search")?.trim() ?? "";
  const status = (request.nextUrl.searchParams.get("status") ?? "all").toLowerCase();
  if (search.length > 120 || !USER_STATUSES.has(status)) {
    return adminError(400, "INVALID_QUERY", "The user directory query is invalid.");
  }

  try {
    const { data, error } = await withTimeout(
      auth.supabase.rpc("admin_user_directory", {
        p_search: search || null,
        p_status: status,
        p_page: boundedInteger(request.nextUrl.searchParams.get("page"), 1, 1, 100_000),
        p_page_size: boundedInteger(request.nextUrl.searchParams.get("pageSize"), 5, 1, 50),
      }),
      8_000
    );

    if (error) {
      return adminError(
        503,
        "USER_DIRECTORY_UNAVAILABLE",
        "The admin user directory is unavailable. Apply supabase/migrations/41_admin_directory.sql."
      );
    }

    if (!data || typeof data !== "object") {
      return adminError(503, "USER_DIRECTORY_UNAVAILABLE", "The user directory returned no data.");
    }

    return adminJson({ ok: true, data: data as AdminUserDirectoryResponse });
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_TIMEOUT") {
      return adminError(504, "USER_DIRECTORY_TIMEOUT", "The admin user directory timed out.");
    }
    return adminError(503, "USER_DIRECTORY_UNAVAILABLE", "The admin user directory could not be loaded.");
  }
}
