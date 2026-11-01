"use client";

import React from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Server,
  ShieldQuestion,
  XCircle,
} from "lucide-react";

import { adminPeriodLabel } from "@/lib/admin/overview";
import type { AdminHealthCheckRow, AdminOverviewPayload } from "@/lib/admin/types";
import { MOCK_SYSTEM_HEALTH } from "./mockData";

const STATE_STYLES: Record<
  AdminHealthCheckRow["state"],
  { label: string; pill: string; icon: React.ReactNode }
> = {
  operational: {
    label: "Operational",
    pill: "text-success bg-success-subtle border-success/25",
    icon: <CheckCircle2 className="w-3 h-3" />,
  },
  degraded: {
    label: "Degraded",
    pill: "text-warning-subtle-foreground bg-warning-subtle border-warning/25",
    icon: <AlertTriangle className="w-3 h-3" />,
  },
  down: {
    label: "Down",
    pill: "text-destructive-subtle-foreground bg-destructive-subtle border-destructive/25",
    icon: <XCircle className="w-3 h-3" />,
  },
  not_configured: {
    label: "Not configured",
    pill: "text-muted-foreground bg-[var(--clay-sunken)] border-[var(--clay-line)]",
    icon: <ShieldQuestion className="w-3 h-3" />,
  },
  unknown: {
    label: "Unknown",
    pill: "text-muted-foreground bg-[var(--clay-sunken)] border-[var(--clay-line)]",
    icon: <HelpCircle className="w-3 h-3" />,
  },
};

/**
 * Live mode renders bounded server-side checks from `/api/adminsh/overview`.
 * No historical uptime exists, so uptime is never claimed; latency is shown only
 * when the check actually measured it.
 */
export function PlatformHealth({
  live = false,
  data,
  error = false,
}: {
  live?: boolean;
  data?: AdminOverviewPayload | null;
  error?: boolean;
}) {
  if (!live) return <DemoPlatformHealth />;
  if (error) return <HealthUnavailable />;
  if (!data) return <HealthSkeleton />;
  return <LivePlatformHealth data={data} />;
}

