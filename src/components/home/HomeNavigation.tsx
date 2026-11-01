"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { ArrowRight } from "lucide-react";

export function HomeNavigation() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 15);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const navLinks = [
    { label: "Features", href: "/features" },
    { label: "Pricing", href: "/pricing" },
    { label: "Docs", href: "/docs" },
    { label: "FAQs", href: "/faq" },
  ];

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-[color-mix(in_srgb,var(--clay-base)_88%,transparent)] backdrop-blur-xl border-b border-[var(--clay-line)] shadow-[var(--clay-elev-2)]"
          : "bg-transparent border-b border-transparent"
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-8 h-16 sm:h-20 flex items-center justify-between">
        {/* Brand Logo */}
        <Link href="/" className="flex items-center gap-2.5 group select-none">
          <div className="w-8 h-8 rounded-xl overflow-hidden bg-card shadow-[var(--clay-elev-1)] p-0.5 border border-[var(--clay-line)] flex items-center justify-center transition-[box-shadow] duration-200 active:shadow-[var(--clay-well-1)]">
            <Image
              src="/logo/Mavly.png"
              alt="Mavly Logo"
              width={28}
              height={28}
              className="w-full h-full object-contain rounded-lg"
              priority
              referrerPolicy="no-referrer"
            />
          </div>
          <span className="font-bold tracking-tight text-foreground text-base sm:text-lg leading-none">
            Mavly
          </span>
        </Link>

        {/* Center Navigation Links (Desktop) */}
        <nav className="hidden md:flex items-center gap-8">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors duration-200 py-1 relative after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-foreground after:scale-x-0 hover:after:scale-x-100 after:transition-[transform] after:duration-200"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Right CTA Button (Mobile & Desktop) */}
        <div className="flex items-center">
          <Link
            href="/dashboard"
            className="mavly-btn-primary px-3.5 py-2 sm:px-5 sm:py-2.5 text-xs font-semibold"
          >
            <span>Start Building</span>
            <ArrowRight className="w-3.5 h-3.5 shrink-0" />
          </Link>
        </div>
      </div>
    </header>
  );
}
