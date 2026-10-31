"use client";

import React, { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  Briefcase,
  Check,
  Copy,
  CreditCard,
  ExternalLink,
  LifeBuoy,
  Mail,
  Sparkles,
} from "lucide-react";
import { AuthNav } from "@/components/auth/AuthNav";
import type { ProfileSummary } from "@/lib/user-profile";

interface SupportClientProps {
  profile: ProfileSummary | null;
}

interface ContactChannel {
  id: string;
  title: string;
  category: string;
  email: string;
  subject: string;
  purpose: string;
  icon: React.ComponentType<{ className?: string }>;
  actionLabel: string;
}

const CONTACT_CHANNELS: ContactChannel[] = [
  {
    id: "general",
    title: "General Enquiries",
    category: "General & Partnerships",
    email: "hello@mavly.xyz",
    subject: "Mavly General Enquiry",
    purpose:
      "For product questions, press and media inquiries, strategic partnerships, agency collaborations, and general questions about Mavly.",
    icon: Mail,
    actionLabel: "Email General Team",
  },
  {
    id: "support",
    title: "Technical Support & Help",
    category: "Builder & Hosting",
    email: "support@mavly.xyz",
    subject: "Mavly Technical Support Request",
    purpose:
      "For technical assistance with website generation, project errors, custom domain setup, sandboxed preview issues, or bug reports.",
    icon: LifeBuoy,
    actionLabel: "Email Technical Support",
  },
  {
    id: "billing",
    title: "Billing, Subscriptions & Payments",
    category: "Plans & Credits",
    email: "billing@mavly.xyz",
    subject: "Mavly Billing & Subscription Inquiry",
    purpose:
      "For questions regarding plan upgrades, AI credit packs, custom invoicing, enterprise terms, or payment troubleshooting.",
    icon: CreditCard,
    actionLabel: "Email Billing Team",
  },
  {
    id: "careers",
    title: "Careers & Job Opportunities",
    category: "Join Our Team",
    email: "careers@mavly.xyz",
    subject: "Mavly Careers Application / Inquiry",
    purpose:
      "For engineering, design, and AI roles, freelance collaborations, internships, or speculative applications to build the future with Mavly.",
    icon: Briefcase,
    actionLabel: "Email Careers Team",
  },
];

