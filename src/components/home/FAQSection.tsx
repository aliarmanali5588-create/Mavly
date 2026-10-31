"use client";

import React, { useState } from "react";
import { ChevronDown } from "lucide-react";

interface FAQItem {
  q: string;
  a: React.ReactNode;
}

export function FAQSection() {
  // Single reliable open index state (0 open by default, null when all closed, single-open accordion)
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  const toggleItem = (idx: number) => {
    setOpenIndex((prev) => (prev === idx ? null : idx));
  };

  const faqs: FAQItem[] = [
    {
      q: "What is Mavly?",
      a: "Mavly is an AI website builder that turns your ideas into beautiful, functional websites. Describe what you want to create, and Mavly helps generate the website layout, styles, components, and pages for you to refine.",
    },
    {
      q: "Do I need any coding knowledge to use Mavly?",
      a: "No coding knowledge is required to get started. Describe the website you want to create in plain language, then use the available editing tools to refine the result.",
    },
    {
      q: "How does the visual in-browser editor work?",
      a: "Mavly's visual editor lets you work with your generated website directly in the browser. You can click on elements like headlines, text, buttons, and images in the live preview to customize content, tweak styles, and see your changes instantly.",
    },
    {
      q: "Can I connect my own custom domain?",
      a: "Yes. Mavly supports connecting custom domains with automated SSL provisioning. You can connect an existing domain from any registrar with standard DNS records or manage web addresses directly from the project settings.",
    },
    {
      q: "What kind of websites can I build with Mavly?",
      a: "Mavly can help you create websites based on your ideas and requirements, including landing pages, portfolios, business websites, restaurant showcases, blogs, and full-stack web applications with interactive databases and forms.",
    },
    {
      q: "How does Mavly pricing work?",
      a: (
        <span>
          Mavly offers four primary tiers: a Free plan (₹0) to explore and build with starter credits, Starter (₹399/month), Creator (₹599/month), and Pro (₹1,999/month) for demanding projects, along with Agency and Custom solutions. Annual billing includes a 20% discount. View our{" "}
          <a
            href="#pricing"
            onClick={(e) => e.stopPropagation()}
            className="underline font-semibold text-gray-950 hover:text-black transition-colors"
          >
            Pricing section
          </a>{" "}
          for plan details and calculations.
        </span>
      ),
    },
  ];

  return (
    <section id="faqs" className="py-24 sm:py-32 bg-white border-t border-black/[0.06] relative">
      <div className="max-w-4xl mx-auto px-4 sm:px-6">
        {/* Section Header */}
        <div className="text-center max-w-2xl mx-auto mb-16">
          <span className="text-xs font-bold tracking-widest uppercase text-stone-500 mb-3 block">
            Frequently Asked Questions
          </span>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-black tracking-tight text-gray-950 leading-tight">
            Got questions? We&apos;ve got answers.
          </h2>
          <p className="mt-4 text-sm sm:text-base text-gray-600 leading-relaxed font-normal">
            Everything you need to know about building websites with Mavly.
          </p>
        </div>

        {/* Accordion List */}
        <div className="space-y-3.5">
          {faqs.map((faq, idx) => {
            const isOpen = openIndex === idx;
            const btnId = `faq-trigger-${idx}`;
            const panelId = `faq-panel-${idx}`;

            return (
              <div
                key={idx}
                className={`rounded-2xl transition-all duration-300 overflow-hidden ${
                  isOpen
                    ? "bg-card border border-[var(--neu-line-strong)] shadow-[var(--neu-elev-3)]"
                    : "bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-1)] hover:border-[var(--neu-line-strong)] hover:shadow-[var(--neu-elev-2)]"
                }`}
              >
                <h3>
                  <button
                    type="button"
                    id={btnId}
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => toggleItem(idx)}
                    className="w-full py-5 px-6 text-left flex items-center justify-between gap-4 font-bold text-sm sm:text-base text-gray-950 hover:text-neutral-700 active:bg-black/[0.02] transition-colors cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 rounded-2xl"
                  >
                    <span className="pr-2">{faq.q}</span>
                    <div
                      aria-hidden="true"
                      className={`p-1.5 sm:p-2 rounded-xl bg-white border transition-all duration-300 ease-out shrink-0 flex items-center justify-center motion-reduce:transition-none pointer-events-none shadow-xs ${
                        isOpen
                          ? "rotate-180 text-gray-950 border-black/[0.16] shadow-sm"
                          : "rotate-0 text-gray-400 border-black/[0.08]"
                      }`}
                    >
                      <ChevronDown className="w-4 h-4 transition-transform duration-300" />
                    </div>
                  </button>
                </h3>

                {/* Animated Dropdown Answer Panel */}
                <div
                  id={panelId}
                  role="region"
                  aria-labelledby={btnId}
                  data-open={isOpen ? "true" : "false"}
                  data-state={isOpen ? "open" : "closed"}
                  className="mavly-accordion-content"
                >
                  <div className="mavly-accordion-inner">
                    <div className="px-6 pb-6 pt-1 text-xs sm:text-sm text-gray-600 leading-relaxed border-t border-black/[0.04]">
                      {faq.a}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
