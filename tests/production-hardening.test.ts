import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

import { proxy } from "../src/proxy";
import {
  paymentEventMetadata,
  type PaymentEventRow,
} from "../src/lib/integrations/payments/event-view";
import {
  PAYMENT_ORDER_LIMIT_PER_WINDOW,
  PAYMENT_RATE_WINDOW_SECONDS,
  PAYMENT_VERIFY_LIMIT_PER_WINDOW,
} from "../src/lib/integrations/rate-limit";
import {
  serializePaymentEvent,
  type PaymentEventFields,
} from "../src/lib/observability/payments";
import { isPrivateAddress, urlRejectionReason } from "../src/lib/safe-url";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const RATE_SQL = read("supabase/migrations/23_production_hardening.sql");
const INTEGRATION_SQL = read("supabase/migrations/21_business_integrations.sql");
const GATEWAY = read("src/lib/integrations/payments/gateway.ts");
const PROXY = read("src/proxy.ts");
const ADMIN_LAYOUT = read("src/app/adminsh/layout.tsx");

const req = (path: string) => new NextRequest(`http://localhost:3000${path}`);

/**
 * Phase 7 focused checks. These are static/pure assertions plus the proxy's
 * real signed-out path; they do not touch a database or a provider.
 */

// ── Durable rate limiting ───────────────────────────────────────────────────

test("migration 23 adds a durable, fixed-limit counter without touching payment state", () => {
  assert.match(RATE_SQL, /create table if not exists public\.integration_rate_limits/);
  assert.match(RATE_SQL, /primary key \(integration_id, operation, window_start\)/);
  assert.match(RATE_SQL, /consume_integration_rate_limit/);
  assert.match(
    RATE_SQL,
    /v_limit := case p_operation when 'order_create' then 30 else 60 end/,
  );
  assert.match(RATE_SQL, /v_window_seconds := 60/);
  assert.equal(/drop table/i.test(RATE_SQL), false);
  assert.equal(/truncate/i.test(RATE_SQL), false);
  // Cleanup is bounded and only touches the new counter table.
  assert.match(RATE_SQL, /delete from public\.integration_rate_limits r/);
  assert.match(RATE_SQL, /limit 50/);
  assert.equal(/delete from public\.project_integration_payments/i.test(RATE_SQL), false);
  assert.equal(/delete from public\.project_integrations/i.test(RATE_SQL), false);
  assert.match(RATE_SQL, /production_hardening_schema_version[\s\S]*?select 23;/);
});

test("migration 23 can recover a stale received webhook event without racing a live handler", () => {
  assert.match(RATE_SQL, /received_at < clock_timestamp\(\) - interval '2 minutes'/);
  assert.match(RATE_SQL, /set received_at = clock_timestamp\(\)/);
  assert.match(RATE_SQL, /return query select v_id, 'received'::text, true/);
  // The finish RPC still only accepts `received`; a processed event is terminal.
  assert.match(
    INTEGRATION_SQL,
    /and e\.status = 'received'/,
  );
});

test("the limiter is not caller-tunable and the counters are not client-readable", () => {
  // The RPC takes no limit/window argument; limits are fixed in SQL.
  assert.match(
    RATE_SQL,
    /consume_integration_rate_limit\(\s*p_key_hash text,\s*p_provider text,\s*p_rpc_hash text,\s*p_operation text\s*\)/,
  );
  assert.equal(/p_limit|p_window_seconds/.test(RATE_SQL), false);
  assert.match(RATE_SQL, /revoke all on public\.integration_rate_limits from authenticated/);
  assert.match(RATE_SQL, /revoke all on public\.integration_rate_limits from anon/);
  assert.equal(
    /grant (select|insert|update|delete)[^;]*on public\.integration_rate_limits/i.test(RATE_SQL),
    false,
  );
  assert.match(
    RATE_SQL,
    /grant execute on function public\.consume_integration_rate_limit[^;]*to anon, authenticated/,
  );
});

test("the gateway uses the durable limiter, not the per-instance counter", () => {
  assert.equal(GATEWAY.includes("consumeIntegrationRateLimit"), true);
  assert.equal(GATEWAY.includes("paymentOrderLimiter"), false);
  assert.equal(GATEWAY.includes("paymentVerifyLimiter"), false);
  // The documented constants agree with the SQL.
  assert.equal(PAYMENT_ORDER_LIMIT_PER_WINDOW, 30);
  assert.equal(PAYMENT_VERIFY_LIMIT_PER_WINDOW, 60);
  assert.equal(PAYMENT_RATE_WINDOW_SECONDS, 60);
});

test("revoked project API keys are excluded by both gateway RPC families", () => {
  assert.match(INTEGRATION_SQL, /k\.revoked_at is null/);
  assert.match(RATE_SQL, /k\.revoked_at is null/);
});

