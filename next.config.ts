import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel has its own Next.js adapter and does not need a standalone server.
  // Standalone is only useful for Docker / self-hosted Node builds. Mixing the
  // two on Next 16.3 makes the build fail late in onBuildComplete with
  // "ENOENT: .../.next/next-server.js.nft.json" (see Next.js issue #96646),
  // so disable standalone when building on Vercel (VERCEL=1 is set there).
  output: process.env.VERCEL ? undefined : "standalone",
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "placeholders.io",
      },
      {
        protocol: "https",
        hostname: "ik.imagekit.io",
      },
    ]
  },
  // Hide the on-screen Next.js dev indicator (the bottom-left bubble shown
  // during `next dev`). Compile/runtime errors are still surfaced.
  devIndicators: false,
  allowedDevOrigins: ["*"],
  async headers() {
    // Only cache-control headers here. CSP and CORS are handled exclusively in proxy.ts
    return [
      /**
       * ⚠️ IMMUTABLE BUILD ASSETS ARE EXCLUDED FROM `no-store`.
       *
       * The blanket rule below used to apply to EVERY path, including
       * `/_next/static/*` — files whose names contain a content hash and which
       * Next serves with `immutable` semantics. Forcing `no-store` on them made
       * the browser re-download the same JavaScript and CSS on every single
       * navigation, which is a large part of why moving between pages felt slow.
       *
       * These are public, content-addressed build outputs. They carry no user
       * data, so caching them cannot leak one session into another.
       */
      {
        source: "/_next/static/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      /**
       * Everything else keeps the original no-cache policy. Application HTML and
       * API responses are per-user and must never be stored by a shared cache.
       */
      {
        source: "/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          { key: "Pragma", value: "no-cache" },
          { key: "Expires", value: "0" },
        ],
      },
    ];
  },
};

export default nextConfig;
