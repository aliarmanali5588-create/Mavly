"use client";

import * as React from "react";

import type {
  AdminAiUsagePayload,
  AdminAnnouncementsPage,
  AdminAuditPage,
  AdminConsolePeriod,
  AdminCreditLedgerPage,
  AdminGenerationDetail,
  AdminGenerationFilter,
  AdminGenerationSummary,
  AdminHealthPayload,
  AdminSettingsPayload,
} from "@/lib/admin/console";
import type { AdminGenerationPage } from "@/lib/admin/types";

/**
 * ═══ LIVE DATA FOR THE SEVEN ADMIN CONSOLE SECTIONS ═════════════════════════
 *
 * Every hook here follows the same rules as the Overview hooks, because those
 * rules are what make a live panel honest:
 *
 *   • each request is abortable and carries a monotonic id, so a slow response
 *     for an old filter can never overwrite the current one;
 *   • a failure sets an error and leaves the last good data in place instead of
 *     blanking the panel;
 *   • nothing is fabricated on the client — an absent field stays absent.
 *
 * ⚠️ NO HOOK INVENTS A VALUE. If the route says the summary is unavailable,
 * the hook returns `null` and the component renders "unavailable". There is no
 * default object quietly standing in for real data.
 */

async function readData<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean; data?: T; error?: string }
    | null;
  if (!response.ok || body?.ok !== true || body.data === undefined) {
    throw new Error(body?.error || "The admin data could not be loaded.");
  }
  return body.data;
}

interface QueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * One abortable, id-guarded GET.
 *
 * `url` may be null, which parks the hook in a loading-free idle state — used
 * when a detail drawer is closed.
 */
export function useAdminQuery<T>(
  url: string | null,
  options: { timeoutMs?: number; pollMs?: number; label: string }
): QueryState<T> {
  const { timeoutMs = 15_000, pollMs, label } = options;
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(url !== null);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshToken, setRefreshToken] = React.useState(0);
  const requestId = React.useRef(0);

  React.useEffect(() => {
    if (url === null) {
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const id = ++requestId.current;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    setLoading(true);
    setError(null);

    fetch(url, { cache: "no-store", signal: controller.signal })
      .then((response) => readData<T>(response))
      .then((payload) => {
        if (id !== requestId.current) return;
        setData(payload);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (id !== requestId.current) return;
        if (controller.signal.aborted && !timedOut) return;
        setError(
          timedOut
            ? `The ${label} request timed out.`
            : cause instanceof Error
              ? cause.message
              : `The ${label} could not be loaded.`
        );
        setLoading(false);
      })
      .finally(() => clearTimeout(timeout));

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [url, refreshToken, timeoutMs, label]);

  const refresh = React.useCallback(() => setRefreshToken((token) => token + 1), []);

  /**
   * Bounded polling for a live panel. Only while the tab is visible, and always
   * cleared on unmount — a background tab must not keep hitting the database.
   */
  React.useEffect(() => {
    if (!pollMs) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, pollMs);
    return () => clearInterval(timer);
  }, [pollMs, refresh]);

  return { data, loading, error, refresh };
}

// ───────────────────────────────── credits ──────────────────────────────────

export function useCreditLedger(params: {
  operation: string;
  search: string;
  page: number;
  pageSize: number;
}) {
  const { operation, search, page, pageSize } = params;
  const query = new URLSearchParams({
    operation,
    q: search,
    limit: String(pageSize),
    offset: String(page * pageSize),
  });
  return useAdminQuery<AdminCreditLedgerPage>(
    `/api/adminsh/credits?${query.toString()}`,
    { label: "credit ledger" }
  );
}

// ───────────────────────────────── AI usage ─────────────────────────────────

export function useAiUsage(params: { period: AdminConsolePeriod; model: string }) {
  const { period, model } = params;
  const query = new URLSearchParams({ period });
  if (model) query.set("model", model);
  return useAdminQuery<AdminAiUsagePayload>(`/api/adminsh/ai-usage?${query.toString()}`, {
    label: "AI usage",
  });
}

