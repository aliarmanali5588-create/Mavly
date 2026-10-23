"use client";

import React, { useState } from "react";
import Link from "next/link";
import { Check, ArrowRight, Sparkles, Building2, ShieldCheck } from "lucide-react";

/**
 * Single source of truth for Mavly pricing definitions, formulas, and tiers.
 */
export type BillingCycle = "monthly" | "yearly";

export interface PricingPlan {
  id: "free" | "starter" | "creator" | "pro";
  name: string;
  badge?: string;
  tierLabel: string;
  description: string;
  monthlyPrice: number; // Base price in INR
  ctaLabel: string;
  ctaHref: string;
  isPrimaryChoice: boolean;
  features: string[];
}

export interface EnterprisePlan {
  id: "agency" | "custom";
  name: string;
  priceDisplay: string;
  badge: string;
  description: string;
  ctaLabel: string;
  ctaHref: string;
  icon: typeof Building2;
  features: string[];
}

export const YEARLY_DISCOUNT_PERCENT = 20;

export const PRIMARY_PLANS: PricingPlan[] = [
  {
    id: "free",
    name: "Free",
    tierLabel: "Free Starter",
    description: "Explore Mavly and start creating with the AI website builder at zero cost.",
    monthlyPrice: 0,
    ctaLabel: "Get Started",
    ctaHref: "/login",
    isPrimaryChoice: false,
    features: [
      "Access to full AI website builder",
      "Instant layout and styling generation",
      "Complimentary starter AI build credits",
      "Live preview development sandbox",
      "Interactive database & table management",
      "Visual click-to-edit component inspector",
      "Instant shareable preview URLs",
    ],
  },
  {
    id: "starter",
    name: "Starter",
    badge: "Most Popular",
    tierLabel: "Individual Creators",
    description: "The primary entry tier for users who want to build, customize, and iterate more.",
    monthlyPrice: 399,
    ctaLabel: "Try the Magic",
    ctaHref: "/login?plan=starter",
    isPrimaryChoice: true,
    features: [
      "Everything included in Free",
      "Higher monthly AI prompt allowance",
      "Priority sandbox build processing",
      "Full source code export & ZIP download",
      "Custom domain connection with auto SSL",
      "Fast hot-reload live preview server",
      "Community & standard email support",
    ],
  },
  {
    id: "creator",
    name: "Creator",
    tierLabel: "Growing Builders",
    description: "For regular builders who need greater capacity, custom domains, and polish.",
    monthlyPrice: 599,
    ctaLabel: "Choose Creator",
    ctaHref: "/login?plan=creator",
    isPrimaryChoice: false,
    features: [
      "Everything included in Starter",
      "Expanded AI generation compute capacity",
      "Multiple custom domain connections",
      "Higher database storage & record limits",
      "Bidirectional GitHub repository sync",
      "Point-in-time version restore & rollbacks",
      "Priority email support with fast response",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    tierLabel: "Professional Scale",
    description: "For professional freelancers and demanding commercial web applications.",
    monthlyPrice: 1999,
    ctaLabel: "Choose Pro",
    ctaHref: "/login?plan=pro",
    isPrimaryChoice: false,
    features: [
      "Everything included in Creator",
      "Dedicated high-speed cloud compute sandboxes",
      "Unlimited custom domain attachments with SSL",
      "Advanced scheduled background cron jobs",
      "Custom webhooks and API integration tokens",
      "Comprehensive project transfer & clone tools",
      "Dedicated developer onboarding support",
    ],
  },
];

export const ENTERPRISE_PLANS: EnterprisePlan[] = [
  {
    id: "agency",
    name: "Agency",
    priceDisplay: "Custom",
    badge: "Multi-Client Studio",
    description:
      "For digital agencies building, delivering, and managing client websites collaboratively.",
    ctaLabel: "Contact Sales",
    ctaHref: "mailto:hello@mavly.xyz?subject=Mavly%20Agency%20Plan%20Inquiry",
    icon: Building2,
    features: [
      "Multi-client workspace isolation and permissions",
      "Client project handoff and transfer workflows",
      "Bulk custom domain provisioning and management",
      "High-concurrency AI generation allowances",
    ],
  },
  {
    id: "custom",
    name: "Custom",
    priceDisplay: "Custom pricing",
    badge: "Enterprise SLA",
    description:
      "For organizations requiring specialized compute isolation, negotiated limits, or tailored contracts.",
    ctaLabel: "Contact Us",
    ctaHref: "mailto:hello@mavly.xyz?subject=Mavly%20Custom%20Plan%20Inquiry",
    icon: ShieldCheck,
    features: [
      "Dedicated cloud compute sandboxes & isolated databases",
      "Custom SLA guarantees & priority support escalation",
      "Tailored compute and storage quotas per organization",
      "Invoicing, custom purchase orders & enterprise terms",
    ],
  },
];

/**
 * Format INR currency according to standard Indian notation.
 * e.g. 399 -> ₹399, 319.2 -> ₹319.20, 3830.4 -> ₹3,830.40
 */
export function formatINR(amount: number): string {
  if (amount === 0) return "₹0";
  const hasDecimals = amount % 1 !== 0;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: hasDecimals ? 2 : 0,
  }).format(amount);
}

