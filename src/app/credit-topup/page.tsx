import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/supabase/server";
import { profileFromAuthUser } from "@/lib/user-profile";
import { CreditTopupClient } from "./credit-topup-client";

export const metadata: Metadata = {
  /**
   * ⚠️ NOT INDEXABLE, AND NOT BECAUSE IT IS SECRET. This page is per-user
   * (it reads the session to show the current plan) and is already listed in
   * robots.ts. `Disallow` only stops a crawler *fetching* it; a URL that is
   * linked from elsewhere can still be indexed from the link alone. The
   * `noindex` directive is what actually keeps it out of an index, so both
   * are set. This does not change access control: the page still renders
   * only what the signed-in user is entitled to see.
   */
  robots: { index: false, follow: false },
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
