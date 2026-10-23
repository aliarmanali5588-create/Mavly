import type { Metadata } from "next";
import { MarketingPageShell } from "@/components/common/MarketingPageShell";
import { PricingSection } from "@/components/home/PricingSection";

export const metadata: Metadata = {
  title: "Pricing Plans — Mavly AI Website Builder",
  description:
    "Explore transparent plans for individual creators, studios, and agencies. Base tier in INR with full source code export and custom domains.",
  openGraph: {
    title: "Pricing Plans — Mavly AI Website Builder",
    description:
      "Explore transparent plans for individual creators, studios, and agencies. Base tier in INR with full source code export and custom domains.",
    images: ["/logo/Mavly.png"],
  },
};

export default function PricingPage() {
  return (
    <MarketingPageShell>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <PricingSection />
      </div>
    </MarketingPageShell>
  );
}
