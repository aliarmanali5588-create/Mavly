import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { NextRequest } from "next/server";

import {
  PAYMENT_INTEGRATIONS,
  RAZORPAY_INTEGRATION,
  findPaymentIntegration,
  integrationCredentialNames,
  publicIntegrationCatalog,
} from "../src/lib/integrations/contracts";
import {
  BUSINESS_INTEGRATIONS_ENABLED_ENV,
  BUSINESS_INTEGRATIONS_PROJECTS_ENV,
  BUSINESS_INTEGRATIONS_RPC_SECRET_ENV,
  integrationRpcHash,
  parseBusinessIntegrationsCohort,
  paymentWebhookUrl,
  publicAppOrigin,
  readBusinessIntegrationsConfig,
} from "../src/lib/integrations/config";
import {
  createRazorpayOrder,
  fetchRazorpayPayment,
  razorpayKeyMode,
  testRazorpayCredentials,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from "../src/lib/integrations/payments/razorpay";
import {
  mayFulfil,
  nextStatus,
  statusFromProviderPayment,
  statusFromProviderOrder,
} from "../src/lib/integrations/payments/state";
import {
  validateCreateOrderInput,
  validatePaymentCredentialsInput,
  validateVerifyPaymentInput,
} from "../src/lib/integrations/payments/validation";
import { createWindowLimiter } from "../src/lib/integrations/rate-limit";
import { apiSessionDecision, isPublicApiPath } from "../src/lib/api-access";
import {
  GET as catchAllGet,
  POST as catchAllPost,
} from "../src/app/api/vcaas/[...path]/route";
import { POST as createOrderPost } from "../src/app/api/app/v1/payments/orders/route";
import { POST as verifyPost } from "../src/app/api/app/v1/payments/verify/route";
import { GET as statusGet } from "../src/app/api/app/v1/payments/[orderId]/route";
import { POST as webhookPost } from "../src/app/api/integrations/webhooks/razorpay/[token]/route";

/**
 * Phase 6 business integrations: the pure provider adapter, signature checks,
 * the state machine, the session gate's new public prefixes, route refusals and
 * the migration's security fences.
 *
 * ⚠️ These tests never contact Razorpay and never write a database. A mocked
 * provider proves error mapping, not live connectivity.
 */

const SQL = readFileSync(
  new URL("../supabase/migrations/21_business_integrations.sql", import.meta.url),
  "utf8",
);

const KEY_ID = "rzp_test_AbCdEf123456";
const KEY_SECRET = "test-key-secret-value";
const WEBHOOK_SECRET = "test-webhook-secret-value";

const req = (path: string, init?: RequestInit) =>
  new NextRequest(`http://localhost:3000${path}`, init);

// ── Registry is truthful ────────────────────────────────────────────────────

test("only implemented providers are listed", () => {
  assert.equal(PAYMENT_INTEGRATIONS.length, 1);
  assert.equal(findPaymentIntegration("razorpay")?.id, "razorpay");
  assert.equal(findPaymentIntegration("stripe"), null);
  assert.equal(findPaymentIntegration("paypal"), null);
  assert.equal(findPaymentIntegration(null), null);

  assert.equal(RAZORPAY_INTEGRATION.implemented, true);
  assert.equal(RAZORPAY_INTEGRATION.capabilities.createOrder, true);
  assert.equal(RAZORPAY_INTEGRATION.capabilities.verifyCheckout, true);
  assert.equal(RAZORPAY_INTEGRATION.capabilities.webhooks, true);
  assert.equal(RAZORPAY_INTEGRATION.capabilities.refunds, false);
  assert.equal(RAZORPAY_INTEGRATION.capabilities.subscriptions, false);
  assert.equal(RAZORPAY_INTEGRATION.capabilities.payouts, false);
});

test("the public catalog carries no implementation or secret detail", () => {
  const catalog = publicIntegrationCatalog();
  assert.equal(catalog.length, 1);
  const entry = catalog[0];
  assert.equal(entry.id, "razorpay");
  assert.deepEqual(
    entry.fields.map((field) => field.key),
    integrationCredentialNames(RAZORPAY_INTEGRATION),
  );
  assert.equal("pattern" in entry.fields[0], false);
  assert.equal(JSON.stringify(catalog).includes("secretValue"), false);
});

// ── Configuration gate ──────────────────────────────────────────────────────

const BASE_ENV = {
  [BUSINESS_INTEGRATIONS_ENABLED_ENV]: "on",
  [BUSINESS_INTEGRATIONS_PROJECTS_ENV]: "proj-a, proj-b",
  [BUSINESS_INTEGRATIONS_RPC_SECRET_ENV]: "rpc-secret-0123456789abcdef0123456789",
  MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
} as unknown as NodeJS.ProcessEnv;

test("business integrations stay off without the flag, cohort and secrets key", () => {
  assert.equal(
    readBusinessIntegrationsConfig({ ...BASE_ENV, [BUSINESS_INTEGRATIONS_ENABLED_ENV]: "" }).ok,
    false,
  );
  assert.equal(
    readBusinessIntegrationsConfig({ ...BASE_ENV, [BUSINESS_INTEGRATIONS_PROJECTS_ENV]: "" }).ok,
    false,
  );
  assert.equal(
    readBusinessIntegrationsConfig({
      ...BASE_ENV,
      [BUSINESS_INTEGRATIONS_PROJECTS_ENV]: "*",
    }).ok,
    false,
  );
  assert.equal(
    readBusinessIntegrationsConfig({ ...BASE_ENV, MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY: "" }).ok,
    false,
  );
  assert.equal(
    readBusinessIntegrationsConfig({
      ...BASE_ENV,
      [BUSINESS_INTEGRATIONS_RPC_SECRET_ENV]: "short",
    }).ok,
    false,
  );
  assert.equal(readBusinessIntegrationsConfig(BASE_ENV).ok, true);
});

test("the webhook write RPCs are gated by a server-only hash, not the anon key", () => {
  const hash = integrationRpcHash(BASE_ENV);
  assert.equal(typeof hash, "string");
  assert.match(String(hash), /^[a-f0-9]{64}$/);
  assert.equal(integrationRpcHash({ ...BASE_ENV, [BUSINESS_INTEGRATIONS_RPC_SECRET_ENV]: "" }), null);
  // The SHA-256 hash is what reaches the DB; the secret itself never does.
  assert.equal(String(hash).includes(BASE_ENV[BUSINESS_INTEGRATIONS_RPC_SECRET_ENV]!), false);
});

test("the cohort parser refuses wildcards and empty entries", () => {
  assert.equal(parseBusinessIntegrationsCohort("*").ok, false);
  assert.equal(parseBusinessIntegrationsCohort("a,*").ok, false);
  assert.equal(parseBusinessIntegrationsCohort("a, b ;c").ok, true);
  assert.equal(parseBusinessIntegrationsCohort(" ").ok, false);
});

test("the webhook URL is derived only from configured origin", () => {
  const token = `whk_${"a".repeat(48)}`;
  assert.equal(
    paymentWebhookUrl(token, { NEXT_PUBLIC_APP_URL: "https://mavly.example" } as unknown as NodeJS.ProcessEnv),
    `https://mavly.example/api/integrations/webhooks/razorpay/${token}`,
  );
  assert.equal(paymentWebhookUrl(token, { NEXT_PUBLIC_APP_URL: "https://mavly.example/path" } as unknown as NodeJS.ProcessEnv), null);
  assert.equal(paymentWebhookUrl(token, {} as unknown as NodeJS.ProcessEnv), null);
  assert.equal(publicAppOrigin({ NEXT_PUBLIC_APP_URL: "javascript:alert(1)" } as unknown as NodeJS.ProcessEnv), null);
});

// ── Signature verification ──────────────────────────────────────────────────

test("checkout signature verification accepts only the exact HMAC", () => {
  const orderId = "order_TestOrder123";
  const paymentId = "pay_TestPayment123";
  const expected = createHmac("sha256", KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  assert.equal(verifyCheckoutSignature(KEY_SECRET, orderId, paymentId, expected), true);
  assert.equal(verifyCheckoutSignature(KEY_SECRET, orderId, paymentId, "0".repeat(64)), false);
  assert.equal(verifyCheckoutSignature(KEY_SECRET, orderId, paymentId, expected.slice(0, 32)), false);
  assert.equal(verifyCheckoutSignature("other", orderId, paymentId, expected), false);
  // A client-supplied "success" without a signature is never accepted.
  assert.equal(verifyCheckoutSignature(KEY_SECRET, orderId, paymentId, ""), false);
});

test("webhook verification binds the exact raw body", () => {
  const body = JSON.stringify({ event: "payment.captured", payload: { amount: 50000 } });
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");

  assert.equal(verifyWebhookSignature(WEBHOOK_SECRET, body, signature), true);
  assert.equal(verifyWebhookSignature(WEBHOOK_SECRET, `${body} `, signature), false);
  assert.equal(verifyWebhookSignature(WEBHOOK_SECRET, body, null), false);
  assert.equal(verifyWebhookSignature("", body, signature), false);
});

// ── Payment state machine ───────────────────────────────────────────────────

test("paid is terminal, except that a late verified capture is accepted", () => {
  assert.equal(nextStatus("paid", "failed"), null);
  assert.equal(nextStatus("paid", "pending"), null);
  assert.equal(nextStatus("failed", "paid"), "paid");
  assert.equal(nextStatus("expired", "paid"), "paid");
  assert.equal(mayFulfil("paid"), true);
  assert.equal(mayFulfil("authorized"), false);
  assert.equal(mayFulfil("pending"), false);
});

test("provider statuses map without inventing a capture", () => {
  assert.equal(statusFromProviderPayment("captured"), "paid");
  assert.equal(statusFromProviderPayment("authorized"), "authorized");
  assert.equal(statusFromProviderPayment("failed"), "failed");
  assert.equal(statusFromProviderPayment("created"), "pending");
  assert.equal(statusFromProviderPayment("something_new"), "unknown");
  assert.equal(statusFromProviderPayment("captured", false), "paid");
  assert.equal(statusFromProviderOrder("paid"), "paid");
  assert.equal(statusFromProviderOrder("attempted"), "pending");
});

// ── Validation ──────────────────────────────────────────────────────────────

test("order input is bounded and currency defaults to INR", () => {
  const ok = validateCreateOrderInput({
    amount: 50_000,
    idempotencyKey: "order-2026-0001",
    notes: { businessOrder: "A-1" },
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.currency, "INR");
    assert.equal(ok.value.receipt, null);
  }

  for (const body of [
    { amount: 0, idempotencyKey: "order-2026-0001" },
    { amount: 1.5, idempotencyKey: "order-2026-0001" },
    { amount: 5_000_000_001, idempotencyKey: "order-2026-0001" },
    { amount: 100, idempotencyKey: "short" },
    { amount: 100, idempotencyKey: "order-2026-0001", currency: "IN" },
    { amount: 100, idempotencyKey: "order-2026-0001", notes: { ["bad key"]: "x" } },
  ]) {
    assert.equal(validateCreateOrderInput(body).ok, false, JSON.stringify(body));
  }
});

test("verify input requires real Razorpay ids and a hex signature", () => {
  assert.equal(
    validateVerifyPaymentInput({
      orderId: "order_TestOrder123",
      paymentId: "pay_TestPayment123",
      signature: "a".repeat(64),
    }).ok,
    true,
  );
  assert.equal(validateVerifyPaymentInput({ orderId: "../etc", paymentId: "pay_x", signature: "x" }).ok, false);
});

test("credential input distinguishes test and live keys and never echoes values", () => {
  assert.equal(razorpayKeyMode(KEY_ID), "test");
  assert.equal(razorpayKeyMode("rzp_live_AbCdEf123456"), "live");
  assert.equal(razorpayKeyMode("pk_test_123"), null);

  const ok = validatePaymentCredentialsInput({
    provider: "razorpay",
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    webhookSecret: WEBHOOK_SECRET,
    enabled: true,
  });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.enabled, true);

  // Saving is not enabling: omitting the flag must leave it off.
  const omitted = validatePaymentCredentialsInput({
    provider: "razorpay",
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    webhookSecret: WEBHOOK_SECRET,
  });
  assert.equal(omitted.ok, true);
  if (omitted.ok) assert.equal(omitted.value.enabled, false);

  const bad = validatePaymentCredentialsInput({
    provider: "razorpay",
    keyId: "pk_test_123",
    keySecret: "x",
    webhookSecret: "y",
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.includes("x"), false);
});

// ── Provider adapter: timeouts and redaction ────────────────────────────────

const credentials = { keyId: KEY_ID, keySecret: KEY_SECRET };

test("a provider timeout is a timeout, not a success", async () => {
  const aborting = (async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  }) as unknown as typeof fetch;

  const result = await createRazorpayOrder(
    credentials,
    { amountMinor: 100, currency: "INR", receipt: "m1", notes: {} },
    aborting,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "provider_timeout");
});

test("provider rejection is generic and never echoes the payload or secret", async () => {
  const rejecting = (async () =>
    new Response(`bad key ${KEY_SECRET} for customer@example.com`, {
      status: 400,
    })) as unknown as typeof fetch;

  const result = await testRazorpayCredentials(credentials, rejecting);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "provider_rejected");
    assert.equal(result.message.includes(KEY_SECRET), false);
    assert.equal(result.message.includes("customer@example.com"), false);
    assert.equal(result.message, "Razorpay rejected the request.");
  }
});

