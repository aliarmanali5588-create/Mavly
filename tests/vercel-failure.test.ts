import { test } from "node:test";
import assert from "node:assert/strict";

import { publicDeploymentFailure } from "../src/lib/deployments/vercel-failure";

test("401 and 403 map to distinct actionable failures without leaking upstream text", () => {
  const unauthorized = publicDeploymentFailure({
    status: 401,
    code: "forbidden",
    message: "Invalid token: super-secret-token",
  });
  assert.equal(unauthorized.status, 503);
  assert.equal(unauthorized.code, "BACKEND_NOT_CONFIGURED");
  assert.match(unauthorized.error, /VERCEL_API_TOKEN/);
  assert.equal(unauthorized.error.includes("super-secret-token"), false);

  const forbidden = publicDeploymentFailure({
    status: 403,
    code: "forbidden",
    message: "You do not have access to team_internal",
  });
  assert.equal(forbidden.status, 503);
  assert.equal(forbidden.code, "BACKEND_NOT_CONFIGURED");
  assert.match(forbidden.error, /VERCEL_TEAM_ID/);
  assert.equal(forbidden.error.includes("team_internal"), false);
});

test("rate limits preserve Retry-After and are not reported as configuration failures", () => {
  const limited = publicDeploymentFailure({
    status: 429,
    code: "rate_limited",
    message: "Too many requests",
    retryAfterSeconds: 12,
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.code, "RATE_LIMITED");
  assert.equal(limited.retryAfterSeconds, 12);
});

test("transport failures are reported as an upstream timeout", () => {
  const timeout = publicDeploymentFailure({
    status: 0,
    code: "network_error",
    message: "The operation was aborted due to timeout",
  });
  assert.equal(timeout.status, 504);
  assert.equal(timeout.code, "UNKNOWN");
});

test("actionable validation failures keep the Vercel explanation", () => {
  const validation = publicDeploymentFailure({
    status: 400,
    code: "invalid_request",
    message: "The project name is already in use.",
  });
  assert.equal(validation.status, 400);
  assert.equal(validation.code, "VALIDATION");
  assert.equal(validation.error, "The project name is already in use.");
});
