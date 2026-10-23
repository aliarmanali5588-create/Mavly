"use client";

import React from "react";
import { Layout, Sliders, Database, Globe, ArrowRight, Check } from "lucide-react";
import Link from "next/link";

export function FeaturesSection() {
  const features = [
    {
      icon: Layout,
      title: "Prompt to Production",
      subtitle: "Effortless Creation",
      description:
        "Describe your dream website or upload your design ideas. Mavly drafts complete, responsive layouts with bespoke typography, curated color palettes, and polished components.",
      bullets: [
        "Responsive across mobile, tablet, and desktop",
        "Semantic typography and accessible component tokens",
        "Clean, maintainable Next.js and Tailwind code",
      ],
    },
    {
      icon: Sliders,
      title: "Visual In-Browser Editor",
      subtitle: "Instant Customization",
      description:
        "Make changes visually in real time. Click on any headline, card, button, or paragraph in the live preview to edit text, swap assets, and adjust styling without touching code.",
      bullets: [
        "Click-to-edit interface elements in real time",
        "Immediate preview synchronization",
        "Preserves your underlying layout structure",
      ],
    },
    {
      icon: Database,
      title: "Full-Stack Data Ready",
      subtitle: "Beyond Static Pages",
      description:
        "Easily handle dynamic data, user registrations, contact forms, and relational records. Mavly provisions database tables and API endpoints seamlessly behind your UI.",
      bullets: [
        "Visual table explorer and database records",
        "Zero-config serverless API routes",
        "Persistent data storage with automatic safety",
      ],
    },
    {
      icon: Globe,
      title: "One-Click Publishing & Domains",
      subtitle: "Live in Seconds",
      description:
        "Launch your website to the world instantly. Attach your own custom domain or use an instant preview URL with automatic SSL certificates and global distribution.",
      bullets: [
        "Instant production deployment",
        "Custom domain attachment with auto-renewing SSL",
        "High performance, scale-to-zero infrastructure",
      ],
    },
  ];

  return (
    <section id="features" className="py-24 sm:py-32 bg-white border-t border-black/[0.06]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        {/* Section Header */}
        <div className="text-center max-w-2xl mx-auto mb-16 sm:mb-20">
          <span className="text-xs font-bold tracking-widest uppercase text-stone-500 mb-3 block">
            Capabilities
          </span>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-black tracking-tight text-gray-950 leading-tight">
            Everything you need to build stunning websites.
          </h2>
          <p className="mt-4 text-sm sm:text-base text-gray-600 leading-relaxed font-normal">
            Whether you&apos;re launching a business, portfolio, storefront, or web application, Mavly gives you total creative control without writing code.
          </p>
        </div>

        {/* Feature Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {features.map((feat, idx) => {
            const Icon = feat.icon;
            return (
              <div
                key={idx}
                className="p-8 sm:p-10 rounded-3xl bg-[#faf9f6] border border-black/[0.06] shadow-[0_4px_20px_-2px_rgba(0,0,0,0.03)] hover:shadow-[0_10px_30px_-4px_rgba(0,0,0,0.07)] hover:border-black/[0.12] hover:-translate-y-1 active:translate-y-0 transition-all duration-300 flex flex-col justify-between"
              >
                <div>
                  <div className="w-12 h-12 rounded-2xl bg-white border border-black/[0.08] shadow-[0_2px_8px_rgba(0,0,0,0.04)] flex items-center justify-center text-black mb-6 transition-transform duration-200 group-hover:scale-105">
                    <Icon className="w-6 h-6" />
                  </div>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-stone-500">
                    {feat.subtitle}
                  </span>
                  <h3 className="text-2xl font-bold text-gray-950 tracking-tight mt-1 mb-3">
                    {feat.title}
                  </h3>
                  <p className="text-sm text-gray-600 leading-relaxed mb-6 font-normal">
                    {feat.description}
                  </p>
                  <ul className="space-y-2.5 pt-4 border-t border-black/[0.06]">
                    {feat.bullets.map((b, bIdx) => (
                      <li key={bIdx} className="flex items-start gap-2.5 text-xs text-gray-700">
                        <Check className="w-4 h-4 text-black shrink-0 mt-0.5" />
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            );
          })}
        </div>

        {/* Bottom Callout Banner */}
        <div className="mt-16 p-8 sm:p-12 rounded-3xl bg-black text-white text-center flex flex-col items-center justify-center shadow-[0_16px_40px_rgba(0,0,0,0.18)]">
          <h3 className="text-2xl sm:text-3xl font-bold tracking-tight">
            Ready to bring your ideas to life?
          </h3>
          <p className="mt-2 text-sm text-neutral-400 max-w-lg mx-auto">
            Build your first website in minutes. Type a prompt, watch it come together, and publish with one click.
          </p>
          <Link
            href="/dashboard"
            className="mavly-btn-secondary mt-6 px-6 py-3 text-xs font-semibold"
          >
            <span>Start Building with Mavly</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}
