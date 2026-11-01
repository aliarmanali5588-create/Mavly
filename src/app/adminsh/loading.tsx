import { AdminShell } from "./components/AdminShell";
import { OverviewSkeleton } from "./components/AdminSkeletons";

/**
 * ═══ INSTANT NAVIGATION FEEDBACK, INSIDE THE REAL SHELL ═════════════════════
 *
 * Every admin route is server-gated (`app/adminsh/layout.tsx` verifies the
 * session and the allowlist before rendering), so a click cannot paint the next
 * page until that check returns. Without a loading boundary the browser sits on
 * the OLD page with no indication anything happened.
 *
 * ⚠️ WHAT THIS REPLACED. The previous version rendered a bare KPI row and one
 * table card with NO `AdminShell` and NO `max-w-7xl mx-auto` content container.
 * During navigation the sidebar and header vanished and the skeleton stretched
 * across the whole viewport, then snapped into the real layout. It also matched
 * no actual page's geometry.
 *
 * This renders the real chrome — same sidebar, same header, same footer, same
 * padded `max-w-7xl` content column — and puts the Overview's own structure
 * inside it. The swap is now a content change, not a layout change.
 *
 * ⚠️ NO NUMBERS, NO FAKE DATA. Bars only. A placeholder metric would be the
 * same class of defect as the hardcoded badge this work removed.
 */
export default function AdminLoading() {
  return (
    <AdminShell activeNav="Overview" live loading>
      <OverviewSkeleton />
    </AdminShell>
  );
}
