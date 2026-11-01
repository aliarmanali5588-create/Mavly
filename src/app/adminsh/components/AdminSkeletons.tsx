import React from "react";

/**
 * ═══ SKELETONS THAT ARE STRUCTURAL COPIES, NOT DECORATION ═══════════════════
 *
 * Each export below reproduces the ACTUAL page it stands in for: the same grid
 * columns, the same gaps, the same card padding and radius, the same toolbar,
 * the same table column count and row height, the same pagination footer.
 *
 * ⚠️ WHY THIS MODULE EXISTS. The single `app/adminsh/loading.tsx` it replaces
 * rendered a bare KPI row and one table card, outside `AdminShell` and outside
 * the `max-w-7xl mx-auto` content container. The result was a full-viewport
 * skeleton with no sidebar, no header, and geometry matching no page — then a
 * hard jump to the real layout. That is the mismatch this fixes.
 *
 * ⚠️ NO NUMBERS, NO LABELS THAT CLAIM DATA. Bars only. A placeholder metric
 * would be the same class of defect as a hardcoded badge.
 *
 * Geometry sources (keep these in sync when a page changes):
 *   Overview  app/adminsh/dashboard/page.tsx + components/KpiCards.tsx
 *   Users     app/adminsh/users/page.tsx
 *   Projects  app/adminsh/projects/page.tsx
 *   Billing   app/adminsh/billing/page.tsx
 */

/** A single pulsing bar. The admin pages' existing skeleton idiom. */
function Bar({ className }: { className: string }) {
  return <div className={`rounded bg-[var(--clay-sunken)] animate-pulse ${className}`} />;
}

