"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";

/**
 * Mavly PWA install experience.
 *
 * States rendered honestly:
 *   • install available      -> "Install Mavly" button (shown only when beforeinstallprompt fires)
 *   • prompt opened          -> native install prompt triggered after explicit user action
 *   • installed successfully -> nothing (button hidden via display-mode / appinstalled)
 *   • dismissed              -> nothing (we do not re-prompt intrusively)
 *   • manual instructions    -> iOS Share → Add to Home Screen guidance
 *   • unsupported            -> nothing
 *
 * iOS Safari does not expose beforeinstallprompt, so we show a short, accessible
 * "Add to Home Screen" instruction instead of pretending the Chromium event works.
 */

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || navigator.platform || "";
  return /iPad|iPhone|iPod/.test(ua) || (navigator as any).standalone === true;
}

function isInstalled(): boolean {
  if (typeof window === "undefined") return false;
  // Chromium/Edge: standalone display-mode. iOS: navigator.standalone.
  return (
    window.matchMedia("(display-mode: standalone)").matches === true ||
    (navigator as any).standalone === true
  );
}

interface InstallButtonProps {
  /** Accessible label for the install action. */
  label?: string;
}

export function InstallButton({ label = "Install Mavly" }: InstallButtonProps = {}) {
  const [deferredPrompt, setDeferredPrompt] = useState<Event | null>(null);
  const [installAvailable, setInstallAvailable] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);
  const promptRef = useRef<Promise<{ outcome: string }> | null>(null);

  // Already installed or on iOS (which needs manual guidance, not a button).
  useEffect(() => {
    setInstalled(isInstalled());
    setIos(isIOS());
    // Re-check installed state when focus returns (user may have installed via the OS).
    const onFocus = () => setInstalled(isInstalled());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    if (installed || ios) return;

    const onBeforeInstallPrompt = (event: Event) => {
      // Only Chromium-based browsers fire this with a usable .prompt().
      event.preventDefault();
      setDeferredPrompt(event);
      setInstallAvailable(true);
    };

    const onAppInstalled = () => {
      setInstalled(true);
      setInstallAvailable(false);
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, [installed, ios]);

  const handleInstall = useCallback(async () => {
    const prompt = deferredPrompt;
    if (!prompt || promptRef.current) return;

    // Trigger the native installation prompt only after this explicit user action.
    const promise = (prompt as any).prompt?.() ?? Promise.reject(new Error("no prompt"));
    promptRef.current = promise;

    try {
      const result = await promise;
      // result.outcome is "accepted" or "dismissed"
      if (result.outcome === "accepted") {
        setInstalled(true);
      }
      setInstallAvailable(false);
      setDeferredPrompt(null);
    } catch {
      // Prompt failed or not supported — honest degradation, show nothing.
    } finally {
      promptRef.current = null;
    }
  }, [deferredPrompt]);

  // Already installed: hide the action entirely.
  if (installed) return null;

  // iOS: manual Add to Home Screen guidance, not a Chromium-style button.
  if (ios) {
    return (
      <div className="text-xs text-muted-foreground leading-relaxed">
        To install Mavly on this device, tap <strong>Share</strong>, then{" "}
        <strong>Add to Home Screen</strong>.
      </div>
    );
  }

  // Install not available on this platform/browser: show nothing (never a dead button).
  if (!installAvailable) return null;

  return (
    <button
      type="button"
      onClick={handleInstall}
      disabled={promptRef.current !== null}
      className="inline-flex items-center gap-2 rounded-full border border-[var(--clay-line)] bg-card px-3.5 py-1.5 text-xs font-medium text-foreground shadow-[var(--clay-elev-1)] active:shadow-[var(--clay-well-1)] clay-press transition-[box-shadow] outline-none focus-visible:shadow-[var(--clay-focus)]"
      aria-label={label}
    >
      <Download className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </button>
  );
}
