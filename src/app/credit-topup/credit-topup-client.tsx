"use client";

import React, { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  ArrowLeft,
  Check,
  Info,
} from "lucide-react";
import { AuthNav } from "@/components/auth/AuthNav";
import { AnnouncementBanner } from "@/components/common/AnnouncementBanner";
import type { ProfileSummary } from "@/lib/user-profile";
import { formatINR } from "@/components/home/PricingSection";
import { PROVISIONAL_CREDIT_PACKAGES } from "@/lib/credits-config";
import { vcaasApi } from "@/lib/vcaas";
import { CheckoutButton } from "@/components/billing/CheckoutButton";
import { fetchPublicBillingCatalog } from "@/lib/billing/catalog-client";
import type { BillingCatalogProduct } from "@/lib/billing/types";

interface CreditTopupClientProps {
  profile: ProfileSummary | null;
}

/**
 * The caller's live credit balance.
 *
 * ⚠️ SAME HONESTY CONTRACT AS `CreditsIndicator`. `undefined` means "still
 * reading", `null` means "known unavailable", a number means the real
 * available balance (balance − active holds). This page never renders a
 * placeholder number, and never renders a zero it did not receive.
 */
function useAvailableCredits(enabled: boolean) {
  const [available, setAvailable] = React.useState<number | null | undefined>(undefined);

  React.useEffect(() => {
    if (!enabled) {
      setAvailable(null);
      return;
    }
    let active = true;
    setAvailable(undefined);

    vcaasApi
      .credits()
      .then((result) => {
        if (!active) return;
        const value = result.ok ? result.data?.available : null;
        setAvailable(
          result.ok && result.data?.enabled && typeof value === "number" ? value : null,
        );
      })
      .catch(() => {
        if (active) setAvailable(null);
      });

    return () => {
      active = false;
    };
  }, [enabled]);

  return available;
}

