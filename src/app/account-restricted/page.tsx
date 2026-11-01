import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { createSupabaseServerClient, getCurrentUser } from "@/lib/supabase/server";
import { loginUrlFor } from "@/lib/auth/redirect";
import { RestrictedScreen } from "./restricted-screen";

export const metadata: Metadata = {
  title: "Account Restricted — Mavly",
  description: "This Mavly account is temporarily restricted by the administration team.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * ═══ THE ACCOUNT RESTRICTION SCREEN ═════════════════════════════════════════
 *
 * Reached when the proxy decides a verified caller is restricted. The proxy is
 * the enforcement point; this page is the explanation and the way out.
 *
 * ⚠️ IT READS THE REASON FROM THE DATABASE, NOT FROM A QUERY PARAMETER. A reason
 * in the URL could be forged by anyone, and this page must never display text
 * an attacker supplied as though the administration team wrote it.
 *
 * ⚠️ A NON-RESTRICTED VISITOR IS SENT AWAY. Landing here while unrestricted
 * means the state changed (an admin unblocked the account) — so the visitor
 * belongs in the product, not on an error screen.
 */
export default async function AccountRestrictedPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlFor("/dashboard"));

  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect(loginUrlFor("/dashboard"));

  /**
   * Ask the database for the caller's own restriction state and the most recent
   * block reason. `current_user_is_restricted()` takes no argument, so this can
   * only ever describe the signed-in caller.
   *
   * The audit read is best-effort: RLS on `account_restriction_events` allows an
   * admin to read rows, and an ordinary restricted user cannot. When the read
   * returns nothing, the screen simply shows no reason rather than inventing one.
   */
  const { data: restrictedResult } = await supabase.rpc("current_user_is_restricted");
  if (restrictedResult !== true) redirect("/dashboard");

  const { data: events } = await supabase
    .from("account_restriction_events")
    .select("reason, created_at, action")
    .eq("target_user_id", user.id)
    .eq("action", "blocked")
    .order("created_at", { ascending: false })
    .limit(1);

  const latest = Array.isArray(events) && events.length > 0 ? events[0] : null;
  const rawReason = typeof latest?.reason === "string" ? latest.reason.trim() : "";
  const reason = rawReason === "" ? null : rawReason;

  return <RestrictedScreen email={user.email ?? null} reason={reason} />;
}
