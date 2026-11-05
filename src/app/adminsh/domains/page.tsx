"use client";

import React, { useMemo, useState } from "react";
import {
  Globe,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Ban,
  Lock,
} from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "../components/AdminShell";
import {
  Badge,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  Pagination,
  PrimaryButton,
  SearchField,
  SecondaryButton,
  SectionCard,
  SegmentedFilter,
  StatCard,
} from "../components/console-ui";
import { useAdminMutation, useAdminQuery, useDebouncedValue } from "../components/useAdminConsoleData";

/**
 * ═══ DOMAINS — ADMIN VISIBILITY ═════════════════════════════════════════════
 *
 * Every figure on this page is `admin_domain_overview`'s own aggregate over
 * `public.project_domains`. Nothing is computed in the browser, so the cards
 * cannot drift from the registry, and a missing migration is reported as a
 * deployment problem rather than as "no domains".
 *
 * ⚠️ APPROVAL IS NOT A BADGE. A custom hostname is routed by the worker only
 * when `routing_approved_at` is set (while routing approval is required, which
 * is the default). The button below writes that through
 * `admin_approve_domain_routing`, which also writes an `admin_audit_log` row.
 */

type DomainStatusFilter =
  | "all"
  | "active"
  | "verification_required"
  | "provisioning"
  | "ssl_failed"
  | "misconfigured"
  | "disabled";

interface AdminDomainRow {
  id: string;
  projectId: string;
  projectName: string;
  userId: string;
  email: string | null;
  hostname: string;
  domainType: "mavly_subdomain" | "custom";
  status: string;
  dnsStatus: string;
  sslStatus: string;
  publicationStatus: string;
  routingProvider: string;
  isPrimary: boolean;
  failureCode: string | null;
  lastVerifiedAt: string | null;
  lastCheckedAt: string | null;
  routingApprovedAt: string | null;
  createdAt: string | null;
}

interface AdminDomainEvent {
  id: string;
  projectId: string;
  domainId: string;
  actorKind: string;
  event: string;
  outcome: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface AdminDomainPayload {
  summary: Record<string, number | string>;
  rows: AdminDomainRow[];
  recentEvents: AdminDomainEvent[];
  limit: number;
  offset: number;
  status: string;
  search: string | null;
}

const PAGE_SIZE = 25;

const FILTERS: ReadonlyArray<{ id: DomainStatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "verification_required", label: "Verification" },
  { id: "provisioning", label: "Provisioning" },
  { id: "ssl_failed", label: "SSL failed" },
  { id: "misconfigured", label: "Misconfigured" },
  { id: "disabled", label: "Disabled" },
];

const STATUS_TONE: Record<string, "positive" | "warning" | "danger" | "neutral"> = {
  active: "positive",
  verified: "warning",
  provisioning: "warning",
  ssl_pending: "warning",
  verifying: "warning",
  pending: "neutral",
  verification_required: "warning",
  removing: "warning",
  misconfigured: "danger",
  ssl_failed: "danger",
  disabled: "neutral",
  removed: "neutral",
};

