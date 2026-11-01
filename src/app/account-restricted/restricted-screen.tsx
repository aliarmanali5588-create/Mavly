"use client";

import { useState } from "react";
import Link from "next/link";
import { ShieldAlert, LogOut, LifeBuoy, Loader2 } from "lucide-react";

interface RestrictedScreenProps {
  email: string | null;
  /** The operator-recorded reason, when one exists and is safe to show. */
  reason: string | null;
}

/**
 * ═══ ACCOUNT RESTRICTED ═════════════════════════════════════════════════════
 *
 * The blocked user's only screen. It must do three things and nothing else:
 * explain the state, let them sign out, and let them reach support.
 *
 * ⚠️ IT CANNOT BE DISMISSED. There is no close button and no "continue anyway":
 * the proxy refuses every protected route while the restriction is active, so a
 * dismiss control would only pretend to work.
 *
 * ⚠️ LOGOUT IS THE REAL SIGN-OUT. It calls the existing POST `/auth/signout`
 * route (the same one `AuthNav` uses) and only reports success once the server
 * confirms — no optimistic redirect that leaves a live session behind.
 *
 * ⚠️ SUPPORT IS THE EXISTING `/support` PAGE. No new address is invented here.
 */
export function RestrictedScreen({ email, reason }: RestrictedScreenProps) {
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const handleLogout = async () => {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);

    try {
      const response = await fetch("/auth/signout", { method: "POST", cache: "no-store" });
      if (!response.ok) throw new Error(`sign out failed (${response.status})`);
      // A full navigation, so no cached protected content survives in history.
      window.location.href = "/login";
    } catch {
      setSigningOut(false);
      setSignOutError("We couldn't sign you out. Please try again.");
    }
  };

  return (
    <div className="min-h-screen bg-[var(--clay-base)] text-foreground font-sans flex items-center justify-center p-4 antialiased">
      <div className="w-full max-w-md bg-card rounded-2xl border border-[var(--clay-line)] shadow-[var(--clay-float)] p-6 sm:p-8 space-y-5">
        <div className="flex items-start gap-3.5">
          <div className="w-11 h-11 rounded-2xl bg-destructive-subtle text-destructive flex items-center justify-center shrink-0">
            <ShieldAlert className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-extrabold tracking-tight text-foreground">
              Account Restricted
            </h1>
            {email && (
              <p className="text-[11px] text-muted-foreground font-mono truncate mt-0.5">
                {email}
              </p>
            )}
          </div>
        </div>

        <p className="text-sm text-muted-foreground leading-relaxed">
          Your Mavly account has been temporarily restricted by the administration team. You
          cannot access your workspace or generate new projects while this restriction is
          active.
        </p>

        {reason && (
          <div className="rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] px-4 py-3 shadow-[var(--clay-well-1)]">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Reason provided
            </p>
            <p className="text-xs text-foreground mt-1 leading-relaxed break-words">{reason}</p>
          </div>
        )}

        <p className="text-xs text-muted-foreground leading-relaxed">
          Your projects, files, credits and billing history have not been deleted. If you
          believe this is a mistake, contact support and the team can review the restriction.
        </p>

        {signOutError && (
          <div
            role="alert"
            className="rounded-xl border border-destructive/25 bg-destructive-subtle px-3 py-2 text-[11px] text-destructive-subtle-foreground"
          >
            {signOutError}
          </div>
        )}

        <div className="flex flex-col sm:flex-row items-stretch gap-2 pt-1">
          <button
            type="button"
            onClick={() => void handleLogout()}
            disabled={signingOut}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-black text-white text-xs font-semibold shadow-[var(--clay-elev-ink-1)] disabled:opacity-60 transition-opacity"
          >
            {signingOut ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Signing out…
              </>
            ) : (
              <>
                <LogOut className="w-3.5 h-3.5" />
                Logout
              </>
            )}
          </button>

          <Link
            href="/support"
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-foreground text-xs font-semibold shadow-[var(--clay-elev-1)] hover:bg-[var(--clay-sunken-deep)] transition-colors"
          >
            <LifeBuoy className="w-3.5 h-3.5" />
            Contact Support
          </Link>
        </div>
      </div>
    </div>
  );
}
