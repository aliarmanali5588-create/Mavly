/**
 * ═══ RAZORPAY WEBHOOK RECEIVER ══════════════════════════════════════════════
 *
 * Trust order: resolve the per-integration token → decrypt the webhook secret →
 * verify HMAC-SHA256 over the EXACT raw body → only then parse and apply.
 *
 * ⚠️ AN UNVERIFIED BODY IS NEVER PARSED FOR STATE. The signature check happens
 * before JSON parsing, and nothing is written on a bad signature.
 * ⚠️ REPLAY PROTECTION IS THE EVENT ID. Razorpay does not sign a timestamp, so a
 * redelivered event is de-duplicated by `(integration_id, provider_event_id)`.
 * ⚠️ NO RAW BODY, HEADER OR PERSONAL DATA IS STORED OR LOGGED. Only the event
 * type, the event id and a SHA-256 digest are persisted.
 */

import { createHash } from "node:crypto";

import {
  integrationRpcHash,
  isBusinessIntegrationsProject,
  readBusinessIntegrationsConfig,
} from "@/lib/integrations/config";
import { projectSecretsCryptoConfig } from "@/lib/project-secrets/config";
import { decryptProjectSecretValue } from "@/lib/project-secrets/crypto";
import { verifyWebhookSignature } from "./razorpay";
import {
  gatewayApplyWebhookPayment,
  gatewayFinishWebhookEvent,
  gatewayRecordWebhookEvent,
  gatewayWebhookContext,
  isStoreFailure,
} from "./store";
import { statusFromProviderPayment } from "./state";
import type { PaymentStatus } from "./types";

/** Events this build acts on. Anything else is recorded and ignored. */
const HANDLED_EVENTS = new Set([
  "payment.authorized",
  "payment.captured",
  "payment.failed",
  "order.paid",
]);

const TOKEN_PATTERN = /^whk_[a-f0-9]{48}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const ORDER_ID = /^order_[A-Za-z0-9]{6,64}$/;
const PAYMENT_ID = /^pay_[A-Za-z0-9]{6,64}$/;

export interface WebhookOutcome {
  status: number;
  ok: boolean;
}

function outcome(status: number, ok: boolean): WebhookOutcome {
  return { status, ok };
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nested(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    const object = objectOf(current);
    if (!object) return undefined;
    current = object[key];
  }
  return current;
}

interface PaymentEvent {
  orderId: string;
  paymentId: string | null;
  amountMinor: number;
  currency: string;
  status: PaymentStatus;
}

function parsePaymentEvent(eventType: string, payload: unknown): PaymentEvent | null {
  const payment = objectOf(nested(payload, "payment", "entity"));
  const order = objectOf(nested(payload, "order", "entity"));

  if (eventType.startsWith("payment.")) {
    if (!payment) return null;
    const orderId = typeof payment.order_id === "string" ? payment.order_id : "";
    const paymentId = typeof payment.id === "string" ? payment.id : "";
    if (!ORDER_ID.test(orderId) || !PAYMENT_ID.test(paymentId)) return null;
    if (!Number.isSafeInteger(payment.amount) || typeof payment.currency !== "string") {
      return null;
    }
    const status =
      eventType === "payment.captured"
        ? statusFromProviderPayment("captured", true)
        : eventType === "payment.authorized"
          ? statusFromProviderPayment("authorized")
          : statusFromProviderPayment("failed");
    return {
      orderId,
      paymentId,
      amountMinor: Number(payment.amount),
      currency: payment.currency.toUpperCase(),
      status,
    };
  }

  if (eventType === "order.paid") {
    if (!order) return null;
    const orderId = typeof order.id === "string" ? order.id : "";
    if (!ORDER_ID.test(orderId)) return null;
    if (!Number.isSafeInteger(order.amount) || typeof order.currency !== "string") {
      return null;
    }
    const paymentId =
      payment && typeof payment.id === "string" && PAYMENT_ID.test(payment.id)
        ? payment.id
        : null;
    return {
      orderId,
      paymentId,
      amountMinor: Number(order.amount),
      currency: order.currency.toUpperCase(),
      status: "paid",
    };
  }

  return null;
}

