/**
 * src/api/admin/inventory-counts/_lib/format.ts
 *
 * Pure helpers shared across endpoints — number formatting + error response
 * shape. No I/O.
 */

import type { ZodError } from "zod";

/**
 * Format the canonical display number for a count.
 *
 * Sequence is shared (`custom_inventory_count_seq` Postgres sequence,
 * START 1000) so numbers are 4+ digits without a year prefix — matching
 * the convention of estimates / orders / invoices.
 */
export function formatCountNumber(seq: number): string {
  return `INVCNT-${seq}`;
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

export function isTerminalStatus(status: string): boolean {
  return ["approved", "rejected", "cancelled"].includes(status);
}
