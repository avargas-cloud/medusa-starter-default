/**
 * src/api/admin/purchase-orders/_lib/format.ts
 *
 * Pure helpers — PO + Receipt number formatting + zod error shape.
 * No I/O.
 */

import type { ZodError } from "zod";

/**
 * Canonical display number for a PurchaseOrder — PO-{seq}.
 * Sequence is shared (custom_purchase_order_seq, START 1000), matching
 * the convention of estimates / invoices / inventory counts.
 */
export function formatPoNumber(seq: number): string {
  return `PO-${seq}`;
}

/**
 * Canonical display number for a PurchaseOrderReceipt — RCP-{seq}.
 */
export function formatReceiptNumber(seq: number): string {
  return `RCP-${seq}`;
}

export function zodErrorToBody(err: ZodError): {
  error: string;
  code: "validation_error";
  issues: Array<{ path: string; message: string }>;
} {
  return {
    error: "Invalid request body",
    code: "validation_error",
    issues: err.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
}
