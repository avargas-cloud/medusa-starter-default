import { computeLandedLines } from "../purchase-orders/landed-allocation";

import {
  applyPlanInTransaction,
  type ApplyResult,
  type TrxLike,
} from "./restatement/apply-plan";
import type { KnexLike } from "./restatement/load-restatement-data";
import {
  buildPlan,
  DEFAULT_ANCHOR_DATE,
  type RestatementPlan,
} from "./restatement/run-restatement";
import { loadVendorBillRevisionSnapshot } from "./vendor-bill-revision";

interface VendorBillReplayRow {
  product_variant_id: string;
}

export interface VendorBillReplayPreview {
  plan: RestatementPlan;
  variantIds: string[];
  currentCogs: number;
  replayedCogs: number;
  cogsDelta: number;
}

export interface ProposedVendorBillCost {
  variantId: string;
  sku: string;
  description: string;
  quantity: number;
  landedUnitCostCents: number;
}

export interface VendorBillCostImpactRow {
  variantId: string;
  sku: string;
  description: string;
  quantity: number;
  landedUnitCostCents: number;
  currentAverageCostCents: number;
  projectedAverageCostCents: number;
  deltaCents: number;
  deltaPercent: number | null;
}

export interface VendorBillConfirmationPreview {
  inputHash: string;
  rows: VendorBillCostImpactRow[];
  cogsDelta: number;
  invoiceLinesChanged: number;
  creditMemoLinesChanged: number;
}

export async function previewVendorBillRemoval(
  knex: KnexLike,
  vendorBillId: string,
  actorUserId?: string | null
): Promise<VendorBillReplayPreview> {
  const { rows } = await knex.raw(
    `SELECT DISTINCT product_variant_id
       FROM vendor_bill_cost_log
      WHERE vendor_bill_id = ? AND reversed_at IS NULL
      ORDER BY product_variant_id`,
    [vendorBillId]
  );
  const variantIds = (rows as VendorBillReplayRow[]).map(
    (row) => row.product_variant_id
  );
  if (variantIds.length === 0) {
    throw new Error("No active cost facts exist for this vendor bill");
  }

  const now = new Date();
  const plan = await buildPlan(knex, {
    runId: `vbr_${vendorBillId}_${now.getTime()}`,
    anchorDate: new Date(DEFAULT_ANCHOR_DATE),
    sourceDataCutoff: now,
    reason: `Replay cost timeline excluding vendor bill ${vendorBillId}`,
    requestedBy: actorUserId ?? null,
    variantIds,
    excludedVendorBillIds: [vendorBillId],
  });

  const currentCogs =
    plan.reconciliation.invoices.originalCogs -
    plan.reconciliation.creditMemos.originalCogs;
  const replayedCogs =
    plan.reconciliation.invoices.restatedCogs -
    plan.reconciliation.creditMemos.restatedCogs;

  return {
    plan,
    variantIds,
    currentCogs,
    replayedCogs,
    cogsDelta: plan.reconciliation.totalCogsDelta,
  };
}

