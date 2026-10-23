// src/app/layout.tsx
import React from "react";
import type { Metadata } from "next";
import { DM_Sans, Geist_Mono } from "next/font/google";
import "./globals.css";
import { GlobalErrorCatcher } from "@/components/GlobalErrorCatcher";
import { Toaster } from "@/components/ui/sonner";
import { InsufficientCreditsModal } from "@/components/workspace/InsufficientCreditsModal";
import { PWAInitializer } from "@/components/pwa/PWAInitializer";

const dmSans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"], weight: ["300", "400", "500", "600", "700"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Mavly — AI App Builder",
  description: "Build apps with AI. Describe what you want, preview in real-time, deploy with one click.",
  icons: {
    icon: [
      { url: "/logo/Mavly.ico", type: "image/x-icon" },
      { url: "/logo/Mavly.png", type: "image/png" },
    ],
    shortcut: "/logo/Mavly.ico",
    apple: "/logo/Mavly.png",
  },
  openGraph: {
    title: "Mavly — AI App Builder",
    description: "Build apps with AI. Describe what you want, preview in real-time, deploy with one click.",
    images: ["/logo/Mavly.png"],
  },
};

// SUPER IMPORTANT: NOT EDIT THE FOLLOWING 2 LINES TO FORCE NEXT.JS TO RENDER DYNAMICALLY
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/logo/Mavly.ico" sizes="any" />
        <link rel="icon" href="/favicon-32x32.png" sizes="32x32" type="image/png" />
        <link rel="icon" href="/favicon-16x16.png" sizes="16x16" type="image/png" />
        <link rel="manifest" href="/manifest.json" />
        <link
          rel="apple-touch-icon"
          href="/applogo/apple-touch-icon.png"
          sizes="180x180"
        />
        <meta name="theme-color" content="#000000" />
      </head>
      <body className={`${dmSans.variable} ${geistMono.variable} antialiased`}>
        <GlobalErrorCatcher />
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
