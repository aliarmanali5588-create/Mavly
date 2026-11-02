import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  adminPeriodWindow,
  csvEscapeCell,
  displayStatusForStage,
  formatDuration,
  generationStatusLabel,
  isAdminPeriod,
  parseAdminPeriod,
  percentChange,
  queueHealthStatus,
  successRate,
  toCsv,
} from "../src/lib/admin/overview";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const migration = read("supabase/migrations/28_admin_overview.sql");
const overviewRoute = read("src/app/api/adminsh/overview/route.ts");
const generationsRoute = read("src/app/api/adminsh/generations/route.ts");
const dashboardPage = read("src/app/adminsh/dashboard/page.tsx");
const generationsTable = read("src/app/adminsh/components/GenerationsTable.tsx");
const transactionsTable = read("src/app/adminsh/components/TransactionsTable.tsx");
const platformHealth = read("src/app/adminsh/components/PlatformHealth.tsx");
const quickActions = read("src/app/adminsh/components/QuickActionsModal.tsx");
const adminHeader = read("src/app/adminsh/components/AdminHeader.tsx");
const adminShell = read("src/app/adminsh/components/AdminShell.tsx");

// ───────────────────────────── periods ──────────────────────────────────────

test("period parsing accepts only the four documented windows and defaults to 30d", () => {
  assert.equal(isAdminPeriod("7d"), true);
  assert.equal(isAdminPeriod("30d"), true);
  assert.equal(isAdminPeriod("3m"), true);
  assert.equal(isAdminPeriod("ytd"), true);
  assert.equal(isAdminPeriod("*"), false);
  assert.equal(parseAdminPeriod("7D"), "7d");
  assert.equal(parseAdminPeriod(null), "30d");
  assert.equal(parseAdminPeriod("all"), "30d");
});

test("each period has an inclusive start, exclusive end and a comparable previous window", () => {
  const now = new Date("2026-10-28T12:00:00.000Z");

  const week = adminPeriodWindow("7d", now);
  assert.equal(week.start.toISOString(), "2026-10-21T18:30:00.000Z");
  assert.equal(week.end.toISOString(), now.toISOString());
  assert.equal(week.previousEnd.toISOString(), week.start.toISOString());
  assert.equal(week.previousStart.toISOString(), "2026-10-14T18:30:00.000Z");

  const month = adminPeriodWindow("30d", now);
  assert.equal(month.start.toISOString(), "2026-09-28T18:30:00.000Z");
  assert.equal(month.previousStart.toISOString(), "2026-08-29T18:30:00.000Z");

  const quarter = adminPeriodWindow("3m", now);
  assert.equal(quarter.start.toISOString(), "2026-07-31T18:30:00.000Z");

  const ytd = adminPeriodWindow("ytd", now);
  assert.equal(ytd.start.toISOString(), "2025-12-31T18:30:00.000Z");
  assert.ok(ytd.previousStart.getTime() < ytd.start.getTime());
});

// ───────────────────────────── rates ────────────────────────────────────────

test("success rate excludes in-progress runs and never divides by zero", () => {
  assert.equal(successRate(0, 0, 0), null);
  assert.equal(successRate(0, 1), 0);
  assert.equal(successRate(1, 1), 50);
  assert.equal(successRate(2, 1), 66.7);
  // cancelled and interrupted runs are terminal and count against the rate
  assert.equal(successRate(1, 0, 1), 50);
  assert.equal(successRate(3, 0, 0, 1), 75);
});

test("percent change is unavailable without a positive comparable base", () => {
  assert.equal(percentChange(5, 0), null);
  assert.equal(percentChange(0, 0), null);
  assert.equal(percentChange(4, 2), 100);
  assert.equal(percentChange(2, 4), -50);
});

// ───────────────────────────── run display ──────────────────────────────────

test("run stages map to the four Overview statuses without calling a queued job running", () => {
  assert.equal(displayStatusForStage("queued"), "queued");
  assert.equal(displayStatusForStage("validating"), "running");
  assert.equal(displayStatusForStage("generating"), "running");
  assert.equal(displayStatusForStage("retrying"), "running");
  assert.equal(displayStatusForStage("retry_wait"), "running");
  assert.equal(displayStatusForStage("completed"), "completed");
  assert.equal(displayStatusForStage("failed"), "failed");
  assert.equal(displayStatusForStage("cancelled"), "cancelled");
  assert.equal(displayStatusForStage("interrupted"), "interrupted");
  assert.equal(displayStatusForStage(null), "running");

  assert.equal(generationStatusLabel("queued"), "Queued");
  assert.equal(generationStatusLabel("cancelled"), "Cancelled");
  assert.equal(generationStatusLabel("interrupted"), "Interrupted");
});