/**
 * Calculate pricing according to the required 20% discount formula:
 * Annual total = Monthly base price * 12 * 0.80
 * Discounted monthly equivalent = Math.round(Monthly base price * 0.80) (clean integer rupees)
 * Annual saving = (Monthly base price * 12) - Annual total
 */
export function calculatePlanPricing(plan: PricingPlan, cycle: BillingCycle) {
  if (plan.monthlyPrice === 0) {
    return {
      displayMonthly: "₹0",
      integerPart: "₹0",
      decimalPart: "",
      isFree: true,
      annualTotal: 0,
      annualSavings: 0,
      annualTotalFormatted: "₹0",
      annualSavingsFormatted: "₹0",
    };
  }

  if (cycle === "monthly") {
    const formatted = formatINR(plan.monthlyPrice);
    return {
      displayMonthly: formatted,
      integerPart: formatted,
      decimalPart: "",
      isFree: false,
      annualTotal: plan.monthlyPrice * 12,
      annualSavings: 0,
      annualTotalFormatted: formatINR(plan.monthlyPrice * 12),
      annualSavingsFormatted: "₹0",
    };
  }

  // Yearly cycle (20% discount applied to annual commitment)
  // Displayed monthly equivalent rounded to whole rupees (removes unnecessary .20 paise decimals)
  const monthlyEquivalent = Math.round(plan.monthlyPrice * (1 - YEARLY_DISCOUNT_PERCENT / 100));
  const annualTotal = Math.round(plan.monthlyPrice * 12 * (1 - YEARLY_DISCOUNT_PERCENT / 100) * 100) / 100;
  const annualSavings = Math.round((plan.monthlyPrice * 12 - annualTotal) * 100) / 100;

  // Split integer and decimal paise for clear, unambiguous typographical hierarchy
  const fullFormatted = formatINR(monthlyEquivalent);
  const dotIndex = fullFormatted.indexOf(".");
  const integerPart = dotIndex !== -1 ? fullFormatted.slice(0, dotIndex) : fullFormatted;
  const decimalPart = dotIndex !== -1 ? fullFormatted.slice(dotIndex) : "";

  return {
    displayMonthly: fullFormatted,
    integerPart,
    decimalPart,
    isFree: false,
    annualTotal,
    annualSavings,
    annualTotalFormatted: formatINR(annualTotal),
    annualSavingsFormatted: formatINR(annualSavings),
  };
}

export interface PricingSectionProps {
  id?: string;
  badge?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  showEnterprise?: boolean;
  className?: string;
  isUpgradePage?: boolean;
  userEmail?: string | null;
  onSelectPlan?: (plan: PricingPlan) => void;
}

