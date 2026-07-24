/**
 * src/lib/cost/restatement/rebuild-timeline.ts
 *
 * Rebuilds each variant's cost-basis timeline: an opening anchor plus one cost
 * event per landed-cost receipt, chained through the AVCO engine.
 *
 * THE ANCHOR. On 2026-04-14 the QuickBooks catalog load wrote each variant's
 * `qb_avg_cost` — QuickBooks Desktop's own average, which for these items
 * already carries freight, agent commission and duty. That value is provably
 * still the original: the earliest frozen COGS snapshot on every China SKU
 * (`pos_invoice_item.average_unit_cost`, 2026-04-14) equals today's
 * `qb_avg_cost` to the last decimal, because the QB average-cost sync has only
 * ever run with scope='non_china'. So the anchor is not a guess — it is the
 * untouched opening balance, and everything after it is reconstructible.
 *
 * EFFECTIVE DATE = `received_at`, NOT the bill-confirm date. Cost attaches to
 * inventory when control of the goods is obtained; the vendor bill that arrives
 * 6.4 days later (max 20) only reveals what that cost was. Using the confirm
 * date would price 224 invoice lines / 530 units at a stale cost for goods that
 * were physically in the building. `recorded_at` keeps the confirm date, so the
 * distinction between "when it was true" and "when we learned it" survives.
 *
 * WHAT IS DELIBERATELY IGNORED from `vendor_bill_cost_log`: its stored
 * `prev_avg_cost_cents` and `new_avg_cost_cents`. Those are the corrupted
 * output of the old formula — the whole reason this rebuild exists. Only the
 * OBSERVED facts are reused: how many units arrived and what one landed unit
 * cost. Quantities on hand come from the movement ledger, not from the log's
 * `prev_qty_on_hand`, so a bad capture cannot propagate.
 */

import {
  applyReceiptToAvco,
  roundCents,
  type AvcoStepResult,
} from "../avco";
import {
  quantityBefore,
  type VariantTimeline,
} from "./movement-ledger";

/** A landed-cost receipt that should move a variant's carrying cost. */
export interface CostChangeEvent {
  variantId: string;
  /** Economic date the cost attaches (the receipt's `received_at`). */
  effectiveAt: Date;
  /** When the vendor bill was confirmed and the amount became known. */
  recordedAt: Date;
  /** Units this bill accounts for on this variant. */
  quantity: number;
  /** Fully-landed cost of one unit, in cents (factory + commission + freight + duty). */
  landedUnitCostCents: number;
  vendorBillId: string;
  receiptId: string | null;
  /** Row id in `vendor_bill_cost_log` — the audit join key. */
  sourceId: string;
}

export interface RebuiltCostEvent {
  variantId: string;
  sku: string | null;
  eventType: "opening_balance" | "vendor_bill_receipt";
  effectiveAt: Date;
  recordedAt: Date;
  economicSequence: number;
  previousUnitCostCents: number | null;
  newUnitCostCents: number;
  quantityOnHandBefore: number;
  quantityOnHandAfter: number;
  quantityDelta: number;
  inventoryValueDeltaCents: number;
  cogsTrueUpCents: number;
  negativeSettledQuantity: number;
  vendorBillId: string | null;
  receiptId: string | null;
  sourceId: string | null;
  /** Deterministic — identical inputs always produce this same key. */
  idempotencyKey: string;
}

export type RebuildExceptionCode =
  | "missing_anchor_cost"
  | "nonpositive_anchor_cost"
  | "negative_opening_quantity"
  | "receipt_not_in_ledger"
  | "quantity_mismatch"
  | "negative_inventory_settled"
  | "no_movement_timeline";

export interface RebuildException {
  variantId: string;
  sku: string | null;
  code: RebuildExceptionCode;
  detail: string;
}

export interface VariantRebuild {
  variantId: string;
  sku: string | null;
  anchorUnitCostCents: number;
  openingQuantity: number;
  events: RebuiltCostEvent[];
  finalUnitCostCents: number;
  endingQuantity: number;
  exceptions: RebuildException[];
}

export interface RebuildVariantInput {
  variantId: string;
  sku: string | null;
  /** QuickBooks' average cost at the catalog load, in cents. */
  anchorUnitCostCents: number | null;
  anchorDate: Date;
  openingQuantity: number;
  currentQuantity: number;
  timeline: VariantTimeline | undefined;
  costChanges: readonly CostChangeEvent[];
  methodologyVersion: string;
}

/**
 * Rebuild one variant. Pure: same inputs -> same events, same order, same ids.
 * Nothing here reads the database or the clock.
 */
