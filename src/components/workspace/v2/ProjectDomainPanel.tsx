"use client";

import * as React from "react";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CopyIcon,
  GlobeIcon,
  InfoIcon,
  PlusIcon,
  RefreshCwIcon,
  StarIcon,
  Trash2Icon,
  Wand2Icon,
} from "lucide-react";

import { ConfirmDialog, EmptyState, Modal, StatusPill } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/i18n";
import {
  domainStatusHelp,
  domainStatusLabel,
  domainStatusTone,
  isDomainSettling,
} from "@/lib/domains/status";
import type {
  DomainDnsInstructions,
  ProjectDomainDetail,
  ProjectDomainView,
  ProjectDomainsWithCapability,
} from "@/lib/domains/types";
import { toast } from "@/lib/toast";
import { vcaasApi } from "@/lib/vcaas";
import type { VcaasProject } from "@/lib/vcaas-types";

import { Callout } from "./page-bits";

/**
 * ═══ DOMAINS ═══════════════════════════════════════════════════════════════
 *
 * The canonical `<project-id>.mavly.xyz` address is derived from the immutable
 * project id; it is never created or renamed here. Everything else in this
 * panel is an additive alias or a customer-owned hostname.
 *
 * ⚠️ EVERY BADGE COMES FROM THE SERVER. Nothing turns green because a request
 * returned; a domain is "Active" only after the worker verified DNS, routing
 * and HTTPS. Verification instructions are printed from server configuration,
 * so a missing routing target is stated instead of inventing a CNAME.
 */

const DOMAIN_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function toneOf(status: ProjectDomainView["status"]) {
  return domainStatusTone(status);
}

function canVerify(domain: ProjectDomainView): boolean {
  return (
    domain.domainType === "custom" &&
    ["verification_required", "misconfigured", "ssl_failed", "ssl_pending"].includes(
      domain.status,
    )
  );
}

function canProvision(domain: ProjectDomainView): boolean {
  return ["verified", "misconfigured", "ssl_failed", "ssl_pending", "pending"].includes(
    domain.status,
  );
}

function copyText(value: string, label: string): void {
  void navigator.clipboard.writeText(value).then(
    () => toast.success(`${label} copied.`),
    () => toast.error(`Could not copy the ${label.toLowerCase()}.`),
  );
}

