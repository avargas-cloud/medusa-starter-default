/**
 * receipt-stock-warnings.ts
 *
 * Shared shape and wording for the two stock conditions that editing or
 * deleting a PurchaseOrderReceipt can produce.
 *
 * POLICY (owner decision, 2026-08-04): neither condition blocks. A receipt
 * records what physically arrived; if the paperwork was wrong, correcting it
 * must not be gated on whether the units are still on the shelf. Units that
 * left between receiving and the correction are an inventory discrepancy, and
 * an inventory count is the instrument that resolves those — refusing the edit
 * just freezes a receipt everyone knows is wrong while the count still has to
 * happen anyway.
 *
 * So negative stock is ALLOWED and reported. Both conditions were hard throws
 * until this date; the reversal is deliberate, and the warning is the whole
 * remaining safety mechanism — it must reach the operator's screen, or the
 * change amounts to removing the guard and saying nothing.
 *
 * Note both conditions overlap (with reserved ≥ 0, negative stock is always
 * also below reserved). `buildStockWarning` emits at most ONE warning per
 * line, picking the more severe, so a single edit never reports the same unit
 * twice.
 */

export type ReceiptStockWarningCode =
  | "stock_goes_negative"
  | "stock_below_reserved";

export interface ReceiptStockWarning {
  code: ReceiptStockWarningCode;
  receipt_line_id: string;
  inventory_item_id: string;
  sku: string | null;
  stock_before: number;
  stock_after: number;
  reserved: number;
  message: string;
}

export interface BuildStockWarningInput {
  receipt_line_id: string;
  inventory_item_id: string;
  sku: string | null;
  stock_before: number;
  stock_after: number;
  reserved: number;
}

/**
 * Returns the warning for a line's resulting stock position, or null when the
 * position is unremarkable (stays at or above the reserved floor).
 */
export function buildStockWarning(
  input: BuildStockWarningInput
): ReceiptStockWarning | null {
  const label = input.sku ? `${input.sku}: ` : "";

  if (input.stock_after < 0) {
    return {
      ...input,
      code: "stock_goes_negative",
      message: `${label}stock at this location goes to ${input.stock_after} (was ${input.stock_before}). ${Math.abs(input.stock_after)} unit(s) were already sold or transferred. Correct it with an inventory count.`,
    };
  }

  if (input.stock_after < input.reserved) {
    return {
      ...input,
      code: "stock_below_reserved",
      message: `${label}stock goes to ${input.stock_after}, below the ${input.reserved} unit(s) reserved for open orders. Availability will read negative until the reservation is fulfilled or an inventory count corrects it.`,
    };
  }

  return null;
}
