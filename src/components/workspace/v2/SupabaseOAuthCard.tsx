"use client";

/**
 * ═══ CONNECT YOUR OWN BACKEND — SUPABASE MANAGEMENT API OAUTH ═══════════════
 *
 * Card 2 of the Backend & Source Control Center.
 *
 * ⚠️ THERE IS NO CREDENTIAL FORM HERE. The user authorizes Mavly in Supabase's
 * own consent screen; Mavly never asks for a service-role key, an anon key or a
 * database password, and never displays one. The only secret that exists is the
 * OAuth token pair, which lives encrypted on the server.
 *
 * ⚠️ THIS COMPONENT NEVER SEES A TOKEN. The callback stores the token pair
 * server-side and returns a project list; selection sends back only a project
 * ref, which the server re-verifies against the live project list.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { StatusPill, type StatusTone } from "@/components/primitives";
import { toast } from "@/lib/toast";
import { LoaderIcon } from "lucide-react";

/* ───────────────────────────── Types ──────────────────────────────────── */

type ConnectionStatus =
  | "pending_selection"
  | "connected"
  | "expired"
  | "revoked"
  | "reconnection_required";

interface ConnectionView {
  supabaseProjectRef: string | null;
  supabaseProjectName: string | null;
  organizationSlug: string | null;
  status: ConnectionStatus;
  grantedScopes: string[];
  accessTokenExpiresAt: string | null;
  lastError: string | null;
  connectedAt: string | null;
  updatedAt: string | null;
}

interface ProjectOption {
  ref: string;
  name: string;
  organizationSlug: string | null;
}

interface SupabaseOAuthCardProps {
  projectId: string;
  /** Called after a successful connect/disconnect so the parent can refresh. */
  onChanged?: () => void;
  /** The existing card chrome, so this card matches the other two exactly. */
  renderCard: (input: {
    headingId: string;
    status: React.ReactNode;
    children: React.ReactNode;
  }) => React.ReactNode;
}

const STATUS_TONE: Record<ConnectionStatus, StatusTone> = {
  pending_selection: "info",
  connected: "success",
  expired: "warning",
  revoked: "danger",
  reconnection_required: "warning",
};

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  pending_selection: "Choose a project",
  connected: "Connected",
  expired: "Authorization expired",
  revoked: "Access revoked",
  reconnection_required: "Reconnect required",
};

/* ─────────────────────────── URL handoff ──────────────────────────────── */

/* ───────────────────────────── The card ───────────────────────────────── */