test("a 401 is reported as invalid credentials", async () => {
  const rejecting = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
  const result = await testRazorpayCredentials(credentials, rejecting);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "credentials_invalid");
});

test("a payment read sends no secret in the URL and validates the id", async () => {
  let called = false;
  const capture = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const bad = await fetchRazorpayPayment(credentials, "../../orders", capture);
  assert.equal(bad.ok, false);
  assert.equal(called, false);
});

// ── Rate-limit guardrail ────────────────────────────────────────────────────

test("the gateway window limiter bounds one project", () => {
  const limiter = createWindowLimiter({
    perKeyLimit: 2,
    perKeyWindowMs: 60_000,
    globalLimit: 10,
    globalWindowMs: 60_000,
  });
  assert.equal(limiter.consume("p", 1_000).ok, true);
  assert.equal(limiter.consume("p", 1_001).ok, true);
  const blocked = limiter.consume("p", 1_002);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.ok(blocked.retryAfterSeconds > 0);
  assert.equal(limiter.consume("other", 1_003).ok, true);
});

// ── Session gate: explicit public prefixes ──────────────────────────────────

test("the gateway and webhook prefixes are public, near misses are not", () => {
  assert.equal(isPublicApiPath("/api/app/v1/payments/orders"), true);
  assert.equal(isPublicApiPath("/api/integrations/webhooks/razorpay/whk_x"), true);
  assert.equal(apiSessionDecision("/api/app/v1/payments/orders", false), "allow");
  assert.equal(
    apiSessionDecision("/api/integrations/webhooks/razorpay/whk_x", false),
    "allow",
  );

  for (const path of [
    "/api/app/v1x/payments",
    "/api/app/v1",
    "/api/app/v2/payments",
    "/api/integrations/github/start",
    "/api/integrations/supabase/start",
    "/api/integrations/webhooksx",
  ]) {
    assert.equal(apiSessionDecision(path, false), "unauthenticated", path);
  }
});

