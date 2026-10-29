import type { Metadata } from "next";
import MarketingHome from "@/components/home/MarketingHome";

export const metadata: Metadata = {
  title: "Mavly — AI App Builder",
  description: "Build your next website or app with Mavly AI.",
  alternates: {
    canonical: "https://mavly.xyz/",
  },
  openGraph: {
    title: "Mavly — AI App Builder",
    description: "Build your next website or app with Mavly AI.",
    url: "https://mavly.xyz/",
    type: "website",
    images: [
      {
        url: "https://mavly.xyz/favicon-32x32.png",
        secureUrl: "https://mavly.xyz/favicon-32x32.png",
        type: "image/png",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: "Mavly — AI App Builder",
    description: "Build your next website or app with Mavly AI.",
    images: ["https://mavly.xyz/favicon-32x32.png"],
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
