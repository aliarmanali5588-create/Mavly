"use client";

import * as React from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  DatabaseIcon,
  Link2Icon,
  RefreshCwIcon,
} from "lucide-react";
import { ConfirmDialog, EmptyState, SpinnerBlock } from "@/components/primitives";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useT } from "@/i18n";
import type { TranslationKey } from "@/i18n/types";
import {
  isSupabaseIntegrationFailure,
  supabaseIntegrationApi,
} from "@/lib/integrations/supabase/client";
import type {
  SupabaseIntegrationSummary,
  SupabaseOrganization,
  SupabaseProjectSummary,
} from "@/lib/integrations/supabase/types";
import { cn } from "@/lib/utils";

type Busy = "connect" | "select" | "disconnect" | null;

const CALLBACK_REASONS: Record<string, TranslationKey> = {
  not_configured: "supabase.callbackConfig",
  access_denied: "supabase.callbackDenied",
  denied: "supabase.callbackDenied",
  invalid_state: "supabase.callbackInvalid",
  state_missing: "supabase.callbackInvalid",
  state_expired: "supabase.callbackInvalid",
  state_invalid: "supabase.callbackInvalid",
  storage_failed: "supabase.callbackStorage",
  store_unavailable: "supabase.callbackStorage",
  exchange_failed: "supabase.callbackError",
  missing_code: "supabase.callbackError",
};

function formatDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toLocaleDateString();
}