export function PricingSection({
  id = "pricing",
  badge = "Pricing",
  title = "Transparent pricing for every project.",
  description = "Start building your website today with complimentary starter credits. Upgrade to dedicated resources as your traffic grows.",
  showEnterprise = true,
  className = "",
  isUpgradePage = false,
  userEmail,
  onSelectPlan,
}: PricingSectionProps = {}) {
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("monthly");

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      setBillingCycle((prev) => (prev === "monthly" ? "yearly" : "monthly"));
    }
  };

  return (
    <section id={id} className={`py-24 sm:py-32 bg-[#faf9f6] border-t border-black/[0.06] relative ${className}`}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-2xl mx-auto mb-12 sm:mb-16">
          <span className="text-xs font-bold tracking-widest uppercase text-stone-500 mb-3 block">
            {badge}
          </span>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-black tracking-tight text-gray-950 leading-tight">
            {title}
          </h2>
          <p className="mt-4 text-sm sm:text-base text-gray-600 leading-relaxed font-normal">
            {description}
          </p>

          {/* Accessible Monthly / Yearly Billing Toggle */}
          <div className="mt-8 flex items-center justify-center">
            <div
              role="radiogroup"
              aria-label="Billing frequency"
              tabIndex={0}
              onKeyDown={handleKeyDown}
              className="inline-flex items-center p-1.5 rounded-full bg-stone-200/70 border border-black/[0.08] shadow-inner select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black"
            >
              <button
                type="button"
                role="radio"
                aria-checked={billingCycle === "monthly"}
                onClick={() => setBillingCycle("monthly")}
                className={`px-4 py-2 rounded-full text-xs font-semibold transition-all duration-200 cursor-pointer focus-visible:outline-none ${
                  billingCycle === "monthly"
                    ? "bg-black text-white shadow-xs"
                    : "text-gray-700 hover:text-black"
                }`}
              >
                Monthly
              </button>

              <button
                type="button"
                role="radio"
                aria-checked={billingCycle === "yearly"}
                onClick={() => setBillingCycle("yearly")}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-semibold transition-all duration-200 cursor-pointer focus-visible:outline-none ${
                  billingCycle === "yearly"
                    ? "bg-black text-white shadow-xs"
                    : "text-gray-700 hover:text-black"
                }`}
              >
                <span>Yearly</span>
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wide transition-colors ${
                    billingCycle === "yearly"
                      ? "bg-emerald-500 text-white"
                      : "bg-emerald-100 text-emerald-800"
                  }`}
                >
                  Save 20%
                </span>
              </button>
            </div>
          </div>
        </div>

        {/* ── 4 Primary Pricing Cards Grid ──────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 items-stretch">
          {PRIMARY_PLANS.map((plan) => {
            const pricing = calculatePlanPricing(plan, billingCycle);

            return (
              <div
                key={plan.id}
                className={`p-6 sm:p-7 rounded-3xl bg-white flex flex-col justify-between relative transition-all duration-300 ${
                  plan.isPrimaryChoice
                    ? "border-2 border-black shadow-[0_12px_36px_-6px_rgba(0,0,0,0.08)] hover:shadow-[0_16px_44px_-6px_rgba(0,0,0,0.12)] hover:-translate-y-1"
                    : "border border-black/[0.08] shadow-[0_4px_20px_-2px_rgba(0,0,0,0.03)] hover:shadow-[0_10px_30px_-4px_rgba(0,0,0,0.07)] hover:border-black/[0.14] hover:-translate-y-1"
                }`}
              >
                <div>
                  {/* Top Tier Header & Optional Popular Badge */}
                  <div className="flex items-center justify-between min-h-[26px]">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                      {plan.tierLabel}
                    </span>
                    {plan.badge && (
                      <span className="px-2.5 py-0.5 rounded-full bg-black text-white text-[10px] font-bold tracking-wide uppercase shadow-xs">
                        {plan.badge}
                      </span>
                    )}
                  </div>

                  <h3 className="text-2xl font-extrabold text-gray-950 mt-2 tracking-tight">
                    {plan.name}
                  </h3>

                  <p className="text-xs text-gray-500 mt-1 leading-relaxed min-h-[34px]">
                    {plan.description}
                  </p>

                  {/* Price Block */}
                  <div className="mt-5 pb-5 border-b border-black/[0.06]">
                    <div className="flex items-baseline gap-0.5">
                      <span className="text-3xl sm:text-4xl font-black text-gray-950 tracking-tight">
                        {pricing.integerPart}
                      </span>
                      {pricing.decimalPart && (
                        <span className="text-lg sm:text-xl font-bold text-gray-500 tracking-tight">
                          {pricing.decimalPart}
                        </span>
                      )}
                      {!pricing.isFree && (
                        <span className="text-xs text-gray-500 font-medium ml-1.5">
                          / month
                        </span>
                      )}
                    </div>

                    {/* Secondary Yearly Calculation Disclosures */}
                    <div className="min-h-[42px] mt-1.5 flex flex-col justify-center">
                      {pricing.isFree ? (
                        <span className="text-[11px] text-gray-400 font-medium">
                          Free forever · No card required
                        </span>
                      ) : billingCycle === "yearly" ? (
                        <>
                          <span className="text-[11px] text-gray-600 font-medium leading-tight">
                            Effective monthly rate · Billed annually at {pricing.annualTotalFormatted}/yr
                          </span>
                          <span className="text-[11px] text-emerald-600 font-semibold mt-0.5">
                            Save {pricing.annualSavingsFormatted} (20% off)
                          </span>
                        </>
                      ) : (
                        <span className="text-[11px] text-gray-400 font-medium">
                          Billed monthly · Cancel anytime
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Feature Checklist */}
                  <div className="mt-5 space-y-2.5">
                    {plan.features.map((feat, i) => (
                      <div key={i} className="flex items-start gap-2.5 text-xs text-gray-700 leading-snug">
                        <Check className="w-4 h-4 text-black shrink-0 mt-0.5" />
                        <span>{feat}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Bottom CTA Button Area */}
                <div className="mt-8 pt-5 border-t border-black/[0.06]">
                  {isUpgradePage && userEmail && plan.id === "free" ? (
                    <Link
                      href="/dashboard"
                      className="w-full py-3 text-xs font-semibold mavly-btn-secondary"
                    >
                      <span>Current Plan</span>
                      <ArrowRight className="w-3.5 h-3.5 shrink-0" />
                    </Link>
                  ) : isUpgradePage && userEmail && onSelectPlan ? (
                    <button
                      type="button"
                      onClick={() => onSelectPlan(plan)}
                      className={`w-full py-3 text-xs font-semibold cursor-pointer ${
                        plan.isPrimaryChoice
                          ? "mavly-btn-primary"
                          : "mavly-btn-secondary"
                      }`}
                    >
                      <span>{plan.ctaLabel}</span>
                      {plan.isPrimaryChoice ? (
                        <Sparkles className="w-3.5 h-3.5 shrink-0" />
                      ) : (
                        <ArrowRight className="w-3.5 h-3.5 shrink-0" />
                      )}
                    </button>
                  ) : (
                    <Link
                      href={plan.ctaHref}
                      className={`w-full py-3 text-xs font-semibold ${
                        plan.isPrimaryChoice
                          ? "mavly-btn-primary"
                          : "mavly-btn-secondary"
                      }`}
                    >
                      <span>{plan.ctaLabel}</span>
                      {plan.isPrimaryChoice ? (
                        <Sparkles className="w-3.5 h-3.5 shrink-0" />
                      ) : (
                        <ArrowRight className="w-3.5 h-3.5 shrink-0" />
                      )}
                    </Link>
                  )}

                  <p className="text-[11px] text-center text-gray-400 mt-2.5">
                    {pricing.isFree
                      ? (isUpgradePage && userEmail ? "Active Free Tier" : "No credit card required")
                      : (isUpgradePage ? "Select plan to review" : "Direct entry to AI workspace")}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Agency and Custom Section (Advanced Business Requirements) ── */}
        {showEnterprise && (
          <div className="mt-20 pt-16 border-t border-black/[0.06]">
            <div className="text-center max-w-xl mx-auto mb-10">
              <span className="text-xs font-bold tracking-widest uppercase text-stone-500 mb-2 block">
                Specialized Solutions
              </span>
              <h3 className="text-2xl sm:text-3xl font-black text-gray-950 tracking-tight">
                Agency & Custom Plans
              </h3>
              <p className="mt-2 text-xs sm:text-sm text-gray-600 leading-relaxed font-normal">
                High-volume delivery, client management, and tailored infrastructure for growing businesses and enterprises.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl mx-auto">
              {ENTERPRISE_PLANS.map((item) => {
                const Icon = item.icon;
                return (
                  <div
                    key={item.id}
                    className="p-6 sm:p-8 rounded-3xl bg-white border border-black/[0.08] shadow-[0_4px_20px_-2px_rgba(0,0,0,0.03)] hover:shadow-[0_10px_30px_-4px_rgba(0,0,0,0.07)] hover:border-black/[0.14] transition-all duration-300 flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-4">
                        <div className="w-10 h-10 rounded-2xl bg-[#faf9f6] border border-black/[0.06] flex items-center justify-center text-black">
                          <Icon className="w-5 h-5" />
                        </div>
                        <span className="px-2.5 py-0.5 rounded-full bg-stone-100 text-stone-700 text-[10px] font-bold tracking-wide uppercase">
                          {item.badge}
                        </span>
                      </div>

                      <h4 className="text-xl sm:text-2xl font-extrabold text-gray-950 tracking-tight">
                        {item.name}
                      </h4>

                      <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                        {item.description}
                      </p>

                      <div className="mt-4 flex items-baseline gap-1">
                        <span className="text-2xl font-black text-gray-950 tracking-tight">
                          {item.priceDisplay}
                        </span>
                      </div>

                      <div className="mt-5 space-y-2 pt-4 border-t border-black/[0.06]">
                        {item.features.map((feat, fIdx) => (
                          <div key={fIdx} className="flex items-start gap-2 text-xs text-gray-700 leading-snug">
                            <Check className="w-3.5 h-3.5 text-black shrink-0 mt-0.5" />
                            <span>{feat}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="mt-6 pt-5 border-t border-black/[0.06]">
                      <a
                        href={item.ctaHref}
                        className="mavly-btn-secondary w-full py-3 text-xs font-semibold"
                      >
                        <span>{item.ctaLabel}</span>
                        <ArrowRight className="w-3.5 h-3.5 shrink-0" />
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Bottom Disclosures & Pricing Truthfulness Note */}
        <div className="mt-12 text-center text-[11px] text-gray-400 max-w-lg mx-auto">
          All prices in Indian Rupees (INR). Annual plans billed as a single annual charge. Need a custom plan structure or have questions? Contact our team.
        </div>
      </div>
    </section>
  );
}
