import type { Metadata } from "next";
import { canonicalFor } from "@/lib/seo/site";
import { JsonLd } from "@/components/seo/JsonLd";
import { breadcrumbSchema } from "@/lib/seo/structured-data";
import { MarketingPageShell } from "@/components/common/MarketingPageShell";
import { PricingSection } from "@/components/home/PricingSection";

export const metadata: Metadata = {
  alternates: {
    canonical: canonicalFor("/pricing"),
  },
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
    <>
      {/* Breadcrumb trail for this nested public page. */}
      <JsonLd data={breadcrumbSchema([{ name: "Home", path: "/" }, { name: "Pricing", path: "/pricing" }])} />
      <MarketingPageShell>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <PricingSection />
        </div>
      </MarketingPageShell>
    </>
  );
}
