"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { toast } from "sonner";
import { startOAuth } from "@/lib/auth/oauth";
import { signInErrorMessage } from "@/lib/auth/error-copy";
import type { OAuthProvider } from "@/lib/auth/oauth-url";

// ── Complete 23 ImageKit Assets Data Source ───────────────────────────────────
export interface ShowcaseAsset {
  id: string;
  url: string;
  label: string;
  aspectClass: string;
  widthClass: string;
  staticRotDeg: number;
}

export const HERO_SHOWCASE_ASSETS: ShowcaseAsset[] = [
  // Group A (Upper-Left Strip: Assets 01 to 11)
  {
    id: "img-01",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.14.03%E2%80%AFAM_converted.webp",
    label: "Artisanal Bakery & Bakehouse",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[320px] sm:w-[410px] md:w-[470px] lg:w-[530px] xl:w-[570px]",
    staticRotDeg: -1.2,
  },
  {
    id: "img-02",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.16.18%E2%80%AFAM_converted.webp",
    label: "Farrow & Reid Advisory",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[300px] sm:w-[380px] md:w-[440px] lg:w-[500px] xl:w-[540px]",
    staticRotDeg: 0.8,
  },
  {
    id: "img-03",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.09.18%20AM.webp",
    label: "Evervale Studio — Marketing",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[330px] sm:w-[420px] md:w-[480px] lg:w-[540px] xl:w-[580px]",
    staticRotDeg: -0.6,
  },
  {
    id: "img-04",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.16.30%E2%80%AFAM_converted.webp",
    label: "CogniBloom — Curiosity & Education",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[310px] sm:w-[390px] md:w-[450px] lg:w-[510px] xl:w-[550px]",
    staticRotDeg: 1.0,
  },
  {
    id: "img-05",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.09.03%20AM.webp",
    label: "SonnenBloom Kinderhaus",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[320px] sm:w-[410px] md:w-[470px] lg:w-[530px] xl:w-[570px]",
    staticRotDeg: -0.9,
  },
  {
    id: "img-06",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.10.21%20AM.webp",
    label: "GH Getaway — Vacation Retreat",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[300px] sm:w-[380px] md:w-[440px] lg:w-[500px] xl:w-[540px]",
    staticRotDeg: 0.6,
  },
  {
    id: "img-07",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.10.05%20AM.webp",
    label: "Starkwater Plumbing",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[330px] sm:w-[420px] md:w-[480px] lg:w-[540px] xl:w-[580px]",
    staticRotDeg: -1.0,
  },
  {
    id: "img-08",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.12.32%E2%80%AFAM_converted.webp",
    label: "Vector Transit Logistics",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[310px] sm:w-[400px] md:w-[460px] lg:w-[520px] xl:w-[560px]",
    staticRotDeg: 0.7,
  },
  {
    id: "img-09",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.13.41%E2%80%AFAM_converted.webp",
    label: "Little Rainbow Daycare & Nursery",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[320px] sm:w-[410px] md:w-[470px] lg:w-[530px] xl:w-[570px]",
    staticRotDeg: -0.7,
  },
  {
    id: "img-10",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.15.37%E2%80%AFAM_converted.webp",
    label: "Newel Remodeling & Architecture",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[300px] sm:w-[380px] md:w-[440px] lg:w-[500px] xl:w-[540px]",
    staticRotDeg: 0.9,
  },
  {
    id: "img-11",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.15.54%E2%80%AFAM_converted.webp",
    label: "CJ7a Event Experiences",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[330px] sm:w-[420px] md:w-[480px] lg:w-[540px] xl:w-[580px]",
    staticRotDeg: -1.1,
  },

  // Group B (Bottom-Right Strip: Assets 12 to 23)
  {
    id: "img-12",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.17.36%E2%80%AFAM_converted.webp",
    label: "Solstice Detailing Automotive",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[330px] sm:w-[420px] md:w-[480px] lg:w-[540px] xl:w-[580px]",
    staticRotDeg: 1.1,
  },
  {
    id: "img-13",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.11.38%E2%80%AFAM_converted.webp",
    label: "Palmer Therapeutic Bodywork",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[310px] sm:w-[390px] md:w-[450px] lg:w-[510px] xl:w-[550px]",
    staticRotDeg: -0.8,
  },
  {
    id: "img-14",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.10.56%E2%80%AFAM_converted.webp",
    label: "All Letters Editorial Journal",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[320px] sm:w-[410px] md:w-[470px] lg:w-[530px] xl:w-[570px]",
    staticRotDeg: 0.7,
  },
  {
    id: "img-15",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.18.17%E2%80%AFAM_converted.webp",
    label: "Momentum Connect Talent Advisory",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[300px] sm:w-[380px] md:w-[440px] lg:w-[500px] xl:w-[540px]",
    staticRotDeg: -1.0,
  },
  {
    id: "img-16",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.13.23%E2%80%AFAM_converted.webp",
    label: "Oakhaven Light Fellowship",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[330px] sm:w-[420px] md:w-[480px] lg:w-[540px] xl:w-[580px]",
    staticRotDeg: 0.9,
  },
  {
    id: "img-17",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.12.59%E2%80%AFAM_converted.webp",
    label: "Waggenburg Kennels",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[310px] sm:w-[400px] md:w-[460px] lg:w-[520px] xl:w-[560px]",
    staticRotDeg: -0.6,
  },
  {
    id: "img-18",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.17.16%E2%80%AFAM_converted.webp",
    label: "Skyline Coming Soon",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[320px] sm:w-[410px] md:w-[470px] lg:w-[530px] xl:w-[570px]",
    staticRotDeg: 1.0,
  },
  {
    id: "img-19",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.10.37%E2%80%AFAM_converted.webp",
    label: "Galvanic Electrical Energy",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[300px] sm:w-[380px] md:w-[440px] lg:w-[500px] xl:w-[540px]",
    staticRotDeg: -0.7,
  },
  {
    id: "img-20",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.11.12%E2%80%AFAM_converted.webp",
    label: "Weaver of Worlds Literature",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[330px] sm:w-[420px] md:w-[480px] lg:w-[540px] xl:w-[580px]",
    staticRotDeg: 0.8,
  },
  {
    id: "img-21",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.14.32%E2%80%AFAM_converted.webp",
    label: "Lustro James Luxury Detailing",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[310px] sm:w-[390px] md:w-[450px] lg:w-[510px] xl:w-[550px]",
    staticRotDeg: -1.2,
  },
  {
    id: "img-22",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.17.57%E2%80%AFAM_converted.webp",
    label: "The Lumina — Midnight Tides",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[320px] sm:w-[410px] md:w-[470px] lg:w-[530px] xl:w-[570px]",
    staticRotDeg: 0.6,
  },
  {
    id: "img-23",
    url: "https://ik.imagekit.io/2potcqor3/Screenshot%202026-10-23%20at%2011.09.38%20AM.webp",
    label: "Miroir Refined Hair Salon",
    aspectClass: "aspect-[16/9.2]",
    widthClass: "w-[320px] sm:w-[410px] md:w-[470px] lg:w-[530px] xl:w-[570px]",
    staticRotDeg: -0.8,
  },
];

