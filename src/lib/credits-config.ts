/**
 * ═══ APPROVED INR CREDIT PACKAGES CONFIGURATION ════════════════════════════════
 *
 * These are the final locked credit top-up packages. Prices are INR only and
 * credit quantities match the approved commercial catalogue. They drive the
 * credit top-up UI and the package identity passed to checkout.
 *
 * Do not scatter package values across multiple components. This file serves as
 * the single editable source of truth for credit top-up packages.
 */

export interface CreditPackage {
  id: string;
  name: string;
  credits: number;
  priceINR: number;
  isProvisional: boolean;
}

export const PROVISIONAL_CREDIT_PACKAGES: CreditPackage[] = [
  { id: "pack-1", name: "Pack 1", credits: 90, priceINR: 199, isProvisional: false },
  { id: "pack-2", name: "Pack 2", credits: 225, priceINR: 499, isProvisional: false },
  { id: "pack-3", name: "Pack 3", credits: 360, priceINR: 799, isProvisional: false },
  { id: "pack-4", name: "Pack 4", credits: 450, priceINR: 999, isProvisional: false },
  { id: "pack-5", name: "Pack 5", credits: 675, priceINR: 1499, isProvisional: false },
  { id: "pack-6", name: "Pack 6", credits: 900, priceINR: 1999, isProvisional: false },
  { id: "pack-7", name: "Pack 7", credits: 1125, priceINR: 2499, isProvisional: false },
  { id: "pack-8", name: "Pack 8", credits: 1350, priceINR: 2999, isProvisional: false },
  { id: "pack-9", name: "Pack 9", credits: 1800, priceINR: 3999, isProvisional: false },
  { id: "pack-10", name: "Pack 10", credits: 2250, priceINR: 4999, isProvisional: false },
];
