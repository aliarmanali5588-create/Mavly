"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, ShieldCheck, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { startOAuth } from "@/lib/auth/oauth";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export default function AdminAuthPage({ initialError = null }: { initialError?: string | null }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const code = initialError;
    if (code === "session_expired" || code === "admin_session_required") {
      return "Your admin session expired or is not active. Please authenticate again.";
    }
    if (code === "unauthorized") {
      return "This account is not authorized to access the Mavly Admin Panel.";
    }
    if (code === "admin_schema_missing") {
      return "Admin authentication is temporarily unavailable. Please contact the operator.";
    }
    return null;
  });

  const handleGoogleClick = async () => {
    if (isLoading) return;
    setIsLoading(true);
    setError(null);

    toast.info("Authenticating Administrator Session...", {
      description: "Redirecting to Mavly Control Console.",
      duration: 1200,
    });

    const supabase = getSupabaseBrowserClient();
    if (supabase) {
      // An expired admin grant must not be revived by the old refresh-token
      // session. Start the provider flow from a local sign-out so Supabase
      // creates a fresh Auth session whose creation time anchors the new grant.
      await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    }

    const result = await startOAuth("google", "/adminsh/dashboard");
    if (!result.ok) {
      setIsLoading(false);
      setError(
        result.error === "not_configured"
          ? "Admin authentication is not configured on this deployment."
          : "We could not start authentication. Please try again.",
      );
      toast.error("We could not start admin authentication.");
    }
  };

  const handlePasswordSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isLoading || !email.trim() || !password) return;

    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setError("Admin authentication is not configured on this deployment.");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Force a new Supabase Auth session before establishing the eight-hour
      // admin grant. This prevents an old refresh token from reviving access.
      await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) {
        setError("We could not authenticate this account for the Mavly Admin Panel.");
        setIsLoading(false);
        return;
      }

      const response = await fetch("/api/admin-auth/session", {
        method: "POST",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(
          response.status === 403
            ? "This account is not authorized to access the Mavly Admin Panel."
            : body?.error || "Admin authentication could not be completed. Please try again.",
        );
        setIsLoading(false);
        return;
      }

      router.replace("/adminsh/dashboard");
      router.refresh();
    } catch {
      setError("Admin authentication could not be completed. Please try again.");
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col justify-between bg-[var(--clay-base)] text-foreground font-sans mavly-page-enter antialiased">
      {/* ── Top Header Navigation ── */}
      <header className="w-full border-b border-[var(--clay-line)] bg-card/80 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-8 h-16 flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-black transition-colors py-1.5 px-2.5 rounded-xl hover:bg-[var(--clay-sunken)]"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Return to Site</span>
          </Link>

          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-xl overflow-hidden bg-card shadow-[var(--clay-elev-1)] p-0.5 border border-[var(--clay-line)] flex items-center justify-center shrink-0">
              <Image
                src="/logo/Mavly.png"
                alt="Mavly Logo"
                width={28}
                height={28}
                className="w-full h-full object-contain rounded-lg"
                priority
                referrerPolicy="no-referrer"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="font-extrabold tracking-tight text-foreground text-sm">
                Mavly
              </span>
              <span className="px-1.5 py-0.5 text-[9px] font-mono font-bold tracking-wider uppercase bg-black text-white rounded shadow-[var(--clay-elev-ink-1)]">
                ADMIN
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* ── Central Authentication Card ── */}
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-[400px] bg-card rounded-3xl border border-[var(--clay-line)] shadow-[var(--clay-float)] p-8 sm:p-10 space-y-7 transition-all">
          {/* Card Header & Branding */}
          <div className="flex flex-col items-center text-center space-y-3">
            <div className="relative">
              <div className="w-14 h-14 rounded-2xl overflow-hidden bg-card shadow-[var(--clay-elev-1)] p-1 border border-[var(--clay-line)] flex items-center justify-center shrink-0 select-none">
                <Image
                  src="/logo/Mavly.png"
                  alt="Mavly Logo"
                  width={48}
                  height={48}
                  className="w-full h-full object-contain rounded-xl"
                  priority
                  referrerPolicy="no-referrer"
                />
              </div>
              <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-black text-white flex items-center justify-center shadow-[var(--clay-elev-ink-1)] border-2 border-card">
                <Lock className="w-2.5 h-2.5" />
              </div>
            </div>

            <div>
              <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-foreground">
                Mavly Administration
              </h1>
              <p className="mt-1 text-xs text-muted-foreground font-normal">
                Enterprise control center for platform operations
              </p>
            </div>

            <span className="px-2.5 py-0.5 rounded text-[10px] font-mono font-bold tracking-wider uppercase bg-[var(--clay-sunken)] text-muted-foreground">
              SINGLE-TENANT PROTOTYPE
            </span>
          </div>

          {/* Admin authentication: provider OAuth or normal Supabase credentials. */}
           <div className="pt-2">
            {error ? (
              <div
                role="alert"
                className="mb-3 rounded-xl border border-destructive/25 bg-destructive-subtle px-3.5 py-3 text-xs text-destructive-subtle-foreground"
              >
                {error}
              </div>
            ) : null}
            <button
              type="button"
              disabled={isLoading}
              onClick={() => void handleGoogleClick()}
              className="w-full h-11 px-4 rounded-xl bg-primary hover:bg-[var(--clay-brand-hover)] text-white font-semibold text-xs sm:text-sm flex items-center justify-center gap-3 shadow-[var(--clay-elev-ink-2)] clay-press transition-all duration-200 disabled:opacity-70 disabled:pointer-events-none cursor-pointer select-none"
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin text-white" />
              ) : (
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="#4285F4"
                    d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.34 24 12 24z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.17 0 9.97 0 12s.45 3.83 1.25 5.42l4.03-3.15z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.34 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"
                  />
                </svg>
              )}
              <span>Continue with Google</span>
            </button>

            <div className="my-4 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <span className="h-px flex-1 bg-[var(--clay-line)]" />
              <span>or use credentials</span>
              <span className="h-px flex-1 bg-[var(--clay-line)]" />
            </div>

            <form onSubmit={(event) => void handlePasswordSubmit(event)} className="space-y-3">
              <label className="block text-left text-xs font-semibold text-foreground">
                Email
                <input
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={isLoading}
                  className="mt-1.5 h-11 w-full rounded-xl border border-[var(--clay-line)] bg-card px-3 text-sm font-normal outline-none transition focus:border-foreground"
                  required
                />
              </label>
              <label className="block text-left text-xs font-semibold text-foreground">
                Password
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={isLoading}
                  className="mt-1.5 h-11 w-full rounded-xl border border-[var(--clay-line)] bg-card px-3 text-sm font-normal outline-none transition focus:border-foreground"
                  required
                />
              </label>
              <button
                type="submit"
                disabled={isLoading || !email.trim() || !password}
                className="w-full h-11 rounded-xl bg-card hover:bg-[var(--clay-sunken)] text-foreground border border-[var(--clay-line)] font-semibold text-xs sm:text-sm shadow-[var(--clay-elev-1)] transition-all disabled:opacity-60 disabled:pointer-events-none"
              >
                {isLoading ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : "Sign in securely"}
              </button>
            </form>
          </div>

          {/* Security Caption */}
          <div className="pt-2 border-t border-[var(--clay-line)] flex items-center justify-center gap-1.5 text-center text-[11px] text-muted-foreground">
            <ShieldCheck className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span>Restricted to authorized organization administrators</span>
          </div>
        </div>
      </main>

      {/* ── Footer ── */}
      <footer className="w-full py-5 text-center text-xs text-muted-foreground">
        © 2026 Mavly Admin Panel · All rights reserved
      </footer>
    </div>
  );
}
