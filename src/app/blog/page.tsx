"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  Sparkles,
  ArrowRight,
  Calendar,
  X,
  BookOpen,
  Layers,
  ChevronRight,
  Code2,
} from "lucide-react";
import { MarketingPageShell } from "@/components/common/MarketingPageShell";

interface BlogPost {
  id: string;
  title: string;
  excerpt: string;
  category: "Prompting" | "Engineering" | "Workflow";
  date: string;
  readTime: string;
  content: string[];
}

const BLOG_POSTS: BlogPost[] = [
  {
    id: "post-1",
    title: "How to write actionable website prompts that avoid generic AI layouts",
    excerpt: "Most AI builders generate identical landing pages because prompts lack specific constraints. Here is a framework for defining section hierarchies and visual tone.",
    category: "Prompting",
    date: "Oct 18, 2026",
    readTime: "4 min read",
    content: [
      "When users ask an AI to 'make a landing page for my fitness app', the model falls back to default token distributions: a large headline, three feature cards, and an oversized purple button.",
      "To produce distinctive websites, structure your prompts into three distinct layers: Intent, Architecture, and Visual Discipline.",
      "1. Intent: Define exactly who visits the site and the single action they should take.",
      "2. Architecture: Specify the sequence of sections—Hero with split mockup, Social proof logos, Interactive feature tabs, Detailed comparison grid, and FAQ accordion.",
      "3. Visual Discipline: Explicitly state styling rules, such as clean neutral backgrounds, high-contrast typography, and restrained borders.",
      "By supplying structural constraints upfront, Mavly's AI models generate semantic, clean HTML code that looks handcrafted.",
    ],
  },
  {
    id: "post-2",
    title: "Why sandboxed static previews are safer than arbitrary server execution",
    excerpt: "A deep dive into Mavly's preview architecture: how we isolate untrusted AI-generated code while keeping live responsive feedback instant.",
    category: "Engineering",
    date: "Oct 12, 2026",
    readTime: "5 min read",
    content: [
      "Running generated backend code directly on a server exposes infrastructure to severe security vulnerabilities, including arbitrary script execution and cross-site request forgery.",
      "At Mavly, we treat all generated code strictly as data, not executable server binaries. The website builder compiles layouts into a standalone static preview.html file.",
      "This preview is served through a dedicated sandboxed iframe route with strict Content Security Policy (CSP) headers that prevent access to cookies, parent window context, or sensitive APIs.",
      "The result is a responsive, pixel-perfect preview that renders in milliseconds without ever compromising user data or platform security.",
    ],
  },
  {
    id: "post-3",
    title: "Git-backed AI workflows: Merging conversational builds with version control",
    excerpt: "Why chat prompts shouldn't replace Git. How Mavly's GitHub integration and snapshot system bridge AI generation and traditional software engineering.",
    category: "Workflow",
    date: "Sep 28, 2026",
    readTime: "6 min read",
    content: [
      "AI chat interfaces are great for quick prototyping, but traditional software development relies on durable commit histories, branches, and diff inspections.",
      "We built Mavly with a dual-persistence model. Internally, every AI generation captures a durable snapshot in our PostgreSQL tables, enabling instant point-in-time rollbacks.",
      "Externally, users can connect their GitHub repositories. Using user-to-server OAuth tokens and GitHub's Git Data API, you can push changes directly to your repository with a single click.",
      "This guarantees you own your code and can transition your generated website into custom production repositories at any time.",
    ],
  },
  {
    id: "post-4",
    title: "Tailwind CSS v4 & semantic HTML: The secret to clean generated websites",
    excerpt: "Exploring why utility-first CSS and modern web standards provide the highest fidelity canvas for machine-learning code generation.",
    category: "Engineering",
    date: "Sep 15, 2026",
    readTime: "4 min read",
    content: [
      "Legacy website builders often generated messy inline style tags or deeply nested div soup that was impossible to maintain.",
      "By training prompt schemas to leverage Tailwind CSS utility classes and semantic HTML5 tags (nav, section, article, footer), generated outputs remain readable and easy to inspect.",
      "Furthermore, responsive prefixes like sm: and lg: ensure that mobile viewports are accounted for automatically during initial code generation.",
    ],
  },
];

