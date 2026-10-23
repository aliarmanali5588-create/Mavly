/**
 * Mavly service-worker registration.
 *
 * Registered only in production (the recommended, honest context for a PWA
 * service worker). Development is intentionally left unregistered so the SW
 * never interferes with hot-reloading during development.
 *
 * The worker lives at /sw.js (served from `public/`) so its scope is the
 * origin root ("/"), which covers the whole app including /dashboard.
 */

export interface SWRegistrationResult {
  registration: ServiceWorkerRegistration | null;
  installing: ServiceWorker | null;
  waiting: ServiceWorker | null;
  active: ServiceWorker | null;
}

function isProduction(): boolean {
  return typeof process !== "undefined" && process.env.NODE_ENV === "production";
}

/** Register the Mavly service worker. Safe to call multiple times. */
export async function registerMavlySW(): Promise<SWRegistrationResult> {
  const empty: SWRegistrationResult = {
    registration: null,
    installing: null,
    waiting: null,
    active: null,
  };

  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return empty;
  }
  if (!isProduction()) {
    return empty;
  }

  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
    });

    return {
      registration,
      installing: registration.installing ?? null,
      waiting: registration.waiting ?? null,
      active: registration.active ?? null,
    };
  } catch (error) {
    // Honest degradation: the app works perfectly fine without a service worker.
    // eslint-disable-next-line no-console
    console.warn("[Mavly PWA] Service worker registration failed:", error);
    return empty;
  }
}

/**
 * Observe a registration for the "updatefound" lifecycle so the host can surface
 * an optional "new version available" UI. Returns an unsubscribe function.
 */
export function onSWUpdate(
  registration: ServiceWorkerRegistration,
  onNewWorker: (worker: ServiceWorker) => void
): () => void {
  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;
    const onStateChange = () => {
      if (installing.state === "installed") {
        onNewWorker(installing);
      }
    };
    installing.addEventListener("statechange", onStateChange);
    return () => installing.removeEventListener("statechange", onStateChange);
  });
  return () => registration.removeEventListener("updatefound", () => {});
}
