"use client";

import React, { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  Clock,
  Cpu,
  IndianRupee,
  Gauge,
  RefreshCw,
  Search,
  XCircle,
} from "lucide-react";

import {
  ADMIN_CONSOLE_PERIODS,
  inrCostDisplay,
  formatCompactNumber,
  formatSeconds,
  terminalSuccessRate,
  type AdminAiUsageAttemptRow,
  type AdminConsolePeriod,
} from "@/lib/admin/console";
import { AdminShell } from "../components/AdminShell";
import {
  useAiUsage,
  useDebouncedValue,
} from "../components/useAdminConsoleData";
import {
  Badge,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  Pagination,
  SearchField,
  SectionCard,
  SegmentedFilter,
  StatCard,
  UnavailableNote,
  formatTimestamp,
} from "../components/console-ui";

/**
 * ═══ AI USAGE & COST ════════════════════════════════════════════════════════
 *
 * Two datasets, kept visually distinct because they answer different questions:
 *
 *   Runs     `project_runs` — one row per generation, with the tokens it used and
 *            the cost the provider reported for it. This is the only cost source.
 *   Attempts `ai_usage_attempts` — per-attempt metering written by the credit
 *            engine. Absent on a deployment that never enabled it, in which case
 *            the table says so instead of showing an empty result as "no usage".
 *
 * ⚠️ COST IS NEVER DERIVED FROM an unapproved price list. INR cost exists only
 * where an auditable provider conversion or operator rate card exists, and a
 * run with no recorded INR cost is counted as unknown — shown as "Cost
 * unavailable", never as ₹0.00.
 *
 * ⚠️ LATENCY IS RUN DURATION. The database records when a run started and
 * finished; it does not record per-request provider latency. The column is
 * labelled "run duration" so nobody reads it as something it is not.
 */

const ATTEMPT_PAGE_SIZE = 25;

