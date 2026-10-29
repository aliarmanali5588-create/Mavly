"use client";

import { useEffect, useState } from "react";
import {
  advanceTypewriter,
  ANIMATED_PROMPTS,
  TYPEWRITER_INITIAL_STATE,
  typewriterDelayMs,
  typewriterText,
  type TypewriterState,
} from "@/lib/animated-placeholder";

type UseAnimatedPlaceholderOptions = {
  active: boolean;
  prompts?: readonly string[];
};

/**
 * The hook that drives the animated placeholder.
 *
 * ⚠️ THE ANIMATION ONLY RUNS WHILE `active` IS TRUE. When it is not — for
 * example after the user types or when reduced motion is enabled — the timer
 * is torn down and the state freezes where it was. Returning to an empty box
 * resumes at the same character.
 *
 * The state machine itself lives in `src/lib/animated-placeholder.ts` and is
 * pure; this hook only turns its steps into time.
 */
export function useAnimatedPlaceholder({
  active,
  prompts = ANIMATED_PROMPTS,
}: UseAnimatedPlaceholderOptions): {
  text: string;
  state: TypewriterState;
} {
  const [state, setState] = useState<TypewriterState>(TYPEWRITER_INITIAL_STATE);

  useEffect(() => {
    if (!active) return;

    const timer = setTimeout(() => {
      setState((current) => advanceTypewriter(current, prompts));
    }, typewriterDelayMs(state));

    return () => clearTimeout(timer);
  }, [active, prompts, state]);

  return { text: typewriterText(state, prompts), state };
}
