/**
 * src/api/admin/unmet-demand/_lib/format.ts
 *
 * Pure helpers — record numbering + zod error shape. No I/O.
 */

import type { ZodError } from "zod";

/**
 * Canonical display number for an unmet-demand record — UMD-{seq}.
 * Sequence is shared (custom_unmet_demand_seq, START 1000), matching the
 * convention of estimates / invoices / inventory counts.
 */
export function formatUnmetDemandNumber(seq: number): string {
  return `UMD-${seq}`;
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
