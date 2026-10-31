"use client";

import { useSyncExternalStore } from "react";
import { ANIMATED_PROMPTS } from "@/lib/animated-placeholder";
import { useAnimatedPlaceholder } from "./useAnimatedPlaceholder";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getReducedMotionSnapshot() {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function getServerReducedMotionSnapshot() {
  return false;
}

/**
 * ═══ THE ANIMATED PLACEHOLDER LAYER ════════════════════════════════════════
 *
 * A layer of text that sits exactly where the textarea's own placeholder would
 * be, and types an example prompt in and out while the box is empty.
 *
 * ⚠️ IT IS DRAWN OVER THE TEXTAREA, NOT INSIDE IT. The textarea keeps the
 * user's own value and the browser's own placeholder; this layer only exists
 * while the box is empty, so the two can never show the same thing at once.
 *
 * ⚠️ IT COVERS THE STATIC PLACEHOLDER WHILE IT IS THERE. The layer has the
 * card's white background, so the browser's placeholder text is hidden under it
 * instead of showing through. The textarea caret is hidden while this layer is
 * active, and reduced-motion users get one static suggestion instead.
 *
 * The layout, the colours and the type size are the textarea's own: the layer
 * copies the padding, the font size and the colour of the placeholder, so the
 * box looks exactly as it did before the animation existed.
 */
export function AnimatedPlaceholder({
  active,
  prompts = ANIMATED_PROMPTS,
  respectReducedMotion = false,
}: {
  active: boolean;
  prompts?: readonly string[];
  respectReducedMotion?: boolean;
}) {
  const prefersReducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionSnapshot,
    getServerReducedMotionSnapshot,
  );
  const reduceMotion = respectReducedMotion && prefersReducedMotion;
  const { text } = useAnimatedPlaceholder({
    active: active && !reduceMotion,
    prompts,
  });

  if (!active) return null;

  const visibleText = reduceMotion ? prompts[0] ?? "" : text;

  return (
    <div
      aria-hidden="true"
      className="absolute inset-x-0 top-0 min-h-[90px] sm:min-h-[110px] bg-card px-5 pt-5 text-[15px] leading-normal text-muted-foreground pointer-events-none select-none"
    >
      <span>{visibleText}</span>
      {!reduceMotion && (
        <span className="inline-block w-[2px] h-[1.05em] translate-y-[0.15em] ml-px bg-gray-400 align-baseline animate-pulse" />
      )}
    </div>
  );
}
