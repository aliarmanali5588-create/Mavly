"use client";

import React, { useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Download,
  FileText,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import { toast } from "sonner";

import {
  auditSourceLabel,
  redactAuditMetadata,
  type AdminAuditRow,
  type AuditSource,
} from "@/lib/admin/console";
import { AdminShell } from "../components/AdminShell";
import { useAuditLogs, useDebouncedValue } from "../components/useAdminConsoleData";
import {
  Badge,
  DetailRow,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  Modal,
  Pagination,
  SearchField,
  SecondaryButton,
  SectionCard,
  SegmentedFilter,
  StatCard,
  UnavailableNote,
  formatTimestamp,
} from "../components/console-ui";

/**
 * ═══ AUDIT LOGS ═════════════════════════════════════════════════════════════
 *
 * One trail, three real sources, assembled in the database:
 *
 *   console             admin_audit_log — every mutation made through this panel
 *   account_restriction account_restriction_events — the existing block trail
 *   credit_ledger       grant / admin_adjustment entries
 *
 * ⚠️ NOTHING IS BACKFILLED OR SYNTHESISED. The previous page listed invented
 * events with invented actors and IP addresses. Every row here exists in a table;
 * where a source recorded no actor, the actor reads "unknown" rather than being
 * filled in.
 *
 * ⚠️ THE TRAIL IS APPEND-ONLY. `admin_audit_log` refuses UPDATE and DELETE at the
 * trigger level, so a correction is a new compensating row and the history cannot
 * be quietly rewritten. The page has no edit or delete control because there is
 * no such operation.
 *
 * ⚠️ EXPORT IS BOUNDED AND REDACTED. It reads at most 1000 rows, escapes cells
 * against formula injection, and strips secret-shaped metadata keys server-side.
 */

const PAGE_SIZE = 50;

const SOURCE_TONE: Record<AuditSource, "neutral" | "positive" | "warning"> = {
  console: "neutral",
  account_restriction: "warning",
  credit_ledger: "positive",
};

export default function AuditLogsPage() {
  const [outcome, setOutcome] = useState("all");
  const [source, setSource] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const debouncedSearch = useDebouncedValue(search, 300);

  const { data, loading, error, refresh } = useAuditLogs({
    outcome,
    source,
    search: debouncedSearch,
    page,
    pageSize: PAGE_SIZE,
  });

  const [selected, setSelected] = useState<AdminAuditRow | null>(null);
  const [exporting, setExporting] = useState(false);

  const rows = data?.rows ?? [];
  const counts = data?.counts ?? null;

  const handleExport = async () => {
    setExporting(true);
    try {
      const query = new URLSearchParams({ outcome, source, q: debouncedSearch, format: "csv" });
      const response = await fetch(`/api/adminsh/audit-logs?${query.toString()}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error("The export could not be produced.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `mavly-audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      /**
       * The export is a second read of the same view, so a failure here is a
       * real failure and is reported as one. It is never silently swallowed and
       * never reported as a successful download.
       */
      toast.error("The audit export could not be produced.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <AdminShell activeNav="Audit Logs" live>
      {/* ── Counts ────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <StatCard
          label="Entries in window"
          value={counts ? counts.total.toLocaleString() : null}
          hint={data ? `Last ${data.retentionDays} days` : undefined}
          icon={<FileText className="w-3.5 h-3.5 text-muted-foreground" />}
          unavailable={!counts}
        />
        <StatCard
          label="Admin console actions"
          value={counts ? counts.console.toLocaleString() : null}
          hint="Mutations made through this panel"
          icon={<ShieldCheck className="w-3.5 h-3.5 text-muted-foreground" />}
          unavailable={!counts}
        />
        <StatCard
          label="Account access changes"
          value={counts ? counts.accountRestriction.toLocaleString() : null}
          hint="Blocks and unblocks"
          icon={<Activity className="w-3.5 h-3.5 text-muted-foreground" />}
          unavailable={!counts}
        />
        <StatCard
          label="Distinct actors"
          value={counts ? counts.distinctActors.toLocaleString() : null}
          hint="Administrators with a recorded identity"
          icon={<CheckCircle2 className="w-3.5 h-3.5 text-success" />}
          unavailable={!counts}
        />
      </div>

      <UnavailableNote>
        This trail covers administrative actions only: console mutations, account blocks, and credit
        grants. It is not a request log and does not record page views, sign-ins or customer activity.
        Entries are append-only — a correction is a new entry, never an edit.
      </UnavailableNote>

      {/* ── Trail ─────────────────────────────────────────────────────────── */}
      <SectionCard
        title="Audit trail"
        description="Newest first. Every row is a real database record."
        actions={
          <>
            <SecondaryButton
              icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />}
              onClick={refresh}
              disabled={loading}
            >
              Refresh
            </SecondaryButton>
            <SecondaryButton
              icon={<Download className="w-3.5 h-3.5" />}
              onClick={handleExport}
              disabled={exporting || rows.length === 0}
              title="Export up to 1000 rows of this view"
            >
              {exporting ? "Exporting…" : "CSV"}
            </SecondaryButton>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedFilter
                options={[
                  { id: "all", label: "All" },
                  { id: "success", label: "Success" },
                  { id: "failure", label: "Failure" },
                ]}
                value={outcome}
                onChange={(next) => {
                  setOutcome(next);
                  setPage(0);
                }}
              />
              <select
                value={source}
                onChange={(event) => {
                  setSource(event.target.value);
                  setPage(0);
                }}
                className="h-8 px-2.5 text-xs rounded-lg bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-foreground focus:bg-card focus:outline-none focus:ring-1 focus:ring-black shadow-[var(--clay-well-1)]"
              >
                <option value="all">All sources</option>
                <option value="console">Admin console</option>
                <option value="account_restriction">Account access</option>
                <option value="credit_ledger">Credit ledger</option>
              </select>
            </div>
            <SearchField
              value={search}
              onChange={(value) => {
                setSearch(value);
                setPage(0);
              }}
              placeholder="Search actor, action, target…"
            />
          </div>

          {loading && !data ? (
            <LoadingBlock label="Reading the audit trail" />
          ) : error && !data ? (
            <ErrorBlock message={error} onRetry={refresh} />
          ) : rows.length === 0 ? (
            <EmptyBlock
              title="No audit entries in this view"
              detail={
                outcome === "all" && source === "all" && debouncedSearch === ""
                  ? "No administrative action has been recorded in the retention window yet."
                  : "Try a different filter or clear the search."
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[var(--clay-line)] text-muted-foreground font-semibold uppercase text-[10px]">
                    <th className="pb-3">Recorded</th>
                    <th className="pb-3">Actor</th>
                    <th className="pb-3">Action</th>
                    <th className="pb-3">Target</th>
                    <th className="pb-3 text-center">Outcome</th>
                    <th className="pb-3 text-center">Source</th>
                    <th className="pb-3 text-right">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--clay-line)]">
                  {rows.map((row) => (
                    <tr key={`${row.source}-${row.id}`} className="hover:bg-[var(--clay-sunken)] transition-colors">
                      <td className="py-3 text-muted-foreground whitespace-nowrap">
                        {formatTimestamp(row.createdAt)}
                      </td>
                      <td className="py-3 truncate max-w-[180px]">
                        {row.actorEmail ?? (
                          <span className="text-muted-foreground italic">unknown</span>
                        )}
                      </td>
                      <td className="py-3 font-mono font-semibold text-foreground">{row.action}</td>
                      <td className="py-3 text-muted-foreground">
                        <span className="font-mono text-[10px] uppercase">{row.targetType}</span>
                        {row.targetId && (
                          <span className="block font-mono text-[10px] truncate max-w-[160px]">
                            {row.targetId}
                          </span>
                        )}
                      </td>
                      <td className="py-3 text-center">
                        <Badge
                          tone={row.outcome === "success" ? "positive" : "danger"}
                          icon={
                            row.outcome === "success" ? (
                              <CheckCircle2 className="w-3 h-3" />
                            ) : (
                              <XCircle className="w-3 h-3" />
                            )
                          }
                        >
                          {row.outcome}
                        </Badge>
                      </td>
                      <td className="py-3 text-center">
                        <Badge tone={SOURCE_TONE[row.source]}>
                          {auditSourceLabel(row.source)}
                        </Badge>
                      </td>
                      <td className="py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setSelected(row)}
                          className="px-2.5 py-1 text-[11px] font-medium text-foreground bg-[var(--clay-sunken)] hover:bg-[var(--clay-sunken-deep)] rounded-md transition-colors"
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data && (
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={data.total}
              onPageChange={setPage}
              loading={loading}
            />
          )}

          {error && data && (
            <p className="text-[11px] text-warning-subtle-foreground">
              Showing the last successful read. The newest refresh failed: {error}
            </p>
          )}
        </div>
      </SectionCard>

      {selected && <AuditDetailModal row={selected} onClose={() => setSelected(null)} />}
    </AdminShell>
  );
}

function AuditDetailModal({ row, onClose }: { row: AdminAuditRow; onClose: () => void }) {
  const metadata = redactAuditMetadata(row.metadata);
  const entries = Object.entries(metadata);

  return (
    <Modal
      title="Audit entry"
      icon={<FileText className="w-4 h-4 text-foreground" />}
      onClose={onClose}
    >
      <div className="space-y-2 bg-[var(--clay-sunken)] p-4 rounded-xl border border-[var(--clay-line)] text-xs shadow-[var(--clay-well-1)]">
        <DetailRow label="Recorded" value={formatTimestamp(row.createdAt)} />
        <DetailRow label="Action" value={row.action} mono />
        <DetailRow label="Actor" value={row.actorEmail ?? "unknown"} />
        <DetailRow label="Actor ID" value={row.actorUserId} mono wrap />
        <DetailRow label="Target type" value={row.targetType} />
        <DetailRow label="Target ID" value={row.targetId} mono wrap />
        <DetailRow label="Outcome" value={row.outcome} />
        <DetailRow label="Source" value={auditSourceLabel(row.source)} />
        <DetailRow label="Entry ID" value={row.id} mono wrap />
      </div>

      <div className="space-y-1.5">
        <p className="text-[11px] font-semibold text-foreground">Metadata</p>
        {entries.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            This entry recorded no additional metadata.
          </p>
        ) : (
          <div className="space-y-1 bg-[var(--clay-sunken)] p-3 rounded-xl border border-[var(--clay-line)] text-[11px]">
            {entries.map(([key, value]) => (
              <div key={key} className="flex justify-between gap-3 py-0.5">
                <span className="text-muted-foreground font-mono shrink-0">{key}</span>
                <span className="text-foreground font-mono text-right break-all">
                  {typeof value === "string" ? value : JSON.stringify(value)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {row.actorEmail === null && row.source === "credit_ledger" && (
        <UnavailableNote>
          The credit engine does not record which administrator applied a grant or adjustment on the
          ledger row itself. The actor for this action is recorded in the admin audit entry written
          alongside it, if it was applied from this console.
        </UnavailableNote>
      )}

      <div className="pt-2 flex justify-end border-t border-[var(--clay-line)]">
        <SecondaryButton onClick={onClose}>Close</SecondaryButton>
      </div>
    </Modal>
  );
}
