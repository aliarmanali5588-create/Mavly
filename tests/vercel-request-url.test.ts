import { test } from "node:test";
import assert from "node:assert/strict";

import { vercelRequestUrl } from "../src/lib/vercel/request-url";

/**
 * Every Vercel path a publish can call, in execution order.
 */
const PUBLISH_PATHS = [
  "/v9/projects/prj_saved",
  "/v11/projects",
  "/v10/projects/prj_saved/domains",
  "/v9/projects/prj_saved/domains/example.mavly.xyz",
  "/v9/projects/prj_saved/domains/example.mavly.xyz/verify",
  "/v2/files",
  "/v13/deployments?forceNew=1",
  "/v13/deployments/dpl_saved",
];

test("personal-account mode omits teamId from every publish request", () => {
  for (const path of PUBLISH_PATHS) {
    const url = vercelRequestUrl(path, null);
    assert.equal(url.searchParams.has("teamId"), false, path);
  }
});

test("team mode sends the configured teamId on every publish request", () => {
  for (const path of PUBLISH_PATHS) {
    const url = vercelRequestUrl(path, "team_123");
    assert.equal(url.searchParams.get("teamId"), "team_123", path);
  }
});

test("existing query parameters are preserved alongside teamId", () => {
  const url = vercelRequestUrl("/v13/deployments?forceNew=1", "team_123");
  assert.equal(url.searchParams.get("forceNew"), "1");
  assert.equal(url.searchParams.get("teamId"), "team_123");
});
