import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCallbackOutcome } from "../src/lib/auth/callback";

const okExchange = async () => ({ error: null });

function input(overrides: Partial<Parameters<typeof resolveCallbackOutcome>[0]> = {}) {
  return {
    searchParams: new URLSearchParams("code=abc"),
    stateCookie: "marker",
    nextCookie: null,
    exchangeCode: okExchange,
    ...overrides,
  };
}

test("a provider error wins over everything else", async () => {
  const outcome = await resolveCallbackOutcome(
    input({ searchParams: new URLSearchParams("error=access_denied&code=abc") }),
  );
  assert.deepEqual(outcome, { ok: false, error: "oauth_failed" });
});

test("a callback without a code fails", async () => {
  const outcome = await resolveCallbackOutcome(input({ searchParams: new URLSearchParams("") }));
  assert.deepEqual(outcome, { ok: false, error: "missing_code" });
});

test("a callback from another browser or an expired flow fails", async () => {
  const outcome = await resolveCallbackOutcome(input({ stateCookie: null }));
  assert.deepEqual(outcome, { ok: false, error: "session_expired" });
});

test("a successful exchange returns the default destination", async () => {
  const outcome = await resolveCallbackOutcome(input());
  assert.deepEqual(outcome, { ok: true, redirectTo: "/dashboard" });
});

test("the destination cookie is used after validation", async () => {
  const outcome = await resolveCallbackOutcome(input({ nextCookie: "/project/my-app" }));
  assert.deepEqual(outcome, { ok: true, redirectTo: "/project/my-app" });
});

test("a hostile destination cookie cannot leave the site", async () => {
  for (const nextCookie of [
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/login",
    "/auth/callback",
  ]) {
    const outcome = await resolveCallbackOutcome(input({ nextCookie }));
    assert.deepEqual(outcome, { ok: true, redirectTo: "/dashboard" });
  }
});

test("a percent-encoded destination cookie is decoded", async () => {
  const outcome = await resolveCallbackOutcome(input({ nextCookie: "%2Fproject%2Fmy-app" }));
  assert.deepEqual(outcome, { ok: true, redirectTo: "/project/my-app" });
});

test("a failed exchange is reported, not thrown", async () => {
  const outcome = await resolveCallbackOutcome(
    input({ exchangeCode: async () => ({ error: new Error("bad code") }) }),
  );
  assert.deepEqual(outcome, { ok: false, error: "exchange_failed" });
});

test("a Supabase user_banned exchange is identified as a suspended account", async () => {
  const outcome = await resolveCallbackOutcome(
    input({ exchangeCode: async () => ({ error: { code: "user_banned" } }) }),
  );
  assert.deepEqual(outcome, { ok: false, error: "account_suspended" });
});

test("a Supabase user_banned callback error is identified without an exchange", async () => {
  const outcome = await resolveCallbackOutcome(
    input({
      searchParams: new URLSearchParams("error=access_denied&error_code=user_banned"),
    }),
  );
  assert.deepEqual(outcome, { ok: false, error: "account_suspended" });
});

test("an exchange that returns nothing is reported", async () => {
  const outcome = await resolveCallbackOutcome(
    input({ exchangeCode: async () => null }),
  );
  assert.deepEqual(outcome, { ok: false, error: "exchange_failed" });
});

test("an exchange that throws is reported as a failure, not a crash", async () => {
  const outcome = await resolveCallbackOutcome(
    input({
      exchangeCode: async () => {
        throw new Error("network down");
      },
    }),
  );
  assert.deepEqual(outcome, { ok: false, error: "exchange_failed" });
});
