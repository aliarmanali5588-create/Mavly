"use client";

import React from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  HelpCircle,
  RefreshCw,
  ShieldQuestion,
  Slash,
  XCircle,
} from "lucide-react";

import {
  formatAge,
  overallServiceState,
  serviceStateLabel,
  type AdminHealthPayload,
  type AdminServiceCheck,
  type AdminServiceState,
} from "@/lib/admin/console";
import { AdminShell } from "../components/AdminShell";
import { useSystemHealth } from "../components/useAdminConsoleData";
import {
  Badge,
  ErrorBlock,
  LoadingBlock,
  SecondaryButton,
  SectionCard,
  ServiceStateBadge,
  StatCard,
  UnavailableNote,
  formatTimestamp,
} from "../components/console-ui";

/**
 * ═══ SYSTEM HEALTH ══════════════════════════════════════════════════════════
 *
 * Every row is one of three things and says which:
 *
 *   measured      a real call was made this request (database round-trip, queue
 *                 read, worker credential resolution)
 *   configured    the dependency exists but has no safe probe, so its state is
 *                 `unknown` — never `operational`
 *   not configured the dependency is absent
 *
 * ⚠️ THE OLD PAGE SHOWED INVENTED UPTIME. "99.98%", "p99 142ms" and a list of
 * past incidents were all fabricated. Mavly records no availability samples and
 * no incident history, so there is nothing to show: the uptime card says "not
 * recorded" and the incident panel is gone rather than emptied, because an empty
 * incident list would itself imply "no incidents happened".
 *
 * ⚠️ A HEALTHY DATABASE DOES NOT MAKE THE PLATFORM HEALTHY. The AI provider, the
 * worker process, DNS and payments are separate dependencies; none of them
 * inherits the database's state.
 */

const STATE_ICON: Record<AdminServiceState, React.ReactNode> = {
  operational: <CheckCircle2 className="w-3.5 h-3.5 text-success" />,
  degraded: <AlertTriangle className="w-3.5 h-3.5 text-warning" />,
  down: <XCircle className="w-3.5 h-3.5 text-foreground" />,
  unknown: <HelpCircle className="w-3.5 h-3.5 text-muted-foreground" />,
  not_configured: <Slash className="w-3.5 h-3.5 text-muted-foreground" />,
};

