/**
 * src/lib/cost/restatement/run-restatement.ts
 *
 * Orchestrates the restatement: build a plan from frozen inputs, then apply it.
 *
 * THE CONTRACT
 *  - `buildPlan` is pure with respect to the database: it reads, it never
 *    writes. A dry-run and an apply run the SAME `buildPlan`, so what is
 *    reported is exactly what gets written.
 *  - Identical inputs produce an identical `inputHash` and byte-identical
 *    events, adjustments and totals. Re-running an applied plan is a verified
 *    no-op, not a second correction stacked on the first.
 *  - Every write is compare-and-swap against the value the plan was built from.
 *    If a row moved underneath the run, the transaction aborts rather than
 *    clobbering someone else's change.
 */

import { createHash } from "crypto";

import {
  hasAdjustmentTable,
  loadCostChanges,
  loadCreditMemoLines,
  loadInvoiceLines,
  loadScope,
  type CostChangeRow,
  type KnexLike,
  type SaleLineRow,
  type ScopeVariantRow,
} from "./load-restatement-data";
import {
  groupMovements,
  solveOpeningQuantity,
  type MovementLedgerRow,
  type VariantTimeline,
  MOVEMENT_LEDGER_SQL,
} from "./movement-ledger";
import {
  rebuildVariantTimeline,
  type RebuildException,
  type RebuiltCostEvent,
  type VariantRebuild,
} from "./rebuild-timeline";
import {
  restateCreditMemoLines,
  restateInvoiceLines,
  summarizeRestatements,
  type SaleLineInput,
  type SaleRestatement,
} from "./restate-sales";

export const METHODOLOGY_VERSION = "china-avco-v1";
/** The QuickBooks catalog load — the opening balance of the reconstruction. */
export const DEFAULT_ANCHOR_DATE = "2026-04-14T00:00:00.000Z";

export interface RestatementOptions {
  runId: string;
  anchorDate: Date;
  sourceDataCutoff: Date;
  reason: string;
  requestedBy?: string | null;
  /** Optional incremental replay scope. Omitted by the original full rebuild. */
  variantIds?: readonly string[];
  /** Facts to omit from the projection, e.g. a bill being reopened/cancelled. */
  excludedVendorBillIds?: readonly string[];
  /** Proposed facts used by confirmation preview before they exist in the log. */
  replacementCostChanges?: readonly CostChangeRow[];
}

export interface RestatementPlan {
  options: RestatementOptions;
  methodologyVersion: string;
  inputHash: string;
  rebuilds: VariantRebuild[];
  invoiceRestatements: SaleRestatement[];
  creditMemoRestatements: SaleRestatement[];
  exceptions: RebuildException[];
  reconciliation: Reconciliation;
}

export interface Reconciliation {
  variantsInScope: number;
  variantsWithAnchor: number;
  costEvents: number;
  /** Miami pool, valued at the rebuilt final cost vs. the cost stored today. */
  inventoryValueBeforeCents: number;
  inventoryValueAfterCents: number;
  inventoryDeltaCents: number;
  /** Units in the China Warehouse — NOT valued at the Miami landed average. */
  chinaWarehouseUnits: number;
  cogsTrueUpCents: number;
  invoices: ReturnType<typeof summarizeRestatements>;
  creditMemos: ReturnType<typeof summarizeRestatements>;
  totalCogsDelta: number;
  exceptionsByCode: Record<string, number>;
}