export function CreditTopupClient({ profile }: CreditTopupClientProps) {
  const userEmail = profile?.email ?? null;
  const [selectedPackageId, setSelectedPackageId] = useState<string>("starter-pack");
  const [catalog, setCatalog] = useState<BillingCatalogProduct[] | null>(null);
  const availableCredits = useAvailableCredits(Boolean(userEmail));

  React.useEffect(() => {
    let active = true;
    fetchPublicBillingCatalog()
      .then((rows) => {
        if (active) setCatalog(rows.filter((row) => row.market === "india" && row.productType === "credit_pack" && row.interval === "one_time" && row.amountMinor !== null && row.credits !== null));
      })
      .catch(() => {
        if (active) setCatalog([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const packages = PROVISIONAL_CREDIT_PACKAGES.flatMap((definition) => {
    const product = catalog?.find((row) => row.productId === definition.id);
    return product?.amountMinor !== null && product?.amountMinor !== undefined && product.credits !== null && product.credits !== undefined
      ? [{ ...definition, amountMinor: product.amountMinor, credits: product.credits }]
      : [];
  });
  const selectedPackage = packages.find((pkg) => pkg.id === selectedPackageId) ?? packages[0] ?? null;

  const balanceLabel =
    availableCredits === undefined
      ? "…"
      : availableCredits === null
        ? "—"
        : availableCredits.toLocaleString("en-IN");

  return (
    <div className="min-h-screen bg-[var(--clay-base)] text-foreground flex flex-col mavly-page-enter">
      {/* ── Header ───────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 bg-[color-mix(in_srgb,var(--clay-base)_86%,transparent)] backdrop-blur-md border-b border-[var(--clay-line)]">
        <AnnouncementBanner />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link
              href={userEmail ? "/dashboard" : "/"}
              className="flex items-center gap-2.5 group select-none"
            >
              <div className="w-8 h-8 rounded-xl overflow-hidden bg-card shadow-[var(--clay-elev-1)] p-0.5 border border-[var(--clay-line)] flex items-center justify-center transition-transform duration-200 clay-press">
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
              <span className="font-bold tracking-tight text-foreground text-base sm:text-lg leading-none">
                Mavly
              </span>
            </Link>

            <nav className="hidden sm:flex items-center gap-4 text-xs font-medium text-muted-foreground">
              <Link
                href={userEmail ? "/dashboard" : "/"}
                className="hover:text-black transition-colors flex items-center gap-1.5"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>{userEmail ? "Dashboard" : "Home"}</span>
              </Link>
              <span className="text-muted-foreground">/</span>
              <span className="text-foreground font-semibold">Credit Top-up</span>
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <AuthNav profile={profile} />
          </div>
        </div>
      </header>

      {/* ── Main ─────────────────────────────────────────────────────── */}
      <main className="flex-1 w-full">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 sm:py-20">
          {/* Hero */}
          <div className="text-center max-w-2xl mx-auto mb-12 sm:mb-16">
            <span className="text-xs font-bold tracking-widest uppercase text-muted-foreground mb-3 block">
              Credits
            </span>
            <h1 className="text-3xl sm:text-4xl md:text-5xl font-black tracking-tight text-foreground leading-tight">
              Top up your AI credits
            </h1>
            <p className="mt-4 text-sm sm:text-base text-muted-foreground leading-relaxed font-normal">
              One-time credit packs for building and refining your projects. They never
              expire and work across every Mavly project you own.
            </p>

            {/* Balance — real value from the credit account, or an honest dash. */}
            <div className="mt-8 flex justify-center">
              <div
                className="clay-subpanel inline-flex items-center gap-3 px-4 py-2.5"
                title={
                  availableCredits === null
                    ? "Your credit balance is unavailable right now"
                    : availableCredits === undefined
                      ? "Reading your credit balance"
                      : "Available credits"
                }
              >
                <Image
                  src="/svg/credit.svg"
                  alt=""
                  width={18}
                  height={18}
                  className="w-[18px] h-[18px] shrink-0 object-contain dark:invert"
                  priority
                  unoptimized
                />
                <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  Available
                </span>
                <span className="text-base font-black tabular-nums text-foreground leading-none">
                  {userEmail ? balanceLabel : "—"}
                </span>
                <span className="text-[11px] font-medium text-muted-foreground">
                  credits
                </span>
              </div>
            </div>

            {!userEmail && (
              <p className="mt-3 text-[11px] text-muted-foreground">
                Sign in to see your balance and link purchased credits to your account.
              </p>
            )}
          </div>

          {/* Pack grid */}
          <section aria-labelledby="packs-heading" className="mb-14 sm:mb-16">
            <div className="flex items-baseline justify-between gap-4 mb-5 px-1">
              <h2
                id="packs-heading"
                className="text-sm font-bold text-foreground uppercase tracking-wider"
              >
                Credit packs
              </h2>
              <span className="text-xs text-muted-foreground">
                {packages.length} available
              </span>
            </div>

            <div
              role="radiogroup"
              aria-label="Credit packages"
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 sm:gap-5 items-stretch"
            >
              {packages.map((pkg) => {
                const isSelected = pkg.id === selectedPackageId;

                return (
                  <div
                    key={pkg.id}
                    onClick={() => setSelectedPackageId(pkg.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedPackageId(pkg.id);
                      }
                    }}
                    role="radio"
                    aria-checked={isSelected}
                    aria-label={`${pkg.name}: ${pkg.credits.toLocaleString("en-IN")} credits for ${formatINR(pkg.amountMinor / 100)}`}
                    tabIndex={0}
                    className={`clay-card-interactive p-5 rounded-3xl flex flex-col justify-between cursor-pointer select-none outline-none ${
                      isSelected
                        ? "border border-transparent bg-primary text-primary-foreground shadow-[var(--clay-elev-ink-2)] focus-visible:shadow-[var(--clay-elev-ink-2),var(--clay-focus)]"
                        : "border border-[var(--clay-line)] bg-card text-foreground shadow-[var(--clay-elev-2)] focus-visible:shadow-[var(--clay-elev-2),var(--clay-focus)]"
                    }`}
                    style={
                      isSelected
                        ? { backgroundImage: "var(--clay-sheen-ink)" }
                        : { backgroundImage: "var(--clay-sheen)" }
                    }
                  >
                    <div>
                      {/* Pack identity + selected marker */}
                      <div className="flex items-center justify-between min-h-[22px] gap-2">
                        <span
                          className={`text-[11px] font-bold uppercase tracking-wider ${
                            isSelected
                              ? "text-primary-foreground/70"
                              : "text-muted-foreground"
                          }`}
                        >
                          {pkg.name}
                        </span>
                        {isSelected && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary-foreground text-primary text-[10px] font-bold uppercase tracking-wider">
                            <Check className="w-2.5 h-2.5" />
                            <span>Selected</span>
                          </span>
                        )}
                      </div>

                      {/* The thing being sold: the credit quantity. */}
                      <div className="mt-5 flex items-baseline gap-1.5">
                        <span className="text-3xl font-black tracking-tight tabular-nums leading-none">
                          {pkg.credits.toLocaleString("en-IN")}
                        </span>
                        <span
                          className={`text-xs font-semibold ${
                            isSelected
                              ? "text-primary-foreground/70"
                              : "text-muted-foreground"
                          }`}
                        >
                          credits
                        </span>
                      </div>

                      <p
                        className={`text-[11px] mt-2 leading-snug ${
                          isSelected
                            ? "text-primary-foreground/70"
                            : "text-muted-foreground"
                        }`}
                      >
                        AI generation &amp; build allowance
                      </p>
                    </div>

                    <div
                      className={`mt-6 pt-4 border-t ${
                        isSelected
                          ? "border-primary-foreground/15"
                          : "border-[var(--clay-line)]"
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-2 mb-3">
                        <span className="text-lg font-extrabold tracking-tight tabular-nums">
                          {formatINR(pkg.amountMinor / 100)}
                        </span>
                        <span
                          className={`text-[10px] font-medium ${
                            isSelected
                              ? "text-primary-foreground/60"
                              : "text-muted-foreground"
                          }`}
                        >
                          one-time
                        </span>
                      </div>

                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedPackageId(pkg.id);
                        }}
                        className={`w-full py-2.5 px-3 text-xs font-semibold ${
                          isSelected ? "mavly-btn-secondary" : "mavly-btn-primary"
                        }`}
                      >
                        {isSelected ? "Selected" : "Select pack"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Review + checkout */}
          <section
            aria-labelledby="review-heading"
            className="max-w-3xl mx-auto clay-panel p-6 sm:p-8"
          >
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 pb-6 border-b border-[var(--clay-line)]">
              <div>
                <span
                  id="review-heading"
                  className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground block mb-1.5"
                >
                  Your selection
                </span>
                <h3 className="text-2xl font-black text-foreground tracking-tight flex flex-wrap items-baseline gap-x-2">
                  <span>{selectedPackage?.name ?? "Unavailable"}</span>
                  <span className="text-base font-normal text-muted-foreground">·</span>
                  <span className="text-xl font-bold tabular-nums">
                    {selectedPackage ? `${selectedPackage.credits.toLocaleString("en-IN")} credits` : "Catalog unavailable"}
                  </span>
                </h3>
                <p className="text-xs text-muted-foreground mt-1.5">
                  One-time purchase. Never expires. Usable across all your Mavly AI
                  projects.
                </p>
              </div>

              <div className="text-left sm:text-right shrink-0">
                <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground block mb-1.5">
                  Total
                </span>
                <span className="text-3xl font-black text-foreground tracking-tight tabular-nums">
                  {selectedPackage ? formatINR(selectedPackage.amountMinor / 100) : "Unavailable"}
                </span>
                <span className="text-[11px] text-muted-foreground block mt-1">
                  Taxes applicable where required
                </span>
              </div>
            </div>

            <div className="mt-6 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
              <div className="flex items-start gap-2.5 max-w-md">
                <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                <p className="text-xs text-muted-foreground leading-relaxed">
                <strong className="text-foreground font-semibold">
                  Checkout is provider-verified.
                </strong>{" "}
                Credits are added only after the signed provider event is committed to the platform ledger.
                </p>
              </div>

              {selectedPackage ? (
                <CheckoutButton productId={selectedPackage.id} label={`Purchase ${selectedPackage.name}`} className="mavly-btn-primary px-6 py-3 text-xs font-semibold w-full sm:w-auto shrink-0" />
              ) : (
                <span className="text-xs text-muted-foreground">Billing catalog unavailable</span>
              )}
            </div>
          </section>

          {/* Cross-link */}
          <div className="mt-12 text-center">
            <p className="text-xs text-muted-foreground">
              Looking for monthly recurring prompt allowances and custom domain slots?{" "}
              <Link
                href="/upgrade"
                className="font-semibold text-foreground hover:underline inline-flex items-center gap-1"
              >
                <span>Explore Mavly subscription plans</span>
                <ArrowLeft className="w-3 h-3 rotate-180" />
              </Link>
            </p>
          </div>
        </div>
      </main>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <footer className="py-8 border-t border-[var(--clay-line)] text-xs text-muted-foreground">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p>© {new Date().getFullYear()} Mavly. All rights reserved.</p>
          <div className="flex items-center gap-5">
            <Link
              href="/support"
              className="text-muted-foreground hover:text-black transition-colors"
            >
              Help &amp; Support
            </Link>
            <Link
              href="/terms"
              className="text-muted-foreground hover:text-black transition-colors"
            >
              Terms
            </Link>
            <Link
              href="/privacy"
              className="text-muted-foreground hover:text-black transition-colors"
            >
              Privacy
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
