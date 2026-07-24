/**
 * src/lib/cost/restatement/restate-sales.ts
 *
 * Prices every historical sale line against the rebuilt cost timeline and emits
 * the before/after adjustment records.
 *
 * TWO DIFFERENT RULES, and getting them confused invents profit:
 *
 *   • An INVOICE line is priced at the cost in effect on the invoice's economic
 *     date (`issued_at`). That is the whole point of the restatement — a sale in
 *     May must carry May's cost basis, not whatever the average drifted to in
 *     July.
 *
 *   • A CREDIT MEMO line is priced at the cost of the ORIGINAL SALE it reverses,
 *     NOT at the cost in effect on the return date. A return sends specific
 *     units back; reversing them at a different cost than they were issued at
 *     fabricates a gain or loss out of nothing. Sell at $20, average drifts to
 *     $27, customer returns the item: crediting $27 of COGS would book a
 *     phantom $7 profit on a transaction where the customer simply got their
 *     money back.
 *
 * Only when a credit memo has no traceable parent sale line does it fall back to
 * the return-date cost — and that fallback is reported as an exception, never
 * applied silently.
 */

import { costInEffectAt, type RebuiltCostEvent } from "./rebuild-timeline";

export interface SaleLineInput {
  lineId: string;
  documentId: string;
  variantId: string | null;
  sku: string | null;
  quantity: number;
  /** The frozen cost currently on the line, in dollars. Null when never set. */
  currentUnitCost: number | null;
  /**
   * The value the line carried before ANY restatement touched it. Null on a
   * line that has never been restated — the caller then captures
   * `currentUnitCost` as the original. Never overwritten by a later run.
   */
  originalUnitCost: number | null;
  /** Economic date: `issued_at` for an invoice, `completed_at` for a memo. */
  economicPostedAt: Date;
  /** Credit-memo lines only: the parent invoice line whose cost they reverse. */
  parentInvoiceLineId: string | null;
}

export type SaleRestatementCode =
  | "priced_from_timeline"
  | "priced_from_parent_sale"
  | "orphan_return_priced_at_return_date"
  | "predates_anchor"
  | "no_timeline"
  | "unchanged";

export interface SaleRestatement {
  lineId: string;
  documentId: string;
  sourceType: "invoice_item" | "credit_memo_item";
  variantId: string | null;
  sku: string | null;
  quantity: number;
  originalUnitCost: number | null;
  priorRestatedUnitCost: number | null;
  newRestatedUnitCost: number | null;
  originalExtendedCogs: number | null;
  newExtendedCogs: number | null;
  deltaCogs: number;
  costEventKey: string | null;
  economicPostedAt: Date;
  reasonCode: SaleRestatementCode;
  derivedFromLineId: string | null;
  changed: boolean;
}

const DOLLAR_EPSILON = 0.000_05;

/** Cents -> dollars, rounded to the 4 decimals the adjustment table stores. */
function toDollars(cents: number): number {
  return Math.round(cents * 100) / 10_000;
}

/**
 * Price a batch of invoice lines. `timelines` maps variant id to that variant's
 * rebuilt events; a variant with no timeline yields a reported exception rather
 * than an invented cost.
 */
export function restateInvoiceLines(
  lines: readonly SaleLineInput[],
  timelines: ReadonlyMap<string, readonly RebuiltCostEvent[]>
): SaleRestatement[] {
  return lines.map((line) => {
    const events = line.variantId ? timelines.get(line.variantId) : undefined;

    if (!events || events.length === 0) {
      return buildResult(line, "invoice_item", null, "no_timeline", null, null);
    }

    const event = costInEffectAt(events, line.economicPostedAt);
    if (!event) {
      // The sale predates the opening anchor. The anchor cost is still the best
      // available basis, but the caller must see that it was extrapolated
      // backwards rather than derived.
      const anchor = events[0];
      if (!anchor) {
        return buildResult(line, "invoice_item", null, "no_timeline", null, null);
      }
      return buildResult(
        line,
        "invoice_item",
        toDollars(anchor.newUnitCostCents),
        "predates_anchor",
        anchor.idempotencyKey,
        null
      );
    }

    return buildResult(
      line,
      "invoice_item",
      toDollars(event.newUnitCostCents),
      "priced_from_timeline",
      event.idempotencyKey,
      null
    );
  });
}

/**
 * Price credit-memo lines. `restatedInvoiceCosts` maps an invoice line id to the
 * cost this same run assigned it — so a return always mirrors its sale, even
 * when both are being restated in the same pass.
 */
