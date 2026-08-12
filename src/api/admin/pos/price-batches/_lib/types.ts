/**
 * src/api/admin/pos/price-batches/_lib/types.ts
 * Local shape for a `price_change_line` row as the module service returns it
 * — avoids `any` at the callsites that read lines back (detail + approve).
 */
export interface PriceChangeLineRow {
  id: string;
  batch_id: string;
  variant_id: string;
  product_id: string;
  sku: string | null;
  description: string | null;
  old_cost: number | null;
  new_cost: number | null;
  old_retail: number | null;
  new_retail: number | null;
  old_wholesale: number | null;
  new_wholesale: number | null;
}
