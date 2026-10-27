import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allowedAppOrigins,
  crossOriginMutationReason,
  isAllowedAppOrigin,
} from "../src/lib/api-origin";

/**
 * ═══ NO ORIGIN TRUST IS DERIVED FROM THE REQUEST HOST ═══════════════════════
 *
 * These tests pin the policy that replaced `origin === "https://" + Host`:
 * an explicit allowlist, plus a browser-signal fallback that a tenant page
 * cannot produce (`same-site` is not `same-origin`).
 */

const ENV = {
  NEXT_PUBLIC_APP_URL: "https://mavly.xyz",
} as unknown as NodeJS.ProcessEnv;

test("the configured app origin and its www sibling are allowed", () => {
  assert.deepEqual(allowedAppOrigins(ENV).sort(), [
    "https://mavly.xyz",
    "https://www.mavly.xyz",
  ]);
  assert.equal(isAllowedAppOrigin("https://mavly.xyz", ENV), true);
  assert.equal(isAllowedAppOrigin("https://www.mavly.xyz", ENV), true);
  assert.equal(isAllowedAppOrigin("https://mavly.xyz/", ENV), true);
});

test("a tenant host is never an allowed app origin", () => {
  assert.equal(isAllowedAppOrigin("https://meri-ek-car-ki.mavly.xyz", ENV), false);
  assert.equal(isAllowedAppOrigin("https://api.mavly.xyz", ENV), false);
  assert.equal(isAllowedAppOrigin("http://mavly.xyz", ENV), false);
  assert.equal(isAllowedAppOrigin("https://mavly.xyz.evil.com", ENV), false);
});

test("extra origins are opt-in configuration, never inferred", () => {
  const env = {
    NEXT_PUBLIC_APP_URL: "https://mavly.xyz",
    MAVLY_ALLOWED_ORIGINS: "http://localhost:3001, not a url",
  } as unknown as NodeJS.ProcessEnv;
  assert.equal(isAllowedAppOrigin("http://localhost:3001", env), true);
  assert.equal(isAllowedAppOrigin("http://localhost:3002", env), false);
});

test("safe methods and development are never blocked", () => {
  const base = { origin: "https://evil.example", secFetchSite: "cross-site" };
  assert.equal(
    crossOriginMutationReason({ ...base, method: "GET", isProduction: true }, ENV),
    null,
  );
  assert.equal(
    crossOriginMutationReason({ ...base, method: "POST", isProduction: false }, ENV),
    null,
  );
});

test("an allowlisted origin may mutate", () => {
  assert.equal(
    crossOriginMutationReason(
      {
        method: "POST",
        origin: "https://mavly.xyz",
        secFetchSite: "same-origin",
        isProduction: true,
      },
      ENV,
    ),
    null,
  );
  assert.equal(
    crossOriginMutationReason(
      {
        method: "DELETE",
        origin: "https://www.mavly.xyz",
        secFetchSite: "same-site",
        isProduction: true,
      },
      ENV,
    ),
    null,
  );
});

test("a published tenant page cannot mutate the app with the visitor's session", () => {
  assert.equal(
    crossOriginMutationReason(
      {
        method: "POST",
        origin: "https://meri-ek-car-ki.mavly.xyz",
        secFetchSite: "same-site",
        isProduction: true,
      },
      ENV,
    ),
    "origin_not_allowed",
  );
});

test("a foreign cross-site mutation is refused", () => {
  assert.equal(
    crossOriginMutationReason(
      {
        method: "PATCH",
        origin: "https://evil.example",
        secFetchSite: "cross-site",
        isProduction: true,
      },
      ENV,
    ),
    "origin_not_allowed",
  );
  assert.equal(
    crossOriginMutationReason(
      {
        method: "POST",
        origin: null,
        secFetchSite: "cross-site",
        isProduction: true,
      },
      ENV,
    ),
    "cross_site_request",
  );
});

test("same-origin browser requests work even when the allowlist is missing", () => {
  const empty = {} as unknown as NodeJS.ProcessEnv;
  assert.deepEqual(allowedAppOrigins(empty), []);
  assert.equal(
    crossOriginMutationReason(
      {
        method: "POST",
        origin: "https://mavly.xyz",
        secFetchSite: "same-origin",
        isProduction: true,
      },
      empty,
    ),
    null,
  );
  // A tenant is same-site, not same-origin, so it is still refused.
  assert.equal(
    crossOriginMutationReason(
      {
        method: "POST",
        origin: "https://meri-ek-car-ki.mavly.xyz",
        secFetchSite: "same-site",
        isProduction: true,
      },
      empty,
    ),
    "origin_not_allowed",
  );
});

test("a same-origin request is never blocked by a stale or mismatched allowlist", () => {
  /**
   * The production regression: `NEXT_PUBLIC_APP_URL` named another origin (or
   * only `MAVLY_ALLOWED_ORIGINS` was set), so `https://mavly.xyz` was not in the
   * allowlist and every dashboard POST — including projects/launch — was
   * answered 403 even though the browser proved it was same-origin.
   */
  const mismatchedAppUrl = {
    NEXT_PUBLIC_APP_URL: "https://staging.mavly.example",
  } as unknown as NodeJS.ProcessEnv;
  const onlyExtraOrigins = {
    MAVLY_ALLOWED_ORIGINS: "https://ops.mavly.example",
  } as unknown as NodeJS.ProcessEnv;
  const wrongProtocol = {
    NEXT_PUBLIC_APP_URL: "http://mavly.xyz",
  } as unknown as NodeJS.ProcessEnv;

  for (const env of [mismatchedAppUrl, onlyExtraOrigins, wrongProtocol]) {
    assert.equal(
      crossOriginMutationReason(
        {
          method: "POST",
          origin: "https://mavly.xyz",
          secFetchSite: "same-origin",
          isProduction: true,
        },
        env,
      ),
      null,
    );
  }

  // A tenant is still same-site, so a mismatched allowlist keeps it refused.
  assert.equal(
    crossOriginMutationReason(
      {
        method: "POST",
        origin: "https://meri-ek-car-ki.mavly.xyz",
        secFetchSite: "same-site",
        isProduction: true,
      },
      mismatchedAppUrl,
    ),
    "origin_not_allowed",
  );

  // So is a genuine third-party cross-site caller.
  assert.equal(
    crossOriginMutationReason(
      {
        method: "POST",
        origin: "https://evil.example",
        secFetchSite: "cross-site",
        isProduction: true,
      },
      mismatchedAppUrl,
    ),
    "origin_not_allowed",
  );
});

test("a server-to-server client with no browser signals is allowed", () => {
  assert.equal(
    crossOriginMutationReason(
      { method: "POST", origin: null, secFetchSite: null, isProduction: true },
      ENV,
    ),
    null,
  );
});
