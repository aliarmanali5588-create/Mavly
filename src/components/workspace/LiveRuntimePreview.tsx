"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ExternalLink,
  FileTerminal,
  Loader2,
  Play,
  RotateCw,
  Square,
} from "lucide-react";

import { vcaasApi } from "@/lib/vcaas";
import type {
  RuntimeSandboxStatus,
  RuntimeSandboxView,
} from "@/lib/runtime-sandbox/types";

interface LiveRuntimePreviewProps {
  projectId: string;
  /** The existing static preview. It stays mounted (hidden) while the live view is shown. */
  children: ReactNode;
  /** Bumped when the project's source changes, so the status is re-read. */
  refreshKey?: number;
  mobilePreview?: boolean;
}

const POLL_INTERVAL_MS = 2_500;
const MAX_POLLS = 160;

function stateLabel(session: RuntimeSandboxView | null): string {
  if (!session) return "Static preview";
  switch (session.state) {
    case "provisioning":
      return "Preparing isolated sandbox…";
    case "syncing":
      return "Copying project files…";
    case "installing":
      return "Installing dependencies…";
    case "starting":
      return "Starting Vite dev server…";
    case "ready":
      return "Live sandbox runtime";
    case "stopping":
      return "Stopping sandbox…";
    case "stopped":
      return "Sandbox stopped";
    case "expired":
      return "Sandbox expired";
    case "failed":
      return "Runtime failed";
    default:
      return "Static preview";
  }
}

function stateTone(session: RuntimeSandboxView | null): string {
  if (!session) return "bg-gray-400";
  if (session.state === "ready") return "bg-emerald-500";
  if (session.state === "failed" || session.state === "expired") return "bg-amber-500";
  if (session.state === "stopped") return "bg-gray-400";
  return "bg-sky-500";
}

function isPending(session: RuntimeSandboxView | null): boolean {
  return (
    !!session &&
    ["provisioning", "syncing", "installing", "starting", "stopping"].includes(session.state)
  );
}

function checkTone(status: string): string {
  if (status === "passed") return "text-emerald-600 dark:text-emerald-400";
  if (status === "failed") return "text-red-600 dark:text-red-400";
  if (status === "pending") return "text-sky-600 dark:text-sky-400";
  return "text-gray-400";
}

/**
 * ═══ LIVE SANDBOX PREVIEW ══════════════════════════════════════════════════
 *
 * The static preview is the default and remains the fallback. This component
 * only takes over when the authenticated backend reports a validated `ready`
 * E2B session, whose preview URL was derived server-side from the provider's
 * own host. The browser never supplies that URL.
 *
 * ⚠️ NAVIGATION OR REFRESH NEVER CREATES A SANDBOX. Only the Start/Restart
 * buttons do, and they are disabled while an operation is in flight, so a
 * refresh cannot start a second install or a second dev server.
 *
 * ⚠️ THE STATIC PANEL STAYS MOUNTED. Hiding it rather than unmounting keeps the
 * existing visual-editor frame and its state alive while the live view is shown.
 */
