import type { Metadata } from "next";
import { canonicalFor } from "@/lib/seo/site";
import { JsonLd } from "@/components/seo/JsonLd";
import { breadcrumbSchema } from "@/lib/seo/structured-data";
import Link from "next/link";
import {
  Sparkles,
  ArrowRight,
  Code2,
  Eye,
  GitBranch,
  Globe,
  Layers,
  Wand2,
  Terminal,
  ShieldCheck,
  CheckCircle2,
  ChevronRight,
  FileCode,
  Laptop,
} from "lucide-react";
import { MarketingPageShell } from "@/components/common/MarketingPageShell";

export const metadata: Metadata = {
  alternates: {
    canonical: canonicalFor("/features"),
  },
  title: "Features — Mavly AI Website Builder",
  description:
    "From your idea to a website, with AI. Prompt-based website generation, live sandboxed preview, code inspection, and GitHub synchronization.",
  openGraph: {
    title: "Features — Mavly AI Website Builder",
    description:
      "From your idea to a website, with AI. Prompt-based website generation, live sandboxed preview, code inspection, and GitHub synchronization.",
    images: ["/logo/Mavly.png"],
  },
};

export default function FeaturesPage() {
  return (
    <>
      {/* Breadcrumb trail for this nested public page. */}
      <JsonLd data={breadcrumbSchema([{ name: "Home", path: "/" }, { name: "Features", path: "/features" }])} />
      <MarketingPageShell>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-24">
          {/* 1. Hero Section */}
          <div className="max-w-3xl mx-auto text-center space-y-5 pt-6 sm:pt-12">
            <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground bg-[var(--clay-sunken)] px-3 py-1 rounded-full border border-[var(--clay-line)]">
              <Sparkles className="w-3.5 h-3.5 text-foreground" />
              <span>THE MAVLY BUILDER</span>
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-foreground leading-[1.1]">
              From your idea to a website, with AI.
            </h1>

            <p className="text-base sm:text-lg text-muted-foreground leading-relaxed font-normal max-w-2xl mx-auto">
              Describe what you want to build, shape the result in your workspace, and refine your website with an AI-assisted workflow.
            </p>

            <div className="pt-4 flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link
                href="/dashboard"
                className="mavly-btn-primary px-6 py-3 text-xs sm:text-sm font-semibold w-full sm:w-auto inline-flex items-center justify-center gap-2"
              >
                <span>Start Building Free</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
              <a
                href="#workflow"
                className="mavly-btn-secondary px-6 py-3 text-xs sm:text-sm font-semibold w-full sm:w-auto text-center"
              >
                Explore the Workflow
              </a>
            </div>
          </div>

          {/* 2. Section A: The 5-Step Workflow */}
          <section id="workflow" className="scroll-mt-28 space-y-10">
            <div className="max-w-2xl">
              <span className="text-xs font-bold tracking-wider uppercase text-muted-foreground">
                Step-by-Step Architecture
              </span>
              <h2 className="text-2xl sm:text-3xl font-extrabold text-foreground mt-1">
                How website generation works in Mavly
              </h2>
              <p className="text-sm text-muted-foreground mt-2">
                Every project follows an intentional 5-stage lifecycle from plain English requirements to a published static build.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
              {[
                {
                  step: "01",
                  title: "Describe your idea",
                  desc: "Type what your website is about, audience needs, branding preferences, and functional sections in plain text.",
                  icon: Wand2,
                },
                {
                  step: "02",
                  title: "Generate initial build",
                  desc: "The OpenRouter-hosted model produces HTML, Tailwind CSS styling, component structures, and copy.",
                  icon: Terminal,
                },
                {
                  step: "03",
                  title: "Review live preview",
                  desc: "Inspect the rendered website in a sandboxed, responsive preview container with desktop and mobile viewports.",
                  icon: Eye,
                },
                {
                  step: "04",
                  title: "Refine with follow-ups",
                  desc: "Ask the AI agent to adjust colors, tweak layouts, add sections, or edit files directly inside the code editor.",
                  icon: Layers,
                },
                {
                  step: "05",
                  title: "Publish or push to Git",
                  desc: "Deploy to a project subdomain or synchronize directly to your connected GitHub repository.",
                  icon: Globe,
                },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <div
                    key={item.step}
                    className="p-6 rounded-2xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] flex flex-col justify-between"
                  >
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-xs font-bold text-muted-foreground">
                          {item.step}
                        </span>
                        <div className="p-2 rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] shadow-[var(--clay-well-1)]">
                          <Icon className="w-4 h-4 text-foreground" />
                        </div>
                      </div>
                      <h3 className="text-base font-bold text-foreground">{item.title}</h3>
                      <p className="text-xs text-muted-foreground leading-relaxed font-normal">
                        {item.desc}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* 3. Section B: Builder Capabilities */}
          <section className="space-y-10">
            <div className="max-w-2xl">
              <span className="text-xs font-bold tracking-wider uppercase text-muted-foreground">
                Verified Technical Features
              </span>
              <h2 className="text-2xl sm:text-3xl font-extrabold text-foreground mt-1">
                Core platform capabilities
              </h2>
              <p className="text-sm text-muted-foreground mt-2">
                Built on Next.js 16 and Supabase with clear operational boundaries.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <div className="p-6 rounded-2xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] space-y-3">
                <div className="w-10 h-10 rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] flex items-center justify-center text-foreground shadow-[var(--clay-well-1)]">
                  <Wand2 className="w-5 h-5" />
                </div>
                <h3 className="text-base font-bold text-foreground">Prompt-Based Website Generation</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  The server-side OpenRouter model (DeepSeek V4.1 Flash) translates conversational prompts into complete HTML, CSS, and component files.
                </p>
              </div>

              <div className="p-6 rounded-2xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] space-y-3">
                <div className="w-10 h-10 rounded-xl bg-success-subtle border border-success/25 flex items-center justify-center text-success">
                  <Eye className="w-5 h-5" />
                </div>
                <h3 className="text-base font-bold text-foreground">Sandboxed Live Preview</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Static generated outputs render safely within an isolated, sandboxed preview iframe with zero unauthorized script execution.
                </p>
              </div>

              <div className="p-6 rounded-2xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] space-y-3">
                <div className="w-10 h-10 rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] flex items-center justify-center text-foreground shadow-[var(--clay-well-1)]">
                  <Code2 className="w-5 h-5" />
                </div>
                <h3 className="text-base font-bold text-foreground">File Tree &amp; Code Inspector</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Browse project files, inspect raw HTML/CSS, make custom edits, and download complete source ZIP archives anytime.
                </p>
              </div>

              <div className="p-6 rounded-2xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] space-y-3">
                <div className="w-10 h-10 rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] flex items-center justify-center text-foreground shadow-[var(--clay-well-1)]">
                  <GitBranch className="w-5 h-5" />
                </div>
                <h3 className="text-base font-bold text-foreground">GitHub App Integration</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Connect your personal GitHub account, select existing repositories, or commit the initial codebase with automated first-push tracking.
                </p>
              </div>

              <div className="p-6 rounded-2xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] space-y-3">
                <div className="w-10 h-10 rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] flex items-center justify-center text-foreground shadow-[var(--clay-well-1)]">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <h3 className="text-base font-bold text-foreground">Durable Restore Points</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Every prompt execution that modifies source code automatically snapshots the project baseline, allowing instant point-in-time code rollbacks.
                </p>
              </div>
            </div>
          </section>

          {/* 4. Section C: Designed for Different Needs */}
          <section className="p-8 sm:p-12 rounded-3xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] space-y-8">
            <div className="max-w-2xl">
              <span className="text-xs font-bold tracking-wider uppercase text-muted-foreground">
                Suitable Use Cases
              </span>
              <h2 className="text-2xl sm:text-3xl font-extrabold text-foreground mt-1">
                Built for ideas that need to become real
              </h2>
              <p className="text-sm text-muted-foreground mt-2">
                Mavly works particularly well for websites requiring rapid visual iteration and clear structural copy.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {[
                {
                  title: "SaaS & Product Landing Pages",
                  desc: "Showcase software features, comparison matrices, pricing tiers, and call-to-action flows.",
                },
                {
                  title: "Creator & Freelancer Portfolios",
                  desc: "Highlight case studies, project galleries, client testimonials, and contact booking channels.",
                },
                {
                  title: "Local Business Websites",
                  desc: "Design clean web presence for coffee shops, medical practices, agencies, and regional boutiques.",
                },
                {
                  title: "Interactive Prototypes",
                  desc: "Validate product concepts and UI flows in front of stakeholders and prospective investors.",
                },
                {
                  title: "Event & Launch Pages",
                  desc: "Announce upcoming product launches, conference schedules, and email waitlist signups.",
                },
                {
                  title: "Content & Editorial Portals",
                  desc: "Structure responsive blog layouts, company announcements, and resource libraries.",
                },
              ].map((useCase) => (
                <div key={useCase.title} className="p-5 rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] space-y-2 shadow-[var(--clay-well-1)]">
                  <h4 className="text-sm font-bold text-foreground">{useCase.title}</h4>
                  <p className="text-xs text-muted-foreground leading-relaxed">{useCase.desc}</p>
                </div>
              ))}
            </div>
          </section>

          {/* 5. Section D & E: Control, Ownership & Getting Started */}
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="p-8 rounded-2xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] space-y-4">
              <h3 className="text-xl font-bold text-foreground">Control and Ownership</h3>
              <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
                We believe you should never be trapped in a proprietary closed sandbox. All generated project files belong to you:
              </p>
              <ul className="space-y-2.5 text-xs text-foreground">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" />
                  <span>Export clean HTML and CSS as a downloadable ZIP package anytime.</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" />
                  <span>Synchronize directly with your own personal or organization GitHub repositories.</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" />
                  <span>No hidden tracking cookies or proprietary runtime locks injected into export files.</span>
                </li>
              </ul>
            </div>

            <div className="p-8 rounded-2xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] space-y-4">
              <h3 className="text-xl font-bold text-foreground">Getting Started in 60 Seconds</h3>
              <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
                No developer environment configuration, Node runtime installations, or credit card required.
              </p>
              <ol className="space-y-2.5 text-xs text-foreground list-decimal list-inside font-medium">
                <li>Sign in with your Google or GitHub account on the homepage.</li>
                <li>Type your website vision in the workspace prompt bar.</li>
                <li>Watch the live preview assemble before your eyes in real time.</li>
                <li>Iterate using conversational feedback or direct code edits.</li>
              </ol>
            </div>
          </section>

          {/* 6. Final CTA */}
          <div className="p-8 sm:p-14 rounded-3xl bg-black text-white text-center space-y-6 shadow-[var(--clay-elev-ink-1)]">
            <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
              Your next website starts with an idea.
            </h2>
            <p className="text-xs sm:text-sm text-muted-foreground max-w-xl mx-auto leading-relaxed">
              Join thousands of creators turning concepts into live, responsive websites without touching complex build tooling.
            </p>
            <div>
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-card text-black font-bold text-xs sm:text-sm border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] hover:border-[var(--clay-line-strong)] clay-press transition-[box-shadow,border-color,background-color]"
              >
                <span>Launch Builder</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </div>
      </MarketingPageShell>
    </>
  );
}
