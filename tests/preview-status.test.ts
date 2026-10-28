import { test } from "node:test";
import assert from "node:assert/strict";

import {
  previewDocumentProblem,
  PREVIEW_ENTRY_PATH,
} from "../src/lib/preview-document";
import {
  previewIsUpdating,
  previewStateForDisplay,
  resolveGenerationState,
  resolvePreviewState,
  type PreviewRunSignal,
} from "../src/lib/preview-status";

const ENTRY = {
  path: PREVIEW_ENTRY_PATH,
  updatedAt: "2026-10-01T10:00:00.000Z",
};

function run(overrides: Partial<PreviewRunSignal> = {}): PreviewRunSignal {
  return {
    stage: "completed",
    status: "done",
    startedAt: "2026-10-01T09:00:00.000Z",
    finishedAt: "2026-10-01T09:05:00.000Z",
    errorMessage: null,
    ...overrides,
  };
}

// ── Generation state ────────────────────────────────────────────────────────

test("durable run stages map to a truthful generation state", () => {
  assert.equal(resolveGenerationState(null), "idle");
  assert.equal(resolveGenerationState(run({ stage: "queued" })), "queued");
  assert.equal(resolveGenerationState(run({ stage: "validating" })), "running");
  assert.equal(resolveGenerationState(run({ stage: "generating" })), "running");
  assert.equal(resolveGenerationState(run({ stage: "retrying" })), "recovering");
  assert.equal(resolveGenerationState(run({ stage: "retry_wait" })), "recovering");
  assert.equal(resolveGenerationState(run({ stage: "completed" })), "completed");
  assert.equal(resolveGenerationState(run({ stage: "failed" })), "failed");
  assert.equal(resolveGenerationState(run({ stage: "interrupted" })), "failed");
  assert.equal(resolveGenerationState(run({ stage: "cancelled" })), "cancelled");
});

test("older rows without a stage fall back to the coarse run status", () => {
  assert.equal(resolveGenerationState(run({ stage: null, status: "pending" })), "queued");
  assert.equal(resolveGenerationState(run({ stage: null, status: "running" })), "running");
  assert.equal(resolveGenerationState(run({ stage: null, status: "done" })), "completed");
  assert.equal(resolveGenerationState(run({ stage: null, status: "error" })), "failed");
  assert.equal(resolveGenerationState(run({ stage: null, status: "cancelled" })), "cancelled");
});

// ── Preview state ───────────────────────────────────────────────────────────

test("no preview file means no preview, never ready", () => {
  const state = resolvePreviewState({ entry: null, run: null });
  assert.equal(state.status, "none");
  assert.equal(state.stale, false);
  assert.equal(state.canResume, false);

  const display = previewStateForDisplay({ entry: null, run: null });
  assert.equal(display.showEmptyState, true);
  assert.equal(display.showStaleNotice, false);
});

test("an active generation with no saved preview is incomplete, not a blank ready frame", () => {
  const state = resolvePreviewState({
    entry: null,
    run: run({ stage: "generating", status: "running", finishedAt: null }),
  });
  assert.equal(state.status, "incomplete");
  assert.match(state.reason ?? "", /still running/i);
  assert.equal(state.canResume, false);
});

test("a failed generation with no preview is incomplete and offers resume", () => {
  const state = resolvePreviewState({
    entry: null,
    run: run({ stage: "failed", status: "error", errorMessage: "provider timeout" }),
  });
  assert.equal(state.status, "incomplete");
  assert.equal(state.canResume, true);
  assert.match(state.reason ?? "", /did not finish/i);
});

test("a cancelled generation with no preview is incomplete but not resumable", () => {
  const state = resolvePreviewState({
    entry: null,
    run: run({ stage: "cancelled", status: "cancelled" }),
  });
  assert.equal(state.status, "incomplete");
  assert.equal(state.canResume, false);
});

test("a completed generation with a saved preview is ready", () => {
  const state = resolvePreviewState({ entry: ENTRY, run: run() });
  assert.equal(state.status, "ready");
  assert.equal(state.stale, false);
  assert.equal(state.reason, null);
  assert.equal(state.entryPath, PREVIEW_ENTRY_PATH);

  const display = previewStateForDisplay({ entry: ENTRY, run: run() });
  assert.equal(display.showEmptyState, false);
  assert.equal(display.showStaleNotice, false);
});