export default function BlogPage() {
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [readingPost, setReadingPost] = useState<BlogPost | null>(null);

  const categories = ["All", "Prompting", "Engineering", "Workflow"];

  const filteredPosts = BLOG_POSTS.filter(
    (post) => selectedCategory === "All" || post.category === selectedCategory
  );

  return (
    <MarketingPageShell>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-16">
        {/* Hero */}
        <div className="max-w-3xl mx-auto text-center space-y-4 pt-6 sm:pt-12">
          <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-stone-600 bg-stone-100 px-3 py-1 rounded-full border border-[var(--neu-line)]">
            <BookOpen className="w-3.5 h-3.5 text-stone-800" />
            <span>IDEAS AND UPDATES</span>
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-foreground leading-[1.1]">
            Notes on building websites with AI.
          </h1>

          <p className="text-base sm:text-lg text-muted-foreground leading-relaxed font-normal max-w-2xl mx-auto">
            Practical ideas, product learnings, and updates from the Mavly website-building workflow.
          </p>
        </div>

        {/* Category Filters */}
        <div className="flex flex-wrap items-center justify-center gap-2">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setSelectedCategory(cat)}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-xl transition-all cursor-pointer ${
                selectedCategory === cat
                  ? "bg-black text-white shadow-xs"
                  : "bg-card text-muted-foreground hover:text-black border border-[var(--neu-line)]"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Blog Posts Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-5xl mx-auto">
          {filteredPosts.map((post) => (
            <article
              key={post.id}
              className="p-8 rounded-3xl bg-card border border-[var(--neu-line)] shadow-[0_4px_20px_rgba(0,0,0,0.02)] hover:border-black/20 transition-all flex flex-col justify-between space-y-6"
            >
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium">
                  <span>{post.category}</span>
                  <span aria-hidden="true">·</span>
                  <span>{post.date}</span>
                  <span aria-hidden="true">·</span>
                  <span>{post.readTime}</span>
                </div>

                <h2 className="text-xl font-bold text-foreground tracking-tight leading-snug">
                  {post.title}
                </h2>

                <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed font-normal">
                  {post.excerpt}
                </p>
              </div>

              <div className="pt-4 border-t border-[var(--neu-line)] flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setReadingPost(post)}
                  className="text-xs font-bold text-black hover:underline inline-flex items-center gap-1 cursor-pointer"
                >
                  <span>Read Article</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
                <span className="text-[11px] text-muted-foreground">Engineering Blog</span>
              </div>
            </article>
          ))}
        </div>

        {/* Article Reader Modal */}
        {readingPost && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-card rounded-3xl max-w-2xl w-full max-h-[85vh] overflow-y-auto border border-[var(--neu-line)] shadow-2xl p-6 sm:p-8 relative space-y-6">
              <button
                type="button"
                onClick={() => setReadingPost(null)}
                className="absolute top-6 right-6 p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-[var(--neu-sunken)] transition-colors"
                aria-label="Close article"
              >
                <X className="w-5 h-5" />
              </button>

              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium">
                  <span>{readingPost.category}</span>
                  <span aria-hidden="true">·</span>
                  <span>{readingPost.date}</span>
                  <span aria-hidden="true">·</span>
                  <span>{readingPost.readTime}</span>
                </div>
                <h2 className="text-2xl sm:text-3xl font-extrabold text-foreground tracking-tight leading-snug pr-8">
                  {readingPost.title}
                </h2>
              </div>

              <div className="space-y-4 text-xs sm:text-sm text-foreground leading-relaxed border-t border-[var(--neu-line)] pt-6">
                {readingPost.content.map((paragraph, idx) => (
                  <p key={idx}>{paragraph}</p>
                ))}
              </div>

              <div className="pt-4 border-t border-[var(--neu-line)] flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Written by the Mavly Engineering Team</span>
                <button
                  type="button"
                  onClick={() => setReadingPost(null)}
                  className="mavly-btn-secondary px-4 py-2 text-xs font-semibold"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </MarketingPageShell>
  );
}
