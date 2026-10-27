/**
 * ═══ THE ADMIN CONSOLE HAS A REAL SERVER-SIDE GATE ══════════════════════════
 *
 * The pages under `/adminsh` are visual/admin simulations, but that is not a
 * reason to publish them. This layout runs before every one of them:
 *
 *   1. no verified session          → redirect to /login
 *   2. session but not the allowlist → 404 (same answer as a missing page)
 *   3. migration 18 missing/error    → 404 (fail closed)
 *
 * Authority comes from `public.current_user_is_admin()`, which reads the
 * caller's confirmed `auth.users` row and the deny-by-default allowlist. The
 * layout never trusts a cookie, a query parameter, a client route or a local
 * `setTimeout`.
 */

import { notFound, redirect } from "next/navigation";

import { loginUrlFor } from "@/lib/auth/redirect";
import { createSupabaseServerClient, getCurrentUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlFor("/adminsh/dashboard"));

  const supabase = await createSupabaseServerClient();
  if (!supabase) notFound();

  const { data, error } = await supabase.rpc("current_user_is_admin");
  if (error || data !== true) notFound();

  return children;
}
