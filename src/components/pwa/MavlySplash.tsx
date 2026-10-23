"use client";

export interface MavlySplashProps {
  show?: boolean;
  onExited?: () => void;
}

/**
 * Disabled splash overlay — website renders immediately on first paint.
 */
export function MavlySplash(_props: MavlySplashProps) {
  return null;
}