// Distribution: Group A has 11 unique assets (0..11); Group B has 12 unique assets (11..23)
const GROUP_A_ASSETS = HERO_SHOWCASE_ASSETS.slice(0, 11);
const GROUP_B_ASSETS = HERO_SHOWCASE_ASSETS.slice(11, 23);

// Shared cache of loaded image URLs to prevent duplicate requests and flash of unstyled content
// across clones, component re-renders, and route transitions (homepage <-> login).
const GLOBAL_LOADED_URLS = new Set<string>();

/**
 * Progressively preloads upcoming off-screen animated images in small staged batches
 * shortly before they rotate into view, avoiding network saturation during initial hero render.
 */
function useStagedPreload(assetsA: ShowcaseAsset[], assetsB: ShowcaseAsset[]) {
  useEffect(() => {
    // Collect off-screen upcoming URLs (skipping the first 2 visible cards of each track)
    const upcomingUrls: string[] = [];
    const maxLen = Math.max(assetsA.length, assetsB.length);
    for (let i = 2; i < maxLen; i++) {
      if (i < assetsA.length) upcomingUrls.push(assetsA[i].url);
      if (i < assetsB.length) upcomingUrls.push(assetsB[i].url);
    }

    const unqueued = upcomingUrls.filter((url) => !GLOBAL_LOADED_URLS.has(url));
    if (unqueued.length === 0) return;

    // Load 2 images every 2.5 seconds (matching the ~3.8s per-card drift speed)
    const BATCH_SIZE = 2;
    const INTERVAL_MS = 2500;
    const timeouts: ReturnType<typeof setTimeout>[] = [];

    for (let i = 0; i < unqueued.length; i += BATCH_SIZE) {
      const batch = unqueued.slice(i, i + BATCH_SIZE);
      const delay = (i / BATCH_SIZE + 1) * INTERVAL_MS;
      const tid = setTimeout(() => {
        batch.forEach((url) => {
          if (GLOBAL_LOADED_URLS.has(url)) return;
          const img = new window.Image();
          img.src = url;
          img.onload = () => GLOBAL_LOADED_URLS.add(url);
          img.onerror = () => {};
        });
      }, delay);
      timeouts.push(tid);
    }

    return () => {
      timeouts.forEach(clearTimeout);
    };
  }, [assetsA, assetsB]);
}

