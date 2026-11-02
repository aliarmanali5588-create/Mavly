"use client";

import React, { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  ArrowLeft,
  Check,
  CreditCard,
  Coins,
  ShieldAlert,
  Info,
  ExternalLink,
} from "lucide-react";
import { AuthNav } from "@/components/auth/AuthNav";
import type { ProfileSummary } from "@/lib/user-profile";
import { formatINR } from "@/components/home/PricingSection";
import {
  PROVISIONAL_CREDIT_PACKAGES,
} from "@/lib/credits-config";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface CreditTopupClientProps {
  profile: ProfileSummary | null;
}

export function CreditTopupClient({ profile }: CreditTopupClientProps) {
  const userEmail = profile?.email ?? null;
  const [selectedPackageId, setSelectedPackageId] = useState<string>("pack-4");
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);

  const selectedPackage =
    PROVISIONAL_CREDIT_PACKAGES.find((pkg) => pkg.id === selectedPackageId) ||
    PROVISIONAL_CREDIT_PACKAGES[0];

  return (
    <div className="min-h-screen bg-[var(--clay-base)] text-foreground flex flex-col mavly-page-enter">
      {/* Top Header */}
      <header className="sticky top-0 z-50 bg-[color-mix(in_srgb,var(--clay-base)_86%,transparent)] backdrop-blur-md border-b border-[var(--clay-line)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link
              href={userEmail ? "/dashboard" : "/"}
              className="flex items-center gap-2.5 group select-none"
            >
              <div className="w-8 h-8 rounded-xl overflow-hidden bg-card shadow-[var(--clay-elev-1)] p-0.5 border border-[var(--clay-line)] flex items-center justify-center clay-press">
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

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
        {/* Page Title & Introductory Copy */}
        <div className="text-center max-w-3xl mx-auto mb-12 sm:mb-16">
          <span className="text-xs font-bold tracking-widest uppercase text-muted-foreground mb-3 block">
            Credits
          </span>
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-black tracking-tight text-foreground leading-tight">
            Top up your AI credits
          </h1>
          <p className="mt-4 text-sm sm:text-base text-muted-foreground leading-relaxed font-normal">
            Get extra credits for building and refining your projects with Mavly. Choose a package that fits your needs.
          </p>

          {/* User Account / Credit Status Banner */}
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl mx-auto text-left">
            {/* Account Status / Actual Balance Notice */}
            <div className="p-4 rounded-2xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-1)]">
              <div className="flex items-center gap-2 mb-1.5">
                <Coins className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs font-bold text-foreground uppercase tracking-wide">
                  Account Status
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {userEmail ? (
                  <>
                    Signed in as <span className="font-semibold text-foreground">{userEmail}</span>. Complimentary starter credits active on local engine.
                  </>
                ) : (
                  <>
                    Complimentary starter credits active for new builders. Sign in to link purchased credits.
                  </>
                )}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Live per-user ledger is in transition; no fabricated numerical balances are displayed.
              </p>
            </div>

            {/* Provisional Pricing Disclosure */}
            <div className="p-4 rounded-2xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-1)]">
              <div className="flex items-center gap-2 mb-1.5">
                <Info className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs font-bold text-foreground uppercase tracking-wide">
                  Provisional Pricing Notice
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Package amounts and quantities below are provisional placeholders for planning and UI layout.
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Final commercial pricing requires business sign-off before payment gateway activation.
              </p>
            </div>
          </div>
        </div>

        {/* 10 Package Cards Grid */}
        <div className="mb-14">
          <div className="flex items-center justify-between mb-4 px-1">
            <h2 className="text-sm font-bold text-foreground uppercase tracking-wider">
              Available Packages (10)
            </h2>
            <span className="text-xs text-muted-foreground">
              Click a card to select
            </span>
          </div>

          <div
            role="radiogroup"
            aria-label="Credit packages"
            className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 sm:gap-5 items-stretch"
          >
            {PROVISIONAL_CREDIT_PACKAGES.map((pkg) => {
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
                  tabIndex={0}
                  className={`clay-card-interactive p-5 rounded-3xl bg-card flex flex-col justify-between cursor-pointer select-none outline-none transition-[box-shadow,border-color] duration-200 ease-[cubic-bezier(0.22,0.61,0.36,1)] ${
                    isSelected
                      ? "border border-[var(--clay-line-strong)] shadow-[var(--clay-elev-4)] focus-visible:shadow-[var(--clay-elev-4),var(--clay-focus)]"
                      : "border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] hover:border-[var(--clay-line-strong)] focus-visible:shadow-[var(--clay-elev-2),var(--clay-focus)]"
                  } active:shadow-[var(--clay-well-2)]`}
                >
                  {/* Top: Package Identifier & Selected Indicator */}
                  <div>
                    <div className="flex items-center justify-between min-h-[22px]">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                        {pkg.name}
                      </span>
                      {isSelected ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold uppercase tracking-wider shadow-[var(--clay-elev-ink-1)]">
                          <Check className="w-2.5 h-2.5" />
                          <span>Selected</span>
                        </span>
                      ) : (
                        <span className="text-[10px] font-medium text-muted-foreground">
                          Pack
                        </span>
                      )}
                    </div>

                    {/* Credit Count */}
                    <div className="mt-4 flex items-baseline gap-1">
                      <span className="text-3xl font-black text-foreground tracking-tight">
                        {pkg.credits.toLocaleString("en-IN")}
                      </span>
                      <span className="text-xs font-semibold text-muted-foreground">
                        credits
                      </span>
                    </div>

                    <p className="text-[11px] text-muted-foreground mt-1">
                      AI generation & build allowance
                    </p>
                  </div>

                  {/* Bottom: Provisional Price & Action Button */}
                  <div className="mt-6 pt-4 border-t border-[var(--clay-line)]">
                    <div className="flex flex-col mb-3">
                      <span className="text-lg font-extrabold text-foreground tracking-tight">
                        {formatINR(pkg.priceINR)}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        Provisional price
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
                        isSelected ? "mavly-btn-primary" : "mavly-btn-secondary"
                      }`}
                    >
                      {isSelected ? "Selected" : "Select package"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Selected Package Review & Checkout Action Card */}
        <div className="max-w-3xl mx-auto rounded-3xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-3)] p-6 sm:p-8">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 pb-6 border-b border-[var(--clay-line)]">
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground block mb-1">
                Current Package Selection
              </span>
              <h3 className="text-2xl font-black text-foreground tracking-tight flex items-center gap-2">
                <span>{selectedPackage.name}</span>
                <span className="text-base font-normal text-muted-foreground">·</span>
                <span className="text-xl font-bold text-foreground">
                  {selectedPackage.credits.toLocaleString("en-IN")} Credits
                </span>
              </h3>
              <p className="text-xs text-muted-foreground mt-1">
                One-time credit pack. Never expires. Usable across all your Mavly AI projects.
              </p>
            </div>

            <div className="text-left sm:text-right shrink-0">
              <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground block mb-1">
                Provisional Amount
              </span>
              <span className="text-3xl font-black text-foreground tracking-tight">
                {formatINR(selectedPackage.priceINR)}
              </span>
              <span className="text-[11px] text-muted-foreground block mt-0.5">
                Taxes applicable where required
              </span>
            </div>
          </div>

          {/* Checkout Status Notice */}
          <div className="mt-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="clay-subpanel flex items-start gap-2.5 max-w-lg p-3.5">
              <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
              <p className="text-xs text-muted-foreground leading-relaxed">
                <strong className="text-foreground">Checkout status:</strong> Automated payment gateway integration (Razorpay / Stripe) is currently in development. You will not be charged.
              </p>
            </div>

            <button
              type="button"
              onClick={() => setShowCheckoutModal(true)}
              className="mavly-btn-primary px-6 py-3 text-xs font-semibold w-full sm:w-auto shrink-0"
            >
              <CreditCard className="w-3.5 h-3.5" />
              <span>Purchase {selectedPackage.name}</span>
            </button>
          </div>
        </div>

        {/* Subscription Cross-link Banner */}
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
      </main>

      {/* Checkout Limitation Modal (Truthful reporting, no fake purchase) */}
      <Dialog
        open={showCheckoutModal}
        onOpenChange={setShowCheckoutModal}
      >
        <DialogContent className="max-w-md bg-card p-6 sm:p-8 rounded-3xl border border-[var(--clay-line)] shadow-[var(--clay-float)]">
          <DialogHeader>
            <div className="w-10 h-10 rounded-2xl bg-warning-subtle border border-warning/25 shadow-[var(--clay-elev-1)] flex items-center justify-center text-warning-subtle-foreground mb-2">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <DialogTitle className="text-xl font-bold tracking-tight text-foreground">
              Payment Gateway Offline
            </DialogTitle>
            <DialogDescription className="text-xs sm:text-sm text-muted-foreground leading-relaxed pt-2">
              Automated payment processing for <strong className="text-foreground">{selectedPackage.name}</strong> ({selectedPackage.credits.toLocaleString("en-IN")} Credits) is not configured in this environment.
              No charges have been made, and credits cannot be granted without verified payment confirmation.
            </DialogDescription>
          </DialogHeader>

          <div className="clay-inset-panel my-4 p-3.5 text-xs text-foreground space-y-1.5">
            <div className="flex justify-between font-medium">
              <span>Selected Package:</span>
              <span className="font-bold text-foreground">{selectedPackage.name}</span>
            </div>
            <div className="flex justify-between font-medium">
              <span>Credits:</span>
              <span>{selectedPackage.credits.toLocaleString("en-IN")}</span>
            </div>
            <div className="flex justify-between font-medium">
              <span>Provisional Price:</span>
              <span>{formatINR(selectedPackage.priceINR)}</span>
            </div>
            <p className="text-[11px] text-muted-foreground pt-1 border-t border-[var(--clay-line)]">
              Real payment integration and ledger ledger accounting require commercial approval.
            </p>
          </div>

          <div className="flex flex-col-reverse sm:flex-row items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={() => setShowCheckoutModal(false)}
              className="mavly-btn-secondary w-full sm:w-auto text-xs py-2.5 px-5"
            >
              Close
            </button>
            <Button asChild className="w-full sm:w-auto mavly-btn-primary text-xs py-2.5 px-5">
              <a
                href={`mailto:billing@mavly.xyz?subject=Mavly%20Credit%20Top-up%20Inquiry%20-%20${encodeURIComponent(selectedPackage.name)}`}
              >
                <span>Contact Sales</span>
                <ExternalLink className="w-3 h-3 ml-1" />
              </a>
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Footer */}
      <footer className="py-8 border-t border-[var(--clay-line)] text-xs text-muted-foreground">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p>© {new Date().getFullYear()} Mavly. All rights reserved.</p>
          <div className="flex items-center gap-5">
            <Link href="/support" className="text-muted-foreground hover:text-black transition-colors">
              Help &amp; Support
            </Link>
            <Link href="/terms" className="text-muted-foreground hover:text-black transition-colors">
              Terms
            </Link>
            <Link href="/privacy" className="text-muted-foreground hover:text-black transition-colors">
              Privacy
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
