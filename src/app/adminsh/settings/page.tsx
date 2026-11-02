"use client";

import React, { useState } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Coins,
  Cpu,
  Database,
  Globe,
  Lock,
  Mail,
  RefreshCw,
  Save,
  ShieldCheck,
  Sliders,
} from "lucide-react";
import { toast } from "sonner";

import {
  settingValueAsString,
  type AdminSettingRow,
  type AdminSettingsPayload,
} from "@/lib/admin/console";
import { AdminShell } from "../components/AdminShell";
import { useAdminMutation, useAdminSettings } from "../components/useAdminConsoleData";
import {
  Badge,
  DetailRow,
  ErrorBlock,
  LoadingBlock,
  PrimaryButton,
  SecondaryButton,
  SectionCard,
  UnavailableNote,
  formatTimestamp,
} from "../components/console-ui";

/**
 * ═══ SETTINGS ═══════════════════════════════════════════════════════════════
 *
 * Two panels, and the split is the point:
 *
 *   Runtime settings  stored in `admin_settings`, written through
 *                     `admin_settings_write`, validated on the server. Only keys
 *                     in the database registry can appear, so there is no toggle
 *                     on this page that persists nothing.
 *   Deployment        model default, worker readiness, provider/payment presence,
 *                     hosting mode. These come from the environment. They are
 *                     read-only here because changing them needs a redeploy, and
 *                     a "Save" button that silently did nothing would be worse
 *                     than no button at all.
 *
 * ⚠️ THE OLD PAGE SAVED TO REACT STATE. Its "Save configuration" button showed a
 * success toast and changed nothing, and its support email was a hardcoded
 * string. Every field here reads and writes a real row.
 *
 * ⚠️ NO SECRET IS DISPLAYED. Provider and payment credentials are reported as
 * present or absent; the value never leaves the server.
 */

export default function SettingsPage() {
  const { data, loading, error, refresh } = useAdminSettings();

  return (
    <AdminShell activeNav="Settings" live>
      {loading && !data ? (
        <LoadingBlock label="Reading settings" />
      ) : error && !data ? (
        <ErrorBlock message={error} onRetry={refresh} />
      ) : !data ? (
        <ErrorBlock message="Settings returned no data." onRetry={refresh} />
      ) : (
        <>
          <RuntimeSettings payload={data} onChanged={refresh} />
          <DeploymentPanel payload={data} onRefresh={refresh} loading={loading} />
        </>
      )}
    </AdminShell>
  );
}

// ───────────────────────── runtime settings ─────────────────────────────────

function RuntimeSettings({
  payload,
  onChanged,
}: {
  payload: AdminSettingsPayload;
  onChanged: () => void;
}) {
  const groups = groupSettings(payload.settings);

  return (
    <>
      <UnavailableNote>
        These settings are stored in the database and take effect on the next request that reads
        them — nothing is cached. Every change is recorded in the audit log with its previous and new
        value.
      </UnavailableNote>

      {groups.map((group) => (
        <SectionCard
          key={group.id}
          title={group.title}
          description={group.description}
          actions={<Badge tone="neutral">{group.rows.length} setting(s)</Badge>}
        >
          <div className="space-y-3">
            {group.rows.map((row) => (
              <SettingField key={row.key} row={row} onSaved={onChanged} />
            ))}
          </div>
        </SectionCard>
      ))}
    </>
  );
}

const GROUP_META: Record<string, { title: string; description: string; icon: React.ReactNode }> = {
  announcements: {
    title: "Announcements",
    description: "Whether the published announcement feed is served.",
    icon: <Bell className="w-3.5 h-3.5 text-muted-foreground" />,
  },
  credits: {
    title: "Credits",
    description: "Limits applied to administrator credit adjustments.",
    icon: <Coins className="w-3.5 h-3.5 text-warning" />,
  },
  audit: {
    title: "Audit",
    description: "How far back the audit log page reads.",
    icon: <ShieldCheck className="w-3.5 h-3.5 text-muted-foreground" />,
  },
  console: {
    title: "Console",
    description: "Presentation values used by the admin console.",
    icon: <Sliders className="w-3.5 h-3.5 text-muted-foreground" />,
  },
};

function groupSettings(rows: AdminSettingRow[]) {
  const buckets = new Map<string, AdminSettingRow[]>();
  for (const row of rows) {
    const prefix = row.key.split(".")[0] ?? "general";
    const bucket = buckets.get(prefix) ?? [];
    bucket.push(row);
    buckets.set(prefix, bucket);
  }
  return Array.from(buckets.entries()).map(([id, bucketRows]) => ({
    id,
    title: GROUP_META[id]?.title ?? id,
    description: GROUP_META[id]?.description ?? "",
    icon: GROUP_META[id]?.icon,
    rows: bucketRows,
  }));
}

