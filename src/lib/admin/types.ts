import type { AdminPeriod } from "./overview";

/**
 * Client-safe types for the admin Overview API.
 *
 * These mirror `admin_overview` / `admin_generation_stream` after the route has
 * added measured health and configuration context. Nothing here is a mock: every
 * field is either a database aggregate, a measured probe result, server
 * configuration presence, or an explicit "unknown / not configured" marker.
 */

export type AdminHealthState =
  | "operational"
  | "degraded"
  | "down"
  | "unknown"
  | "not_configured";

export interface AdminHealthCheckRow {
  id: "app_server" | "database" | "worker_queue" | "ai_provider" | "domain" | "storage";
  label: string;
  description: string;
  state: AdminHealthState;
  /** Short factual context (counts, config presence). Never a secret or URL. */
  detail: string | null;
  latencyMs: number | null;
}

export interface AdminAiModelRow {
  /** Raw catalog id recorded on the run, e.g. `deepseek/deepseek-v4.1-flash`. */
  model: string;
  label: string;
  provider: string;
  requests: number;
  completed: number;
  failed: number;
  /** Sum of persisted `total_tokens`; 0 means nothing recorded, not "unknown". */
  tokens: number;
  /** Provider-reported cost in USD for runs where `cost_known` is true. */
  costUsd: number;
  costKnownRuns: number;
  /** Share of the period's runs, 0–100 with one decimal. */
  sharePercent: number;
  successRate: number | null;
  /** True when the id is in the server's model catalog (default or cohort). */
  active: boolean;
}

export interface AdminAiUsage {
  totalRequests: number;
  completed: number;
  failed: number;
  successRate: number | null;
  tokens: number;
  costUsd: number;
  costKnownRuns: number;
  models: AdminAiModelRow[];
  providers: string[];
}

export interface AdminOverviewQueue {
  queued: number;
  running: number;
  staleLeases: number;
  oldestQueuedAt: string | null;
}

export interface AdminOverviewPayload {
  period: AdminPeriod;
  generatedAt: string;
  window: {
    start: string;
    end: string;
    previousStart: string;
    previousEnd: string;
  };
  users: { total: number; new: number; previousNew: number };
  projects: { total: number; new: number };
  runs: {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    /** Runs closed by recovery without completing (terminal, not successful). */
    interrupted: number;
    active: number;
    successRate: number | null;
    previousCompleted: number;
    previousFailed: number;
    previousCancelled: number;
    previousInterrupted: number;
    previousSuccessRate: number | null;
  };
  ai: AdminAiUsage;
  queue: AdminOverviewQueue;
  /** There is no Mavly subscription/invoice table in this deployment. */
  billing: { configured: false };
  health: AdminHealthCheckRow[];
  environment: string;
  version: string | null;
}

/** The four statuses the Overview filter exposes; `all` and `queued` are query values. */
export type AdminGenerationFilter = "all" | "completed" | "running" | "queued" | "failed";

export interface AdminGenerationRow {
  id: string;
  projectId: string;
  projectLabel: string | null;
  ownerName: string;
  ownerEmail: string | null;
  model: string;
  stage: string;
  status: "completed" | "running" | "queued" | "failed" | "cancelled" | "interrupted";
  startedAt: string;
  finishedAt: string | null;
  tokens: number | null;
  attempts: number | null;
  errorCode: string | null;
}

export interface AdminGenerationPage {
  rows: AdminGenerationRow[];
  total: number;
  limit: number;
  offset: number;
  status: AdminGenerationFilter;
  search: string | null;
}

export interface AdminApiSuccess<T> {
  ok: true;
  data: T;
}

export interface AdminApiFailure {
  ok: false;
  code: string;
  error: string;
  data: null;
}
