import type { NextRequest } from "next/server";

import { adminError, adminJson, requireAdmin } from "@/lib/admin/http";

export const dynamic = "force-dynamic";

/**
 * ═══ SETTINGS — WRITE ═══════════════════════════════════════════════════════
 *
 * Writes one runtime-editable key through `admin_settings_write`, which validates
 * the type and range on the server and refuses any key that is not in the
 * database registry.
 *
 * ⚠️ A DEPLOYMENT-MANAGED VALUE CANNOT BE WRITTEN HERE. Model defaults, worker
 * credentials, provider keys and the payment gateway come from the environment.
 * The RPC has no registry row for them, so this route cannot persist them and
 * the page renders them read-only with their real source.
 *
 * ⚠️ EVERY WRITE IS AUDITED. The RPC records an `setting.updated` row with the
 * previous and next value, so a configuration change is always attributable.
 */

interface WriteBody {
  key?: unknown;
  value?: unknown;
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  let body: WriteBody;
  try {
    body = (await request.json()) as WriteBody;
  } catch {
    return adminError(400, "INVALID_REQUEST", "The request body is not valid JSON.");
  }

  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (key === "" || key.length > 61) {
    return adminError(400, "INVALID_SETTING_KEY", "A valid setting key is required.");
  }

  if (body.value === undefined) {
    return adminError(400, "INVALID_SETTING_VALUE", "A value is required.");
  }

  const { data, error } = await auth.supabase.rpc("admin_settings_write", {
    p_key: key,
    p_value: body.value as never,
  });

  if (error) {
    if (error.message?.includes("UNKNOWN_SETTING")) {
      return adminError(400, "UNKNOWN_SETTING", "That setting does not exist.");
    }
    if (error.message?.includes("SETTING_NOT_EDITABLE")) {
      return adminError(
        403,
        "SETTING_NOT_EDITABLE",
        "That setting is managed by the deployment and cannot be changed here."
      );
    }
    if (error.message?.includes("INVALID_SETTING_VALUE")) {
      return adminError(400, "INVALID_SETTING_VALUE", "That value is not valid for this setting.");
    }
    if (error.message?.includes("ANNOUNCEMENT_MESSAGE_REQUIRED")) {
      return adminError(400, "ANNOUNCEMENT_MESSAGE_REQUIRED", "Enter a message before enabling the announcement.");
    }
    if (error.message?.includes("ANNOUNCEMENT_MESSAGE_TOO_LONG")) {
      return adminError(400, "ANNOUNCEMENT_MESSAGE_TOO_LONG", "The announcement must be 500 characters or fewer.");
    }
    const missing = error.code === "PGRST202" || error.code === "42883";
    return adminError(
      503,
      missing ? "SETTINGS_SCHEMA_MISSING" : "SETTING_WRITE_FAILED",
      missing
        ? "Settings are not installed. Apply supabase/migrations/50_admin_console_backend.sql."
        : "The setting could not be saved."
    );
  }

  const result = (data ?? {}) as { key?: string; value?: unknown; changed?: boolean };

  return adminJson({
    ok: true,
    data: {
      key: result.key ?? key,
      value: result.value,
      changed: result.changed === true,
      message:
        result.changed === true
          ? "Saved. This takes effect on the next request that reads it; nothing is cached."
          : "Saved. The value was already set to that.",
    },
  });
}
