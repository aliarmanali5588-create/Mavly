// src/app/layout.tsx
import React from "react";
import type { Metadata, Viewport } from "next";
import { DM_Sans, Geist_Mono } from "next/font/google";
import "./globals.css";
import { GlobalErrorCatcher } from "@/components/GlobalErrorCatcher";
import { Toaster } from "@/components/ui/sonner";
import { InsufficientCreditsModal } from "@/components/workspace/InsufficientCreditsModal";
import { PWAInitializer } from "@/components/pwa/PWAInitializer";
import { AccountRestrictionWatcher } from "@/components/AccountRestrictionWatcher";

const dmSans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"], weight: ["300", "400", "500", "600", "700"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

/**
 * ═══ GOOGLE SEARCH CONSOLE VERIFICATION ═════════════════════════════════════
 *
 * The token is a fixed string issued by Google for the `mavly.xyz` property. It
 * must appear verbatim in the served `<head>` of the homepage, in the HTML the
 * server returns, with no JavaScript executed.
 *
 * ⚠️ WHY IT LIVES IN THE ROOT LAYOUT AND NOT A PAGE. Next merges metadata from
 * the layout down, so declaring it once here emits it on every page — including
 * the homepage reached after the apex→www redirect, which is the URL Google
 * actually fetches. Declaring it in `app/page.tsx` would also work, but a second
 * copy anywhere would render the tag twice and Google treats a duplicated
 * verification tag as ambiguous.
 *
 * ⚠️ DO NOT REGENERATE OR "TIDY" THIS VALUE. It is not a secret and not a
 * placeholder; it is the exact token Google compares against.
 */
const GOOGLE_SITE_VERIFICATION = "lnx3GeC1KdlwHdtsa36BFgCj9c-tnvDpw_cKua9ZhUA";

export const metadata: Metadata = {
  /*
   * ⚠️ `metadataBase` IS THE CANONICAL ORIGIN, NOT THE APEX. The apex
   * `mavly.xyz` 301s to `www.mavly.xyz` at the edge, so every URL Next resolves
   * against this base (canonicals, OG images, Twitter cards) must already be the
   * post-redirect host. Pointing it at the apex made every generated URL a
   * redirect to itself.
   */
  metadataBase: new URL("https://www.mavly.xyz"),
  /*
   * ⚠️ NO `title.template`. Every public page already authors a complete,
   * unique, branded title ("Pricing Plans — Mavly AI Website Builder"). Adding a
   * template appended a second brand to each one, producing
   * "Pricing Plans — Mavly AI Website Builder | Mavly". A plain string is the
   * homepage's title and the fallback for any page that does not set its own.
   */
  title: "Mavly — AI Website Builder",
  description:
    "Mavly is an AI website builder that turns a plain-English prompt into a working website, with live preview, code editing, GitHub sync and publishing.",
  applicationName: "Mavly",
  authors: [{ name: "Mavly", url: "https://www.mavly.xyz/" }],
  creator: "Mavly",
  publisher: "Mavly",
  /*
   * The site-wide default. Public marketing pages inherit `index, follow`;
   * private surfaces are handled by (a) the proxy's session gate and (b) the
   * `Disallow` rules in robots.ts. A page that must not be indexed can override
   * this with its own `robots` field.
   */
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  verification: {
    google: GOOGLE_SITE_VERIFICATION,
  },
  icons: {
    icon: [
      { url: "/favicon.ico", type: "image/x-icon" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    shortcut: "/favicon.ico",
    apple: "/applogo/apple-touch-icon.png",
  },
  openGraph: {
    type: "website",
    siteName: "Mavly",
    locale: "en_US",
    url: "https://www.mavly.xyz/",
    title: "Mavly — AI Website Builder",
    description:
      "Mavly is an AI website builder that turns a plain-English prompt into a working website, with live preview, code editing, GitHub sync and publishing.",
    /*
     * ⚠️ A 32×32 FAVICON WAS BEING USED AS THE SHARE IMAGE. Every link preview
     * on every platform was a blurry icon. The 1254×1254 brand logo is the
     * verified asset already used by the app icon and the Organization schema.
     */
    images: [
      {
        url: "/logo/Mavly.png",
        width: 1254,
        height: 1254,
        alt: "Mavly — AI website builder",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Mavly — AI Website Builder",
    description:
      "Mavly is an AI website builder that turns a plain-English prompt into a working website, with live preview, code editing, GitHub sync and publishing.",
    images: ["/logo/Mavly.png"],
  },
  alternates: {
    canonical: "https://www.mavly.xyz/",
  },
  category: "technology",
};

// SUPER IMPORTANT: NOT EDIT THE FOLLOWING 2 LINES TO FORCE NEXT.JS TO RENDER DYNAMICALLY
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * `viewportFit: "cover"` is what makes `env(safe-area-inset-*)` resolve to a
 * real value on a notched phone. Without it those insets are always 0 and the
 * workspace's safe-area padding silently does nothing.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#000000",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#000000" />
        <meta name="google-site-verification" content="lnx3GeC1KdlwHdtsa36BFgCj9c-tnvDpw_cKua9ZhUA" />
      </head>
      <body className={`${dmSans.variable} ${geistMono.variable} antialiased`}>
        <GlobalErrorCatcher />
        <AccountRestrictionWatcher />
        <Toaster position="top-right" richColors />
        {/*
          ⭐ MOUNTED ONCE FOR THE WHOLE APP. Running out of credits can happen on any
          screen — the dashboard creating a project, the workspace publishing one — and
          the modal listens for the event the VCaaS client raises rather than being wired
          per page. See `InsufficientCreditsModal`.
        */}
        <InsufficientCreditsModal />
        {/* PWA: service worker, branded initial splash, and honest offline banner. */}
        <PWAInitializer />
        <div className="min-h-screen flex flex-col">
          <main className="flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
