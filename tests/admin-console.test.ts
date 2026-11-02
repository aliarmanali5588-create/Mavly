import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  ADMIN_CONSOLE_PERIODS,
  ANNOUNCEMENT_KINDS,
  announcementKindLabel,
  announcementStatusLabel,
  auditSourceLabel,
  canCancelRun,
  canRetryRun,
  costDisplay,
  creditAmountLabel,
  creditOperationLabel,
  creditOperationTone,
  csvEscapeCell,
  formatAge,
  formatCompactNumber,
  formatSeconds,
  isAdminConsolePeriod,
  isAnnouncementLive,
  numberOrZero,
  nullableNumber,
  overallServiceState,
  parseAdminConsolePeriod,
  parseAdminGenerationFilter,
  parseCreditLedgerFilter,
  redactAuditMetadata,
  serviceStateLabel,
  settingValueAsString,
  terminalSuccessRate,
  toCsv,
  type AdminServiceCheck,
} from "../src/lib/admin/console";

/**
 * ═══ ADMIN CONSOLE CONTRACT TESTS ═══════════════════════════════════════════
 *
 * These pin the rules that make the seven sections honest. They are pure: no
 * database, no network, no React. What they protect is the difference between
 * "zero" and "unknown", between "published" and "live", and between a real
 * action and a button that only looks like one.
 */

// ─────────────────────────────── periods ────────────────────────────────────

test("console periods parse to a known value and default to 30d", () => {
  assert.equal(parseAdminConsolePeriod("7d"), "7d");
  assert.equal(parseAdminConsolePeriod("YTD"), "ytd");
  assert.equal(parseAdminConsolePeriod("nonsense"), "30d");
  assert.equal(parseAdminConsolePeriod(null), "30d");
  assert.equal(parseAdminConsolePeriod(""), "30d");
  assert.equal(isAdminConsolePeriod("3m"), true);
  assert.equal(isAdminConsolePeriod("1y"), false);
  assert.equal(ADMIN_CONSOLE_PERIODS.length, 4);
});

// ──────────────────────────── numbers and null ──────────────────────────────

test("a missing number stays null and never becomes zero", () => {
  assert.equal(nullableNumber(null), null);
  assert.equal(nullableNumber(undefined), null);
  assert.equal(nullableNumber("not a number"), null);
  assert.equal(nullableNumber("12.5"), 12.5);
  assert.equal(nullableNumber(0), 0);
  // numberOrZero is the explicit opt-in, and 0 is a real answer there.
  assert.equal(numberOrZero(null), 0);
  assert.equal(numberOrZero(0), 0);
});

// ─────────────────────────────── credits ────────────────────────────────────

test("ledger filters accept only real operations", () => {
  assert.equal(parseCreditLedgerFilter("all"), "all");
  assert.equal(parseCreditLedgerFilter("grant"), "grant");
  assert.equal(parseCreditLedgerFilter("GENERATION_CONSUMED"), "generation_consumed");
  assert.equal(parseCreditLedgerFilter("made_up"), "all");
  assert.equal(parseCreditLedgerFilter(null), "all");
});

test("a reservation renders no money movement", () => {
  // ⚠️ The whole point: a hold is not a charge.
  assert.equal(creditAmountLabel({ operation: "generation_reserved", amount: 0 }), "—");
  assert.equal(creditAmountLabel({ operation: "generation_released", amount: 0 }), "—");
  assert.equal(creditAmountLabel({ operation: "grant", amount: 500 }), "+500");
  assert.equal(creditAmountLabel({ operation: "generation_consumed", amount: -120 }), "-120");
  assert.equal(creditAmountLabel({ operation: "generation_refunded", amount: 120 }), "+120");
});

test("every ledger operation has a label and a tone", () => {
  const operations = [
    "grant",
    "admin_adjustment",
    "generation_reserved",
    "generation_consumed",
    "generation_released",
    "generation_refunded",
  ] as const;
  for (const operation of operations) {
    assert.ok(creditOperationLabel(operation).length > 0, operation);
    assert.ok(creditOperationTone(operation).length > 0, operation);
  }
  assert.equal(creditOperationTone("generation_consumed"), "negative");
  assert.equal(creditOperationTone("generation_reserved"), "neutral");
});

