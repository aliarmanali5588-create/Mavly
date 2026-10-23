"use client";

import { useAnimatedPlaceholder } from "./useAnimatedPlaceholder";

/**
 * ═══ THE ANIMATED PLACEHOLDER LAYER ════════════════════════════════════════
 *
 * A layer of text that sits exactly where the textarea's own placeholder would
 * be, and types an example prompt in and out while the box is empty.
 *
 * ⚠️ IT IS DRAWN OVER THE TEXTAREA, NOT INSIDE IT. The textarea keeps the
 * user's own value and the browser's own placeholder; this layer only exists
 * while the box is empty and unfocused, so the two can never show the same
 * thing at the same time.
 *
 * ⚠️ IT COVERS THE STATIC PLACEHOLDER WHILE IT IS THERE. The layer has the
 * card's white background, so the browser's placeholder text is hidden under it
 * instead of showing through — no doubled text, no two carets.
 *
 * The layout, the colours and the type size are the textarea's own: the layer
 * copies the padding, the font size and the colour of the placeholder, so the
 * box looks exactly as it did before the animation existed.
 */
export function AnimatedPlaceholder({ active }: { active: boolean }) {
  const { text } = useAnimatedPlaceholder(active);

  if (!active) return null;

  return (
    <div
      aria-hidden="true"
      className="absolute inset-x-0 top-0 min-h-[90px] sm:min-h-[110px] bg-white px-5 pt-5 text-[15px] leading-normal text-gray-400 pointer-events-none select-none"
    >
      <span>{text}</span>
      {/* The typing cursor — the same caret the user's own text would have. */}
      <span className="inline-block w-[2px] h-[1.05em] translate-y-[0.15em] ml-px bg-gray-400 align-baseline animate-pulse" />
    </div>
  );
}
