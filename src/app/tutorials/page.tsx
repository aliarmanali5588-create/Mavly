"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  GraduationCap,
  Sparkles,
  ArrowRight,
  ChevronDown,
  CheckCircle2,
  AlertCircle,
  Code2,
  GitBranch,
  Globe,
  Layers,
  Wand2,
  Terminal,
} from "lucide-react";
import { MarketingPageShell } from "@/components/common/MarketingPageShell";

interface TutorialGuide {
  id: string;
  category: "Getting Started" | "Design & Refinement" | "Integrations" | "Publishing" | "Troubleshooting";
  title: string;
  difficulty: "Beginner" | "Intermediate";
  intro: string;
  prerequisites: string[];
  steps: { stepNumber: number; instruction: string; detail: string }[];
  outcome: string;
  warnings?: string;
}

const TUTORIALS: TutorialGuide[] = [
  {
    id: "tut-1",
    category: "Getting Started",
    title: "Create your first website with prompt engineering",
    difficulty: "Beginner",
    intro: "Learn how to formulate an effective prompt that directs the AI model to build a complete, stylish, multi-section landing page.",
    prerequisites: ["A free Mavly account", "A conceptual idea of what you want to build"],
    steps: [
      {
        stepNumber: 1,
        instruction: "Open your Dashboard and start a New Project",
        detail: "Sign in with Google or GitHub and click the '+ New Project' card to launch a blank canvas.",
      },
      {
        stepNumber: 2,
        instruction: "Draft your structural prompt",
        detail: "Specify the business name, audience, hero headline, 3-4 distinct sections (Hero, Features, Pricing, Contact), and desired aesthetic tone.",
      },
      {
        stepNumber: 3,
        instruction: "Submit and inspect the generated preview",
        detail: "Press Enter. The AI worker generates HTML with modern Tailwind utility classes and loads the preview inside the iframe sandbox.",
      },
    ],
    outcome: "A functional, responsive single-page website ready for customization in your live preview.",
    warnings: "Avoid extremely vague prompts like 'make a website'. The more concrete your section requirements, the better the initial layout.",
  },
  {
    id: "tut-2",
    category: "Design & Refinement",
    title: "Refining your website without losing progress",
    difficulty: "Beginner",
    intro: "How to use conversational follow-up prompts to tweak colors, change layouts, and leverage point-in-time restore snapshots.",
    prerequisites: ["An existing generated project in your workspace"],
    steps: [
      {
        stepNumber: 1,
        instruction: "Select specific areas to adjust",
        detail: "Focus on one component or section at a time (e.g. 'Change the hero CTA button color to emerald green and enlarge the headline').",
      },
      {
        stepNumber: 2,
        instruction: "Send refinement prompt to the agent",
        detail: "The agent reads the existing source files, applies the diff, and writes an updated preview.html.",
      },
      {
        stepNumber: 3,
        instruction: "Review the automated restore point",
        detail: "If you prefer the earlier version, click 'Restore Code' next to the previous AI response bubble in the chat to revert immediately.",
      },
    ],
    outcome: "Confidently iterate on layouts with zero fear of breaking earlier working states.",
  },
  {
    id: "tut-3",
    category: "Integrations",
    title: "Connecting a GitHub repository & the first-push workflow",
    difficulty: "Intermediate",
    intro: "Connect your personal GitHub account, select a repository, and understand how Mavly handles initial commit pushes to empty repos.",
    prerequisites: ["A personal GitHub account with authorized permissions", "An active Mavly project"],
    steps: [
      {
        stepNumber: 1,
        instruction: "Authorize the Mavly GitHub App",
        detail: "Click Workspace Settings > GitHub Integration > Connect Account. Authorize read/write repo permissions.",
      },
      {
        stepNumber: 2,
        instruction: "Connect an empty or existing repository",
        detail: "Select an existing repository from your account or enter a brand new repository name.",
      },
      {
        stepNumber: 3,
        instruction: "Trigger the first push",
        detail: "If the repo has zero commits, Mavly initializes the main branch and pushes the complete source tree directly via the Git Data API.",
      },
    ],
    outcome: "Your project source code is securely synced to GitHub with full Git version history.",
    warnings: "Ensure your GitHub token has permissions for the selected organization or personal user account.",
  },
  {
    id: "tut-4",
    category: "Publishing",
    title: "Understanding publishing prerequisites & domains",
    difficulty: "Intermediate",
    intro: "Learn how project subdomains work and what server prerequisites are needed for live deployment.",
    prerequisites: ["An active project with a completed build"],
    steps: [
      {
        stepNumber: 1,
        instruction: "Inspect your project domain assignment",
        detail: "Each project is assigned a deterministic <project-id>.mavly.xyz hostname derived from its unique UUID.",
      },
      {
        stepNumber: 2,
        instruction: "Verify publishing availability",
        detail: "Publishing uploads the preview.html package to edge hosting. If the operator has configured Vercel publishing, the site goes live immediately.",
      },
      {
        stepNumber: 3,
        instruction: "Test live DNS resolution",
        detail: "Open the published link in a new tab to verify SSL certificate issuance and edge caching.",
      },
    ],
    outcome: "A globally accessible live website served over HTTPS.",
    warnings: "Publishing is disabled by default unless MAVLY_VERCEL_DEPLOYMENTS_ENABLED is activated by the operator.",
  },
  {
    id: "tut-5",
    category: "Troubleshooting",
    title: "Interpreting generation errors and recovering access",
    difficulty: "Beginner",
    intro: "How to identify model timeouts, syntax errors, and restore previous snapshots.",
    prerequisites: ["Basic familiarity with the chat and code panels"],
    steps: [
      {
        stepNumber: 1,
        instruction: "Read the chat error feedback",
        detail: "If a prompt generation fails, the system outputs an informative error message explaining whether it was a token limit, timeout, or rate limit.",
      },
      {
        stepNumber: 2,
        instruction: "Re-run with a refined prompt",
        detail: "Break complex multi-page requests into smaller steps. First ask for the layout, then ask for specific content.",
      },
      {
        stepNumber: 3,
        instruction: "Use point-in-time recovery",
        detail: "If an unexpected file modification occurs, click 'Restore Code' on any prior completed step to rollback safely.",
      },
    ],
    outcome: "Quick diagnosis and zero-loss recovery from prompt errors.",
  },
];

