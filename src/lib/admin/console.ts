/**
 * Client-safe types and pure helpers for the seven admin console sections.
 *
 * ⚠️ NOTHING IN THIS MODULE IS A MOCK. Every field mirrors a real column, a real
 * aggregate, or an explicit "unavailable / deployment-managed" marker produced by
 * a route. Where a value genuinely has no source it is `null`, never 0, and the
 * UI is required to render it as unavailable.
 *
 * No React, no fetch, no `process.env`: the routes validate with these and the
 * components format with these, so `tests/admin-console.test.ts` can pin the
 * edges (period windows, cost-unknown handling, CSV injection, status mapping).
 */

// ─────────────────────────────── shared ─────────────────────────────────────

export type AdminConsolePeriod = "7d" | "30d" | "3m" | "ytd";

export const ADMIN_CONSOLE_PERIODS = [
  { id: "7d", label: "7D", description: "Last 7 days" },
  { id: "30d", label: "30D", description: "Last 30 days" },
  { id: "3m", label: "3M", description: "Previous 3 calendar months" },
  { id: "ytd", label: "YTD", description: "Year to date" },
] as const;

export function isAdminConsolePeriod(value: unknown): value is AdminConsolePeriod {
  return (
    typeof value === "string" && ADMIN_CONSOLE_PERIODS.some((period) => period.id === value)
  );
}

export function parseAdminConsolePeriod(value: string | null | undefined): AdminConsolePeriod {
  const normalized = (value ?? "").trim().toLowerCase();
  return isAdminConsolePeriod(normalized) ? normalized : "30d";
}

/** A number the database did not report stays `null`; it never becomes 0. */
export function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function numberOrZero(value: unknown): number {
  return nullableNumber(value) ?? 0;
}

// ──────────────────────────────── credits ───────────────────────────────────

export type CreditLedgerOperation =
  | "grant"
  | "admin_adjustment"
  | "generation_reserved"
  | "generation_consumed"
  | "generation_released"
  | "generation_refunded"
  | "purchase"
  | "subscription_grant"
  | "refund";

export const CREDIT_LEDGER_OPERATIONS: readonly CreditLedgerOperation[] = [
  "grant",
  "admin_adjustment",
  "generation_reserved",
  "generation_consumed",
  "generation_released",
  "generation_refunded",
  "purchase",
  "subscription_grant",
  "refund",
];

export type CreditLedgerFilter = "all" | CreditLedgerOperation;

export function parseCreditLedgerFilter(value: string | null | undefined): CreditLedgerFilter {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "all" || normalized === "") return "all";
  return CREDIT_LEDGER_OPERATIONS.includes(normalized as CreditLedgerOperation)
    ? (normalized as CreditLedgerOperation)
    : "all";
}

export interface AdminCreditLedgerRow {
  id: string;
  userId: string;
  userName: string;
  userEmail: string | null;
  projectId: string | null;
  runId: string | null;
  operation: CreditLedgerOperation;
  /** Signed credit delta. A hold writes 0 and a reserved delta instead. */
  amount: number;
  reservedDelta: number;
  balanceAfter: number;
  reservedAfter: number;
  status: "applied" | "reversed";
  reason: string | null;
  createdAt: string;
}

export interface AdminCreditSummary {
  issued: number;
  purchased?: number;
  subscription?: number;
  operator?: number;
  consumed: number;
  refunded: number;
  outstanding: number;
  reserved: number;
  wallets: number;
  reversed: number;
  transactions: number;
}

export interface AdminCreditLedgerPage {
  rows: AdminCreditLedgerRow[];
  total: number;
  limit: number;
  offset: number;
  operation: CreditLedgerFilter;
  search: string | null;
  summary: AdminCreditSummary;
}

/**
 * How a ledger row reads to a human.
 *
 * ⚠️ A RESERVATION IS NOT A CHARGE. `generation_reserved` moves 0 credits and
 * only raises the hold, so it is labelled "Hold" and shown with an em dash
 * amount rather than a number that would look like a debit.
 */