// ───────────────────────────── generation monitor ───────────────────────────

interface GenerationMonitorPayload {
  page: AdminGenerationPage;
  summary: AdminGenerationSummary | null;
  summaryAvailable: boolean;
}

export function useGenerationMonitor(params: {
  status: AdminGenerationFilter;
  search: string;
  page: number;
  pageSize: number;
}) {
  const { status, search, page, pageSize } = params;
  const query = new URLSearchParams({
    status,
    q: search,
    limit: String(pageSize),
    offset: String(page * pageSize),
  });
  return useAdminQuery<GenerationMonitorPayload>(
    `/api/adminsh/generation-monitor?${query.toString()}`,
    { label: "generation monitor", pollMs: 30_000 }
  );
}

export function useGenerationDetail(runId: string | null) {
  return useAdminQuery<AdminGenerationDetail>(
    runId ? `/api/adminsh/generation-monitor?detail=${encodeURIComponent(runId)}` : null,
    { label: "run detail" }
  );
}

// ─────────────────────────────── system health ──────────────────────────────

export function useSystemHealth() {
  return useAdminQuery<AdminHealthPayload>("/api/adminsh/system-health", {
    label: "system health",
    pollMs: 60_000,
  });
}

// ─────────────────────────────── announcements ──────────────────────────────

export function useAnnouncements(params: {
  status: string;
  kind: string;
  search: string;
  page: number;
  pageSize: number;
}) {
  const { status, kind, search, page, pageSize } = params;
  const query = new URLSearchParams({
    status,
    kind,
    q: search,
    limit: String(pageSize),
    offset: String(page * pageSize),
  });
  return useAdminQuery<AdminAnnouncementsPage>(
    `/api/adminsh/announcements?${query.toString()}`,
    { label: "announcements" }
  );
}

// ──────────────────────────────── audit logs ────────────────────────────────

export function useAuditLogs(params: {
  outcome: string;
  source: string;
  search: string;
  page: number;
  pageSize: number;
}) {
  const { outcome, source, search, page, pageSize } = params;
  const query = new URLSearchParams({
    outcome,
    source,
    q: search,
    limit: String(pageSize),
    offset: String(page * pageSize),
  });
  return useAdminQuery<AdminAuditPage>(`/api/adminsh/audit-logs?${query.toString()}`, {
    label: "audit log",
  });
}

// ────────────────────────────────── settings ────────────────────────────────

export function useAdminSettings() {
  return useAdminQuery<AdminSettingsPayload>("/api/adminsh/settings", {
    label: "settings",
  });
}

// ──────────────────────────────── mutations ─────────────────────────────────

interface MutationState {
  pending: boolean;
  error: string | null;
}

/**
 * A single POST with the same honesty rules: the caller gets the server's own
 * message, and a failure is never reported as success.
 */
export function useAdminMutation() {
  const [state, setState] = React.useState<MutationState>({ pending: false, error: null });

  const run = React.useCallback(
    async <T,>(url: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> => {
      setState({ pending: true, error: null });
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => null)) as
          | { ok?: boolean; data?: T; error?: string }
          | null;

        if (!response.ok || payload?.ok !== true || payload.data === undefined) {
          const message = payload?.error || "The action could not be completed.";
          setState({ pending: false, error: message });
          return { ok: false, error: message };
        }

        setState({ pending: false, error: null });
        return { ok: true, data: payload.data };
      } catch {
        const message = "The action could not be completed.";
        setState({ pending: false, error: message });
        return { ok: false, error: message };
      }
    },
    []
  );

  return { ...state, run };
}

/** A stable idempotency key for one form submission. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `admin-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─────────────────────────────── debounce ───────────────────────────────────

/**
 * Debounce a search box so typing does not fire a query per keystroke.
 *
 * The value settles after `delayMs` of quiet. The first render returns the
 * initial value immediately, so a page never starts with an empty query.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = React.useState(value);

  React.useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
