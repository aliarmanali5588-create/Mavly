import type { Metadata } from "next";
import Link from "next/link";
import {
  Sparkles,
  ArrowRight,
  GitCommit,
  CheckCircle2,
  Calendar,
  Layers,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { MarketingPageShell } from "@/components/common/MarketingPageShell";

export const metadata: Metadata = {
  title: "Changelog — Mavly AI Website Builder",
  description:
    "What’s changing in Mavly. Follow shipped improvements, fixes, and architectural updates to the website-building platform.",
  openGraph: {
    title: "Changelog — Mavly AI Website Builder",
    description:
      "What’s changing in Mavly. Follow shipped improvements, fixes, and architectural updates to the website-building platform.",
    images: ["/logo/Mavly.png"],
  },
};

interface ChangelogRelease {
  version: string;
  date: string;
  headline: string;
  status: "Shipped" | "In Progress";
  highlights: string[];
}

const RELEASES: ChangelogRelease[] = [
  {
    version: "v2.4.0",
    date: "October 2026",
    headline: "DeepSeek V4.1 Integration & Durable Restore Points",
    status: "Shipped",
    highlights: [
      "Integrated DeepSeek V4.1 Flash via OpenRouter for 3x faster website code generation and improved Tailwind v4 utility syntax.",
      "Implemented durable restore points: every completed AI run automatically snapshots the codebase to project_snapshots, allowing instant code rollbacks from the chat interface.",
      "Added mobile and desktop dual-viewport toggle inside the sandboxed preview iframe.",
      "Enhanced GitHub integration to support empty repositories (zero commits) with automated branch creation and initial commit push.",
    ],
  },
  {
    version: "v2.3.0",
    date: "September 2026",
    headline: "Figma URL Context",
    status: "Shipped",
    highlights: [
      "Added support for Figma selection links in prompts: extracts visual layout frames and injects bounded design context into generation.",
      "Strict Content Security Policy (CSP) sandboxing for static preview iframes, eliminating unauthorized script execution.",
    ],
  },
  {
    version: "v2.2.0",
    date: "August 2026",
    headline: "Mavly-Managed Publishing & Subdomain Allocation",
    status: "Shipped",
    highlights: [
      "Introduced opt-in static deployment pipeline attaching deterministic <project-id>.mavly.xyz hostnames.",
      "Added source code export: download complete static HTML and CSS bundles as ZIP archives anytime.",
      "Migrated auth layer to pure Supabase OAuth with Google and GitHub providers.",
      "Refactored client proxy and route authorization to enforce strict RLS project ownership.",
    ],
  },
  {
    version: "v2.5.0",
    date: "Upcoming (Q4 2026)",
    headline: "Custom Domain DNS Validation & Team Workspaces",
    status: "In Progress",
    highlights: [
      "Automated SSL certificate verification for user-provided root domains.",
      "Collaborative project permissions and shared team workspace credits.",
      "Visual click-to-edit component styling directly on the live preview canvas.",
    ],
  },
];

export default function ChangelogPage() {
  return (
    <MarketingPageShell>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-16">
        {/* Hero */}
        <div className="max-w-3xl mx-auto text-center space-y-4 pt-6 sm:pt-12">
          <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground bg-[var(--neu-sunken)] px-3 py-1 rounded-full border border-[var(--neu-line)]">
            <GitCommit className="w-3.5 h-3.5 text-foreground" />
            <span>PRODUCT UPDATES</span>
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-foreground leading-[1.1]">
            What’s changing in Mavly.
          </h1>

          <p className="text-base sm:text-lg text-muted-foreground leading-relaxed font-normal max-w-2xl mx-auto">
            Follow shipped improvements, fixes, and changes to the website-building experience.
          </p>
        </div>

        {/* Releases Timeline */}
        <div className="max-w-3xl mx-auto space-y-12">
          {RELEASES.map((rel) => (
            <div
              key={rel.version}
              className="p-8 rounded-3xl bg-card border border-[var(--neu-line)] shadow-[0_4px_20px_rgba(0,0,0,0.02)] space-y-6"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[var(--neu-line)] pb-4">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs font-bold px-2.5 py-1 rounded-lg bg-black text-white">
                    {rel.version}
                  </span>
                  <span className="text-xs text-muted-foreground font-medium">
                    {rel.date}
                  </span>
                </div>

                <span
                  className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full self-start sm:self-auto ${
                    rel.status === "Shipped"
                      ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                      : "bg-blue-50 text-blue-700 border border-blue-200"
                  }`}
                >
                  {rel.status}
                </span>
              </div>

              <div>
                <h2 className="text-xl font-bold text-foreground">{rel.headline}</h2>
              </div>

              <ul className="space-y-3 text-xs sm:text-sm text-foreground">
                {rel.highlights.map((item, idx) => (
                  <li key={idx} className="flex items-start gap-2.5 leading-relaxed">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>

              <div className="pt-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>Verified in repository codebase</span>
                <Link
                  href="/docs"
                  className="font-semibold text-black hover:underline inline-flex items-center gap-1"
                >
                  <span>Related Documentation</span>
                  <ArrowRight className="w-3 h-3" />
                </Link>
              </div>
            </div>
          ))}
        </div>
      </div>
    </MarketingPageShell>
  );
}
