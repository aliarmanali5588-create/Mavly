"use client";

import * as React from "react";
import {
  CheckCircle2Icon,
  DatabaseIcon,
  ExternalLinkIcon,
  GithubIcon,
  LoaderIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { ConfirmDialog, StatusPill, type StatusTone } from "@/components/primitives";
import { SupabaseOAuthCard } from "@/components/workspace/v2/SupabaseOAuthCard";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import type { VcaasProject } from "@/lib/vcaas-types";
import {
  BACKEND_PROVIDER_LABELS,
  BACKEND_STATE_LABELS,
  type BackendCenterView,
  type BackendConnectionState,
  type BackendProvider,
  type BackendProviderView,
} from "@/lib/backend-providers/types";

/**
 * ═══ BACKEND & SOURCE CONTROL CENTER ════════════════════════════════════════
 *
 * Three separate cards, because they are three separate decisions:
 *
 *   1. Mavly-managed database  — the platform provisions and owns it.
 *   2. Your own Supabase       — the customer owns it; Mavly holds a key.
 *   3. GitHub                  — source control, INDEPENDENT of the backend.
 *
 * ⚠️ GITHUB IS NOT A BACKEND. It is rendered here because the brief asks for one
 * page, but it never participates in provider selection and the page works fully
 * without it.
 *
 * ⚠️ NO ELEVATION ON HOVER. Cards use the clay material and change only their
 * border and shadow depth; nothing translates or scales. Interactive cards get
 * the press-in treatment on `:active` only.
 */

/**
 * The managed backend's lifecycle state, as the backend route reports it.
 * `state` is the lifecycle fact; `enrollment` is the authorization fact. They are
 * deliberately separate: an approved enrollment with no database is real.
 */
interface ManagedBackendPayload {
  state: string | null;
  enrollment: { state: string; reasonCode: string | null } | null;
}

interface BackendCenterProps {
  project: VcaasProject;
  /** Opens the existing GitHub dialog; this page never reimplements it. */
  onOpenGithub: () => void;
  githubConnected: boolean;
}

const STATE_TONE: Record<BackendConnectionState, StatusTone> = {
  not_connected: "neutral",
  connecting: "info",
  provisioning: "info",
  ready: "success",
  failed: "danger",
  suspended: "warning",
  disconnecting: "info",
  reconnection_required: "warning",
};

const IN_FLIGHT: ReadonlySet<BackendConnectionState> = new Set([
  "connecting",
  "provisioning",
  "disconnecting",
]);

/** The clay card shell. Static by default; interactive cards opt in. */
function ClayCard({
  children,
  interactive = false,
  labelledBy,
}: {
  children: React.ReactNode;
  interactive?: boolean;
  labelledBy?: string;
}) {
  return (
    <section
      aria-labelledby={labelledBy}
      className={[
        "rounded-[var(--clay-r-xl)] border border-[var(--clay-line)] bg-card p-5 sm:p-6",
        "shadow-[var(--clay-elev-2)] transition-[box-shadow,border-color] duration-200",
        interactive
          ? "hover:border-[var(--clay-line-strong)] active:shadow-[var(--clay-well-2)]"
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </section>
  );
}

function CardHeading({
  id,
  icon,
  title,
  description,
  status,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  status?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className="grid size-11 shrink-0 place-items-center rounded-[var(--clay-r-md)] border border-[var(--clay-line)] bg-[var(--clay-sunken)] shadow-[var(--clay-well-1)]"
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={id} className="text-base font-semibold tracking-tight text-foreground">
            {title}
          </h3>
          {status}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

/**
 * The official Supabase mark, loaded from the existing asset. It is decorative:
 * the card's heading carries the meaning, so the image is hidden from assistive
 * technology rather than given a redundant label.
 */
function SupabaseMark() {
  return (
    <img
      src="/svg/supabase.svg"
      alt=""
      aria-hidden="true"
      width={22}
      height={22}
      className="size-[22px]"
    />
  );
}

function GithubMark() {
  return (
    <img
      src="/svg/github.svg"
      alt=""
      aria-hidden="true"
      width={22}
      height={22}
      className="size-[22px]"
    />
  );
}

function StatePill({ state }: { state: BackendConnectionState }) {
  const inFlight = IN_FLIGHT.has(state);
  return (
    <StatusPill
      tone={STATE_TONE[state]}
      size="sm"
      dot
      pulse={inFlight}
      icon={inFlight ? <LoaderIcon className="size-3 animate-spin" aria-hidden="true" /> : undefined}
    >
      {BACKEND_STATE_LABELS[state]}
    </StatusPill>
  );
}

/**
 * The managed backend's state comes from the lifecycle projection the backend
 * route returns, not from a second source of truth.
 */
function managedStateOf(payload: ManagedBackendPayload | null): BackendConnectionState {
  const state = payload?.state;
  switch (state) {
    case "ready":
      return "ready";
    case "provisioning":
    case "provisioned":
    case "configuring":
      return "provisioning";
    case "failed":
      return "failed";
    case "outcome_unknown":
    case "cleanup_pending":
      return "reconnection_required";
    default:
      return "not_connected";
  }
}

export function BackendCenter({ project, onOpenGithub, githubConnected }: BackendCenterProps) {
  const projectId = project.projectId;
  const [center, setCenter] = React.useState<BackendCenterView | null>(null);
  const [managedBackend, setManagedBackend] = React.useState<ManagedBackendPayload | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<string | null>(null);

  // Switch confirmation
  const [switchTarget, setSwitchTarget] = React.useState<BackendProvider | null>(null);
  const [switchMessage, setSwitchMessage] = React.useState<string | null>(null);

  const managedState = managedStateOf(managedBackend);

  const load = React.useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/backend-providers`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        data?: { center?: BackendCenterView; managedBackend?: ManagedBackendPayload };
        error?: { message?: string };
      };
      if (!response.ok || payload.ok === false) {
        setError(payload.error?.message ?? "The backend settings could not be loaded.");
        return;
      }
      setCenter(payload.data?.center ?? null);
      setManagedBackend(payload.data?.managedBackend ?? null);
      setError(null);
    } catch {
      setError("The backend settings could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const supabaseRow: BackendProviderView | null =
    center?.providers.find((entry) => entry.provider === "external_supabase") ?? null;

  const activeProvider: BackendProvider | null =
    center?.activeProvider ?? (managedState === "ready" ? "mavly_managed_neon" : null);

  const managedActive = activeProvider === "mavly_managed_neon";
  const supabaseActive = activeProvider === "external_supabase";

  const post = React.useCallback(
    async (body: Record<string, unknown>) => {
      const response = await fetch(`/api/projects/${projectId}/backend-providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: { code?: string; message?: string };
      };
      return { response, payload };
    },
    [projectId],
  );

  const requestSwitch = async (target: BackendProvider) => {
    setPending(`switch:${target}`);
    try {
      const { response, payload } = await post({ action: "switch", provider: target });
      if (response.status === 409 && payload.error?.code === "BACKEND_SWITCH_CONFIRMATION_REQUIRED") {
        /**
         * The server asks for confirmation rather than assuming it. The dialog
         * shows the server's own message so the two cannot drift apart.
         */
        setSwitchMessage(payload.error.message ?? null);
        setSwitchTarget(target);
        return;
      }
      if (!response.ok || payload.ok === false) {
        toast.error(payload.error?.message ?? "The backend could not be switched.");
        return;
      }
      toast.success(`Now using ${BACKEND_PROVIDER_LABELS[target]}.`);
      await load();
    } catch {
      toast.error("The backend could not be switched.");
    } finally {
      setPending(null);
    }
  };

  const confirmSwitch = async () => {
    if (!switchTarget) return;
    const target = switchTarget;
    setSwitchTarget(null);
    setPending(`switch:${target}`);
    try {
      const { response, payload } = await post({
        action: "switch",
        provider: target,
        confirmed: true,
      });
      if (!response.ok || payload.ok === false) {
        toast.error(payload.error?.message ?? "The backend could not be switched.");
        return;
      }
      toast.success(`Now using ${BACKEND_PROVIDER_LABELS[target]}.`);
      await load();
    } catch {
      toast.error("The backend could not be switched.");
    } finally {
      setPending(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
        Loading backend settings…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Backend &amp; Source Control
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose where your app stores its data, and connect the repository that holds its
          source. Only one backend is active at a time.
        </p>
      </header>

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-[var(--clay-r-lg)] border border-[var(--clay-line)] bg-destructive-subtle p-3 text-sm text-destructive-subtle-foreground shadow-[var(--clay-well-1)]"
        >
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      {/* ── 1. Mavly-managed backend ─────────────────────────────────────── */}
      <ClayCard labelledBy="backend-mavly-heading">
        <CardHeading
          id="backend-mavly-heading"
          icon={<DatabaseIcon className="size-5 text-foreground" aria-hidden="true" />}
          title="Enable Backend on Mavly"
          description="Mavly provisions and manages a PostgreSQL database for this project, including schema, authentication tables and backups."
          status={<StatePill state={managedState} />}
        />

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {managedActive ? (
            <StatusPill tone="brand" size="sm">
              Active backend
            </StatusPill>
          ) : null}

          {managedState === "ready" && !managedActive ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void requestSwitch("mavly_managed_neon")}
              disabled={pending !== null}
            >
              {pending === "switch:mavly_managed_neon" ? (
                <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              Use this backend
            </Button>
          ) : null}

          {managedState === "not_connected" ? (
            /**
             * ⚠️ THIS DOES NOT PROVISION. Provisioning happens inside a
             * generation run, behind enrollment authorization, so this button
             * explains the next step instead of faking a database.
             */
            <p className="text-sm text-muted-foreground">
              A Mavly database is created automatically the first time a generation needs
              stored data. Nothing is provisioned until then.
            </p>
          ) : null}

          {managedState === "failed" || managedState === "reconnection_required" ? (
            <p className="text-sm text-muted-foreground">
              The database needs attention. Run a generation to retry provisioning; existing
              data is never deleted.
            </p>
          ) : null}
        </div>

        {managedBackend?.enrollment ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Authorization: {managedBackend.enrollment.state}
            {managedBackend.enrollment.reasonCode
              ? ` — ${managedBackend.enrollment.reasonCode.replace(/_/g, " ")}`
              : ""}
          </p>
        ) : null}
      </ClayCard>

      {/* ── 2. Customer-owned Supabase (Management API OAuth) ────────────── */}
      {/*
        ⚠️ THE MANUAL CREDENTIAL FORM IS GONE. There is no field for a project URL,
        an anon key or a service-role key anywhere in this page. Access is granted
        through Supabase's own consent screen, and the token pair stays encrypted
        on the server.
      */}
      <SupabaseOAuthCard
        projectId={projectId}
        onChanged={() => void load()}
        renderCard={({ headingId, status, children }) => (
          <ClayCard labelledBy={headingId}>
            <CardHeading
              id={headingId}
              icon={<SupabaseMark />}
              title="Connect Your Own Backend"
              description="Authorize Mavly to use a Supabase project you already own. You sign in to Supabase and choose the project; Mavly never asks for a service-role key."
              status={status}
            />
            {children}
          </ClayCard>
        )}
      />

      {/* The active-backend control stays with the provider registry, not the
          OAuth card: switching is a separate decision from connecting. */}
      {supabaseRow && supabaseRow.status === "ready" ? (
        <div className="flex flex-wrap items-center gap-2 px-1">
          {supabaseActive ? (
            <StatusPill tone="brand" size="sm">
              Active backend
            </StatusPill>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void requestSwitch("external_supabase")}
              disabled={pending !== null}
            >
              {pending === "switch:external_supabase" ? (
                <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              Use this backend
            </Button>
          )}
        </div>
      ) : null}

      {/* ── 3. GitHub — source control, independent of the backend ───────── */}
      <ClayCard labelledBy="backend-github-heading" interactive>
        <CardHeading
          id="backend-github-heading"
          icon={<GithubMark />}
          title="Connect GitHub"
          description="Connect a repository to push this project's source and import a branch. Source control is independent of which backend you choose."
          status={
            githubConnected ? (
              <StatusPill tone="success" size="sm" dot>
                Connected
              </StatusPill>
            ) : (
              <StatusPill tone="neutral" size="sm">
                Not connected
              </StatusPill>
            )
          }
        />

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" variant={githubConnected ? "outline" : "default"} onClick={onOpenGithub}>
            {githubConnected ? (
              <RefreshCwIcon className="size-4" aria-hidden="true" />
            ) : (
              <GithubIcon className="size-4" aria-hidden="true" />
            )}
            {githubConnected ? "Manage repository" : "Connect GitHub"}
          </Button>
          <a
            href="https://docs.github.com/en/get-started"
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            What is a repository?
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </a>
        </div>
      </ClayCard>

      <ConfirmDialog
        open={switchTarget !== null}
        onOpenChange={(open) => {
          if (!open) setSwitchTarget(null);
        }}
        title="Switch backend?"
        description={switchMessage ?? "This changes which database your app uses."}
        confirmLabel="Switch backend"
        onConfirm={() => void confirmSwitch()}
      />
    </div>
  );
}
