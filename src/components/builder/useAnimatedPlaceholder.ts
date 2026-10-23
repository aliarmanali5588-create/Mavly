"use client";

import { useEffect, useState } from "react";
import {
  advanceTypewriter,
  TYPEWRITER_INITIAL_STATE,
  typewriterDelayMs,
  typewriterText,
  type TypewriterState,
} from "@/lib/animated-placeholder";

/**
 * The hook that drives the animated placeholder.
 *
 * ⚠️ THE ANIMATION ONLY RUNS WHILE `active` IS TRUE. When it is not — the user
 * typed something, or the box is focused — the timers are torn down and the
 * state FREEZES where it was. Coming back to an empty box therefore resumes
 * the same prompt at the same character, instead of starting over or
 * flickering.
 *
 * The state machine itself lives in `src/lib/animated-placeholder.ts` and is
 * pure; this hook only turns its steps into time.
 */
export function useAnimatedPlaceholder(active: boolean): {
  text: string;
  state: TypewriterState;
} {
  const [state, setState] = useState<TypewriterState>(TYPEWRITER_INITIAL_STATE);

  useEffect(() => {
    if (!active) return;

    const timer = setTimeout(() => {
      setState((current) => advanceTypewriter(current));
    }, typewriterDelayMs(state));

    return () => clearTimeout(timer);
  }, [active, state]);

  return { text: typewriterText(state), state };
}