/**
 * Free-flowing website preview screenshot for the animated showcase tracks
 */
function HeroCard({
  card,
  isClone = false,
  priority = false,
}: {
  card: ShowcaseAsset;
  isClone?: boolean;
  priority?: boolean;
}) {
  const [isLoaded, setIsLoaded] = useState(() => GLOBAL_LOADED_URLS.has(card.url));
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    if (GLOBAL_LOADED_URLS.has(card.url)) {
      setIsLoaded(true);
    }
  }, [card.url]);

  // Gracefully handle failed requests without leaving broken icons or empty white cards
  if (hasError) {
    return null;
  }

  return (
    <div
      className={`shrink-0 ${card.widthClass} select-none pointer-events-none`}
      style={{
        transform: `rotate(${card.staticRotDeg}deg)`,
      }}
      aria-hidden={isClone}
    >
      <div
        className={`relative w-full ${card.aspectClass} rounded-xl sm:rounded-2xl overflow-hidden bg-white shadow-[0_12px_32px_rgba(0,0,0,0.07),0_2px_6px_rgba(0,0,0,0.03)] ring-1 ring-black/[0.06] transition-opacity duration-500 ease-out ${
          isLoaded ? "opacity-100" : "opacity-0"
        }`}
      >
        <Image
          src={card.url}
          alt={isClone ? "" : card.label}
          fill
          unoptimized
          sizes="(max-width: 640px) 340px, (max-width: 1024px) 500px, 600px"
          priority={priority}
          loading={priority ? "eager" : "lazy"}
          className="object-contain object-top"
          referrerPolicy="no-referrer"
          onLoad={() => {
            GLOBAL_LOADED_URLS.add(card.url);
            setIsLoaded(true);
          }}
          onError={() => {
            setHasError(true);
          }}
        />
      </div>
    </div>
  );
}

function ShowcaseTrack({
  assets,
  direction,
  priorityFirstTwo = false,
}: {
  assets: ShowcaseAsset[];
  direction: "left" | "right";
  priorityFirstTwo?: boolean;
}) {
  return (
    <div className={`flex w-max ${direction === "left" ? "mavly-track-left" : "mavly-track-right"}`}>
      <div className="flex gap-5 sm:gap-6 pr-5 sm:pr-6 shrink-0 items-center">
        {assets.map((card, idx) => (
          <HeroCard key={card.id} card={card} priority={priorityFirstTwo && idx < 2} />
        ))}
      </div>
      <div className="flex gap-5 sm:gap-6 pr-5 sm:pr-6 shrink-0 items-center" aria-hidden="true">
        {assets.map((card) => (
          <HeroCard key={`clone-${direction}-${card.id}`} card={card} isClone />
        ))}
      </div>
    </div>
  );
}

