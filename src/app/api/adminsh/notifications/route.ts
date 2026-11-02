import type { NextRequest } from "next/server";

import { adminError, adminJson, boundedInteger, requireAdmin, withTimeout } from "@/lib/admin/http";
import { normalizeAdminNotification, type AdminNotificationsPage } from "@/lib/admin/notifications";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizePage(value: unknown, limit: number, offset: number): AdminNotificationsPage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const rows = Array.isArray(raw.rows)
    ? raw.rows.map(normalizeAdminNotification).filter((row): row is NonNullable<typeof row> => row !== null)
    : [];
  const total = Number(raw.total);
  const unreadCount = Number(raw.unreadCount);
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(unreadCount) || unreadCount < 0) {
    return null;
  }
  return {
    rows,
    total,
    unreadCount,
    limit,
    offset,
    hasMore: raw.hasMore === true,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  const params = request.nextUrl.searchParams;
  const limit = boundedInteger(params.get("limit"), 20, 1, 50);
  const offset = boundedInteger(params.get("offset"), 0, 0, 100_000);

  try {
    const { data, error } = await withTimeout(
      auth.supabase.rpc("admin_notifications_page", { p_limit: limit, p_offset: offset }),
      8_000,
    );
    if (error) {
      const missing = error.code === "PGRST202" || error.code === "42883";
      return adminError(
        503,
        missing ? "NOTIFICATIONS_SCHEMA_MISSING" : "NOTIFICATIONS_UNAVAILABLE",
        missing
          ? "The admin notification store is not installed. Apply supabase/migrations/52_admin_notifications_and_reporting.sql."
          : "Admin notifications could not be read.",
      );
    }
    const page = normalizePage(data, limit, offset);
    if (!page) return adminError(503, "NOTIFICATIONS_INVALID_RESPONSE", "The notification store returned invalid data.");
    return adminJson({ ok: true, data: page });
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_TIMEOUT") {
      return adminError(504, "NOTIFICATIONS_TIMEOUT", "The admin notification request timed out.");
    }
    return adminError(503, "NOTIFICATIONS_UNAVAILABLE", "Admin notifications could not be read.");
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  const body = (await request.json().catch(() => null)) as
    | { action?: unknown; notificationId?: unknown }
    | null;
  const action = body?.action;

  if (action === "mark_read") {
    if (typeof body?.notificationId !== "string" || !UUID.test(body.notificationId)) {
      return adminError(400, "INVALID_NOTIFICATION_ID", "That notification id is invalid.");
    }
    try {
      const { data, error } = await withTimeout(
        auth.supabase.rpc("admin_notifications_mark_read", { p_notification_id: body.notificationId }),
        8_000,
      );
      if (error) return adminError(503, "NOTIFICATION_READ_UNAVAILABLE", "The notification could not be marked as read.");
      return adminJson({ ok: true, data });
    } catch {
      return adminError(503, "NOTIFICATION_READ_UNAVAILABLE", "The notification could not be marked as read.");
    }
  }

  if (action === "mark_all_read") {
    try {
      const { data, error } = await withTimeout(auth.supabase.rpc("admin_notifications_mark_all_read"), 8_000);
      if (error) return adminError(503, "NOTIFICATION_READ_UNAVAILABLE", "Notifications could not be marked as read.");
      return adminJson({ ok: true, data });
    } catch {
      return adminError(503, "NOTIFICATION_READ_UNAVAILABLE", "Notifications could not be marked as read.");
    }
  }

  return adminError(400, "INVALID_NOTIFICATION_ACTION", "That notification action is invalid.");
}