export function creditOperationLabel(operation: CreditLedgerOperation): string {
  switch (operation) {
    case "grant":
      return "Grant";
    case "purchase":
      return "Purchased credits";
    case "subscription_grant":
      return "Subscription credits";
    case "admin_adjustment":
      return "Adjustment";
    case "generation_reserved":
      return "Hold";
    case "generation_consumed":
      return "Usage";
    case "generation_released":
      return "Hold released";
    case "generation_refunded":
      return "Refund";
    case "refund":
      return "Payment refund";
  }
}

export function creditOperationTone(
  operation: CreditLedgerOperation
): "positive" | "negative" | "neutral" | "warning" {
  switch (operation) {
    case "grant":
    case "generation_refunded":
    case "purchase":
    case "subscription_grant":
      return "positive";
    case "refund":
      return "negative";
    case "generation_consumed":
      return "negative";
    case "admin_adjustment":
      return "warning";
    case "generation_reserved":
    case "generation_released":
      return "neutral";
  }
}

/** The signed amount as displayed: holds and releases show no money movement. */
export function creditAmountLabel(row: {
  operation: CreditLedgerOperation;
  amount: number;
}): string {
  if (row.operation === "generation_reserved" || row.operation === "generation_released") {
    return "—";
  }
  if (row.amount > 0) return `+${row.amount.toLocaleString()}`;
  return row.amount.toLocaleString();
}

// ─────────────────────────────── AI usage ───────────────────────────────────

export interface AdminAiUsageModelRow {
  model: string;
  requests: number;
  completed: number;
  failed: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  /** Sum of provider-reported cost. Only meaningful with `costKnownRuns`. */
  costUsd: number | null;
  costInrPaise?: number | null;
  estimatedCostInrPaise?: number | null;
  costKnownRuns: number;
  costUnknownRuns: number;
  /** Run duration percentiles in seconds — NOT provider request latency. */
  durationP50: number | null;
  durationP95: number | null;
}

export interface AdminAiUsageAttemptRow {
  id: string;
  model: string;
  provider: string;
  role: string | null;
  taskKey: string | null;
  attemptIndex: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  usageSource: "provider" | "unavailable";
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
  actualCostInrPaise?: number | null;
  estimatedCostInrPaise?: number | null;
  inrCostSource?: string | null;
  costSource: "provider_reported" | "rate_card" | "unavailable";
  reconciliationStatus: "reconciled" | "unreconciled" | "uncertain" | "unavailable";
  uncertain: boolean;
  createdAt: string;
}

export interface AdminAiUsageSummary {
  requests: number;
  completed: number;
  failed: number;
  cancelled: number;
  active: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  costInrPaise?: number | null;
  estimatedCostInrPaise?: number | null;
  costKnownRuns: number;
  costUnknownRuns: number;
  durationP50: number | null;
  durationP95: number | null;
}

export interface AdminAiUsagePayload {
  period: AdminConsolePeriod;
  window: { start: string; end: string };
  summary: AdminAiUsageSummary;
  models: AdminAiUsageModelRow[];
  modelTotal: number;
  attempts: AdminAiUsageAttemptRow[];
  attemptsAvailable: boolean;
}

/**
 * Cost display that never conflates "zero" with "we don't know".
 *
 * ⚠️ THIS IS THE RULE THE SECTION EXISTS FOR. A run whose provider reported no
 * cost is not a $0.00 run. When nothing in scope has a known cost the answer is
 * "Cost unavailable", and when only some do the number is marked partial.
 */
export function costDisplay(input: {
  costUsd: number;
  costKnownRuns: number;
  costUnknownRuns?: number;
}): { text: string; available: boolean; partial: boolean } {
  const known = numberOrZero(input.costKnownRuns);
  const unknown = numberOrZero(input.costUnknownRuns);
  if (known <= 0) {
    return { text: "Cost unavailable", available: false, partial: false };
  }
  const amount = `$${numberOrZero(input.costUsd).toFixed(4)}`;
  if (unknown > 0) {
    return { text: `${amount} (partial)`, available: true, partial: true };
  }
  return { text: amount, available: true, partial: false };
}