test("duration uses persisted timestamps and the current time only for in-flight runs", () => {
  const started = "2026-10-28T10:00:00.000Z";
  const finished = "2026-10-28T10:01:30.000Z";
  assert.equal(formatDuration(started, finished), "1m 30s");
  assert.equal(formatDuration(started, "2026-10-28T10:00:30.000Z"), "30s");
  assert.equal(formatDuration(started, "2026-10-28T12:00:00.000Z"), "2h");
  assert.equal(formatDuration(null, finished), "—");
  assert.equal(formatDuration("not-a-date", finished), "—");
  assert.equal(
    formatDuration(started, null, Date.parse("2026-10-28T10:00:45.000Z")),
    "45s"
  );
});

test("queue health uses stale leases and backlog age, never a fabricated uptime", () => {
  const now = Date.parse("2026-10-28T12:00:00.000Z");
  assert.equal(
    queueHealthStatus({ queued: 0, running: 0, staleLeases: 0, oldestQueuedAt: null }, now),
    "operational"
  );
  assert.equal(
    queueHealthStatus({ queued: 2, running: 1, staleLeases: 0, oldestQueuedAt: "2026-10-28T11:55:00.000Z" }, now),
    "operational"
  );
  assert.equal(
    queueHealthStatus({ queued: 2, running: 1, staleLeases: 1, oldestQueuedAt: null }, now),
    "degraded"
  );
  assert.equal(
    queueHealthStatus({ queued: 2, running: 0, staleLeases: 0, oldestQueuedAt: "2026-10-28T11:20:00.000Z" }, now),
    "degraded"
  );
});

// ───────────────────────────── CSV ──────────────────────────────────────────

