import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { createSupabaseServerClient, getCurrentUser } from "@/lib/supabase/server";
import { loginUrlFor } from "@/lib/auth/redirect";
import { RestrictedScreen } from "./restricted-screen";

export const metadata: Metadata = {
  title: "Account Suspended — Mavly",
  description: "Your Mavly account has been suspended.",
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
export default async function AccountRestrictedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();
  const params = await searchParams;
  const rawSource = params.source;
  const source = Array.isArray(rawSource) ? rawSource[0] : rawSource;
  if (!user) {
    if (source === "auth") {
      return (
        <RestrictedScreen
          email={null}
          reason={null}
          reasonState="identity_unverified"
          status="sign_in_rejected"
        />
      );
    }
    redirect(loginUrlFor("/dashboard"));
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect(loginUrlFor("/dashboard"));

  const { data: restrictedResult, error: statusError } = await supabase.rpc(
    "current_user_is_restricted",
  );
  if (statusError || typeof restrictedResult !== "boolean") {
    console.error("[account-restricted] status lookup failed", {
      code: statusError?.code ?? "invalid_response",
    });
    return (
      <RestrictedScreen
        email={user.email ?? null}
        reason={null}
        reasonState="unavailable"
        status="unavailable"
      />
    );
  }
  if (restrictedResult !== true) redirect("/dashboard");

  const { data: reasonResult, error: reasonError } = await supabase.rpc(
    "current_user_restriction_reason",
  );
  if (reasonError) {
    console.error("[account-restricted] reason lookup failed", {
      code: reasonError.code ?? "unknown",
    });
  }
  const reason =
    !reasonError && typeof reasonResult === "string" && reasonResult.trim()
      ? reasonResult.trim()
      : null;
  const reasonState = reasonError ? "unavailable" : reason ? "recorded" : "not_recorded";

  return (
    <RestrictedScreen
      email={user.email ?? null}
      reason={reason}
      reasonState={reasonState}
      status="suspended"
    />
  );
}
