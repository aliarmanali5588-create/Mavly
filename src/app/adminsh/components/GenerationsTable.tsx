"use client";

import React from "react";
import Link from "next/link";
import {
  ArrowRight,
  Clock,
  RefreshCw,
  Search,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";

import { formatDuration, generationStatusLabel } from "@/lib/admin/overview";
import type { AdminGenerationFilter, AdminGenerationRow } from "@/lib/admin/types";
import { useAdminGenerations, useDebouncedValue } from "./useAdminLiveData";

const PAGE_SIZE = 10;

const FILTERS: ReadonlyArray<{ id: Exclude<AdminGenerationFilter, "queued">; label: string }> = [
  { id: "all", label: "All" },
  { id: "completed", label: "Completed" },
  { id: "running", label: "Running" },
  { id: "failed", label: "Failed" },
];

const timestampFormat = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "—";
  return timestampFormat.format(new Date(parsed));
}

function StatusBadge({ status }: { status: AdminGenerationRow["status"] }) {
  const styles: Record<AdminGenerationRow["status"], string> = {
    completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
    running: "bg-[var(--clay-sunken)] text-foreground border-[var(--clay-line)]",
    queued: "bg-amber-50 text-amber-700 border-amber-200",
    failed: "bg-red-50 text-red-700 border-red-200",
    cancelled: "bg-[var(--clay-sunken)] text-muted-foreground border-[var(--clay-line)]",
    interrupted: "bg-[var(--clay-sunken)] text-muted-foreground border-[var(--clay-line)]",
  };
  const dots: Record<AdminGenerationRow["status"], string> = {
    completed: "bg-emerald-500",
    running: "bg-[var(--clay-sunken)]0 animate-pulse",
    queued: "bg-amber-500",
    failed: "bg-red-500",
    cancelled: "bg-muted-foreground",
    interrupted: "bg-muted-foreground",
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${styles[status]}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dots[status]}`} />
      {generationStatusLabel(status)}
    </span>
  );
}

/**
 * Live generation stream. Search, status filtering and pagination run in SQL
 * (`admin_generation_stream`); nothing is filtered from a fully fetched table.
 * There is no admin-authorized retry endpoint in this repository, so no retry
 * control is rendered rather than faking one.
 */
export function GenerationsTable() {
  const [searchInput, setSearchInput] = React.useState("");
  const search = useDebouncedValue(searchInput.trim(), 350);
  const [status, setStatus] = React.useState<Exclude<AdminGenerationFilter, "queued">>("all");
  const [page, setPage] = React.useState(0);
  const [selected, setSelected] = React.useState<AdminGenerationRow | null>(null);
  // `Date.now()` during SSR would differ from the client render; running-job
  // durations are therefore shown only after mount. Finished jobs use persisted
  // timestamps and are deterministic.
  const [now, setNow] = React.useState<number | null>(null);

  React.useEffect(() => {
    setPage(0);
  }, [search, status]);

  React.useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const { data, loading, error, refresh } = useAdminGenerations({
    status,
    search,
    page,
    pageSize: PAGE_SIZE,
  });

  // Bounded polling only while the tab is visible; the interval is cleared on
  // unmount and never stacks because `refresh` is stable.
  React.useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const start = total === 0 ? 0 : (data?.offset ?? 0) + 1;
  const end = Math.min((data?.offset ?? 0) + rows.length, total);

  const durationFor = (run: AdminGenerationRow): string =>
    run.finishedAt
      ? formatDuration(run.startedAt, run.finishedAt)
      : now === null
        ? "—"
        : formatDuration(run.startedAt, null, now);

  return (
    <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)] space-y-4">
      {/* ── Table Header Controls ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[var(--clay-line)]">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-[var(--clay-sunken)] text-foreground border border-[var(--clay-line)]">
              <Sparkles className="w-4 h-4" />
            </div>
            <h2 className="text-base font-bold text-foreground">Generation Operations Stream</h2>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Durable generation runs across all projects · live records
          </p>
        </div>

        <div className="flex items-center gap-3 self-start sm:self-auto">
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-black disabled:opacity-40"
            title="Refresh run list"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
            <span>Refresh</span>
          </button>
          <Link
            href="/adminsh/generation-monitor"
            className="text-xs font-bold text-black hover:underline inline-flex items-center gap-1"
          >
            <span>Open Full Monitor</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      {/* ── Filter & Search Toolbar ── */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by project, owner, or model..."
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            className="w-full h-8 pl-8 pr-3 text-xs rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] focus:bg-card focus:outline-none focus:ring-2 focus:ring-black text-foreground placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex items-center gap-1 bg-[var(--clay-sunken)] p-1 rounded-xl border border-[var(--clay-line)] text-xs">
          {FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => setStatus(filter.id)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all cursor-pointer ${
                status === filter.id
                  ? "bg-card text-black shadow-xs font-bold"
                  : "text-muted-foreground hover:text-black"
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── High-Density Data Table ── */}
      <div className="overflow-x-auto rounded-xl border border-[var(--clay-line)]">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="bg-[var(--clay-sunken)]/60 border-b border-[var(--clay-line)] text-muted-foreground font-bold uppercase tracking-wider text-[10px]">
              <th className="py-2.5 px-4">Project</th>
              <th className="py-2.5 px-4">Owner</th>
              <th className="py-2.5 px-4">Model Engine</th>
              <th className="py-2.5 px-4">Status</th>
              <th className="py-2.5 px-4 font-mono">Duration</th>
              <th className="py-2.5 px-4">Started</th>
              <th className="py-2.5 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/[0.04]">
            {error ? (
              <tr>
                <td colSpan={7} className="py-8 text-center">
                  <p className="text-xs font-semibold text-foreground">The generation stream is unavailable</p>
                  <p className="text-[11px] text-muted-foreground mt-1">{error}</p>
                  <button
                    type="button"
                    onClick={refresh}
                    className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-foreground hover:text-black"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Try again
                  </button>
                </td>
              </tr>
            ) : loading && rows.length === 0 ? (
              Array.from({ length: 4 }).map((_, index) => (
                <tr key={index} className="animate-pulse">
                  {Array.from({ length: 7 }).map((__, cell) => (
                    <td key={cell} className="py-3 px-4">
                      <div className="h-3 rounded bg-[var(--clay-sunken)]" />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-muted-foreground">
                  No generation records match the current search and status filter.
                </td>
              </tr>
            ) : (
              rows.map((run) => (
                <tr key={run.id} className="hover:bg-[var(--clay-sunken)]/60 transition-colors">
                  <td className="py-2.5 px-4 max-w-[200px]">
                    <p className="font-bold text-foreground truncate" title={run.projectLabel ?? run.projectId}>
                      {run.projectLabel ?? run.projectId}
                    </p>
                    <p className="text-[10px] text-muted-foreground font-mono truncate">{run.projectId}</p>
                  </td>
                  <td className="py-2.5 px-4 text-muted-foreground max-w-[160px]">
                    <p className="truncate">{run.ownerName}</p>
                    {run.ownerEmail ? (
                      <p className="text-[10px] text-muted-foreground truncate">{run.ownerEmail}</p>
                    ) : null}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-[11px] text-foreground max-w-[180px] truncate">
                    {run.model}
                  </td>
                  <td className="py-2.5 px-4">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="py-2.5 px-4 font-mono text-muted-foreground">
                    {durationFor(run)}
                  </td>
                  <td className="py-2.5 px-4 text-muted-foreground whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {now === null ? "—" : formatTimestamp(run.startedAt)}
                    </span>
                  </td>
                  <td className="py-2.5 px-4 text-right">
                    <button
                      type="button"
                      onClick={() => setSelected(run)}
                      className="px-2 py-1 rounded-lg text-[11px] font-semibold text-foreground bg-[var(--clay-sunken)] hover:bg-[var(--clay-sunken-deep)] transition-colors"
                    >
                      Inspect
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ── */}
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{loading ? "Loading…" : total === 0 ? "No records" : `${start}–${end} of ${total}`}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            disabled={page === 0 || loading}
            className="px-2.5 py-1 rounded-lg border border-[var(--clay-line)] font-semibold text-foreground hover:bg-[var(--clay-sunken)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() => setPage((current) => current + 1)}
            disabled={loading || end >= total}
            className="px-2.5 py-1 rounded-lg border border-[var(--clay-line)] font-semibold text-foreground hover:bg-[var(--clay-sunken)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      </div>

      {/* ── Inspection Modal (metadata only) ── */}
      {selected ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-lg bg-card rounded-2xl border border-[var(--clay-line)] shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--clay-line)]">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-foreground truncate">
                  {selected.projectLabel ?? selected.projectId}
                </h3>
                <p className="text-xs text-muted-foreground font-mono truncate">Run ID: {selected.id}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="p-1 text-muted-foreground hover:text-black rounded-lg hover:bg-black/5"
                aria-label="Close inspection"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2.5 text-xs bg-[var(--clay-sunken)] p-4 rounded-xl border border-[var(--clay-line)]">
              <Detail label="Status" value={<StatusBadge status={selected.status} />} />
              <Detail label="Stage" value={<span className="font-mono">{selected.stage}</span>} />
              <Detail label="Owner" value={selected.ownerName} />
              {selected.ownerEmail ? <Detail label="Owner email" value={selected.ownerEmail} /> : null}
              <Detail label="Project" value={<span className="font-mono">{selected.projectId}</span>} />
              <Detail label="Model" value={<span className="font-mono">{selected.model}</span>} />
              <Detail
                label="Duration"
                value={<span className="font-mono">{durationFor(selected)}</span>}
              />
              <Detail label="Started" value={formatTimestamp(selected.startedAt)} />
              <Detail label="Finished" value={formatTimestamp(selected.finishedAt)} />
              <Detail
                label="Attempts"
                value={selected.attempts === null ? "—" : String(selected.attempts)}
              />
              <Detail
                label="Tokens"
                value={selected.tokens === null ? "Not recorded" : selected.tokens.toLocaleString("en-IN")}
              />
              {selected.errorCode ? (
                <Detail label="Error code" value={<span className="font-mono">{selected.errorCode}</span>} />
              ) : null}
            </div>

            <p className="text-[10px] text-muted-foreground flex items-start gap-1.5">
              <Terminal className="w-3 h-3 mt-0.5 shrink-0" />
              <span>
                Metadata only. Prompt text and generated files stay with the project owner. No admin
                retry endpoint exists in this build, so retry is not offered here.
              </span>
            </p>

            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="mavly-btn-secondary px-4 py-2 text-xs font-semibold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{label}:</span>
      <span className="font-semibold text-foreground text-right min-w-0 break-words">{value}</span>
    </div>
  );
}
