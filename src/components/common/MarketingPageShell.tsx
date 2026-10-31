"use client";

import React from "react";
import { ScrollProgressIndicator } from "@/components/common/ScrollProgressIndicator";
import { HomeNavigation } from "@/components/home/HomeNavigation";
import { HomeFooter } from "@/components/home/HomeFooter";

interface MarketingPageShellProps {
  children: React.ReactNode;
}

export function MarketingPageShell({ children }: MarketingPageShellProps) {
  return (
    <div className="min-h-screen bg-[var(--clay-base)] text-foreground font-sans mavly-page-enter flex flex-col justify-between">
      {/* Top Edge Neon Scroll Progress Indicator */}
      <ScrollProgressIndicator />

      {/* Navigation Header */}
      <HomeNavigation />

      {/* Main Page Content */}
      <main className="flex-1 pt-24 sm:pt-28 pb-16 w-full">
        {children}
      </main>

      {/* Global SaaS Footer */}
      <HomeFooter />
    </div>
  );
}
