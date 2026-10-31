"use client";

import React, { useEffect, useRef } from "react";

/**
 * Mavly Premium Neon Top Scroll Progress Indicator
 *
 * Fixed to the very top edge of the viewport (top: 0).
 * Displays a minimal, refined neon beam with a restrained glow that
 * synchronizes in real time with the actual page scroll position.
 *
 * Performance:
 * - Uses direct DOM transform (scaleX) on the compositor thread.
 * - Throttled with requestAnimationFrame (zero React state re-renders on scroll).
 * - Observes resize, dynamic DOM height mutations, and route changes.
 * - Completely non-interactive (pointer-events: none).
 */
export function ScrollProgressIndicator() {
  const barRef = useRef<HTMLDivElement>(null);
  const glowHeadRef = useRef<HTMLDivElement>(null);
  const rafIdRef = useRef<number | null>(null);

  useEffect(() => {
    const bar = barRef.current;
    const glowHead = glowHeadRef.current;
    if (!bar) return;

    // Detect prefers-reduced-motion
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const calculateProgress = (): number => {
      const doc = document.documentElement;
      const body = document.body;

      const scrollTop = window.scrollY || doc.scrollTop || body.scrollTop || 0;
      const scrollHeight = Math.max(
        body.scrollHeight,
        doc.scrollHeight,
        body.offsetHeight,
        doc.offsetHeight,
        body.clientHeight,
        doc.clientHeight
      );
      const clientHeight = window.innerHeight || doc.clientHeight || 0;
      const maxScroll = scrollHeight - clientHeight;

      if (maxScroll <= 0) return 0;
      const pct = (scrollTop / maxScroll) * 100;
      return Math.min(100, Math.max(0, pct));
    };

    const update = () => {
      const progress = calculateProgress();
      const scale = progress / 100;

      if (bar) {
        bar.style.transform = `scaleX(${scale})`;

        // Fade in when scrolled, fade out when at top
        if (progress > 0.4) {
          bar.style.opacity = "1";
        } else {
          bar.style.opacity = "0";
        }
      }

      if (glowHead) {
        glowHead.style.opacity = progress > 0.4 && progress < 100 ? "1" : progress >= 100 ? "0.8" : "0";
      }
    };

    const requestUpdate = () => {
      if (rafIdRef.current !== null) return;
      rafIdRef.current = window.requestAnimationFrame(() => {
        rafIdRef.current = null;
        update();
      });
    };

    // Initial measurement
    update();

    // Scroll and viewport resize listeners
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate, { passive: true });

    // Observe document height changes (e.g. accordions, async components, images loading)
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        requestUpdate();
      });
      if (document.body) resizeObserver.observe(document.body);
      if (document.documentElement) resizeObserver.observe(document.documentElement);
    }

    // Observe subtree mutations that change document height
    let mutationObserver: MutationObserver | null = null;
    if (typeof MutationObserver !== "undefined" && document.body) {
      mutationObserver = new MutationObserver(() => {
        requestUpdate();
      });
      mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    }

    return () => {
      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className="fixed top-0 left-0 right-0 h-[2.5px] z-[100] pointer-events-none overflow-visible"
    >
      {/* Neon Progress Bar */}
      <div
        ref={barRef}
        className="w-full h-full origin-left opacity-0"
        style={{
          transform: "scaleX(0)",
          background:
            "linear-gradient(90deg, #000000 0%, #1f1f1f 40%, #6b6b6b 70%, #d4d4d4 92%, #ffffff 100%)",
          boxShadow:
            "0 0 10px rgba(99, 102, 241, 0.65), 0 0 3px rgba(168, 85, 247, 0.9), 0 1px 2px rgba(0, 0, 0, 0.5)",
          transition: "opacity 0.2s ease-out",
          willChange: "transform, opacity",
        }}
      >
        {/* Active Neon Leading Edge Glow Head */}
        <div
          ref={glowHeadRef}
          className="absolute right-0 top-1/2 -translate-y-1/2 w-4 h-3 -mr-1 rounded-full pointer-events-none opacity-0"
          style={{
            background:
              "radial-gradient(circle, rgba(255,255,255,0.95) 0%, rgba(168,85,247,0.7) 40%, rgba(99,102,241,0.2) 75%, transparent 100%)",
            filter: "blur(0.5px)",
            transition: "opacity 0.2s ease-out",
          }}
        />
      </div>
    </div>
  );
}