export function SupportClient({ profile }: SupportClientProps) {
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null);
  const isAuthenticated = Boolean(profile?.email || profile?.id);

  const handleCopy = async (email: string) => {
    try {
      await navigator.clipboard.writeText(email);
      setCopiedEmail(email);
      toast.success(`Copied ${email} to clipboard`);
      setTimeout(() => {
        setCopiedEmail((current) => (current === email ? null : current));
      }, 2000);
    } catch {
      toast.error(`Could not copy ${email}. Please copy it manually.`);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--neu-base)] text-foreground flex flex-col mavly-page-enter">
      {/* Top Header Navigation */}
      <header className="sticky top-0 z-50 bg-[color-mix(in_srgb,var(--neu-base)_86%,transparent)] backdrop-blur-md border-b border-[var(--neu-line)]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4 sm:gap-6">
            <Link
              href={isAuthenticated ? "/dashboard" : "/"}
              className="flex items-center gap-2.5 group select-none"
              aria-label="Mavly Home"
            >
              <div className="w-8 h-8 rounded-xl overflow-hidden bg-card shadow-xs p-0.5 border border-[var(--neu-line)] flex items-center justify-center transition-transform duration-200 group-hover:scale-105 active:scale-95">
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

            <nav className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <span className="text-muted-foreground">/</span>
              <span className="text-foreground font-semibold">Support</span>
            </nav>
          </div>

          <div className="flex items-center gap-3">
            {isAuthenticated ? (
              <Link
                href="/dashboard"
                className="mavly-btn-secondary px-3.5 py-1.5 text-xs font-semibold gap-1.5 hidden sm:inline-flex"
                aria-label="Return to Dashboard"
              >
                <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Back to Dashboard</span>
              </Link>
            ) : (
              <Link
                href="/"
                className="mavly-btn-secondary px-3.5 py-1.5 text-xs font-semibold gap-1.5 hidden sm:inline-flex"
                aria-label="Return to Home"
              >
                <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Back to Home</span>
              </Link>
            )}

            <AuthNav profile={profile} />
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-16 flex-1 w-full">
        {/* Page Heading & Introduction */}
        <div className="max-w-3xl mb-10 sm:mb-14">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[var(--neu-sunken)] border border-[var(--neu-line)] text-[11px] font-bold text-foreground tracking-wide uppercase mb-3">
            <LifeBuoy className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
            <span>MAVLY SUPPORT</span>
          </div>
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight text-foreground">
            Let&apos;s get you back to building.
          </h1>
          <p className="mt-3.5 text-sm sm:text-base text-muted-foreground leading-relaxed font-normal">
            Find guidance for your workspace, website generation, integrations, publishing, and account questions.
          </p>

          {/* Quick return button for mobile where top button is hidden */}
          <div className="mt-5 sm:hidden">
            <Link
              href={isAuthenticated ? "/dashboard" : "/"}
              className="mavly-btn-secondary px-3.5 py-1.5 text-xs font-semibold gap-1.5"
            >
              <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{isAuthenticated ? "Back to Dashboard" : "Back to Home"}</span>
            </Link>
          </div>
        </div>

        {/* 4 Clearly Separated Contact Options */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
          {CONTACT_CHANNELS.map((channel) => {
            const Icon = channel.icon;
            const isCopied = copiedEmail === channel.email;
            const mailtoHref = `mailto:${channel.email}?subject=${encodeURIComponent(channel.subject)}`;

            return (
              <section
                key={channel.id}
                aria-labelledby={`channel-title-${channel.id}`}
                className="mavly-soft-card mavly-soft-card-hover p-6 sm:p-7 flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between gap-3 mb-4">
                    <div className="w-11 h-11 rounded-2xl bg-card border border-[var(--neu-line)] shadow-xs flex items-center justify-center text-foreground shrink-0">
                      <Icon className="w-5 h-5 text-foreground" aria-hidden="true" />
                    </div>
                    <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[var(--neu-sunken)] text-foreground border border-[var(--neu-line)]">
                      {channel.category}
                    </span>
                  </div>

                  <h2
                    id={`channel-title-${channel.id}`}
                    className="text-lg font-bold text-foreground tracking-tight mb-2"
                  >
                    {channel.title}
                  </h2>

                  <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed font-normal mb-6">
                    {channel.purpose}
                  </p>
                </div>

                <div className="pt-5 border-t border-[var(--neu-line)] space-y-3.5">
                  <div className="flex items-center justify-between gap-2 p-2 sm:p-2.5 rounded-xl bg-[var(--neu-base)] border border-black/[0.05]">
                    <div className="min-w-0 flex-1 pl-1">
                      <span className="block text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
                        Recipient Address
                      </span>
                      <a
                        href={mailtoHref}
                        className="font-mono text-xs sm:text-[13px] font-medium text-foreground hover:underline truncate block"
                        title={`Open email to ${channel.email}`}
                      >
                        {channel.email}
                      </a>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleCopy(channel.email)}
                      className="px-2.5 py-1.5 rounded-lg bg-card border border-[var(--neu-line)] text-xs font-medium text-foreground hover:text-black hover:bg-[var(--neu-sunken)] shadow-xs active:scale-95 transition-all flex items-center gap-1.5 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--neu-brand)]"
                      aria-label={`Copy ${channel.email} to clipboard`}
                    >
                      {isCopied ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                          <span className="text-[11px] text-emerald-700 font-semibold">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
                          <span className="text-[11px]">Copy</span>
                        </>
                      )}
                    </button>
                  </div>

                  <a
                    href={mailtoHref}
                    className="mavly-btn-primary w-full py-2.5 px-4 text-xs font-semibold gap-1.5"
                    aria-label={`${channel.actionLabel} at ${channel.email}`}
                  >
                    <span>{channel.actionLabel}</span>
                    <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                  </a>
                </div>
              </section>
            );
          })}
        </div>

        {/* Diagnostic Problem Reporting Guidance */}
        <div className="mavly-soft-card p-6 sm:p-8 mb-8 border border-[var(--neu-line)] space-y-3">
          <h3 className="text-sm font-bold text-foreground">
            Frequently Encountered Problems &amp; How to Report
          </h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            When reporting a bug or generation issue, please provide your <strong>Project ID</strong> (from the URL <code>/project/&#123;id&#125;</code>), the prompt text that caused the error, and any visible message in the chat panel.
          </p>
          <div className="p-3 rounded-xl bg-amber-50/70 border border-amber-200/60 text-[11px] text-amber-900">
            <strong>Security Notice:</strong> Never share passwords, GitHub personal access tokens, Supabase database secrets, or API keys with support or anyone else. Our team will never ask for your credentials.
          </div>
        </div>

        {/* Self-Service Resources Section */}
        <div className="mavly-soft-card p-6 sm:p-8 mb-10 border border-[var(--neu-line)]">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="max-w-xl">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles className="w-4 h-4 text-foreground" aria-hidden="true" />
                <h3 className="text-base font-bold text-foreground tracking-tight">
                  Guides, Documentation &amp; Frequently Asked Questions
                </h3>
              </div>
              <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed font-normal">
                Looking for self-service help? Follow our step-by-step documentation, browse practical tutorials, or review plan details.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <Link
                href="/docs"
                className="mavly-btn-secondary px-3.5 py-2 text-xs font-semibold"
              >
                <span>Documentation</span>
              </Link>
              <Link
                href="/tutorials"
                className="mavly-btn-secondary px-3.5 py-2 text-xs font-semibold"
              >
                <span>Tutorials</span>
              </Link>
              <Link
                href="/faq"
                className="mavly-btn-secondary px-3.5 py-2 text-xs font-semibold"
              >
                <span>FAQs</span>
              </Link>
              <Link
                href="/pricing"
                className="mavly-btn-secondary px-3.5 py-2 text-xs font-semibold"
              >
                <span>Plans &amp; Pricing</span>
              </Link>
            </div>
          </div>
        </div>

        {/* Return to Dashboard / Return to Mavly Banner */}
        <div className="rounded-3xl bg-card border border-[var(--neu-line)] shadow-sm p-6 sm:p-8 flex flex-col sm:flex-row items-center justify-between gap-6">
          <div>
            <h3 className="text-base font-bold text-foreground tracking-tight">
              {isAuthenticated ? "Ready to continue building?" : "Ready to start building with Mavly?"}
            </h3>
            <p className="mt-1 text-xs sm:text-sm text-muted-foreground leading-relaxed font-normal">
              {isAuthenticated
                ? "Return to your workspace to generate, edit, and publish your websites."
                : "Describe your dream website in plain text and watch Mavly turn your ideas into functional websites."}
            </p>
          </div>
          <div className="flex items-center gap-3 w-full sm:w-auto shrink-0">
            {isAuthenticated ? (
              <Link
                href="/dashboard"
                className="mavly-btn-primary w-full sm:w-auto px-5 py-2.5 text-xs font-semibold gap-2"
                aria-label="Return to Dashboard"
              >
                <span>Back to Dashboard</span>
                <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
              </Link>
            ) : (
              <>
                <Link
                  href="/login"
                  className="mavly-btn-secondary w-full sm:w-auto px-4 py-2.5 text-xs font-semibold"
                >
                  Sign In
                </Link>
                <Link
                  href="/dashboard"
                  className="mavly-btn-primary w-full sm:w-auto px-5 py-2.5 text-xs font-semibold gap-2"
                >
                  <span>Start Building Free</span>
                  <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </Link>
              </>
            )}
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="py-8 border-t border-[var(--neu-line)] text-xs text-muted-foreground bg-card/40">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p>© {new Date().getFullYear()} Mavly. All rights reserved.</p>
          <div className="flex items-center gap-5">
            <Link href="/" className="text-muted-foreground hover:text-black transition-colors">
              Home
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
