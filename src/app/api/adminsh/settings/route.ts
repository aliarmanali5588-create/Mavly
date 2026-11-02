import type { NextRequest } from "next/server";

import packageJson from "../../../../../package.json";
import { adminError, adminJson, requireAdmin, withTimeout } from "@/lib/admin/http";
import type { AdminSettingRow, AdminSettingsPayload } from "@/lib/admin/console";
import { OPENROUTER_MODEL_CATALOG, configuredDefaultModelId } from "@/lib/ai/models";
import { generationWorkerConfig } from "@/lib/generation/worker-config";

export const dynamic = "force-dynamic";

/**
 * ═══ SETTINGS — READ ════════════════════════════════════════════════════════
 *
 * Two distinct kinds of setting, and the payload keeps them apart:
 *
 *   settings[]    runtime-editable, stored in `admin_settings`, written through
 *                 `admin_settings_write`. Only keys in the database registry can
 *                 appear, so the page cannot offer a toggle that persists
 *                 nothing.
 *   deployment    facts that come from the environment (model default, worker
 *                 readiness, provider/payment presence, hosting mode). These are
 *                 read-only here BY CONSTRUCTION: changing them requires a
 *                 redeploy, and a UI that let you "save" them would be lying.
 *
 * ⚠️ NO SECRET IS EVER RETURNED. Presence is reported as a boolean; the value
 * itself never leaves the server.
 */

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

function configured(name: string): boolean {
  return (process.env[name] ?? "").trim() !== "";
}

function environmentName(): string {
  const explicit = (process.env.MAVLY_ENVIRONMENT ?? process.env.NODE_ENV ?? "").trim();
  return explicit !== "" ? explicit : "unknown";
}

export async function GET(_request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  let settings: AdminSettingRow[] = [];

  try {
    const { data, error } = await withTimeout(auth.supabase.rpc("admin_settings_read"), 8_000);

    if (error) {
      const missing = error.code === "PGRST202" || error.code === "42883";
      return adminError(
        503,
        missing ? "SETTINGS_SCHEMA_MISSING" : "SETTINGS_UNAVAILABLE",
        missing
          ? "Settings are not installed. Apply supabase/migrations/50_admin_console_backend.sql."
          : "Settings could not be read."
      );
    }

    const payload = (data as { settings?: AdminSettingRow[] } | null) ?? null;
    settings = Array.isArray(payload?.settings) ? payload.settings : [];
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_TIMEOUT") {
      return adminError(504, "SETTINGS_TIMEOUT", "The settings query timed out.");
    }
    return adminError(503, "SETTINGS_UNAVAILABLE", "Settings could not be read.");
  }

  const worker = generationWorkerConfig();
  const hostingMode = (process.env.MAVLY_HOSTING_MODE ?? "").trim().toLowerCase() || null;

  const payload: AdminSettingsPayload = {
    settings,
    deployment: {
      environment: environmentName(),
      /**
       * `package.json` has no `version` field in this repository, so the read is
       * typed as unknown and reports null rather than inventing a release.
       */
      version:
        typeof (packageJson as unknown as { version?: unknown }).version === "string" &&
        String((packageJson as unknown as { version: string }).version).trim() !== ""
          ? String((packageJson as unknown as { version: string }).version)
          : null,
      defaultModel: configuredDefaultModelId(),
      modelCatalog: OPENROUTER_MODEL_CATALOG.map((entry) => entry.id),
      workerConfigured: worker.ready,
      providerConfigured: configured("OPENROUTER_API_KEY"),
      paymentGateway:
        configured("RAZORPAY_KEY_ID") && configured("RAZORPAY_KEY_SECRET")
          ? "razorpay"
          : null,
      storageConfigured:
        ENABLED_VALUES.has((process.env.MAVLY_ANDROID_BUILD_ENABLED ?? "").trim().toLowerCase()) &&
        configured("MAVLY_ANDROID_ARTIFACT_BUCKET"),
      hostingMode,
    },
  };

  return adminJson({ ok: true, data: payload });
}
