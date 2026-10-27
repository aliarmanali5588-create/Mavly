/**
 * ═══ BUSINESS-INTEGRATION CONTRACTS ═════════════════════════════════════════
 *
 * A small, truthful catalog of the business services a generated application may
 * use. It is deliberately NOT a generic plugin framework: every entry describes
 * capabilities that actually exist in this build.
 *
 * ⚠️ PURE. This module is imported by the workspace UI, so it must never import
 * `node:crypto`, read an environment variable or reach a provider.
 *
 * ⚠️ NOTHING UNIMPLEMENTED IS LISTED. A provider appears here only when its
 * adapter, credential schema, server-side route and verification tests exist. A
 * "coming soon" row would be indistinguishable from a working one in the UI.
 */

export type IntegrationCategory = "payments" | "email" | "messaging";

export type IntegrationProviderId = "razorpay";

export interface IntegrationCredentialField {
  /** The `project_secrets` name the value is stored under. */
  key: string;
  label: string;
  /** `identifier` is displayable (e.g. a publishable key id); `secret` is not. */
  kind: "identifier" | "secret";
  /** Validated server-side before anything is stored. */
  pattern: string;
  maxLength: number;
}

export interface IntegrationCapabilities {
  /** The server creates the provider order/session. */
  createOrder: boolean;
  /** A browser callback is verified server-side before any state changes. */
  verifyCheckout: boolean;
  /** Provider webhooks are signature-verified and idempotent. */
  webhooks: boolean;
  /** Explicitly false until a real implementation exists. */
  refunds: boolean;
  subscriptions: boolean;
  payouts: boolean;
}

export interface IntegrationDefinition {
  id: IntegrationProviderId;
  category: "payments";
  name: string;
  summary: string;
  implemented: true;
  capabilities: IntegrationCapabilities;
  credentialFields: readonly IntegrationCredentialField[];
  /** Events this build understands; anything else is recorded and ignored. */
  webhookEvents: readonly string[];
  webhookSignatureHeader: string;
}

export const RAZORPAY_INTEGRATION: IntegrationDefinition = {
  id: "razorpay",
  category: "payments",
  name: "Razorpay",
  summary:
    "Create payment orders in your published app and confirm them with Razorpay's signed webhook or the authoritative payment API.",
  implemented: true,
  capabilities: {
    createOrder: true,
    verifyCheckout: true,
    webhooks: true,
    refunds: false,
    subscriptions: false,
    payouts: false,
  },
  credentialFields: [
    {
      key: "RAZORPAY_KEY_ID",
      label: "Key ID",
      kind: "identifier",
      pattern: "^rzp_(test|live)_[A-Za-z0-9]{6,40}$",
      maxLength: 64,
    },
    {
      key: "RAZORPAY_KEY_SECRET",
      label: "Key secret",
      kind: "secret",
      pattern: "^[^\\s]{8,128}$",
      maxLength: 128,
    },
    {
      key: "RAZORPAY_WEBHOOK_SECRET",
      label: "Webhook secret",
      kind: "secret",
      pattern: "^[^\\s]{8,128}$",
      maxLength: 128,
    },
  ],
  webhookEvents: [
    "payment.authorized",
    "payment.captured",
    "payment.failed",
    "order.paid",
  ],
  webhookSignatureHeader: "x-razorpay-signature",
};

export const PAYMENT_INTEGRATIONS: readonly IntegrationDefinition[] = [
  RAZORPAY_INTEGRATION,
];

export function findPaymentIntegration(
  provider: string | null | undefined,
): IntegrationDefinition | null {
  const id = (provider ?? "").trim().toLowerCase();
  return PAYMENT_INTEGRATIONS.find((entry) => entry.id === id) ?? null;
}

/** Names the adapter is allowed to read for a provider. */
export function integrationCredentialNames(
  definition: IntegrationDefinition,
): string[] {
  return definition.credentialFields.map((field) => field.key);
}

/**
 * What the workspace may display. A secret field never carries a value; the
 * identifier field is safe to show (Razorpay key ids are public identifiers and
 * are required by Checkout in the browser).
 */
export interface PublicIntegrationCatalogEntry {
  id: IntegrationProviderId;
  category: IntegrationCategory;
  name: string;
  summary: string;
  capabilities: IntegrationCapabilities;
  fields: { key: string; label: string; kind: "identifier" | "secret" }[];
  webhookEvents: string[];
}

export function publicIntegrationCatalog(): PublicIntegrationCatalogEntry[] {
  return PAYMENT_INTEGRATIONS.map((entry) => ({
    id: entry.id,
    category: entry.category,
    name: entry.name,
    summary: entry.summary,
    capabilities: entry.capabilities,
    fields: entry.credentialFields.map((field) => ({
      key: field.key,
      label: field.label,
      kind: field.kind,
    })),
    webhookEvents: [...entry.webhookEvents],
  }));
}
