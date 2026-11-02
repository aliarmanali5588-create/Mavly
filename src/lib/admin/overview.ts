/**
 * Pure helpers behind the admin Overview.
 *
 * No React, no fetch, no environment access: the API route validates with these,
 * the components format with these, and `tests/admin-overview.test.ts` pins the
 * edges (period windows, zero denominators, CSV injection).
 */

export const ADMIN_PERIODS = [
  { id: "7d", label: "7D", description: "Last 7 days" },
  { id: "30d", label: "30D", description: "Last 30 days" },
  { id: "3m", label: "3M", description: "Previous 3 calendar months" },
  { id: "ytd", label: "YTD", description: "Year to date" },
] as const;

export type AdminPeriod = (typeof ADMIN_PERIODS)[number]["id"];

export function isAdminPeriod(value: unknown): value is AdminPeriod {
  return typeof value === "string" && ADMIN_PERIODS.some((period) => period.id === value);
}

/** Human-readable window name for a resolved period id. */
export function adminPeriodLabel(period: AdminPeriod): string {
  return ADMIN_PERIODS.find((entry) => entry.id === period)?.description ?? "Last 30 days";
}

/** An absent or unrecognised period falls back to 30 days, never to YTD. */
export function parseAdminPeriod(value: string | null | undefined): AdminPeriod {
  const normalized = (value ?? "").trim().toLowerCase();
  return isAdminPeriod(normalized) ? normalized : "30d";
}

export interface AdminPeriodWindow {
  /** Inclusive start, at midnight in the reporting timezone (Asia/Kolkata). */
  start: Date;
  /** Exclusive end (the current instant). */
  end: Date;
  /** The equally long window immediately before `start`. */
  previousStart: Date;
  previousEnd: Date;
}

const DAY_MS = 86_400_000;

const REPORTING_TIMEZONE_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Return the instant representing midnight for an India calendar date.
 * Asia/Kolkata has no daylight-saving transitions, so its fixed +05:30 offset
 * is safe for these reporting boundaries and keeps this pure helper aligned
 * with the database RPC without depending on the browser's local timezone.
 */
function indiaMidnight(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day) - REPORTING_TIMEZONE_OFFSET_MS);
}

function indiaDateParts(now: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month") - 1, day: value("day") };
}

export function adminPeriodWindow(period: AdminPeriod, now: Date = new Date()): AdminPeriodWindow {
  const end = new Date(now.getTime());
  const { year, month, day } = indiaDateParts(end);
  const indiaToday = indiaMidnight(year, month, day);
  let start: Date;
  switch (period) {
    case "7d":
      start = new Date(indiaToday.getTime() - 6 * DAY_MS);
      break;
    case "3m":
      start = indiaMidnight(year, month - 2, 1);
      break;
    case "ytd":
      start = indiaMidnight(year, 0, 1);
      break;
    case "30d":
    default:
      start = new Date(indiaToday.getTime() - 29 * DAY_MS);
      break;
  }
  const span = end.getTime() - start.getTime();
  return {
    start,
    end,
    previousStart: new Date(start.getTime() - span),
    previousEnd: new Date(start.getTime()),
  };
}

/**
 * Completed ÷ terminal jobs, as a percentage with one decimal.
 *
 * Terminal = completed + failed + cancelled + interrupted. Queued/running jobs
 * are excluded because they have no outcome yet. `null` (not 0) when no job is
 * terminal, so the UI can say "no completed jobs" instead of a fabricated 0%.
 */
export function successRate(
  completed: number,
  failed: number,
  cancelled = 0,
  interrupted = 0
): number | null {
  const terminal = completed + failed + cancelled + interrupted;
  if (!Number.isFinite(terminal) || terminal <= 0) return null;
  return Math.round((completed / terminal) * 1000) / 10;
}

/** Percentage change vs a comparable previous window; `null` when there is no base. */
export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export type GenerationDisplayStatus =
  | "completed"
  | "running"
  | "queued"
  | "failed"
  | "cancelled"
  | "interrupted";

/** Map the durable run stage to the statuses the Overview filters expose. */
export function displayStatusForStage(stage: string | null | undefined): GenerationDisplayStatus {
  switch (stage) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "queued":
      return "queued";
    default:
      return "running";
  }
}

export function generationStatusLabel(status: GenerationDisplayStatus): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "running":
      return "Running";
    case "queued":
      return "Queued";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
  }
}

/** Elapsed time between two instants; a running job passes `now`. */
export function formatDuration(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
  now: number = Date.now()
): string {
  if (!startedAt) return "—";
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return "—";
  const end = finishedAt ? Date.parse(finishedAt) : now;
  if (!Number.isFinite(end) || end < start) return "—";
  const totalSeconds = Math.round((end - start) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export type QueueHealthStatus = "operational" | "degraded" | "unknown";

/**
 * Queue health from observable backlog only.
 *
 * Degraded when a running job's heartbeat is stale, or the oldest queued job has
 * waited more than 30 minutes. A non-empty but healthy queue is operational.
 */
export function queueHealthStatus(
  input: { queued: number; running: number; staleLeases: number; oldestQueuedAt: string | null },
  now: number = Date.now()
): QueueHealthStatus {
  if (!Number.isFinite(input.queued) || !Number.isFinite(input.running)) return "unknown";
  if (input.staleLeases > 0) return "degraded";
  if (input.queued > 0 && input.oldestQueuedAt) {
    const oldest = Date.parse(input.oldestQueuedAt);
    if (Number.isFinite(oldest) && now - oldest > 30 * 60_000) return "degraded";
  }
  return "operational";
}

// ─────────────────────────────── CSV ────────────────────────────────────────

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

export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  return rows.map((row) => row.map(csvEscapeCell).join(",")).join("\n");
}
