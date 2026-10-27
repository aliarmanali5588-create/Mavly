/**
 * Persistence for the payments integration.
 *
 * Two clients, deliberately separate:
 *   · owner operations use the caller's RLS-scoped session client;
 *   · generated-app and webhook operations use the public anon client because
 *     the callers have no Supabase session. Those calls can only reach the
 *     SECURITY DEFINER gateway RPCs, which authenticate a hashed project API key
 *     or a per-integration webhook token themselves.
 *
 * No function in this module ever receives a decrypted credential from the
 * database: the RPCs return ciphertext, and decryption happens in the service.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { SUPABASE_ANON_KEY, SUPABASE_URL, isValidSupabaseUrl } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { PaymentStatus } from "./types";

export interface IntegrationRow {
  id: string;
  project_id: string;
  category: "payments";
  provider: "razorpay";
  enabled: boolean;
  status: "configured" | "verified" | "error" | "disabled";
  config: Record<string, unknown>;
  webhook_token: string;
  credential_secret_names: string[];
  last_error: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntegrationPaymentRow {
  id: string;
  integration_id: string;
  project_id: string;
  provider: "razorpay";
  provider_order_id: string | null;
  provider_payment_id: string | null;
  receipt: string;
  amount_minor: number;
  currency: string;
  status: PaymentStatus;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
}

export interface CredentialCiphertextRow {
  secret_name: string;
  secret_id: string;
  value_ciphertext: string;
}

export interface GatewayContextRow {
  integration_id: string;
  project_id: string;
  user_id: string;
  enabled: boolean;
  secret_name: string | null;
  secret_id: string | null;
  value_ciphertext: string | null;
}

export type StoreFailureCode =
  | "unavailable"
  | "migration_required"
  | "unauthorized"
  | "invalid_input"
  | "conflict"
  | "not_found"
  | "error";

export interface StoreFailure {
  ok: false;
  code: StoreFailureCode;
  error: string;
}

export type StoreResult<T> = { ok: true; data: T } | StoreFailure;

export function isStoreFailure<T>(result: StoreResult<T>): result is StoreFailure {
  return result.ok === false;
}

const INTEGRATION_COLUMNS =
  "id,project_id,category,provider,enabled,status,config,webhook_token,credential_secret_names,last_error,last_checked_at,created_at,updated_at";

const PAYMENT_COLUMNS =
  "id,integration_id,project_id,provider,provider_order_id,provider_payment_id,receipt,amount_minor,currency,status,failure_code,created_at,updated_at,paid_at";

function failure(code: StoreFailureCode, error: string): StoreFailure {
  return { ok: false, code, error };
}

function mapDatabaseError(scope: string, error: { code?: string } | null): StoreFailure {
  const code = error?.code ?? "unknown";
  console.error(`[integrations] ${scope} failed (${code})`);

  if (
    code === "42P01" ||
    code === "42703" ||
    code === "42883" ||
    code === "PGRST202" ||
    code === "PGRST204" ||
    code === "PGRST205"
  ) {
    return failure(
      "migration_required",
      "Business-integration storage is not installed. Apply supabase/migrations/21_business_integrations.sql.",
    );
  }
  if (code === "42501" || code === "28000") {
    return failure("unauthorized", "This project is not authorized for that integration operation.");
  }
  if (code === "22023" || code === "23514") {
    return failure("invalid_input", "The integration request was rejected as invalid.");
  }
  if (code === "23505") {
    return failure("conflict", "That operation conflicts with an existing record.");
  }
  return failure("error", "Could not complete the integration operation.");
}

/** Public client for routes without a user session. Never persists a session. */
export function createIntegrationPublicClient(): SupabaseClient | null {
  if (!isValidSupabaseUrl(SUPABASE_URL) || !SUPABASE_ANON_KEY.trim()) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

async function ownerClient(): Promise<SupabaseClient | null> {
  return createSupabaseServerClient();
}

// ── Owner reads ─────────────────────────────────────────────────────────────

export async function readProjectIntegration(
  projectId: string,
  provider: string,
): Promise<StoreResult<IntegrationRow | null>> {
  const supabase = await ownerClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase
    .from("project_integrations")
    .select(INTEGRATION_COLUMNS)
    .eq("project_id", projectId)
    .eq("provider", provider)
    .maybeSingle();

  if (error) return mapDatabaseError("read integration", error);
  return { ok: true, data: (data as IntegrationRow | null) ?? null };
}

export async function listIntegrationPayments(
  projectId: string,
  limit = 20,
): Promise<StoreResult<IntegrationPaymentRow[]>> {
  const supabase = await ownerClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase
    .from("project_integration_payments")
    .select(PAYMENT_COLUMNS)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(100, limit)));

  if (error) return mapDatabaseError("list payments", error);
  return { ok: true, data: (data ?? []) as IntegrationPaymentRow[] };
}

