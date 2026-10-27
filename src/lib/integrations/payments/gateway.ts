/**
 * ═══ PAYMENT GATEWAY — THE GENERATED APP'S SERVER-SIDE PATH ═════════════════
 *
 * A published generated application calls these operations from its own server
 * code with a project API key that carries the `integrations:*` scope. The key
 * is the credential: there is no Mavly user session and no way for a browser to
 * obtain the provider secrets.
 *
 * ⚠️ THE APP NEVER CALLS POSTGREST. This route also holds the server-only RPC
 * hash required by the gateway DB RPCs, so the project API key alone cannot
 * create, fail or mark an order paid by calling the database directly.
 * ⚠️ A REDIRECT OR A CLIENT CLAIM IS NEVER ENOUGH. `verify` checks the Razorpay
 * checkout signature AND then reads the payment back from Razorpay's API before
 * the order can become `paid`.
 * ⚠️ ORDER CREATION IS IDEMPOTENT LOCALLY. A retry with the same idempotency
 * key returns the recorded order instead of creating a second one; the provider
 * call itself is never blindly retried.
 */

import {
  integrationRpcHash,
  readBusinessIntegrationsConfig,
} from "@/lib/integrations/config";
import { hashApiKey } from "@/lib/project-api-keys/crypto";
import { projectSecretsCryptoConfig } from "@/lib/project-secrets/config";
import { decryptProjectSecretValue } from "@/lib/project-secrets/crypto";
import {
  createRazorpayOrder,
  fetchRazorpayPayment,
  isRazorpayFailure,
  razorpayKeyMode,
  verifyCheckoutSignature,
  type RazorpayCredentials,
} from "./razorpay";
import { statusFromProviderPayment } from "./state";
import {
  gatewayBeginPayment,
  gatewayFailPayment,
  gatewayMarkPayment,
  gatewayPaymentContext,
  gatewayPaymentStatus,
  gatewaySetPaymentOrder,
  isStoreFailure,
} from "./store";
import type {
  PaymentCheckoutSession,
  PaymentResult,
  PaymentStatusView,
} from "./types";
import { isPaymentFailure, type PaymentFailureCode } from "./types";
import {
  validateCreateOrderInput,
  validateVerifyPaymentInput,
} from "./validation";
import { paymentOrderLimiter, paymentVerifyLimiter } from "@/lib/integrations/rate-limit";

export const PAYMENT_PROVIDER = "razorpay" as const;

const API_KEY_PATTERN = /^tlm_pk_[a-f0-9]{64}$/;

interface GatewayAuth {
  keyHash: string;
  provider: typeof PAYMENT_PROVIDER;
  integrationId: string;
  projectId: string;
  userId: string;
  enabled: boolean;
  rpcHash: string;
  credentials: RazorpayCredentials;
}

function gatewayFailure(
  status: number,
  code: PaymentFailureCode,
  error: string,
  retryAfterSeconds?: number,
): PaymentResult<never> {
  return {
    ok: false,
    status,
    code,
    error,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
}

const UNAUTHORIZED = gatewayFailure(
  401,
  "unauthorized",
  "A project API key with the integrations scope and an enabled payments integration is required.",
);

/**
 * Fail closed when the operator has turned the feature off or removed the
 * project from the explicit cohort. The gateway is a public path, so a refusal
 * does not name the missing prerequisite.
 */
function eligibilityFailure(projectId: string): PaymentResult<never> | null {
  const config = readBusinessIntegrationsConfig();
  if (!("config" in config)) {
    return gatewayFailure(404, "not_found", "Not found.");
  }
  if (!config.config.cohort.has(projectId.trim().toLowerCase())) {
    return gatewayFailure(404, "not_found", "Not found.");
  }
  return null;
}

/** Bearer token → SHA-256 hash. Nothing else about the key is logged. */
export function paymentKeyHash(authorization: string | null): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((authorization ?? "").trim());
  const key = match?.[1]?.trim() ?? "";
  if (!API_KEY_PATTERN.test(key)) return null;
  return hashApiKey(key);
}

