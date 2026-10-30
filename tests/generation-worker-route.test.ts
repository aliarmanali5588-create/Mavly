import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { PUBLIC_API_PATHS, apiSessionDecision } from "../src/lib/api-access";

const scheduler = readFileSync(
  new URL("../workers/generation-scheduler.ts", import.meta.url),
  "utf8",
);
const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

test("the generation worker has no public HTTP invocation route", () => {
  assert.equal(existsSync(new URL("../src/app/api/generation/worker/route.ts", import.meta.url)), false);
  assert.equal(PUBLIC_API_PATHS.includes("/api/generation/worker"), false);
  assert.equal(apiSessionDecision("/api/generation/worker", false), "unauthenticated");
});

test("Cloudflare Cron invokes the existing worker directly every minute", () => {
  assert.match(wrangler, /"crons":\s*\["\* \* \* \* \*"\]/);
  assert.match(wrangler, /"workers_dev":\s*false/);
  assert.match(scheduler, /async scheduled\(controller: ScheduledController\)/);
  assert.match(scheduler, /runGenerationWorkerOnce\(\)/);
  assert.match(scheduler, /generation\.scheduler\.heartbeat/);
  assert.match(scheduler, /generation\.scheduler\.completed/);
  assert.match(scheduler, /generation\.scheduler\.failed/);
});