export async function handleRazorpayWebhook(input: {
  token: string;
  rawBody: string;
  signature: string | null;
  eventId: string | null;
}): Promise<WebhookOutcome> {
  const config = readBusinessIntegrationsConfig();
  if (!("config" in config)) return outcome(404, false);
  const rpcHash = integrationRpcHash();
  if (!rpcHash) return outcome(503, false);

  if (!TOKEN_PATTERN.test(input.token)) return outcome(404, false);
  if (!input.eventId || !EVENT_ID_PATTERN.test(input.eventId)) {
    return outcome(400, false);
  }

  const context = await gatewayWebhookContext(input.token, "razorpay", rpcHash);
  if (isStoreFailure(context)) return outcome(503, false);
  const rows = context.data;
  if (rows.length === 0) return outcome(404, false);

  const first = rows[0];
  if (
    !first.integration_id ||
    !first.project_id ||
    !first.user_id ||
    !isBusinessIntegrationsProject(first.project_id)
  ) {
    return outcome(404, false);
  }

  const cryptoConfig = projectSecretsCryptoConfig();
  if (cryptoConfig.ok === false) return outcome(503, false);

  let webhookSecret: string | null = null;
  for (const row of rows) {
    if (
      row.secret_name !== "RAZORPAY_WEBHOOK_SECRET" ||
      !row.secret_id ||
      !row.value_ciphertext
    ) {
      continue;
    }
    webhookSecret = decryptProjectSecretValue(
      cryptoConfig.config.encryptionKey,
      row.value_ciphertext,
      {
        userId: first.user_id,
        projectId: first.project_id,
        secretId: row.secret_id,
      },
    );
  }
  if (!webhookSecret) return outcome(503, false);

  if (!verifyWebhookSignature(webhookSecret, input.rawBody, input.signature)) {
    return outcome(401, false);
  }

  let body: unknown;
  try {
    body = JSON.parse(input.rawBody);
  } catch {
    return outcome(400, false);
  }
  const eventType = typeof nested(body, "event") === "string"
    ? String(nested(body, "event"))
    : "";
  if (!eventType || eventType.length > 80) return outcome(400, false);

  const payloadDigest = createHash("sha256").update(input.rawBody, "utf8").digest("hex");
  const recorded = await gatewayRecordWebhookEvent({
    integrationId: first.integration_id,
    providerEventId: input.eventId,
    eventType,
    payloadSha256: payloadDigest,
    rpcHash,
  });
  if (isStoreFailure(recorded)) {
    return recorded.code === "migration_required"
      ? outcome(503, false)
      : outcome(500, false);
  }
  if (!recorded.data.fresh) return outcome(200, true);

  const eventId = recorded.data.event_id;

  if (!HANDLED_EVENTS.has(eventType)) {
    await gatewayFinishWebhookEvent({ eventId, status: "ignored", errorCode: null, rpcHash });
    return outcome(200, true);
  }

  const event = parsePaymentEvent(eventType, nested(body, "payload"));
  if (!event) {
    await gatewayFinishWebhookEvent({
      eventId,
      status: "failed",
      errorCode: "invalid_payload",
      rpcHash,
    });
    return outcome(200, true);
  }

  const applied = await gatewayApplyWebhookPayment({
    integrationId: first.integration_id,
    providerOrderId: event.orderId,
    providerPaymentId: event.paymentId,
    status: event.status,
    amountMinor: event.amountMinor,
    currency: event.currency,
    rpcHash,
  });
  if (isStoreFailure(applied)) {
    await gatewayFinishWebhookEvent({
      eventId,
      status: "failed",
      errorCode: "processing_error",
      rpcHash,
    });
    return outcome(500, false);
  }
  if (!applied.data) {
    // A signed event for an order this integration did not create. Acknowledge
    // it so the provider stops retrying, and keep the audit row.
    await gatewayFinishWebhookEvent({
      eventId,
      status: "failed",
      errorCode: "order_not_found",
      rpcHash,
    });
    return outcome(200, true);
  }
  if (!applied.data.matched) {
    await gatewayFinishWebhookEvent({
      eventId,
      status: "failed",
      errorCode: "amount_mismatch",
      rpcHash,
    });
    return outcome(200, true);
  }

  await gatewayFinishWebhookEvent({
    eventId,
    status: "processed",
    errorCode: null,
    rpcHash,
  });
  return outcome(200, true);
}
