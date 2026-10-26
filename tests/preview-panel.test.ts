import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isRunOver } from "../src/lib/run-progress";

const panel = readFileSync(
  new URL("../src/components/workspace/PreviewPanel.tsx", import.meta.url),
  "utf8",
);
const loader = readFileSync(
  new URL("../src/components/workspace/BuildingLoader.tsx", import.meta.url),
  "utf8",
);
const page = readFileSync(
  new URL("../src/app/project/[projectId]/page.tsx", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("../src/app/globals.css", import.meta.url),
  "utf8",
);

test("the living canvas is limited to an initial generation with no preview URL", () => {
  assert.match(panel, /\{!previewUrl \? \(\s*loading \? <BuildingLoader/);
  assert.match(panel, /: \(\s*<div className="flex flex-col items-center justify-center text-center px-8">/);
  assert.match(page, /const showInitialGenerationLoader = isBuilding && !hasSuccessfulWebsite;/);
  assert.match(page, /const hasSuccessfulWebsite =\s*Boolean\(previewUrl\) \|\|/);
});

test("a usable real preview replaces the canvas without waiting for its animation", () => {
  assert.match(panel, /<iframe[\s\S]*?src=\{fullIframeUrl \|\| undefined\}/);
  assert.match(page, /const shownPreviewUrl = previewUrl \?\? verifiedInitialPreviewUrl;/);
  assert.match(page, /const verifiedInitialPreviewUrl = showInitialGenerationLoader && isV2 && previewReady/);
});

test("an existing website remains usable during a follow-up generation", () => {
  assert.match(page, /Boolean\(previewUrl\) \|\|/);
  assert.match(page, /const showInitialGenerationLoader = isBuilding && !hasSuccessfulWebsite;/);
  assert.match(
    page,
    /options\.preservePreviewOnUnsuccessfulRun &&\s*\(res\.data\.currentRun\?\.status !== "done" \|\| !nextPreviewUrl\)\s*\?\s*current/,
  );
});

test("terminal generation states leave the loader gate and preserve actionable labels", () => {
  assert.match(page, /const isBuilding = project\?\.agentProcessStatus === "init";/);
  assert.match(page, /"Retrying a generation step"/);
  assert.match(panel, /loading \? <BuildingLoader/);
  assert.match(panel, /"No preview yet"/);
  assert.equal(isRunOver("failed"), true);
  assert.equal(isRunOver("cancelled"), true);
  assert.equal(isRunOver("done"), true);
  assert.equal(isRunOver("writing-files"), false);
});

test("canvas entrances are finite, mount-driven, and reduced-motion aware", () => {
  assert.match(loader, /className="living-canvas" aria-hidden="true"/);
  assert.doesNotMatch(loader, /data-stage=/);
  assert.doesNotMatch(loader, /useEffect|useState|key=/);
  const motionStart = css.lastIndexOf("@media (prefers-reduced-motion: no-preference)");
  const canvasAnimation = css.indexOf(".living-browser {\n    animation:");
  const reducedMotionStart = css.lastIndexOf("@media (prefers-reduced-motion: reduce)");
  const reducedMotionBlock = css.match(
    /@media \(prefers-reduced-motion: reduce\) \{([^}]*)\}/,
  )?.[1];

  assert.equal(motionStart >= 0 && motionStart < canvasAnimation, true);
  assert.equal(canvasAnimation < reducedMotionStart, true);
  assert.ok(reducedMotionBlock);
  assert.doesNotMatch(reducedMotionBlock, /living-canvas|living-browser/);
});