function RecordRow({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-[var(--clay-line)] bg-muted/30 px-3 py-2">
      <div className="min-w-0 space-y-0.5">
        <p className="text-muted-foreground text-2xs font-semibold uppercase tracking-wide">
          {label}
        </p>
        <p className="break-all font-mono text-xs">{value}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="shrink-0"
        onClick={() => copyText(value, copyLabel)}
        aria-label={`Copy ${copyLabel}`}
      >
        <CopyIcon className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}

function Instructions({
  instructions,
  capability,
}: {
  instructions: DomainDnsInstructions;
  capability: ProjectDomainsWithCapability["capability"];
}) {
  return (
    <div className="space-y-2 rounded-xl border border-[var(--clay-line)] bg-card p-3">
      <p className="text-sm font-medium">DNS records</p>
      {instructions.verification.map((record) => (
        <React.Fragment key={`${record.recordType}-${record.name}`}>
          <RecordRow label={`${record.recordType} name`} value={record.name} copyLabel="record name" />
          <RecordRow label={`${record.recordType} value`} value={record.value} copyLabel="record value" />
        </React.Fragment>
      ))}
      {instructions.routing.map((record) => (
        <React.Fragment key={`${record.recordType}-${record.name}`}>
          <RecordRow
            label={`${record.recordType} name`}
            value={record.name === "@" ? instructions.hostname : record.name}
            copyLabel="record name"
          />
          <RecordRow label={`${record.recordType} value`} value={record.value} copyLabel="record value" />
        </React.Fragment>
      ))}
      {instructions.notes.map((note) => (
        <p key={note} className="text-muted-foreground flex gap-1.5 text-xs leading-relaxed">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {note}
        </p>
      ))}
      {instructions.unavailableReason ? (
        <Callout tone="warning" title="Routing is not configured yet">
          {instructions.unavailableReason}
        </Callout>
      ) : null}
      {capability.requireRoutingApproval ? (
        <p className="text-muted-foreground text-xs leading-relaxed">
          Customer-owned hostnames also need an operator routing approval after ownership is
          verified. Approval is permission to route; the server still verifies DNS and HTTPS
          before the address becomes active.
        </p>
      ) : null}
    </div>
  );
}

export function ProjectDomainPanel({
  project,
  open = true,
  onOpenChange = () => {},
  onChanged,
}: {
  project: VcaasProject;
  onChanged?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useT();
  const projectId = project.projectId;
  const [overview, setOverview] = React.useState<ProjectDomainsWithCapability | null>(null);
  const [detail, setDetail] = React.useState<ProjectDomainDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [label, setLabel] = React.useState("");
  const [hostname, setHostname] = React.useState("");
  const [removing, setRemoving] = React.useState<ProjectDomainView | null>(null);

  const load = React.useCallback(async () => {
    const response = await vcaasApi.domains.overview(projectId);
    if (response.ok) {
      setOverview(response.data);
      setLoadError(null);
      if (detail) {
        const refreshed = await vcaasApi.domains.get(projectId, detail.id);
        if (refreshed.ok) setDetail(refreshed.data);
      }
    } else {
      setLoadError(response.error || "Domains could not be read.");
    }
    setLoading(false);
  }, [detail, projectId]);

  React.useEffect(() => {
    if (!open) return;
    setLoading(true);
    void load();
    // Re-read only when the panel opens; polling is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  /**
   * Poll only while the server reports a settling state. A terminal state stops
   * polling, so a failed row never spins forever.
   */
  React.useEffect(() => {
    if (!open || !overview) return;
    const settling = overview.domains.some((domain) => isDomainSettling(domain.status));
    if (!settling) return;
    const interval = setInterval(() => void load(), 6_000);
    return () => clearInterval(interval);
  }, [open, overview, load]);

  async function showDetail(domainId: string) {
    setBusy(`detail:${domainId}`);
    const response = await vcaasApi.domains.get(projectId, domainId);
    setBusy(null);
    if (response.ok) setDetail(response.data);
    else toast.error("Could not read that domain", { description: response.error });
  }

  async function reserve(event: React.FormEvent) {
    event.preventDefault();
    const value = label.trim().toLowerCase();
    if (!value) return;
    setBusy("reserve");
    const response = await vcaasApi.domains.reserveSubdomain(projectId, value);
    setBusy(null);
    if (response.ok) {
      setLabel("");
      toast.success(`${response.data.hostname} reserved. Routing is provisioned next.`);
      onChanged?.();
      await load();
    } else {
      toast.error("Could not reserve that subdomain", { description: response.error });
    }
  }

  async function addCustom(event: React.FormEvent) {
    event.preventDefault();
    const value = hostname.trim().toLowerCase();
    if (!value || !DOMAIN_NAME.test(value)) {
      toast.error("Enter a hostname such as example.com or shop.example.com.");
      return;
    }
    setBusy("add-custom");
    const response = await vcaasApi.domains.addCustom(projectId, value);
    setBusy(null);
    if (response.ok) {
      setHostname("");
      setDetail(response.data);
      toast.success("Domain added. Add the TXT record, then run verification.");
      onChanged?.();
      await load();
    } else {
      toast.error("Could not add that domain", { description: response.error });
    }
  }

  async function act(
    domain: ProjectDomainView,
    action: "verify" | "retry" | "primary" | "remove",
  ) {
    setBusy(`${action}:${domain.id}`);
    const response =
      action === "verify"
        ? await vcaasApi.domains.verify(projectId, domain.id)
        : action === "retry"
          ? await vcaasApi.domains.retry(projectId, domain.id)
          : action === "primary"
            ? await vcaasApi.domains.primary(projectId, domain.id)
            : await vcaasApi.domains.remove(projectId, domain.id);
    setBusy(null);
    if (response.ok) {
      toast.success(
        action === "verify"
          ? "Verification requested."
          : action === "retry"
            ? "Provisioning requested."
            : action === "primary"
              ? "Primary domain updated."
              : "Removal requested.",
      );
      if (action === "remove") setDetail(null);
      onChanged?.();
      await load();
    } else {
      toast.error("That domain action was refused", { description: response.error });
    }
  }

  const capability = overview?.capability;
  const domains = overview?.domains ?? [];

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        size="lg"
        title={t("engineV2.address.title")}
        description="Your Mavly address, readable subdomain aliases and customer-owned custom domains."
      >
        <div className="space-y-5">
          {loading ? (
            <p className="text-muted-foreground text-sm">Reading domain state…</p>
          ) : null}
          {loadError ? (
            <Callout tone="warning" title="Domains are unavailable">
              {loadError}
            </Callout>
          ) : null}

          {overview ? (
            <section className="space-y-2 rounded-xl border border-[var(--clay-line)] bg-card p-4 shadow-[var(--clay-elev-1)]">
              <div className="flex flex-wrap items-center gap-2">
                <GlobeIcon className="text-muted-foreground size-4" aria-hidden />
                <span className="text-sm font-medium">Canonical Mavly address</span>
                <StatusPill
                  tone={
                    overview.canonicalStatus === "published"
                      ? "success"
                      : overview.canonicalStatus === "failed"
                        ? "danger"
                        : "warning"
                  }
                >
                  {overview.canonicalStatus === "published"
                    ? "Published"
                    : overview.canonicalStatus === "not_published"
                      ? "Not published"
                      : "Pending"}
                </StatusPill>
              </div>
              <p className="font-mono text-sm" data-testid="mavly-address">
                {overview.canonicalHostname}
              </p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                This address is derived from the project id and cannot be renamed. It becomes
                available after a successful publish.
              </p>
            </section>
          ) : null}

          {capability?.problem ? (
            <Callout tone="warning" title="Domain management is limited">
              {capability.problem}
            </Callout>
          ) : null}

          {overview && capability?.enabled ? (
            <section className="border-[var(--clay-line)] space-y-3 border-t pt-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium">Mavly subdomain aliases</h3>
                <p className="text-muted-foreground text-xs">
                  {overview.entitlements.subdomainAliasesUsed} of{" "}
                  {overview.entitlements.maxSubdomainAliases} used · plan{" "}
                  {overview.entitlements.planId}
                </p>
              </div>
              {capability.subdomainAliasesEnabled ? (
                <form className="flex flex-col gap-2 sm:flex-row" onSubmit={reserve}>
                  <div className="flex min-w-0 flex-1 items-center rounded-md border border-[var(--clay-line)] bg-background">
                    <Input
                      value={label}
                      onChange={(event) =>
                        setLabel(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
                      }
                      placeholder="shop"
                      aria-label="Mavly subdomain label"
                      className="border-0 shadow-none focus-visible:ring-0"
                    />
                    <span className="text-muted-foreground pr-3 font-mono text-xs">.mavly.xyz</span>
                  </div>
                  <Button type="submit" disabled={busy !== null || !label.trim()}>
                    {busy === "reserve" ? (
                      <RefreshCwIcon className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <PlusIcon className="size-4" aria-hidden />
                    )}
                    Reserve
                  </Button>
                </form>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Subdomain aliases are disabled on this deployment.
                </p>
              )}
            </section>
          ) : null}

          {overview && capability?.customDomainsEnabled ? (
            <section className="border-[var(--clay-line)] space-y-3 border-t pt-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium">Custom domains</h3>
                <p className="text-muted-foreground text-xs">
                  {overview.entitlements.customDomainsUsed} of{" "}
                  {overview.entitlements.maxCustomDomains} used
                </p>
              </div>
              <form className="flex flex-col gap-2 sm:flex-row" onSubmit={addCustom}>
                <Input
                  value={hostname}
                  onChange={(event) => setHostname(event.target.value.toLowerCase())}
                  placeholder="example.com or shop.example.com"
                  aria-label="Custom domain"
                  className="flex-1"
                />
                <Button type="submit" disabled={busy !== null || !hostname.trim()}>
                  {busy === "add-custom" ? (
                    <RefreshCwIcon className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Wand2Icon className="size-4" aria-hidden />
                  )}
                  Add domain
                </Button>
              </form>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Ownership is proven with a TXT record. A CNAME is never accepted as proof of
                ownership. After verification the server provisions routing and HTTPS; the
                address is marked Active only when an HTTPS request really reaches the
                published project.
              </p>
            </section>
          ) : null}

          <section className="border-[var(--clay-line)] space-y-2 border-t pt-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Attached addresses</h3>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void load()}
                disabled={busy !== null}
              >
                <RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden />
                Refresh
              </Button>
            </div>
            {domains.length === 0 ? (
              <EmptyState
                title="No additional addresses"
                description="The canonical Mavly address above is always available. Reserve an alias or add a domain you own."
              />
            ) : (
              <ul className="space-y-2">
                {domains.map((domain) => (
                  <li
                    key={domain.id}
                    className="rounded-xl border border-[var(--clay-line)] bg-card p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm">{domain.hostname}</span>
                      <StatusPill tone={toneOf(domain.status)} dot>
                        {domainStatusLabel(domain.status)}
                      </StatusPill>
                      {domain.isPrimary ? (
                        <StatusPill tone="brand" icon={<StarIcon aria-hidden />}>
                          Primary
                        </StatusPill>
                      ) : null}
                      <span className="text-muted-foreground text-2xs">
                        {domain.domainType === "mavly_subdomain" ? "Mavly alias" : "Custom domain"}
                      </span>
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                      {domain.failureMessage || domainStatusHelp(domain.status)}
                    </p>
                    {domain.failureCode ? (
                      <p className="text-muted-foreground mt-1 font-mono text-2xs">
                        {domain.failureCode}
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void showDetail(domain.id)}
                        disabled={busy !== null}
                      >
                        DNS details
                      </Button>
                      {canVerify(domain) ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void act(domain, "verify")}
                          disabled={busy !== null}
                        >
                          Verify ownership
                        </Button>
                      ) : null}
                      {capability?.provisioningEnabled && canProvision(domain) ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void act(domain, "retry")}
                          disabled={busy !== null}
                        >
                          Provision
                        </Button>
                      ) : null}
                      {domain.domainType === "custom" &&
                      domain.status === "active" &&
                      !domain.isPrimary ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void act(domain, "primary")}
                          disabled={busy !== null}
                        >
                          Make primary
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setRemoving(domain)}
                        disabled={busy !== null}
                      >
                        <Trash2Icon className="size-3.5" aria-hidden />
                        Remove
                      </Button>
                    </div>
                    {domain.status === "active" ? (
                      <p className="text-success mt-2 flex items-center gap-1.5 text-xs">
                        <CheckCircle2Icon className="size-3.5" aria-hidden />
                        Verified, HTTPS active and routed to this project.
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {detail ? (
            <section className="border-[var(--clay-line)] space-y-2 border-t pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium">{detail.hostname}</h3>
                <StatusPill tone={toneOf(detail.status)} dot>
                  {domainStatusLabel(detail.status)}
                </StatusPill>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setDetail(null)}
                >
                  Close
                </Button>
              </div>
              {detail.domainType === "custom" ? (
                <Instructions
                  instructions={detail.instructions}
                  capability={
                    capability ?? {
                      enabled: false,
                      customDomainsEnabled: false,
                      subdomainAliasesEnabled: false,
                      provisioningEnabled: false,
                      requireRoutingApproval: true,
                      hasRoutingTarget: false,
                      hasApexTarget: false,
                      problem: "Domain capability could not be read.",
                    }
                  }
                />
              ) : (
                <p className="text-muted-foreground text-xs leading-relaxed">
                  This is a Mavly-managed alias. It needs no DNS records from you; routing is
                  provisioned by the platform after the project is published.
                </p>
              )}
            </section>
          ) : null}

          {overview && overview.domains.some((domain) => domain.status === "misconfigured") ? (
            <Callout tone="warning" title="Some addresses are misconfigured">
              <span className="flex items-center gap-1.5">
                <AlertTriangleIcon className="size-3.5 shrink-0" aria-hidden />
                Fix the DNS records shown in the details, then retry verification or provisioning.
              </span>
            </Callout>
          ) : null}
        </div>
      </Modal>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
        title={`Remove ${removing?.hostname ?? "this domain"}?`}
        description="The address stops resolving to this project. The audit history is kept, and the hostname can be attached again later."
        confirmLabel="Remove domain"
        tone="danger"
        onConfirm={() => {
          if (removing) void act(removing, "remove");
          setRemoving(null);
        }}
      />
    </>
  );
}
