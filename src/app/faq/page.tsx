"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  HelpCircle,
  Sparkles,
  ChevronDown,
  ArrowRight,
  Search,
  BookOpen,
} from "lucide-react";
import { MarketingPageShell } from "@/components/common/MarketingPageShell";

interface FaqItem {
  id: string;
  category: "Getting Started" | "Workspace & Code" | "Integrations" | "Publishing" | "Plans & Credits";
  question: string;
  answer: string;
  relatedLink?: { label: string; href: string };
}

const FAQS: FaqItem[] = [
  // Getting started
  {
    id: "faq-1",
    category: "Getting Started",
    question: "What is Mavly?",
    answer: "Mavly is an AI-powered website builder that transforms natural language prompts into clean, responsive websites with HTML, modern Tailwind CSS, and structured layouts.",
    relatedLink: { label: "Explore features", href: "/features" },
  },
  {
    id: "faq-2",
    category: "Getting Started",
    question: "How do I create my first website?",
    answer: "Sign in with your Google or GitHub account, open your Dashboard, click 'New Project', and describe your website vision in the prompt bar. The AI agent generates the file structure and displays a live preview in seconds.",
    relatedLink: { label: "Read tutorial", href: "/tutorials" },
  },
  {
    id: "faq-3",
    category: "Getting Started",
    question: "Do I need coding experience?",
    answer: "No. You can create, style, and refine entire websites using plain English conversational prompts. However, if you are a developer, you also have full access to view, edit, and export the raw HTML, CSS, and file tree.",
  },
  {
    id: "faq-4",
    category: "Getting Started",
    question: "Can I refine a generated website?",
    answer: "Yes. Use follow-up prompts in the workspace chat to request specific changes (e.g., 'Change header background to black', 'Add a 3-column pricing card section'). Every modification creates an automatic restore snapshot.",
  },

  // Workspace and code
  {
    id: "faq-5",
    category: "Workspace & Code",
    question: "How do I access my project files?",
    answer: "In your project workspace, click on the 'Code' or file tree tab. You can inspect all files (such as preview.html, stylesheets, and assets) and download the entire codebase as a ZIP archive anytime.",
  },
  {
    id: "faq-6",
    category: "Workspace & Code",
    question: "What does the preview represent?",
    answer: "The preview is a sandboxed, responsive rendering of your compiled static HTML and CSS files. It runs inside an isolated iframe with desktop and mobile viewport toggles.",
  },
  {
    id: "faq-7",
    category: "Workspace & Code",
    question: "Does saving a file automatically rebuild or run my application?",
    answer: "No. Generated code is never executed as a dynamic server runtime on Mavly servers. The preview renders the static HTML and client styling. Backend endpoints exist only as source files in your project repository.",
  },

  // Integrations
  {
    id: "faq-8",
    category: "Integrations",
    question: "How do I connect GitHub?",
    answer: "Open Workspace Settings and click 'Connect GitHub'. You will be redirected to authorize the Mavly GitHub App with user-to-server OAuth tokens, which are encrypted with AES-256-GCM on our backend.",
    relatedLink: { label: "Integration details", href: "/integrations" },
  },
  {
    id: "faq-9",
    category: "Integrations",
    question: "Can Mavly create a new GitHub repository?",
    answer: "Yes. When the GitHub App authorization and your account permissions allow repository creation, you can initialize a new repository directly from the project settings modal.",
  },
  {
    id: "faq-10",
    category: "Integrations",
    question: "Why might repository creation fail?",
    answer: "Repository creation can fail if the chosen name is already taken in your account, if your GitHub App authorization lacks repository creation scope, or if organization-level OAuth restrictions block third-party app installations.",
  },
  {
    id: "faq-11",
    category: "Integrations",
    question: "How does the first push to an empty repository work?",
    answer: "When connecting a repository with zero commits, Mavly marks it as 'first_push_pending'. Upon your first push, Mavly uses GitHub's Git Data API to create the initial branch and commit without placeholder commits.",
  },
  {
    id: "faq-12",
    category: "Integrations",
    question: "What does connecting Supabase currently enable?",
    answer: "Connecting Supabase authorizes account-level read-only organization and project discovery to link external projects. It does not browse live tables, run custom SQL, or execute schema migrations.",
  },

  // Publishing
  {
    id: "faq-13",
    category: "Publishing",
    question: "How does publishing work?",
    answer: "Publishing uploads the compiled static preview.html bytes directly to edge hosting and assigns your project a dedicated subdomain in the format <project-id>.mavly.xyz.",
  },
  {
    id: "faq-14",
    category: "Publishing",
    question: "Why might publishing be unavailable?",
    answer: "Vercel publishing is an optional hosting path enabled only when the operator activates MAVLY_VERCEL_DEPLOYMENTS_ENABLED and supplies a valid VERCEL_API_TOKEN. Otherwise, the endpoint returns a truthful 503 error.",
  },
  {
    id: "faq-15",
    category: "Publishing",
    question: "When is a custom domain considered ready?",
    answer: "A domain is considered ready when DNS records (CNAME or A record) resolve correctly to the hosting edge and the SSL certificate has been verified.",
  },

  // Plans and credits
  {
    id: "faq-16",
    category: "Plans & Credits",
    question: "Where can I see plans and prices?",
    answer: "Visit our dedicated Pricing page to compare Free, Starter (₹399/mo), Creator (₹599/mo), Pro (₹1,999/mo), and Agency tiers.",
    relatedLink: { label: "View Pricing Plans", href: "/pricing" },
  },
  {
    id: "faq-17",
    category: "Plans & Credits",
    question: "How do credit top-ups work?",
    answer: "If you run low on credits mid-cycle, you can purchase instant credit booster packs from the Credit Top-up portal without changing your subscription tier.",
    relatedLink: { label: "Credit Top-up", href: "/credit-topup" },
  },
  {
    id: "faq-18",
    category: "Plans & Credits",
    question: "What happens if generation fails?",
    answer: "If a generation attempt fails due to an upstream model timeout or network disruption, the system cancels the run and credits are not permanently lost for incomplete jobs.",
  },
];