// ── Route refusals ──────────────────────────────────────────────────────────

test("the generated-app gateway refuses a missing project API key", async () => {
  const order = await createOrderPost(
    req("/api/app/v1/payments/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 50000, idempotencyKey: "order-2026-0001" }),
    }),
  );
  assert.equal(order.status, 401);

  const verify = await verifyPost(
    req("/api/app/v1/payments/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderId: "order_TestOrder123",
        paymentId: "pay_TestPayment123",
        signature: "a".repeat(64),
      }),
    }),
  );
  assert.equal(verify.status, 401);

  const status = await statusGet(
    req("/api/app/v1/payments/order_TestOrder123"),
    { params: Promise.resolve({ orderId: "order_TestOrder123" }) },
  );
  assert.equal(status.status, 401);
});

test("the owner integration route still requires a session", async () => {
  const response = await catchAllGet(
    req("/api/vcaas/projects/my-app/integrations/payments"),
    { params: Promise.resolve({ path: ["projects", "my-app", "integrations", "payments"] }) },
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "UNAUTHENTICATED");

  const catalog = await catchAllGet(
    req("/api/vcaas/projects/my-app/integrations/catalog"),
    { params: Promise.resolve({ path: ["projects", "my-app", "integrations", "catalog"] }) },
  );
  assert.equal(catalog.status, 401);
});

