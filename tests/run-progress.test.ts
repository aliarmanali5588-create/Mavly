import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  generationStepStatuses,
  projectGenerationProgressStage,
  sanitizeRunProgress,
} from "../src/lib/run-progress";
import { resolveStaticPreview } from "../src/lib/static-site";

test("durable generation lifecycle maps to confirmed user-facing stages", () => {
  assert.deepEqual(projectGenerationProgressStage("queued", false, false, false), {
    stage: "queued",
    retrying: false,
  });
  assert.deepEqual(projectGenerationProgressStage("validating", false, false, false), {
    stage: "planning",
    retrying: false,
  });
  assert.deepEqual(projectGenerationProgressStage("generating", true, false, false), {
    stage: "writing-files",
    retrying: false,
  });
  assert.deepEqual(projectGenerationProgressStage("validating", true, false, false), {
    stage: "validating-output",
    retrying: false,
  });
  assert.deepEqual(projectGenerationProgressStage("generating", true, true, true), {
    stage: "preparing-preview",
    retrying: false,
  });
  assert.deepEqual(projectGenerationProgressStage("validating", true, true, true), {
    stage: "preparing-preview",
    retrying: false,
  });

  assert.deepEqual(generationStepStatuses("queued"), [
    "active",
    "pending",
    "pending",
    "pending",
    "pending",
  ]);
  assert.deepEqual(generationStepStatuses("planning"), [
    "completed",
    "active",
    "pending",
    "pending",
    "pending",
  ]);
  assert.deepEqual(generationStepStatuses("writing-files"), [
    "completed",
    "completed",
    "active",
    "pending",
    "pending",
  ]);
  assert.deepEqual(generationStepStatuses("validating-output"), [
    "completed",
    "completed",
    "completed",
    "active",
    "pending",
  ]);
});

test("preview preparation is not reported until checkpoints and static preview are confirmed", () => {
  assert.equal(
    projectGenerationProgressStage("generating", true, true, false).stage,
    "writing-files",
  );
  assert.equal(
    projectGenerationProgressStage("generating", true, false, true).stage,
    "writing-files",
  );
  assert.deepEqual(generationStepStatuses("preparing-preview", true), [
    "completed",
    "completed",
    "completed",
    "completed",
    "active",
  ]);

  const resolution = resolveStaticPreview([
    { path: "preview.html", content: "<!doctype html><title>Ready</title>" },
  ]);
  assert.equal(resolution.site !== null, true);
  assert.equal(
    projectGenerationProgressStage(
      "generating",
      true,
      true,
      resolution.site !== null,
    ).stage,
    "preparing-preview",
  );
});

test("the preview stage completes only after a successful run and preview verification", () => {
  assert.deepEqual(generationStepStatuses("done", false), [
    "completed",
    "completed",
    "completed",
    "completed",
    "pending",
  ]);
  assert.deepEqual(generationStepStatuses("done", true), [
    "completed",
    "completed",
    "completed",
    "completed",
    "completed",
  ]);
});

test("repeated and delayed progress snapshots do not invent intermediate percentages", () => {
  const repeated = projectGenerationProgressStage("generating", true, false, false);
  assert.deepEqual(
    projectGenerationProgressStage("generating", true, false, false),
    repeated,
  );
  assert.equal("percent" in repeated, false);

  const afterDelayedPoll = projectGenerationProgressStage("generating", true, true, true);
  assert.equal(afterDelayedPoll.stage, "preparing-preview");
  assert.deepEqual(generationStepStatuses(null), [
    "pending",
    "pending",
    "pending",
    "pending",
    "pending",
  ]);
});

test("retry, failure, interruption, cancellation, and completion remain terminally distinct", () => {
  assert.deepEqual(projectGenerationProgressStage("retrying", true, false, false), {
    stage: "writing-files",
    retrying: true,
  });
  assert.equal(projectGenerationProgressStage("failed", true, false, false).stage, "failed");
  assert.equal(projectGenerationProgressStage("interrupted", true, false, false).stage, "failed");
  assert.equal(projectGenerationProgressStage("cancelled", true, false, false).stage, "cancelled");
  assert.equal(projectGenerationProgressStage("completed", true, true, true).stage, "done");
  assert.deepEqual(generationStepStatuses("failed", false), [
    "pending",
    "pending",
    "pending",
    "pending",
    "pending",
  ]);
  assert.deepEqual(generationStepStatuses("cancelled", false), [
    "pending",
    "pending",
    "pending",
    "pending",
    "pending",
  ]);
});

test("progress sanitization remains compatible with responses predating preview readiness", () => {
  const progress = sanitizeRunProgress({
    runId: "d2719f9b-b17a-4c9d-9f50-10f1f26a0149",
    stage: "writing-files",
    startedAt: "2026-10-25T00:00:00.000Z",
    turns: 1,
    steps: [],
    totalSteps: 0,
    files: [],
  });

  assert.equal(progress?.stage, "writing-files");
  assert.equal(progress?.retrying, false);
  assert.equal(progress?.previewReady, false);
});

test("progress visuals stay indeterminate, accessible, and reduced-motion aware", () => {
  const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  const loader = readFileSync(
    new URL("../src/components/workspace/BuildingLoader.tsx", import.meta.url),
    "utf8",
  );
  const visuals = readFileSync(
    new URL("../src/components/workspace/GenerationProgressVisuals.tsx", import.meta.url),
    "utf8",
  );
  const activity = readFileSync(
    new URL("../src/components/workspace/RunActivity.tsx", import.meta.url),
    "utf8",
  );
  const runProgress = readFileSync(
    new URL("../src/components/workspace/RunProgress.tsx", import.meta.url),
    "utf8",
  );

  assert.equal(css.includes("@media (prefers-reduced-motion: no-preference)"), true);
  assert.equal(css.includes(".run-progress-indeterminate"), true);
  assert.equal(loader.includes('role="progressbar"'), true);
  assert.equal(loader.includes('aria-live="polite"'), true);
  assert.equal(activity.includes('aria-busy={!!live}'), true);
  assert.equal(activity.includes('aria-live="polite"'), true);
  assert.equal(visuals.includes('aria-current={current ? "step" : undefined}'), true);
  assert.equal(visuals.includes('className="sr-only"'), true);
  assert.equal(visuals.includes("motion-reduce:transition-none"), true);
  assert.equal(loader.includes("aria-valuenow"), false);
  assert.equal(visuals.includes("aria-valuenow"), false);
  assert.equal(runProgress.includes("aria-valuenow"), false);
});