export function inrCostDisplay(input: {
  actualPaise: number | null | undefined;
  estimatedPaise?: number | null;
  knownAttempts: number;
  unknownAttempts?: number;
}): { text: string; available: boolean; partial: boolean } {
  const known = numberOrZero(input.knownAttempts);
  const unknown = numberOrZero(input.unknownAttempts);
  if (known <= 0 || input.actualPaise === null || input.actualPaise === undefined) {
    if (input.estimatedPaise !== null && input.estimatedPaise !== undefined) {
      return {
        text: `~₹${(Number(input.estimatedPaise) / 100).toFixed(2)}`,
        available: true,
        partial: true,
      };
    }
    return { text: "Cost unavailable", available: false, partial: false };
  }
  return {
    text: `₹${(Number(input.actualPaise) / 100).toFixed(2)}${unknown > 0 ? " · partial" : ""}`,
    available: true,
    partial: unknown > 0,
  };
}

/** Success rate over terminal runs only; `null` when nothing is terminal. */
export function terminalSuccessRate(input: {
  completed: number;
  failed: number;
  cancelled?: number;
}): number | null {
  const terminal =
    numberOrZero(input.completed) + numberOrZero(input.failed) + numberOrZero(input.cancelled);
  if (terminal <= 0) return null;
  return Math.round((numberOrZero(input.completed) / terminal) * 1000) / 10;
}