async function authenticate(authorization: string | null): Promise<PaymentResult<GatewayAuth>> {
  const keyHash = paymentKeyHash(authorization);
  if (!keyHash) return UNAUTHORIZED;

  // The route is the only holder of this server-only proof; the app's API key
  // alone cannot call the state-changing RPCs directly.
  const rpcHash = integrationRpcHash();
  if (!rpcHash) {
    return gatewayFailure(503, "unavailable", "The payment gateway is unavailable.");
  }

  const context = await gatewayPaymentContext(keyHash, PAYMENT_PROVIDER, rpcHash);
  if (isStoreFailure(context)) {
    if (context.code === "migration_required") {
      console.error("[integrations] payment gateway storage is not installed");
    }
    return gatewayFailure(503, "unavailable", "The payment gateway is unavailable.");
  }
  const rows = context.data;
  if (rows.length === 0) return UNAUTHORIZED;

  const first = rows[0];
  if (!first.integration_id || !first.project_id || !first.user_id) {
    return UNAUTHORIZED;
  }

  const crypto = projectSecretsCryptoConfig();
  if (crypto.ok === false) {
    return gatewayFailure(503, "unavailable", "Payment credentials are not readable.");
  }

  const values = new Map<string, string>();
  for (const row of rows) {
    if (!row.secret_name || !row.secret_id || !row.value_ciphertext) continue;
    const value = decryptProjectSecretValue(crypto.config.encryptionKey, row.value_ciphertext, {
      userId: first.user_id,
      projectId: first.project_id,
      secretId: row.secret_id,
    });
    if (value === null) {
      return gatewayFailure(
        503,
        "credentials_missing",
        "The stored payment credentials could not be read. Re-save them in Mavly.",
      );
    }
    values.set(row.secret_name, value);
  }

  const keyId = values.get("RAZORPAY_KEY_ID");
  const keySecret = values.get("RAZORPAY_KEY_SECRET");
  if (!keyId || !keySecret) {
    return gatewayFailure(
      503,
      "credentials_missing",
      "The payments integration has no usable credentials. Re-save them in Mavly.",
    );
  }

  return {
    ok: true,
    data: {
      keyHash,
      provider: PAYMENT_PROVIDER,
      integrationId: first.integration_id,
      projectId: first.project_id,
      userId: first.user_id,
      enabled: first.enabled === true,
      rpcHash,
      credentials: { keyId, keySecret },
    },
  };
}

function providerFailure(
  code: "credentials_invalid" | "provider_timeout" | "provider_unavailable" | "provider_rate_limited" | "provider_rejected" | "invalid_response" | "invalid_input",
  message: string,
  retryAfterSeconds?: number,
): PaymentResult<never> {
  switch (code) {
    case "credentials_invalid":
      return gatewayFailure(
        503,
        "credentials_invalid",
        "The payments integration credentials were rejected by Razorpay. Re-save them in Mavly.",
      );
    case "provider_timeout":
      return gatewayFailure(504, "provider_timeout", "Razorpay did not answer in time.");
    case "provider_rate_limited":
      return gatewayFailure(
        429,
        "provider_rate_limited",
        "Razorpay is rate-limiting requests. Retry later.",
        retryAfterSeconds,
      );
    case "provider_unavailable":
      return gatewayFailure(502, "provider_unavailable", "Razorpay is temporarily unavailable.", retryAfterSeconds);
    case "invalid_input":
      return gatewayFailure(400, "invalid_request", message);
    default:
      return gatewayFailure(502, "provider_rejected", "Razorpay rejected the request.");
  }
}