// ─────────────────────────────── AI cost ────────────────────────────────────

test("cost is unavailable, not zero, when nothing recorded one", () => {
  // ⚠️ This is the rule the AI Usage section exists for.
  const unknown = costDisplay({ costUsd: 0, costKnownRuns: 0, costUnknownRuns: 12 });
  assert.equal(unknown.text, "Cost unavailable");
  assert.equal(unknown.available, false);
  assert.equal(unknown.partial, false);
});

test("a genuinely zero cost with a known run is not 'unavailable'", () => {
  const zero = costDisplay({ costUsd: 0, costKnownRuns: 3, costUnknownRuns: 0 });
  assert.equal(zero.text, "$0.0000");
  assert.equal(zero.available, true);
  assert.equal(zero.partial, false);
});

test("a partially known cost is marked partial", () => {
  const partial = costDisplay({ costUsd: 1.2345, costKnownRuns: 4, costUnknownRuns: 6 });
  assert.equal(partial.text, "$1.2345 (partial)");
  assert.equal(partial.available, true);
  assert.equal(partial.partial, true);
});

test("success rate counts terminal runs only and is null when there are none", () => {
  assert.equal(terminalSuccessRate({ completed: 0, failed: 0, cancelled: 0 }), null);
  assert.equal(terminalSuccessRate({ completed: 9, failed: 1 }), 90);
  // A cancelled run is terminal but neither a success nor a failure.
  assert.equal(terminalSuccessRate({ completed: 1, failed: 1, cancelled: 2 }), 25);
});

test("duration and compact formatting never invent a value", () => {
  assert.equal(formatSeconds(null), "—");
  assert.equal(formatSeconds(undefined), "—");
  assert.equal(formatSeconds(-1), "—");
  assert.equal(formatSeconds(0.25), "250ms");
  assert.equal(formatSeconds(12.34), "12.3s");
  assert.equal(formatSeconds(125), "2m 5s");
  assert.equal(formatCompactNumber(null), "—");
  assert.equal(formatCompactNumber(999), "999");
  assert.equal(formatCompactNumber(1500), "1.5K");
  assert.equal(formatCompactNumber(2_500_000), "2.50M");
});

// ────────────────────────── generation monitor ──────────────────────────────

test("generation filters accept only real statuses", () => {
  assert.equal(parseAdminGenerationFilter("cancelled"), "cancelled");
  assert.equal(parseAdminGenerationFilter("RUNNING"), "running");
  assert.equal(parseAdminGenerationFilter("bogus"), "all");
  assert.equal(parseAdminGenerationFilter(null), "all");
});

test("a finished run is never offered as cancellable", () => {
  // ⚠️ Offering cancel on a finished run is the fake-button failure.
  assert.equal(canCancelRun({ finishedAt: "2026-01-01T00:00:00Z", cancellationRequestedAt: null }), false);
  assert.equal(canCancelRun({ finishedAt: null, cancellationRequestedAt: null }), true);
});

test("a run whose cancellation is pending is not offered again", () => {
  assert.equal(
    canCancelRun({ finishedAt: null, cancellationRequestedAt: "2026-01-01T00:00:00Z" }),
    false
  );
});

test("only a terminal failed or interrupted run is retryable", () => {
  assert.equal(canRetryRun({ finishedAt: "2026-01-01T00:00:00Z", stage: "failed" }), true);
  assert.equal(canRetryRun({ finishedAt: "2026-01-01T00:00:00Z", stage: "interrupted" }), true);
  assert.equal(canRetryRun({ finishedAt: "2026-01-01T00:00:00Z", stage: "completed" }), false);
  assert.equal(canRetryRun({ finishedAt: "2026-01-01T00:00:00Z", stage: "cancelled" }), false);
  assert.equal(canRetryRun({ finishedAt: null, stage: "failed" }), false);
});

