/**
 * resolve-tax-listid.ts
 *
 * Single source of truth that maps a tax mode ('florida' | 'exempt') to the
 * QuickBooks SalesTaxItem ListID configured in env vars (QB_TAX_ITEM_LISTID_TAXED
 * and QB_TAX_ITEM_LISTID_EXEMPT, exposed via getQbConfig()).
 *
 * Used by the API routes that persist tax decisions on documents
 * (pos_invoice, pos_credit_memo, order.metadata) — the resolved ListID is
 * stored alongside the existing tax math so the QB pipeline can read it
 * directly without re-deriving from order.tax_total at handler time.
 */

import type { QbOrderConfig } from "./qb-config";

export type TaxMode = "florida" | "exempt";

/**
 * Returns the QB SalesTaxItem ListID for the given tax mode, or `null` when
 * the env var is not configured. Callers must treat `null` as "fall back to
 * legacy FullName behavior" — never persist `null` if you can avoid it.
 */
export function resolveTaxListid(
  mode: TaxMode,
  config: Pick<QbOrderConfig, "taxItemListidTaxed" | "taxItemListidExempt">
): string | null {
  if (mode === "exempt") {
    return config.taxItemListidExempt ?? null;
  }
  return config.taxItemListidTaxed ?? null;
}
