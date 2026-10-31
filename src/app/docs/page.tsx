import type { Metadata } from "next";
import Link from "next/link";
import {
  BookOpen,
  ArrowRight,
  Terminal,
  Layers,
  GitBranch,
  CreditCard,
  AlertTriangle,
  HelpCircle,
  CheckCircle2,
  Code2,
  Eye,
  RotateCcw,
  ShieldCheck,
  Globe,
} from "lucide-react";
import { MarketingPageShell } from "@/components/common/MarketingPageShell";

export const metadata: Metadata = {
  title: "Documentation — Mavly AI Website Builder",
  description:
    "Everything you need to get started with Mavly. Learn the workspace basics, connect GitHub and Supabase, manage credits, and troubleshoot builds.",
  openGraph: {
    title: "Documentation — Mavly AI Website Builder",
    description:
      "Everything you need to get started with Mavly. Learn the workspace basics, connect GitHub and Supabase, manage credits, and troubleshoot builds.",
    images: ["/logo/Mavly.png"],
  },
};

export default function DocsPage() {
  return (
    <MarketingPageShell>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-16">
        {/* Hero */}
        <div className="max-w-3xl mx-auto text-center space-y-4 pt-6 sm:pt-12">
          <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground bg-[var(--neu-sunken)] px-3 py-1 rounded-full border border-[var(--neu-line)]">
            <BookOpen className="w-3.5 h-3.5 text-foreground" />
            <span>MAVLY DOCUMENTATION</span>
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-foreground leading-[1.1]">
            Everything you need to get started with Mavly.
          </h1>

          <p className="text-base sm:text-lg text-muted-foreground leading-relaxed font-normal max-w-2xl mx-auto">
            Learn the basics, configure your workspace, connect supported services, and understand the current website-building workflow.
          </p>
        </div>

        {/* Documentation Layout: Quick Nav + Rich Content Sections */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
          {/* Left Sticky Navigation Column */}
          <aside className="lg:col-span-3 lg:sticky lg:top-28 h-fit space-y-4 hidden lg:block text-xs">
            <div className="p-4 rounded-2xl bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-2)] space-y-3">
              <span className="font-bold uppercase tracking-wider text-muted-foreground text-[10px]">
                Documentation Index
              </span>
              <nav className="flex flex-col gap-2 font-medium">
                <a href="#getting-started" className="text-foreground hover:text-black py-1">
                  1. Getting Started
                </a>
                <a href="#workspace-guide" className="text-foreground hover:text-black py-1">
                  2. Workspace Guide
                </a>
                <a href="#integrations" className="text-foreground hover:text-black py-1">
                  3. Integrations Setup
                </a>
                <a href="#credits-plans" className="text-foreground hover:text-black py-1">
                  4. Credits &amp; Plans
                </a>
                <a href="#troubleshooting" className="text-foreground hover:text-black py-1">
                  5. Troubleshooting
                </a>
              </nav>
            </div>

            <div className="p-4 rounded-2xl bg-[var(--neu-base)] border border-[var(--neu-line)] text-xs space-y-2">
              <span className="font-bold text-foreground block">Need direct help?</span>
              <p className="text-muted-foreground text-[11px] leading-relaxed">
                Our support team is available at <code>support@mavly.xyz</code>.
              </p>
              <Link href="/support" className="text-black font-semibold hover:underline block pt-1">
                Open Support Center →
              </Link>
            </div>
          </aside>

          {/* Right Main Content Column */}
          <div className="lg:col-span-9 space-y-16">
            {/* Section A: Getting Started */}
            <section id="getting-started" className="scroll-mt-28 space-y-6">
              <div className="border-b border-[var(--neu-line)] pb-4">
                <span className="text-xs font-mono font-bold text-muted-foreground">Section 01</span>
                <h2 className="text-2xl font-bold text-foreground mt-1">Getting Started</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Step-by-step instructions to create your first website project.
                </p>
              </div>

              <div className="space-y-4 text-xs sm:text-sm text-foreground leading-relaxed">
                <div className="p-5 rounded-xl bg-card border border-[var(--neu-line)] space-y-2">
                  <h3 className="font-bold text-foreground text-sm">Step 1: Create an Account or Sign In</h3>
                  <p className="text-xs text-muted-foreground">
                    Visit the Mavly homepage and click &quot;Continue with Google&quot; or &quot;Continue with GitHub&quot;. Authentication is secured directly through Supabase Auth without intermediary credentials.
                  </p>
                </div>

                <div className="p-5 rounded-xl bg-card border border-[var(--neu-line)] space-y-2">
                  <h3 className="font-bold text-foreground text-sm">Step 2: Open the Workspace</h3>
                  <p className="text-xs text-muted-foreground">
                    Navigate to your <Link href="/dashboard" className="text-black font-semibold hover:underline">Dashboard</Link>. Click &quot;New Project&quot; to launch an empty canvas with the AI prompt bar initialized.
                  </p>
                </div>

                <div className="p-5 rounded-xl bg-card border border-[var(--neu-line)] space-y-2">
                  <h3 className="font-bold text-foreground text-sm">Step 3: Describe Your Website</h3>
                  <p className="text-xs text-muted-foreground">
                    Type your project vision into the prompt input. Be specific: include purpose, target audience, layout sections (hero, features, testimonials, footer), and design vibe.
                  </p>
                </div>

                <div className="p-5 rounded-xl bg-card border border-[var(--neu-line)] space-y-2">
                  <h3 className="font-bold text-foreground text-sm">Step 4: Review the Live Preview</h3>
                  <p className="text-xs text-muted-foreground">
                    The AI generation worker outputs HTML and Tailwind CSS files into your workspace. The sandboxed iframe refreshes automatically to render the compiled preview.
                  </p>
                </div>

                <div className="p-5 rounded-xl bg-card border border-[var(--neu-line)] space-y-2">
                  <h3 className="font-bold text-foreground text-sm">Step 5: Save and Manage Your Project</h3>
                  <p className="text-xs text-muted-foreground">
                    Every generation creates an automated restore point. You can rename your project, download the source code as a ZIP file, or connect a GitHub repository.
                  </p>
                </div>
              </div>
            </section>

            {/* Section B: Workspace Guide */}
            <section id="workspace-guide" className="scroll-mt-28 space-y-6">
              <div className="border-b border-[var(--neu-line)] pb-4">
                <span className="text-xs font-mono font-bold text-muted-foreground">Section 02</span>
                <h2 className="text-2xl font-bold text-foreground mt-1">Workspace Guide</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Understanding panels, status indicators, and point-in-time recovery.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div className="p-5 rounded-xl bg-card border border-[var(--neu-line)] space-y-2">
                  <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-purple-600" />
                    <h3 className="font-bold text-foreground text-sm">Chat &amp; Generation Status</h3>
                  </div>
                  <p className="text-muted-foreground leading-relaxed">
                    The conversation panel records the history of prompts, follow-up tweaks, model outputs, token usage, and execution status (Queued, Running, Completed).
                  </p>
                </div>

                <div className="p-5 rounded-xl bg-card border border-[var(--neu-line)] space-y-2">
                  <div className="flex items-center gap-2">
                    <Eye className="w-4 h-4 text-blue-600" />
                    <h3 className="font-bold text-foreground text-sm">Preview Sandbox Panel</h3>
                  </div>
                  <p className="text-muted-foreground leading-relaxed">
                    Rendered static preview served from <code>/api/preview/&#123;id&#125;/</code> with strict sandboxing. Switch between desktop (1440px) and mobile viewports with one click.
                  </p>
                </div>

                <div className="p-5 rounded-xl bg-card border border-[var(--neu-line)] space-y-2">
                  <div className="flex items-center gap-2">
                    <Code2 className="w-4 h-4 text-emerald-600" />
                    <h3 className="font-bold text-foreground text-sm">Code &amp; File Tree Panel</h3>
                  </div>
                  <p className="text-muted-foreground leading-relaxed">
                    Inspect the generated file tree (e.g. <code>preview.html</code>, styles, scripts). View raw code lines and make manual adjustments directly in the editor.
                  </p>
                </div>

                <div className="p-5 rounded-xl bg-card border border-[var(--neu-line)] space-y-2">
                  <div className="flex items-center gap-2">
                    <RotateCcw className="w-4 h-4 text-amber-600" />
                    <h3 className="font-bold text-foreground text-sm">Durable Restore Points</h3>
                  </div>
                  <p className="text-muted-foreground leading-relaxed">
                    Every completed AI run captures a snapshot of your files in <code>project_snapshots</code>. Click &quot;Restore Code&quot; on any execution bubble to roll back safely.
                  </p>
                </div>
              </div>
            </section>

            {/* Section C: Integrations */}
            <section id="integrations" className="scroll-mt-28 space-y-6">
              <div className="border-b border-[var(--neu-line)] pb-4">
                <span className="text-xs font-mono font-bold text-muted-foreground">Section 03</span>
                <h2 className="text-2xl font-bold text-foreground mt-1">Integrations Guide</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Connect GitHub repositories, Supabase metadata, and understand Vercel publishing.
                </p>
              </div>

              <div className="space-y-4 text-xs text-foreground leading-relaxed">
                <div className="p-5 rounded-xl bg-card border border-[var(--neu-line)] space-y-2">
                  <h3 className="font-bold text-foreground text-sm">GitHub Connection &amp; First Push</h3>
                  <p className="text-xs text-muted-foreground">
                    Authorize the Mavly GitHub App from the Project Settings panel. You can select an existing repository or connect an empty repository. If the repository is brand new (zero commits), Mavly tracks <code>first_push_pending</code> and creates the branch and initial commit using the GitHub Git Data API upon first push.
                  </p>
                </div>

                <div className="p-5 rounded-xl bg-card border border-[var(--neu-line)] space-y-2">
                  <h3 className="font-bold text-foreground text-sm">Vercel Publishing Prerequisites</h3>
                  <p className="text-xs text-muted-foreground">
                    Publishing uploads the standalone static preview bytes to <code>&lt;project-id&gt;.mavly.xyz</code>. It is disabled by default and requires server operator configuration. If not configured, requests return a truthful 503 error.
                  </p>
                </div>
              </div>
            </section>

            {/* Section D: Credits & Plans */}
            <section id="credits-plans" className="scroll-mt-28 space-y-6">
              <div className="border-b border-[var(--neu-line)] pb-4">
                <span className="text-xs font-mono font-bold text-muted-foreground">Section 04</span>
                <h2 className="text-2xl font-bold text-foreground mt-1">Credits and Plans</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  How AI compute credits and subscription tiers function in Mavly.
                </p>
              </div>

              <div className="p-6 rounded-2xl bg-card border border-[var(--neu-line)] space-y-4 text-xs">
                <p className="text-foreground leading-relaxed">
                  Every plan includes a monthly allocation of generation credits. Credits are consumed when an AI model processes a website prompt or refinement.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                  <div className="p-3.5 rounded-xl bg-[var(--neu-sunken)] border border-[var(--neu-line)]">
                    <span className="font-bold text-foreground block">Starter Tier</span>
                    <span className="text-muted-foreground text-[11px]">₹399/mo · Priority generation</span>
                  </div>
                  <div className="p-3.5 rounded-xl bg-[var(--neu-sunken)] border border-[var(--neu-line)]">
                    <span className="font-bold text-foreground block">Creator Tier</span>
                    <span className="text-muted-foreground text-[11px]">₹599/mo · GitHub sync &amp; restore</span>
                  </div>
                  <div className="p-3.5 rounded-xl bg-[var(--neu-sunken)] border border-[var(--neu-line)]">
                    <span className="font-bold text-foreground block">Pro Tier</span>
                    <span className="text-muted-foreground text-[11px]">₹899/mo · Unlimited custom domains</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-2">
                  <Link href="/pricing" className="mavly-btn-primary px-3.5 py-1.5 text-xs font-semibold">
                    View All Pricing Tiers
                  </Link>
                  <Link href="/credit-topup" className="mavly-btn-secondary px-3.5 py-1.5 text-xs font-semibold">
                    Credit Top-up Packs
                  </Link>
                </div>
              </div>
            </section>

            {/* Section E: Troubleshooting */}
            <section id="troubleshooting" className="scroll-mt-28 space-y-6">
              <div className="border-b border-[var(--neu-line)] pb-4">
                <span className="text-xs font-mono font-bold text-muted-foreground">Section 05</span>
                <h2 className="text-2xl font-bold text-foreground mt-1">Troubleshooting</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Actionable solutions for common workflow and connection issues.
                </p>
              </div>

              <div className="space-y-4 text-xs">
                <div className="p-5 rounded-xl bg-card border border-[var(--neu-line)] space-y-1.5">
                  <div className="flex items-center gap-2 text-foreground font-bold text-sm">
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                    <span>Generation Timeout or Model Error</span>
                  </div>
                  <p className="text-muted-foreground leading-relaxed">
                    If an upstream AI provider experiences latency, the builder will retry once or switch to the fallback pool. Check your internet connection, verify you have remaining credits in your profile, and try resubmitting a concise prompt.
                  </p>
                </div>

                <div className="p-5 rounded-xl bg-card border border-[var(--neu-line)] space-y-1.5">
                  <div className="flex items-center gap-2 text-foreground font-bold text-sm">
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                    <span>Empty Preview Screen</span>
                  </div>
                  <p className="text-muted-foreground leading-relaxed">
                    Check the Code panel to verify that <code>preview.html</code> was generated successfully. If an invalid HTML tag was produced, click the &quot;Restore Code&quot; button in the chat panel to revert to the previous snapshot.
                  </p>
                </div>

                <div className="p-5 rounded-xl bg-card border border-[var(--neu-line)] space-y-1.5">
                  <div className="flex items-center gap-2 text-foreground font-bold text-sm">
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                    <span>GitHub Authorization Failed</span>
                  </div>
                  <p className="text-muted-foreground leading-relaxed">
                    Make sure you grant the Mavly GitHub App permission to access the specific repository or organization. If you recently revoked access on github.com, click &quot;Disconnect&quot; in Workspace Settings and reconnect fresh.
                  </p>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </MarketingPageShell>
  );
}