export function LiveRuntimePreview({
  projectId,
  children: fallback,
  refreshKey = 0,
  mobilePreview = false,
}: LiveRuntimePreviewProps) {
  const [status, setStatus] = useState<RuntimeSandboxStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [polling, setPolling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Remounts only the iframe; it never starts or restarts the sandbox. */
  const [frameNonce, setFrameNonce] = useState(0);

  const mountedRef = useRef(true);
  const pollsRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const load = useCallback(
    async (options: { logs?: boolean } = {}) => {
      const response = await vcaasApi.runtime.status(projectId, options);
      if (!mountedRef.current) return null;
      if (response.ok && response.data) {
        setStatus(response.data);
        setError(null);
        return response.data;
      }
      setError(response.error ?? "Could not read the live preview state.");
      return null;
    },
    [projectId],
  );

  useEffect(() => {
    pollsRef.current = 0;
    setPolling(false);
    setLogsOpen(false);
    setNotice(null);
    void load();
  }, [projectId, load]);

  useEffect(() => {
    // A new generation changed the source: re-read the state, never auto-start.
    if (refreshKey === 0) return;
    void load();
  }, [refreshKey, load]);

  const session = status?.session ?? null;
  const pending = isPending(session);
  const live =
    session?.state === "ready" && !!session.previewUrl && !busy;

  /**
   * Poll only while this component observed a start/stop. It stops on a
   * terminal state and after a bounded number of attempts, so a provider that
   * never finishes cannot leave an infinite loop behind.
   */
  useEffect(() => {
    if (!polling || !pending) return;
    if (pollsRef.current >= MAX_POLLS) {
      setPolling(false);
      setNotice("This is taking longer than expected. Check the logs or try again.");
      return;
    }
    pollsRef.current += 1;
    timerRef.current = setTimeout(async () => {
      const next = await load({ logs: true });
      if (!mountedRef.current) return;
      if (!next || !isPending(next.session)) setPolling(false);
    }, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [polling, pending, load, session?.state, session?.updatedAt]);

  const invoke = useCallback(
    async (action: "start" | "restart" | "stop") => {
      if (busy) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      const response =
        action === "start"
          ? await vcaasApi.runtime.start(projectId)
          : action === "restart"
            ? await vcaasApi.runtime.restart(projectId)
            : await vcaasApi.runtime.stop(projectId);
      if (!mountedRef.current) return;
      setBusy(false);

      const next = response.ok && response.data ? response.data.status : null;
      if (next) setStatus(next);

      if (!response.ok) {
        setError(response.error ?? "The runtime request failed.");
        if (next && isPending(next.session)) {
          pollsRef.current = 0;
          setPolling(true);
        }
        return;
      }
      if (action === "stop") {
        setPolling(false);
        setLogsOpen(false);
        return;
      }
      pollsRef.current = 0;
      setPolling(!!next && isPending(next.session));
      if (response.data?.outcome === "reused") setNotice("Reused the running sandbox.");
    },
    [busy, projectId],
  );

  const refreshLogs = useCallback(async () => {
    const next = await load({ logs: true });
    if (!next) return;
    setLogsOpen(true);
  }, [load]);

  /** The one approved QA build. No arguments; the server owns the command. */
  const runBuild = useCallback(async () => {
    if (building) return;
    setBuilding(true);
    setError(null);
    setNotice(null);
    const response = await vcaasApi.runtime.build(projectId);
    if (!mountedRef.current) return;
    setBuilding(false);
    if (!response.ok) {
      setError(response.error ?? "The build request failed.");
      return;
    }
    const check = response.data?.check;
    setLogsOpen(true);
    if (check) setNotice(`${check.label}: ${check.status}${check.detail ? ` — ${check.detail}` : ""}`);
    await load({ logs: true });
  }, [building, load, projectId]);

  // Not loaded yet: render the existing static preview only.
  if (!status) return <>{fallback}</>;

  /**
   * Feature off stays silent (the static preview is the product default), but an
   * enabled deployment that cannot run — misconfigured, missing migration, wrong
   * project — says why instead of silently hiding the capability.
   */
  if (!status.capability.available) {
    const showReason = status.capability.reason && status.capability.reason !== "disabled";
    if (!showReason) return <>{fallback}</>;
    return (
      <div className="flex h-full min-h-0 flex-col">
        <p className="shrink-0 border-b border-amber-200/60 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          Static preview · {status.capability.message ?? "Live runtime previews are unavailable."}
        </p>
        <div className="relative min-h-0 flex-1">{fallback}</div>
      </div>
    );
  }

  const failed = session?.state === "failed" || session?.state === "expired";
  const stopped = session?.state === "stopped";
  const canStart = !pending && !busy && (!session || failed || stopped);
  const canRestart = !busy && !pending && !!session && !failed && !stopped;
  const canStop = !busy && !!session && !stopped && !failed;
  const unsupported = !status.support.supported;

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--neu-line)] bg-card/90 px-2.5 py-1.5 text-[11px]">
        <span className={`h-2 w-2 rounded-full ${stateTone(session)}`} aria-hidden="true" />
        <span className="font-medium text-gray-700 dark:text-gray-200">
          {unsupported && !session ? "Static preview" : stateLabel(session)}
        </span>
        {session?.state === "ready" && session.port !== null && (
          <span className="text-gray-400">port {session.port}</span>
        )}
        <span className="text-gray-400">· static fallback stays available</span>

        <span className="ml-auto flex items-center gap-1.5">
          {session?.state === "ready" && (
            <button
              type="button"
              onClick={() => void runBuild()}
              disabled={building}
              className="flex items-center gap-1 rounded-md border border-gray-200/70 px-2 py-0.5 text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700/60 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {building ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Build
            </button>
          )}
          {logsOpen ? (
            <button
              type="button"
              onClick={() => setLogsOpen(false)}
              className="rounded-md border border-gray-200/70 px-2 py-0.5 text-gray-600 hover:bg-gray-50 dark:border-gray-700/60 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Hide logs
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void refreshLogs()}
              disabled={!session}
              className="flex items-center gap-1 rounded-md border border-gray-200/70 px-2 py-0.5 text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700/60 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <FileTerminal className="h-3 w-3" /> Logs
            </button>
          )}
          {canStart && (
            <button
              type="button"
              onClick={() => void invoke("start")}
              disabled={unsupported}
              className="flex items-center gap-1 rounded-md border border-gray-200/70 px-2 py-0.5 text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700/60 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <Play className="h-3 w-3" /> Start live preview
            </button>
          )}
          {canRestart && (
            <button
              type="button"
              onClick={() => void invoke("restart")}
              className="flex items-center gap-1 rounded-md border border-gray-200/70 px-2 py-0.5 text-gray-700 hover:bg-gray-50 dark:border-gray-700/60 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <RotateCw className="h-3 w-3" /> Restart
            </button>
          )}
          {canStop && (
            <button
              type="button"
              onClick={() => void invoke("stop")}
              className="flex items-center gap-1 rounded-md border border-gray-200/70 px-2 py-0.5 text-gray-700 hover:bg-gray-50 dark:border-gray-700/60 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <Square className="h-3 w-3" /> Stop
            </button>
          )}
          {(busy || pending) && <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500" />}
          {session?.state === "ready" && session.previewUrl && (
            <button
              type="button"
              onClick={() => setFrameNonce((value) => value + 1)}
              className="flex items-center gap-1 rounded-md border border-gray-200/70 px-2 py-0.5 text-gray-600 hover:bg-gray-50 dark:border-gray-700/60 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <RotateCw className="h-3 w-3" /> Refresh
            </button>
          )}
          {session?.state === "ready" && session.previewUrl && (
            <a
              href={session.previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 rounded-md border border-gray-200/70 px-2 py-0.5 text-gray-600 hover:bg-gray-50 dark:border-gray-700/60 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <ExternalLink className="h-3 w-3" /> Open
            </a>
          )}
        </span>
      </div>

      {unsupported && (
        <p className="border-b border-amber-200/60 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          {status.support.detail ?? "Live runtime previews support React + Vite projects only."}
        </p>
      )}

      {(error || notice || (failed && session)) && (
        <div
          role="status"
          className="flex items-start gap-1.5 border-b border-gray-200/70 bg-gray-50 px-3 py-1.5 text-[11px] dark:border-gray-700/60 dark:bg-gray-900/40"
        >
          {(error || failed) && <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" />}
          <span className="min-w-0 flex-1 text-gray-700 dark:text-gray-200">
            {error ??
              (failed
                ? `${session?.failureReason ?? "The live preview failed."}${session?.failureCode ? ` (${session.failureCode})` : ""}`
                : notice)}
          </span>
          {failed && canStart && (
            <button
              type="button"
              onClick={() => void invoke("start")}
              className="shrink-0 underline underline-offset-2"
            >
              Retry
            </button>
          )}
        </div>
      )}

      <div className="relative flex-1 min-h-0">
        <div className={live ? "hidden" : "h-full min-h-0"} aria-hidden={live}>
          {fallback}
        </div>
        {live && (
          <iframe
            key={`${session?.previewUrl ?? "runtime"}:${frameNonce}`}
            src={session?.previewUrl ?? undefined}
            title="Live runtime preview"
            className={`h-full w-full border-0 bg-white ${
              mobilePreview ? "mx-auto max-w-[375px]" : ""
            }`}
            /**
             * The live app runs on the provider's own origin. `allow-same-origin`
             * is that origin's storage, not Mavly's; no top navigation, no
             * downloads and no Mavly credentials are granted.
             */
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            referrerPolicy="no-referrer"
          />
        )}
      </div>

      {logsOpen && (
        <div className="max-h-48 shrink-0 overflow-auto border-t border-gray-200/70 bg-[#111] px-3 py-2 dark:border-gray-700/60">
          <div className="mb-1.5 flex flex-wrap gap-3 text-[10px]">
            {(session?.checks ?? []).map((entry) => (
              <span key={entry.id} className={checkTone(entry.status)}>
                {entry.label}: {entry.status}
              </span>
            ))}
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-gray-200">
            {session?.logs?.trim() || "No terminal output yet."}
          </pre>
          <p className="mt-2 text-[10px] text-gray-500">
            Output is bounded and redacted on the server. It never includes environment variables.
          </p>
        </div>
      )}
    </div>
  );
}
