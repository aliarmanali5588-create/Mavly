"use client";

import React, { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowLeft, ShieldCheck, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";

export default function AdminAuthPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  const handleGoogleClick = () => {
    if (isLoading) return;
    setIsLoading(true);

    toast.info("Authenticating Administrator Session...", {
      description: "Redirecting to Mavly Control Console.",
      duration: 1200,
    });

    setTimeout(() => {
      router.push("/adminsh/dashboard");
    }, 900);
  };

  return (
    <div className="min-h-screen flex flex-col justify-between bg-[var(--neu-base)] text-foreground font-sans mavly-page-enter antialiased">
      {/* ── Top Header Navigation ── */}
      <header className="w-full border-b border-[var(--neu-line)] bg-card/80 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-8 h-16 flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-black transition-colors py-1.5 px-2.5 rounded-xl hover:bg-black/[0.04]"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Return to Site</span>
          </Link>

          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-xl overflow-hidden bg-card shadow-xs p-0.5 border border-[var(--neu-line)] flex items-center justify-center shrink-0">
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
              <span className="px-1.5 py-0.5 text-[9px] font-mono font-bold tracking-wider uppercase bg-black text-white rounded">
                ADMIN
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* ── Central Authentication Card ── */}
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-[400px] bg-card rounded-3xl border border-[var(--neu-line)] shadow-[0_20px_50px_rgba(0,0,0,0.04),0_4px_12px_rgba(0,0,0,0.02)] p-8 sm:p-10 space-y-7 transition-all">
          {/* Card Header & Branding */}
          <div className="flex flex-col items-center text-center space-y-3">
            <div className="relative">
              <div className="w-14 h-14 rounded-2xl overflow-hidden bg-card shadow-sm p-1 border border-[var(--neu-line)] flex items-center justify-center shrink-0 select-none">
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
              <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-black text-white flex items-center justify-center shadow-md border-2 border-white">
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

            <span className="px-2.5 py-0.5 rounded text-[10px] font-mono font-bold tracking-wider uppercase bg-[var(--neu-sunken)] text-muted-foreground">
              SINGLE-TENANT PROTOTYPE
            </span>
          </div>

          {/* Single Action: Continue with Google (Retained as sole auth option) */}
          <div className="pt-2">
            <button
              type="button"
              disabled={isLoading}
              onClick={handleGoogleClick}
              className="w-full h-11 px-4 rounded-xl bg-black hover:bg-neutral-800 text-white font-semibold text-xs sm:text-sm flex items-center justify-center gap-3 shadow-[0_4px_14px_rgba(0,0,0,0.12)] hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] transition-all duration-200 disabled:opacity-70 disabled:pointer-events-none cursor-pointer select-none"
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
          </div>

          {/* Security Caption */}
          <div className="pt-2 border-t border-black/[0.05] flex items-center justify-center gap-1.5 text-center text-[11px] text-muted-foreground">
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
