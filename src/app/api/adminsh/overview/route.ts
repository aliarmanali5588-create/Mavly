import type { NextRequest } from "next/server";

import packageJson from "../../../../../package.json";
import { adminError, adminJson, requireAdmin, withTimeout } from "@/lib/admin/http";
import { parseAdminPeriod, queueHealthStatus, successRate } from "@/lib/admin/overview";
import type {
  AdminAiModelRow,
  AdminHealthCheckRow,
  AdminOverviewPayload,
  AdminOverviewQueue,
} from "@/lib/admin/types";
import { OPENROUTER_MODEL_CATALOG } from "@/lib/ai/models";
import { generationWorkerConfig } from "@/lib/generation/worker-config";

export const dynamic = "force-dynamic";

/**
 * Shape returned by `public.admin_overview` (migration 28). The database owns the
 * cross-user aggregates; this route only adds measured health, configuration
 * presence and catalog labels. It never invents a metric.
 */
interface RpcModelUsage {
  model: string;
  runs: number;
  completed: number;
  failed: number;
  tokens: number;
  costUsd: number | string;
  costKnownRuns: number;
}

interface RpcOverview {
  period: string;
  generatedAt: string;
  window: AdminOverviewPayload["window"];
  users: AdminOverviewPayload["users"];
  projects: AdminOverviewPayload["projects"];
  runs: Omit<AdminOverviewPayload["runs"], "previousSuccessRate">;
  usage: { tokens: number | string; costUsd: number | string; costKnownRuns: number };
  models: RpcModelUsage[];
  queue: AdminOverviewQueue;
  billing: { configured: false };
}