test("CSV cells neutralise formula injection and escape delimiters", () => {
  assert.equal(csvEscapeCell("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(csvEscapeCell("+1"), "'+1");
  assert.equal(csvEscapeCell("-2"), "'-2");
  assert.equal(csvEscapeCell("@cmd"), "'@cmd");
  assert.equal(csvEscapeCell("\tdata"), "'\tdata");
  assert.equal(csvEscapeCell("plain"), "plain");
  assert.equal(csvEscapeCell('a,b'), '"a,b"');
  assert.equal(csvEscapeCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscapeCell(null), "");
  assert.equal(toCsv([["a", "b"], ["1", "2"]]), "a,b\n1,2");
});

// ───────────────────────────── migration contract ───────────────────────────

test("migration 28 adds admin-only read functions with a fixed search_path", () => {
  assert.match(migration, /create or replace function public\.admin_overview\(p_period text/);
  assert.match(migration, /create or replace function public\.admin_generation_stream\(/);
  assert.match(migration, /security definer/g);
  assert.match(migration, /set search_path = ''/g);
  assert.match(migration, /public\.current_user_is_admin\(\)/g);
  assert.match(migration, /raise exception 'admin_overview: not authorized' using errcode = '42501'/);
  assert.match(
    migration,
    /raise exception 'admin_generation_stream: not authorized' using errcode = '42501'/
  );
  assert.match(migration, /revoke all on function public\.admin_overview\(text\) from anon;/);
  assert.match(migration, /grant execute on function public\.admin_overview\(text\) to authenticated;/);
  assert.match(
    migration,
    /revoke all on function public\.admin_generation_stream\(text, text, integer, integer\) from anon;/
  );
  assert.doesNotMatch(migration, /create policy/i);
});

test("migration 28 adds indexes but never fabricates or rewrites data", () => {
  assert.match(migration, /create index if not exists project_runs_started_at_idx/);
  assert.match(migration, /on public\.project_runs \(stage, started_at desc\)/);
  assert.match(migration, /on public\.projects \(created_at desc\)/);
  assert.doesNotMatch(migration, /insert into/i);
  assert.doesNotMatch(migration, /update public\./i);
  assert.doesNotMatch(migration, /delete from/i);
  assert.doesNotMatch(migration, /truncate/i);
  assert.match(migration, /'costUsd'/);
  assert.match(migration, /cost_known/);
  assert.match(migration, /'interrupted', count\(\*\) filter \(where stage = 'interrupted'\)/);
  assert.match(migration, /previousInterrupted/);
});

// ───────────────────────────── route contracts ──────────────────────────────

test("both admin routes authorize before reading and never use a service-role client", () => {
  for (const route of [overviewRoute, generationsRoute]) {
    const authIndex = route.indexOf("await requireAdmin()");
    assert.ok(authIndex > 0, "route must call requireAdmin");
    assert.match(route, /if \(!auth\.ok\) return auth\.response;/);
    assert.match(route, /auth\.supabase\.rpc\(/);
    assert.doesNotMatch(route, /SERVICE_ROLE|service_role|createClient\(/);
  }

  const guardIndex = overviewRoute.indexOf("await requireAdmin()");
  const rpcIndex = overviewRoute.indexOf('rpc("admin_overview"');
  assert.ok(guardIndex < rpcIndex, "authorization must precede the aggregate");
});

test("overview route maps only real aggregates and explicit health states", () => {
  assert.match(overviewRoute, /parseAdminPeriod\(/);
  assert.match(overviewRoute, /queueHealthStatus\(queue\)/);
  assert.match(overviewRoute, /state: providerConfigured \? "unknown" : "not_configured"/);
  assert.match(overviewRoute, /state: domainConfigured \? "unknown" : "not_configured"/);
  assert.match(overviewRoute, /state: storageConfigured \? "unknown" : "not_configured"/);
  assert.match(overviewRoute, /billing: \{ configured: false \}/);
  assert.doesNotMatch(overviewRoute, /MOCK|hardcoded|fake/i);
});

test("generation stream route bounds pagination and validates the status filter", () => {
  assert.match(generationsRoute, /boundedInteger\(params\.get\("limit"\), 10, 1, 50\)/);
  assert.match(generationsRoute, /boundedInteger\(params\.get\("offset"\), 0, 0, 100_000\)/);
  assert.match(generationsRoute, /slice\(0, 120\)/);
  assert.match(generationsRoute, /rpc\("admin_generation_stream"/);
});

// ───────────────────────────── UI contracts ────────────────────────────────

test("Overview renders only live sections and never imports mock dashboard data", () => {
  assert.match(dashboardPage, /useAdminOverview\(period\)/);
  assert.match(dashboardPage, /<RevenueChart live data=\{data\} error=\{Boolean\(error\)\} \/>/);
  assert.match(dashboardPage, /<AiUsageSection live data=\{data\} error=\{Boolean\(error\)\} \/>/);
  assert.match(dashboardPage, /<PlatformHealth live data=\{data\} error=\{Boolean\(error\)\} \/>/);
  assert.match(
    dashboardPage,
    /<QuickActionsModal data=\{data\} error=\{Boolean\(error\)\} \/>/
  );
  assert.doesNotMatch(dashboardPage, /mockData/);
});

test("generation stream is server-filtered, debounced, paginated and offers no fake retry", () => {
  assert.match(generationsTable, /useAdminGenerations\(/);
  assert.match(generationsTable, /useDebouncedValue\(searchInput\.trim\(\), 350\)/);
  assert.match(generationsTable, /interval[\s\S]*?30_000/);
  assert.match(generationsTable, /document\.visibilityState === "visible"/);
  assert.match(generationsTable, /setPage\(0\)/);
  assert.match(generationsTable, /disabled=\{loading \|\| end >= total\}/);
  assert.doesNotMatch(generationsTable, /MOCK_GENERATIONS|handleRerun|RotateCcw/);
  assert.match(generationsTable, /No admin\s+retry endpoint exists/);
});

test("billing table reports the missing source instead of demo transactions", () => {
  assert.doesNotMatch(transactionsTable, /MOCK_TRANSACTIONS|TXN-|INV-2026/);
  assert.match(transactionsTable, /No Mavly billing records exist in this deployment/);
  assert.match(transactionsTable, /disabled/);
  assert.match(transactionsTable, /\/adminsh\/billing/);
});

test("health cards never claim uptime and never assume every service is healthy", () => {
  assert.match(platformHealth, /Uptime:/);
  assert.match(platformHealth, /Not measured/);
  assert.match(platformHealth, /not_configured/);
  assert.match(platformHealth, /Health checks are unavailable/);
});

test("live chrome replaces the simulated status, environment and footer claims", () => {
  assert.match(adminHeader, /live \? statusSummary : "99\.98% Operational"/);
  assert.match(adminHeader, /Notifications are unavailable/);
  assert.match(adminHeader, /live \? environment : "PRODUCTION"/);
  assert.match(adminShell, /Release \{version \?\? "not set"\}/);
  assert.match(adminShell, /p99: not measured/);
  assert.doesNotMatch(adminShell, /version \?\? "2\.4\.0"/);
});

test("shortcuts link to real existing admin routes and never broadcast from the card", () => {
  for (const href of [
    "/adminsh/announcements",
    "/adminsh/users",
    "/adminsh/generation-monitor",
    "/adminsh/billing",
  ]) {
    assert.ok(quickActions.includes(`href="${href}"`), `${href} must be linked`);
  }
  assert.doesNotMatch(quickActions, /toast\.success|fetch\(|Broadcast Notice|handlePostAnnouncement/);
  assert.match(quickActions, /No Mavly billing source configured/);
});
