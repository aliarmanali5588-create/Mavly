import type { Metadata } from "next";
import MarketingHome from "@/components/home/MarketingHome";

export const metadata: Metadata = {
  title: "Mavly — Build Websites with AI. No Coding Required.",
  description:
    "Mavly is an AI website builder that turns your ideas into beautiful, functional websites. We don't make websites. We make memories.",
  icons: {
    icon: "/logo/Mavly.ico",
    shortcut: "/logo/Mavly.ico",
  },
  openGraph: {
    title: "Mavly — Build Websites with AI. No Coding Required.",
    description:
      "Mavly is an AI website builder that turns your ideas into beautiful, functional websites. We don't make websites. We make memories.",
    images: ["/logo/Mavly.png"],
  },
};

/**
 * The public marketing page.
 *
 * It is the front door of the site, so it stays reachable without an account.
 * The Google/GitHub buttons on it start the OAuth flow directly — there is no
 * detour through `/login`.
 */
export default function Page() {
  return <MarketingHome />;
}
