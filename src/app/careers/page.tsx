"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  Briefcase,
  Sparkles,
  ArrowRight,
  Heart,
  Code2,
  Compass,
  Users,
  Copy,
  Check,
  ExternalLink,
  Info,
} from "lucide-react";
import { toast } from "sonner";
import { MarketingPageShell } from "@/components/common/MarketingPageShell";

export default function CareersPage() {
  const [copied, setCopied] = useState(false);
  const email = "careers@mavly.xyz";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(email);
      setCopied(true);
      toast.success("Copied careers@mavly.xyz to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Please copy careers@mavly.xyz manually.");
    }
  };

  return (
    <MarketingPageShell>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-20">
        {/* Hero */}
        <div className="max-w-3xl mx-auto text-center space-y-4 pt-6 sm:pt-12">
          <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground bg-[var(--neu-sunken)] px-3 py-1 rounded-full border border-[var(--neu-line)]">
            <Briefcase className="w-3.5 h-3.5 text-foreground" />
            <span>CAREERS AT MAVLY</span>
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-foreground leading-[1.1]">
            Help shape how people build for the web.
          </h1>

          <p className="text-base sm:text-lg text-muted-foreground leading-relaxed font-normal max-w-2xl mx-auto">
            We&apos;re interested in people who care about useful tools, thoughtful product experiences, and making website creation more accessible.
          </p>
        </div>

        {/* Section A: What We Value */}
        <div className="max-w-5xl mx-auto space-y-8">
          <div className="text-center max-w-2xl mx-auto">
            <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Our Culture &amp; Values
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-foreground mt-1">
              What we value
            </h2>
            <p className="text-xs sm:text-sm text-muted-foreground mt-2">
              Aspirational standards that guide how we design and build tools for creators.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="p-6 rounded-2xl bg-card border border-[var(--neu-line)] shadow-[0_4px_20px_rgba(0,0,0,0.02)] space-y-3">
              <div className="w-10 h-10 rounded-xl bg-purple-50 text-purple-700 flex items-center justify-center">
                <Code2 className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-foreground">Craftsmanship &amp; Clarity</h3>
              <p className="text-xs text-muted-foreground leading-relaxed font-normal">
                We believe exceptional software comes from obsessive attention to detail, readable code, and honest interfaces that do not hide behind marketing jargon.
              </p>
            </div>

            <div className="p-6 rounded-2xl bg-card border border-[var(--neu-line)] shadow-[0_4px_20px_rgba(0,0,0,0.02)] space-y-3">
              <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center">
                <Compass className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-foreground">Product Thinking</h3>
              <p className="text-xs text-muted-foreground leading-relaxed font-normal">
                Engineering and design work hand-in-hand. We care deeply about the user journey—from typing a prompt to reviewing a preview and deploying to production.
              </p>
            </div>

            <div className="p-6 rounded-2xl bg-card border border-[var(--neu-line)] shadow-[0_4px_20px_rgba(0,0,0,0.02)] space-y-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center">
                <Heart className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-foreground">User Empathy</h3>
              <p className="text-xs text-muted-foreground leading-relaxed font-normal">
                Our users range from first-time founders to seasoned developers. We build tools that empower them, respect their autonomy, and keep their data safe.
              </p>
            </div>
          </div>
        </div>

        {/* Section B: Areas of Interest */}
        <div className="p-8 sm:p-12 rounded-3xl bg-card border border-[var(--neu-line)] shadow-[0_4px_20px_rgba(0,0,0,0.02)] max-w-5xl mx-auto space-y-6">
          <div className="max-w-2xl">
            <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Future Disciplines
            </span>
            <h2 className="text-xl sm:text-2xl font-bold text-foreground mt-1">
              Areas of interest
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              Disciplines we frequently engage with and explore as the platform evolves.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs text-foreground">
            <div className="p-4 rounded-xl bg-[var(--neu-sunken)] border border-[var(--neu-line)] space-y-1">
              <span className="font-bold text-foreground block">AI &amp; Systems Engineering</span>
              <p className="text-muted-foreground">Model prompt orchestration, streaming parsers, and sandboxed preview execution.</p>
            </div>
            <div className="p-4 rounded-xl bg-[var(--neu-sunken)] border border-[var(--neu-line)] space-y-1">
              <span className="font-bold text-foreground block">Frontend Architecture</span>
              <p className="text-muted-foreground">Next.js App Router, Tailwind CSS design systems, and responsive workspace layout.</p>
            </div>
            <div className="p-4 rounded-xl bg-[var(--neu-sunken)] border border-[var(--neu-line)] space-y-1">
              <span className="font-bold text-foreground block">UI &amp; Visual Design</span>
              <p className="text-muted-foreground">Luxury minimalist aesthetics, soft-UI neumorphic depth, and ergonomic component hierarchies.</p>
            </div>
            <div className="p-4 rounded-xl bg-[var(--neu-sunken)] border border-[var(--neu-line)] space-y-1">
              <span className="font-bold text-foreground block">Developer Experience &amp; Docs</span>
              <p className="text-muted-foreground">Clear tutorials, actionable onboarding, and technical writing for creators.</p>
            </div>
          </div>
        </div>

        {/* Section C: Current Openings (Strictly truthful) */}
        <div className="p-8 rounded-3xl bg-card border border-[var(--neu-line)] shadow-[0_4px_20px_rgba(0,0,0,0.02)] max-w-3xl mx-auto text-center space-y-4">
          <div className="w-10 h-10 rounded-full bg-[var(--neu-sunken)] flex items-center justify-center mx-auto text-muted-foreground">
            <Info className="w-5 h-5" />
          </div>
          <h2 className="text-lg font-bold text-foreground">Current Openings</h2>
          <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed font-medium">
            There are no confirmed open positions listed right now.
          </p>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">
            We are a focused team building deliberately. As specific roles open up, they will be announced here.
          </p>
        </div>

        {/* Section D: Get In Touch */}
        <div className="p-8 sm:p-12 rounded-3xl bg-black text-white max-w-3xl mx-auto text-center space-y-6">
          <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
            Interested in what we are doing?
          </h2>
          <p className="text-xs sm:text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
            Send a note about what you enjoy building, links to past work, or a portfolio to our team.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
            <a
              href="mailto:careers@mavly.xyz?subject=Mavly%20Careers%20Inquiry"
              className="px-5 py-2.5 rounded-xl bg-card text-black font-bold text-xs hover:bg-[var(--neu-sunken)] transition-colors inline-flex items-center gap-2"
            >
              <span>Email careers@mavly.xyz</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
            <button
              type="button"
              onClick={handleCopy}
              className="px-4 py-2.5 rounded-xl bg-black border border-white/10 text-xs text-muted-foreground hover:text-white transition-colors inline-flex items-center gap-2 cursor-pointer"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400">Copied Address</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy Address</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </MarketingPageShell>
  );
}
