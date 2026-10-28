import { test } from "node:test";
import assert from "node:assert/strict";

import {
  importWatchVerdict,
  IMPORT_IDLE_POLLS_BEFORE_READINESS,
} from "../src/lib/import-watch";

test("an observed import lock must clear before the watch completes", () => {
  assert.equal(
    importWatchVerdict({
      importInProgress: true,
      importWasObserved: true,
      idlePolls: IMPORT_IDLE_POLLS_BEFORE_READINESS,
      previewReady: true,
    }),
    "wait",
  );
  assert.equal(
    importWatchVerdict({
      importInProgress: false,
      importWasObserved: true,
      idlePolls: 1,
      previewReady: false,
    }),
    "completed",
  );
});

test("without an import lock, only a ready preview ends the watch", () => {
  assert.equal(
    importWatchVerdict({
      importInProgress: false,
      importWasObserved: false,
      idlePolls: IMPORT_IDLE_POLLS_BEFORE_READINESS - 1,
      previewReady: true,
    }),
    "wait",
  );
  assert.equal(
    importWatchVerdict({
      importInProgress: false,
      importWasObserved: false,
      idlePolls: IMPORT_IDLE_POLLS_BEFORE_READINESS,
      previewReady: true,
    }),
    "preview-ready",
  );
  assert.equal(
    importWatchVerdict({
      importInProgress: false,
      importWasObserved: false,
      idlePolls: 10,
      previewReady: false,
    }),
    "wait",
  );
});
