import type { Metadata } from "next";
import { canonicalFor } from "@/lib/seo/site";
import { JsonLd } from "@/components/seo/JsonLd";
import { breadcrumbSchema } from "@/lib/seo/structured-data";
import { getCurrentUser } from "@/lib/supabase/server";
import { profileFromAuthUser } from "@/lib/user-profile";
import { SupportClient } from "./support-client";

export const metadata: Metadata = {
  alternates: {
    canonical: canonicalFor("/support"),
  },
  title: "Help & Support — Mavly",
  description:
    "Contact the Mavly team for technical assistance, billing, subscriptions, careers, or general enquiries.",
  openGraph: {
    title: "Help & Support — Mavly",
    description:
      "Contact the Mavly team for technical assistance, billing, subscriptions, careers, or general enquiries.",
    images: ["/logo/Mavly.png"],
  },
};

export default async function SupportPage() {
  const user = await getCurrentUser();
  return (
    <>
      {/* Breadcrumb trail for this nested public page. */}
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Support", path: "/support" },
        ])}
      />
      <SupportClient profile={user ? profileFromAuthUser(user) : null} />
    </>
  );
}