export function SupabaseDatabasePanel() {
  const t = useT();
  const [summary, setSummary] = React.useState<SupabaseIntegrationSummary | null>(null);
  const [organizations, setOrganizations] = React.useState<SupabaseOrganization[]>([]);
  const [projects, setProjects] = React.useState<SupabaseProjectSummary[]>([]);
  const [selectedRef, setSelectedRef] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [discovering, setDiscovering] = React.useState(false);
  const [busy, setBusy] = React.useState<Busy>(null);
  const [configured, setConfigured] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [disconnectOpen, setDisconnectOpen] = React.useState(false);

  const discover = React.useCallback(async (preferredRef?: string) => {
    setDiscovering(true);
    setError("");
    const [orgResult, projectResult] = await Promise.all([
      supabaseIntegrationApi.organizations(),
      supabaseIntegrationApi.projects(),
    ]);

    if (isSupabaseIntegrationFailure(orgResult)) {
      setError(orgResult.error || t("supabase.loadFailed"));
      setDiscovering(false);
      return;
    }
    if (isSupabaseIntegrationFailure(projectResult)) {
      setError(projectResult.error || t("supabase.loadFailed"));
      setDiscovering(false);
      return;
    }

    setOrganizations(orgResult.data.organizations);
    setProjects(projectResult.data.projects);
    setSelectedRef((current) => {
      const next = current || preferredRef || "";
      return projectResult.data.projects.some((project) => project.ref === next)
        ? next
        : "";
    });
    setDiscovering(false);
  }, [t]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    const result = await supabaseIntegrationApi.status();

    if (isSupabaseIntegrationFailure(result)) {
      if (result.code === "SUPABASE_INTEGRATION_NOT_CONFIGURED") {
        setConfigured(false);
        setLoading(false);
        return;
      }
      setError(result.error || t("supabase.loadFailed"));
      setLoading(false);
      return;
    }

    setConfigured(true);
    setSummary(result.data);
    if (result.data.connected) {
      await discover(result.data.selectedProject?.ref);
    }
    setLoading(false);
  }, [discover, t]);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const callback = params.get("supabase");

    if (callback === "connected") {
      setNotice(t("supabase.connectedNotice"));
    } else if (callback === "error") {
      const reason = params.get("reason") ?? "";
      setError(t(CALLBACK_REASONS[reason] ?? "supabase.callbackError"));
    }

    if (callback) {
      params.delete("supabase");
      params.delete("reason");
      const query = params.toString();
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
      );
    }

    void load();
  }, [load, t]);

  const connect = async () => {
    setBusy("connect");
    setError("");
    setNotice("");
    const returnTo = `${window.location.pathname}${window.location.search}`;
    const result = await supabaseIntegrationApi.start(returnTo);
    if (isSupabaseIntegrationFailure(result)) {
      setError(result.error || t("supabase.connectFailed"));
      setBusy(null);
      return;
    }
    window.location.assign(result.data.authorizationUrl);
  };

  const saveSelection = async () => {
    if (!selectedRef) return;
    setBusy("select");
    setError("");
    setNotice("");
    const result = await supabaseIntegrationApi.select(selectedRef);
    if (isSupabaseIntegrationFailure(result)) {
      setError(result.error || t("supabase.selectFailed"));
      setBusy(null);
      return;
    }
    setSummary(result.data);
    setNotice(t("common.saved"));
    setBusy(null);
  };

  const disconnect = async () => {
    setBusy("disconnect");
    setError("");
    setNotice("");
    const result = await supabaseIntegrationApi.disconnect();
    if (isSupabaseIntegrationFailure(result)) {
      setError(result.error || t("supabase.disconnectFailed"));
      setBusy(null);
      throw new Error(result.error || t("supabase.disconnectFailed"));
    }
    setSummary({
      connected: false,
      selectedProject: null,
      connectedAt: null,
      tokenExpiresAt: null,
    });
    setOrganizations([]);
    setProjects([]);
    setSelectedRef("");
    setNotice(
      result.data.revoked === false
        ? t("supabase.disconnectLocalOnly")
        : t("supabase.disconnected"),
    );
    setBusy(null);
    setDisconnectOpen(false);
  };

  if (loading && !summary) return <SpinnerBlock label={t("common.loading")} />;

  if (!configured) {
    return (
      <EmptyState
        variant="panel"
        icon={<DatabaseIcon />}
        title={t("supabase.notConfigured")}
        description={t("supabase.notConfiguredHint")}
        actions={<Button onClick={() => void load()}>{t("common.retry")}</Button>}
      />
    );
  }

  if (!summary) {
    return (
      <EmptyState
        variant="panel"
        icon={<DatabaseIcon />}
        title={t("supabase.loadFailed")}
        description={error || t("common.loadFailedDescription")}
        actions={<Button onClick={() => void load()}>{t("common.retry")}</Button>}
      />
    );
  }

  const connected = summary.connected;
  const selected = summary.selectedProject;
  const grouped = new Map<string, { name: string; projects: SupabaseProjectSummary[] }>();
  for (const project of projects) {
    const group = grouped.get(project.organizationSlug) ?? {
      name:
        organizations.find((org) => org.slug === project.organizationSlug)?.name ??
        project.organizationSlug,
      projects: [],
    };
    group.projects.push(project);
    grouped.set(project.organizationSlug, group);
  }

  return (
    <div className="tp-scroll h-full min-h-0 overflow-y-auto px-4 py-6 sm:px-8">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold">{t("supabase.title")}</h2>
            <p className="text-muted-foreground mt-1 text-sm">{t("supabase.description")}</p>
          </div>
          <Badge variant={connected ? "secondary" : "outline"}>
            {connected ? t("supabase.connected") : t("supabase.notConnected")}
          </Badge>
        </div>

        {notice ? (
          <Alert>
            <CheckCircle2Icon />
            <AlertTitle>{t("supabase.noticeTitle")}</AlertTitle>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>{t("common.somethingWentWrong")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DatabaseIcon className="size-4" aria-hidden />
              {connected ? t("supabase.selectedProject") : t("supabase.connect")}
            </CardTitle>
            <CardDescription>
              {connected
                ? t("supabase.accountScope")
                : t("supabase.scopeNote")}
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-5">
            {!connected ? (
              <>
                <p className="text-muted-foreground text-sm">{t("supabase.connectHint")}</p>
                <Button onClick={() => void connect()} disabled={busy !== null}>
                  <Link2Icon aria-hidden />
                  {busy === "connect" ? t("supabase.connecting") : t("supabase.connect")}
                </Button>
              </>
            ) : (
              <>
                <div className="border-border rounded-lg border p-3">
                  <p className="text-muted-foreground text-xs font-medium">
                    {t("supabase.selectedProject")}
                  </p>
                  {selected ? (
                    <div className="mt-1">
                      <p className="text-sm font-medium">{selected.name}</p>
                      <p className="text-muted-foreground font-mono text-xs">
                        {selected.ref} · {selected.organizationSlug}
                      </p>
                    </div>
                  ) : (
                    <p className="text-muted-foreground mt-1 text-sm">
                      {t("supabase.noSelection")}
                    </p>
                  )}
                  {summary.connectedAt ? (
                    <p className="text-muted-foreground mt-2 text-xs">
                      {t("supabase.connectedAt", {
                        date: formatDate(summary.connectedAt),
                      })}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <label htmlFor="supabase-project" className="text-sm font-medium">
                    {t("supabase.chooseProject")}
                  </label>
                  <select
                    id="supabase-project"
                    value={selectedRef}
                    onChange={(event) => setSelectedRef(event.target.value)}
                    disabled={discovering || busy !== null}
                    className={cn(
                      "border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px]",
                    )}
                  >
                    <option value="">{t("supabase.chooseProject")}</option>
                    {[...grouped.entries()].map(([slug, group]) => (
                      <optgroup key={slug} label={group.name}>
                        {group.projects.map((project) => (
                          <option key={project.ref} value={project.ref}>
                            {project.name} · {project.ref}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {!discovering && projects.length === 0 ? (
                    <p className="text-muted-foreground text-xs">
                      {t("supabase.noProjects")}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    onClick={() => void saveSelection()}
                    disabled={!selectedRef || busy !== null || discovering}
                  >
                    {busy === "select" ? t("supabase.saving") : t("supabase.saveSelection")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void discover(selected?.ref)}
                    disabled={busy !== null || discovering}
                  >
                    <RefreshCwIcon aria-hidden />
                    {t("supabase.refresh")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void connect()}
                    disabled={busy !== null}
                  >
                    <Link2Icon aria-hidden />
                    {busy === "connect"
                      ? t("supabase.connecting")
                      : t("supabase.reconnect")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDisconnectOpen(true)}
                    disabled={busy !== null}
                  >
                    {busy === "disconnect"
                      ? t("supabase.disconnecting")
                      : t("supabase.disconnect")}
                  </Button>
                </div>
              </>
            )}

            <Alert>
              <DatabaseIcon />
              <AlertTitle>{t("supabase.phaseTitle")}</AlertTitle>
              <AlertDescription>{t("supabase.phaseNote")}</AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title={t("supabase.disconnect")}
        description={t("supabase.disconnectWarning")}
        confirmLabel={t("supabase.disconnect")}
        tone="danger"
        onConfirm={disconnect}
      />
    </div>
  );
}