export function SupabaseOAuthCard({
  projectId,
  onChanged,
  renderCard,
}: SupabaseOAuthCardProps) {
  const router = useRouter();

  const [connection, setConnection] = useState<ConnectionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<
    null | "start" | "select" | "refresh" | "disconnect"
  >(null);
  const [error, setError] = useState<string | null>(null);

  /** Set by the callback redirect, cleared once the user picks or dismisses. */
  const [options, setOptions] = useState<ProjectOption[] | null>(null);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  /**
   * ⚠️ THE SINGLE-USE SELECTION SESSION. It is issued with the project list and
   * must be presented when a project is chosen. It is what replaces the project
   * refs that used to travel in the callback URL: the browser holds an opaque id
   * that expires in minutes, not a list of customer identifiers.
   */
  const [selectionId, setSelectionId] = useState<string | null>(null);

  const base = `/api/projects/${encodeURIComponent(projectId)}/supabase`;

  const load = useCallback(async () => {
    try {
      const response = await fetch(base, { cache: "no-store" });
      const payload = (await response.json()) as {
        data?: { connection: ConnectionView | null };
        error?: { message?: string };
      };
      if (!response.ok) {
        setError(payload.error?.message ?? "The Supabase connection could not be read.");
        return;
      }
      setConnection(payload.data?.connection ?? null);
      setError(null);
    } catch {
      setError("The Supabase connection could not be read.");
    } finally {
      setLoading(false);
    }
  }, [base]);

  /**
   * Fetch the selectable projects from the authenticated endpoint.
   *
   * ⚠️ THE LIST IS NOT IN THE CALLBACK URL ANY MORE. It is derived server-side
   * from the encrypted token, so customer project refs and names never appear in
   * browser history, access logs or referrer headers.
   */
  const loadOptions = useCallback(async () => {
    try {
      const response = await fetch(`${base}/projects`, { cache: "no-store" });
      const payload = (await response.json()) as {
        data?: { projects?: ProjectOption[]; selectionId?: string };
        error?: { message?: string };
      };
      if (!response.ok) {
        setError(payload.error?.message ?? "Your Supabase projects could not be listed.");
        return;
      }
      setOptions(payload.data?.projects ?? []);
      /**
       * ⚠️ WITHOUT A SESSION THE PICKER CANNOT SUBMIT. The server refuses a
       * selection that presents no valid session, so a missing id is surfaced
       * here rather than as a confusing failure on submit.
       */
      setSelectionId(payload.data?.selectionId ?? null);
    } catch {
      setError("Your Supabase projects could not be listed.");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * ⚠️ THE CALLBACK PARAMETERS ARE READ ONCE AND THEN REMOVED FROM THE URL. A
   * refresh must not re-open the picker for a flow the user already finished, and
   * the project list should not linger in the address bar.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("supabase");
    if (!outcome) return;

    if (outcome === "select") {
      /**
       * ⚠️ THE OPTIONS COME FROM THE SERVER, NOT THE URL. The callback no longer
       * carries project refs or names, so the picker asks the authenticated
       * endpoint for the list the stored token can actually see.
       */
      void loadOptions();
    } else if (outcome === "error") {
      const reason = params.get("reason") ?? "";
      setError(
        reason.includes("denied")
          ? "Supabase authorization was declined."
          : reason.includes("state")
            ? "That authorization link expired. Try connecting again."
            : "The Supabase connection could not be completed.",
      );
    }

    const url = new URL(window.location.href);
    for (const key of ["supabase", "projects", "project", "reason"]) {
      url.searchParams.delete(key);
    }
    window.history.replaceState({}, "", url.toString());
    void load();
  }, [load, loadOptions]);

  const start = async () => {
    setPending("start");
    setError(null);
    try {
      const response = await fetch(`${base}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnTo: window.location.pathname }),
      });
      const payload = (await response.json()) as {
        data?: { authorizationUrl?: string };
        error?: { message?: string };
      };
      if (!response.ok || !payload.data?.authorizationUrl) {
        setError(payload.error?.message ?? "The Supabase connection could not be started.");
        return;
      }
      // A full navigation: Supabase's consent screen is a different origin.
      window.location.assign(payload.data.authorizationUrl);
    } catch {
      setError("The Supabase connection could not be started.");
    } finally {
      setPending(null);
    }
  };

  const select = async () => {
    if (!selectedRef || !selectionId) return;
    setPending("select");
    setError(null);
    try {
      const response = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "select",
          supabaseProjectRef: selectedRef,
          /**
           * ⚠️ THE SESSION IS SENT WITH THE REF. The ref alone is not proof of
           * intent; the session binds this selection to the authenticated user
           * and the OAuth connection, and is consumed by it.
           */
          selectionId,
        }),
      });
      const payload = (await response.json()) as {
        data?: { connection: ConnectionView };
        error?: { message?: string };
      };
      if (!response.ok || !payload.data) {
        setError(payload.error?.message ?? "That project could not be connected.");
        return;
      }
      setConnection(payload.data.connection);
      setOptions(null);
      setSelectedRef(null);
      setSelectionId(null);
      toast.success("Supabase project connected.");
      onChanged?.();
      router.refresh();
    } catch {
      setError("That project could not be connected.");
    } finally {
      setPending(null);
    }
  };

  const refresh = async () => {
    setPending("refresh");
    setError(null);
    try {
      const response = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh" }),
      });
      const payload = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        setError(payload.error?.message ?? "The authorization could not be refreshed.");
        await load();
        return;
      }
      toast.success("Supabase authorization refreshed.");
      await load();
    } catch {
      setError("The authorization could not be refreshed.");
    } finally {
      setPending(null);
    }
  };

  const disconnect = async () => {
    setPending("disconnect");
    setError(null);
    try {
      const response = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disconnect" }),
      });
      const payload = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        setError(payload.error?.message ?? "The connection could not be removed.");
        return;
      }
      setConnection(null);
      toast.success("Supabase disconnected. Your Supabase project was not changed.");
      onChanged?.();
      router.refresh();
    } catch {
      setError("The connection could not be removed.");
    } finally {
      setPending(null);
    }
  };

  const isConnected = connection?.status === "connected";
  const needsReconnect =
    connection?.status === "expired" ||
    connection?.status === "revoked" ||
    connection?.status === "reconnection_required";

  const status = useMemo(() => {
    if (loading) return <StatusPill tone="neutral" size="sm">Checking</StatusPill>;
    if (!connection) return <StatusPill tone="neutral" size="sm">Not connected</StatusPill>;
    return (
      <StatusPill tone={STATUS_TONE[connection.status]} size="sm">
        {STATUS_LABEL[connection.status]}
      </StatusPill>
    );
  }, [connection, loading]);

  const body = (
    <>
      {/* ── Connected summary ─────────────────────────────────────────── */}
      {isConnected && connection ? (
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Project</dt>
            <dd className="font-medium text-foreground">
              {connection.supabaseProjectName ?? connection.supabaseProjectRef}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Reference</dt>
            <dd className="font-mono text-xs text-foreground">
              {connection.supabaseProjectRef}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              Organization
            </dt>
            <dd className="font-medium text-foreground">
              {connection.organizationSlug ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              Granted scopes
            </dt>
            <dd className="font-medium text-foreground">
              {connection.grantedScopes.length > 0
                ? connection.grantedScopes.join(", ")
                : "None reported"}
            </dd>
          </div>
        </dl>
      ) : null}

      {/* ── Reconnection notice ───────────────────────────────────────── */}
      {needsReconnect ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {connection?.lastError ??
            "Mavly's access to your Supabase project ended. Reconnect to restore it."}
        </p>
      ) : null}

      {/* ── Project picker ────────────────────────────────────────────── */}
      {options ? (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Choose the Supabase project this Mavly project should use.
          </p>
          {options.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This authorization can see no Supabase projects. Create one in Supabase, or
              check that the app was granted project access, then connect again.
            </p>
          ) : (
            <ul className="space-y-2">
              {options.map((option) => (
                <li key={option.ref}>
                  <label
                    className={[
                      "flex cursor-pointer items-center gap-3 rounded-[var(--clay-r-md)] border p-3",
                      "border-[var(--clay-line)] transition-colors",
                      selectedRef === option.ref
                        ? "border-[var(--clay-line-strong)] bg-[var(--clay-sunken)]"
                        : "hover:border-[var(--clay-line-strong)]",
                    ].join(" ")}
                  >
                    <input
                      type="radio"
                      name="supabase-project"
                      value={option.ref}
                      checked={selectedRef === option.ref}
                      onChange={() => setSelectedRef(option.ref)}
                      className="size-4 accent-[var(--brand)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {option.name}
                      </span>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {option.ref}
                        {option.organizationSlug ? ` · ${option.organizationSlug}` : ""}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => void select()}
              disabled={pending !== null || !selectedRef || !selectionId}
            >
              {pending === "select" ? (
                <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              Use this project
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOptions(null);
                setSelectedRef(null);
              }}
              disabled={pending !== null}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {/* ── Actions ───────────────────────────────────────────────────── */}
      {!options ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={isConnected ? "outline" : "default"}
            onClick={() => void start()}
            disabled={pending !== null || loading}
          >
            {pending === "start" ? (
              <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {isConnected ? "Reconnect Supabase" : "Connect Supabase"}
          </Button>

          {needsReconnect ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refresh()}
              disabled={pending !== null}
            >
              {pending === "refresh" ? (
                <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              Try refresh
            </Button>
          ) : null}

          {connection ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void disconnect()}
              disabled={pending !== null}
            >
              {pending === "disconnect" ? (
                <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              Disconnect
            </Button>
          ) : null}
        </div>
      ) : null}

      <p className="mt-3 text-xs text-muted-foreground">
        Mavly never asks for your service-role key. Access is granted through Supabase&apos;s
        own consent screen and can be revoked there at any time. Disconnecting removes
        Mavly&apos;s access only; your Supabase project and its data are untouched.
      </p>
    </>
  );

  return renderCard({ headingId: "backend-supabase-heading", status, children: body });
}