export default function AiUsageAdminPage() {
  const [period, setPeriod] = useState<AdminConsolePeriod>("30d");
  const [modelFilter, setModelFilter] = useState("");
  const [attemptSearch, setAttemptSearch] = useState("");
  const [attemptPage, setAttemptPage] = useState(0);
  const debouncedAttemptSearch = useDebouncedValue(attemptSearch, 300);

  const { data, loading, error, refresh } = useAiUsage({ period, model: modelFilter });

  const summary = data?.summary ?? null;
  const models = data?.models ?? [];
  const attempts = data?.attempts ?? [];

  const cost = summary
    ? inrCostDisplay({
        actualPaise: summary.costInrPaise,
        estimatedPaise: summary.estimatedCostInrPaise,
        knownAttempts: summary.costKnownRuns,
        unknownAttempts: summary.costUnknownRuns,
      })
    : null;

  const successRate = summary
    ? terminalSuccessRate({
        completed: summary.completed,
        failed: summary.failed,
        cancelled: summary.cancelled,
      })
    : null;

  /**
   * The attempt search filters the page the server already returned. Attempt
   * rows are a bounded window, so this is a view filter over that window — the
   * UI says "in this page" rather than implying a global search.
   */
  const visibleAttempts = useMemo(() => {
    const needle = debouncedAttemptSearch.trim().toLowerCase();
    if (needle === "") return attempts;
    return attempts.filter((row) =>
      [row.model, row.provider, row.role ?? "", row.taskKey ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [attempts, debouncedAttemptSearch]);

  const attemptPageCount = Math.max(1, Math.ceil(visibleAttempts.length / ATTEMPT_PAGE_SIZE));
  const attemptSlice = visibleAttempts.slice(
    attemptPage * ATTEMPT_PAGE_SIZE,
    (attemptPage + 1) * ATTEMPT_PAGE_SIZE
  );

  const modelOptions = useMemo(
    () => [
      { id: "", label: "All models" },
      ...models.map((entry) => ({ id: entry.model, label: entry.model })),
    ],
    [models]
  );

  return (
    <AdminShell activeNav="AI Usage & Cost" live>
      {/* ── Period + model filters ────────────────────────────────────────── */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <SegmentedFilter
          options={ADMIN_CONSOLE_PERIODS.map((entry) => ({
            id: entry.id,
            label: entry.label,
          }))}
          value={period}
          onChange={(next) => setPeriod(next)}
        />
        <div className="flex items-center gap-2">
          <select
            value={modelFilter}
            onChange={(event) => setModelFilter(event.target.value)}
            className="h-8 px-2.5 text-xs rounded-lg bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-foreground focus:bg-card focus:outline-none focus:ring-1 focus:ring-black shadow-[var(--clay-well-1)] max-w-[240px]"
          >
            {modelOptions.map((option) => (
              <option key={option.id || "all"} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground bg-[var(--clay-sunken)] hover:bg-[var(--clay-sunken-deep)] border border-[var(--clay-line)] rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {data && (
        <p className="text-[11px] text-muted-foreground">
          Window: {formatTimestamp(data.window.start)} → {formatTimestamp(data.window.end)}.
          {modelFilter !== "" && ` Filtered to ${modelFilter}.`}
        </p>
      )}

      {error && !data && <ErrorBlock message={error} onRetry={refresh} />}

      {/* ── Summary cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <StatCard
          label="Generation runs"
          value={summary ? summary.requests.toLocaleString() : null}
          hint={
            summary
              ? `${summary.active} active · ${summary.cancelled} cancelled`
              : undefined
          }
          icon={<Activity className="w-3.5 h-3.5 text-muted-foreground" />}
          unavailable={!summary}
        />
        <StatCard
          label="Tokens"
          value={summary ? formatCompactNumber(summary.tokens) : null}
          hint={
            summary
              ? `${formatCompactNumber(summary.promptTokens)} in · ${formatCompactNumber(
                  summary.completionTokens
                )} out`
              : undefined
          }
          icon={<Cpu className="w-3.5 h-3.5 text-muted-foreground" />}
          unavailable={!summary}
        />
        <StatCard
           label="AI cost (INR)"
          value={cost ? cost.text : null}
          hint={
            summary
              ? summary.costKnownRuns > 0
                ? `${summary.costKnownRuns} run(s) with a recorded cost · ${summary.costUnknownRuns} without`
                : "No run in this window recorded a cost"
              : undefined
          }
           icon={<IndianRupee className="w-3.5 h-3.5 text-muted-foreground" />}
          tone={cost?.available ? "neutral" : "warning"}
          unavailable={!cost || !cost.available}
        />
        <StatCard
          label="Success rate"
          value={successRate === null ? null : `${successRate}%`}
          hint={
            summary
              ? `${summary.completed} completed · ${summary.failed} failed`
              : undefined
          }
          icon={<CheckCircle2 className="w-3.5 h-3.5 text-success" />}
          tone="positive"
          unavailable={successRate === null}
        />
      </div>

      {/* ── Cost honesty note ─────────────────────────────────────────────── */}
      {summary && summary.costUnknownRuns > 0 && (
        <UnavailableNote>
           {summary.costUnknownRuns.toLocaleString()} attempt(s) in this window have no
           authoritative INR cost. They are counted as unknown, not as ₹0.00.
        </UnavailableNote>
      )}

      {/* ── Per-model breakdown ───────────────────────────────────────────── */}
      <SectionCard
        title="Usage by model"
        description="Every row is a model that actually ran generations in this window."
      >
        {loading && !data ? (
          <LoadingBlock label="Reading usage" />
        ) : models.length === 0 ? (
          <EmptyBlock
            title="No generation runs in this window"
            detail="No model has run a generation in the selected period. That is an empty window, not an error."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[var(--clay-line)] text-muted-foreground font-semibold uppercase text-[10px]">
                  <th className="pb-3">Model</th>
                  <th className="pb-3 text-right">Runs</th>
                  <th className="pb-3 text-right">Completed</th>
                  <th className="pb-3 text-right">Failed</th>
                  <th className="pb-3 text-right">Tokens</th>
                  <th className="pb-3 text-right">Cost</th>
                  <th className="pb-3 text-right">Run duration p50</th>
                  <th className="pb-3 text-right">p95</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--clay-line)]">
                {models.map((row) => {
                  const rowCost = inrCostDisplay({
                    actualPaise: row.costInrPaise,
                    estimatedPaise: row.estimatedCostInrPaise,
                    knownAttempts: row.costKnownRuns,
                    unknownAttempts: row.costUnknownRuns,
                  });
                  return (
                    <tr key={row.model} className="hover:bg-[var(--clay-sunken)] transition-colors">
                      <td className="py-3 font-mono font-semibold text-foreground">{row.model}</td>
                      <td className="py-3 text-right font-mono">{row.requests.toLocaleString()}</td>
                      <td className="py-3 text-right font-mono text-success">
                        {row.completed.toLocaleString()}
                      </td>
                      <td className="py-3 text-right font-mono">
                        {row.failed > 0 ? (
                          <span className="text-warning-subtle-foreground">
                            {row.failed.toLocaleString()}
                          </span>
                        ) : (
                          "0"
                        )}
                      </td>
                      <td className="py-3 text-right font-mono text-muted-foreground">
                        {formatCompactNumber(row.tokens)}
                      </td>
                      <td
                        className={`py-3 text-right font-mono ${
                          rowCost.available ? "text-foreground" : "text-muted-foreground"
                        }`}
                      >
                        {rowCost.text}
                      </td>
                      <td className="py-3 text-right font-mono text-muted-foreground">
                        {formatSeconds(row.durationP50)}
                      </td>
                      <td className="py-3 text-right font-mono text-muted-foreground">
                        {formatSeconds(row.durationP95)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* ── Per-attempt metering ──────────────────────────────────────────── */}
      <SectionCard
        title="Provider attempts"
        description="Per-attempt token and cost metering written by the credit engine."
        actions={
          <SearchField
            value={attemptSearch}
            onChange={(value) => {
              setAttemptSearch(value);
              setAttemptPage(0);
            }}
            placeholder="Filter this page by model, provider, role…"
            className="w-full sm:w-64"
          />
        }
      >
        {!data ? (
          <LoadingBlock label="Reading attempts" />
        ) : !data.attemptsAvailable ? (
          <EmptyBlock
            title="Per-attempt metering is not installed"
            detail="The ai_usage_attempts table does not exist on this deployment, so there is no attempt-level data to show. The run-level figures above are unaffected."
          />
        ) : attempts.length === 0 ? (
          <EmptyBlock
            title="No attempt rows in this window"
            detail="The metering table exists but recorded no attempt in the selected period."
          />
        ) : (
          <div className="space-y-3">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[var(--clay-line)] text-muted-foreground font-semibold uppercase text-[10px]">
                    <th className="pb-3">Recorded</th>
                    <th className="pb-3">Model</th>
                    <th className="pb-3">Role</th>
                    <th className="pb-3 text-right">Attempt</th>
                    <th className="pb-3 text-right">Tokens in</th>
                    <th className="pb-3 text-right">Tokens out</th>
                    <th className="pb-3 text-right">Cost</th>
                    <th className="pb-3 text-center">Cost source</th>
                    <th className="pb-3 text-center">Usage</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--clay-line)]">
                  {attemptSlice.map((row) => (
                    <AttemptRow key={row.id} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={attemptPage}
              pageSize={ATTEMPT_PAGE_SIZE}
              total={visibleAttempts.length}
              onPageChange={setAttemptPage}
            />
            <p className="text-[11px] text-muted-foreground">
              Showing the most recent {attempts.length} attempt rows returned for this window.
            </p>
          </div>
        )}
      </SectionCard>

      {error && data && (
        <p className="text-[11px] text-warning-subtle-foreground">
          Showing the last successful read. The newest refresh failed: {error}
        </p>
      )}
    </AdminShell>
  );
}

function AttemptRow({ row }: { row: AdminAiUsageAttemptRow }) {
  /**
   * ⚠️ THREE DISTINCT COST STATES, NOT TWO. A provider-reported cost, a
   * rate-card estimate, and no cost at all are different claims; collapsing the
   * last two into "$0.00" is exactly the error this page exists to avoid.
   */
   const costText =
    row.actualCostInrPaise !== null && row.actualCostInrPaise !== undefined
      ? `₹${(row.actualCostInrPaise / 100).toFixed(2)}`
      : row.estimatedCostInrPaise !== null && row.estimatedCostInrPaise !== undefined
        ? `~₹${(row.estimatedCostInrPaise / 100).toFixed(2)}`
        : "unavailable";

  return (
    <tr className="hover:bg-[var(--clay-sunken)] transition-colors">
      <td className="py-3 text-muted-foreground whitespace-nowrap">
        {formatTimestamp(row.createdAt)}
      </td>
      <td className="py-3 font-mono font-semibold text-foreground">{row.model}</td>
      <td className="py-3 text-muted-foreground">{row.role ?? "—"}</td>
      <td className="py-3 text-right font-mono">{row.attemptIndex}</td>
      <td className="py-3 text-right font-mono text-muted-foreground">
        {row.promptTokens === null ? "—" : row.promptTokens.toLocaleString()}
      </td>
      <td className="py-3 text-right font-mono text-muted-foreground">
        {row.completionTokens === null ? "—" : row.completionTokens.toLocaleString()}
      </td>
      <td
        className={`py-3 text-right font-mono ${
          row.costSource === "unavailable" ? "text-muted-foreground" : "text-foreground"
        }`}
      >
        {costText}
      </td>
      <td className="py-3 text-center">
        <Badge
          tone={
            row.costSource === "provider_reported"
              ? "positive"
              : row.costSource === "rate_card"
                ? "warning"
                : "neutral"
          }
        >
          {row.costSource === "provider_reported"
            ? "provider"
            : row.costSource === "rate_card"
              ? "rate card"
              : "none"}
        </Badge>
      </td>
      <td className="py-3 text-center">
        <Badge tone={row.usageSource === "provider" ? "positive" : "neutral"}>
          {row.usageSource === "provider" ? "measured" : "unavailable"}
        </Badge>
      </td>
    </tr>
  );
}