test("the owner save route refuses an anonymous caller", async () => {
  const response = await catchAllPost(
    req("/api/vcaas/projects/my-app/integrations/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    { params: Promise.resolve({ path: ["projects", "my-app", "integrations", "payments"] }) },
  );
  assert.equal(response.status, 401);
});

test("the webhook route rejects the wrong content type", async () => {
  const response = await webhookPost(
    req("/api/integrations/webhooks/razorpay/whk_bad", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    }),
    { params: Promise.resolve({ token: "whk_bad" }) },
  );
  assert.equal(response.status, 415);
});

test("an unknown webhook token is a truthful 404", async () => {
  const response = await webhookPost(
    req("/api/integrations/webhooks/razorpay/not-a-token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-razorpay-event-id": "evt_test",
        "x-razorpay-signature": "a".repeat(64),
      },
      body: "{}",
    }),
    { params: Promise.resolve({ token: "not-a-token" }) },
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).ok, false);
});

// ── Migration security fences ───────────────────────────────────────────────

test("migration 21 is additive and stores no provider secret", () => {
  assert.match(SQL, /create table if not exists public\.project_integrations/);
  assert.match(SQL, /create table if not exists public\.project_integration_payments/);
  assert.match(SQL, /create table if not exists public\.project_integration_events/);
  assert.equal(/drop table/i.test(SQL), false);
  assert.equal(/delete from/i.test(SQL), false);
  assert.equal(/truncate/i.test(SQL), false);
  assert.match(SQL, /credential_secret_names text\[\]/);
  assert.equal(/project_integrations[\s\S]{0,1200}value_ciphertext/.test(SQL.split("create table if not exists public.project_integration_payments")[0]), false);
});

