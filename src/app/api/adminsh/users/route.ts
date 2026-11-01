import type { NextRequest } from "next/server";

import {
  adminError,
  adminJson,
  boundedInteger,
  requireAdmin,
  withTimeout,
} from "@/lib/admin/http";
import { isAdminUserDirectoryResponse } from "@/lib/admin/directory";
import { adminDirectoryFailure } from "@/lib/admin/directory-errors";

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
      console.error("[adminsh] user directory RPC failed", {
        databaseCode: error.code ?? "unknown",
      });
      const failure = adminDirectoryFailure("user", error.code);
      return adminError(failure.status, failure.code, failure.message);
    }

    if (!isAdminUserDirectoryResponse(data)) {
      return adminError(503, "USER_DIRECTORY_INVALID_RESPONSE", "The user directory returned an invalid response.");
    }

    return adminJson({ ok: true, data });
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_TIMEOUT") {
      return adminError(504, "USER_DIRECTORY_TIMEOUT", "The admin user directory timed out.");
    }
    console.error("[adminsh] user directory request failed", {
      reason: error instanceof Error ? "request_error" : "unknown_error",
    });
    return adminError(503, "USER_DIRECTORY_UNAVAILABLE", "The admin user directory could not be loaded.");
  }
}
