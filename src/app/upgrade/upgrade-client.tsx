"use client";

import React, { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, Sparkles, CreditCard, ExternalLink, ShieldAlert } from "lucide-react";
import {
  PricingSection,
  type PricingPlan,
} from "@/components/home/PricingSection";
import { AuthNav } from "@/components/auth/AuthNav";
import { AnnouncementBanner } from "@/components/common/AnnouncementBanner";
import type { ProfileSummary } from "@/lib/user-profile";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface UpgradeClientProps {
  profile: ProfileSummary | null;
}

export function UpgradeClient({ profile }: UpgradeClientProps) {
  const userEmail = profile?.email ?? null;
  const [selectedPlanForNotice, setSelectedPlanForNotice] = useState<PricingPlan | null>(null);

  const handleSelectPlan = (plan: PricingPlan) => {
    setSelectedPlanForNotice(plan);
  };

  return (
    <div className="min-h-screen bg-[var(--clay-base)] text-foreground flex flex-col mavly-page-enter">
      {/* Top Navigation Bar */}
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
              <span className="text-foreground font-semibold">Upgrade</span>
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <AuthNav profile={profile} />
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1">
        {/* Reused Pricing Section */}
        <PricingSection
          id="upgrade-plans"
          badge="Upgrade"
          title="Choose your Mavly plan"
          description="Choose the plan that fits your workflow. Upgrade whenever you need more capacity and features."
          showEnterprise={true}
          isUpgradePage={true}
          userEmail={userEmail}
          onSelectPlan={handleSelectPlan}
          className="border-t-0 pt-12 sm:pt-16 pb-20"
        />

        {/* On-demand Credit Top-up Banner */}
        <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pb-20">
          <div className="p-6 sm:p-8 rounded-3xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
            <div className="max-w-xl">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles className="w-4 h-4 text-black" />
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  On-Demand AI Credits
                </span>
              </div>
              <h3 className="text-xl font-extrabold text-foreground tracking-tight">
                Need extra credits without changing your monthly plan?
              </h3>
              <p className="mt-1 text-xs sm:text-sm text-muted-foreground leading-relaxed font-normal">
                Purchase flexible one-time AI credit packages anytime to keep building, iterating, and polishing without interruption.
              </p>
            </div>
            <Link
              href="/credit-topup"
              className="mavly-btn-primary px-5 py-3 text-xs font-semibold shrink-0"
            >
              <span>Explore credit packs</span>
              <CreditCard className="w-3.5 h-3.5 shrink-0" />
            </Link>
          </div>
        </section>
      </main>

      {/* Checkout Limitation Modal (truthful reporting without fake purchases) */}
      <Dialog
        open={selectedPlanForNotice !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedPlanForNotice(null);
        }}
      >
        <DialogContent className="max-w-md bg-card p-6 sm:p-8 rounded-3xl border border-[var(--clay-line)] shadow-[var(--clay-float)]">
          <DialogHeader>
            <div className="w-10 h-10 rounded-2xl bg-warning-subtle border border-warning/25 flex items-center justify-center text-warning-subtle-foreground mb-2">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <DialogTitle className="text-xl font-bold tracking-tight text-foreground">
              Checkout Not Yet Configured
            </DialogTitle>
            <DialogDescription className="text-xs sm:text-sm text-muted-foreground leading-relaxed pt-2">
              Automated subscription checkout for the{" "}
              <strong className="text-foreground">{selectedPlanForNotice?.name}</strong> plan is currently in development.
              No payment provider is active on this deployment, and no charges have been made. Your account remains safely on the Free tier.
            </DialogDescription>
          </DialogHeader>

          <div className="my-4 p-3.5 rounded-xl bg-[var(--clay-base)] border border-[var(--clay-line)] text-xs text-foreground space-y-1.5">
            <div className="flex justify-between font-medium">
              <span>Selected Tier:</span>
              <span className="font-bold text-foreground">{selectedPlanForNotice?.name}</span>
            </div>
            <div className="flex justify-between font-medium">
              <span>Base Monthly Price:</span>
              <span>₹{selectedPlanForNotice?.monthlyPrice} / month</span>
            </div>
            <p className="text-[11px] text-muted-foreground pt-1 border-t border-[var(--clay-line)]">
              To request early access or volume agency billing, please contact our team directly.
            </p>
          </div>

          <div className="flex flex-col-reverse sm:flex-row items-center justify-end gap-2.5 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setSelectedPlanForNotice(null)}
              className="w-full sm:w-auto text-xs rounded-full py-2 px-4"
            >
              Close
            </Button>
            <Button asChild className="w-full sm:w-auto mavly-btn-primary text-xs py-2 px-4">
              <a
                href={`mailto:billing@mavly.xyz?subject=Mavly%20Plan%20Upgrade%20Inquiry%20-%20${encodeURIComponent(selectedPlanForNotice?.name || "")}`}
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