function SettingField({ row, onSaved }: { row: AdminSettingRow; onSaved: () => void }) {
  const [draft, setDraft] = useState(settingValueAsString(row));
  const mutation = useAdminMutation();

  const dirty = draft !== settingValueAsString(row);

  const save = async () => {
    let value: unknown = draft;
    if (row.kind === "boolean") value = draft === "true";
    else if (row.kind === "integer") {
      const parsed = Number.parseInt(draft, 10);
      if (!Number.isFinite(parsed)) {
        toast.error("That value must be a whole number.");
        return;
      }
      value = parsed;
    }

    const result = await mutation.run<{ message: string }>("/api/adminsh/settings/write", {
      key: row.key,
      value,
    });

    if ("error" in result) {
      toast.error(result.error);
      return;
    }
    toast.success(result.data.message);
    onSaved();
  };

  return (
    <div className="px-3 py-3 rounded-lg bg-[var(--clay-sunken)] border border-[var(--clay-line)] space-y-2">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-xs font-semibold text-foreground font-mono">{row.key}</p>
            <Badge tone={row.isDefault ? "neutral" : "positive"}>
              {row.isDefault ? "default" : "custom"}
            </Badge>
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">
            {row.description}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {row.kind === "boolean" ? (
            <select
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="h-8 px-2.5 text-xs rounded-lg bg-card border border-[var(--clay-line)] text-foreground focus:outline-none focus:ring-1 focus:ring-black"
            >
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
          ) : (
            <input
              type={row.kind === "integer" ? "number" : "text"}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="h-8 w-40 px-2.5 text-xs rounded-lg bg-card border border-[var(--clay-line)] text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-black"
            />
          )}
          <PrimaryButton onClick={save} disabled={!dirty || mutation.pending} icon={<Save className="w-3 h-3" />}>
            {mutation.pending ? "Saving…" : "Save"}
          </PrimaryButton>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground font-mono">
        <span>default: {settingValueAsString({ ...row, value: row.defaultValue })}</span>
        {row.updatedAt ? (
          <span>
            updated {formatTimestamp(row.updatedAt)}
            {row.updatedByEmail ? ` by ${row.updatedByEmail}` : ""}
          </span>
        ) : (
          <span>never changed</span>
        )}
      </div>

      {mutation.error && (
        <p className="text-[11px] text-warning-subtle-foreground">{mutation.error}</p>
      )}
    </div>
  );
}

// ───────────────────────────── deployment ───────────────────────────────────

function DeploymentPanel({
  payload,
  onRefresh,
  loading,
}: {
  payload: AdminSettingsPayload;
  onRefresh: () => void;
  loading: boolean;
}) {
  const deployment = payload.deployment;

  return (
    <SectionCard
      title="Deployment configuration"
      description="Read from this deployment's environment. Changing any of these requires a redeploy."
      actions={
        <SecondaryButton
          icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />}
          onClick={onRefresh}
          disabled={loading}
        >
          Re-read
        </SecondaryButton>
      }
    >
      <div className="space-y-2 bg-[var(--clay-sunken)] p-4 rounded-xl border border-[var(--clay-line)] text-xs shadow-[var(--clay-well-1)]">
        <DetailRow label="Environment" value={deployment.environment} />
        <DetailRow label="Release" value={deployment.version} mono />
        <DetailRow
          label="Default model"
          value={
            <span className="inline-flex items-center gap-1.5">
              <Cpu className="w-3 h-3 text-muted-foreground" />
              <span className="font-mono">{deployment.defaultModel}</span>
            </span>
          }
        />
        <DetailRow
          label="Model catalog"
          value={`${deployment.modelCatalog.length} configured`}
        />
        <DetailRow
          label="Generation worker"
          value={
            <span className="inline-flex items-center gap-1.5">
              {deployment.workerConfigured ? (
                <CheckCircle2 className="w-3 h-3 text-success" />
              ) : (
                <AlertTriangle className="w-3 h-3 text-warning" />
              )}
              {deployment.workerConfigured ? "credentials present" : "not configured"}
            </span>
          }
        />
        <DetailRow
          label="AI provider"
          value={
            <span className="inline-flex items-center gap-1.5">
              {deployment.providerConfigured ? (
                <Lock className="w-3 h-3 text-success" />
              ) : (
                <AlertTriangle className="w-3 h-3 text-warning" />
              )}
              {deployment.providerConfigured ? "key present (not shown)" : "not configured"}
            </span>
          }
        />
        <DetailRow
          label="Payment gateway"
          value={
            deployment.paymentGateway ? (
              <span className="inline-flex items-center gap-1.5">
                <Lock className="w-3 h-3 text-success" />
                {deployment.paymentGateway} (keys present, not shown)
              </span>
            ) : (
              "not configured"
            )
          }
        />
        <DetailRow
          label="Artifact storage"
          value={
            <span className="inline-flex items-center gap-1.5">
              <Database className="w-3 h-3 text-muted-foreground" />
              {deployment.storageConfigured ? "configured" : "not configured"}
            </span>
          }
        />
        <DetailRow
          label="Hosting mode"
          value={
            <span className="inline-flex items-center gap-1.5">
              <Globe className="w-3 h-3 text-muted-foreground" />
              {deployment.hostingMode ?? "none enabled"}
            </span>
          }
        />
      </div>

      <div className="mt-3">
        <UnavailableNote>
          These values are read-only here on purpose. They live in the deployment's environment, so a
          form on this page could not change them — it could only pretend to. Provider and payment
          credentials are reported as present or absent and are never displayed.
        </UnavailableNote>
      </div>

      <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-[11px] text-muted-foreground leading-relaxed">
        <Mail className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>
          The support address shown in this console is the{" "}
          <span className="font-mono">console.support_email</span> setting above. It is a console
          presentation value; it does not change the address printed on public marketing pages.
        </span>
      </div>
    </SectionCard>
  );
}
