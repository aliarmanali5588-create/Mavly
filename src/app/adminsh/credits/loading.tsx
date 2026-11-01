import { AdminShell } from "../components/AdminShell";
import { GenericAdminSkeleton } from "../components/AdminSkeletons";

/**
 * Loading boundary for /adminsh/credits.
 *
 * Renders the real `AdminShell` so the sidebar and header stay painted during
 * navigation, with a conservative KPI-row + table-card placeholder inside the
 * same `max-w-7xl` content column. This section has no bespoke skeleton yet;
 * give it one in `components/AdminSkeletons.tsx` if its real geometry diverges.
 */
export default function Loading() {
  return (
    <AdminShell activeNav="Credits" loading>
      <GenericAdminSkeleton />
    </AdminShell>
  );
}
