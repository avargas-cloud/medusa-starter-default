/**
 * Single source of truth for "which steps belong to the Sales Pipeline tab".
 *
 * The QB pipeline UI splits `qb_order_pipeline` across several tabs. The Sales
 * Pipeline tab shows everything EXCEPT the steps that own a dedicated tab of
 * their own. Both the row listing and the header status badges must apply the
 * exact same scope — when they drift, the badge reports failures the user cannot
 * find in the list ("Failed 5" above a single row, caused by four failed
 * `vendor_bill_add` rows belonging to the Purchase Pipeline tab).
 *
 * Import from here in BOTH call sites rather than re-typing the list.
 */

/** Steps surfaced by the Purchase Pipeline tab. */
export const PURCHASE_PIPELINE_STEPS = [
  "purchase_order_mod",
  "item_receipt_add",
  "item_receipt_mod",
  "vendor_bill_add",
  "vendor_bill_mod",
  "vendor_bill_rebuild_preflight",
  "vendor_bill_rebuild_delete",
] as const;

/** Steps surfaced by the Inventory Adjustments tab. */
export const INVENTORY_ADJUSTMENT_STEPS = [
  "inventory_adjustment",
  "void_inventory_adjustment",
] as const;

/** Steps surfaced by the Customer Sync tab. */
export const CUSTOMER_SYNC_STEPS = ["customer_data_ext"] as const;

/**
 * Every step that has its own tab — and therefore must be excluded from both the
 * Sales Pipeline listing and its status badges.
 */
export const SALES_PIPELINE_EXCLUDED_STEPS: string[] = [
  ...CUSTOMER_SYNC_STEPS,
  ...INVENTORY_ADJUSTMENT_STEPS,
  ...PURCHASE_PIPELINE_STEPS,
];

/**
 * Builds the SQL predicate restricting a query to Sales Pipeline steps.
 *
 * Pass `SALES_PIPELINE_EXCLUDED_STEPS` as the value for `paramIndex`.
 *
 * @param paramIndex 1-based placeholder position of the excluded-steps array.
 * @param alias Optional table alias (the listing query aliases the table `p`).
 */
export function salesPipelineStepScopeSql(
  paramIndex: number,
  alias?: string
): string {
  const prefix = alias ? `${alias}.` : "";
  return `${prefix}step <> ALL($${paramIndex}::text[])`;
}
