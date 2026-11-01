import type { NextRequest } from "next/server";

import {
  adminError,
  adminJson,
  boundedInteger,
  requireAdmin,
  withTimeout,
} from "@/lib/admin/http";
import type {
  AdminProjectGenerationStatus,
} from "@/lib/admin/directory";
import { isAdminProjectDirectoryResponse } from "@/lib/admin/directory";
import { adminDirectoryFailure } from "@/lib/admin/directory-errors";

export const dynamic = "force-dynamic";

const PROJECT_STATUSES = new Set<AdminProjectGenerationStatus>([
  "all",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "no_run",
]);
const VISIBILITIES = new Set(["all", "custom_domain", "preview_url", "draft"]);

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  const search = request.nextUrl.searchParams.get("search")?.trim() ?? "";
  const status = (request.nextUrl.searchParams.get("status") ?? "all") as AdminProjectGenerationStatus;
  const visibility = (request.nextUrl.searchParams.get("visibility") ?? "all").toLowerCase();
  if (search.length > 120 || !PROJECT_STATUSES.has(status) || !VISIBILITIES.has(visibility)) {
    return adminError(400, "INVALID_QUERY", "The project directory query is invalid.");
  }

  try {
    const { data, error } = await withTimeout(
      auth.supabase.rpc("admin_project_directory", {
        p_search: search || null,
        p_status: status,
        p_visibility: visibility,
        p_page: boundedInteger(request.nextUrl.searchParams.get("page"), 1, 1, 100_000),
        p_page_size: boundedInteger(request.nextUrl.searchParams.get("pageSize"), 10, 1, 50),
      }),
      8_000
    );

    if (error) {
      console.error("[adminsh] project directory RPC failed", {
        databaseCode: error.code ?? "unknown",
      });
      const failure = adminDirectoryFailure("project", error.code);
      return adminError(failure.status, failure.code, failure.message);
    }

    if (!isAdminProjectDirectoryResponse(data)) {
      return adminError(503, "PROJECT_DIRECTORY_INVALID_RESPONSE", "The project directory returned an invalid response.");
    }

    return adminJson({ ok: true, data });
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_TIMEOUT") {
      return adminError(504, "PROJECT_DIRECTORY_TIMEOUT", "The admin project directory timed out.");
    }
    console.error("[adminsh] project directory request failed", {
      reason: error instanceof Error ? "request_error" : "unknown_error",
    });
    return adminError(503, "PROJECT_DIRECTORY_UNAVAILABLE", "The admin project directory could not be loaded.");
  }
}
