/**
 * ═══ APPROVED INR CREDIT PACKAGES CONFIGURATION ════════════════════════════════
 *
 * These are stable product identifiers and display names. Prices and credit
 * quantities come from the server-owned billing catalog at runtime.
 *
 * Do not scatter package values across multiple components. This file serves as
 * the single editable source of truth for credit top-up packages.
 */

export interface CreditPackage {
  id: string;
  name: string;
}

export const PROVISIONAL_CREDIT_PACKAGES: CreditPackage[] = [
  { id: "starter-pack", name: "Starter Pack" },
  { id: "growth-pack", name: "Growth Pack" },
  { id: "power-pack", name: "Power Pack" },
];
