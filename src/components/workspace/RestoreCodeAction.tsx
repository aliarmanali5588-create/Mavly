"use client";

import * as React from "react";
import { History, Loader2, TriangleAlert } from "lucide-react";

import { ConfirmDialog } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { toast } from "@/lib/toast";
import { vcaasApi } from "@/lib/vcaas";
import type { ProjectSnapshotDetail } from "@/lib/vcaas-types";

/**
 * ═══ THE "RESTORE CODE" ACTION ═════════════════════════════════════════════
 *
 * It belongs to ONE execution: the message that carries the `restoreSnapshotId`
 * the server wrote when that run changed the project's source. The button is
 * therefore bound to PERSISTED state, not to transient client state — a reload
 * shows the same action for the same run, and a run that changed nothing has
 * no button at all.
 *
 * ⚠️ WHAT IT RESTORES. The snapshot holds the state from BEFORE the run, so
 * pressing it undoes the run: files the agent deleted come back, files it
 * rewrote go back to what they were, and files it added are removed.
 *
 * ⚠️ THE CONFIRMATION IS NOT A FORMALITY. It names the recovery point and the
 * files it holds, because the restore replaces the whole project source.
 *
 * ⚠️ A STALE RESTORE IS REFUSED. The recovery point's detail carries the hash
 * of the project's source at the moment it was read; it is sent back with the
 * restore, and the server refuses if the project changed in the meantime.
 *
 * ⚠️ THE RESTORE IS RECOVERABLE. The server captures the current state before
 * it writes anything, so the restore itself can be undone.
 */
export interface RestoreCodeActionProps {
  projectId: string;
  /** The snapshot this action restores. */
  snapshotId: string;
  /** Called after a successful restore, so the workspace can refresh. */
  onRestored?: () => void;
  className?: string;
}

type Phase = "idle" | "loading" | "confirming" | "restoring" | "failed";

export function RestoreCodeAction({
  projectId,
  snapshotId,
  onRestored,
  className,
}: RestoreCodeActionProps) {
  const t = useT();
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [detail, setDetail] = React.useState<ProjectSnapshotDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const openDetail = React.useCallback(async () => {
    if (phase === "loading" || phase === "restoring") return;
    setPhase("loading");
    setError(null);

    const response = await vcaasApi.snapshots.detail(projectId, snapshotId);
    if (!response.ok || !response.data) {
      setPhase("failed");
      setError(response.error || t("workspace.restore.unavailable"));
      return;
    }
    if (response.data.status !== "ready" || response.data.files.length === 0) {
      setPhase("failed");
      setError(t("workspace.restore.unavailable"));
      return;
    }

    setDetail(response.data);
    setPhase("confirming");
  }, [phase, projectId, snapshotId, t]);

  const confirmRestore = React.useCallback(async () => {
    if (!detail) return;
    setPhase("restoring");
    setError(null);

    const response = await vcaasApi.snapshots.restore(projectId, snapshotId, {
      expectedSourceHash: detail.projectSourceHash,
    });

    if (!response.ok) {
      setPhase("failed");
      setError(response.error || t("workspace.restore.failed"));
      // The confirmation closes and the reason is shown next to the button, so
      // the failure is visible instead of being swallowed by a closed dialog.
      throw new Error(response.error || "restore failed");
    }

    setDetail(null);
    setPhase("idle");
    toast.success(t("workspace.restore.restored"));
    onRestored?.();
  }, [detail, projectId, snapshotId, t, onRestored]);

  const busy = phase === "loading" || phase === "restoring";

  return (
    <>
      <div className={className}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void openDetail()}
          className="h-7 gap-1.5 px-2.5 text-xs"
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <History className="size-3.5" aria-hidden />
          )}
          {t("workspace.restore.button")}
        </Button>

        {error ? (
          <p className="text-destructive mt-1.5 flex items-start gap-1.5 text-xs">
            <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
            {error}
          </p>
        ) : null}
      </div>

      <ConfirmDialog
        open={phase === "confirming"}
        onOpenChange={open => {
          if (!open && phase === "confirming") {
            setPhase("idle");
            setDetail(null);
          }
        }}
        title={t("workspace.restore.title")}
        description={t("workspace.restore.description")}
        confirmLabel={t("workspace.restore.confirm")}
        cancelLabel={t("workspace.restore.cancel")}
        onConfirm={confirmRestore}
      >
        {detail ? (
          <div className="space-y-2 text-xs">
            <p className="text-muted-foreground">
              {t("workspace.restore.files", { count: detail.files.length })}
            </p>
            <ul className="text-muted-foreground max-h-40 space-y-0.5 overflow-auto font-mono">
              {detail.files.slice(0, 40).map(file => (
                <li key={file.path} className="truncate">
                  {file.path}
                </li>
              ))}
            </ul>
            {detail.files.length > 40 ? (
              <p className="text-muted-foreground">
                +{detail.files.length - 40} more
              </p>
            ) : null}
          </div>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