// ───────────────────────────── system health ────────────────────────────────

function service(state: AdminServiceCheck["state"]): AdminServiceCheck {
  return {
    id: state,
    label: state,
    description: "",
    state,
    detail: null,
    latencyMs: null,
    measured: true,
  };
}

test("overall state escalates to the worst real problem", () => {
  assert.equal(overallServiceState([service("operational"), service("operational")]), "operational");
  assert.equal(overallServiceState([service("operational"), service("degraded")]), "degraded");
  assert.equal(overallServiceState([service("degraded"), service("down")]), "down");
  assert.equal(overallServiceState([service("operational"), service("unknown")]), "unknown");
  assert.equal(overallServiceState([]), "unknown");
  assert.equal(overallServiceState([service("not_configured")]), "not_configured");
});

test("a configured-but-unprobed dependency is unknown, not operational", () => {
  // ⚠️ The rule that keeps a health page from lying about what it checked.
  assert.equal(serviceStateLabel("unknown"), "Unknown");
  assert.equal(serviceStateLabel("not_configured"), "Not configured");
  assert.equal(serviceStateLabel("operational"), "Operational");
  assert.equal(serviceStateLabel("degraded"), "Degraded");
  assert.equal(serviceStateLabel("down"), "Down");
});

test("age formatting says 'never' rather than guessing", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  assert.equal(formatAge(null, now), "never");
  assert.equal(formatAge("not a date", now), "never");
  assert.equal(formatAge("2026-11-02T11:59:30Z", now), "30s ago");
  assert.equal(formatAge("2026-11-02T11:30:00Z", now), "30m ago");
  assert.equal(formatAge("2026-11-02T09:00:00Z", now), "3h ago");
  assert.equal(formatAge("2026-10-30T12:00:00Z", now), "3d ago");
});

// ───────────────────────────── announcements ────────────────────────────────

test("published is not the same as live", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  // Published, no window: live.
  assert.equal(isAnnouncementLive({ status: "published", startsAt: null, expiresAt: null }, now), true);
  // Published but the window has not opened.
  assert.equal(
    isAnnouncementLive(
      { status: "published", startsAt: "2026-11-05T00:00:00Z", expiresAt: null },
      now
    ),
    false
  );
  // Published but the window has closed.
  assert.equal(
    isAnnouncementLive(
      { status: "published", startsAt: null, expiresAt: "2026-11-01T00:00:00Z" },
      now
    ),
    false
  );
  // A draft is never live, whatever its window says.
  assert.equal(isAnnouncementLive({ status: "draft", startsAt: null, expiresAt: null }, now), false);
  assert.equal(
    isAnnouncementLive({ status: "archived", startsAt: null, expiresAt: null }, now),
    false
  );
});

test("every announcement kind and status has a label", () => {
  for (const kind of ANNOUNCEMENT_KINDS) {
    assert.ok(announcementKindLabel(kind).length > 0, kind);
  }
  assert.equal(announcementStatusLabel("draft"), "Draft");
  assert.equal(announcementStatusLabel("published"), "Published");
  assert.equal(announcementStatusLabel("archived"), "Archived");
});

// ─────────────────────────────── audit log ──────────────────────────────────

test("audit metadata redacts secret-shaped keys", () => {
  const redacted = redactAuditMetadata({
    amount: 500,
    reason: "goodwill",
    apiKey: "sk-live-should-not-render",
    service_role_key: "nope",
    nested: { token: "also hidden by key name" },
  });
  assert.equal(redacted.amount, 500);
  assert.equal(redacted.reason, "goodwill");
  assert.equal(redacted.apiKey, "[redacted]");
  assert.equal(redacted.service_role_key, "[redacted]");
  // A nested object keeps its shape; the renderer only inspects top-level keys.
  assert.deepEqual(redacted.nested, { token: "also hidden by key name" });
});

