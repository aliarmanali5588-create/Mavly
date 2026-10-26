import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ANIMATED_PROMPTS,
  ANIMATED_PROMPT_PREFIX,
  advanceTypewriter,
  currentPrompt,
  shouldAnimatePlaceholder,
  shouldSubmitPrompt,
  TYPEWRITER_INITIAL_STATE,
  typewriterText,
  type TypewriterState,
} from "../src/lib/animated-placeholder";

/**
 * The animated placeholder of the builder's chatbox.
 *
 * The rotation is a pure state machine, so the whole thing is tested here
 * without a browser, a timer or a React tree.
 */

// ── The prompts ─────────────────────────────────────────────────────────────

test("there are fifteen to sixteen prompts", () => {
  assert.equal(ANIMATED_PROMPTS.length >= 15, true);
  assert.equal(ANIMATED_PROMPTS.length <= 16, true);
});

test("every prompt starts with the same phrase", () => {
  for (const prompt of ANIMATED_PROMPTS) {
    assert.equal(prompt.startsWith(ANIMATED_PROMPT_PREFIX), true, prompt);
  }
});

test("every prompt is a different idea", () => {
  assert.equal(new Set(ANIMATED_PROMPTS).size, ANIMATED_PROMPTS.length);
  // Not just different wording — no two prompts share their subject.
  const subjects = ANIMATED_PROMPTS.map((prompt) =>
    prompt.replace(ANIMATED_PROMPT_PREFIX, "").trim().split(/\s+/).slice(0, 3).join(" "),
  );
  assert.equal(new Set(subjects).size, subjects.length);
});

test("no prompt is empty or absurdly long", () => {
  for (const prompt of ANIMATED_PROMPTS) {
    assert.equal(prompt.trim().length > 20, true);
    assert.equal(prompt.length < 140, true);
  }
});

// ── The rotation ────────────────────────────────────────────────────────────

/** Runs the machine for a number of ticks. */
function run(state: TypewriterState, ticks: number): TypewriterState {
  let current = state;
  for (let i = 0; i < ticks; i += 1) current = advanceTypewriter(current);
  return current;
}

test("the first prompt is typed one character at a time", () => {
  const state = advanceTypewriter(TYPEWRITER_INITIAL_STATE);
  assert.equal(state.phase, "typing");
  assert.equal(state.length, 1);
  assert.equal(typewriterText(state), ANIMATED_PROMPTS[0].slice(0, 1));
});

test("a prompt is typed out completely and then held", () => {
  const first = ANIMATED_PROMPTS[0];
  const state = run(TYPEWRITER_INITIAL_STATE, first.length);
  assert.equal(state.length, first.length);
  assert.equal(typewriterText(state), first);

  // The tick after the last character holds the finished prompt.
  const held = advanceTypewriter(state);
  assert.equal(held.phase, "holding");
  assert.equal(held.length, first.length);
});

test("the held prompt is erased and the next one starts", () => {
  const first = ANIMATED_PROMPTS[0];
  let state = run(TYPEWRITER_INITIAL_STATE, first.length + 1);
  assert.equal(state.phase, "holding");

  // The hold ends and the erasing begins.
  while (state.phase !== "erasing") state = advanceTypewriter(state);
  assert.equal(state.promptIndex, 0);

  // The prompt is taken back character by character…
  while (state.length > 0) state = advanceTypewriter(state);
  assert.equal(state.length, 0);

  // …and the next prompt starts.
  const next = advanceTypewriter(state);
  assert.equal(next.promptIndex, 1);
  assert.equal(next.phase, "typing");
});

test("the rotation visits every prompt and comes back around", () => {
  const seen = new Set<number>();
  let state = TYPEWRITER_INITIAL_STATE;

  // Long enough for a full cycle of typing, holding and erasing.
  for (let i = 0; i < ANIMATED_PROMPTS.length * 400; i += 1) {
    state = advanceTypewriter(state);
    seen.add(state.promptIndex);
    if (state.promptIndex === 0 && state.length === 0 && state.phase === "typing" && i > 0) break;
  }

  assert.equal(seen.size, ANIMATED_PROMPTS.length);
  assert.equal(state.promptIndex, 0);
});

