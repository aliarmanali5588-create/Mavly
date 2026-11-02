"use client";

import React, { useState } from "react";
import {
  Activity,
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Copy,
  Layers,
  RefreshCw,
  RotateCcw,
  Timer,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import {
  canCancelRun,
  canRetryRun,
  formatAge,
  formatSeconds,
  type AdminGenerationDetail,
  type AdminGenerationFilter,
} from "@/lib/admin/console";
import { AdminShell } from "../components/AdminShell";
import {
  useAdminMutation,
  useDebouncedValue,
  useGenerationDetail,
  useGenerationMonitor,
} from "../components/useAdminConsoleData";
import {
  Badge,
  DetailRow,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  Modal,
  Pagination,
  PrimaryButton,
  SearchField,
  SecondaryButton,
  SectionCard,
  SegmentedFilter,
  StatCard,
  UnavailableNote,
  formatTimestamp,
} from "../components/console-ui";

/**
 * ═══ GENERATION MONITOR ═════════════════════════════════════════════════════
 *
 * The table is `project_runs` — the same rows the durable worker claims, leases
 * and finishes. The counters are the database's own aggregates over those rows,
 * so the cards and the table describe one backlog, not two.
 *
 * ⚠️ THE TWO BUTTONS DO THE THING.
 *   Retry  → `admin_retry_generation_run`: the same reset the owner-initiated
 *            resume performs, under the same advisory lock. It refuses a
 *            credit-enforced project, because resuming one holds credits from
 *            the owner's balance and that is not an administrator's call.
 *   Cancel → the same terminal transition `agent/stop` performs, releasing the
 *            credit hold atomically for a worker run. It refuses a run that
 *            already finished or already has a cancellation pending.
 *
 * ⚠️ A CANCELLATION IS A REQUEST THE WORKER OBSERVES. A provider call already in
 * flight cannot be recalled. The confirmation says so instead of implying the
 * work stopped the instant the button was pressed.
 *
 * ⚠️ THE OLD PAGE MUTATED LOCAL STATE. It flipped a row's status in React and
 * showed a success toast, which meant the table could disagree with the database
 * indefinitely. Nothing here changes a row locally: every action re-reads.
 */

const PAGE_SIZE = 10;

const STATUS_TONE: Record<string, "positive" | "warning" | "neutral" | "danger"> = {
  completed: "positive",
  running: "warning",
  queued: "neutral",
  failed: "danger",
  cancelled: "neutral",
  interrupted: "danger",
};

const STATUS_ICON: Record<string, React.ReactNode> = {
  completed: <CheckCircle2 className="w-3 h-3" />,
  running: <Activity className="w-3 h-3" />,
  queued: <Clock className="w-3 h-3" />,
  failed: <XCircle className="w-3 h-3" />,
  cancelled: <Ban className="w-3 h-3" />,
  interrupted: <AlertTriangle className="w-3 h-3" />,
};

export default function GenerationMonitorPage() {
  const [status, setStatus] = useState<AdminGenerationFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const debouncedSearch = useDebouncedValue(search, 300);

  const { data, loading, error, refresh } = useGenerationMonitor({
    status,
    search: debouncedSearch,
    page,
    pageSize: PAGE_SIZE,
  });

  const [detailId, setDetailId] = useState<string | null>(null);

  const summary = data?.summary ?? null;
  const rows = data?.page.rows ?? [];

  const filterOptions = [
    { id: "all" as const, label: "All" },
    { id: "running" as const, label: "Running" },
    { id: "queued" as const, label: "Queued" },
    { id: "completed" as const, label: "Completed" },
    { id: "failed" as const, label: "Failed" },
    { id: "cancelled" as const, label: "Cancelled" },
  ];

  return (
    <AdminShell activeNav="Generation Monitor" live>
      {/* ── Queue counters ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <StatCard
          label="Queued"
          value={summary ? summary.queued.toLocaleString() : null}
          hint={
            summary
              ? summary.oldestQueuedAt
                ? `Oldest enqueued ${formatAge(summary.oldestQueuedAt)}`
                : "Nothing waiting"
              : undefined
          }
          icon={<Clock className="w-3.5 h-3.5 text-muted-foreground" />}
          unavailable={!summary}
        />
        <StatCard
          label="Running"
          value={summary ? summary.running.toLocaleString() : null}
          hint={
            summary
              ? `${summary.retryWait} waiting to retry · ${summary.staleLeases} stale lease(s)`
              : undefined
          }
          icon={<Activity className="w-3.5 h-3.5 text-warning" />}
          tone={summary && summary.staleLeases > 0 ? "warning" : "neutral"}
          unavailable={!summary}
        />
        <StatCard
          label="Completed"
          value={summary ? summary.completed.toLocaleString() : null}
          hint={
            summary
              ? summary.lastCompletedAt
                ? `Last finished ${formatAge(summary.lastCompletedAt)}`
                : "None finished yet"
              : undefined
          }
          icon={<CheckCircle2 className="w-3.5 h-3.5 text-success" />}
          tone="positive"
          unavailable={!summary}
        />
        <StatCard
          label="Failed"
          value={summary ? (summary.failed + summary.interrupted).toLocaleString() : null}
          hint={
            summary
              ? `${summary.failed} failed · ${summary.interrupted} interrupted · ${summary.deadLettered} dead-lettered`
              : undefined
          }
          icon={<XCircle className="w-3.5 h-3.5 text-muted-foreground" />}
          unavailable={!summary}
        />
      </div>

      {!data?.summaryAvailable && data && (
        <UnavailableNote>
          The queue counters could not be read, so the cards above show no value. They are not
          zero: a zero would claim an empty queue, which is a different statement.
        </UnavailableNote>
      )}

      {summary && summary.staleLeases > 0 && (
        <UnavailableNote>
          {summary.staleLeases} run(s) hold a lease that has already expired. The worker recovers
          expired leases on its own schedule; a lease expiring is not proof the worker is down.
        </UnavailableNote>
      )}

      {/* ── Runs ──────────────────────────────────────────────────────────── */}
      <SectionCard
        title="Generation runs"
        description="Live rows from the durable generation pipeline. Refreshes every 30 seconds while this tab is visible."
        actions={
          <SecondaryButton
            icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />}
            onClick={refresh}
            disabled={loading}
          >
            Refresh
          </SecondaryButton>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <SegmentedFilter
              options={filterOptions}
              value={status}
              onChange={(next) => {
                setStatus(next);
                setPage(0);
              }}
            />
            <SearchField
              value={search}
              onChange={(value) => {
                setSearch(value);
                setPage(0);
              }}
              placeholder="Search project, owner, model, run id…"
            />
          </div>

          {loading && !data ? (
            <LoadingBlock label="Reading the generation queue" />
          ) : error && !data ? (
            <ErrorBlock message={error} onRetry={refresh} />
          ) : rows.length === 0 ? (
            <EmptyBlock
              title="No runs match this view"
              detail={
                status === "all" && debouncedSearch === ""
                  ? "No generation has been started on this deployment yet."
                  : "Try a different status filter or clear the search."
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[var(--clay-line)] text-muted-foreground font-semibold uppercase text-[10px]">
                    <th className="pb-3">Run</th>
                    <th className="pb-3">Project</th>
                    <th className="pb-3">Owner</th>
                    <th className="pb-3 text-center">Status</th>
                    <th className="pb-3">Model</th>
                    <th className="pb-3 text-right">Tokens</th>
                    <th className="pb-3 text-right">Attempts</th>
                    <th className="pb-3 text-right">Started</th>
                    <th className="pb-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--clay-line)]">
                  {rows.map((row) => (
                    <tr key={row.id} className="hover:bg-[var(--clay-sunken)] transition-colors">
                      <td className="py-3 font-mono font-semibold text-foreground">
                        {row.id.slice(0, 8)}
                      </td>
                      <td className="py-3">
                        <p className="font-semibold text-foreground truncate max-w-[160px]">
                          {row.projectLabel ?? row.projectId}
                        </p>
                        <p className="text-[11px] text-muted-foreground font-mono truncate max-w-[160px]">
                          {row.projectId}
                        </p>
                      </td>
                      <td className="py-3">
                        <p className="text-foreground truncate max-w-[150px]">{row.ownerName}</p>
                        <p className="text-[11px] text-muted-foreground truncate max-w-[150px]">
                          {row.ownerEmail ?? "no email"}
                        </p>
                      </td>
                      <td className="py-3 text-center">
                        <Badge
                          tone={STATUS_TONE[row.status] ?? "neutral"}
                          icon={STATUS_ICON[row.status]}
                        >
                          {row.status}
                        </Badge>
                      </td>
                      <td className="py-3 font-mono text-muted-foreground truncate max-w-[140px]">
                        {row.model}
                      </td>
                      <td className="py-3 text-right font-mono text-muted-foreground">
                        {row.tokens === null ? "—" : row.tokens.toLocaleString()}
                      </td>
                      <td className="py-3 text-right font-mono text-muted-foreground">
                        {row.attempts ?? "—"}
                      </td>
                      <td className="py-3 text-right text-muted-foreground whitespace-nowrap">
                        {formatTimestamp(row.startedAt)}
                      </td>
                      <td className="py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setDetailId(row.id)}
                          className="px-2.5 py-1 text-[11px] font-medium text-foreground bg-[var(--clay-sunken)] hover:bg-[var(--clay-sunken-deep)] rounded-md transition-colors"
                        >
                          Open
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
              total={data.page.total}
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

      {detailId && (
        <RunDetailDrawer
          runId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={() => refresh()}
        />
      )}
    </AdminShell>
  );
}

// ───────────────────────────── run detail ───────────────────────────────────

function RunDetailDrawer({
  runId,
  onClose,
  onChanged,
}: {
  runId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data, loading, error, refresh } = useGenerationDetail(runId);
  const mutation = useAdminMutation();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const handleAction = async (action: "retry" | "cancel") => {
    const result = await mutation.run<{ message: string }>(
      "/api/adminsh/generation-monitor/actions",
      { runId, action, reason: cancelReason.trim() }
    );

    if ("error" in result) {
      toast.error(result.error);
      return;
    }

    toast.success(result.data.message);
    setConfirmCancel(false);
    setCancelReason("");
    refresh();
    onChanged();
  };

  const copy = (value: string, label: string) => {
    void navigator.clipboard?.writeText(value);
    toast.success(`${label} copied`);
  };

  return (
    <Modal
      title="Run detail"
      icon={<Layers className="w-4 h-4 text-foreground" />}
      onClose={onClose}
      maxWidth="max-w-2xl"
    >
      {loading && !data ? (
        <LoadingBlock label="Reading the run" />
      ) : error && !data ? (
        <ErrorBlock message={error} onRetry={refresh} />
      ) : !data ? (
        <EmptyBlock title="That run could not be read" />
      ) : (
        <RunDetailBody
          detail={data}
          onCopy={copy}
          onRetry={() => handleAction("retry")}
          onRequestCancel={() => setConfirmCancel(true)}
          pending={mutation.pending}
          confirmCancel={confirmCancel}
          cancelReason={cancelReason}
          onCancelReasonChange={setCancelReason}
          onConfirmCancel={() => handleAction("cancel")}
          onDismissCancel={() => {
            setConfirmCancel(false);
            setCancelReason("");
          }}
          actionError={mutation.error}
        />
      )}
    </Modal>
  );
}

function RunDetailBody({
  detail,
  onCopy,
  onRetry,
  onRequestCancel,
  pending,
  confirmCancel,
  cancelReason,
  onCancelReasonChange,
  onConfirmCancel,
  onDismissCancel,
  actionError,
}: {
  detail: AdminGenerationDetail;
  onCopy: (value: string, label: string) => void;
  onRetry: () => void;
  onRequestCancel: () => void;
  pending: boolean;
  confirmCancel: boolean;
  cancelReason: string;
  onCancelReasonChange: (value: string) => void;
  onConfirmCancel: () => void;
  onDismissCancel: () => void;
  actionError: string | null;
}) {
  const showCancel = canCancelRun(detail);
  const showRetry = canRetryRun(detail);

  return (
    <div className="space-y-4">
      {/* Status strip */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[detail.stage] ?? "neutral"} icon={STATUS_ICON[detail.stage]}>
          {detail.stage}
        </Badge>
        <Badge tone="neutral">{detail.dispatchMode}</Badge>
        {detail.cancellationRequestedAt && (
          <Badge tone="warning" icon={<Ban className="w-3 h-3" />}>
            cancellation requested
          </Badge>
        )}
        {detail.deadLetteredAt && (
          <Badge tone="danger" icon={<AlertTriangle className="w-3 h-3" />}>
            dead-lettered
          </Badge>
        )}
      </div>

      {/* Identity */}
      <div className="space-y-2 bg-[var(--clay-sunken)] p-4 rounded-xl border border-[var(--clay-line)] text-xs shadow-[var(--clay-well-1)]">
        <DetailRow
          label="Run ID"
          value={
            <button
              type="button"
              onClick={() => onCopy(detail.id, "Run ID")}
              className="font-mono underline decoration-dotted"
            >
              {detail.id}
            </button>
          }
          wrap
        />
        <DetailRow label="Project" value={detail.projectLabel ?? detail.projectId} />
        <DetailRow label="Project ID" value={detail.projectId} mono wrap />
        <DetailRow label="Owner" value={`${detail.ownerName} (${detail.ownerEmail ?? "no email"})`} />
        <DetailRow label="Model" value={detail.model} mono />
        {detail.requestedModel && detail.requestedModel !== detail.model && (
          <DetailRow label="Requested model" value={detail.requestedModel} mono />
        )}
      </div>

      {/* Timing */}
      <div className="space-y-2 bg-[var(--clay-sunken)] p-4 rounded-xl border border-[var(--clay-line)] text-xs shadow-[var(--clay-well-1)]">
        <DetailRow label="Started" value={formatTimestamp(detail.startedAt)} />
        <DetailRow label="Finished" value={formatTimestamp(detail.finishedAt)} />
        <DetailRow
          label="Duration"
          value={detail.durationSeconds === null ? "still running" : formatSeconds(detail.durationSeconds)}
        />
        <DetailRow label="Enqueued" value={formatTimestamp(detail.enqueuedAt)} />
        <DetailRow label="Dispatched" value={formatTimestamp(detail.dispatchedAt)} />
        <DetailRow label="Last heartbeat" value={formatAge(detail.heartbeatAt)} />
        <DetailRow label="Last progress" value={formatAge(detail.lastProgressAt)} />
        <DetailRow label="Next attempt" value={formatTimestamp(detail.nextAttemptAt)} />
        <DetailRow label="Lease expires" value={formatTimestamp(detail.leaseExpiresAt)} />
        <DetailRow label="Worker" value={detail.workerId} mono wrap />
      </div>

      {/* Progress */}
      <div className="space-y-2 bg-[var(--clay-sunken)] p-4 rounded-xl border border-[var(--clay-line)] text-xs shadow-[var(--clay-well-1)]">
        <DetailRow
          label="Job attempt"
          value={
            detail.jobAttempt === null
              ? null
              : `${detail.jobAttempt} / ${detail.maxJobAttempts ?? "?"}`
          }
        />
        <DetailRow label="Provider attempts" value={detail.attemptCount} />
        <DetailRow label="Checkpoints" value={detail.checkpointCount} />
        <DetailRow label="Batches" value={detail.batchCount} />
        <DetailRow label="Files written" value={detail.filesWritten} />
        <DetailRow label="Finish reason" value={detail.finishReason} />
      </div>

      {/* Tokens and cost */}
      <div className="space-y-2 bg-[var(--clay-sunken)] p-4 rounded-xl border border-[var(--clay-line)] text-xs shadow-[var(--clay-well-1)]">
        <DetailRow label="Prompt tokens" value={detail.promptTokens?.toLocaleString() ?? null} mono />
        <DetailRow
          label="Completion tokens"
          value={detail.completionTokens?.toLocaleString() ?? null}
          mono
        />
        <DetailRow label="Total tokens" value={detail.totalTokens?.toLocaleString() ?? null} mono />
        <DetailRow
          label="Reasoning tokens"
          value={detail.reasoningTokens?.toLocaleString() ?? null}
          mono
        />
        <DetailRow
          label="Reported cost"
          value={
            detail.costKnown && detail.reportedCostUsd !== null
              ? `$${detail.reportedCostUsd.toFixed(6)}`
              : "Cost unavailable"
          }
          mono
        />
      </div>

      {/* Failure */}
      {(detail.errorCode || detail.errorMessage || detail.lastErrorSummary) && (
        <div className="space-y-1.5 p-4 rounded-xl border border-warning/30 bg-[var(--clay-sunken)]">
          <p className="text-[11px] font-semibold text-foreground flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-warning" />
            Failure
          </p>
          <p className="text-[11px] text-muted-foreground font-mono">{detail.errorCode ?? "—"}</p>
          <p className="text-[11px] text-muted-foreground leading-relaxed whitespace-pre-wrap">
            {detail.errorMessage ?? detail.lastErrorSummary ?? "No message was recorded."}
          </p>
          {detail.lastErrorClass && (
            <p className="text-[10px] text-muted-foreground font-mono">
              class: {detail.lastErrorClass}
            </p>
          )}
        </div>
      )}

      {/* Prompt */}
      <div className="space-y-1.5">
        <p className="text-[11px] font-semibold text-foreground">Prompt</p>
        <pre className="text-[11px] text-muted-foreground leading-relaxed whitespace-pre-wrap max-h-40 overflow-y-auto bg-[var(--clay-sunken)] p-3 rounded-xl border border-[var(--clay-line)]">
          {detail.prompt || "No prompt was recorded for this run."}
        </pre>
      </div>

      {actionError && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-[var(--clay-sunken)] border border-warning/30 text-[11px] text-warning-subtle-foreground leading-relaxed">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{actionError}</span>
        </div>
      )}

      {/* Actions */}
      <div className="pt-3 border-t border-[var(--clay-line)] space-y-3">
        {confirmCancel ? (
          <div className="space-y-2">
            <p className="text-[11px] font-semibold text-foreground">
              Cancel this run?
            </p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              The run is marked cancelled and its credit hold is released. A provider request
              already in flight cannot be recalled, and the run keeps none of its output.
            </p>
            <input
              type="text"
              value={cancelReason}
              onChange={(event) => onCancelReasonChange(event.target.value)}
              maxLength={500}
              placeholder="Reason (optional, recorded in the audit log)"
              className="w-full px-3 py-2 text-xs bg-[var(--clay-sunken)] border border-[var(--clay-line)] rounded-xl focus:outline-none focus:bg-card shadow-[var(--clay-well-1)]"
            />
            <div className="flex items-center justify-end gap-2">
              <SecondaryButton onClick={onDismissCancel} disabled={pending}>
                Keep running
              </SecondaryButton>
              <PrimaryButton onClick={onConfirmCancel} disabled={pending}>
                {pending ? "Cancelling…" : "Confirm cancel"}
              </PrimaryButton>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {showRetry && (
              <SecondaryButton
                icon={<RotateCcw className="w-3.5 h-3.5" />}
                onClick={onRetry}
                disabled={pending}
              >
                {pending ? "Re-queueing…" : "Retry run"}
              </SecondaryButton>
            )}
            {showCancel && (
              <SecondaryButton
                icon={<Ban className="w-3.5 h-3.5" />}
                onClick={onRequestCancel}
                disabled={pending}
              >
                Cancel run
              </SecondaryButton>
            )}
            {!showRetry && !showCancel && (
              <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                <Timer className="w-3.5 h-3.5" />
                This run is terminal and has no available action.
              </p>
            )}
          </div>
        )}

        {showRetry && (
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Retry re-queues the run for the durable worker. It does not start immediately, and a
            credit-enforced project cannot be retried from here — the owner must resume it so the
            credit hold comes from their own balance.
          </p>
        )}
      </div>
    </div>
  );
}