export async function previewVendorBillConfirmation(
  knex: KnexLike,
  vendorBillId: string,
  _proposed: readonly ProposedVendorBillCost[],
  actorUserId?: string | null
): Promise<VendorBillConfirmationPreview> {
  const billResult = await knex.raw(
    `SELECT service_vendor_bill_id, freight_included, freight_amount_cents,
            tariff_included, tariff_amount_cents, tax_amount_cents
       FROM vendor_bill
      WHERE id = ? AND deleted_at IS NULL`,
    [vendorBillId]
  );
  const bill = billResult.rows[0] as
    | {
        service_vendor_bill_id: string | null;
        freight_included: boolean;
        freight_amount_cents: number;
        tariff_included: boolean;
        tariff_amount_cents: number;
        tax_amount_cents: number | string;
      }
    | undefined;
  if (!bill) throw new Error("Vendor bill not found");
  const lineResult = await knex.raw(
    `SELECT l.product_variant_id, l.sku, l.description, l.qty,
            l.unit_cost_cents,
            COALESCE(NULLIF(pv.metadata->>'cbm','')::numeric, l.cbm_per_unit) AS cbm
       FROM vendor_bill_line l
       JOIN product_variant pv ON pv.id = l.product_variant_id
      WHERE l.vendor_bill_id = ? AND l.deleted_at IS NULL
        AND COALESCE(l.line_type, 'product') = 'product'
        AND COALESCE(l.line_kind, 'po_item') <> 'freight_charge'
      ORDER BY l.created_at, l.id`,
    [vendorBillId]
  );
  const sourceLines = lineResult.rows as Array<{
    product_variant_id: string;
    sku: string;
    description: string;
    qty: number | string;
    unit_cost_cents: number | string;
    cbm: number | string | null;
  }>;
  let commissionCents = 0;
  if (bill.service_vendor_bill_id) {
    const serviceResult = await knex.raw(
      `SELECT COALESCE(SUM(landed_unit_cost_cents * qty), 0)::int AS total
         FROM vendor_bill vb
         JOIN vendor_bill_line vbl
           ON vbl.vendor_bill_id = vb.id
          AND vbl.deleted_at IS NULL
        WHERE vb.id = ? AND vb.deleted_at IS NULL
          AND vb.bill_type = 'service'
          AND vb.status IN ('draft', 'confirmed', 'synced')`,
      [bill.service_vendor_bill_id]
    );
    commissionCents = Number(
      (serviceResult.rows[0] as { total: number | string } | undefined)
        ?.total ?? 0
    );
  }
  const allocation = computeLandedLines(
    sourceLines.map((line) => ({
      qty: Number(line.qty),
      unit_cost_cents: Number(line.unit_cost_cents),
      cbm_per_unit: line.cbm === null ? null : Number(line.cbm),
    })),
    {
      commissionCents,
      freightCents: bill.freight_included ? bill.freight_amount_cents : 0,
      tariffCents: bill.tariff_included ? bill.tariff_amount_cents : 0,
      taxCents: Number(bill.tax_amount_cents ?? 0),
    }
  );
  const usable = sourceLines.map((line, index) => {
    const qty = Number(line.qty);
    const alloc = allocation.lines[index]!;
    return {
      variantId: line.product_variant_id,
      sku: line.sku,
      description: line.description,
      quantity: qty,
      /** Integer per-unit — for DISPLAY in the preview table only. */
      landedUnitCostCents: alloc.landed_unit_cost_cents,
      /**
       * Exact per-unit as a real number, derived from the line's exact money.
       * The cost projection MUST use this: the integer above strands up to
       * `qty − 1` cents of every pool, so a preview built on it would show a
       * different average cost than the Confirm that follows it — the confirm
       * route reads `landed_total_cents` directly.
       */
      exactUnitCostCents:
        qty > 0 ? alloc.landed_total_cents / qty : alloc.landed_unit_cost_cents,
    };
  });
  const variantIds = [...new Set(usable.map((row) => row.variantId))];
  if (variantIds.length === 0) {
    throw new Error("No product cost lines are available to preview");
  }

  const receiptRows = await knex.raw(
    `SELECT rl.product_variant_id AS variant_id,
            rl.id AS source_id,
            r.id AS receipt_id,
            r.received_at,
            rl.qty_received_now AS quantity
       FROM purchase_order_receipt_line rl
       JOIN purchase_order_receipt r ON r.id = rl.purchase_order_receipt_id
      WHERE (
          r.vendor_bill_id = ?
          OR r.id = (
            SELECT purchase_order_receipt_id
              FROM vendor_bill
             WHERE id = ? AND deleted_at IS NULL
          )
        )
        AND rl.product_variant_id = ANY(?::text[])
        AND rl.deleted_at IS NULL AND r.deleted_at IS NULL
        AND r.voided_at IS NULL AND rl.qty_received_now > 0
      ORDER BY r.received_at, rl.id`,
    [vendorBillId, vendorBillId, variantIds]
  );
  const proposedByVariant = new Map(usable.map((row) => [row.variantId, row]));
  const now = new Date();
  const replacements = (
    receiptRows.rows as Array<{
      variant_id: string;
      source_id: string;
      receipt_id: string;
      received_at: string;
      quantity: number | string;
    }>
  ).flatMap((receipt) => {
    const row = proposedByVariant.get(receipt.variant_id);
    if (!row) return [];
    return [
      {
        source_id: `preview:${vendorBillId}:${receipt.source_id}`,
        variant_id: receipt.variant_id,
        vendor_bill_id: vendorBillId,
        receipt_id: receipt.receipt_id,
        received_at: receipt.received_at,
        applied_at: now.toISOString(),
        received_qty: Number(receipt.quantity),
        landed_unit_cost_cents: row.exactUnitCostCents,
      },
    ];
  });
  if (replacements.length === 0) {
    throw new Error("This bill has no bound receipt quantities to cost");
  }

  const common = {
    anchorDate: new Date(DEFAULT_ANCHOR_DATE),
    sourceDataCutoff: now,
    requestedBy: actorUserId ?? null,
    variantIds,
  };
  const [baselinePlan, plan] = await Promise.all([
    buildPlan(knex, {
      ...common,
      runId: `vbp_base_${vendorBillId}_${now.getTime()}`,
      reason: `Baseline before previewing vendor bill ${vendorBillId}`,
    }),
    buildPlan(knex, {
      ...common,
      runId: `vbp_${vendorBillId}_${now.getTime()}`,
      reason: `Preview confirmation of vendor bill ${vendorBillId}`,
      excludedVendorBillIds: [vendorBillId],
      replacementCostChanges: replacements,
    }),
  ]);
  const rebuildByVariant = new Map(
    plan.rebuilds.map((rebuild) => [rebuild.variantId, rebuild])
  );
  const baselineByVariant = new Map(
    baselinePlan.rebuilds.map((rebuild) => [
      rebuild.variantId,
      rebuild.finalUnitCostCents,
    ])
  );
  const revisionSnapshot = await loadVendorBillRevisionSnapshot(
    knex,
    vendorBillId
  );

  return {
    inputHash: revisionSnapshot.inputHash,
    rows: usable.map((row) => {
      const current = baselineByVariant.get(row.variantId) ?? 0;
      const projected =
        rebuildByVariant.get(row.variantId)?.finalUnitCostCents ?? current;
      const delta = projected - current;
      return {
        variantId: row.variantId,
        sku: row.sku,
        description: row.description,
        quantity: row.quantity,
        landedUnitCostCents: row.landedUnitCostCents,
        currentAverageCostCents: current,
        projectedAverageCostCents: projected,
        deltaCents: delta,
        deltaPercent: current > 0 ? (delta / current) * 100 : null,
      };
    }),
    cogsDelta: round4(
      plan.reconciliation.totalCogsDelta -
        baselinePlan.reconciliation.totalCogsDelta
    ),
    invoiceLinesChanged: countChangedBetweenPlans(
      baselinePlan.invoiceRestatements,
      plan.invoiceRestatements
    ),
    creditMemoLinesChanged: countChangedBetweenPlans(
      baselinePlan.creditMemoRestatements,
      plan.creditMemoRestatements
    ),
  };
}

function countChangedBetweenPlans(
  baseline: readonly { lineId: string; newRestatedUnitCost: number | null }[],
  proposed: readonly { lineId: string; newRestatedUnitCost: number | null }[]
): number {
  const current = new Map(
    baseline.map((row) => [row.lineId, row.newRestatedUnitCost])
  );
  return proposed.filter(
    (row) => current.get(row.lineId) !== row.newRestatedUnitCost
  ).length;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export async function applyVendorBillRemovalReplay(
  trx: TrxLike,
  preview: VendorBillReplayPreview
): Promise<ApplyResult> {
  await trx.raw(
    `SELECT id
       FROM product_variant
      WHERE id = ANY(?::text[])
      ORDER BY id
      FOR UPDATE`,
    [preview.variantIds]
  );
  const verifiedPlan = await buildPlan(trx, preview.plan.options);
  if (verifiedPlan.inputHash !== preview.plan.inputHash) {
    throw new Error(
      "The cost timeline changed after preview. Refresh the preview before applying."
    );
  }
  return applyPlanInTransaction(trx, verifiedPlan);
}
