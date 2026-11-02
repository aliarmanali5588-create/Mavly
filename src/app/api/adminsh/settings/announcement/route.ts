import type { NextRequest } from "next/server";

import { adminError, adminJson, requireAdmin, withTimeout } from "@/lib/admin/http";

export const dynamic = "force-dynamic";

interface AnnouncementSettingsBody {
  enabled?: unknown;
  message?: unknown;
}

/**
 * The Settings card sends both announcement values together. The database RPC
 * validates and writes them in one transaction, so an enabled banner can never
 * observe only half of a form submission.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  let body: AnnouncementSettingsBody;
  try {
    body = (await request.json()) as AnnouncementSettingsBody;
  } catch {
    return adminError(400, "INVALID_REQUEST", "The request body is not valid JSON.");
  }

  if (typeof body.enabled !== "boolean") {
    return adminError(400, "INVALID_SETTING_VALUE", "Choose whether the announcement is enabled.");
  }
  if (typeof body.message !== "string") {
    return adminError(400, "INVALID_SETTING_VALUE", "Enter an announcement message.");
  }

  const message = body.message.trim();
  if (message.length > 500) {
    return adminError(400, "ANNOUNCEMENT_MESSAGE_TOO_LONG", "The announcement must be 500 characters or fewer.");
  }
  if (body.enabled && message.length === 0) {
    return adminError(400, "ANNOUNCEMENT_MESSAGE_REQUIRED", "Enter a message before enabling the announcement.");
  }

  try {
    const { data, error } = await withTimeout(
      auth.supabase.rpc("admin_announcement_settings_write", {
        p_enabled: body.enabled,
        p_message: message,
      }),
      8_000,
    );

    if (error) {
      if (error.message?.includes("ANNOUNCEMENT_MESSAGE_REQUIRED")) {
        return adminError(400, "ANNOUNCEMENT_MESSAGE_REQUIRED", "Enter a message before enabling the announcement.");
      }
      if (error.message?.includes("ANNOUNCEMENT_MESSAGE_TOO_LONG")) {
        return adminError(400, "ANNOUNCEMENT_MESSAGE_TOO_LONG", "The announcement must be 500 characters or fewer.");
      }
      if (error.message?.includes("INVALID_SETTING_VALUE")) {
        return adminError(400, "INVALID_SETTING_VALUE", "The announcement settings are not valid.");
      }

      const missing = error.code === "PGRST202" || error.code === "42883";
      return adminError(
        503,
        missing ? "SETTINGS_SCHEMA_MISSING" : "ANNOUNCEMENT_SETTINGS_WRITE_FAILED",
        missing
          ? "Announcement settings are not installed. Apply supabase/migrations/53_live_announcement_banner.sql."
          : "The announcement could not be saved.",
      );
    }

    const result = (data ?? {}) as { changed?: boolean };
    return adminJson({
      ok: true,
      data: {
        changed: result.changed === true,
        message: result.changed === true
          ? "Saved. The public banner uses this state on its next request."
          : "Saved. The announcement settings were already set to that.",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_TIMEOUT") {
      return adminError(504, "ANNOUNCEMENT_SETTINGS_TIMEOUT", "The announcement settings request timed out.");
    }
    return adminError(503, "ANNOUNCEMENT_SETTINGS_UNAVAILABLE", "The announcement settings could not be saved.");
  }
}
