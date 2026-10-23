"use client";

import { useEffect } from "react";
import { registerMavlySW, onSWUpdate } from "@/lib/pwa/registerSW";

/**
 * Mounts the Mavly service worker once on initial load.
 *
 * Rendered from the root layout so it covers the whole app. Registration is
 * production-only inside `registerMavlySW`, so development is untouched.
 *
 * When a new service worker becomes waiting (an updated app version), we log
 * it. A future "new version available" UI can hook into `onUpdateFound`.
 */

interface SWRegistrationProps {
  /** Optional callback fired when an updated service worker is waiting to activate. */
  onUpdateFound?: (registration: ServiceWorkerRegistration) => void;
}

export function SWRegistration({ onUpdateFound }: SWRegistrationProps = {}) {
  useEffect(() => {
    let unsub: (() => void) | undefined;

    registerMavlySW().then(({ registration }) => {
      if (!registration) return;
      if (onUpdateFound) {
        unsub = onSWUpdate(registration, () => onUpdateFound(registration));
      }
    });

    return () => {
      unsub?.();
    };
  }, [onUpdateFound]);

  return null;
}
