import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/supabase/server";
import { profileFromAuthUser } from "@/lib/user-profile";
import { SupportClient } from "./support-client";

export const metadata: Metadata = {
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
  return <SupportClient profile={user ? profileFromAuthUser(user) : null} />;
}
