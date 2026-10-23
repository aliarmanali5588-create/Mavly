"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  Mail,
  LifeBuoy,
  CreditCard,
  Briefcase,
  Copy,
  Check,
  ExternalLink,
  ArrowRight,
  Clock,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { MarketingPageShell } from "@/components/common/MarketingPageShell";

interface ContactChannel {
  id: string;
  title: string;
  category: string;
  email: string;
  subject: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}

const CHANNELS: ContactChannel[] = [
  {
    id: "general",
    title: "General Enquiries",
    category: "Product & Partnerships",
    email: "hello@mavly.xyz",
    subject: "Mavly General Enquiry",
    description: "For questions about Mavly, business partnerships, press inquiries, or general questions about our website builder.",
    icon: Mail,
  },
  {
    id: "support",
    title: "Technical Support",
    category: "Builder & Hosting",
    email: "support@mavly.xyz",
    subject: "Mavly Technical Support Request",
    description: "For assistance with website prompt generation, live preview rendering, restore points, or custom domain configuration.",
    icon: LifeBuoy,
  },
  {
    id: "billing",
    title: "Billing & Subscriptions",
    category: "Plans & Credits",
    email: "billing@mavly.xyz",
    subject: "Mavly Billing & Subscription Inquiry",
    description: "For questions regarding subscription plans, payment receipts, invoice copies, or credit pack purchases.",
    icon: CreditCard,
  },
  {
    id: "careers",
    title: "Careers & Talent",
    category: "Join Our Team",
    email: "careers@mavly.xyz",
    subject: "Mavly Careers Application / Inquiry",
    description: "For speculative applications, engineering collaborations, or design inquiries. Tell us about what you enjoy building.",
    icon: Briefcase,
  },
];

export default function ContactPage() {
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null);

  const handleCopy = async (email: string) => {
    try {
      await navigator.clipboard.writeText(email);
      setCopiedEmail(email);
      toast.success(`Copied ${email} to clipboard`);
      setTimeout(() => {
        setCopiedEmail((prev) => (prev === email ? null : prev));
      }, 2000);
    } catch {
      toast.error(`Please copy ${email} manually.`);
    }
  };

  return (
    <MarketingPageShell>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-16">
        {/* Hero */}
        <div className="max-w-3xl mx-auto text-center space-y-4 pt-6 sm:pt-12">
          <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-stone-600 bg-stone-100 px-3 py-1 rounded-full border border-black/[0.04]">
            <Mail className="w-3.5 h-3.5 text-stone-800" />
            <span>GET IN TOUCH</span>
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-gray-950 leading-[1.1]">
            Let&apos;s get your question to the right place.
          </h1>

          <p className="text-base sm:text-lg text-gray-600 leading-relaxed font-normal max-w-2xl mx-auto">
            Choose the right contact channel for general enquiries, technical issues, billing questions, or career opportunities.
          </p>
        </div>

        {/* 4 Contact Channels Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-5xl mx-auto">
          {CHANNELS.map((ch) => {
            const Icon = ch.icon;
            const isCopied = copiedEmail === ch.email;
            const mailtoHref = `mailto:${ch.email}?subject=${encodeURIComponent(ch.subject)}`;

            return (
              <div
                key={ch.id}
                className="p-8 rounded-3xl bg-white border border-black/[0.08] shadow-[0_4px_20px_rgba(0,0,0,0.02)] flex flex-col justify-between space-y-6"
              >
                <div>
                  <div className="flex items-center justify-between gap-3 mb-4">
                    <div className="w-12 h-12 rounded-2xl bg-gray-50 border border-black/[0.06] flex items-center justify-center text-gray-900">
                      <Icon className="w-5 h-5" />
                    </div>
                    <span className="text-[11px] font-semibold text-gray-500 bg-gray-100 px-2.5 py-0.5 rounded-full">
                      {ch.category}
                    </span>
                  </div>

                  <h2 className="text-xl font-bold text-gray-950 mb-2">{ch.title}</h2>
                  <p className="text-xs sm:text-sm text-gray-600 leading-relaxed">
                    {ch.description}
                  </p>
                </div>

                <div className="pt-4 border-t border-black/[0.06] space-y-3">
                  <div className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-[#faf9f6] border border-black/[0.04]">
                    <div className="min-w-0 flex-1 pl-1">
                      <span className="block text-[10px] uppercase font-bold text-gray-400 tracking-wider">
                        Email Address
                      </span>
                      <a
                        href={mailtoHref}
                        className="font-mono text-xs font-semibold text-gray-900 hover:underline truncate block"
                      >
                        {ch.email}
                      </a>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleCopy(ch.email)}
                      className="px-2.5 py-1.5 rounded-lg bg-white border border-black/[0.08] text-xs font-medium text-gray-700 hover:text-black shadow-xs flex items-center gap-1.5 cursor-pointer"
                    >
                      {isCopied ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                          <span className="text-[11px] text-emerald-700 font-semibold">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5 text-gray-400" />
                          <span className="text-[11px]">Copy</span>
                        </>
                      )}
                    </button>
                  </div>

                  <a
                    href={mailtoHref}
                    className="mavly-btn-primary w-full py-2.5 px-4 text-xs font-semibold inline-flex items-center justify-center gap-1.5"
                  >
                    <span>Send Message</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            );
          })}
        </div>

        {/* Operating Hours & Response Notice */}
        <div className="max-w-2xl mx-auto p-6 rounded-2xl bg-white border border-black/[0.08] text-center space-y-2 text-xs">
          <div className="flex items-center justify-center gap-2 text-gray-950 font-bold">
            <Clock className="w-4 h-4 text-gray-700" />
            <span>Response Commitments</span>
          </div>
          <p className="text-gray-600 leading-relaxed">
            All messages are delivered straight to our core engineering and support inboxes. We typically respond within 1–2 business days.
          </p>
        </div>
      </div>
    </MarketingPageShell>
  );
}