test("a failed generation keeps the previous preview but marks it stale", () => {
  const state = resolvePreviewState({
    entry: ENTRY,
    run: run({
      stage: "failed",
      status: "error",
      startedAt: "2026-10-02T10:00:00.000Z",
      errorMessage: "GENERATION_TRUNCATED",
    }),
  });
  assert.equal(state.status, "stale");
  assert.equal(state.stale, true);
  assert.equal(state.canResume, true);
  assert.match(state.reason ?? "", /did not finish/i);

  const display = previewStateForDisplay({
    entry: ENTRY,
    run: run({ stage: "failed", status: "error", startedAt: "2026-10-02T10:00:00.000Z" }),
  });
  assert.equal(display.showStaleNotice, true);
  assert.equal(display.showEmptyState, false);
});

test("a newer active generation makes an older saved preview stale", () => {
  const state = resolvePreviewState({
    entry: ENTRY,
    run: run({
      stage: "generating",
      status: "running",
      startedAt: "2026-10-02T10:00:00.000Z",
      finishedAt: null,
    }),
  });
  assert.equal(state.status, "stale");
  assert.equal(state.stale, true);
  assert.equal(state.canResume, false);
  assert.equal(previewIsUpdating(run({ stage: "generating", status: "running" })), true);
});

test("an active generation that already saved the entry is ready", () => {
  const state = resolvePreviewState({
    entry: { path: PREVIEW_ENTRY_PATH, updatedAt: "2026-10-02T10:05:00.000Z" },
    run: run({
      stage: "generating",
      status: "running",
      startedAt: "2026-10-02T10:00:00.000Z",
      finishedAt: null,
    }),
  });
  assert.equal(state.status, "ready");
  assert.equal(state.stale, false);
});

test("a completed run does not invalidate a preview it did not need to change", () => {
  const state = resolvePreviewState({
    entry: ENTRY,
    run: run({
      stage: "completed",
      status: "done",
      startedAt: "2026-10-02T10:00:00.000Z",
    }),
  });
  assert.equal(state.status, "ready");
  assert.equal(state.stale, false);
});

test("a native project with no web preview is unavailable, not incomplete", () => {
  const state = resolvePreviewState({
    entry: null,
    unavailableReason: "Native Android projects do not have a web preview.",
    run: run({ stage: "completed" }),
  });
  assert.equal(state.status, "unavailable");
  assert.match(state.reason ?? "", /Android/i);
  assert.equal(state.canResume, false);
});

test("a failed run is described before the needs-a-build reason", () => {
  /**
   * A project with `package.json` but no `preview.html` also yields an
   * "unsupported" reason. When the latest run failed, the honest message is the
   * generation failure (and the resume action), not "your framework needs a
   * build".
   */
  const state = resolvePreviewState({
    entry: null,
    unavailableReason: "This project needs a build before it can be previewed.",
    run: run({ stage: "failed", status: "error" }),
  });
  assert.equal(state.status, "incomplete");
  assert.match(state.reason ?? "", /did not finish/i);
  assert.equal(state.canResume, true);
});

// ── Document structure ──────────────────────────────────────────────────────

test("a complete standalone preview document passes structural validation", () => {
  assert.equal(
    previewDocumentProblem(
      "<!doctype html><html><head><style>body{color:red}</style></head><body><h1>Hi</h1><script>console.log(1)</script></body></html>",
    ),
    null,
  );
  assert.equal(
    previewDocumentProblem("<html><body>Minimal</body></html>"),
    null,
  );
  // A legal leading comment must not be mistaken for a truncated document.
  assert.equal(
    previewDocumentProblem(
      "<!-- generated by Mavly -->\n<!doctype html><html><body>Hi</body></html>",
    ),
    null,
  );
});

test("truncated preview documents are rejected with a user-safe reason", () => {
  assert.match(
    previewDocumentProblem("<!doctype html><html><body><h1>Hi</h1>") ?? "",
    /cut off before <\/html>/i,
  );
  assert.match(
    previewDocumentProblem("<h1>Not a document</h1>") ?? "",
    /did not start with an HTML document/i,
  );
  // These fixtures keep </html> so the script/style check — not the
  // missing-closing-tag check — is the one under test.
  assert.match(
    previewDocumentProblem(
      "<!doctype html><html><body><script>1</body></html>",
    ) ?? "",
    /unclosed <script>/i,
  );
  assert.match(
    previewDocumentProblem(
      "<!doctype html><html><body><style>body{}</body></html>",
    ) ?? "",
    /unclosed <style>/i,
  );
  assert.match(
    previewDocumentProblem("<!doctype html><html><body><h1>Hi</h1></body></html><div") ?? "",
    /middle of a tag/i,
  );
  assert.match(previewDocumentProblem("   ") ?? "", /empty/i);
});
