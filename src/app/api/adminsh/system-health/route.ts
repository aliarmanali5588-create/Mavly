import type { NextRequest } from "next/server";

import packageJson from "../../../../../package.json";
import { adminError, adminJson, requireAdmin, withTimeout } from "@/lib/admin/http";
import type {
  AdminHealthPayload,
  AdminServiceCheck,
  AdminServiceState,
} from "@/lib/admin/console";
import { generationWorkerConfig } from "@/lib/generation/worker-config";

export const dynamic = "force-dynamic";

/**
 * ═══ SYSTEM HEALTH — MEASURED, NOT DECORATED ════════════════════════════════
 *
 * Every row here is one of exactly three things, and the row says which:
 *
 *   measured     a real call was made this request and the result is reported
 *                (database round-trip, worker credential resolution, queue state)
 *   configured   the dependency is present but has no safe probe (provider key,
 *                payment gateway, sandbox key). State is `unknown`, never `ok`.
 *   absent       the dependency is not configured. State is `not_configured`.
 *
 * ⚠️ A SUCCESSFUL QUERY DOES NOT PROVE THE PLATFORM IS HEALTHY. The database row
 * proves the database answered. It says nothing about the AI provider, the
 * worker process, DNS or payments, so those rows never inherit its state.
 *
 * ⚠️ THERE IS NO UPTIME PERCENTAGE. Mavly records no historical availability
 * samples, so `uptimePercent` is always `null` and the page renders "not
 * recorded". A number here would be invented, and an invented uptime is the
 * single most misleading thing a health page can show.
 *
 * ⚠️ NO PROBE IS DESTRUCTIVE OR PAID. Nothing here writes, charges, sends or
 * calls a third-party API. The only network call is the database read the page
 * already needs.
 */

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

function flagEnabled(name: string): boolean {
  return ENABLED_VALUES.has((process.env[name] ?? "").trim().toLowerCase());
}

function configured(name: string): boolean {
  return (process.env[name] ?? "").trim() !== "";
}

function environmentName(): string {
  const explicit = (process.env.MAVLY_ENVIRONMENT ?? process.env.NODE_ENV ?? "").trim();
  if (explicit !== "") return explicit;
  return "unknown";
}

interface RpcSnapshot {
  measuredAt: string;
  queued: number;
  running: number;
  staleLeases: number;
  oldestQueuedAt: string | null;
  lastHeartbeatAt: string | null;
  lastCompletedAt: string | null;
  lastFailureAt: string | null;
  runsLast24h: number;
  failuresLast24h: number;
}

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Queue state from real facts.
 *
 * ⚠️ "NO HEARTBEAT" IS NOT "DOWN". A platform with no generation traffic has no
 * heartbeat and is perfectly healthy. Only a stale lease or a backlog older than
 * the worker's own lease window is evidence of a problem, and even then the
 * honest state is `degraded` — the database cannot see whether the worker
 * process is alive, only whether work is moving.
 */
function queueState(snapshot: RpcSnapshot): { state: AdminServiceState; detail: string } {
  const stale = num(snapshot.staleLeases);
  const queued = num(snapshot.queued);
  const running = num(snapshot.running);
  const oldest = snapshot.oldestQueuedAt ? Date.parse(snapshot.oldestQueuedAt) : null;
  const oldestMinutes =
    oldest !== null && Number.isFinite(oldest) ? Math.round((Date.now() - oldest) / 60_000) : null;

  const parts = [
    `${queued} queued`,
    `${running} running`,
    stale > 0 ? `${stale} stale lease(s)` : "no stale leases",
  ];
  if (oldestMinutes !== null && queued > 0) {
    parts.push(`oldest queued ${oldestMinutes}m`);
  }
  if (snapshot.lastHeartbeatAt) {
    parts.push("worker heartbeat recorded");
  } else {
    parts.push("no worker heartbeat recorded yet");
  }

  let state: AdminServiceState = "operational";
  if (stale > 0) state = "degraded";
  else if (oldestMinutes !== null && oldestMinutes > 30) state = "degraded";
  else if (queued > 0 && !snapshot.lastHeartbeatAt) state = "degraded";

  return { state, detail: parts.join(" · ") };
}