export default function TutorialsPage() {
  const [activeCategory, setActiveCategory] = useState<string>("All");
  const [expandedId, setExpandedId] = useState<string>("tut-1");

  const categories = [
    "All",
    "Getting Started",
    "Design & Refinement",
    "Integrations",
    "Publishing",
    "Troubleshooting",
  ];

  const filtered = TUTORIALS.filter(
    (t) => activeCategory === "All" || t.category === activeCategory
  );

  return (
    <MarketingPageShell>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-16">
        {/* Hero */}
        <div className="max-w-3xl mx-auto text-center space-y-4 pt-6 sm:pt-12">
          <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground bg-[var(--clay-sunken)] px-3 py-1 rounded-full border border-[var(--clay-line)]">
            <GraduationCap className="w-3.5 h-3.5 text-foreground" />
            <span>LEARN BY BUILDING</span>
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-foreground leading-[1.1]">
            Build your first website, one step at a time.
          </h1>

          <p className="text-base sm:text-lg text-muted-foreground leading-relaxed font-normal max-w-2xl mx-auto">
            Follow practical guides for turning a website idea into a project you can review and refine in Mavly.
          </p>
        </div>

        {/* Category Filters (Clean Segmented Buttons) */}
        <div className="flex flex-wrap items-center justify-center gap-2">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setActiveCategory(cat)}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-xl transition-all cursor-pointer ${
                activeCategory === cat
                  ? "bg-black text-white shadow-[var(--clay-elev-1)]"
                  : "bg-card text-muted-foreground hover:text-black border border-[var(--clay-line)]"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Tutorial Guides List */}
        <div className="max-w-4xl mx-auto space-y-6">
          {filtered.map((tut) => {
            const isExpanded = expandedId === tut.id;
            return (
              <div
                key={tut.id}
                className="rounded-2xl bg-card border border-[var(--clay-line)] shadow-[var(--clay-elev-2)] overflow-hidden transition-all"
              >
                {/* Accordion Header */}
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? "" : tut.id)}
                  className="w-full p-6 text-left flex items-start justify-between gap-4 cursor-pointer hover:bg-[var(--clay-sunken)] transition-colors"
                >
                  <div className="space-y-1.5 flex-1">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium">
                      <span>{tut.category}</span>
                      <span aria-hidden="true">·</span>
                      <span>{tut.difficulty}</span>
                    </div>
                    <h3 className="text-lg font-bold text-foreground">{tut.title}</h3>
                    <p className="text-xs text-muted-foreground leading-relaxed">{tut.intro}</p>
                  </div>

                  <div className="p-2 rounded-xl bg-[var(--clay-sunken)] border border-[var(--clay-line)] text-muted-foreground shrink-0 shadow-[var(--clay-well-1)]">
                    <ChevronDown
                      className={`w-4 h-4 transition-transform ${
                        isExpanded ? "rotate-180" : ""
                      }`}
                    />
                  </div>
                </button>

                {/* Expanded Details */}
                {isExpanded && (
                  <div className="px-6 pb-6 pt-2 border-t border-[var(--clay-line)] space-y-6 text-xs text-foreground">
                    {/* Prerequisites */}
                    <div className="p-4 rounded-xl bg-[var(--clay-base)] border border-[var(--clay-line)] space-y-2">
                      <span className="font-bold text-foreground block text-[11px] uppercase tracking-wider">
                        Prerequisites
                      </span>
                      <ul className="space-y-1 list-disc list-inside text-muted-foreground">
                        {tut.prerequisites.map((req, i) => (
                          <li key={i}>{req}</li>
                        ))}
                      </ul>
                    </div>

                    {/* Ordered Steps */}
                    <div className="space-y-3">
                      <span className="font-bold text-foreground block text-[11px] uppercase tracking-wider">
                        Step-by-Step Instructions
                      </span>
                      <div className="space-y-3">
                        {tut.steps.map((s) => (
                          <div
                            key={s.stepNumber}
                            className="p-3.5 rounded-xl bg-card border border-[var(--clay-line)] space-y-1 shadow-[var(--clay-elev-1)]"
                          >
                            <p className="font-bold text-foreground">
                              Step {s.stepNumber}: {s.instruction}
                            </p>
                            <p className="text-muted-foreground leading-relaxed">{s.detail}</p>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Expected Outcome */}
                    <div className="flex items-start gap-2.5 p-3.5 rounded-xl bg-success-subtle border border-success/25 text-success-subtle-foreground">
                      <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" />
                      <div>
                        <span className="font-bold block">Expected Outcome:</span>
                        <p className="text-success-subtle-foreground text-xs mt-0.5">{tut.outcome}</p>
                      </div>
                    </div>

                    {/* Warning if any */}
                    {tut.warnings && (
                      <div className="flex items-start gap-2.5 p-3.5 rounded-xl bg-warning-subtle border border-warning/25 text-warning-subtle-foreground">
                        <AlertCircle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                        <div>
                          <span className="font-bold block">Important Notice:</span>
                          <p className="text-warning-subtle-foreground text-xs mt-0.5">{tut.warnings}</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* CTA to Builder */}
        <div className="p-8 rounded-3xl bg-card border border-[var(--clay-line)] text-center max-w-2xl mx-auto space-y-4 shadow-[var(--clay-elev-1)]">
          <h3 className="text-lg font-bold text-foreground">Ready to put these tutorials into practice?</h3>
          <p className="text-xs text-muted-foreground">
            Open the workspace to begin building your website with the AI assistant.
          </p>
          <Link
            href="/dashboard"
            className="mavly-btn-primary px-5 py-2.5 text-xs font-semibold inline-flex items-center gap-2"
          >
            <span>Open Builder</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
    </MarketingPageShell>
  );
}
