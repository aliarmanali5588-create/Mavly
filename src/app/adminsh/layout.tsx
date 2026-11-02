/**
 * ═══ THE ADMIN CONSOLE HAS A REAL SERVER-SIDE GATE ══════════════════════════
 *
 * The pages under `/adminsh` are visual/admin simulations, but that is not a
 * reason to publish them. This layout runs before every one of them:
 *
 *   1. no verified session          → redirect to /adminsh/auth
 *   2. session but not the registry → request-boundary 403
 *   3. missing/error schema         → 404 (fail closed)
 *
 * Authority comes from `public.current_user_admin_status()`, which reads the
 * caller's confirmed `auth.users` row, the UUID registry and the fixed-lifetime
 * admin session. The
 * layout never trusts a cookie, a query parameter, a client route or a local
 * `setTimeout`.
 */

import { notFound, redirect } from "next/navigation";

import { createSupabaseServerClient, getRequestUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  /**
   * `getRequestUser` is request-memoised, so the API route's own `requireAdmin`
   * call reuses the same verified `getCurrentUser` answer instead of asking the
   * Auth server again.
   */
  const user = await getRequestUser();
  if (!user) redirect("/adminsh/auth?redirect=%2Fadminsh%2Fdashboard");

  const supabase = await createSupabaseServerClient();
  if (!supabase) notFound();

  const { data: adminStatus, error } = await supabase.rpc("current_user_admin_status");
  // `current_user_is_admin()` remains the database predicate used by every
  // privileged admin RPC; this page additionally needs the status detail to
  // route an expired grant back through the admin login screen.
  const data = adminStatus === "active";
  if (error || data !== true) {
    if (adminStatus === "expired" || adminStatus === "needs_login") {
      redirect("/adminsh/auth?error=admin_session_required&redirect=%2Fadminsh%2Fdashboard");
    }
    notFound();
  }

  return children;
}