export function restateCreditMemoLines(
  lines: readonly SaleLineInput[],
  timelines: ReadonlyMap<string, readonly RebuiltCostEvent[]>,
  restatedInvoiceCosts: ReadonlyMap<string, number>
): SaleRestatement[] {
  return lines.map((line) => {
    // Rule 1: mirror the original sale.
    if (line.parentInvoiceLineId) {
      const parentCost = restatedInvoiceCosts.get(line.parentInvoiceLineId);
      if (parentCost !== undefined) {
        return buildResult(
          line,
          "credit_memo_item",
          parentCost,
          "priced_from_parent_sale",
          null,
          line.parentInvoiceLineId
        );
      }
    }

    // Rule 2 (fallback): no traceable sale. Price at the return date and say so.
    const events = line.variantId ? timelines.get(line.variantId) : undefined;
    if (!events || events.length === 0) {
      return buildResult(line, "credit_memo_item", null, "no_timeline", null, null);
    }

    const event = costInEffectAt(events, line.economicPostedAt) ?? events[0];
    if (!event) {
      return buildResult(line, "credit_memo_item", null, "no_timeline", null, null);
    }
    return buildResult(
      line,
      "credit_memo_item",
      toDollars(event.newUnitCostCents),
      "orphan_return_priced_at_return_date",
      event.idempotencyKey,
      null
    );
  });
}

function buildResult(
  line: SaleLineInput,
  sourceType: "invoice_item" | "credit_memo_item",
  newUnitCost: number | null,
  reasonCode: SaleRestatementCode,
  costEventKey: string | null,
  derivedFromLineId: string | null
): SaleRestatement {
  // Captured once, on first restatement, and carried forward untouched after.
  const originalUnitCost = line.originalUnitCost ?? line.currentUnitCost;
  const priorRestatedUnitCost = line.currentUnitCost;

  // A restated cost of zero is never a real cost — it is a variant with no
  // QuickBooks anchor and no vendor bill, whose timeline resolves to nothing.
  // Writing it would zero out the COGS on a real sale and turn the whole line
  // into pure profit. Leave the existing snapshot alone and report it.
  if (newUnitCost !== null && newUnitCost <= 0) {
    return {
      lineId: line.lineId,
      documentId: line.documentId,
      sourceType,
      variantId: line.variantId,
      sku: line.sku,
      quantity: line.quantity,
      originalUnitCost,
      priorRestatedUnitCost,
      newRestatedUnitCost: null,
      originalExtendedCogs:
        originalUnitCost === null ? null : round4(originalUnitCost * line.quantity),
      newExtendedCogs: null,
      deltaCogs: 0,
      costEventKey: null,
      economicPostedAt: line.economicPostedAt,
      reasonCode: "no_timeline",
      derivedFromLineId: null,
      changed: false,
    };
  }

  const originalExtendedCogs =
    originalUnitCost === null ? null : round4(originalUnitCost * line.quantity);
  const newExtendedCogs = newUnitCost === null ? null : round4(newUnitCost * line.quantity);

  const changed =
    newUnitCost !== null &&
    (priorRestatedUnitCost === null ||
      Math.abs(newUnitCost - priorRestatedUnitCost) > DOLLAR_EPSILON);

  return {
    lineId: line.lineId,
    documentId: line.documentId,
    sourceType,
    variantId: line.variantId,
    sku: line.sku,
    quantity: line.quantity,
    originalUnitCost,
    priorRestatedUnitCost,
    newRestatedUnitCost: newUnitCost,
    originalExtendedCogs,
    newExtendedCogs,
    deltaCogs:
      newExtendedCogs === null || priorRestatedUnitCost === null
        ? newExtendedCogs === null
          ? 0
          : round4(newExtendedCogs)
        : round4(newExtendedCogs - priorRestatedUnitCost * line.quantity),
    costEventKey,
    economicPostedAt: line.economicPostedAt,
    reasonCode: changed ? reasonCode : "unchanged",
    derivedFromLineId,
    changed,
  };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Roll a set of restatements up into the totals an accountant signs off on. */
export function summarizeRestatements(results: readonly SaleRestatement[]): {
  lines: number;
  changedLines: number;
  originalCogs: number;
  restatedCogs: number;
  deltaCogs: number;
  byReason: Record<string, number>;
} {
  let originalCogs = 0;
  let restatedCogs = 0;
  let deltaCogs = 0;
  let changedLines = 0;
  const byReason: Record<string, number> = {};

  for (const result of results) {
    byReason[result.reasonCode] = (byReason[result.reasonCode] ?? 0) + 1;
    if (result.changed) changedLines++;
    const priorExtended =
      result.priorRestatedUnitCost === null
        ? 0
        : result.priorRestatedUnitCost * result.quantity;
    originalCogs += priorExtended;
    // A line the run refused to touch still carries its existing cost. Counting
    // it only on the "before" side would make the two totals cover different
    // populations, and the accountant's tie-out would never close.
    restatedCogs += result.newExtendedCogs ?? priorExtended;
    deltaCogs += result.deltaCogs;
  }

  return {
    lines: results.length,
    changedLines,
    originalCogs: round4(originalCogs),
    restatedCogs: round4(restatedCogs),
    deltaCogs: round4(deltaCogs),
    byReason,
  };
}