export function formatSeconds(value: number | null | undefined): string {
  const seconds = nullableNumber(value);
  if (seconds === null || seconds < 0) return "—";
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export function formatCompactNumber(value: number | null | undefined): string {
  const parsed = nullableNumber(value);
  if (parsed === null) return "—";
  if (Math.abs(parsed) >= 1_000_000_000) return `${(parsed / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(parsed) >= 1_000_000) return `${(parsed / 1_000_000).toFixed(2)}M`;
  if (Math.abs(parsed) >= 1_000) return `${(parsed / 1_000).toFixed(1)}K`;
  return parsed.toLocaleString();
}

// ─────────────────────────── generation monitor ─────────────────────────────

export type AdminGenerationStatus =
  | "completed"
  | "running"
  | "queued"
  | "failed"
  | "cancelled"
  | "interrupted";

export type AdminGenerationFilter =
  | "all"
  | "completed"
  | "running"
  | "queued"
  | "failed"
  | "cancelled";

export const ADMIN_GENERATION_FILTERS: readonly AdminGenerationFilter[] = [
  "all",
  "running",
  "queued",
  "completed",
  "failed",
  "cancelled",
];

export function parseAdminGenerationFilter(
  value: string | null | undefined
): AdminGenerationFilter {
  const normalized = (value ?? "").trim().toLowerCase();
  return ADMIN_GENERATION_FILTERS.includes(normalized as AdminGenerationFilter)
    ? (normalized as AdminGenerationFilter)
    : "all";
}

export interface AdminGenerationSummary {
  queued: number;
  running: number;
  retryWait: number;
  completed: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  staleLeases: number;
  deadLettered: number;
  oldestQueuedAt: string | null;
  lastHeartbeatAt: string | null;
  lastCompletedAt: string | null;
  avgDurationSeconds: number | null;
}

export interface AdminGenerationDetail {
  id: string;
  projectId: string;
  projectLabel: string | null;
  ownerName: string;
  ownerEmail: string | null;
  status: string;
  stage: string;
  model: string;
  requestedModel: string | null;
  prompt: string;
  startedAt: string;
  finishedAt: string | null;
  heartbeatAt: string | null;
  lastProgressAt: string | null;
  enqueuedAt: string | null;
  dispatchedAt: string | null;
  nextAttemptAt: string | null;
  cancellationRequestedAt: string | null;
  deadLetteredAt: string | null;
  dispatchMode: string;
  workerId: string | null;
  traceId: string | null;
  attemptCount: number | null;
  jobAttempt: number | null;
  maxJobAttempts: number | null;
  checkpointCount: number | null;
  batchCount: number | null;
  filesWritten: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  finishReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  lastErrorClass: string | null;
  lastErrorSummary: string | null;
  reportedCostUsd: number | null;
  costKnown: boolean;
  leaseExpiresAt: string | null;
  providerAttempts: unknown[];
  durationSeconds: number | null;
  /** True only while the run has no `finished_at`. */
  cancellable: boolean;
  /** True only for a terminal failed/interrupted run. */
  retryable: boolean;
}

/**
 * Whether the console may offer "Cancel" for a run.
 *
 * ⚠️ A RUN THAT ALREADY FINISHED IS NOT CANCELLABLE, and a run whose
 * cancellation was already requested must not be offered again — the request is
 * persisted and the worker observes it at its next checkpoint, so a second
 * click would only produce a misleading "cancelled" toast.
 */
export function canCancelRun(detail: {
  finishedAt: string | null;
  cancellationRequestedAt: string | null;
}): boolean {
  return detail.finishedAt === null && detail.cancellationRequestedAt === null;
}

/** Whether the console may offer "Retry" for a run. */
export function canRetryRun(detail: {
  finishedAt: string | null;
  stage: string;
}): boolean {
  return detail.finishedAt !== null && (detail.stage === "failed" || detail.stage === "interrupted");
}

// ────────────────────────────── system health ───────────────────────────────

export type AdminServiceState =
  | "operational"
  | "degraded"
  | "down"
  | "unknown"
  | "not_configured";

export interface AdminServiceCheck {
  id: string;
  label: string;
  description: string;
  state: AdminServiceState;
  /** Factual context: counts, config presence, age. Never a secret or a URL. */
  detail: string | null;
  /** Measured latency in ms, or null when this check does not measure one. */
  latencyMs: number | null;
  /** True when a real measurement backs this row. False = configuration only. */
  measured: boolean;
}

export interface AdminHealthPayload {
  measuredAt: string;
  environment: string;
  version: string | null;
  services: AdminServiceCheck[];
  /** Present only when the database answered; null means the snapshot failed. */
  snapshot: {
    queued: number;
    running: number;
    staleLeases: number;
    oldestQueuedAt: string | null;
    lastHeartbeatAt: string | null;
    lastCompletedAt: string | null;
    lastFailureAt: string | null;
    runsLast24h: number;
    failuresLast24h: number;
  } | null;
  /**
   * ⚠️ ALWAYS NULL. Mavly records no historical availability, so there is no
   * uptime percentage to show. The field exists so the UI cannot quietly
   * substitute a made-up number.
   */
  uptimePercent: null;
}

export function serviceStateLabel(state: AdminServiceState): string {
  switch (state) {
    case "operational":
      return "Operational";
    case "degraded":
      return "Degraded";
    case "down":
      return "Down";
    case "unknown":
      return "Unknown";
    case "not_configured":
      return "Not configured";
  }
}

/** Aggregate banner state: any down wins, then degraded, then unknown. */
export function overallServiceState(services: AdminServiceCheck[]): AdminServiceState {
  if (services.some((service) => service.state === "down")) return "down";
  if (services.some((service) => service.state === "degraded")) return "degraded";
  if (services.length === 0) return "unknown";
  if (services.every((service) => service.state === "not_configured")) return "not_configured";
  if (services.some((service) => service.state === "unknown")) return "unknown";
  return "operational";
}

/** "3m ago" style age for a timestamp, or "never" when there is none. */
export function formatAge(
  timestamp: string | null | undefined,
  now: number = Date.now()
): string {
  if (!timestamp) return "never";
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return "never";
  const seconds = Math.max(0, Math.round((now - parsed) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ────────────────────────────── announcements ───────────────────────────────

export type AnnouncementKind = "information" | "success" | "warning" | "maintenance";
export type AnnouncementStatus = "draft" | "published" | "archived";

export const ANNOUNCEMENT_KINDS: readonly AnnouncementKind[] = [
  "information",
  "success",
  "warning",
  "maintenance",
];

export const ANNOUNCEMENT_STATUSES: readonly AnnouncementStatus[] = [
  "draft",
  "published",
  "archived",
];

export interface AdminAnnouncementRow {
  id: string;
  title: string;
  body: string;
  kind: AnnouncementKind;
  status: AnnouncementStatus;
  targetPlan: string;
  dismissible: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface AdminAnnouncementCounts {
  total: number;
  draft: number;
  published: number;
  archived: number;
  /** Published AND inside its visibility window right now. */
  live: number;
}

export interface AdminAnnouncementsPage {
  rows: AdminAnnouncementRow[];
  total: number;
  limit: number;
  offset: number;
  status: string;
  kind: string;
  search: string | null;
  counts: AdminAnnouncementCounts;
}

export function announcementKindLabel(kind: AnnouncementKind): string {
  switch (kind) {
    case "information":
      return "Information";
    case "success":
      return "Success";
    case "warning":
      return "Warning";
    case "maintenance":
      return "Maintenance";
  }
}

export function announcementStatusLabel(status: AnnouncementStatus): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "published":
      return "Published";
    case "archived":
      return "Archived";
  }
}

/**
 * Whether a published announcement is inside its window right now.
 *
 * ⚠️ "PUBLISHED" AND "LIVE" ARE DIFFERENT. A published row whose window has not
 * opened, or has closed, is not being served. The console shows both so an
 * operator never assumes a banner is visible when it is not.
 */
export function isAnnouncementLive(
  row: { status: AnnouncementStatus; startsAt: string | null; expiresAt: string | null },
  now: number = Date.now()
): boolean {
  if (row.status !== "published") return false;
  if (row.startsAt) {
    const start = Date.parse(row.startsAt);
    if (Number.isFinite(start) && start > now) return false;
  }
  if (row.expiresAt) {
    const end = Date.parse(row.expiresAt);
    if (Number.isFinite(end) && end <= now) return false;
  }
  return true;
}

// ──────────────────────────────── audit log ─────────────────────────────────

export type AuditSource = "console" | "account_restriction" | "credit_ledger";
export type AuditOutcome = "success" | "failure";

export interface AdminAuditRow {
  id: string;
  createdAt: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  outcome: AuditOutcome;
  source: AuditSource;
  metadata: Record<string, unknown>;
}

export interface AdminAuditCounts {
  total: number;
  success: number;
  failure: number;
  console: number;
  accountRestriction: number;
  creditLedger: number;
  distinctActors: number;
}

export interface AdminAuditPage {
  rows: AdminAuditRow[];
  total: number;
  limit: number;
  offset: number;
  outcome: string;
  source: string;
  search: string | null;
  retentionDays: number;
  counts: AdminAuditCounts;
}

export function auditSourceLabel(source: AuditSource): string {
  switch (source) {
    case "console":
      return "Admin console";
    case "account_restriction":
      return "Account access";
    case "credit_ledger":
      return "Credit ledger";
  }
}

/**
 * Metadata keys that must never be rendered, even if a row somehow carries one.
 *
 * ⚠️ DEFENCE IN DEPTH. The write paths do not store secrets, but an audit view is
 * exactly the place a leaked token would surface, so the renderer filters by key
 * name as well.
 */
const REDACTED_METADATA_KEYS = [
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "service_role",
  "private_key",
  "lease_token",
  "rpc_secret",
];

export function redactAuditMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object") return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (REDACTED_METADATA_KEYS.some((needle) => key.toLowerCase().includes(needle))) {
      output[key] = "[redacted]";
      continue;
    }
    output[key] = value;
  }
  return output;
}

// ───────────────────────────────── settings ─────────────────────────────────

export type AdminSettingKind = "boolean" | "integer" | "text";

export interface AdminSettingRow {
  key: string;
  kind: AdminSettingKind;
  editable: boolean;
  /** "database" = stored and editable; "deployment" = env-managed, read-only. */
  source: "database" | "deployment";
  value: unknown;
  defaultValue: unknown;
  isDefault: boolean;
  description: string;
  updatedAt: string | null;
  updatedByEmail: string | null;
}

export interface AdminSettingsPayload {
  settings: AdminSettingRow[];
  /** Deployment-managed facts, reported read-only with their real source. */
  deployment: {
    environment: string;
    version: string | null;
    defaultModel: string;
    modelCatalog: string[];
    workerConfigured: boolean;
    providerConfigured: boolean;
    paymentGateway: string | null;
    storageConfigured: boolean;
    hostingMode: string | null;
  };
}

/** A setting's value coerced for a form control, without inventing one. */
export function settingValueAsString(row: AdminSettingRow): string {
  if (row.value === null || row.value === undefined) return "";
  if (typeof row.value === "boolean") return row.value ? "true" : "false";
  return String(row.value);
}

// ─────────────────────────────────── CSV ────────────────────────────────────

/**
 * One CSV cell. Cells beginning with `=`, `+`, `-`, `@`, TAB or CR are prefixed
 * with a single quote so spreadsheet software treats them as text (CSV formula
 * injection), then quoted/escaped when needed.
 */
export function csvEscapeCell(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}

export function toCsv(
  rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>
): string {
  return rows.map((row) => row.map(csvEscapeCell).join(",")).join("\n");
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
