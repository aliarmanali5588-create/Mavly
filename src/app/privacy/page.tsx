import type { Metadata } from "next";
import Link from "next/link";
import { ShieldCheck, Mail, ArrowRight, Lock } from "lucide-react";
import { MarketingPageShell } from "@/components/common/MarketingPageShell";

export const metadata: Metadata = {
  title: "Privacy Policy — Mavly AI Website Builder",
  description:
    "Learn how Mavly handles your account data, project prompts, source code, and connected integrations with transparency and security.",
  openGraph: {
    title: "Privacy Policy — Mavly AI Website Builder",
    description:
      "Learn how Mavly handles your account data, project prompts, source code, and connected integrations with transparency and security.",
    images: ["/logo/Mavly.png"],
  },
};

export default function PrivacyPage() {
  return (
    <MarketingPageShell>
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 space-y-12">
        {/* Header */}
        <div className="space-y-3 border-b border-black/[0.06] pb-6">
          <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-gray-500">
            <Lock className="w-3.5 h-3.5" />
            <span>DATA &amp; PRIVACY</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-gray-950">
            Privacy Policy
          </h1>
          <p className="text-xs text-gray-400">
            Last updated: October 2026 · Grounded in Platform Architecture
          </p>
        </div>

        {/* Legal Transparency Notice */}
        <div className="p-4 rounded-xl bg-gray-50 border border-black/[0.06] text-xs text-gray-700 leading-relaxed">
          <strong>Privacy Commitment:</strong> This policy describes our actual data practices as implemented in our codebase. We do not sell your personal data or project files. For privacy questions, reach us at <code>hello@mavly.xyz</code>.
        </div>

        {/* 15 Structured Sections */}
        <div className="space-y-10 text-xs sm:text-sm text-gray-700 leading-relaxed">
          <section id="scope" className="space-y-2">
            <h2 className="text-base font-bold text-gray-950">1. Introduction and Scope</h2>
            <p>
              This Privacy Policy explains how Mavly collects, uses, protects, and discloses personal information and project data when you use the Mavly website builder at mavly.xyz and its related web services.
            </p>
          </section>

          <section id="provided-info" className="space-y-2">
            <h2 className="text-base font-bold text-gray-950">2. Information Users Provide</h2>
            <p>
              We collect information that you directly provide when registering an account, configuring user preferences, submitting website generation prompts, or contacting customer support.
            </p>
          </section>

          <section id="account-data" className="space-y-2">
            <h2 className="text-base font-bold text-gray-950">3. Account and Authentication Data</h2>
            <p>
              When you sign in using Google or GitHub OAuth, we receive basic identity information permitted by your authorization: your email address, primary name, avatar URL, and provider account identifier. We do not store your Google or GitHub account passwords.
            </p>
          </section>

          <section id="projects-data" className="space-y-2">
            <h2 className="text-base font-bold text-gray-950">4. Prompts, Generated Projects, and Project Files</h2>
            <p>
              Your conversational prompts, follow-up messages, and the resulting HTML/CSS files are stored in our Supabase database under strict user-scoped Row-Level Security (RLS) policies. Only authenticated requests matching the project&apos;s owner ID are permitted to read or modify these files.
            </p>
          </section>

          <section id="connected-services" className="space-y-2">
            <h2 className="text-base font-bold text-gray-950">5. Connected Services (GitHub, Supabase &amp; Vercel)</h2>
            <p>
              When you connect external accounts (such as GitHub for source code commits or Supabase for organization discovery), integration access tokens are encrypted on our server using AES-256-GCM before storage. These tokens are used solely to perform the actions you initiate and are never exposed to browser client code.
            </p>
          </section>

          <section id="ai-providers" className="space-y-2">
            <h2 className="text-base font-bold text-gray-950">6. AI Providers &amp; Data Transmission</h2>
            <p>
              To generate websites, your natural language prompts and current project file context are transmitted securely over HTTPS to our server-side FreeModel integration. Image-generation requests use a separate OpenRouter image API path. We do not send your email address or account credentials to either provider.
            </p>
          </section>

          <section id="billing-data" className="space-y-2">
            <h2 className="text-base font-bold text-gray-950">7. Payments and Billing Data</h2>
            <p>
              Subscription and credit top-up transactions are processed through authorized payment gateways (e.g. Razorpay). Mavly does not store complete credit card numbers, CVVs, or bank account credentials on its own application servers.
            </p>
          </section>

          <section id="cookies" className="space-y-2">
            <h2 className="text-base font-bold text-gray-950">8. Cookies and Sessions</h2>
            <p>
              We use essential HTTP cookies strictly to maintain your authenticated session and secure CSRF/OAuth callback states (such as <code>mavly_oauth_next</code>). We do not use third-party behavioral advertising trackers on our builder pages.
            </p>
          </section>

          <section id="how-used" className="space-y-2">
            <h2 className="text-base font-bold text-gray-950">9. How Information is Used</h2>
            <p>
              We use collected information to:
            </p>
            <ul className="list-disc list-inside space-y-1 pl-1 text-gray-600">
              <li>Deliver, operate, and maintain the AI website builder.</li>
              <li>Authenticate your account and enforce project access boundaries.</li>
              <li>Process AI prompt requests and build sandboxed live previews.</li>
              <li>Provide customer and technical support upon your request.</li>
              <li>Prevent fraudulent activity, service abuse, and unauthorized access.</li>
            </ul>
          </section>

          <section id="sharing" className="space-y-2">
            <h2 className="text-base font-bold text-gray-950">10. When Information is Shared</h2>
            <p>
              We do not sell, rent, or trade your personal data. We share information only with trusted infrastructure service providers necessary to operate Mavly: hosting providers (Vercel), database infrastructure (Supabase), and AI model APIs (FreeModel for website/code generation and OpenRouter for image generation).
            </p>
          </section>

          <section id="retention" className="space-y-2">
            <h2 className="text-base font-bold text-gray-950">11. Data Retention and Deletion</h2>
            <p>
              We retain your projects and account information for as long as your account is active. If you delete a project, its files and snapshots are removed from active database rows. You may request full account data deletion by writing to <code>hello@mavly.xyz</code>.
            </p>
          </section>

          <section id="security" className="space-y-2">
            <h2 className="text-base font-bold text-gray-950">12. Security Practices</h2>
            <p>
              We employ defense-in-depth security measures:
            </p>
            <ul className="list-disc list-inside space-y-1 pl-1 text-gray-600">
              <li>All web traffic is encrypted in transit using Transport Layer Security (TLS 1.3).</li>
              <li>Database access is enforced via Supabase Row-Level Security (RLS).</li>
              <li>OAuth tokens and Figma keys are stored as AES-256-GCM ciphertext.</li>
              <li>Generated previews are isolated in an iframe sandbox without same-origin privileges.</li>
            </ul>
          </section>

          <section id="choices" className="space-y-2">
            <h2 className="text-base font-bold text-gray-950">13. User Privacy Choices</h2>
            <p>
              You can disconnect GitHub or Supabase accounts at any time from your Project Settings. You can export all project source files as a ZIP archive at any point to maintain an independent local backup.
            </p>
          </section>

          <section id="policy-changes" className="space-y-2">
            <h2 className="text-base font-bold text-gray-950">14. Changes to This Privacy Policy</h2>
            <p>
              We may revise this policy as our services evolve. If changes are made, we will update the &quot;Last updated&quot; date at the top of this document. Continued use of the platform constitutes acknowledgement of the updated policy.
            </p>
          </section>

          <section id="contact-privacy" className="space-y-2 border-t border-black/[0.06] pt-6">
            <h2 className="text-base font-bold text-gray-950">15. Contact Information</h2>
            <p>
              For privacy-related questions, data export requests, or security disclosures:
            </p>
            <div className="p-4 rounded-xl bg-gray-50 border border-black/[0.04] inline-block font-mono text-xs">
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