function count(summary: Record<string, number | string>, key: string): number | null {
  const value = summary[key];
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AdminDomainsPage() {
  const [status, setStatus] = useState<DomainStatusFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const debouncedSearch = useDebouncedValue(search);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      status,
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());
    return `/api/adminsh/domains?${params.toString()}`;
  }, [status, page, debouncedSearch]);

  const { data, loading, error, refresh } = useAdminQuery<AdminDomainPayload>(query, {
    label: "domains",
  });
  const mutation = useAdminMutation();

  const summary = data?.summary ?? {};
  const rows = data?.rows ?? [];
  const events = data?.recentEvents ?? [];
  const total = count(summary, "total");

  async function setApproval(domain: AdminDomainRow, approved: boolean) {
    const result = await mutation.run<unknown>("/api/adminsh/domains", {
      domainId: domain.id,
      approved,
    });
    if (!result.ok) {
      toast.error((result as { ok: false; error: string }).error);
      return;
    }
    toast.success(
      approved
        ? `Routing approved for ${domain.hostname}.`
        : `Routing approval revoked for ${domain.hostname}.`,
    );
    refresh();
  }

  return (
    <AdminShell activeNav="Domains" live>
      <div className="space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">Domains</h1>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Registered hostnames, verification, certificates and routing approval.
            </p>
          </div>
          <SecondaryButton onClick={refresh} icon={<RefreshCw className="w-3.5 h-3.5" />}>
            Refresh
          </SecondaryButton>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            label="Registered"
            value={total === null ? null : total.toLocaleString()}
            unavailable={total === null}
            hint="All rows, including removed"
            icon={<Globe className="w-4 h-4" />}
          />
          <StatCard
            label="Active"
            value={count(summary, "active")?.toLocaleString() ?? null}
            unavailable={count(summary, "active") === null}
            tone="positive"
            hint="Verified, HTTPS, routing confirmed"
            icon={<CheckCircle2 className="w-4 h-4" />}
          />
          <StatCard
            label="Pending verification"
            value={count(summary, "pendingVerification")?.toLocaleString() ?? null}
            unavailable={count(summary, "pendingVerification") === null}
            tone="warning"
            hint="Ownership not yet proven"
            icon={<Clock className="w-4 h-4" />}
          />
          <StatCard
            label="Failures"
            value={
              count(summary, "dnsFailures") === null && count(summary, "sslFailures") === null
                ? null
                : (
                    (count(summary, "dnsFailures") ?? 0) + (count(summary, "sslFailures") ?? 0)
                  ).toLocaleString()
            }
            unavailable={count(summary, "dnsFailures") === null && count(summary, "sslFailures") === null}
            tone="negative"
            hint="DNS misconfiguration + certificate failures"
            icon={<AlertTriangle className="w-4 h-4" />}
          />
        </div>

        <SectionCard
          title="Registered hostnames"
          description="Custom domains and Mavly aliases. The canonical <project-id>.mavly.xyz address is derived from the project id and is not a row."
          actions={<SearchField value={search} onChange={setSearch} placeholder="Hostname, project or email" />}
        >
          <div className="space-y-3">
            <SegmentedFilter
              options={FILTERS}
              value={status}
              onChange={(next) => {
                setStatus(next);
                setPage(0);
              }}
            />

            {loading && rows.length === 0 ? (
              <LoadingBlock label="Loading domains" />
            ) : error ? (
              <ErrorBlock message={error} onRetry={refresh} />
            ) : rows.length === 0 ? (
              <EmptyBlock
                title="No domains match"
                detail="No registered hostname matches this filter. The canonical project address is not listed here."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b border-[var(--clay-line)]">
                      <th className="py-2 pr-3 font-medium">Hostname</th>
                      <th className="py-2 pr-3 font-medium">Project</th>
                      <th className="py-2 pr-3 font-medium">Owner</th>
                      <th className="py-2 pr-3 font-medium">Status</th>
                      <th className="py-2 pr-3 font-medium">DNS</th>
                      <th className="py-2 pr-3 font-medium">SSL</th>
                      <th className="py-2 pr-3 font-medium">Routing</th>
                      <th className="py-2 pr-3 font-medium">Created</th>
                      <th className="py-2 font-medium">Approval</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.id}
                        className="border-b border-[var(--clay-line)] last:border-0 align-top"
                      >
                        <td className="py-2.5 pr-3">
                          <div className="font-mono text-foreground">{row.hostname}</div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            {row.domainType === "custom" ? "Custom domain" : "Mavly alias"}
                            {row.isPrimary ? " · primary" : ""}
                          </div>
                          {row.failureCode ? (
                            <div className="text-[10px] text-[var(--clay-danger)] mt-0.5 font-mono">
                              {row.failureCode}
                            </div>
                          ) : null}
                        </td>
                        <td className="py-2.5 pr-3">
                          <div className="text-foreground">{row.projectName}</div>
                          <div className="text-[10px] text-muted-foreground font-mono">
                            {row.projectId}
                          </div>
                        </td>
                        <td className="py-2.5 pr-3 text-muted-foreground">
                          {row.email ?? row.userId.slice(0, 8)}
                        </td>
                        <td className="py-2.5 pr-3">
                          <Badge tone={STATUS_TONE[row.status] ?? "neutral"}>{row.status}</Badge>
                        </td>
                        <td className="py-2.5 pr-3 text-muted-foreground font-mono">{row.dnsStatus}</td>
                        <td className="py-2.5 pr-3 text-muted-foreground font-mono">{row.sslStatus}</td>
                        <td className="py-2.5 pr-3 text-muted-foreground font-mono">
                          {row.routingProvider}
                        </td>
                        <td className="py-2.5 pr-3 text-muted-foreground whitespace-nowrap">
                          {formatDate(row.createdAt)}
                        </td>
                        <td className="py-2.5">
                          {row.domainType !== "custom" ? (
                            <span className="text-[10px] text-muted-foreground">
                              Not required
                            </span>
                          ) : row.routingApprovedAt ? (
                            <div className="space-y-1">
                              <Badge tone="positive" icon={<ShieldCheck className="w-3 h-3" />}>
                                approved
                              </Badge>
                              <div>
                                <SecondaryButton
                                  onClick={() => void setApproval(row, false)}
                                  disabled={mutation.pending}
                                  icon={<Ban className="w-3 h-3" />}
                                >
                                  Revoke
                                </SecondaryButton>
                              </div>
                            </div>
                          ) : (
                            <PrimaryButton
                              onClick={() => void setApproval(row, true)}
                              disabled={mutation.pending}
                              icon={<ShieldAlert className="w-3 h-3" />}
                            >
                              Approve
                            </PrimaryButton>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={total ?? 0}
              onPageChange={setPage}
              loading={loading}
            />
          </div>
        </SectionCard>

        <SectionCard
          title="Recent domain events"
          description="The last 50 recorded domain events. Verification tokens, DNS answers and certificate material are never stored here."
        >
          {loading && events.length === 0 ? (
            <LoadingBlock label="Loading events" />
          ) : events.length === 0 ? (
            <EmptyBlock title="No events yet" detail="No domain event has been recorded." />
          ) : (
            <ul className="space-y-2">
              {events.map((event) => (
                <li
                  key={event.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 py-1.5 border-b border-[var(--clay-line)] last:border-0"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge
                      tone={
                        event.outcome === "failure"
                          ? "danger"
                          : event.outcome === "success"
                            ? "positive"
                            : "neutral"
                      }
                    >
                      {event.event}
                    </Badge>
                    <span className="font-mono text-[11px] text-muted-foreground truncate">
                      {event.projectId}
                    </span>
                    <span className="text-[10px] text-muted-foreground">{event.actorKind}</span>
                  </div>
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                    {formatDate(event.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <div className="flex items-start gap-2 text-[11px] text-muted-foreground px-1">
          <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <p>
            Approving a custom hostname records the decision and an audit entry. It does not
            attach the hostname at the hosting provider or issue a certificate; the domain
            worker does that, and a hostname stays <span className="font-mono">provisioning</span>{" "}
            until Vercel reports it verified and the public HTTPS probe confirms it serves the
            published version.
          </p>
        </div>
      </div>
    </AdminShell>
  );
}