export async function readOwnerPaymentCredentials(
  projectId: string,
  provider: string,
): Promise<StoreResult<CredentialCiphertextRow[]>> {
  const supabase = await ownerClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase.rpc("owner_payment_credentials", {
    p_project_id: projectId,
    p_provider: provider,
  });
  if (error) return mapDatabaseError("read owner credentials", error);
  return { ok: true, data: (data ?? []) as CredentialCiphertextRow[] };
}

// ── Owner writes ────────────────────────────────────────────────────────────

export async function savePaymentIntegration(input: {
  projectId: string;
  provider: string;
  keyId: string;
  enabled: boolean;
  secretNames: string[];
  rpcHash: string;
}): Promise<
  StoreResult<{
    integration_id: string;
    provider: string;
    enabled: boolean;
    status: string;
    webhook_token: string;
    created: boolean;
  }>
> {
  const supabase = await ownerClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase.rpc("save_payment_integration", {
    p_project_id: input.projectId,
    p_provider: input.provider,
    p_key_id: input.keyId,
    p_enabled: input.enabled,
    p_secret_names: input.secretNames,
    p_rpc_secret_hash: input.rpcHash,
  });
  if (error) return mapDatabaseError("save integration", error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return failure("error", "The integration was not saved.");
  return { ok: true, data: row };
}

export async function markPaymentIntegrationChecked(input: {
  projectId: string;
  provider: string;
  ok: boolean;
  error: string | null;
}): Promise<StoreResult<null>> {
  const supabase = await ownerClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { error } = await supabase.rpc("mark_payment_integration_checked", {
    p_project_id: input.projectId,
    p_provider: input.provider,
    p_ok: input.ok,
    p_error: input.error,
  });
  if (error) return mapDatabaseError("mark integration", error);
  return { ok: true, data: null };
}

export async function disablePaymentIntegration(
  projectId: string,
  provider: string,
): Promise<StoreResult<{ webhook_token: string }>> {
  const supabase = await ownerClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase.rpc("disable_payment_integration", {
    p_project_id: projectId,
    p_provider: provider,
  });
  if (error) return mapDatabaseError("disable integration", error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return failure("not_found", "Integration not found.");
  return { ok: true, data: row as { webhook_token: string } };
}

// ── Gateway RPCs (public client) ────────────────────────────────────────────

export async function gatewayPaymentContext(
  keyHash: string,
  provider: string,
  rpcHash: string,
): Promise<StoreResult<GatewayContextRow[]>> {
  const supabase = createIntegrationPublicClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase.rpc("gateway_payment_context", {
    p_key_hash: keyHash,
    p_provider: provider,
    p_rpc_hash: rpcHash,
  });
  if (error) return mapDatabaseError("gateway context", error);
  return { ok: true, data: (data ?? []) as GatewayContextRow[] };
}

export interface BeginPaymentRow {
  payment_id: string;
  created: boolean;
  status: PaymentStatus;
  provider_order_id: string | null;
  receipt: string;
  amount_minor: number;
  currency: string;
}

export async function gatewayBeginPayment(input: {
  keyHash: string;
  provider: string;
  integrationId: string;
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
  notes: Record<string, string>;
  rpcHash: string;
}): Promise<StoreResult<BeginPaymentRow | null>> {
  const supabase = createIntegrationPublicClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase.rpc("gateway_begin_payment", {
    p_key_hash: input.keyHash,
    p_provider: input.provider,
    p_integration_id: input.integrationId,
    p_idempotency_key: input.idempotencyKey,
    p_amount_minor: input.amountMinor,
    p_currency: input.currency,
    p_notes: input.notes,
    p_rpc_hash: input.rpcHash,
  });
  if (error) return mapDatabaseError("gateway begin payment", error);
  const row = Array.isArray(data) ? data[0] : null;
  return { ok: true, data: (row as BeginPaymentRow | undefined) ?? null };
}

export async function gatewaySetPaymentOrder(input: {
  paymentId: string;
  keyHash: string;
  providerOrderId: string;
  rpcHash: string;
}): Promise<StoreResult<boolean>> {
  const supabase = createIntegrationPublicClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase.rpc("gateway_set_payment_order", {
    p_payment_id: input.paymentId,
    p_key_hash: input.keyHash,
    p_provider_order_id: input.providerOrderId,
    p_rpc_hash: input.rpcHash,
  });
  if (error) return mapDatabaseError("gateway set order", error);
  return { ok: true, data: data === true };
}

export async function gatewayFailPayment(input: {
  paymentId: string;
  keyHash: string;
  failureCode: string;
  rpcHash: string;
}): Promise<StoreResult<null>> {
  const supabase = createIntegrationPublicClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { error } = await supabase.rpc("gateway_fail_payment", {
    p_payment_id: input.paymentId,
    p_key_hash: input.keyHash,
    p_failure_code: input.failureCode,
    p_rpc_hash: input.rpcHash,
  });
  if (error) return mapDatabaseError("gateway fail payment", error);
  return { ok: true, data: null };
}

export interface MarkPaymentRow {
  payment_id: string;
  status: PaymentStatus;
  matched: boolean;
}

export async function gatewayMarkPayment(input: {
  keyHash: string;
  provider: string;
  providerOrderId: string;
  providerPaymentId: string | null;
  status: string;
  amountMinor: number;
  currency: string;
  rpcHash: string;
}): Promise<StoreResult<MarkPaymentRow | null>> {
  const supabase = createIntegrationPublicClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase.rpc("gateway_mark_payment", {
    p_key_hash: input.keyHash,
    p_provider: input.provider,
    p_provider_order_id: input.providerOrderId,
    p_provider_payment_id: input.providerPaymentId,
    p_status: input.status,
    p_amount_minor: input.amountMinor,
    p_currency: input.currency,
    p_rpc_hash: input.rpcHash,
  });
  if (error) return mapDatabaseError("gateway mark payment", error);
  const row = Array.isArray(data) ? data[0] : null;
  return { ok: true, data: (row as MarkPaymentRow | undefined) ?? null };
}

export interface GatewayStatusRow {
  payment_id: string;
  status: PaymentStatus;
  provider_payment_id: string | null;
  amount_minor: number;
  currency: string;
  failure_code: string | null;
  paid_at: string | null;
}

export async function gatewayPaymentStatus(input: {
  keyHash: string;
  provider: string;
  providerOrderId: string;
  rpcHash: string;
}): Promise<StoreResult<GatewayStatusRow | null>> {
  const supabase = createIntegrationPublicClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase.rpc("gateway_payment_status", {
    p_key_hash: input.keyHash,
    p_provider: input.provider,
    p_provider_order_id: input.providerOrderId,
    p_rpc_hash: input.rpcHash,
  });
  if (error) return mapDatabaseError("gateway status", error);
  const row = Array.isArray(data) ? data[0] : null;
  return { ok: true, data: (row as GatewayStatusRow | undefined) ?? null };
}

// ── Webhook RPCs (public client) ────────────────────────────────────────────

export interface WebhookContextRow {
  integration_id: string;
  project_id: string;
  user_id: string;
  secret_name: string | null;
  secret_id: string | null;
  value_ciphertext: string | null;
}

export async function gatewayWebhookContext(
  token: string,
  provider: string,
  rpcHash: string,
): Promise<StoreResult<WebhookContextRow[]>> {
  const supabase = createIntegrationPublicClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase.rpc("gateway_webhook_context", {
    p_token: token,
    p_provider: provider,
    p_rpc_hash: rpcHash,
  });
  if (error) return mapDatabaseError("webhook context", error);
  return { ok: true, data: (data ?? []) as WebhookContextRow[] };
}

export async function gatewayRecordWebhookEvent(input: {
  integrationId: string;
  providerEventId: string;
  eventType: string;
  payloadSha256: string;
  rpcHash: string;
}): Promise<
  StoreResult<{ event_id: string; current_status: string; fresh: boolean }>
> {
  const supabase = createIntegrationPublicClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase.rpc("gateway_record_webhook_event", {
    p_integration_id: input.integrationId,
    p_provider_event_id: input.providerEventId,
    p_event_type: input.eventType,
    p_payload_sha256: input.payloadSha256,
    p_rpc_hash: input.rpcHash,
  });
  if (error) return mapDatabaseError("record webhook event", error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return failure("error", "The webhook event was not recorded.");
  return {
    ok: true,
    data: row as { event_id: string; current_status: string; fresh: boolean },
  };
}

export async function gatewayFinishWebhookEvent(input: {
  eventId: string;
  status: "processed" | "ignored" | "failed";
  errorCode: string | null;
  rpcHash: string;
}): Promise<StoreResult<null>> {
  const supabase = createIntegrationPublicClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { error } = await supabase.rpc("gateway_finish_webhook_event", {
    p_event_id: input.eventId,
    p_status: input.status,
    p_error_code: input.errorCode,
    p_rpc_hash: input.rpcHash,
  });
  if (error) return mapDatabaseError("finish webhook event", error);
  return { ok: true, data: null };
}

export async function gatewayApplyWebhookPayment(input: {
  integrationId: string;
  providerOrderId: string;
  providerPaymentId: string | null;
  status: string;
  amountMinor: number;
  currency: string;
  rpcHash: string;
}): Promise<StoreResult<MarkPaymentRow | null>> {
  const supabase = createIntegrationPublicClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase.rpc("gateway_apply_webhook_payment", {
    p_integration_id: input.integrationId,
    p_provider_order_id: input.providerOrderId,
    p_provider_payment_id: input.providerPaymentId,
    p_status: input.status,
    p_amount_minor: input.amountMinor,
    p_currency: input.currency,
    p_rpc_hash: input.rpcHash,
  });
  if (error) return mapDatabaseError("apply webhook payment", error);
  const row = Array.isArray(data) ? data[0] : null;
  return { ok: true, data: (row as MarkPaymentRow | undefined) ?? null };
}