// ── SSRF / address validation ───────────────────────────────────────────────

test("outbound URL validation refuses loopback, private, metadata and credential shapes", () => {
  for (const url of [
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://169.254.169.254/",
    "http://[::ffff:169.254.169.254]/",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://localhost/",
    "http://foo.internal/",
    "file:///etc/passwd",
    "https://user:pass@example.com/",
  ]) {
    assert.notEqual(urlRejectionReason(url), null, url);
  }
  assert.equal(urlRejectionReason("https://example.com/assets/logo.png"), null);
});

test("private address classification covers IPv4-mapped and unique-local IPv6", () => {
  for (const address of [
    "10.1.2.3",
    "172.16.0.1",
    "192.168.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

// ── Webhook event visibility ────────────────────────────────────────────────

test("the owner event projection omits evidence material and unknown statuses fail closed", () => {
  const view = paymentEventMetadata({
    provider_event_id: "evt_123",
    event_type: "payment.captured",
    status: "processed",
    error_code: null,
    received_at: "2026-10-27T00:00:00.000Z",
    processed_at: "2026-10-27T00:00:01.000Z",
    // Extra fields a careless query might return must not survive the projection.
    payload_sha256: "a".repeat(64),
    value_ciphertext: "v1.secret",
  } as unknown as PaymentEventRow);

  assert.deepEqual(view, {
    eventId: "evt_123",
    eventType: "payment.captured",
    status: "processed",
    errorCode: null,
    receivedAt: "2026-10-27T00:00:00.000Z",
    processedAt: "2026-10-27T00:00:01.000Z",
  });
  assert.equal("payload_sha256" in view, false);
  assert.equal("value_ciphertext" in view, false);

  const unknown = paymentEventMetadata({
    provider_event_id: "evt_123",
    event_type: "payment.captured",
    status: "something_new",
    error_code: null,
    received_at: "2026-10-27T00:00:00.000Z",
    processed_at: null,
  });
  assert.equal(unknown.status, "failed");
});

// ── Structured payment diagnostics ──────────────────────────────────────────

const INTEGRATION_ID = "11111111-1111-4111-8111-111111111111";

test("payment events serialize only allowlisted, redacted fields", () => {
  const line = serializePaymentEvent("payment.order_created", {
    integrationId: INTEGRATION_ID,
    projectId: "my-app",
    operation: "order_create",
    status: "created",
    httpStatus: 200,
    durationMs: 12,
    keySecret: "sk_live_should_never_appear",
    rawBody: "{\"event\":\"payment.captured\"}",
  } as unknown as PaymentEventFields);
  const parsed = JSON.parse(line);
  assert.equal(parsed.event, "payment.order_created");
  assert.equal(parsed.integrationId, INTEGRATION_ID);
  assert.equal(parsed.projectId, "my-app");
  assert.equal(parsed.operation, "order_create");
  assert.equal(parsed.status, "created");
  assert.equal(parsed.httpStatus, 200);
  assert.equal("keySecret" in parsed, false);
  assert.equal("rawBody" in parsed, false);
  assert.equal(line.includes("sk_live_should_never_appear"), false);

  const bad = JSON.parse(
    serializePaymentEvent("payment.webhook_failed", {
      errorClass: "not a class with spaces",
      status: "a status that is not allowlisted",
      eventType: "payment.captured",
      eventStatus: "failed",
    }),
  );
  assert.equal("errorClass" in bad, false);
  assert.equal("status" in bad, false);
  assert.equal(bad.eventType, "payment.captured");
  assert.equal(bad.eventStatus, "failed");
});

test("payment diagnostics never include an amount or provider order id", () => {
  const line = serializePaymentEvent("payment.verify_succeeded", {
    integrationId: INTEGRATION_ID,
    projectId: "my-app",
    operation: "payment_verify",
    status: "paid",
    httpStatus: 200,
  });
  const parsed = JSON.parse(line);
  assert.equal("amount" in parsed, false);
  assert.equal("amountMinor" in parsed, false);
  assert.equal("orderId" in parsed, false);
  assert.equal("paymentId" in parsed, false);
});

// ── Admin surface ───────────────────────────────────────────────────────────

test("the admin console requires a session at the proxy", async () => {
  const res = await proxy(req("/adminsh/dashboard"));
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location") ?? "", /\/adminsh\/auth/);
});

test("the admin console has a database-backed allowlist gate", () => {
  assert.match(PROXY, /pathname === "\/adminsh"/);
  assert.match(ADMIN_LAYOUT, /getCurrentUser/);
  assert.match(ADMIN_LAYOUT, /current_user_is_admin/);
  assert.match(ADMIN_LAYOUT, /data !== true/);
  assert.match(ADMIN_LAYOUT, /notFound\(\)/);
  assert.match(ADMIN_LAYOUT, /loginUrlFor/);
});