function LivePlatformHealth({ data }: { data: AdminOverviewPayload }) {
  const checks = data.health;
  const measured = checks.filter((row) => row.state === "operational");
  const problems = checks.filter((row) => row.state === "degraded" || row.state === "down");

  const summary =
    problems.length > 0
      ? `${problems.length} service${problems.length === 1 ? "" : "s"} need attention`
      : `${measured.length} of ${checks.length} configured checks operational`;

  return (
    <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[var(--clay-line)]">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-success-subtle text-success-subtle-foreground border border-success/25">
              <Server className="w-4 h-4" />
            </div>
            <h2 className="text-base font-bold text-foreground">Platform Health & Infrastructure</h2>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Bounded checks executed for this request · {adminPeriodLabel(data.period)} data context
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={`px-2.5 py-1 text-[10px] font-bold tracking-wider uppercase rounded-lg border flex items-center gap-1.5 ${
              problems.length > 0
                ? "bg-warning-subtle text-warning-subtle-foreground border-warning/25"
                : "bg-success-subtle text-success-subtle-foreground border-success/25"
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>{summary}</span>
          </span>
          <span className="px-2 py-1 text-[10px] font-bold tracking-wider uppercase bg-[var(--clay-sunken)] text-muted-foreground rounded-lg">
            Live checks
          </span>
        </div>
      </div>

      {/* Grid of Health Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {checks.map((check) => {
          const style = STATE_STYLES[check.state];
          return (
            <div
              key={check.id}
              className="p-4 rounded-xl border border-[var(--clay-line)] bg-[var(--clay-sunken)] hover:bg-card hover:border-[var(--clay-line-strong)] transition-all space-y-2 shadow-[var(--clay-well-1)]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-foreground">{check.label}</span>
                <span
                  className={`inline-flex items-center gap-1 text-[11px] font-semibold border px-2 py-0.5 rounded-full ${style.pill}`}
                >
                  {style.icon}
                  {style.label}
                </span>
              </div>

              <p className="text-[11px] text-muted-foreground leading-snug">{check.description}</p>

              {check.detail ? (
                <p className="text-[10px] text-muted-foreground leading-snug font-medium break-words">
                  {check.detail}
                </p>
              ) : null}

              <div className="pt-2 border-t border-[var(--clay-line)] flex items-center justify-between text-[10px] text-muted-foreground font-medium">
                <span>
                  Uptime: <strong className="text-muted-foreground">Not measured</strong>
                </span>
                <span className="flex items-center gap-1">
                  <Activity className="w-3 h-3 text-muted-foreground" />
                  Latency:{" "}
                  <strong className="text-foreground">
                    {check.latencyMs === null ? "—" : `${check.latencyMs} ms`}
                  </strong>
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[10px] text-muted-foreground leading-relaxed">
        Checks are executed server-side with strict timeouts and never expose hostnames, credentials or
        internal URLs. Historical uptime percentages are not tracked by this application.
      </p>
    </div>
  );
}

function HealthUnavailable() {
  return (
    <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] space-y-4">
      <div className="flex items-center gap-2">
        <div className="p-1.5 rounded-lg bg-[var(--clay-sunken)] text-muted-foreground border border-[var(--clay-line)] shadow-[var(--clay-well-1)]">
          <Server className="w-4 h-4" />
        </div>
        <h2 className="text-base font-bold text-foreground">Platform Health & Infrastructure</h2>
      </div>
      <div className="rounded-xl border border-dashed border-[var(--clay-line)] bg-[var(--clay-sunken)] px-4 py-10 text-center shadow-[var(--clay-well-1)]">
        <p className="text-sm font-semibold text-foreground">Health checks are unavailable</p>
        <p className="text-xs text-muted-foreground mt-1">
          The status endpoint could not be read. Services are not assumed healthy.
        </p>
      </div>
    </div>
  );
}

function HealthSkeleton() {
  return (
    <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] space-y-4 animate-pulse">
      <div className="h-4 w-64 rounded bg-[var(--clay-sunken)]" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="h-24 rounded-xl bg-[var(--clay-sunken)]" />
        ))}
      </div>
    </div>
  );
}

function DemoPlatformHealth() {
  return (
    <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[var(--clay-line)]">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-success-subtle text-success-subtle-foreground border border-success/25">
              <Server className="w-4 h-4" />
            </div>
            <h2 className="text-base font-bold text-foreground">Platform Health & Infrastructure</h2>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Real-time status of backend services, database connections, and worker queues
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="px-2.5 py-1 text-[10px] font-bold tracking-wider uppercase bg-success-subtle text-success-subtle-foreground border border-success/25 rounded-lg flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>All Systems Operational</span>
          </span>
          <span className="px-2 py-1 text-[10px] font-bold tracking-wider uppercase bg-[var(--clay-sunken)] text-muted-foreground rounded-lg">
            Demo Statuses
          </span>
        </div>
      </div>

      {/* Grid of Health Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {MOCK_SYSTEM_HEALTH.map((srv) => (
          <div
            key={srv.name}
            className="p-4 rounded-xl border border-[var(--clay-line)] bg-[var(--clay-sunken)] hover:bg-card hover:border-[var(--clay-line-strong)] transition-all space-y-2 shadow-[var(--clay-well-1)]"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-foreground">{srv.name}</span>
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-success bg-success-subtle border border-success/25 px-2 py-0.5 rounded-full">
                <CheckCircle2 className="w-3 h-3 text-success" />
                {srv.status}
              </span>
            </div>

            <p className="text-[11px] text-muted-foreground leading-snug">{srv.description}</p>

            <div className="pt-2 border-t border-[var(--clay-line)] flex items-center justify-between text-[10px] text-muted-foreground font-medium">
              <span>
                Uptime: <strong className="text-foreground">{srv.uptime}</strong>
              </span>
              <span className="flex items-center gap-1">
                <Activity className="w-3 h-3 text-muted-foreground" />
                Latency: <strong className="text-foreground">{srv.latency}</strong>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
