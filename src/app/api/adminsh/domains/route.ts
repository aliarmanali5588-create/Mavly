import type { NextRequest } from "next/server";

import {
  adminError,
  adminJson,
  boundedInteger,
  requireAdmin,
  withTimeout,
} from "@/lib/admin/http";

export const dynamic = "force-dynamic";

/**
 * ═══ DOMAINS — ADMIN READ + ROUTING APPROVAL ════════════════════════════════
 *
 * Reads `public.project_domains` through `admin_domain_overview`, which refuses
 * unless the CALLER is an administrator (`current_user_is_admin()`). The route
 * holds no service-role client: every figure below is the database's own
 * aggregate, so the page cannot drift from the registry.
 *
 * ⚠️ APPROVAL IS A REAL WRITE, NOT A FLAG. `admin_approve_domain_routing` writes
 * `routing_approved_at` and an `admin_audit_log` row. A custom hostname cannot be
 * routed by the worker while `MAVLY_DOMAIN_ROUTING_REQUIRE_APPROVAL` is on (the
 * default) and this approval is absent.
 *
 * ⚠️ A MISSING FUNCTION IS A DEPLOYMENT PROBLEM, NOT AN EMPTY REGISTRY. Saying so
 * is the difference between "no domains yet" and "migration 62 is not applied".
 */

const DOMAIN_STATUSES = new Set([
  "all",
  "pending",
  "verification_required",
  "verifying",
  "verified",
  "provisioning",
  "active",
  "misconfigured",
  "ssl_pending",
  "ssl_failed",
  "disabled",
  "removing",
  "removed",
]);

interface RpcDomainOverview {
  summary: Record<string, unknown> | null;
  rows: unknown[] | null;
  recentEvents: unknown[] | null;
}

function missingSchema(error: { code?: string | null; message?: string | null }): boolean {
  const code = error.code ?? "";
  if (code === "PGRST202" || code === "42883" || code === "42P01") return true;
  return (error.message ?? "").includes("admin_domain_overview");
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  const params = request.nextUrl.searchParams;
  const status = params.get("status") ?? "all";
  const search = (params.get("q") ?? "").trim().slice(0, 120);
  const limit = boundedInteger(params.get("limit"), 50, 1, 100);
  const offset = boundedInteger(params.get("offset"), 0, 0, 100_000);

  if (!DOMAIN_STATUSES.has(status)) {
    return adminError(400, "DOMAIN_STATUS_INVALID", "That domain status filter is not supported.");
  }

  try {
    const { data, error } = await withTimeout(
      auth.supabase.rpc("admin_domain_overview", {
        p_limit: limit,
        p_offset: offset,
        p_search: search ? search : null,
        p_status: status,
      }),
      8_000
    );

    if (error) {
      const missing = missingSchema(error);
      return adminError(
        503,
        missing ? "DOMAINS_SCHEMA_MISSING" : "DOMAINS_UNAVAILABLE",
        missing
          ? "The domain registry is not installed. Apply supabase/migrations/62_domain_management.sql."
          : "The domain registry could not be read."
      );
    }

    const page = (data as RpcDomainOverview | null) ?? null;
    if (!page) {
      return adminError(503, "DOMAINS_UNAVAILABLE", "The domain registry returned no data.");
    }

    return adminJson({
      ok: true,
      data: {
        summary: page.summary ?? {},
        rows: Array.isArray(page.rows) ? page.rows : [],
        recentEvents: Array.isArray(page.recentEvents) ? page.recentEvents : [],
        limit,
        offset,
        status,
        search: search || null,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_TIMEOUT") {
      return adminError(504, "DOMAINS_TIMEOUT", "The domain registry query timed out.");
    }
    return adminError(503, "DOMAINS_UNAVAILABLE", "The domain registry could not be read.");
  }
}

/**
 * Approve or revoke routing for one custom hostname.
 *
 * The RPC enforces the admin check again and writes the audit row; this handler
 * only validates the shape of the request.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return adminError(400, "REQUEST_INVALID", "Send a JSON body.");
  }

  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const domainId = typeof record.domainId === "string" ? record.domainId.trim() : "";
  const approved = record.approved;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(domainId)) {
    return adminError(400, "DOMAIN_ID_INVALID", "That domain id is not valid.");
  }
  if (typeof approved !== "boolean") {
    return adminError(400, "DOMAIN_APPROVAL_INVALID", "approved must be true or false.");
  }

  try {
    const { data, error } = await withTimeout(
      auth.supabase.rpc("admin_approve_domain_routing", {
        p_domain_id: domainId,
        p_approved: approved,
      }),
      8_000
    );

    if (error) {
      const missing = missingSchema(error);
      const notFound = (error.message ?? "").includes("DOMAIN_NOT_FOUND");
      return adminError(
        notFound ? 404 : 503,
        missing ? "DOMAINS_SCHEMA_MISSING" : notFound ? "DOMAIN_NOT_FOUND" : "DOMAINS_UNAVAILABLE",
        missing
          ? "The domain registry is not installed. Apply supabase/migrations/62_domain_management.sql."
          : notFound
            ? "That domain no longer exists."
            : "The approval could not be recorded."
      );
    }

    return adminJson({ ok: true, data: data ?? null });
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_TIMEOUT") {
      return adminError(504, "DOMAINS_TIMEOUT", "The approval timed out.");
    }
    return adminError(503, "DOMAINS_UNAVAILABLE", "The approval could not be recorded.");
  }
}
