/**
 * ═══ PAYMENTS INTEGRATION — OWNER SERVICE ═══════════════════════════════════
 *
 * The catch-all has already proved the caller owns the project. Everything here
 * repeats the project/user predicate through the RLS-scoped client and the
 * owner-only RPCs.
 *
 * Credential handling:
 *   · the three values are encrypted by `project_secrets` (AES-256-GCM, same
 *     server-only key) before anything is stored;
 *   · for a project in the full-stack hosting cohort, the existing Phase 5
 *     secret sync also pushes them to the generated app's production runtime,
 *     so that app may call Razorpay directly for its own server-side work;
 *   · the workspace never receives a secret value or ciphertext.
 *
 * ⚠️ A SAVE TESTS THE KEY PAIR FIRST. Invalid credentials are not written. The
 * check is a side-effect-free `GET /v1/orders?count=1`.
 * ⚠️ DISABLE DOES NOT DELETE THE USER'S SECRETS. It stops the gateway, rotates
 * the webhook token and says so; deleting credential values stays the explicit
 * action of the Secrets panel, where the user can see the names.
 */

import {
  businessIntegrationsRefusal,
  integrationRpcHash,
  paymentWebhookUrl,
  readBusinessIntegrationsConfig,
  type BusinessIntegrationsReason,
} from "@/lib/integrations/config";
import { RAZORPAY_INTEGRATION, integrationCredentialNames } from "@/lib/integrations/contracts";
import { projectSecretsCryptoConfig } from "@/lib/project-secrets/config";
import { decryptProjectSecretValue } from "@/lib/project-secrets/crypto";
import {
  createProjectSecret,
  isProjectSecretServiceFailure,
  listProjectSecrets,
  updateProjectSecret,
  type ProjectSecretServiceFailure,
} from "@/lib/project-secrets/service";
import type {
  PaymentsIntegrationStatus,
  ProjectPaymentTransaction,
  VcaasSecret,
} from "@/lib/vcaas-types";
import {
  isRazorpayFailure,
  razorpayKeyMode,
  testRazorpayCredentials,
  type RazorpayCredentials,
  type RazorpayFailure,
} from "./razorpay";
import {
  disablePaymentIntegration,
  isStoreFailure,
  listIntegrationEvents,
  listIntegrationPayments,
  markPaymentIntegrationChecked,
  productionHardeningReady,
  readOwnerPaymentCredentials,
  readProjectIntegration,
  savePaymentIntegration,
  type IntegrationPaymentRow,
  type IntegrationRow,
  type StoreFailure,
} from "./store";
import { paymentEventMetadata } from "./event-view";
import { validatePaymentCredentialsInput } from "./validation";
import { emitPaymentEvent } from "@/lib/observability/payments";

export const PAYMENT_PROVIDER = "razorpay" as const;

export type PaymentsServiceFailure = {
  ok: false;
  status: number;
  code: string;
  error: string;
};

export type PaymentsServiceResult<T> = { ok: true; data: T } | PaymentsServiceFailure;

export function isPaymentsServiceFailure<T>(
  result: PaymentsServiceResult<T>,
): result is PaymentsServiceFailure {
  return result.ok === false;
}

function failure(status: number, code: string, error: string): PaymentsServiceFailure {
  return { ok: false, status, code, error };
}

function configFailure(reason: BusinessIntegrationsReason): PaymentsServiceFailure {
  return failure(503, "BACKEND_NOT_CONFIGURED", businessIntegrationsRefusal(reason));
}

function storeFailure(error: StoreFailure): PaymentsServiceFailure {
  switch (error.code) {
    case "migration_required":
      return failure(503, "MIGRATION_REQUIRED", error.error);
    case "unavailable":
      return failure(503, "BACKEND_NOT_CONFIGURED", error.error);
    case "unauthorized":
      return failure(404, "PROJECT_NOT_FOUND", "Integration not found.");
    case "invalid_input":
      return failure(400, "VALIDATION", error.error);
    case "conflict":
      return failure(409, "CONFLICT", error.error);
    case "not_found":
      return failure(404, "NOT_FOUND", error.error);
    default:
      return failure(500, "UNKNOWN", error.error);
  }
}