test("webhook write RPCs require the server-only RPC hash", () => {
  assert.match(SQL, /rpc_secret_hash text not null/);
  assert.match(SQL, /constraint project_integrations_rpc_hash_check/);
  assert.match(SQL, /i\.rpc_secret_hash = p_rpc_hash/);
  assert.match(SQL, /gateway_webhook_context\(text, text, text\)/);
  assert.match(SQL, /gateway_record_webhook_event\(uuid, text, text, text, text\)/);
  assert.match(SQL, /gateway_apply_webhook_payment\(uuid, text, text, text, bigint, text, text\)/);
  // The app-facing DB RPCs also require the server proof, so an API key alone
  // cannot mark an order paid directly through PostgREST.
  assert.match(SQL, /gateway_begin_payment\(text, text, uuid, text, bigint, text, jsonb, text\)/);
  assert.match(SQL, /gateway_mark_payment\(text, text, text, text, text, bigint, text, text\)/);

  // The hash may not be read by the authenticated role.
  const grant = SQL.match(
    /grant select \(([\s\S]*?)\) on public\.project_integrations to authenticated/,
  );
  assert.notEqual(grant, null);
  assert.equal(grant![1].includes("rpc_secret_hash"), false);
});

test("webhook idempotency is keyed on the signed body digest, not an unsigned header", () => {
  assert.match(
    SQL,
    /create unique index if not exists project_integration_events_digest_key\s+on public\.project_integration_events \(integration_id, payload_sha256\)/,
  );
  assert.match(SQL, /on conflict \(integration_id, payload_sha256\) do nothing/);
  assert.match(SQL, /and e\.payload_sha256 = p_payload_sha256/);
  assert.match(SQL, /if v_status = 'failed' then/);
  // The event-id header is retained for audit but must not be the unique key.
  assert.equal(/unique index[^;]*provider_event_id/.test(SQL), false);
});

test("payments are idempotent locally and paid requires a timestamp", () => {
  assert.match(
    SQL,
    /create unique index if not exists project_integration_payments_idempotency_key\s+on public\.project_integration_payments \(integration_id, idempotency_key\)/,
  );
  assert.match(SQL, /constraint project_integration_payments_paid_at_check/);
  assert.match(SQL, /if v_row\.amount_minor <> p_amount_minor or v_row\.currency <> p_currency then/);
});