test("audit metadata handles a missing or non-object value", () => {
  assert.deepEqual(redactAuditMetadata(null), {});
  assert.deepEqual(redactAuditMetadata(undefined), {});
});

test("every audit source has a label", () => {
  assert.equal(auditSourceLabel("console"), "Admin console");
  assert.equal(auditSourceLabel("account_restriction"), "Account access");
  assert.equal(auditSourceLabel("credit_ledger"), "Credit ledger");
});

// ──────────────────────────────── CSV ───────────────────────────────────────

test("CSV cells are escaped against formula injection", () => {
  // ⚠️ A ledger reason beginning with '=' must not execute in a spreadsheet.
  assert.equal(csvEscapeCell("=1+1"), "'=1+1");
  assert.equal(csvEscapeCell("+44 7700"), "'+44 7700");
  assert.equal(csvEscapeCell("-5"), "'-5");
  assert.equal(csvEscapeCell("@user"), "'@user");
  assert.equal(csvEscapeCell("plain"), "plain");
  assert.equal(csvEscapeCell(null), "");
});

test("CSV cells with separators are quoted and inner quotes doubled", () => {
  assert.equal(csvEscapeCell('a,b'), '"a,b"');
  assert.equal(csvEscapeCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscapeCell("line\nbreak"), '"line\nbreak"');
});

test("toCsv joins rows with newlines", () => {
  const csv = toCsv([
    ["a", "b"],
    [1, 2],
  ]);
  assert.equal(csv, "a,b\n1,2");
});

// ─────────────────────────────── settings ───────────────────────────────────

test("setting values render without inventing one", () => {
  const base = {
    key: "announcements.enabled",
    kind: "boolean" as const,
    editable: true,
    source: "database" as const,
    defaultValue: true,
    isDefault: false,
    description: "",
    updatedAt: null,
    updatedByEmail: null,
  };
  assert.equal(settingValueAsString({ ...base, value: true }), "true");
  assert.equal(settingValueAsString({ ...base, value: false }), "false");
  assert.equal(settingValueAsString({ ...base, value: 90 }), "90");
  assert.equal(settingValueAsString({ ...base, value: "Mavly" }), "Mavly");
  assert.equal(settingValueAsString({ ...base, value: null }), "");
});

// ─────────────────────── static migration invariants ────────────────────────

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/50_admin_console_backend.sql"),
  "utf8"
);

test("the migration is additive and never drops a customer table", () => {
  assert.ok(MIGRATION.includes("begin;"));
  assert.ok(MIGRATION.includes("commit;"));
  assert.equal(/drop\s+table/i.test(MIGRATION), false);
  assert.equal(/drop\s+column/i.test(MIGRATION), false);
  assert.equal(/truncate/i.test(MIGRATION), false);
  assert.equal(/delete\s+from\s+public\.credit_ledger/i.test(MIGRATION), false);
});

test("every admin function refuses a non-administrator", () => {
  /**
   * ⚠️ Every SECURITY DEFINER function that reads or writes admin data must
   * check the caller. A missing check is an authorization hole, so this counts
   * the guards rather than trusting a reading of the file.
   */
  const adminFunctions = MIGRATION.match(/create or replace function public\.admin_[a-z_]+/g) ?? [];
  const guards = MIGRATION.match(/if not public\.current_user_is_admin\(\) then/g) ?? [];
  assert.ok(adminFunctions.length > 0, "expected admin functions");

  /**
   * Three functions legitimately carry no caller check, and each is enumerated
   * rather than excused by a count:
   *   admin_console_schema_version  reports a constant, reads nothing
   *   admin_audit_log_reject_mutation  a trigger, runs as the writing session
   *   admin_settings_registry  a pure static table of key definitions
   * Everything else must refuse a non-administrator.
   */
  const UNGUARDED = [
    "admin_console_schema_version",
    "admin_audit_log_reject_mutation",
    "admin_settings_registry",
  ];
  assert.equal(guards.length, adminFunctions.length - UNGUARDED.length);

  for (const name of UNGUARDED) {
    const body = MIGRATION.slice(
      MIGRATION.indexOf(`create or replace function public.${name}`),
      MIGRATION.indexOf(`create or replace function public.${name}`) + 1200
    );
    // None of them may read a customer table.
    assert.equal(/from\s+public\.(projects|project_runs|credit_accounts|project_files)/.test(body), false, name);
  }
});

