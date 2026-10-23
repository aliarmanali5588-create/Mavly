import React from "react";
import { ScrollProgressIndicator } from "@/components/common/ScrollProgressIndicator";
import { HomeNavigation } from "@/components/home/HomeNavigation";
import { HeroSection } from "@/components/home/HeroSection";
import { FeaturesSection } from "@/components/home/FeaturesSection";
import { PricingSection } from "@/components/home/PricingSection";
import { FAQSection } from "@/components/home/FAQSection";
import { HomeFooter } from "@/components/home/HomeFooter";

/**
 * The public marketing page.
 *
 * The route file (`src/app/page.tsx`) owns the metadata — Next.js only
 * reads `metadata` from a route or layout file, never from a component.
 */
export default function MarketingHome() {
  return (
    <div className="min-h-screen bg-white text-gray-950 mavly-page-enter">
      {/* Top Edge Neon Scroll Progress Indicator */}
      <ScrollProgressIndicator />

      {/* Navigation */}
      <HomeNavigation />

      <main>
        {/* Hero Section with Headline, Subheading, Google/GitHub Auth, and Showcase Cards */}
        <HeroSection />

        {/* Features / Capabilities */}
        <FeaturesSection />

        {/* Pricing */}
        <PricingSection />

        {/* FAQs */}
        <FAQSection />
      </main>

      {/* Footer */}
      <HomeFooter />
    </div>
  );
}
