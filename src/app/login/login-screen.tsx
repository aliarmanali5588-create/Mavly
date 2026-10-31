"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { HeroShowcaseBackground } from "@/components/home/HeroSection";
import { startOAuth } from "@/lib/auth/oauth";
import { isOAuthProvider, type OAuthProvider } from "@/lib/auth/oauth-url";
import { signInErrorMessage } from "@/lib/auth/error-copy";
import { supabaseConfigProblem } from "@/lib/supabase/config";

type LoginScreenProps = {
  /** Validated internal destination the user came from. */
  redirectPath: string;
  /** Provider the user asked for (deep link from the homepage fallback). */
  initialProvider: string | null;
  /** Error code handed over by the OAuth callback. */
  initialError: string | null;
};

export default function LoginScreen({
  redirectPath,
  initialProvider,
  initialError,
}: LoginScreenProps) {
  const [loadingProvider, setLoadingProvider] = useState<OAuthProvider | null>(null);
  // ⚠️ There is no "sign up" / "sign in" switch any more: Google and GitHub
  // decide what happens. Supabase Auth creates the account on the first
  // successful OAuth sign-in and signs the same person in afterwards.
  const [error, setError] = useState<string | null>(
    initialError
      ? signInErrorMessage(initialError)
      : supabaseConfigProblem()
        ? signInErrorMessage("not_configured")
        : null,
  );
  const autoStarted = useRef(false);

  const beginOAuth = async (provider: OAuthProvider) => {
    if (loadingProvider) return;
    setError(null);
    setLoadingProvider(provider);

    try {
      const result = await startOAuth(provider, redirectPath);
      if (!result.ok) {
        setLoadingProvider(null);
        setError(signInErrorMessage(result.error));
        toast.error("We could not start the sign-in. Please try again.");
      }
    } catch {
      setLoadingProvider(null);
      setError("We could not start the sign-in. Please try again.");
    }
  };

  // Deep link such as /login?provider=google starts the flow right away.
  useEffect(() => {
    if (autoStarted.current) return;
    if (!isOAuthProvider(initialProvider)) return;
    autoStarted.current = true;
    void beginOAuth(initialProvider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProvider]);

  return (
    <div className="relative isolate min-h-screen flex flex-col justify-between bg-[var(--clay-base)] text-foreground font-sans mavly-page-enter">
      <HeroShowcaseBackground variant="login" />

      {/* ── Top Navigation Row ── */}
      <header className="w-full border-b border-black/[0.05] bg-card/70 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-8 h-16 sm:h-20 flex items-center justify-between">
          {/* Left Side: Back to Mavly */}
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-black transition-colors py-2 px-2.5 rounded-xl hover:bg-black/[0.04] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
          >
            <ArrowLeft className="w-4 h-4 text-muted-foreground group-hover:text-black transition-colors" />
            <span>Back to Mavly</span>
          </Link>

          {/* Right Side: Official Mavly Logo */}
          <Link
            href="/"
            className="flex items-center gap-2.5 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 p-1 group select-none"
            aria-label="Mavly Home"
          >
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl overflow-hidden bg-card shadow-xs p-0.5 border border-[var(--clay-line)] flex items-center justify-center transition-transform group-hover:scale-105 active:scale-95 shrink-0">
              <Image
                src="/logo/Mavly.png"
                alt="Mavly Logo"
                width={36}
                height={36}
                className="w-full h-full object-contain rounded-lg"
                priority
                referrerPolicy="no-referrer"
              />
            </div>
            <span className="font-extrabold tracking-tight text-foreground text-base hidden sm:inline-block">
              Mavly
            </span>
          </Link>
        </div>
      </header>

      {/* ── Central Authentication Card ── */}
      <main className="relative z-10 flex-1 flex items-center justify-center px-4 py-10 sm:py-16">
        <div className="w-full max-w-[420px] bg-card rounded-2xl sm:rounded-3xl border border-[var(--clay-line)] shadow-[var(--clay-float)] p-7 sm:p-10 transition-all">
          {/* A. Mavly Logo at top of the card */}
          <div className="flex flex-col items-center text-center">
            <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl overflow-hidden bg-card shadow-[var(--clay-elev-2)] p-1 border border-[var(--clay-line)] flex items-center justify-center mb-5 sm:mb-6 transition-transform hover:scale-105 duration-200 shrink-0 select-none">
              <Image
                src="/logo/Mavly.png"
                alt="Mavly Logo"
                width={56}
                height={56}
                className="w-full h-full object-contain rounded-xl"
                priority
                referrerPolicy="no-referrer"
              />
            </div>

            {/* B. Heading */}
            <h1 className="text-2xl sm:text-[26px] font-bold tracking-tight text-foreground">
              Welcome to Mavly
            </h1>

            {/* C. Supporting text */}
            <p className="mt-2 text-xs sm:text-sm text-muted-foreground font-normal max-w-[280px]">
              Sign in to keep building with AI.
            </p>
          </div>

          {/* D. Error state + E. Authentication Buttons */}
          <div className="mt-7 flex flex-col gap-3.5">
            {error ? (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50/70 px-3.5 py-3 text-xs sm:text-sm text-red-700"
              >
                <span className="font-medium shrink-0">
                  {supabaseConfigProblem() ? "Sign-in unavailable." : "Sign-in failed."}
                </span>
                <span className="min-w-0">{error}</span>
              </div>
            ) : null}

            {/* F. Continue with Google button */}
            <button
              type="button"
              disabled={!!loadingProvider}
              onClick={() => void beginOAuth("google")}
              className="w-full h-12 px-4 rounded-xl bg-primary hover:bg-[var(--clay-brand-hover)] text-white font-medium text-sm flex items-center justify-center gap-3 shadow-[var(--clay-elev-ink-2)] hover:shadow-[var(--clay-elev-ink-3)] hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] active:shadow-[var(--clay-elev-ink-1)] transition-all duration-200 disabled:opacity-70 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 cursor-pointer select-none"
            >
              {loadingProvider === "google" ? (
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

            {/* G. Continue with GitHub button */}
            <button
              type="button"
              disabled={!!loadingProvider}
              onClick={() => void beginOAuth("github")}
              className="w-full h-12 px-4 rounded-xl bg-card hover:bg-[var(--clay-sunken)] text-foreground border border-black/[0.1] hover:border-black/[0.18] font-medium text-sm flex items-center justify-center gap-3 shadow-[var(--clay-elev-1)] hover:shadow-[var(--clay-elev-2)] hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] active:shadow-[var(--clay-well-1)] transition-all duration-200 disabled:opacity-70 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 cursor-pointer select-none"
            >
              {loadingProvider === "github" ? (
                <Loader2 className="w-4 h-4 animate-spin text-foreground" />
              ) : (
                <svg className="w-4 h-4 shrink-0 fill-current text-foreground" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fillRule="evenodd"
                    clipRule="evenodd"
                    d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                  />
                </svg>
              )}
              <span>Continue with GitHub</span>
            </button>
          </div>

          {/* Legal Notice */}
          <div className="mt-8 pt-6 border-t border-black/[0.05] text-center">
            <p className="text-xs text-muted-foreground leading-relaxed">
              By continuing, you agree to our{" "}
              <Link href="/terms" className="text-muted-foreground hover:text-black underline underline-offset-2 transition-colors">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="text-muted-foreground hover:text-black underline underline-offset-2 transition-colors">
                Privacy Policy
              </Link>
              .
            </p>
          </div>
        </div>
      </main>

      {/* ── Page Footer ── */}
      <footer className="relative z-10 w-full py-6 text-center text-xs text-muted-foreground">
        © 2026 Mavly. All rights reserved.
      </footer>
    </div>
  );
}
