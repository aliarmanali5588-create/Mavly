import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/supabase/server";
import { profileFromAuthUser } from "@/lib/user-profile";
import { UpgradeClient } from "./upgrade-client";

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
  title: "Upgrade Plan — Mavly",
  description:
    "Choose the plan that fits your workflow. Upgrade whenever you need more capacity and features.",
  openGraph: {
    title: "Upgrade Plan — Mavly",
    description:
      "Choose the plan that fits your workflow. Upgrade whenever you need more capacity and features.",
    images: ["/logo/Mavly.png"],
  },
};

export default async function UpgradePage() {
  const user = await getCurrentUser();
  return <UpgradeClient profile={user ? profileFromAuthUser(user) : null} />;
}
