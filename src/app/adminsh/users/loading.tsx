import { AdminShell } from "../components/AdminShell";
import { UsersSkeleton } from "../components/AdminSkeletons";

/**
 * Users loading boundary.
 *
 * Mirrors `users/page.tsx`: four KPI cards (`gap-4`, `p-5 rounded-2xl`), the
 * Customer Directory card with its heading, search field, two selects and
 * Invite button, the 8-column table with `py-2.5 px-4` rows and a 7×7 avatar,
 * and the pagination footer.
 *
 * ⚠️ `activeNav="Users"` matters: `AdminShell` treats this as a real-data
 * section, so the environment ribbon and the mock-telemetry footer are omitted
 * here exactly as they are on the real page.
 */
export default function UsersLoading() {
  return (
    <AdminShell activeNav="Users" loading>
      <UsersSkeleton />
    </AdminShell>
  );
}
