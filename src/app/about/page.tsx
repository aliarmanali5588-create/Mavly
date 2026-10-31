import type { Metadata } from "next";
import Link from "next/link";
import {
  Sparkles,
  ArrowRight,
  Heart,
  Target,
  Compass,
  Users,
  Code2,
  ShieldCheck,
  CheckCircle2,
} from "lucide-react";
import { MarketingPageShell } from "@/components/common/MarketingPageShell";

export const metadata: Metadata = {
  title: "About Mavly — We don't make websites. We make memories.",
  description:
    "Mavly helps turn website ideas into something people can see, shape, and share through an AI-assisted website-building workflow.",
  openGraph: {
    title: "About Mavly — We don't make websites. We make memories.",
    description:
      "Mavly helps turn website ideas into something people can see, shape, and share through an AI-assisted website-building workflow.",
    images: ["/logo/Mavly.png"],
  },
};

export default function AboutPage() {
  return (
    <MarketingPageShell>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-20">
        {/* Hero */}
        <div className="max-w-3xl mx-auto text-center space-y-5 pt-6 sm:pt-12">
          <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground bg-[var(--neu-sunken)] px-3 py-1 rounded-full border border-[var(--neu-line)]">
            <Heart className="w-3.5 h-3.5 text-foreground" />
            <span>ABOUT MAVLY</span>
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-foreground leading-[1.1]">
            We don&apos;t make websites. We make memories.
          </h1>

          <p className="text-base sm:text-lg text-muted-foreground leading-relaxed font-normal max-w-2xl mx-auto">
            Mavly helps turn website ideas into something people can see, shape, and share through an AI-assisted website-building workflow.
          </p>

          <div className="pt-2">
            <Link
              href="/dashboard"
              className="mavly-btn-primary px-6 py-3 text-xs sm:text-sm font-semibold inline-flex items-center gap-2"
            >
              <span>Start Building with Mavly</span>
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>

        {/* Story & Philosophy Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-5xl mx-auto">
          {/* Why Mavly Exists */}
          <div className="p-8 rounded-3xl bg-card border border-[var(--neu-line)] shadow-[0_4px_20px_rgba(0,0,0,0.02)] space-y-4">
            <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center">
              <Compass className="w-5 h-5" />
            </div>
            <h2 className="text-xl font-bold text-foreground">Why Mavly Exists</h2>
            <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed font-normal">
              Bringing a website idea to life has traditionally required coordinating disparate tools: writing code from scratch, configuring build pipelines, setting up DNS, and managing deployment servers.
            </p>
            <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed font-normal">
              For individuals, founders, and creators, this technical friction often stands between a creative spark and a tangible digital presence. Mavly bridges that gap by transforming conversational intent into functional, editable web experiences.
            </p>
          </div>

          {/* Our Mission */}
          <div className="p-8 rounded-3xl bg-card border border-[var(--neu-line)] shadow-[0_4px_20px_rgba(0,0,0,0.02)] space-y-4">
            <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center">
              <Target className="w-5 h-5" />
            </div>
            <h2 className="text-xl font-bold text-foreground">Our Mission</h2>
            <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed font-normal">
              Our mission is to make website creation genuinely accessible, transparent, and joyful. We want creators to spend time shaping their voice, product offerings, and stories rather than wrestling with boilerplate configurations.
            </p>
            <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed font-normal">
              When someone launches their first website or shows a prototype to their first customer, that milestone matters. That&apos;s why we say: we don&apos;t just build websites; we create moments people remember.
            </p>
          </div>
        </div>

        {/* How We Approach Building */}
        <div className="p-8 sm:p-12 rounded-3xl bg-card border border-[var(--neu-line)] shadow-[0_4px_20px_rgba(0,0,0,0.02)] max-w-5xl mx-auto space-y-8">
          <div className="max-w-2xl">
            <span className="text-xs font-bold tracking-wider uppercase text-muted-foreground">
              Core Principles
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-foreground mt-1">
              How we approach building software
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-xs text-foreground">
            <div className="space-y-2">
              <span className="font-bold text-foreground text-sm block">1. Clarity Over Hype</span>
              <p className="text-muted-foreground leading-relaxed">
                We present capabilities honestly. We don&apos;t make magical claims about zero-effort perfection—we give you intuitive levers to review, inspect, and refine code.
              </p>
            </div>
            <div className="space-y-2">
              <span className="font-bold text-foreground text-sm block">2. User Ownership</span>
              <p className="text-muted-foreground leading-relaxed">
                Your code is yours. Download clean HTML/CSS ZIP archives, connect directly to GitHub, and take your website anywhere without platform lock-in.
              </p>
            </div>
            <div className="space-y-2">
              <span className="font-bold text-foreground text-sm block">3. Safe Iteration</span>
 point-in-time restore snapshots ensure you can experiment boldly without ever losing previous working states.
            </div>
          </div>
        </div>

        {/* Who Mavly is For */}
        <div className="max-w-5xl mx-auto space-y-6">
          <h2 className="text-xl font-bold text-foreground text-center">Who Mavly is For</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
            <div className="p-5 rounded-2xl bg-card border border-[var(--neu-line)] space-y-2 text-center">
              <h3 className="font-bold text-foreground">Solo Founders</h3>
              <p className="text-muted-foreground">Launch MVPs and validate business ideas in hours instead of weeks.</p>
            </div>
            <div className="p-5 rounded-2xl bg-card border border-[var(--neu-line)] space-y-2 text-center">
              <h3 className="font-bold text-foreground">Freelancers</h3>
              <p className="text-muted-foreground">Deliver client concepts and rapid initial mockups with ease.</p>
            </div>
            <div className="p-5 rounded-2xl bg-card border border-[var(--neu-line)] space-y-2 text-center">
              <h3 className="font-bold text-foreground">Small Businesses</h3>
              <p className="text-muted-foreground">Establish a professional online presence without large agency costs.</p>
            </div>
            <div className="p-5 rounded-2xl bg-card border border-[var(--neu-line)] space-y-2 text-center">
              <h3 className="font-bold text-foreground">Creative Teams</h3>
              <p className="text-muted-foreground">Prototype landing pages and collaborate on web experiences quickly.</p>
            </div>
          </div>
        </div>

        {/* Final CTA */}
        <div className="p-8 sm:p-14 rounded-3xl bg-black text-white text-center space-y-6 max-w-5xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
            Have an idea? Start building with Mavly.
          </h2>
          <p className="text-xs sm:text-sm text-muted-foreground max-w-lg mx-auto leading-relaxed">
            Create your first website today. Free starter credits included with every new account.
          </p>
          <div>
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-card text-black font-bold text-xs sm:text-sm hover:bg-[var(--neu-sunken)] transition-colors"
            >
              <span>Launch Builder</span>
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </div>
    </MarketingPageShell>
  );
}