export default function FaqPage() {
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string>("faq-1");

  const categories = [
    "All",
    "Getting Started",
    "Workspace & Code",
    "Integrations",
    "Publishing",
    "Plans & Credits",
  ];

  const filtered = FAQS.filter((f) => {
    const matchesCategory =
      selectedCategory === "All" || f.category === selectedCategory;
    const matchesSearch =
      f.question.toLowerCase().includes(searchQuery.toLowerCase()) ||
      f.answer.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  return (
    <MarketingPageShell>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-16">
        {/* Hero */}
        <div className="max-w-3xl mx-auto text-center space-y-4 pt-6 sm:pt-12">
          <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-stone-600 bg-stone-100 px-3 py-1 rounded-full border border-black/[0.04]">
            <HelpCircle className="w-3.5 h-3.5 text-stone-800" />
            <span>FREQUENTLY ASKED QUESTIONS</span>
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-gray-950 leading-[1.1]">
            Questions about building with Mavly?
          </h1>

          <p className="text-base sm:text-lg text-gray-600 leading-relaxed font-normal max-w-2xl mx-auto">
            Find straightforward answers about getting started, project editing, integrations, publishing, plans, and credits.
          </p>
        </div>

        {/* Search & Category Filter Bar */}
        <div className="max-w-3xl mx-auto space-y-4">
          <div className="relative">
            <Search className="w-4 h-4 text-gray-400 absolute left-4 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search questions or keywords (e.g. GitHub, credits, preview)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-11 pr-4 py-3 text-xs sm:text-sm bg-white border border-black/[0.08] rounded-2xl focus:outline-none focus:ring-2 focus:ring-black/10 text-gray-900 shadow-xs"
            />
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                className={`px-3.5 py-1.5 text-xs font-semibold rounded-xl transition-all cursor-pointer ${
                  selectedCategory === cat
                    ? "bg-black text-white shadow-xs"
                    : "bg-white text-gray-600 hover:text-black border border-black/[0.08]"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* FAQs Accordion Grid */}
        <div className="max-w-3xl mx-auto space-y-4">
          {filtered.length === 0 ? (
            <div className="p-8 text-center bg-white rounded-2xl border border-black/[0.08] text-gray-400 text-xs">
              No questions found matching your search.
            </div>
          ) : (
            filtered.map((item) => {
              const isExpanded = expandedId === item.id;
              return (
                <div
                  key={item.id}
                  className="rounded-2xl bg-white border border-black/[0.08] shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden transition-all"
                >
                  <button
                    type="button"
                    onClick={() => setExpandedId(isExpanded ? "" : item.id)}
                    className="w-full p-5 text-left flex items-start justify-between gap-4 cursor-pointer hover:bg-gray-50/50 transition-colors"
                  >
                    <div className="space-y-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 block">
                        {item.category}
                      </span>
                      <h3 className="text-sm sm:text-base font-bold text-gray-950">
                        {item.question}
                      </h3>
                    </div>
                    <div className="p-1.5 rounded-lg bg-gray-50 border border-black/[0.04] text-gray-500 shrink-0 mt-1">
                      <ChevronDown
                        className={`w-4 h-4 transition-transform ${
                          isExpanded ? "rotate-180" : ""
                        }`}
                      />
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="px-5 pb-5 pt-2 border-t border-black/[0.06] text-xs sm:text-sm text-gray-600 leading-relaxed space-y-3">
                      <p>{item.answer}</p>
                      {item.relatedLink && (
                        <div className="pt-1">
                          <Link
                            href={item.relatedLink.href}
                            className="font-bold text-black hover:underline inline-flex items-center gap-1 text-xs"
                          >
                            <span>{item.relatedLink.label}</span>
                            <ArrowRight className="w-3.5 h-3.5" />
                          </Link>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Bottom Callout */}
        <div className="p-8 rounded-3xl bg-white border border-black/[0.08] text-center max-w-2xl mx-auto space-y-3 text-xs">
          <h3 className="text-sm font-bold text-gray-950">Have a question that isn&apos;t answered here?</h3>
          <p className="text-gray-600">
            Reach out to our support specialists directly at <code>support@mavly.xyz</code>.
          </p>
          <div className="pt-2">
            <Link
              href="/support"
              className="mavly-btn-secondary px-4 py-2 text-xs font-semibold inline-flex items-center gap-1.5"
            >
              <span>Contact Support</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </div>
    </MarketingPageShell>
  );
}