export async function createPaymentOrder(input: {
  authorization: string | null;
  body: unknown;
}): Promise<PaymentResult<PaymentCheckoutSession>> {
  const validated = validateCreateOrderInput(input.body);
  if (!validated.ok) return gatewayFailure(400, "invalid_request", validated.error);

  const auth = await authenticate(input.authorization);
  if (isPaymentFailure(auth)) return auth;
  const ineligible = eligibilityFailure(auth.data.projectId);
  if (ineligible) return ineligible;
  if (!auth.data.enabled) {
    return gatewayFailure(409, "integration_disabled", "Payments are disabled for this project.");
  }

  const limited = paymentOrderLimiter.consume(auth.data.projectId);
  if (!limited.ok) {
    return gatewayFailure(429, "rate_limited", "Too many payment orders. Retry shortly.", (limited as { retryAfterSeconds: number }).retryAfterSeconds);
  }

  const begun = await gatewayBeginPayment({
    keyHash: auth.data.keyHash,
    provider: PAYMENT_PROVIDER,
    integrationId: auth.data.integrationId,
    idempotencyKey: validated.value.idempotencyKey,
    amountMinor: validated.value.amountMinor,
    currency: validated.value.currency,
    notes: validated.value.notes,
    rpcHash: auth.data.rpcHash,
  });
  if (isStoreFailure(begun)) {
    return gatewayFailure(503, "unavailable", "The payment order could not be recorded.");
  }
  const row = begun.data;
  if (!row) return UNAUTHORIZED;

  const testMode = razorpayKeyMode(auth.data.credentials.keyId) === "test";

  if (!row.created) {
    if (row.provider_order_id) {
      return {
        ok: true,
        data: {
          provider: PAYMENT_PROVIDER,
          keyId: auth.data.credentials.keyId,
          orderId: row.provider_order_id,
          amountMinor: Number(row.amount_minor),
          currency: row.currency,
          receipt: row.receipt,
          status: row.status,
          testMode,
        },
      };
    }
    if (row.status === "creating") {
      return gatewayFailure(409, "unavailable", "That idempotency key is still being processed.", 2);
    }
    return gatewayFailure(
      409,
      "invalid_request",
      `That idempotency key already ended in "${row.status}". Use a new key.`,
    );
  }

  const created = await createRazorpayOrder(
    auth.data.credentials,
    {
      amountMinor: validated.value.amountMinor,
      currency: validated.value.currency,
      receipt: row.receipt,
      notes: validated.value.notes,
    },
  );

  if (isRazorpayFailure(created)) {
    await gatewayFailPayment({
      paymentId: row.payment_id,
      keyHash: auth.data.keyHash,
      failureCode: created.code,
      rpcHash: auth.data.rpcHash,
    });
    return providerFailure(created.code, created.message, created.retryAfterSeconds);
  }

  if (
    created.data.amount !== validated.value.amountMinor ||
    created.data.currency !== validated.value.currency
  ) {
    await gatewayFailPayment({
      paymentId: row.payment_id,
      keyHash: auth.data.keyHash,
      failureCode: "provider_rejected",
      rpcHash: auth.data.rpcHash,
    });
    return gatewayFailure(
      502,
      "provider_rejected",
      "Razorpay returned an order that does not match the request.",
    );
  }

  let recorded = await gatewaySetPaymentOrder({
    paymentId: row.payment_id,
    keyHash: auth.data.keyHash,
    providerOrderId: created.data.id,
    rpcHash: auth.data.rpcHash,
  });
  if (isStoreFailure(recorded) || !recorded.data) {
    // One retry: the provider order exists, so failing to record it would make
    // the order unreachable. Never fabricate a success if both attempts fail.
    recorded = await gatewaySetPaymentOrder({
      paymentId: row.payment_id,
      keyHash: auth.data.keyHash,
      providerOrderId: created.data.id,
      rpcHash: auth.data.rpcHash,
    });
    if (isStoreFailure(recorded) || !recorded.data) {
      return gatewayFailure(
        502,
        "unavailable",
        "Razorpay created the order but it could not be recorded. Do not retry with this key; create a new order.",
      );
    }
  }

  return {
    ok: true,
    data: {
      provider: PAYMENT_PROVIDER,
      keyId: auth.data.credentials.keyId,
      orderId: created.data.id,
      amountMinor: created.data.amount,
      currency: created.data.currency,
      receipt: row.receipt,
      status: "created",
      testMode,
    },
  };
}

