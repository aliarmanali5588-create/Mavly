import { AdminShell } from "../components/AdminShell";
import { OverviewSkeleton } from "../components/AdminSkeletons";

/**
 * Overview loading boundary.
 *
 * Renders the real `AdminShell` (sidebar, header, footer, `max-w-7xl` content
 * column) with the Overview page's own section structure inside it, so the
 * transition to `dashboard/page.tsx` does not move anything.
 */
export default function DashboardLoading() {
  return (
    <AdminShell activeNav="Overview" live loading>
      <OverviewSkeleton />
    </AdminShell>
  );
}
