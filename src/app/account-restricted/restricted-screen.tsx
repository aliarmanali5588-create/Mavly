"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, LogOut, Mail, ShieldAlert } from "lucide-react";

type RestrictionStatus = "suspended" | "sign_in_rejected" | "unavailable";
type ReasonState = "recorded" | "not_recorded" | "unavailable" | "identity_unverified";

interface RestrictedScreenProps {
  email: string | null;
  reason: string | null;
  reasonState: ReasonState;
  status: RestrictionStatus;
}

const SUPPORT_EMAIL = "support@mavly.xyz";

function supportMailto(email: string | null): string {
  const body = email
    ? `Hello Mavly Support,\n\nMy Mavly account email is ${email}. My account has been suspended, and I am requesting a review of this suspension.\n\nThank you.`
    : "Hello Mavly Support,\n\nMy Mavly account has been suspended, and I am requesting a review. I could not sign in to confirm my account email. Please let me know what information you need.\n\nThank you.";
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Account Suspension Appeal")}&body=${encodeURIComponent(body)}`;
}

export function RestrictedScreen({
  email,
  reason,
  reasonState,
  status,
}: RestrictedScreenProps) {
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const isSuspended = status === "suspended" || status === "sign_in_rejected";

  const handleLogout = async () => {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);

    try {
      const response = await fetch("/auth/signout", { method: "POST", cache: "no-store" });
      if (!response.ok) throw new Error(`sign out failed (${response.status})`);
      window.location.href = "/login";
    } catch {
      setSigningOut(false);
      setSignOutError("We couldn't sign you out. Please try again.");
    }
  };

  return (
    <div className="min-h-screen bg-[var(--clay-base)] text-foreground font-sans flex items-center justify-center p-4 antialiased">
      <main className="w-full max-w-lg bg-card rounded-2xl sm:rounded-3xl border border-[var(--clay-line)] shadow-[var(--clay-float)] p-6 sm:p-8 space-y-5">
        <header className="flex items-start gap-3.5">
          <div className="w-11 h-11 rounded-2xl bg-destructive-subtle text-destructive flex items-center justify-center shrink-0">
            <ShieldAlert className="w-5 h-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-foreground">
              {status === "unavailable" ? "Account Status Unavailable" : "Account Suspended"}
            </h1>
            {email ? (
              <p className="text-xs text-muted-foreground font-mono truncate mt-1">{email}</p>
            ) : null}
          </div>
          {isSuspended ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/20 bg-destructive-subtle px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-destructive-subtle-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
              Suspended
            </span>
          ) : null}
        </header>

        <p className="text-sm text-muted-foreground leading-relaxed">
          {status === "unavailable"
            ? "We couldn't verify your account status right now. Protected account access remains unavailable until the status can be confirmed. Please retry shortly or contact support."
            : "Your account has been suspended because it was found to be in violation of Mavly's policies."}
        </p>

        {status === "suspended" ? (
          <section
            aria-labelledby="suspension-reason-heading"
            className="rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] px-4 py-3 shadow-[var(--clay-well-1)]"
          >
            <h2
              id="suspension-reason-heading"
              className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground"
            >
              Suspension reason
            </h2>
            {reasonState === "recorded" && reason ? (
              <p className="text-sm text-foreground mt-1.5 leading-relaxed break-words whitespace-pre-wrap">
                {reason}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                {reasonState === "unavailable"
                  ? "The saved reason could not be retrieved right now. Customer Support can review it with you."
                  : "No specific reason was recorded. Contact Customer Support to request a review."}
              </p>
            )}
          </section>
        ) : null}

        {status === "sign_in_rejected" ? (
          <p className="rounded-xl border border-[var(--clay-line)] bg-[var(--clay-sunken)] px-4 py-3 text-xs leading-relaxed text-muted-foreground">
            {reasonState === "identity_unverified"
              ? "Supabase rejected this sign-in because the account is suspended. Your saved suspension reason is not shown until Mavly can verify the account identity."
              : "This sign-in was rejected. Contact Customer Support for help."}
          </p>
        ) : null}

        <section className="rounded-xl border border-[var(--clay-line)] bg-card px-4 py-3">
          <h2 className="text-xs font-bold text-foreground">Your account data is preserved</h2>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
            Your projects, files, credits and billing history have not been deleted. If you
            believe this is a mistake, Customer Support can review the suspension.
          </p>
        </section>

        {signOutError ? (
          <div
            role="alert"
            className="rounded-xl border border-destructive/25 bg-destructive-subtle px-3 py-2 text-[11px] text-destructive-subtle-foreground"
          >
            {signOutError}
          </div>
        ) : null}

        <div className="flex flex-col gap-2 pt-1">
          <a
            href={supportMailto(email)}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-black text-white text-sm font-semibold shadow-[var(--clay-elev-ink-1)] hover:bg-black/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
          >
            <Mail className="w-4 h-4" aria-hidden="true" />
            Contact Customer Support
          </a>
          <p className="text-center text-[11px] text-muted-foreground">
            Email us at{" "}
            <a
              className="font-medium text-foreground underline underline-offset-2"
              href={`mailto:${SUPPORT_EMAIL}`}
            >
              {SUPPORT_EMAIL}
            </a>
          </p>
          {status === "sign_in_rejected" ? (
            <Link
              href="/login"
              className="w-full inline-flex items-center justify-center px-4 py-2.5 rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-foreground text-xs font-semibold shadow-[var(--clay-elev-1)] hover:bg-[var(--clay-sunken-deep)] transition-colors"
            >
              Return to sign in
            </Link>
          ) : null}
          {status !== "sign_in_rejected" ? (
            <button
              type="button"
              onClick={() => void handleLogout()}
              disabled={signingOut}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-foreground text-xs font-semibold shadow-[var(--clay-elev-1)] hover:bg-[var(--clay-sunken-deep)] disabled:opacity-60 transition-colors"
            >
              {signingOut ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  Signing out…
                </>
              ) : (
                <>
                  <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                  Sign out
                </>
              )}
            </button>
          ) : null}
        </div>
      </main>
    </div>
  );
}