export async function GET(_request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  const measuredAt = new Date().toISOString();
  const services: AdminServiceCheck[] = [];

  // ── 1. Application server ─────────────────────────────────────────────────
  services.push({
    id: "app_server",
    label: "Application Server",
    description: "This Next.js server, rendering and answering this admin request.",
    state: "operational",
    detail: `Responded in this request · ${environmentName()}`,
    latencyMs: null,
    measured: true,
  });

  // ── 2. Database ───────────────────────────────────────────────────────────
  const dbStarted = Date.now();
  let snapshot: RpcSnapshot | null = null;
  let snapshotError: string | null = null;

  try {
    const { data, error } = await withTimeout(
      auth.supabase.rpc("admin_health_snapshot"),
      6_000
    );
    if (error) {
      snapshotError =
        error.code === "PGRST202" || error.code === "42883"
          ? "The health snapshot function is not installed. Apply supabase/migrations/50_admin_console_backend.sql."
          : "The health snapshot query failed.";
    } else {
      snapshot = (data as RpcSnapshot | null) ?? null;
    }
  } catch {
    snapshotError = "The health snapshot query timed out.";
  }

  const dbLatencyMs = Date.now() - dbStarted;

  services.push({
    id: "database",
    label: "Primary Database",
    description: "Supabase Postgres, read through the caller's own session.",
    state: snapshot ? "operational" : "down",
    detail: snapshot
      ? `Health snapshot returned in ${dbLatencyMs}ms`
      : (snapshotError ?? "The database did not answer."),
    latencyMs: snapshot ? dbLatencyMs : null,
    measured: true,
  });

  // ── 3. Generation worker queue ────────────────────────────────────────────
  const worker = generationWorkerConfig();
  if (!worker.ready) {
    services.push({
      id: "worker_queue",
      label: "Generation Worker Queue",
      description: "Durable generation runs, leases and backlog.",
      state: "not_configured",
      detail: `Server-side worker credentials are not configured (${worker.problems.join(", ")}).`,
      latencyMs: null,
      measured: true,
    });
  } else if (!snapshot) {
    services.push({
      id: "worker_queue",
      label: "Generation Worker Queue",
      description: "Durable generation runs, leases and backlog.",
      state: "unknown",
      detail: "Worker credentials are configured, but the queue could not be read.",
      latencyMs: null,
      measured: false,
    });
  } else {
    const queue = queueState(snapshot);
    services.push({
      id: "worker_queue",
      label: "Generation Worker Queue",
      description: "Durable generation runs, leases and backlog.",
      state: queue.state,
      detail: queue.detail,
      latencyMs: null,
      measured: true,
    });
  }

  // ── 4. AI provider ────────────────────────────────────────────────────────
  const providerConfigured = configured("OPENROUTER_API_KEY");
  services.push({
    id: "ai_provider",
    label: "AI Provider (OpenRouter)",
    description: "Server-only text and image generation provider.",
    state: providerConfigured ? "unknown" : "not_configured",
    detail: providerConfigured
      ? "API key configured. No live provider probe is performed: a paid generation request is not a health check."
      : "OPENROUTER_API_KEY is not configured.",
    latencyMs: null,
    measured: false,
  });

  // ── 5. Payments ───────────────────────────────────────────────────────────
  const paymentConfigured =
    configured("RAZORPAY_KEY_ID") &&
    configured("RAZORPAY_KEY_SECRET") &&
    configured("RAZORPAY_WEBHOOK_SECRET");
  const paymentPartial =
    configured("RAZORPAY_KEY_ID") || configured("RAZORPAY_KEY_SECRET");

  services.push({
    id: "payments",
    label: "Payment Gateway (Razorpay)",
    description: "Order creation and webhook verification.",
    state: paymentConfigured ? "unknown" : paymentPartial ? "degraded" : "not_configured",
    detail: paymentConfigured
      ? "Credentials configured. No live gateway probe is performed: a real order is not a health check."
      : paymentPartial
        ? "Only part of the Razorpay configuration is present, so payments will fail closed."
        : "Razorpay is not configured.",
    latencyMs: null,
    measured: false,
  });

  // ── 6. Managed database provisioning ──────────────────────────────────────
  const neonConfigured = configured("NEON_API_KEY");
  services.push({
    id: "managed_backends",
    label: "Managed Database Provisioning (Neon)",
    description: "Per-project Postgres provisioning for generated apps.",
    state: neonConfigured ? "unknown" : "not_configured",
    detail: neonConfigured
      ? "Neon credentials configured. Provisioning is not exercised by a health check."
      : "Managed backends are not configured on this deployment.",
    latencyMs: null,
    measured: false,
  });

  // ── 7. Runtime sandbox ────────────────────────────────────────────────────
  const sandboxConfigured = configured("E2B_API_KEY");
  services.push({
    id: "runtime_sandbox",
    label: "Preview Runtime Sandbox (E2B)",
    description: "Isolated React + Vite dev preview for generated projects.",
    state: sandboxConfigured ? "unknown" : "not_configured",
    detail: sandboxConfigured
      ? "Sandbox credentials configured. No sandbox is created by a health check."
      : "The live preview runtime is not configured; the static preview is unaffected.",
    latencyMs: null,
    measured: false,
  });

  // ── 8. Hosting ────────────────────────────────────────────────────────────
  const hostingMode = (process.env.MAVLY_HOSTING_MODE ?? "").trim().toLowerCase() || null;
  services.push({
    id: "hosting",
    label: "Project Hosting",
    description: "Where published generated projects are served from.",
    state: hostingMode === "shared" ? "unknown" : "not_configured",
    detail:
      hostingMode === "shared"
        ? "Shared tenant hosting is enabled. Wildcard DNS and TLS are operator prerequisites and are not verified here."
        : "No hosting mode is enabled on this deployment.",
    latencyMs: null,
    measured: false,
  });

  const payload: AdminHealthPayload = {
    measuredAt,
    environment: environmentName(),
    version:
      typeof (packageJson as unknown as { version?: unknown }).version === "string" &&
      String((packageJson as unknown as { version: string }).version).trim() !== ""
        ? String((packageJson as unknown as { version: string }).version)
        : null,
    services,
    snapshot: snapshot
      ? {
          queued: num(snapshot.queued),
          running: num(snapshot.running),
          staleLeases: num(snapshot.staleLeases),
          oldestQueuedAt: snapshot.oldestQueuedAt ?? null,
          lastHeartbeatAt: snapshot.lastHeartbeatAt ?? null,
          lastCompletedAt: snapshot.lastCompletedAt ?? null,
          lastFailureAt: snapshot.lastFailureAt ?? null,
          runsLast24h: num(snapshot.runsLast24h),
          failuresLast24h: num(snapshot.failuresLast24h),
        }
      : null,
    /** ⚠️ Always null. No historical availability is recorded anywhere. */
    uptimePercent: null,
  };

  /**
   * The page still renders when the snapshot failed: the database row says
   * `down` and the rest of the rows are honest about what they could not check.
   * A 503 here would hide the one diagnostic the operator needs.
   */
  if (!snapshot && snapshotError) {
    return adminJson({ ok: true, data: payload, warning: snapshotError });
  }

  return adminJson({ ok: true, data: payload });
}