export default function SystemHealthPage() {
  const { data, loading, error, refresh } = useSystemHealth();

  const services = data?.services ?? [];
  const overall = overallServiceState(services);
  const snapshot = data?.snapshot ?? null;

  return (
    <AdminShell activeNav="System Health" live>
      {/* ── Overall banner ────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 rounded-xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]">
        <div className="flex items-center gap-2.5 min-w-0">
          {STATE_ICON[overall]}
          <div className="min-w-0">
            <p className="text-sm font-bold text-foreground tracking-tight">
              {data ? serviceStateLabel(overall) : "Reading service state"}
            </p>
            <p className="text-[11px] text-muted-foreground truncate">
              {data
                ? `Measured ${formatTimestamp(data.measuredAt)} · ${data.environment}${
                    data.version ? ` · release ${data.version}` : ""
                  }`
                : "Contacting this deployment's services"}
            </p>
          </div>
        </div>
        <SecondaryButton
          icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />}
          onClick={refresh}
          disabled={loading}
        >
          Re-check now
        </SecondaryButton>
      </div>

      {error && !data && <ErrorBlock message={error} onRetry={refresh} />}

      {/* ── Measured counters ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <StatCard
          label="Queue backlog"
          value={snapshot ? snapshot.queued.toLocaleString() : null}
          hint={
            snapshot
              ? snapshot.oldestQueuedAt
                ? `Oldest enqueued ${formatAge(snapshot.oldestQueuedAt)}`
                : "Nothing waiting"
              : "Database snapshot unavailable"
          }
          icon={<Clock className="w-3.5 h-3.5 text-muted-foreground" />}
          unavailable={!snapshot}
        />
        <StatCard
          label="Running now"
          value={snapshot ? snapshot.running.toLocaleString() : null}
          hint={snapshot ? `${snapshot.staleLeases} stale lease(s)` : "Database snapshot unavailable"}
          icon={<Activity className="w-3.5 h-3.5 text-muted-foreground" />}
          tone={snapshot && snapshot.staleLeases > 0 ? "warning" : "neutral"}
          unavailable={!snapshot}
        />
        <StatCard
          label="Runs (24h)"
          value={snapshot ? snapshot.runsLast24h.toLocaleString() : null}
          hint={
            snapshot
              ? `${snapshot.failuresLast24h} failed or interrupted`
              : "Database snapshot unavailable"
          }
          icon={<Activity className="w-3.5 h-3.5 text-muted-foreground" />}
          unavailable={!snapshot}
        />
        <StatCard
          label="Historical uptime"
          value={null}
          hint="Not recorded. Mavly stores no availability samples, so no percentage exists."
          icon={<ShieldQuestion className="w-3.5 h-3.5 text-muted-foreground" />}
          unavailable
        />
      </div>

      {/* ── Service checks ────────────────────────────────────────────────── */}
      <SectionCard
        title="Service checks"
        description="What this deployment could actually observe. A row marked 'configuration only' was not probed."
      >
        {loading && !data ? (
          <LoadingBlock label="Checking services" />
        ) : services.length === 0 ? (
          <ErrorBlock
            message="No service checks were returned."
            onRetry={refresh}
            title="Nothing to report"
          />
        ) : (
          <div className="space-y-2">
            {services.map((service) => (
              <ServiceRow key={service.id} service={service} />
            ))}
          </div>
        )}
      </SectionCard>

      {/* ── Worker timing ─────────────────────────────────────────────────── */}
      {snapshot && (
        <SectionCard
          title="Worker timing"
          description="Timestamps the database recorded. These describe work, not process liveness."
        >
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <TimingCell
              label="Last worker heartbeat"
              value={snapshot.lastHeartbeatAt}
              note="A worker writes a heartbeat while it holds a run. No heartbeat means no run has been claimed recently, not that the worker is down."
            />
            <TimingCell
              label="Last completed run"
              value={snapshot.lastCompletedAt}
              note="The newest run that reached a completed stage."
            />
            <TimingCell
              label="Last failure"
              value={snapshot.lastFailureAt}
              note="The newest run that ended failed or interrupted."
            />
          </div>
        </SectionCard>
      )}

      {/* ── Honest limits ─────────────────────────────────────────────────── */}
      <UnavailableNote>
        This page reports what the platform can observe from inside itself. It does not monitor the
        worker process, DNS, TLS or the payment gateway, and it keeps no history — so it cannot tell
        you whether a service was healthy an hour ago, and it will not claim an uptime percentage it
        has no samples for. Provider and payment rows are configuration checks, not live probes: a
        paid generation request is not a health check.
      </UnavailableNote>

      {error && data && (
        <p className="text-[11px] text-warning-subtle-foreground">
          Showing the last successful check. The newest refresh failed: {error}
        </p>
      )}
    </AdminShell>
  );
}

function ServiceRow({ service }: { service: AdminServiceCheck }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 px-3 py-2.5 rounded-lg bg-[var(--clay-sunken)] border border-[var(--clay-line)]">
      <div className="flex items-start gap-2.5 min-w-0">
        <span className="mt-0.5 shrink-0">{STATE_ICON[service.state]}</span>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground">{service.label}</p>
          <p className="text-[11px] text-muted-foreground leading-relaxed">{service.description}</p>
          {service.detail && (
            <p className="text-[11px] text-muted-foreground leading-relaxed mt-1 font-mono break-words">
              {service.detail}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0 sm:flex-col sm:items-end">
        <ServiceStateBadge state={service.state} label={serviceStateLabel(service.state)} />
        <Badge tone={service.measured ? "neutral" : "warning"}>
          {service.measured ? "measured" : "configuration only"}
        </Badge>
        {service.latencyMs !== null && (
          <span className="text-[10px] font-mono text-muted-foreground">
            {service.latencyMs}ms
          </span>
        )}
      </div>
    </div>
  );
}

function TimingCell({
  label,
  value,
  note,
}: {
  label: string;
  value: string | null;
  note: string;
}) {
  return (
    <div className="p-3 rounded-lg bg-[var(--clay-sunken)] border border-[var(--clay-line)]">
      <p className="text-[11px] font-semibold text-foreground">{label}</p>
      <p className="font-mono text-xs text-foreground mt-1">{formatAge(value)}</p>
      <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">{note}</p>
    </div>
  );
}
