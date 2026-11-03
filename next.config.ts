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
      /**
       * ═══ PUBLIC DISCOVERY LINK HEADERS ═══════════════════════════════════
       *
       * `Link: <…>; rel="sitemap"` advertises the sitemap on the response itself,
       * so a crawler or agent that fetched a page without reading robots.txt
       * still learns where the map is. This is the Cloudflare Agent Readiness
       * "give agents a website map" signal, alongside robots.txt and the
       * sitemap file itself.
       *
       * ⚠️ SCOPED TO PUBLIC MARKETING PATHS, NOT `/:path*`. A `Link` header on
       * `/api/*` or on an authenticated page would advertise a discovery
       * resource from a response that is neither public nor cacheable, and it
       * would be duplicated onto every per-user payload for no benefit. The
       * requirements say "no unnecessary headers on private API responses";
       * the narrow matcher is how that is honoured rather than asserted.
       *
       * ⚠️ THE SITEMAP IS NOT THE ONLY LINK. `rel="llms-txt"` is a
       * non-registered relation type (there is no IANA registration for it), so
       * it is emitted as a plain `rel` string that consumers may ignore. It is
       * additive: it cannot break a client that does not know it.
       *
       * ⚠️ ONE VALUE PER HEADER, COMMA-SEPARATED. Emitting the `Link` key twice
       * in this array produces two separate `Link` headers, which is legal but
       * makes de-duplication the client's problem. A single combined value is
       * unambiguous and cannot be duplicated by the matcher.
       *
       * ⚠️ THIS DOES NOT TOUCH CACHING. It adds a response header only; the
       * `Cache-Control` rules above (and Cloudflare's own edge behaviour) are
       * unchanged.
       */
      {
        source: "/",
        headers: [
          {
            key: "Link",
            value:
              '</sitemap.xml>; rel="sitemap", </llms.txt>; rel="llms-txt", </auth.md>; rel="authorization"',
          },
        ],
      },
      {
        source: "/:page((?!api/|dashboard|project/|adminsh|login|auth/|upgrade|credit-topup|account-restricted).*)",
        headers: [
          {
            key: "Link",
            value:
              '</sitemap.xml>; rel="sitemap", </llms.txt>; rel="llms-txt", </auth.md>; rel="authorization"',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
