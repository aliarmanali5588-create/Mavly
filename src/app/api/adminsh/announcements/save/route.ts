import type { NextRequest } from "next/server";

import { adminError, adminJson, requireAdmin } from "@/lib/admin/http";
import { ANNOUNCEMENT_KINDS, ANNOUNCEMENT_STATUSES } from "@/lib/admin/console";

export const dynamic = "force-dynamic";

/**
 * ═══ ANNOUNCEMENTS — WRITE ══════════════════════════════════════════════════
 *
 * Create, edit, publish, unpublish, archive and delete, all through
 * `admin_announcement_save` / `admin_announcement_delete`. The database is the
 * validator: this route checks shape so the operator gets a useful message, and
 * the RPC re-checks everything so a crafted request cannot bypass it.
 *
 * ⚠️ DELETING A PUBLISHED ANNOUNCEMENT IS REFUSED. It must be unpublished or
 * archived first, so removing something users can currently see is always a
 * deliberate two-step act with its own audit row.
 *
 * ⚠️ PUBLISHING IS NOT DELIVERY. The response says the row is eligible for the
 * app feed; it does not claim anyone saw it.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SaveBody {
  id?: unknown;
  title?: unknown;
  body?: unknown;
  kind?: unknown;
  status?: unknown;
  targetPlan?: unknown;
  dismissible?: unknown;
  startsAt?: unknown;
  expiresAt?: unknown;
}

function parseTimestamp(value: unknown, field: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null || value === undefined || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: `${field} must be an ISO timestamp.` };
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return { ok: false, error: `${field} must be a valid date.` };
  return { ok: true, value: new Date(parsed).toISOString() };
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  let body: SaveBody;
  try {
    body = (await request.json()) as SaveBody;
  } catch {
    return adminError(400, "INVALID_REQUEST", "The request body is not valid JSON.");
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  if (body.status === "__delete__") {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!UUID_PATTERN.test(id)) {
      return adminError(400, "INVALID_REQUEST", "A valid announcement id is required.");
    }

    const { data, error } = await auth.supabase.rpc("admin_announcement_delete", { p_id: id });

    if (error) {
      if (error.message?.includes("ANNOUNCEMENT_PUBLISHED")) {
        return adminError(
          409,
          "ANNOUNCEMENT_PUBLISHED",
          "Unpublish or archive this announcement before deleting it."
        );
      }
      if (error.code === "P0002") {
        return adminError(404, "ANNOUNCEMENT_NOT_FOUND", "That announcement no longer exists.");
      }
      const missing = error.code === "PGRST202" || error.code === "42883";
      return adminError(
        503,
        missing ? "ANNOUNCEMENTS_SCHEMA_MISSING" : "ANNOUNCEMENT_DELETE_FAILED",
        missing
          ? "Announcements are not installed. Apply supabase/migrations/50_admin_console_backend.sql."
          : "The announcement could not be deleted."
      );
    }

    return adminJson({
      ok: true,
      data: { status: "deleted", id, ...(data as object) },
    });
  }

  // ── Create / update ───────────────────────────────────────────────────────
  const id = typeof body.id === "string" && body.id.trim() !== "" ? body.id.trim() : null;
  if (id !== null && !UUID_PATTERN.test(id)) {
    return adminError(400, "INVALID_REQUEST", "That announcement id is not valid.");
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title.length < 1 || title.length > 160) {
    return adminError(400, "INVALID_TITLE", "A title of 1 to 160 characters is required.");
  }

  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (text.length < 1 || text.length > 4000) {
    return adminError(400, "INVALID_BODY", "A body of 1 to 4000 characters is required.");
  }

  const kind = typeof body.kind === "string" ? body.kind.trim().toLowerCase() : "information";
  if (!ANNOUNCEMENT_KINDS.includes(kind as never)) {
    return adminError(400, "INVALID_KIND", "That announcement type is not supported.");
  }

  const status = typeof body.status === "string" ? body.status.trim().toLowerCase() : "draft";
  if (!ANNOUNCEMENT_STATUSES.includes(status as never)) {
    return adminError(400, "INVALID_STATUS", "That announcement status is not supported.");
  }

  const targetPlan =
    typeof body.targetPlan === "string" && body.targetPlan.trim() !== ""
      ? body.targetPlan.trim().slice(0, 80)
      : "All Plans";

  const dismissible = body.dismissible === undefined ? true : body.dismissible === true;

  const startsAt = parseTimestamp(body.startsAt, "The start time");
  if ("error" in startsAt) return adminError(400, "INVALID_WINDOW", startsAt.error);

  const expiresAt = parseTimestamp(body.expiresAt, "The expiry time");
  if ("error" in expiresAt) return adminError(400, "INVALID_WINDOW", expiresAt.error);

  if (startsAt.value && expiresAt.value && Date.parse(expiresAt.value) <= Date.parse(startsAt.value)) {
    return adminError(400, "INVALID_WINDOW", "The expiry must be after the start time.");
  }

  const { data, error } = await auth.supabase.rpc("admin_announcement_save", {
    p_id: id,
    p_title: title,
    p_body: text,
    p_kind: kind,
    p_status: status,
    p_target_plan: targetPlan,
    p_dismissible: dismissible,
    p_starts_at: startsAt.value,
    p_expires_at: expiresAt.value,
  });

  if (error) {
    if (error.code === "P0002") {
      return adminError(404, "ANNOUNCEMENT_NOT_FOUND", "That announcement no longer exists.");
    }
    const missing = error.code === "PGRST202" || error.code === "42883";
    return adminError(
      503,
      missing ? "ANNOUNCEMENTS_SCHEMA_MISSING" : "ANNOUNCEMENT_SAVE_FAILED",
      missing
        ? "Announcements are not installed. Apply supabase/migrations/50_admin_console_backend.sql."
        : "The announcement could not be saved."
    );
  }

  const saved = (data ?? {}) as { id?: string; status?: string; publishedAt?: string | null };

  return adminJson({
    ok: true,
    data: {
      id: saved.id ?? id,
      status: saved.status ?? status,
      publishedAt: saved.publishedAt ?? null,
      message:
        status === "published"
          ? "Published. It is now eligible for the app announcement feed; no delivery channel is wired to that feed yet."
          : status === "archived"
            ? "Archived. It is retained but never served."
            : "Saved as a draft. It is not visible to anyone.",
    },
  });
}