test("the credit adjustment writes the ledger, never a bare balance", () => {
  const fn = MIGRATION.slice(
    MIGRATION.indexOf("create or replace function public.admin_adjust_credits"),
    MIGRATION.indexOf("comment on function public.admin_adjust_credits")
  );
  // It must take the same per-user lock the credit engine uses.
  assert.ok(fn.includes("pg_advisory_xact_lock"));
  // It must lock the account row before moving the balance.
  assert.ok(fn.includes("lock_credit_account"));
  // It must write exactly one ledger row.
  assert.ok(fn.includes("insert into public.credit_ledger"));
  // It must refuse a debit that would eat a held reservation.
  assert.ok(fn.includes("INSUFFICIENT_CREDITS_FOR_ADJUSTMENT"));
  // It must be idempotent.
  assert.ok(fn.includes("idempotency"));
  // It must write an audit row.
  assert.ok(fn.includes("insert into public.admin_audit_log"));
});

test("the audit log is append-only at the trigger level", () => {
  assert.ok(MIGRATION.includes("admin_audit_log_append_only"));
  assert.ok(MIGRATION.includes("before update or delete on public.admin_audit_log"));
  assert.ok(MIGRATION.includes("ADMIN_AUDIT_LOG_APPEND_ONLY"));
});

test("a published announcement cannot be deleted in one step", () => {
  const fn = MIGRATION.slice(
    MIGRATION.indexOf("create or replace function public.admin_announcement_delete"),
    MIGRATION.indexOf("comment on function public.admin_announcement_delete")
  );
  assert.ok(fn.includes("ANNOUNCEMENT_PUBLISHED"));
});

test("the generation retry refuses a credit-enforced project", () => {
  const fn = MIGRATION.slice(
    MIGRATION.indexOf("create or replace function public.admin_retry_generation_run"),
    MIGRATION.indexOf("comment on function public.admin_retry_generation_run")
  );
  // ⚠️ Resuming a credit project spends the owner's credits; an admin must not.
  assert.ok(fn.includes("credit_project_policies"));
  assert.ok(fn.includes("credit_project"));
  // It must use the same advisory lock as the admission path.
  assert.ok(fn.includes("mavly:create_generation_job"));
});

test("settings writes are restricted to the registry", () => {
  const fn = MIGRATION.slice(
    MIGRATION.indexOf("create or replace function public.admin_settings_write"),
    MIGRATION.indexOf("comment on function public.admin_settings_write")
  );
  assert.ok(fn.includes("admin_settings_registry()"));
  assert.ok(fn.includes("UNKNOWN_SETTING"));
  assert.ok(fn.includes("SETTING_NOT_EDITABLE"));
});

test("the AI usage aggregate never invents a cost", () => {
  const fn = MIGRATION.slice(
    MIGRATION.indexOf("create or replace function public.admin_ai_usage"),
    MIGRATION.indexOf("comment on function public.admin_ai_usage")
  );
  // Cost is summed only where the run recorded one.
  assert.ok(fn.includes("filter (where cost_known)"));
  assert.ok(fn.includes("costUnknownRuns"));
  // No price arithmetic anywhere in this function.
  assert.equal(/reported_cost_usd\s*\*/.test(fn), false);
});

test("the health snapshot reports facts and no uptime", () => {
  const fn = MIGRATION.slice(
    MIGRATION.indexOf("create or replace function public.admin_health_snapshot"),
    MIGRATION.indexOf("comment on function public.admin_health_snapshot")
  );
  assert.ok(fn.includes("staleLeases"));
  assert.ok(fn.includes("lastHeartbeatAt"));
  assert.equal(/uptime/i.test(fn), false);
});
