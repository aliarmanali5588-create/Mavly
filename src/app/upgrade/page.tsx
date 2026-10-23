import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/supabase/server";
import { profileFromAuthUser } from "@/lib/user-profile";
import { UpgradeClient } from "./upgrade-client";

export const metadata: Metadata = {
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
