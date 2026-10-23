/**
 * ═══ PROVISIONAL CREDIT PACKAGES CONFIGURATION ═════════════════════════════════
 *
 * NOTE: The prices and credit quantities below are provisional placeholders
 * for product planning and UI implementation. They are NOT approved final
 * commercial prices and require business/commercial approval before real payment
 * processing and production billing are enabled.
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
  { id: "pack-1", name: "Pack 1", credits: 50, priceINR: 199, isProvisional: true },
  { id: "pack-2", name: "Pack 2", credits: 200, priceINR: 499, isProvisional: true },
  { id: "pack-3", name: "Pack 3", credits: 350, priceINR: 799, isProvisional: true },
  { id: "pack-4", name: "Pack 4", credits: 500, priceINR: 999, isProvisional: true },
  { id: "pack-5", name: "Pack 5", credits: 800, priceINR: 1499, isProvisional: true },
  { id: "pack-6", name: "Pack 6", credits: 1200, priceINR: 1999, isProvisional: true },
  { id: "pack-7", name: "Pack 7", credits: 1600, priceINR: 2499, isProvisional: true },
  { id: "pack-8", name: "Pack 8", credits: 2000, priceINR: 2999, isProvisional: true },
  { id: "pack-9", name: "Pack 9", credits: 3000, priceINR: 3999, isProvisional: true },
  { id: "pack-10", name: "Pack 10", credits: 4000, priceINR: 4999, isProvisional: true },
];
