import { AdminShell } from "../components/AdminShell";
import { ProjectsSkeleton } from "../components/AdminSkeletons";

/**
 * Projects loading boundary.
 *
 * Mirrors `projects/page.tsx`, which differs from Users in ways that used to
 * cause a visible jump: `gap-3.5` and `p-4 rounded-xl` KPI cards (not `gap-4`
 * / `p-5 rounded-2xl`), a status TAB GROUP instead of a heading, a plain
 * `overflow-x-auto` table with no rounded wrapper, `py-3.5` rows, and a
 * "Showing … of n projects" footer.
 */
export default function ProjectsLoading() {
  return (
    <AdminShell activeNav="Projects" loading>
      <ProjectsSkeleton />
    </AdminShell>
  );
}