/** The card shell every admin section uses. */
function Card({ className = "", children }: { className?: string; children?: React.ReactNode }) {
  return (
    <div
      className={`bg-card border border-[var(--clay-line)] ${className}`}
      aria-hidden="true"
    >
      {children}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * OVERVIEW — dashboard/page.tsx
 *
 * 1. KpiCards:        grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4
 *                     card = rounded-2xl p-5, title row / value / divider+context
 * 2. Analytics grid:  grid-cols-1 lg:grid-cols-2 gap-6, two rounded-2xl p-5 sm:p-6
 * 3. Quick actions:   rounded-2xl p-5 sm:p-6, 4 tiles h-24 in gap-3 grid
 * 4. Activity:        two stacked rounded-2xl p-5 sm:p-6 cards
 * 5. Platform health: rounded-2xl p-5 sm:p-6, 3-up check grid
 * ═══════════════════════════════════════════════════════════════════════════ */
export function OverviewSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading admin overview…</span>

      {/* 1. KPI cards — mirrors KpiSkeletons in components/KpiCards.tsx */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((index) => (
          <Card key={index} className="rounded-2xl p-5 shadow-[var(--clay-elev-1)]">
            <div className="flex items-center justify-between">
              <Bar className="h-3 w-24" />
              <Bar className="h-8 w-8 rounded-xl" />
            </div>
            <Bar className="mt-4 h-8 w-28" />
            <div className="mt-4 pt-3 border-t border-[var(--clay-line)]">
              <Bar className="h-3 w-36" />
            </div>
          </Card>
        ))}
      </div>

      {/* 2. Revenue + AI usage side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {[0, 1].map((index) => (
          <Card key={index} className="rounded-2xl p-5 sm:p-6 shadow-[var(--clay-elev-1)] space-y-6">
            <div className="flex items-center justify-between">
              <Bar className="h-4 w-40" />
              <Bar className="h-6 w-20 rounded-lg" />
            </div>
            <Bar className="h-40 w-full rounded-xl" />
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
              {[0, 1, 2, 3].map((tile) => (
                <Bar key={tile} className="h-14 rounded-xl" />
              ))}
            </div>
          </Card>
        ))}
      </div>

      {/* 3. Administrative shortcuts */}
      <Card className="rounded-2xl p-5 sm:p-6 shadow-[var(--clay-elev-1)] space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-[var(--clay-line)]">
          <div className="flex items-center gap-2">
            <Bar className="h-7 w-7 rounded-lg" />
            <Bar className="h-4 w-48" />
          </div>
          <Bar className="h-3 w-28" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((tile) => (
            <Bar key={tile} className="h-24 rounded-xl" />
          ))}
        </div>
      </Card>

      {/* 4. Generation stream + transactions ledger */}
      {[0, 1].map((index) => (
        <Card key={index} className="rounded-2xl p-5 sm:p-6 shadow-[var(--clay-elev-1)] space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[var(--clay-line)]">
            <div className="space-y-2">
              <Bar className="h-4 w-56" />
              <Bar className="h-3 w-72" />
            </div>
            <Bar className="h-8 w-32 rounded-xl" />
          </div>
          <div className="divide-y divide-[var(--clay-line)]">
            {[0, 1, 2, 3, 4].map((row) => (
              <div key={row} className="flex items-center gap-4 py-3">
                <Bar className="h-3 w-32" />
                <Bar className="h-3 w-24" />
                <Bar className="h-3 w-20 ml-auto" />
                <Bar className="h-3 w-16" />
              </div>
            ))}
          </div>
        </Card>
      ))}

      {/* 5. Platform health */}
      <Card className="rounded-2xl p-5 sm:p-6 shadow-[var(--clay-elev-2)] space-y-4">
        <div className="space-y-2 pb-3 border-b border-[var(--clay-line)]">
          <Bar className="h-4 w-44" />
          <Bar className="h-3 w-64" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[0, 1, 2, 3, 4, 5].map((check) => (
            <Bar key={check} className="h-16 rounded-xl" />
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * USERS — users/page.tsx
 *
 * 1. Four KPI cards:  grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4,
 *                     card = rounded-2xl p-5 (label / value / source line)
 * 2. Directory card:  rounded-2xl p-5 sm:p-6 space-y-4
 *                     header row = "Customer Directory" + subtitle, then
 *                     search (w-60) + 2 selects + Invite button
 * 3. Table:           overflow-x-auto rounded-xl border, 8 columns,
 *                     rows py-2.5 px-4 with a 7x7 avatar
 * 4. Footer:          "Showing x to y of n" + prev/page/next
 * ═══════════════════════════════════════════════════════════════════════════ */
export function UsersSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading users…</span>

      {/* 1. KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((index) => (
          <Card key={index} className="p-5 rounded-2xl shadow-[var(--clay-elev-2)]">
            <Bar className="h-3 w-28" />
            <Bar className="mt-2.5 h-8 w-20" />
            <Bar className="mt-3 h-2.5 w-32" />
          </Card>
        ))}
      </div>

      {/* 2. Customer Directory */}
      <Card className="rounded-2xl p-5 sm:p-6 shadow-[var(--clay-elev-1)] space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4 border-b border-[var(--clay-line)]">
          <div className="space-y-2">
            <Bar className="h-4 w-40" />
            <Bar className="h-3 w-52" />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Bar className="h-8 w-full sm:w-60 rounded-xl" />
            <Bar className="h-8 w-32 rounded-xl" />
            <Bar className="h-8 w-28 rounded-xl" />
            <Bar className="h-8 w-32 rounded-xl" />
          </div>
        </div>

        {/* 3. Table — 8 columns, matching the real thead */}
        <div className="overflow-x-auto rounded-xl border border-[var(--clay-line)] bg-card shadow-[var(--clay-elev-1)]">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[var(--clay-sunken)] border-b border-[var(--clay-line)]">
                {["User", "Role", "Plan", "Projects", "Credits", "Status", "Last Sign-In", "Actions"].map(
                  (column) => (
                    <th key={column} className="py-2.5 px-4">
                      <Bar className="h-2.5 w-16" />
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--clay-line)]">
              {[0, 1, 2, 3, 4].map((row) => (
                <tr key={row}>
                  <td className="py-2.5 px-4">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-[var(--clay-sunken)] animate-pulse shrink-0" />
                      <div className="space-y-1.5">
                        <Bar className="h-3 w-28" />
                        <Bar className="h-2.5 w-36" />
                      </div>
                    </div>
                  </td>
                  <td className="py-2.5 px-4"><Bar className="h-3 w-14" /></td>
                  <td className="py-2.5 px-4"><Bar className="h-4 w-16 rounded" /></td>
                  <td className="py-2.5 px-4"><Bar className="h-3 w-8 mx-auto" /></td>
                  <td className="py-2.5 px-4"><Bar className="h-3 w-12 ml-auto" /></td>
                  <td className="py-2.5 px-4"><Bar className="h-3 w-20" /></td>
                  <td className="py-2.5 px-4"><Bar className="h-3 w-24" /></td>
                  <td className="py-2.5 px-4">
                    <div className="flex items-center justify-end gap-1.5">
                      <Bar className="h-6 w-11 rounded-lg" />
                      <Bar className="h-6 w-11 rounded-lg" />
                      <Bar className="h-6 w-6 rounded-lg" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 4. Pagination footer */}
        <div className="flex items-center justify-between pt-3 border-t border-[var(--clay-line)]">
          <Bar className="h-3 w-48" />
          <div className="flex items-center gap-1">
            <Bar className="h-7 w-7 rounded-lg" />
            <Bar className="h-3 w-10 mx-2" />
            <Bar className="h-7 w-7 rounded-lg" />
          </div>
        </div>
      </Card>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PROJECTS — projects/page.tsx
 *
 * ⚠️ DIFFERENT FROM USERS ON PURPOSE. This page uses gap-3.5 and p-4 rounded-xl
 * for its KPI cards, a status TAB GROUP instead of a heading, a plain
 * overflow-x-auto table (no rounded-xl wrapper), py-3.5 rows, and a
 * "Showing x to y of n projects" footer. A skeleton that reused the Users
 * geometry would shift on load — which is the defect being fixed.
 * ═══════════════════════════════════════════════════════════════════════════ */
export function ProjectsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading projects…</span>

      {/* 1. KPI cards — grid-cols-2 on mobile, gap-3.5, p-4 rounded-xl */}
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {[0, 1, 2, 3].map((index) => (
          <Card key={index} className="p-4 rounded-xl shadow-[var(--clay-elev-2)]">
            <div className="flex items-center justify-between">
              <Bar className="h-3 w-24" />
              <Bar className="h-3.5 w-3.5 rounded" />
            </div>
            <Bar className="mt-2.5 h-6 w-16" />
            <Bar className="mt-2.5 h-2.5 w-32" />
          </Card>
        ))}
      </div>

      {/* 2. Directory card */}
      <Card className="rounded-2xl p-5 sm:p-6 shadow-[var(--clay-elev-1)] space-y-4">
        {/* Toolbar: status tabs left, search + visibility select right */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-[var(--clay-line)]">
          <div className="flex flex-wrap items-center gap-1 bg-[var(--clay-sunken)] p-0.5 rounded-lg border border-[var(--clay-line)] shadow-[var(--clay-well-1)]">
            {[0, 1, 2, 3, 4].map((tab) => (
              <Bar key={tab} className="h-6 w-16 rounded-md" />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Bar className="h-8 w-full sm:w-60 rounded-lg" />
            <Bar className="h-8 w-36 rounded-lg" />
          </div>
        </div>

        {/* 3. Table — 8 columns, plain overflow-x-auto, py-3.5 rows */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--clay-line)]">
                {[
                  "Project",
                  "Owner",
                  "Model",
                  "Generation",
                  "Visibility",
                  "Routes",
                  "Updated",
                  "Actions",
                ].map((column) => (
                  <th key={column} className="pb-3">
                    <Bar className="h-2.5 w-16" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--clay-line)]">
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((row) => (
                <tr key={row}>
                  <td className="py-3.5">
                    <div className="space-y-1.5">
                      <Bar className="h-3 w-32" />
                      <Bar className="h-2.5 w-40" />
                    </div>
                  </td>
                  <td className="py-3.5">
                    <div className="space-y-1.5">
                      <Bar className="h-3 w-24" />
                      <Bar className="h-2.5 w-32" />
                    </div>
                  </td>
                  <td className="py-3.5"><Bar className="h-4 w-24 rounded" /></td>
                  <td className="py-3.5"><Bar className="h-4 w-20 rounded mx-auto" /></td>
                  <td className="py-3.5"><Bar className="h-3 w-28" /></td>
                  <td className="py-3.5"><Bar className="h-3 w-16 ml-auto" /></td>
                  <td className="py-3.5"><Bar className="h-3 w-24 ml-auto" /></td>
                  <td className="py-3.5">
                    <div className="flex items-center justify-end gap-1">
                      <Bar className="h-6 w-14 rounded-md" />
                      <Bar className="h-4 w-4 rounded" />
                      <Bar className="h-4 w-4 rounded" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 4. Pagination footer */}
        <div className="flex items-center justify-between pt-3 border-t border-[var(--clay-line)]">
          <Bar className="h-3 w-52" />
          <div className="flex items-center gap-1">
            <Bar className="h-7 w-7 rounded-lg" />
            <Bar className="h-3 w-10 mx-2" />
            <Bar className="h-7 w-7 rounded-lg" />
          </div>
        </div>
      </Card>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * BILLING & REVENUE — billing/page.tsx
 *
 * 1. Four metric cards:  grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4,
 *                        card = rounded-2xl p-5
 * 2. Chart + plan split: grid-cols-1 lg:grid-cols-3 gap-6,
 *                        chart spans 2, plan card is 1
 * 3. Ledger card:        rounded-2xl p-5 sm:p-6, toolbar, 7-column table
 * ═══════════════════════════════════════════════════════════════════════════ */
export function BillingSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading billing…</span>

      {/* 1. Metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((index) => (
          <Card key={index} className="p-5 rounded-2xl shadow-[var(--clay-elev-2)]">
            <Bar className="h-3 w-32" />
            <Bar className="mt-2.5 h-9 w-16" />
            <Bar className="mt-3 h-2.5 w-40" />
          </Card>
        ))}
      </div>

      {/* 2. Revenue chart + plan distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Card className="rounded-2xl p-5 sm:p-6 shadow-[var(--clay-elev-1)] space-y-6">
            <div className="flex items-center justify-between">
              <Bar className="h-4 w-40" />
              <Bar className="h-6 w-20 rounded-lg" />
            </div>
            <Bar className="h-48 w-full rounded-xl" />
          </Card>
        </div>

        <Card className="rounded-2xl p-5 sm:p-6 shadow-[var(--clay-elev-1)] flex flex-col justify-between space-y-4">
          <div className="space-y-2">
            <Bar className="h-4 w-36" />
            <Bar className="h-3 w-48" />
          </div>
          <Bar className="min-h-40 rounded-xl" />
          <Bar className="h-12 rounded-xl" />
        </Card>
      </div>

      {/* 3. Payment transactions ledger */}
      <Card className="rounded-2xl p-5 sm:p-6 shadow-[var(--clay-elev-1)] space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4 border-b border-[var(--clay-line)]">
          <div className="flex items-center gap-2">
            <Bar className="h-7 w-7 rounded-lg" />
            <div className="space-y-1.5">
              <Bar className="h-4 w-56" />
              <Bar className="h-3 w-64" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Bar className="h-8 w-full sm:w-60 rounded-xl" />
            <Bar className="h-8 w-32 rounded-xl" />
            <Bar className="h-8 w-28 rounded-xl" />
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-[var(--clay-line)] bg-card shadow-[var(--clay-elev-1)]">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[var(--clay-sunken)] border-b border-[var(--clay-line)]">
                {["Invoice", "Customer", "Plan", "Amount", "Status", "Timestamp", "Actions"].map(
                  (column) => (
                    <th key={column} className="py-2.5 px-4">
                      <Bar className="h-2.5 w-16" />
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--clay-line)]">
              {[0, 1, 2, 3, 4].map((row) => (
                <tr key={row}>
                  <td className="py-2.5 px-4"><Bar className="h-3 w-24" /></td>
                  <td className="py-2.5 px-4"><Bar className="h-3 w-32" /></td>
                  <td className="py-2.5 px-4"><Bar className="h-4 w-16 rounded" /></td>
                  <td className="py-2.5 px-4"><Bar className="h-3 w-16 ml-auto" /></td>
                  <td className="py-2.5 px-4"><Bar className="h-3 w-20" /></td>
                  <td className="py-2.5 px-4"><Bar className="h-3 w-24" /></td>
                  <td className="py-2.5 px-4"><Bar className="h-6 w-16 rounded-lg ml-auto" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * GENERIC — for admin sections that have no bespoke geometry yet.
 *
 * ⚠️ IT STILL RENDERS INSIDE AdminShell, so the chrome never disappears. It is
 * deliberately conservative: one KPI row and one table card, which is the
 * common shape of the remaining sections. It is NOT a claim to match them
 * exactly; a section that diverges should get its own skeleton above.
 * ═══════════════════════════════════════════════════════════════════════════ */
export function GenericAdminSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading admin data…</span>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((index) => (
          <Card key={index} className="p-5 rounded-2xl shadow-[var(--clay-elev-2)]">
            <Bar className="h-3 w-24" />
            <Bar className="mt-2.5 h-7 w-16" />
            <Bar className="mt-3 h-2.5 w-32" />
          </Card>
        ))}
      </div>

      <Card className="rounded-2xl p-5 sm:p-6 shadow-[var(--clay-elev-1)] space-y-4">
        <div className="flex items-center justify-between pb-4 border-b border-[var(--clay-line)]">
          <div className="space-y-2">
            <Bar className="h-4 w-40" />
            <Bar className="h-3 w-56" />
          </div>
          <Bar className="h-8 w-44 rounded-xl" />
        </div>
        <div className="divide-y divide-[var(--clay-line)]">
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <div key={row} className="flex items-center gap-4 py-3.5">
              <Bar className="h-7 w-7 rounded-full shrink-0" />
              <Bar className="h-3 w-40" />
              <Bar className="h-3 w-24 ml-auto" />
              <Bar className="h-3 w-16" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
