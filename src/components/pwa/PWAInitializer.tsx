"use client";

import { MavlySplash } from "./MavlySplash";
import { OfflineBanner } from "./OfflineBanner";
import { SWRegistration } from "./SWRegistration";

/**
 * Bootstraps Mavly's PWA concerns:
 *   1. Service-worker registration.
 *   2. Offline connectivity banner.
 * Splash screen overlay disabled so website renders instantly on first paint.
 */

export function PWAInitializer() {
  return (
    <>
      <SWRegistration />
      <MavlySplash show={false} />
      <OfflineBanner />
    </>
  );
}
