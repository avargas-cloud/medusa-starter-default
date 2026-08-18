/**
 * src/lib/purchase-orders/freight-policy.ts
 *
 * `vendor_bill.freight_allocation_basis` decides which of TWO freight
 * policies a bill's `freight_charge` lines (the opt-in "Add Freight Charges"
 * ExpenseLine, see freight-charge-lines.ts) follow:
 *
 *   NULL     → LEGACY. The freight charge is a pure expense — it ships to
 *              QuickBooks as its own ExpenseLine and is never folded into any
 *              item's `<Cost>`. This is the behavior every bill has always
 *              had, byte for byte — including 2 already-`synced` bills whose
 *              freight_charge line carries a real `qb_txn_line_id` ($8.54 and
 *              $108.98). `BillMod` deletes by omission, so a Mod that stopped
 *              emitting that line without checking the policy would silently
 *              erase it from QuickBooks on the bill's next edit.
 *
 *   non-null → CAPITALIZED. The freight amount is spread across the bill's
 *              product lines (same engine as commission/tariff/tax —
 *              `computeLandedLines`) using the named basis, and the
 *              `freight_charge` line itself is excluded from the QB payload —
 *              its money already rode inside the item cost.
 *
 * This module is PURE (no I/O) — the confirm route and the QB payload
 * builders (ADD + MOD) all call it so the "which policy" decision lives in
 * exactly one place and can never diverge between them.
 */

import type { FreightBasis } from "./landed-allocation";

export type FreightPolicy =
  | { mode: "legacy" }
  | { mode: "capitalized"; basis: FreightBasis; poolCents: number };

const VALID_BASES: ReadonlySet<string> = new Set(["cbm", "units", "value"]);

/**
 * Resolves a bill's freight policy from its stored fields. Pure and
 * synchronous — every caller has already fetched the inputs.
 *
 * Fail-closed: a non-null basis together with a positive
 * `headerFreightAmountCents` throws. That header amount is the pool of the
 * LINKED freight sibling bill (the China-agent path — `freight_included` +
 * `freight_vendor_bill_id`), which `computeLandedLines` already capitalizes
 * unconditionally via the CBM basis. Letting a non-null
 * `freight_allocation_basis` ALSO capitalize the `freight_charge` pool on top
 * of that would double-count the same shipment's freight. Measured: all 90
 * local (non-China) vendor bills carry `header FreightAmountCents === 0`, so
 * this can only fire on a bill that deliberately mixes both mechanisms.
 */
export function resolveFreightPolicy(args: {
  freightAllocationBasis: string | null;
  freightChargeLineAmountsCents: number[];
  headerFreightAmountCents: number;
}): FreightPolicy {
  const {
    freightAllocationBasis,
    freightChargeLineAmountsCents,
    headerFreightAmountCents,
  } = args;

  if (freightAllocationBasis == null) {
    return { mode: "legacy" };
  }

  if (!VALID_BASES.has(freightAllocationBasis)) {
    throw new Error(
      `Invalid freight_allocation_basis: '${freightAllocationBasis}' — must be one of cbm, units, value`
    );
  }

  if (headerFreightAmountCents > 0) {
    throw new Error(
      `Bill has freight_allocation_basis='${freightAllocationBasis}' but also a header ` +
        `freight pool of ${headerFreightAmountCents}c (freight_included + freight_amount_cents, ` +
        `the linked freight-bill path). These are two different freight pools — capitalizing ` +
        `both would double-count. Clear one before confirming.`
    );
  }

  const poolCents = freightChargeLineAmountsCents.reduce((s, c) => s + c, 0);
  return {
    mode: "capitalized",
    basis: freightAllocationBasis as FreightBasis,
    poolCents,
  };
}
