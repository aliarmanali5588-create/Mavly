import type { Metadata } from "next";
import Link from "next/link";
import { ShieldCheck, Mail, ArrowRight, FileText } from "lucide-react";
import { MarketingPageShell } from "@/components/common/MarketingPageShell";

export const metadata: Metadata = {
  title: "Terms of Service — Mavly AI Website Builder",
  description:
    "Read the terms governing your use of Mavly's AI website-building platform, workspace tools, integrations, and generation services.",
  openGraph: {
    title: "Terms of Service — Mavly AI Website Builder",
    description:
      "Read the terms governing your use of Mavly's AI website-building platform, workspace tools, integrations, and generation services.",
    images: ["/logo/Mavly.png"],
  },
};

export default function TermsPage() {
  return (
    <MarketingPageShell>
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 space-y-12">
        {/* Header */}
        <div className="space-y-3 border-b border-[var(--clay-line)] pb-6">
          <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
            <FileText className="w-3.5 h-3.5" />
            <span>LEGAL AGREEMENT</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-foreground">
            Terms of Service
          </h1>
          <p className="text-xs text-muted-foreground">
            Last updated: October 2026 · Standard Draft for Platform Usage
          </p>
        </div>

        {/* Legal Review Notice */}
        <div className="p-4 rounded-xl bg-amber-50/70 border border-amber-200/60 text-xs text-amber-900 leading-relaxed">
          <strong>Notice:</strong> This document represents a working operational draft of our platform terms of service. For formal enterprise agreements or bespoke commercial terms, contact <code>hello@mavly.xyz</code>.
        </div>

        {/* 13 Structured Sections */}
        <div className="space-y-10 text-xs sm:text-sm text-foreground leading-relaxed">
          <section id="agreement" className="space-y-2">
            <h2 className="text-base font-bold text-foreground">1. Introduction and Agreement to Terms</h2>
            <p>
              By accessing, browsing, or using the Mavly website building service (&quot;Mavly&quot;, &quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) available at mavly.xyz, you acknowledge that you have read, understood, and agree to be bound by these Terms of Service. If you do not agree to these terms, you must not access or use the platform.
            </p>
          </section>

          <section id="eligibility" className="space-y-2">
            <h2 className="text-base font-bold text-foreground">2. Eligibility and Account Responsibilities</h2>
            <p>
              You must be at least 18 years of age (or the age of majority in your jurisdiction) to create an account. When signing in through Google, GitHub, or email authentication, you agree to safeguard your credentials and remain responsible for all activities and project modifications performed under your account.
            </p>
          </section>

          <section id="acceptable-use" className="space-y-2">
            <h2 className="text-base font-bold text-foreground">3. Acceptable Use</h2>
            <p>
              You agree to use Mavly exclusively for lawful purposes. You shall not use the service to generate, publish, or transmit content that violates third-party intellectual property, promotes illegal goods or violence, conducts phishing or malware distribution, or attempts to disrupt or reverse-engineer our hosting infrastructure.
            </p>
          </section>

          <section id="user-inputs" className="space-y-2">
            <h2 className="text-base font-bold text-foreground">4. User Prompts, Inputs, and Generated Website Content</h2>
            <p>
              You retain rights to the original text prompts, descriptions, and proprietary brand assets you submit to the builder. As between you and Mavly, you own the website files, layouts, and copy generated for your specific projects, subject to applicable open-source licenses and third-party foundation model terms.
            </p>
          </section>

          <section id="ai-limitations" className="space-y-2">
            <h2 className="text-base font-bold text-foreground">5. AI-Generated Output Limitations &amp; Review Responsibility</h2>
            <p>
              Artificial intelligence generation models produce outputs based on statistical patterns. Output code may occasionally contain unintended layout anomalies, incomplete accessibility tags, or syntax errors. You are solely responsible for reviewing, testing, and verifying all generated code, styling, and text before publishing to a live custom domain.
            </p>
          </section>

          <section id="integrations" className="space-y-2">
            <h2 className="text-base font-bold text-foreground">6. Project Source, Integrations, and Third-Party Services</h2>
            <p>
              Mavly allows you to connect optional third-party integrations, such as personal GitHub accounts and external Supabase databases. You acknowledge that your use of third-party platforms is governed by their respective terms and privacy policies. Mavly is not responsible for data loss or outages on connected external services.
            </p>
          </section>

          <section id="billing" className="space-y-2">
            <h2 className="text-base font-bold text-foreground">7. Plans, Billing, and Credits</h2>
            <p>
              Mavly provides both complimentary starter tiers and paid subscription plans (Starter, Creator, Pro, Agency). Prices are quoted in INR or local currency where applicable. Credits are consumed upon initiating AI prompt operations. Additional credits may be purchased through top-up packs. Subscription fees are billed on recurring monthly or annual billing cycles.
            </p>
          </section>

          <section id="availability" className="space-y-2">
            <h2 className="text-base font-bold text-foreground">8. Service Availability &amp; Limitations</h2>
            <p>
              While we aim for high service availability across our global edge, Mavly is provided on an &quot;AS IS&quot; and &quot;AS AVAILABLE&quot; basis. We reserve the right to perform scheduled maintenance, update underlying model providers, or temporarily restrict workspace access during infrastructure migrations.
            </p>
          </section>

          <section id="ip-rights" className="space-y-2">
            <h2 className="text-base font-bold text-foreground">9. Intellectual Property Provisions</h2>
            <p>
              Mavly, its brand assets, software architecture, UI design system, logos, and proprietary algorithms are protected by copyright, trademark, and intellectual property laws. Nothing in these terms transfers ownership of Mavly&apos;s underlying platform or codebase to the user.
            </p>
          </section>

          <section id="termination" className="space-y-2">
            <h2 className="text-base font-bold text-foreground">10. Suspension and Termination</h2>
            <p>
              We reserve the right to suspend or terminate your account access if you materially breach these terms, engage in abusive generation requests, or fail to resolve billing discrepancies. You may delete your account and projects at any time.
            </p>
          </section>

          <section id="liability" className="space-y-2">
            <h2 className="text-base font-bold text-foreground">11. Disclaimers &amp; Limitation of Liability</h2>
            <p className="text-muted-foreground">
              [SUBJECT TO FORMAL LEGAL COUNSEL REVIEW] To the fullest extent permitted by applicable law, Mavly shall not be liable for any indirect, incidental, punitive, or consequential damages arising from your use of the website builder, including lost profits, data corruption, or third-party hosting interruptions.
            </p>
          </section>

          <section id="changes" className="space-y-2">
            <h2 className="text-base font-bold text-foreground">12. Changes to These Terms</h2>
            <p>
              We may update these Terms of Service periodically to reflect product evolutions or legal compliance updates. When changes occur, the &quot;Last updated&quot; date at the top of this document will be modified. Continued use of Mavly following updates indicates acceptance.
            </p>
          </section>

          <section id="contact" className="space-y-2 border-t border-[var(--clay-line)] pt-6">
            <h2 className="text-base font-bold text-foreground">13. Contact Information</h2>
            <p>
              For legal questions, general notices, or compliance inquiries, please reach out directly:
            </p>
            <div className="p-4 rounded-xl bg-[var(--clay-sunken)] border border-black/[0.04] inline-block font-mono text-xs">
              <a href="mailto:hello@mavly.xyz" className="text-black font-semibold hover:underline">
                hello@mavly.xyz
              </a>
            </div>
          </section>
        </div>
      </div>
    </MarketingPageShell>
  );
}