test("the visible text is always a prefix of the current prompt", () => {
  let state = TYPEWRITER_INITIAL_STATE;
  for (let i = 0; i < 500; i += 1) {
    state = advanceTypewriter(state);
    const prompt = currentPrompt(state);
    assert.equal(typewriterText(state), prompt.slice(0, state.length));
    assert.equal(state.length <= prompt.length, true);
    assert.equal(state.length >= 0, true);
  }
});

// ── When may the animation run? ─────────────────────────────────────────────

test("the animation runs while the box is empty and unfocused", () => {
  assert.equal(shouldAnimatePlaceholder("", false), true);
  assert.equal(shouldAnimatePlaceholder("   ", false), true);
});

test("the animation stops as soon as the user types", () => {
  assert.equal(shouldAnimatePlaceholder("a", false), false);
  assert.equal(shouldAnimatePlaceholder("Ask Mavly to create a blog", false), false);
});

test("the animation stops while the box is focused", () => {
  assert.equal(shouldAnimatePlaceholder("", true), false);
});

// ── The submit key ──────────────────────────────────────────────────────────

test("Enter submits and Shift+Enter does not", () => {
  assert.equal(shouldSubmitPrompt("Enter", false), true);
  assert.equal(shouldSubmitPrompt("Enter", true), false);
  assert.equal(shouldSubmitPrompt("a", false), false);
  assert.equal(shouldSubmitPrompt("Escape", false), false);
});

// ── The chatbox itself ──────────────────────────────────────────────────────

const dashboard = readFileSync(
  new URL("../src/components/builder/BuilderDashboard.tsx", import.meta.url),
  "utf8",
);

test("the chatbox still has its real controls", () => {
  assert.equal(dashboard.includes("AnimatedPlaceholder"), true);
  // The attach button, the integrations and the build button are untouched.
  assert.equal(dashboard.includes("handleFileSelect"), true);
  assert.equal(dashboard.includes("FigmaPromptButton"), true);
  assert.equal(dashboard.includes("<span>Build</span>"), true);
  assert.equal(dashboard.includes("openBuildModal"), true);
});

test("the dashboard prompt mode changes only its selected state and placeholder", () => {
  assert.equal(dashboard.includes('useState<"website" | "android">("website")'), true);
  assert.equal(dashboard.includes('aria-label="Build mode"'), true);
  assert.equal(dashboard.includes('aria-pressed={promptMode === "website"}'), true);
  assert.equal(dashboard.includes('aria-pressed={promptMode === "android"}'), true);
  assert.equal(dashboard.includes('setPromptMode("website")'), true);
  assert.equal(dashboard.includes('setPromptMode("android")'), true);
  assert.equal(dashboard.includes("Describe the website you want to build..."), true);
  assert.equal(dashboard.includes("Describe the Android app you want to build..."), true);
  const launchStart = dashboard.indexOf("const launched = await vcaasApi.projects.launch({");
  const launchEnd = dashboard.indexOf("\n      });", launchStart);
  assert.equal(launchStart >= 0 && launchEnd > launchStart, true);
  assert.doesNotMatch(dashboard.slice(launchStart, launchEnd), /promptMode/);
});

test("Enter in the chatbox goes through the submit helper", () => {
  assert.equal(dashboard.includes("shouldSubmitPrompt(e.key, e.shiftKey)"), true);
});

test("an empty prompt submits nothing", () => {
  assert.equal(
    dashboard.includes(
      "if (!firstPrompt.trim() && attachedFiles.length === 0) return;",
    ),
    true,
  );
  assert.equal(
    dashboard.includes("disabled={!firstPrompt.trim() && attachedFiles.length === 0}"),
    true,
  );
});

test("the submitted prompt travels through the launch call to the workspace", () => {
  // The established mechanism: one launch call that creates the project and
  // starts the first prompt, then the navigation to the workspace.
  assert.equal(dashboard.includes("vcaasApi.projects.launch({"), true);
  assert.equal(dashboard.includes("prompt: firstPrompt.trim()"), true);
  assert.equal(dashboard.includes("router.push(`/project/${created}`)"), true);
  assert.equal(dashboard.includes("router.push(`/project/${id2}`)"), true);
});

test("the draft that survives a sign-in redirect is kept in sessionStorage", () => {
  assert.equal(dashboard.includes('vibebuild:draftPrompt'), true);
  assert.equal(dashboard.includes("sessionStorage.setItem(DRAFT_PROMPT_KEY"), true);
  assert.equal(dashboard.includes("sessionStorage.removeItem(DRAFT_PROMPT_KEY)"), true);
});
