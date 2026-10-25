import { test } from "node:test";
import assert from "node:assert/strict";

import { hashFileContent, verifyCheckpointBatches } from "../src/lib/mavly/checkpoints";
import type { RunBatchRow } from "../src/lib/mavly/store";

function batch(
  batchIndex: number,
  files: Record<string, string>,
): RunBatchRow {
  const pathHashes = Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, hashFileContent(content)]),
  );
  return {
    batch_index: batchIndex,
    paths: Object.keys(files),
    path_hashes: pathHashes,
    source_hash: "source",
    bytes: 0,
    status: "done",
  };
}

test("checkpoints only count paths whose content still matches", () => {
  const verified = verifyCheckpointBatches(
    [batch(0, { "a.ts": "alpha", "b.ts": "beta" })],
    [
      { path: "a.ts", content: "alpha" },
      { path: "b.ts", content: "changed" },
    ],
  );

  assert.deepEqual(verified.completedPaths, ["a.ts"]);
  assert.deepEqual(verified.mismatchedPaths, ["b.ts"]);
  assert.equal(verified.nextBatchIndex, 1);
});

test("a missing checkpoint file is treated as mismatched", () => {
  const verified = verifyCheckpointBatches(
    [batch(0, { "a.ts": "alpha" })],
    [],
  );

  assert.deepEqual(verified.completedPaths, []);
  assert.deepEqual(verified.mismatchedPaths, ["a.ts"]);
});

test("the next batch index continues after the highest checkpoint", () => {
  const verified = verifyCheckpointBatches(
    [batch(2, { "c.ts": "gamma" }), batch(1, { "b.ts": "beta" })],
    [
      { path: "b.ts", content: "beta" },
      { path: "c.ts", content: "gamma" },
    ],
  );

  assert.deepEqual(verified.completedPaths, ["b.ts", "c.ts"]);
  assert.equal(verified.nextBatchIndex, 3);
});

test("a failed checkpoint is not reused", () => {
  const failed = batch(0, { "a.ts": "alpha" });
  failed.status = "failed";

  const verified = verifyCheckpointBatches([failed], [{ path: "a.ts", content: "alpha" }]);

  assert.deepEqual(verified.completedPaths, []);
  assert.deepEqual(verified.mismatchedPaths, []);
  assert.equal(verified.nextBatchIndex, 1);
});