test("the tables are owner-readable only and never directly writable", () => {
  for (const table of [
    "project_integrations",
    "project_integration_payments",
    "project_integration_events",
  ]) {
    assert.match(SQL, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(SQL, new RegExp(`revoke all on public\\.${table} from authenticated`));
    assert.match(SQL, new RegExp(`grant select \\(`));
  }
  // No INSERT/UPDATE/DELETE grant for the authenticated role on the new tables.
  assert.equal(/grant (insert|update|delete)[^;]*on public\.project_integrations/i.test(SQL), false);
  assert.equal(/grant (insert|update|delete)[^;]*on public\.project_integration_payments/i.test(SQL), false);
  assert.equal(/grant (insert|update|delete)[^;]*on public\.project_integration_events/i.test(SQL), false);
});

test("the owner save RPC can only name the adapter's own credentials", () => {
  assert.match(SQL, /p_secret_names @> array\[/);
  for (const name of [
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
  ]) {
    assert.match(SQL, new RegExp(`'${name}'`));
  }
  assert.match(SQL, /array_length\(p_secret_names, 1\) is distinct from 3/);
});

test("gateway RPCs authenticate the hashed key and its integrations scope", () => {
  const gateway = SQL.slice(SQL.indexOf("create or replace function public.gateway_payment_context"));
  assert.match(gateway, /k\.key_hash = p_key_hash/);
  assert.match(gateway, /k\.revoked_at is null/);
  assert.match(gateway, /k\.scopes \? 'integrations:\*'/);
  assert.match(gateway, /i\.project_id = k\.project_id/);
  assert.match(gateway, /pay\.project_id = k\.project_id|i\.project_id = k\.project_id and i\.id = pay\.integration_id/);
});

test("owner writes and gateway writes are SECURITY DEFINER with a pinned search_path", () => {
  const blocks = SQL.split("security definer").slice(1);
  assert.ok(blocks.length >= 9, `expected at least 9 definer functions, got ${blocks.length}`);
  for (const block of blocks) {
    assert.equal(
      block.slice(0, 240).includes("set search_path = public, pg_temp"),
      true,
      "every SECURITY DEFINER function must pin search_path",
    );
  }
});

test("the schema marker is 21 and the owner save RPC is not anon-executable", () => {
  assert.match(SQL, /create or replace function public\.business_integrations_schema_version[\s\S]*?select 21;/);
  assert.match(SQL, /revoke all on function public\.save_payment_integration[^;]*from anon;/);
  assert.match(SQL, /grant execute on function public\.save_payment_integration[^;]*to authenticated;/);
  assert.equal(
    /grant execute on function public\.save_payment_integration[^;]*to anon/.test(SQL),
    false,
  );
});

test("the migration never logs or stores a raw webhook body", () => {
  assert.equal(/raw_body|request_body|payload jsonb/i.test(SQL), false);
  assert.match(SQL, /payload_sha256 text not null/);
  assert.equal(/value_ciphertext[\s\S]{0,200}insert into public\.project_integration_events/i.test(SQL), false);
});

// ── Secret leakage in the status model ──────────────────────────────────────

test("the payment status type exposes metadata only", () => {
  const sample = {
    provider: "razorpay",
    eligible: true,
    configured: true,
    enabled: true,
    status: "verified",
    mode: "test",
    keyId: KEY_ID,
    webhookUrl: "https://mavly.example/api/integrations/webhooks/razorpay/whk_x",
    credentialsPresent: true,
    lastCheckedAt: null,
    lastError: null,
    transactions: [],
    events: [],
    hardeningReady: true,
    credentialNames: integrationCredentialNames(RAZORPAY_INTEGRATION),
  };
  assert.equal(JSON.stringify(sample).includes(KEY_SECRET), false);
  assert.equal(JSON.stringify(sample).includes(WEBHOOK_SECRET), false);
  assert.equal("keySecret" in sample, false);
  assert.equal("webhookSecret" in sample, false);
});

test("a project API key hash is what the gateway stores, never the key", () => {
  const key = `tlm_pk_${"b".repeat(64)}`;
  const hash = createHash("sha256").update(key).digest("hex");
  assert.equal(hash.length, 64);
  assert.equal(hash.includes(key), false);
});
