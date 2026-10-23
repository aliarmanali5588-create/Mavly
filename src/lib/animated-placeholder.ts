/**
 * ═══ THE ANIMATED PLACEHOLDER OF THE BUILDER'S CHATBOX ═════════════════════
 *
 * The prompt box on `/dashboard` shows what Mavly can build: a rotating set of
 * example requests, typed out and erased one after another, while the box is
 * empty. It is a PLACEHOLDER, not a value — the moment the user types, the
 * animation is out of the way and their own text is the only text on screen.
 *
 * ⚠️ EVERYTHING IN THIS FILE IS PURE. The prompts, the state machine that
 * types/erases them and the rules that decide when the animation may run are
 * plain functions and plain data, so they can be tested without a browser, a
 * timer or a React tree. The hook that drives them is
 * `src/components/builder/useAnimatedPlaceholder.ts`.
 */

/**
 * The rotating prompts.
 *
 * ⚠️ EVERY ONE STARTS WITH THE SAME PHRASE — the box is asking a question, and
 * the answers are all "build me this". They are also all DIFFERENT: a booking
 * page, a budget tracker and a flashcard app are three different products, and
 * a list of fifteen variations on "task manager" would teach the visitor
 * nothing about what the agent can do.
 */
export const ANIMATED_PROMPTS: readonly string[] = [
  "Ask Mavly to create a project management board with drag-and-drop columns and due dates.",
  "Ask Mavly to create a recipe website with search, filters and a printable ingredient list.",
  "Ask Mavly to create a personal finance dashboard with charts and a monthly budget.",
  "Ask Mavly to create a booking page for a barbershop with opening hours and staff profiles.",
  "Ask Mavly to create a wedding planner with a countdown, a guest list and a seating chart.",
  "Ask Mavly to create a landing page for a coffee subscription with a monthly plan picker.",
  "Ask Mavly to create a small blog with tags, an archive and a dark mode toggle.",
  "Ask Mavly to create a photographer portfolio with a gallery and a full-screen lightbox.",
  "Ask Mavly to create a fitness class schedule with sign-ups, a waitlist and a calendar.",
  "Ask Mavly to create a real-estate listings site with a map and saved-search alerts.",
  "Ask Mavly to create an online store for handmade candles with a cart and a checkout.",
  "Ask Mavly to create a flashcard app with spaced repetition and progress statistics.",
  "Ask Mavly to create a support ticket desk with priority queues and an SLA countdown.",
  "Ask Mavly to create a travel itinerary planner with a day-by-day timeline and a map.",
  "Ask Mavly to create a podcast directory with audio players, show notes and episode lists.",
  "Ask Mavly to create an event ticketing page with QR code check-in and a guest list.",
];

/** The phrase every prompt starts with. */
export const ANIMATED_PROMPT_PREFIX = "Ask Mavly to create";

/** How long one typed character takes. */
export const TYPE_TICK_MS = 55;
/** How long one erased character takes — erasing reads faster than typing. */
export const ERASE_TICK_MS = 26;
/** How long a finished prompt stays on screen before it is erased. */
export const HOLD_TICKS = 26;

export type TypewriterPhase = "typing" | "holding" | "erasing";

export type TypewriterState = {
  /** Which prompt is on screen. */
  promptIndex: number;
  /** How many characters of it are visible. */
  length: number;
  phase: TypewriterPhase;
  /** Ticks left before the erasing starts. */
  holdTicks: number;
};

/** The state the animation starts in: the first prompt, nothing typed yet. */
export const TYPEWRITER_INITIAL_STATE: TypewriterState = {
  promptIndex: 0,
  length: 0,
  phase: "typing",
  holdTicks: 0,
};

/** The prompt the given state is on. */
export function currentPrompt(state: TypewriterState): string {
  return ANIMATED_PROMPTS[state.promptIndex] ?? "";
}

/** The text that is on screen right now. */
export function typewriterText(state: TypewriterState): string {
  return currentPrompt(state).slice(0, state.length);
}

/** How long to wait before the next step. */
export function typewriterDelayMs(state: TypewriterState): number {
  return state.phase === "erasing" ? ERASE_TICK_MS : TYPE_TICK_MS;
}

/**
 * One step of the animation.
 *
 * Typing adds a character, a finished prompt is held for a moment, erasing takes
 * it back and the next prompt starts. The order never breaks: a prompt is
 * always typed completely before it is erased.
 */
export function advanceTypewriter(state: TypewriterState): TypewriterState {
  const prompt = currentPrompt(state);

  // A prompt that is empty (or the index ran off the list) would never finish
  // typing — skip it instead of stalling.
  if (!prompt) {
    return {
      promptIndex: (state.promptIndex + 1) % ANIMATED_PROMPTS.length,
      length: 0,
      phase: "typing",
      holdTicks: 0,
    };
  }

  if (state.phase === "typing") {
    if (state.length < prompt.length) {
      return { ...state, length: state.length + 1 };
    }
    return { ...state, phase: "holding", holdTicks: HOLD_TICKS };
  }

  if (state.phase === "holding") {
    if (state.holdTicks > 1) {
      return { ...state, holdTicks: state.holdTicks - 1 };
    }
    return { ...state, phase: "erasing" };
  }

  // erasing
  if (state.length > 0) {
    return { ...state, length: state.length - 1 };
  }
  return {
    promptIndex: (state.promptIndex + 1) % ANIMATED_PROMPTS.length,
    length: 0,
    phase: "typing",
    holdTicks: 0,
  };
}

/**
 * May the animation run right now?
 *
 * ⚠️ NOT WHILE THE USER IS TYPING, AND NOT WHILE THE BOX IS FOCUSED. The
 * animation is decoration for an empty box; the moment there is a real caret
 * in there, the decoration would be a second cursor and a text that fights the
 * user's own. Focusing an empty box hands the hint back to the browser's own
 * placeholder instead.
 */
export function shouldAnimatePlaceholder(
  text: string,
  focused: boolean,
): boolean {
  if (focused) return false;
  return text.trim().length === 0;
}

/**
 * Does this key press submit the prompt?
 *
 * Enter submits; Shift+Enter is a newline (the box is a textarea, so it can
 * hold more than one line).
 */
export function shouldSubmitPrompt(key: string, shiftKey: boolean): boolean {
  return key === "Enter" && !shiftKey;
}
