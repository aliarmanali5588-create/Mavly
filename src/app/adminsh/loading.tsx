/**
 * ═══ INSTANT NAVIGATION FEEDBACK ════════════════════════════════════════════
 *
 * Every admin route is server-gated (`app/adminsh/layout.tsx` verifies the
 * session and the allowlist before rendering), so a click cannot paint the next
 * page until that check returns. Without a `loading.tsx`, the browser sits on
 * the OLD page with no indication anything happened — which reads as a frozen
 * interface even when the server is simply working.
 *
 * This renders immediately on navigation and mirrors the real page's geometry
 * (a KPI row plus a table card) so the swap does not shift layout.
 *
 * ⚠️ NO NUMBERS, NO FAKE DATA. Skeletons only — a placeholder metric would be
 * the same class of defect as the hardcoded badge this work removed.
 */
export default function AdminLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading admin data…</span>

      {/* KPI row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className="p-5 rounded-2xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)]"
          >
            <div className="h-3 w-24 rounded bg-[var(--clay-sunken)] animate-pulse" />
            <div className="h-7 w-16 rounded bg-[var(--clay-sunken)] animate-pulse mt-2.5" />
            <div className="h-2.5 w-32 rounded bg-[var(--clay-sunken)] animate-pulse mt-3" />
          </div>
        ))}
      </div>

      {/* Table card */}
      <div className="bg-card rounded-2xl p-5 sm:p-6 border border-[var(--clay-line)] shadow-[var(--clay-elev-1)]">
        <div className="flex items-center justify-between pb-4 border-b border-[var(--clay-line)]">
          <div className="space-y-2">
            <div className="h-4 w-40 rounded bg-[var(--clay-sunken)] animate-pulse" />
            <div className="h-3 w-56 rounded bg-[var(--clay-sunken)] animate-pulse" />
          </div>
          <div className="h-8 w-44 rounded-xl bg-[var(--clay-sunken)] animate-pulse" />
        </div>

        <div className="divide-y divide-[var(--clay-line)]">
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <div key={row} className="flex items-center gap-4 py-3.5">
              <div className="h-7 w-7 rounded-full bg-[var(--clay-sunken)] animate-pulse shrink-0" />
              <div className="h-3 w-40 rounded bg-[var(--clay-sunken)] animate-pulse" />
              <div className="h-3 w-24 rounded bg-[var(--clay-sunken)] animate-pulse ml-auto" />
              <div className="h-3 w-16 rounded bg-[var(--clay-sunken)] animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