export function rebuildVariantTimeline(input: RebuildVariantInput): VariantRebuild {
  const exceptions: RebuildException[] = [];
  const push = (code: RebuildExceptionCode, detail: string) =>
    exceptions.push({ variantId: input.variantId, sku: input.sku, code, detail });

  if (input.anchorUnitCostCents === null) {
    push("missing_anchor_cost", "variant has no qb_avg_cost to anchor on");
  } else if (input.anchorUnitCostCents <= 0) {
    push("nonpositive_anchor_cost", `qb_avg_cost resolves to ${input.anchorUnitCostCents} cents`);
  }
  if (!input.timeline) {
    push("no_movement_timeline", "no movements found in the Miami pool");
  }
  if (input.openingQuantity < 0) {
    push(
      "negative_opening_quantity",
      `opening solves to ${input.openingQuantity} units — a movement source is missing`
    );
  }

  const anchorCents = input.anchorUnitCostCents ?? 0;
  const events: RebuiltCostEvent[] = [];
  let sequence = 0;

  // --- Event 0: the opening balance. Establishes the basis, moves nothing. ---
  events.push({
    variantId: input.variantId,
    sku: input.sku,
    eventType: "opening_balance",
    effectiveAt: input.anchorDate,
    recordedAt: input.anchorDate,
    economicSequence: sequence++,
    previousUnitCostCents: null,
    newUnitCostCents: anchorCents,
    quantityOnHandBefore: input.openingQuantity,
    quantityOnHandAfter: input.openingQuantity,
    quantityDelta: 0,
    inventoryValueDeltaCents: 0,
    cogsTrueUpCents: 0,
    negativeSettledQuantity: 0,
    vendorBillId: null,
    receiptId: null,
    sourceId: null,
    idempotencyKey: `restatement:${input.methodologyVersion}:anchor:${input.variantId}`,
  });

  // Chronological by economic date. Ties break on the source id so a rerun
  // cannot reorder two events that share a timestamp.
  const ordered = [...input.costChanges].sort((a, b) => {
    const delta = a.effectiveAt.getTime() - b.effectiveAt.getTime();
    return delta !== 0 ? delta : a.sourceId.localeCompare(b.sourceId);
  });

  let runningCost: number | null = anchorCents > 0 ? anchorCents : null;

  for (const change of ordered) {
    // Quantity on hand comes from the reconstructed ledger, never from the
    // log's own `prev_qty_on_hand` — that capture is per-location and unverified.
    const qBefore = resolveQuantityBefore(input, change);
    if (qBefore === null) {
      push(
        "receipt_not_in_ledger",
        `bill ${change.vendorBillId} @ ${change.effectiveAt.toISOString()} has no matching movement`
      );
    }
    const quantityOnHandBefore = qBefore ?? 0;

    const step: AvcoStepResult = applyReceiptToAvco(runningCost, {
      quantity: change.quantity,
      landedUnitCostCents: change.landedUnitCostCents,
      quantityOnHandBefore,
    });

    if (step.negativeSettledQuantity > 0) {
      push(
        "negative_inventory_settled",
        `${step.negativeSettledQuantity} oversold units settled against bill ${change.vendorBillId}; ` +
          `COGS true-up ${step.cogsTrueUpCents} cents`
      );
    }

    events.push({
      variantId: input.variantId,
      sku: input.sku,
      eventType: "vendor_bill_receipt",
      effectiveAt: change.effectiveAt,
      recordedAt: change.recordedAt,
      economicSequence: sequence++,
      previousUnitCostCents: step.previousAvgCostCents,
      newUnitCostCents: step.newAvgCostCents,
      quantityOnHandBefore,
      quantityOnHandAfter: step.quantityOnHandAfter,
      quantityDelta: change.quantity,
      inventoryValueDeltaCents: step.inventoryValueDeltaCents,
      cogsTrueUpCents: step.cogsTrueUpCents,
      negativeSettledQuantity: step.negativeSettledQuantity,
      vendorBillId: change.vendorBillId,
      receiptId: change.receiptId,
      sourceId: change.sourceId,
      idempotencyKey: `restatement:${input.methodologyVersion}:bill:${change.sourceId}`,
    });

    runningCost = step.newAvgCostCents;
  }

  return {
    variantId: input.variantId,
    sku: input.sku,
    anchorUnitCostCents: anchorCents,
    openingQuantity: input.openingQuantity,
    events,
    finalUnitCostCents: runningCost ?? anchorCents,
    endingQuantity: input.currentQuantity,
    exceptions,
  };
}

/**
 * Pool quantity immediately before a cost event. Prefers walking the ledger to
 * the receipt's own movement row; falls back to summing every movement strictly
 * earlier than the effective date when the receipt line cannot be pinpointed
 * (a bill covering several receipt lines of the same variant).
 */
function resolveQuantityBefore(
  input: RebuildVariantInput,
  change: CostChangeEvent
): number | null {
  const timeline = input.timeline;
  if (!timeline) return null;

  if (change.receiptId) {
    const exact = quantityBefore(timeline, input.openingQuantity, change.receiptId);
    if (exact !== null) return exact;
  }

  // Date-based fallback: everything that happened strictly BEFORE this instant.
  // Movements sharing the exact timestamp are excluded, which keeps a receipt
  // from counting itself.
  const cutoff = change.effectiveAt.getTime();
  let running = input.openingQuantity;
  let sawAny = false;
  for (const movement of timeline.movements) {
    if (movement.effectiveAt.getTime() >= cutoff) break;
    running += movement.quantityDelta;
    sawAny = true;
  }
  return sawAny || timeline.movements.length > 0 ? running : null;
}

/**
 * The unit cost in effect for a variant on a given date: the newest event whose
 * effective date is at or before it. This is what prices a historical sale.
 *
 * Events must be the output of `rebuildVariantTimeline` (already in economic
 * order). Returns null when the date precedes the anchor — a sale older than
 * the opening balance cannot be priced from this timeline and must be reported
 * rather than guessed.
 */
export function costInEffectAt(
  events: readonly RebuiltCostEvent[],
  at: Date
): RebuiltCostEvent | null {
  const target = at.getTime();
  let winner: RebuiltCostEvent | null = null;
  for (const event of events) {
    if (event.effectiveAt.getTime() <= target) winner = event;
    else break;
  }
  return winner;
}

/** Cents -> the dollars that `metadata.average_cost` stores. */
export function centsToDollars(cents: number): number {
  return roundCents(cents) / 100;
}