function secretFailure(error: ProjectSecretServiceFailure): PaymentsServiceFailure {
  return failure(error.status, error.code, error.error);
}

function providerFailure(error: RazorpayFailure): PaymentsServiceFailure {
  switch (error.code) {
    case "credentials_invalid":
      // 400, not 401: the Mavly session is valid; the PROVIDER rejected the
      // supplied key pair. A 401 here would read as "your session expired".
      return failure(400, "CREDENTIALS_INVALID", error.message);
    case "provider_timeout":
      return failure(504, "PROVIDER_TIMEOUT", error.message);
    case "provider_rate_limited":
      return failure(429, "PROVIDER_RATE_LIMITED", error.message);
    case "provider_unavailable":
      return failure(502, "PROVIDER_UNAVAILABLE", error.message);
    case "invalid_input":
      return failure(400, "VALIDATION", error.message);
    default:
      return failure(502, "PROVIDER_REJECTED", error.message);
  }
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function modeOf(row: IntegrationRow | null): "test" | "live" | null {
  if (!row) return null;
  const keyId = stringOf(row.config.keyId);
  const fromKey = keyId ? razorpayKeyMode(keyId) : null;
  if (fromKey) return fromKey;
  const configured = stringOf(row.config.mode);
  return configured === "test" || configured === "live" ? configured : null;
}

function toTransaction(row: IntegrationPaymentRow): ProjectPaymentTransaction {
  return {
    orderId: row.provider_order_id,
    paymentId: row.provider_payment_id,
    receipt: row.receipt,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    paidAt: row.paid_at,
  };
}

async function credentialsPresent(
  projectId: string,
  userId: string,
  names: string[],
): Promise<boolean> {
  const listed = await listProjectSecrets(projectId, userId);
  if (isProjectSecretServiceFailure(listed)) return false;
  const available = new Set(
    listed.data
      .filter((secret: VcaasSecret) => secret.environment !== "development")
      .map((secret: VcaasSecret) => secret.secretName),
  );
  return names.every((name) => available.has(name));
}

async function composeStatus(
  projectId: string,
  userId: string,
  row: IntegrationRow | null,
): Promise<PaymentsServiceResult<PaymentsIntegrationStatus>> {
  const names = integrationCredentialNames(RAZORPAY_INTEGRATION);
  const present = await credentialsPresent(projectId, userId, names);
  const [payments, events, hardeningReady] = await Promise.all([
    listIntegrationPayments(projectId, 20),
    listIntegrationEvents(projectId, 20),
    productionHardeningReady(),
  ]);
  if (isStoreFailure(payments)) return storeFailure(payments);
  if (isStoreFailure(events)) return storeFailure(events);

  return {
    ok: true,
    data: {
      provider: "razorpay",
      eligible: true,
      configured: Boolean(row),
      enabled: Boolean(row?.enabled),
      status: row ? row.status : "not_configured",
      mode: modeOf(row),
      keyId: row ? stringOf(row.config.keyId) : null,
      webhookUrl:
        row && row.enabled ? paymentWebhookUrl(row.webhook_token) : null,
      credentialsPresent: present,
      lastCheckedAt: row?.last_checked_at ?? null,
      lastError: row?.last_error ?? null,
      transactions: payments.data.map(toTransaction),
      events: events.data.map(paymentEventMetadata),
      hardeningReady,
      credentialNames: names,
    },
  };
}

/** The gate every owner operation shares. */
function readGate(): PaymentsServiceFailure | null {
  const config = readBusinessIntegrationsConfig();
  if (!("config" in config)) return configFailure(config.reason);
  return null;
}

function eligible(projectId: string): PaymentsServiceFailure | null {
  const config = readBusinessIntegrationsConfig();
  if (!("config" in config)) return configFailure(config.reason);
  if (!config.config.cohort.has(projectId.trim().toLowerCase())) {
    return failure(
      503,
      "BACKEND_NOT_CONFIGURED",
      "Business integrations are not enabled for this project.",
    );
  }
  return null;
}

export async function getPaymentsStatus(
  projectId: string,
  userId: string,
): Promise<PaymentsServiceResult<PaymentsIntegrationStatus>> {
  const refusal = readGate() ?? eligible(projectId);
  if (refusal) return refusal;

  const row = await readProjectIntegration(projectId, PAYMENT_PROVIDER);
  if (isStoreFailure(row)) return storeFailure(row);
  return composeStatus(projectId, userId, row.data);
}

/**
 * Upsert one credential row. The environment is `production` so Phase 5 can
 * sync it to the generated application's production runtime.
 */
async function upsertCredential(
  projectId: string,
  userId: string,
  name: string,
  value: string,
): Promise<PaymentsServiceResult<VcaasSecret>> {
  const listed = await listProjectSecrets(projectId, userId);
  if (isProjectSecretServiceFailure(listed)) return secretFailure(listed);

  const existing =
    listed.data.find(
      (secret) => secret.secretName === name && secret.environment === "production",
    ) ??
    listed.data.find(
      (secret) => secret.secretName === name && secret.environment === "both",
    );

  if (existing) {
    const updated = await updateProjectSecret(projectId, userId, existing._id, {
      secretValue: value,
      environment: "production",
    });
    if (!isProjectSecretServiceFailure(updated)) return updated;

    if (updated.code !== "CONFLICT") return secretFailure(updated);

    // A concurrent create won the race: re-read and update that row.
    const again = await listProjectSecrets(projectId, userId);
    if (isProjectSecretServiceFailure(again)) return secretFailure(again);
    const current = again.data.find(
      (secret) => secret.secretName === name && secret.environment === "production",
    );
    if (!current) return secretFailure(updated);
    const retried = await updateProjectSecret(projectId, userId, current._id, {
      secretValue: value,
    });
    return isProjectSecretServiceFailure(retried) ? secretFailure(retried) : retried;
  }

  const created = await createProjectSecret(projectId, userId, {
    secretName: name,
    secretValue: value,
    environment: "production",
  });
  return isProjectSecretServiceFailure(created) ? secretFailure(created) : created;
}

export async function savePaymentsIntegration(
  projectId: string,
  userId: string,
  body: unknown,
): Promise<PaymentsServiceResult<PaymentsIntegrationStatus>> {
  const refusal = readGate() ?? eligible(projectId);
  if (refusal) return refusal;

  const input = validatePaymentCredentialsInput(body);
  if (!input.ok) return failure(400, "VALIDATION", input.error);
  if (input.value.provider !== PAYMENT_PROVIDER) {
    return failure(400, "VALIDATION", "Only Razorpay is implemented.");
  }

  const rpcHash = integrationRpcHash();
  if (!rpcHash) {
    return failure(
      503,
      "BACKEND_NOT_CONFIGURED",
      businessIntegrationsRefusal("rpc_secret_missing"),
    );
  }

  const credentials: RazorpayCredentials = {
    keyId: input.value.keyId,
    keySecret: input.value.keySecret,
  };

  // Prove the key pair before writing anything. A rejected key is not stored.
  const tested = await testRazorpayCredentials(credentials);
  if (isRazorpayFailure(tested)) return providerFailure(tested);

  const values: Array<[string, string]> = [
    ["RAZORPAY_KEY_ID", input.value.keyId],
    ["RAZORPAY_KEY_SECRET", input.value.keySecret],
    ["RAZORPAY_WEBHOOK_SECRET", input.value.webhookSecret],
  ];
  for (const [name, value] of values) {
    const saved = await upsertCredential(projectId, userId, name, value);
    if (isPaymentsServiceFailure(saved)) return saved;
  }

  const saved = await savePaymentIntegration({
    projectId,
    provider: PAYMENT_PROVIDER,
    keyId: input.value.keyId,
    enabled: input.value.enabled,
    secretNames: values.map(([name]) => name),
    rpcHash,
  });
  if (isStoreFailure(saved)) return storeFailure(saved);

  if (input.value.enabled) {
    const marked = await markPaymentIntegrationChecked({
      projectId,
      provider: PAYMENT_PROVIDER,
      ok: true,
      error: null,
    });
    if (isStoreFailure(marked)) return storeFailure(marked);
  }

  const row = await readProjectIntegration(projectId, PAYMENT_PROVIDER);
  if (isStoreFailure(row)) return storeFailure(row);
  emitPaymentEvent("payment.integration_saved", {
    integrationId: row.data?.id ?? null,
    projectId,
    operation: "owner",
    status: "saved",
    httpStatus: 200,
  });
  return composeStatus(projectId, userId, row.data);
}

/** Read the stored credentials (ciphertext) for a real provider check. */
async function loadCredentials(
  projectId: string,
  userId: string,
): Promise<PaymentsServiceResult<RazorpayCredentials>> {
  const crypto = projectSecretsCryptoConfig();
  if (crypto.ok === false) return failure(503, "BACKEND_NOT_CONFIGURED", crypto.error);

  const rows = await readOwnerPaymentCredentials(projectId, PAYMENT_PROVIDER);
  if (isStoreFailure(rows)) return storeFailure(rows);

  const values = new Map<string, string>();
  for (const row of rows.data) {
    const decrypted = decryptProjectSecretValue(crypto.config.encryptionKey, row.value_ciphertext, {
      userId,
      projectId,
      secretId: row.secret_id,
    });
    if (decrypted === null) {
      return failure(
        503,
        "CREDENTIALS_UNREADABLE",
        "The stored payment credentials could not be decrypted. Re-save them.",
      );
    }
    values.set(row.secret_name, decrypted);
  }

  const keyId = values.get("RAZORPAY_KEY_ID");
  const keySecret = values.get("RAZORPAY_KEY_SECRET");
  if (!keyId || !keySecret) {
    return failure(
      409,
      "CREDENTIALS_MISSING",
      "Save the Razorpay key id, key secret and webhook secret first.",
    );
  }
  return { ok: true, data: { keyId, keySecret } };
}

export async function testPaymentsIntegration(
  projectId: string,
  userId: string,
): Promise<
  PaymentsServiceResult<{
    verified: boolean;
    mode: "test" | "live" | null;
    lastError: string | null;
    checkedAt: string;
  }>
> {
  const refusal = readGate() ?? eligible(projectId);
  if (refusal) return refusal;

  const integration = await readProjectIntegration(projectId, PAYMENT_PROVIDER);
  if (isStoreFailure(integration)) return storeFailure(integration);
  if (!integration.data) {
    return failure(404, "NOT_FOUND", "Razorpay is not configured for this project.");
  }

  const credentials = await loadCredentials(projectId, userId);
  if (isPaymentsServiceFailure(credentials)) return credentials;

  const tested = await testRazorpayCredentials(credentials.data);
  const checkedAt = new Date().toISOString();
  const providerError = isRazorpayFailure(tested) ? tested : null;
  const verified = providerError === null;
  const lastError = providerError?.message ?? null;

  const marked = await markPaymentIntegrationChecked({
    projectId,
    provider: PAYMENT_PROVIDER,
    ok: verified,
    error: lastError,
  });
  if (isStoreFailure(marked)) return storeFailure(marked);

  if (!verified) {
    emitPaymentEvent("payment.integration_test_failed", {
      integrationId: integration.data.id,
      projectId,
      operation: "owner",
      status: "test_failed",
      errorClass: providerError?.code ?? "provider_failed",
      httpStatus: 200,
    });
  }

  return {
    ok: true,
    data: {
      verified,
      mode: razorpayKeyMode(credentials.data.keyId),
      lastError,
      checkedAt,
    },
  };
}

export async function disablePaymentsIntegration(
  projectId: string,
  userId: string,
): Promise<PaymentsServiceResult<PaymentsIntegrationStatus>> {
  const refusal = readGate() ?? eligible(projectId);
  if (refusal) return refusal;

  const integration = await readProjectIntegration(projectId, PAYMENT_PROVIDER);
  if (isStoreFailure(integration)) return storeFailure(integration);
  if (!integration.data) {
    return failure(404, "NOT_FOUND", "Razorpay is not configured for this project.");
  }

  const disabled = await disablePaymentIntegration(projectId, PAYMENT_PROVIDER);
  if (isStoreFailure(disabled)) return storeFailure(disabled);

  const row = await readProjectIntegration(projectId, PAYMENT_PROVIDER);
  if (isStoreFailure(row)) return storeFailure(row);
  emitPaymentEvent("payment.integration_disabled", {
    integrationId: row.data?.id ?? null,
    projectId,
    operation: "owner",
    status: "disabled",
    httpStatus: 200,
  });
  return composeStatus(projectId, userId, row.data);
}
