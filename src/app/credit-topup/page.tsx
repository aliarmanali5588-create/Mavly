import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/supabase/server";
import { profileFromAuthUser } from "@/lib/user-profile";
import { CreditTopupClient } from "./credit-topup-client";

export const metadata: Metadata = {
  title: "Top Up AI Credits — Mavly",
  description:
    "Get extra credits for building and refining your projects with Mavly. Choose a package that fits your needs.",
  openGraph: {
    title: "Top Up AI Credits — Mavly",
    description:
      "Get extra credits for building and refining your projects with Mavly. Choose a package that fits your needs.",
    images: ["/logo/Mavly.png"],
  },
};

export default async function CreditTopupPage() {
  const user = await getCurrentUser();
  return <CreditTopupClient profile={user ? profileFromAuthUser(user) : null} />;
}
