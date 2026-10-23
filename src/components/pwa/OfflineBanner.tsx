"use client";

import { useCallback, useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

/**
 * Honest offline indicator.
 *
 * Shows a non-intrusive banner only while `navigator.onLine` is false, and
 * removes itself automatically when connectivity returns. It never promises
 * that AI generation, payments or sign-in work offline — it only reports the
 * connectivity state so the user understands why those actions can't proceed.
 *
 * Respects prefers-reduced-motion (no sliding animation).
 */

export function OfflineBanner() {
  // `navigator` is unavailable during server-side render; default to online
  // until the client hydrates and the real connectivity state is read.
  const [offline, setOffline] = useState(
    typeof navigator !== "undefined" && !navigator.onLine
  );

  const handleOnline = useCallback(() => setOffline(false), []);
  const handleOffline = useCallback(() => setOffline(true), []);

  useEffect(() => {
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [handleOnline, handleOffline]);

  if (!offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="fixed top-0 left-0 right-0 z-[50000] flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-amber-900 bg-amber-100 border-b border-amber-200 shadow-sm"
    >
      <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
      <span>You're offline — cached assets remain available; signing in, AI generation and publishing need a connection.</span>
    </div>
  );
}