export async function verifyPayment(input: {
  authorization: string | null;
  body: unknown;
}): Promise<PaymentResult<PaymentStatusView>> {
  const validated = validateVerifyPaymentInput(input.body);
  if (!validated.ok) return gatewayFailure(400, "invalid_request", validated.error);

  const auth = await authenticate(input.authorization);
  if (isPaymentFailure(auth)) return auth;
  const ineligible = eligibilityFailure(auth.data.projectId);
  if (ineligible) return ineligible;

  const limited = paymentVerifyLimiter.consume(auth.data.projectId);
  if (!limited.ok) {
    return gatewayFailure(429, "rate_limited", "Too many payment checks. Retry shortly.", (limited as { retryAfterSeconds: number }).retryAfterSeconds);
  }

  if (
    !verifyCheckoutSignature(
      auth.data.credentials.keySecret,
      validated.value.orderId,
      validated.value.paymentId,
      validated.value.signature,
    )
  ) {
    return gatewayFailure(400, "signature_invalid", "The payment signature is not valid.");
  }

  const fetched = await fetchRazorpayPayment(auth.data.credentials, validated.value.paymentId);
  if (isRazorpayFailure(fetched)) {
    return providerFailure(fetched.code, fetched.message, fetched.retryAfterSeconds);
  }
  if (fetched.data.orderId !== validated.value.orderId) {
    return gatewayFailure(409, "order_mismatch", "That payment belongs to a different order.");
  }

  const status = statusFromProviderPayment(fetched.data.status, fetched.data.captured);
  if (status === "unknown") {
    return {
      ok: true,
      data: {
        orderId: validated.value.orderId,
        paymentId: fetched.data.id,
        status: "unknown",
        amountMinor: fetched.data.amount,
        currency: fetched.data.currency,
        paid: false,
        failureCode: null,
      },
    };
  }

  const marked = await gatewayMarkPayment({
    keyHash: auth.data.keyHash,
    provider: PAYMENT_PROVIDER,
    providerOrderId: validated.value.orderId,
    providerPaymentId: fetched.data.id,
    status,
    amountMinor: fetched.data.amount,
    currency: fetched.data.currency,
    rpcHash: auth.data.rpcHash,
  });
  if (isStoreFailure(marked)) {
    return gatewayFailure(503, "unavailable", "The payment state could not be recorded.");
  }
  if (!marked.data) {
    return gatewayFailure(404, "not_found", "That order was not created for this project.");
  }
  if (!marked.data.matched) {
    return gatewayFailure(
      409,
      "amount_mismatch",
      "The payment does not match the recorded amount or currency.",
    );
  }

  return {
    ok: true,
    data: {
      orderId: validated.value.orderId,
      paymentId: fetched.data.id,
      status: marked.data.status,
      amountMinor: fetched.data.amount,
      currency: fetched.data.currency,
      paid: marked.data.status === "paid",
      failureCode: marked.data.status === "failed" ? "provider_rejected" : null,
    },
  };
}

export async function paymentStatus(input: {
  authorization: string | null;
  orderId: string;
}): Promise<PaymentResult<PaymentStatusView>> {
  const orderId = input.orderId.trim();
  if (!/^order_[A-Za-z0-9]{6,64}$/.test(orderId)) {
    return gatewayFailure(400, "invalid_request", "A valid order id is required.");
  }

  const auth = await authenticate(input.authorization);
  if (isPaymentFailure(auth)) return auth;
  const ineligible = eligibilityFailure(auth.data.projectId);
  if (ineligible) return ineligible;

  const limited = paymentVerifyLimiter.consume(auth.data.projectId);
  if (!limited.ok) {
    return gatewayFailure(429, "rate_limited", "Too many payment checks. Retry shortly.", (limited as { retryAfterSeconds: number }).retryAfterSeconds);
  }

  const row = await gatewayPaymentStatus({
    keyHash: auth.data.keyHash,
    provider: PAYMENT_PROVIDER,
    providerOrderId: orderId,
    rpcHash: auth.data.rpcHash,
  });
  if (isStoreFailure(row)) {
    return gatewayFailure(503, "unavailable", "The payment state could not be read.");
  }
  if (!row.data) return gatewayFailure(404, "not_found", "Order not found.");

  return {
    ok: true,
    data: {
      orderId,
      paymentId: row.data.provider_payment_id,
      status: row.data.status,
      amountMinor: Number(row.data.amount_minor),
      currency: row.data.currency,
      paid: row.data.status === "paid",
      failureCode: row.data.failure_code,
    },
  };
}
