"use client";

import * as React from "react";

/**
 * ═══ THE SIDEBAR'S ONLY USER-COUNT SOURCE ═══════════════════════════════════
 *
 * `AdminShell` is the shared parent of every admin page, so fetching here means
 * the badge is correct on Users, Projects, Billing — everywhere — not only on
 * the Overview page that happens to have an overview payload.
 *
 * Returns `null` while unknown. The caller renders a skeleton or nothing; it
 * must never substitute a constant, because a fabricated count is exactly the
 * defect this replaces.
 */
export function useAdminUserCount(enabled = true): number | null {
  const [total, setTotal] = React.useState<number | null>(null);

  React.useEffect(() => {
    /**
     * ⚠️ A SKELETON MUST NOT FETCH.
     *
     * The loading boundaries render this shell with `enabled = false`, so a
     * navigation does not fire a second count request that the real page will
     * immediately duplicate. The badge holds its space and stays unknown.
     */
    if (!enabled) return;

    const controller = new AbortController();

    fetch("/api/adminsh/users/count", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | { ok?: boolean; data?: { total?: unknown } }
          | null;
        if (!response.ok || body?.ok !== true) return;
        const value = body.data?.total;
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
          setTotal(value);
        }
      })
      .catch(() => {
        // A failed count leaves the badge unknown. It never becomes a fake number.
      });

    return () => controller.abort();
  }, [enabled]);

  return total;
}
