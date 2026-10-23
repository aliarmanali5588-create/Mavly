// Mavly service worker — production offline support.
//
// Honest caching rules:
//  * Only static, non-user-specific assets are cached (branding, app shell resources).
//  * Authenticated pages, /api/*, /auth/*, Next.js payload (_next/data) and anything
//    user-specific are never cached.
//  * Navigation requests fall back to /offline.html when the network is unavailable.
//  * Cache is versioned; obsolete Mavly caches are purged on activate.

const CACHE_STATIC = "mavly-static-v1";
const OFFLINE_URL = "/offline.html";

// Branding / shell assets that are safe to cache (public, non-user-specific).
const SHELL_ASSETS = [
  "/manifest.json",
  "/offline.html",
  "/favicon.ico",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/robots.txt",
  "/logo/Mavly.png",
  "/logo/Mavly.ico",
  "/applogo/applogo.png",
  "/applogo/applogo-192.png",
  "/applogo/applogo-512.png",
  "/applogo/applogo-maskable-192.png",
  "/applogo/applogo-maskable-512.png",
  "/applogo/apple-touch-icon.png",
  "/svg/credit.svg",
];

function isSameOrigin(urlString) {
  try {
    return new URL(urlString).origin === self.origin;
  } catch {
    return false;
  }
}

function isCacheableAsset(pathname) {
  // Versioned Next.js JS/CSS — safe to cache-first because the filename hash changes
  // on every deploy, so stale bytes are never served after an update.
  if (pathname.startsWith("/_next/static/")) return true;
  // Branding / static public assets.
  if (pathname.startsWith("/logo/")) return true;
  if (pathname.startsWith("/applogo/")) return true;
  if (pathname.startsWith("/svg/")) return true;
  if (pathname === "/favicon.ico" || pathname === "/favicon-16x16.png" || pathname === "/favicon-32x32.png") return true;
  if (pathname === "/manifest.json" || pathname === "/offline.html" || pathname === "/robots.txt") return true;
  return false;
}

// Never cache these — they carry auth/session/user/AI/payment data.
function isSensitive(pathname) {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/_next/data/") // Next.js client-transition payload (user-specific)
  );
}

// ── Install: precache the shell, then activate immediately ──────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_STATIC)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: claim clients so updates take effect without a reload, and purge
//    only caches owned by Mavly ───────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((key) => key.startsWith("mavly-") && key !== CACHE_STATIC)
              .map((key) => caches.delete(key))
          )
        ),
    ])
  );
});

// ── Fetch ───────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const urlString = request.url;

  // Only same-origin GET requests are handled by this worker.
  if (request.method !== "GET" || !isSameOrigin(urlString)) return;

  const pathname = new URL(urlString).pathname;

  // Sensitive routes: never intercept, never cache — let them hit the network.
  if (isSensitive(pathname)) return;

  // Navigation requests (pages): network first, honest offline fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL))
    );
    return;
  }

  // Cacheable static assets: cache first, then network, then fill cache.
  if (isCacheableAsset(pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_STATIC).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else: network only (no caching).
  return;
});
