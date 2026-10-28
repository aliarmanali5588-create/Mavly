"use client";

import * as React from "react";

import type { AdminPeriod } from "@/lib/admin/overview";
import type {
  AdminGenerationFilter,
  AdminGenerationPage,
  AdminOverviewPayload,
} from "@/lib/admin/types";

/**
 * Live Overview data.
 *
 * Every request is abortable, and a monotonically increasing request id makes a
 * late response for an older period unable to overwrite the newest one. A failed
 * independent fetch does not blank the rest of the dashboard: each consumer owns
 * its own loading/error state.
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

export function useAdminOverview(period: AdminPeriod) {
  const [data, setData] = React.useState<AdminOverviewPayload | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshToken, setRefreshToken] = React.useState(0);
  const requestId = React.useRef(0);

  React.useEffect(() => {
    const controller = new AbortController();
    const id = ++requestId.current;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15_000);

    setLoading(true);
    setError(null);

    fetch(`/api/adminsh/overview?period=${encodeURIComponent(period)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => readData<AdminOverviewPayload>(response))
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
            ? "The admin overview request timed out."
            : cause instanceof Error
              ? cause.message
              : "The admin overview could not be loaded."
        );
        setLoading(false);
      })
      .finally(() => clearTimeout(timeout));

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [period, refreshToken]);

  const refresh = React.useCallback(() => setRefreshToken((token) => token + 1), []);

  // Bounded refresh so the header status and queue counts stay current. Only
  // runs while the tab is visible and is always cleared on unmount.
  React.useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 60_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return { data, loading, error, refresh };
}

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);

  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

export function useAdminGenerations(params: {
  status: AdminGenerationFilter;
  search: string;
  page: number;
  pageSize: number;
}) {
  const { status, search, page, pageSize } = params;
  const [data, setData] = React.useState<AdminGenerationPage | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshToken, setRefreshToken] = React.useState(0);
  const requestId = React.useRef(0);

  React.useEffect(() => {
    const controller = new AbortController();
    const id = ++requestId.current;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15_000);

    const query = new URLSearchParams({
      status,
      q: search,
      limit: String(pageSize),
      offset: String(page * pageSize),
    });

    setLoading(true);
    setError(null);

    fetch(`/api/adminsh/generations?${query.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => readData<AdminGenerationPage>(response))
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
            ? "The generation stream request timed out."
            : cause instanceof Error
              ? cause.message
              : "The generation stream could not be loaded."
        );
        setLoading(false);
      })
      .finally(() => clearTimeout(timeout));

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [status, search, page, pageSize, refreshToken]);

  const refresh = React.useCallback(() => setRefreshToken((token) => token + 1), []);

  return { data, loading, error, refresh };
}