const num = (raw: unknown): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
};
const parseCost = (raw: string | null): number | null => {
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/** Read everything, rebuild every timeline, price every sale. No writes. */
export async function buildPlan(
  knex: KnexLike,
  options: RestatementOptions
): Promise<RestatementPlan> {
  const cutoff = options.sourceDataCutoff;
  const includedVariantIds = options.variantIds ?? [];
  // Absent before the restatement migration runs — a dry run must still work.
  const adjustmentTableExists = await hasAdjustmentTable(knex);

  const [scope, costChangeRows, invoiceRows, creditMemoRows, movementResult] =
    await Promise.all([
      loadScope(knex, includedVariantIds),
      loadCostChanges(knex, cutoff),
      loadInvoiceLines(knex, cutoff, adjustmentTableExists, includedVariantIds),
      loadCreditMemoLines(
        knex,
        cutoff,
        adjustmentTableExists,
        includedVariantIds
      ),
      knex.raw(MOVEMENT_LEDGER_SQL, [
        [...includedVariantIds],
        cutoff.toISOString(),
      ]),
    ]);

  const variantFilter = options.variantIds?.length
    ? new Set(options.variantIds)
    : null;
  const excludedBills = new Set(options.excludedVendorBillIds ?? []);
  const scopedVariants = variantFilter
    ? scope.filter((row) => variantFilter.has(row.variant_id))
    : scope;
  const scopedChanges = [
    ...costChangeRows.filter(
      (row) =>
        (!variantFilter || variantFilter.has(row.variant_id)) &&
        !excludedBills.has(row.vendor_bill_id)
    ),
    ...(options.replacementCostChanges ?? []).filter(
      (row) => !variantFilter || variantFilter.has(row.variant_id)
    ),
  ];
  const scopedInvoices = variantFilter
    ? invoiceRows.filter(
        (row) => row.variant_id && variantFilter.has(row.variant_id)
      )
    : invoiceRows;
  const scopedCreditMemos = variantFilter
    ? creditMemoRows.filter(
        (row) => row.variant_id && variantFilter.has(row.variant_id)
      )
    : creditMemoRows;
  const movementRows = variantFilter
    ? (movementResult.rows as MovementLedgerRow[]).filter((row) =>
        variantFilter.has(row.variant_id)
      )
    : (movementResult.rows as MovementLedgerRow[]);

  const timelines = groupMovements(movementRows);
  const changesByVariant = groupCostChanges(scopedChanges);

  const rebuilds: VariantRebuild[] = [];
  const exceptions: RebuildException[] = [];
  const eventsByVariant = new Map<string, RebuiltCostEvent[]>();

  let inventoryBeforeCents = 0;
  let inventoryAfterCents = 0;
  let chinaWarehouseUnits = 0;
  let cogsTrueUpCents = 0;
  let variantsWithAnchor = 0;

  for (const row of scopedVariants) {
    const timeline: VariantTimeline | undefined = timelines.get(row.variant_id);
    const currentQuantity = num(row.miami_qty);
    chinaWarehouseUnits += num(row.china_qty);

    const anchorDollars = parseCost(row.qb_avg_cost);
    const anchorCents =
      anchorDollars === null ? null : Math.round(anchorDollars * 100);
    if (anchorCents !== null && anchorCents > 0) variantsWithAnchor++;

    const { openingQuantity } = timeline
      ? solveOpeningQuantity(timeline, currentQuantity)
      : { openingQuantity: currentQuantity };

    const rebuild = rebuildVariantTimeline({
      variantId: row.variant_id,
      sku: row.sku,
      anchorUnitCostCents: anchorCents,
      anchorDate: options.anchorDate,
      openingQuantity,
      currentQuantity,
      timeline,
      costChanges: changesByVariant.get(row.variant_id) ?? [],
      methodologyVersion: METHODOLOGY_VERSION,
    });

    rebuilds.push(rebuild);
    exceptions.push(...rebuild.exceptions);
    eventsByVariant.set(row.variant_id, rebuild.events);

    // Inventory revaluation, on the Miami pool only. Negative stock contributes
    // nothing to carrying value — you cannot hold a negative asset.
    const valuedQty = Math.max(0, currentQuantity);
    const storedCost = parseCost(row.average_cost);
    inventoryBeforeCents += valuedQty * Math.round((storedCost ?? 0) * 100);
    inventoryAfterCents += valuedQty * rebuild.finalUnitCostCents;
    cogsTrueUpCents += rebuild.events.reduce(
      (sum, e) => sum + e.cogsTrueUpCents,
      0
    );
  }

  // --- Price the sales. Invoices first: returns mirror them. ---
  const invoiceLines = scopedInvoices.map(toSaleLineInput);
  const invoiceRestatements = restateInvoiceLines(
    invoiceLines,
    eventsByVariant
  );

  const restatedInvoiceCosts = new Map<string, number>();
  for (const result of invoiceRestatements) {
    if (result.newRestatedUnitCost !== null) {
      restatedInvoiceCosts.set(result.lineId, result.newRestatedUnitCost);
    }
  }

  const creditMemoLines = scopedCreditMemos.map(toSaleLineInput);
  const creditMemoRestatements = restateCreditMemoLines(
    creditMemoLines,
    eventsByVariant,
    restatedInvoiceCosts
  );

  const invoiceSummary = summarizeRestatements(invoiceRestatements);
  const creditMemoSummary = summarizeRestatements(creditMemoRestatements);

  const exceptionsByCode: Record<string, number> = {};
  for (const exception of exceptions) {
    exceptionsByCode[exception.code] =
      (exceptionsByCode[exception.code] ?? 0) + 1;
  }

  const reconciliation: Reconciliation = {
    variantsInScope: scopedVariants.length,
    variantsWithAnchor,
    costEvents: rebuilds.reduce((sum, r) => sum + r.events.length, 0),
    inventoryValueBeforeCents: inventoryBeforeCents,
    inventoryValueAfterCents: inventoryAfterCents,
    inventoryDeltaCents: inventoryAfterCents - inventoryBeforeCents,
    chinaWarehouseUnits,
    cogsTrueUpCents,
    invoices: invoiceSummary,
    creditMemos: creditMemoSummary,
    // A return REDUCES COGS, so its delta subtracts from the sales restatement.
    totalCogsDelta:
      Math.round(
        (invoiceSummary.deltaCogs - creditMemoSummary.deltaCogs) * 10_000
      ) / 10_000,
    exceptionsByCode,
  };

  return {
    options,
    methodologyVersion: METHODOLOGY_VERSION,
    inputHash: hashInputs(
      scopedVariants,
      scopedChanges,
      scopedInvoices,
      scopedCreditMemos
    ),
    rebuilds,
    invoiceRestatements,
    creditMemoRestatements,
    exceptions,
    reconciliation,
  };
}

function toSaleLineInput(row: SaleLineRow): SaleLineInput {
  return {
    lineId: row.line_id,
    documentId: row.document_id,
    variantId: row.variant_id,
    sku: row.sku,
    quantity: num(row.quantity),
    currentUnitCost: parseCost(row.average_unit_cost),
    originalUnitCost: parseCost(row.original_unit_cost),
    economicPostedAt: new Date(row.economic_posted_at),
    parentInvoiceLineId: row.parent_invoice_line_id,
  };
}

function groupCostChanges(rows: readonly CostChangeRow[]) {
  const byVariant = new Map<string, ReturnType<typeof toCostChange>[]>();
  for (const row of rows) {
    const list = byVariant.get(row.variant_id) ?? [];
    list.push(toCostChange(row));
    byVariant.set(row.variant_id, list);
  }
  return byVariant;
}

function toCostChange(row: CostChangeRow) {
  // received_at is the economic date; if the anchor receipt is gone (voided or
  // deleted) the confirm date is the only date left, and the missing link shows
  // up downstream as a `receipt_not_in_ledger` exception.
  const receivedAt = row.received_at
    ? new Date(row.received_at)
    : new Date(row.applied_at);
  return {
    variantId: row.variant_id,
    effectiveAt: receivedAt,
    recordedAt: new Date(row.applied_at),
    quantity: num(row.received_qty),
    landedUnitCostCents: num(row.landed_unit_cost_cents),
    vendorBillId: row.vendor_bill_id,
    receiptId: row.receipt_id,
    sourceId: row.source_id,
  };
}

/**
 * Content hash of the frozen inputs. A dry-run and its apply MUST produce the
 * same hash; a difference means the source data moved and the plan is stale.
 *
 * It covers only what DETERMINES the plan — the anchor, the pool quantity, the
 * landed-cost receipts, and each line's identity, quantity and economic date.
 *
 * It deliberately does NOT include `average_unit_cost`. That column is an
 * OUTPUT of the run, not an input to it: the restated cost is derived purely
 * from the timeline. Hashing it made the value change the moment the run
 * applied, so a second apply saw a different hash and reported "the source data
 * moved" when nothing had — breaking the very no-op guarantee the hash exists
 * to provide. The prior cost still gates every write, but as the
 * compare-and-swap expectation, which is a per-row check rather than a
 * plan-identity one.
 */
function hashInputs(
  scope: readonly ScopeVariantRow[],
  costChanges: readonly CostChangeRow[],
  invoiceLines: readonly SaleLineRow[],
  creditMemoLines: readonly SaleLineRow[]
): string {
  const hash = createHash("sha256");
  for (const row of scope) {
    hash.update(`v|${row.variant_id}|${row.qb_avg_cost}|${row.miami_qty}\n`);
  }
  for (const row of costChanges) {
    hash.update(
      `c|${row.source_id}|${row.received_qty}|${row.landed_unit_cost_cents}\n`
    );
  }
  for (const row of invoiceLines) {
    hash.update(`i|${row.line_id}|${row.quantity}|${row.economic_posted_at}\n`);
  }
  for (const row of creditMemoLines) {
    hash.update(
      `m|${row.line_id}|${row.quantity}|${row.economic_posted_at}|${row.parent_invoice_line_id}\n`
    );
  }
  return hash.digest("hex");
}
