import type { Metadata } from "next";
import { canonicalFor } from "@/lib/seo/site";

/**
 * ═══ METADATA FOR A CLIENT-COMPONENT PAGE ═══════════════════════════════════
 *
 * `page.tsx` in this folder is a `"use client"` component, and a client
 * component cannot export `metadata`. Next only reads `metadata` from server
 * modules, so declaring it there would be silently ignored and the page would
 * inherit the root layout's title and canonical — i.e. it would claim to be the
 * homepage.
 *
 * ⚠️ THIS LAYOUT EXISTS ONLY TO CARRY METADATA. It renders `children`
 * unchanged: no wrapper element, no styling, no behaviour. That keeps the page's
 * existing UI and hydration exactly as they were.
 */
export const metadata: Metadata = {
  title: "Blog — Mavly AI Website Builder",
  description:
    "Articles on prompting, engineering and workflow for AI website building.",
  alternates: {
    canonical: canonicalFor("/blog"),
  },
  openGraph: {
    title: "Blog — Mavly AI Website Builder",
    description:
      "Articles on prompting, engineering and workflow for AI website building.",
    url: canonicalFor("/blog"),
    images: ["/logo/Mavly.png"],
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
