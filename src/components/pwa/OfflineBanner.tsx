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
  /**
   * ⚠️ ALWAYS `false` ON THE FIRST RENDER — THE REAL ANSWER ARRIVES AFTER HYDRATION.
   *
   * `navigator` does not exist during the server render, so the previous initializer
   * returned `false` there and `true` in an offline browser: two different trees for
   * the same commit, i.e. a React #418 hydration mismatch. The connectivity state is
   * client-only, so it is read in the effect below, which already subscribes to the
   * online/offline events.
   */
  const [offline, setOffline] = useState(false);

  const handleOnline = useCallback(() => setOffline(false), []);
  const handleOffline = useCallback(() => setOffline(true), []);

  useEffect(() => {
    setOffline(!navigator.onLine);
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
      className="fixed top-0 left-0 right-0 z-[50000] flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-warning-subtle-foreground bg-warning-subtle border-b border-warning/25 shadow-[var(--clay-elev-1)]"
    >
      <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
      <span>You're offline — cached assets remain available; signing in, AI generation and publishing need a connection.</span>
    </div>
  );
}