const WORKER_ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function flagEnabled(name: string): boolean {
  const value = (process.env[name] ?? "").trim().toLowerCase();
  return WORKER_ENABLED_VALUES.has(value);
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  const period = parseAdminPeriod(request.nextUrl.searchParams.get("period"));
  const measuredAt = new Date().toISOString();
  const startedMs = Date.now();

  let rpcData: RpcOverview | null;
  try {
    const { data, error } = await withTimeout(
      auth.supabase.rpc("admin_overview", { p_period: period }),
      8_000
    );
    if (error) {
      return adminError(
        503,
        "OVERVIEW_UNAVAILABLE",
        "The admin overview aggregate is not available. Apply supabase/migrations/28_admin_overview.sql."
      );
    }
    rpcData = (data as RpcOverview | null) ?? null;
  } catch {
    return adminError(504, "OVERVIEW_TIMEOUT", "The admin overview aggregate timed out.");
  }

  if (!rpcData) {
    return adminError(503, "OVERVIEW_UNAVAILABLE", "The admin overview returned no data.");
  }

  const databaseLatencyMs = Date.now() - startedMs;
  const runs = rpcData.runs;
  const previousSuccessRate = successRate(
    runs.previousCompleted,
    runs.previousFailed,
    runs.previousCancelled,
    runs.previousInterrupted
  );

  const totalRequests = num(runs.total);
  const rows: RpcModelUsage[] = Array.isArray(rpcData.models) ? rpcData.models : [];
  const models: AdminAiModelRow[] = rows.map((row) => {
    const requests = num(row.runs);
    const catalogEntry = OPENROUTER_MODEL_CATALOG.find((entry) => entry.id === row.model);
    return {
      model: row.model,
      label: catalogEntry?.label ?? row.model,
      provider: catalogEntry?.provider ?? "openrouter",
      requests,
      completed: num(row.completed),
      failed: num(row.failed),
      tokens: num(row.tokens),
      costUsd: num(row.costUsd),
      costKnownRuns: num(row.costKnownRuns),
      sharePercent: totalRequests > 0 ? Math.round((requests / totalRequests) * 1000) / 10 : 0,
      successRate: successRate(num(row.completed), num(row.failed)),
      active: Boolean(catalogEntry),
    };
  });

  const usage = rpcData.usage ?? { tokens: 0, costUsd: 0, costKnownRuns: 0 };
  const ai = {
    totalRequests,
    completed: num(runs.completed),
    failed: num(runs.failed),
    successRate: successRate(
      num(runs.completed),
      num(runs.failed),
      num(runs.cancelled),
      num(runs.interrupted)
    ),
    tokens: num(usage.tokens),
    costUsd: num(usage.costUsd),
    costKnownRuns: num(usage.costKnownRuns),
    models,
    providers: Array.from(new Set(models.map((row) => row.provider))),
  };

  const queue = rpcData.queue ?? {
    queued: 0,
    running: 0,
    staleLeases: 0,
    oldestQueuedAt: null,
  };
  const queueStatus = queueHealthStatus(queue);
  const workerConfigured = generationWorkerConfig().ready;
  const queueDetail = `${num(queue.queued)} queued · ${num(queue.running)} running · ${num(
    queue.staleLeases
  )} stale lease(s)`;

  const providerConfigured = Boolean((process.env.OPENROUTER_API_KEY ?? "").trim());
  const domainConfigured =
    (process.env.MAVLY_HOSTING_MODE ?? "").trim().toLowerCase() === "shared" ||
    flagEnabled("MAVLY_VERCEL_DEPLOYMENTS_ENABLED");
  const storageConfigured =
    flagEnabled("MAVLY_ANDROID_BUILD_ENABLED") &&
    Boolean((process.env.MAVLY_ANDROID_ARTIFACT_BUCKET ?? "").trim());

  const health: AdminHealthCheckRow[] = [
    {
      id: "app_server",
      label: "Application Server",
      description: "This Next.js server rendering and answering the admin request.",
      state: "operational",
      detail: "Responding to this request",
      latencyMs: null,
    },
    {
      id: "database",
      label: "Primary Database",
      description: "Supabase Postgres read used by the Overview aggregate.",
      state: "operational",
      detail: "Admin aggregate query completed",
      latencyMs: databaseLatencyMs,
    },
    {
      id: "worker_queue",
      label: "Generation Worker Queue",
      description: "Durable generation runs, leases and backlog.",
      state:
        queueStatus === "degraded"
          ? "degraded"
          : workerConfigured
            ? "unknown"
            : "not_configured",
      detail: workerConfigured
        ? `${queueDetail} · check Cloudflare Worker logs for scheduler heartbeat and outcomes`
        : `${queueDetail} · server-side worker credentials are not configured`,
      latencyMs: null,
    },
    {
      id: "ai_provider",
      label: "OpenRouter & Model APIs",
      description: "Server-only text and image generation provider.",
      state: providerConfigured ? "unknown" : "not_configured",
      detail: providerConfigured
        ? "API key configured; no live provider probe is performed"
        : "OPENROUTER_API_KEY is not configured",
      latencyMs: null,
    },
    {
      id: "domain",
      label: "Domain & DNS Resolver",
      description: "Mavly hostname mapping for published projects.",
      state: domainConfigured ? "unknown" : "not_configured",
      detail: domainConfigured
        ? "Hosting path enabled; DNS/certificate checks are not measured here"
        : "No Mavly hosting or domain path is enabled",
      latencyMs: null,
    },
    {
      id: "storage",
      label: "Background Storage",
      description: "Private Supabase Storage for build artifacts.",
      state: storageConfigured ? "unknown" : "not_configured",
      detail: storageConfigured
        ? "Artifact bucket configured; storage is not probed here"
        : "Android artifact storage is not enabled",
      latencyMs: null,
    },
  ];

  const data: AdminOverviewPayload = {
    period,
    generatedAt: typeof rpcData.generatedAt === "string" ? rpcData.generatedAt : measuredAt,
    window: rpcData.window,
    users: {
      total: num(rpcData.users?.total),
      new: num(rpcData.users?.new),
      previousNew: num(rpcData.users?.previousNew),
    },
    projects: {
      total: num(rpcData.projects?.total),
      new: num(rpcData.projects?.new),
    },
    runs: {
      total: num(runs.total),
      completed: num(runs.completed),
      failed: num(runs.failed),
      cancelled: num(runs.cancelled),
      interrupted: num(runs.interrupted),
      active: num(runs.active),
      successRate: runs.successRate === null ? null : num(runs.successRate),
      previousCompleted: num(runs.previousCompleted),
      previousFailed: num(runs.previousFailed),
      previousCancelled: num(runs.previousCancelled),
      previousInterrupted: num(runs.previousInterrupted),
      previousSuccessRate,
    },
    ai,
    queue: {
      queued: num(queue.queued),
      running: num(queue.running),
      staleLeases: num(queue.staleLeases),
      oldestQueuedAt: queue.oldestQueuedAt ?? null,
    },
    billing: { configured: false },
    health,
    environment: (process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown").trim() || "unknown",
    version:
      typeof (packageJson as unknown as { version?: unknown }).version === "string"
        ? String((packageJson as unknown as { version: string }).version)
        : null,
  };

  return adminJson({ ok: true, data });
}
