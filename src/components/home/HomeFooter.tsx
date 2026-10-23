"use client";

import React from "react";
import Link from "next/link";
import Image from "next/image";
import { ArrowUp, ArrowRight } from "lucide-react";

export function HomeFooter() {
  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <footer className="pt-20 pb-12 border-t border-black/[0.08] bg-[#faf9f6] text-gray-900">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 pb-16 border-b border-black/[0.06]">
          {/* Brand Column */}
          <div className="lg:col-span-4 max-w-sm space-y-4">
            <Link href="/" className="inline-flex items-center gap-2.5 group select-none">
              <div className="w-8 h-8 rounded-xl overflow-hidden bg-white shadow-xs p-0.5 border border-black/[0.08] flex items-center justify-center transition-transform group-hover:scale-105 active:scale-95">
                <Image
                  src="/logo/Mavly.png"
                  alt="Mavly Logo"
                  width={28}
                  height={28}
                  className="w-full h-full object-contain rounded-lg"
                  referrerPolicy="no-referrer"
                />
              </div>
              <span className="font-extrabold tracking-tight text-gray-950 text-lg leading-none">
                Mavly
              </span>
            </Link>

            <p className="text-xs text-gray-600 leading-relaxed font-normal">
              Mavly is an AI website builder that turns your ideas into beautiful, functional websites. We don&apos;t make websites. We make memories.
            </p>

            <div className="pt-2">
              <Link
                href="/dashboard"
                className="mavly-btn-primary px-4 py-2 text-xs font-semibold inline-flex items-center gap-1.5"
                aria-label="Launch Mavly Builder"
              >
                <span>Launch Builder</span>
                <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
              </Link>
            </div>
          </div>

          {/* 4 Multi-column Grid Navigation Links */}
          <div className="lg:col-span-8 grid grid-cols-2 sm:grid-cols-4 gap-8 text-xs">
            {/* Product Column */}
            <div className="flex flex-col gap-3">
              <span className="font-bold text-gray-950 tracking-wider uppercase text-[10px]">
                Product
              </span>
              <nav className="flex flex-col gap-2.5">
                <Link
                  href="/features"
                  className="text-gray-600 hover:text-black transition-colors"
                >
                  Features
                </Link>
                <Link
                  href="/pricing"
                  className="text-gray-600 hover:text-black transition-colors"
                >
                  Pricing
                </Link>
                <Link
                  href="/integrations"
                  className="text-gray-600 hover:text-black transition-colors"
                >
                  Integrations
                </Link>
                <Link
                  href="/changelog"
                  className="text-gray-600 hover:text-black transition-colors"
                >
                  Changelog
                </Link>
              </nav>
            </div>

            {/* Resources Column */}
            <div className="flex flex-col gap-3">
              <span className="font-bold text-gray-950 tracking-wider uppercase text-[10px]">
                Resources
              </span>
              <nav className="flex flex-col gap-2.5">
                <Link
                  href="/docs"
                  className="text-gray-600 hover:text-black transition-colors"
                >
                  Documentation
                </Link>
                <Link
                  href="/tutorials"
                  className="text-gray-600 hover:text-black transition-colors"
                >
                  Tutorials
                </Link>
                <Link
                  href="/blog"
                  className="text-gray-600 hover:text-black transition-colors"
                >
                  Blog
                </Link>
                <Link
                  href="/faq"
                  className="text-gray-600 hover:text-black transition-colors"
                >
                  FAQs
                </Link>
              </nav>
            </div>

            {/* Company Column */}
            <div className="flex flex-col gap-3">
              <span className="font-bold text-gray-950 tracking-wider uppercase text-[10px]">
                Company
              </span>
              <nav className="flex flex-col gap-2.5">
                <Link
                  href="/about"
                  className="text-gray-600 hover:text-black transition-colors"
                >
                  About Mavly
                </Link>
                <Link
                  href="/contact"
                  className="text-gray-600 hover:text-black transition-colors"
                >
                  Contact
                </Link>
                <Link
                  href="/careers"
                  className="text-gray-600 hover:text-black transition-colors"
                >
                  Careers
                </Link>
              </nav>
            </div>

            {/* Support & Legal Column */}
            <div className="flex flex-col gap-3">
              <span className="font-bold text-gray-950 tracking-wider uppercase text-[10px]">
                Support &amp; Legal
              </span>
              <nav className="flex flex-col gap-2.5">
                <Link
                  href="/support"
                  className="text-gray-600 hover:text-black transition-colors font-medium"
                >
                  Help &amp; Support
                </Link>
                <Link
                  href="/terms"
                  className="text-gray-600 hover:text-black transition-colors"
                >
                  Terms of Service
                </Link>
                <Link
                  href="/privacy"
                  className="text-gray-600 hover:text-black transition-colors"
                >
                  Privacy Policy
                </Link>
              </nav>
            </div>
          </div>
        </div>

        {/* Bottom Bar: Copyright & Back to Top */}
        <div className="pt-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-gray-500">
          <div>
            © {new Date().getFullYear()} Mavly. All rights reserved.
          </div>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={scrollToTop}
              className="mavly-btn-secondary px-3.5 py-2 text-xs font-medium inline-flex items-center gap-1.5"
              aria-label="Back to top"
            >
              <span>Back to top</span>
              <ArrowUp className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
}