export function HeroShowcaseBackground({ variant = "hero" }: { variant?: "hero" | "login" }) {
  useStagedPreload(GROUP_A_ASSETS, GROUP_B_ASSETS);

  if (variant === "login") {
    return (
      <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none select-none" aria-hidden="true">
        <div className="absolute -top-8 sm:-top-12 -left-[6%] sm:-left-[4%] w-full sm:w-[65vw] lg:w-[55vw] max-w-[900px] overflow-hidden pointer-events-none opacity-80 sm:opacity-90 [mask-image:linear-gradient(to_right,black_70%,transparent)]">
          <ShowcaseTrack assets={GROUP_A_ASSETS} direction="left" priorityFirstTwo />
        </div>
        <div className="absolute -bottom-10 sm:-bottom-14 -right-[6%] sm:-right-[4%] w-full sm:w-[65vw] lg:w-[55vw] max-w-[900px] overflow-hidden pointer-events-none opacity-80 sm:opacity-90 [mask-image:linear-gradient(to_left,black_70%,transparent)] hidden sm:block">
          <ShowcaseTrack assets={GROUP_B_ASSETS} direction="right" priorityFirstTwo />
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        className="absolute top-2 sm:top-5 md:top-8 left-0 w-full sm:w-[58vw] lg:w-[52vw] xl:w-[48vw] max-w-[950px] overflow-hidden pointer-events-none z-10 opacity-90 sm:opacity-95 lg:opacity-100 [mask-image:linear-gradient(to_right,black_75%,transparent)]"
        aria-hidden="true"
      >
        <ShowcaseTrack assets={GROUP_A_ASSETS} direction="left" priorityFirstTwo />
      </div>
      <div
        className="absolute bottom-2 sm:bottom-5 md:bottom-8 right-0 w-full sm:w-[58vw] lg:w-[52vw] xl:w-[48vw] max-w-[950px] overflow-hidden pointer-events-none z-10 opacity-90 sm:opacity-95 lg:opacity-100 [mask-image:linear-gradient(to_left,black_75%,transparent)]"
        aria-hidden="true"
      >
        <ShowcaseTrack assets={GROUP_B_ASSETS} direction="right" priorityFirstTwo />
      </div>
    </>
  );
}

export function HeroSection() {
  const [loadingProvider, setLoadingProvider] = useState<OAuthProvider | null>(null);

  // The homepage starts the OAuth flow immediately — the user is sent
  // straight to Google/GitHub instead of being routed through /login.
  // The link's href stays as a no-JavaScript fallback.
  const handleProviderClick = async (
    event: React.MouseEvent<HTMLAnchorElement>,
    provider: OAuthProvider,
  ) => {
    event.preventDefault();
    if (loadingProvider) return;

    setLoadingProvider(provider);
    try {
      // The builder is the destination: the marketing page stays public.
      const result = await startOAuth(provider, "/dashboard");
      if (!result.ok) {
        setLoadingProvider(null);
        toast.error(signInErrorMessage(result.error));
      }
    } catch {
      setLoadingProvider(null);
      toast.error("We could not start the sign-in. Please try again.");
    }
  };

  return (
    <section className="relative pt-24 pb-20 sm:pt-32 sm:pb-28 md:pt-36 md:pb-36 overflow-hidden bg-[var(--neu-base)]">
      {/* Ambient Radial Depth Glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[550px] bg-gradient-to-b from-black/[0.02] to-transparent rounded-full blur-3xl pointer-events-none -z-10" />

      <HeroShowcaseBackground />

      {/* ── STABLE CENTRAL HERO CONTENT (Primary Focal Point, Unobstructed & Static) ── */}
      <div className="relative max-w-3xl mx-auto px-4 sm:px-6 text-center z-20 pointer-events-auto">
        {/* Official Mavly Logo */}
        <div className="flex items-center justify-center mb-6 sm:mb-8">
          <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl sm:rounded-3xl overflow-hidden bg-white shadow-[0_8px_24px_rgba(0,0,0,0.06),0_2px_6px_rgba(0,0,0,0.02)] p-1.5 border border-black/[0.08] flex items-center justify-center shrink-0 transition-transform duration-300 hover:scale-105 select-none">
            <Image
              src="/logo/Mavly.png"
              alt="Mavly Logo"
              width={72}
              height={72}
              className="w-full h-full object-contain rounded-xl sm:rounded-2xl"
              priority
              referrerPolicy="no-referrer"
            />
          </div>
        </div>

        {/* Headline */}
        <h1 className="text-4xl sm:text-5xl md:text-6xl font-black tracking-tight text-gray-950 leading-[1.12] max-w-2xl mx-auto">
          Build Websites with AI. <br className="hidden sm:inline" />
          No Coding Required.
        </h1>

        {/* Supporting Description */}
        <p className="mt-5 text-sm sm:text-base md:text-lg text-gray-700 font-normal leading-relaxed max-w-xl mx-auto">
          Mavly is an AI website builder that turns your ideas into beautiful, functional websites. We don&apos;t make websites. We make memories.
        </p>

        {/* Authentication Buttons directly beneath the supporting description */}
        <div className="mt-8 flex flex-col items-center gap-3 w-full max-w-sm mx-auto">
          {/* Button 1: Continue with Google (Primary dark appearance) */}
          <Link
            href="/login?provider=google"
            onClick={(event) => void handleProviderClick(event, "google")}
            aria-busy={loadingProvider === "google"}
            className="w-full h-12 rounded-full bg-black hover:bg-neutral-800 text-white font-medium text-sm flex items-center justify-center gap-3 shadow-[0_4px_14px_rgba(0,0,0,0.14),0_1px_2px_rgba(0,0,0,0.06)] hover:shadow-[0_6px_20px_rgba(0,0,0,0.2)] hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] active:shadow-[inset_0_2px_4px_rgba(0,0,0,0.25)] transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 select-none"
          >
            <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"
              />
              <path
                fill="#34A853"
                d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.34 24 12 24z"
              />
              <path
                fill="#FBBC05"
                d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.17 0 9.97 0 12s.45 3.83 1.25 5.42l4.03-3.15z"
              />
              <path
                fill="#EA4335"
                d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.34 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"
              />
            </svg>
            <span>Continue with Google</span>
          </Link>

          {/* Button 2: Continue with GitHub (White/neutral appearance) */}
          <Link
            href="/login?provider=github"
            onClick={(event) => void handleProviderClick(event, "github")}
            aria-busy={loadingProvider === "github"}
            className="w-full h-12 rounded-full bg-white hover:bg-neutral-50 text-gray-900 border border-black/[0.1] font-medium text-sm flex items-center justify-center gap-3 shadow-[0_2px_8px_rgba(0,0,0,0.04)] hover:shadow-[0_4px_14px_rgba(0,0,0,0.08)] hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] active:shadow-[inset_0_1px_3px_rgba(0,0,0,0.06)] transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 select-none"
          >
            <svg className="w-4 h-4 shrink-0 fill-current text-gray-900" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
              />
            </svg>
            <span>Continue with GitHub</span>
          </Link>

          {/* Legal Notice */}
          <p className="text-xs text-gray-500 text-center mt-3">
            By continuing, you agree to our{" "}
            <Link href="/terms" className="underline hover:text-gray-900 transition-colors">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className="underline hover:text-gray-900 transition-colors">
              Privacy Policy
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}
