/**
 * src/api/admin/purchase-orders/[id]/receipts/[receiptId]/vendor-bill/confirm/route.ts
 *
 * POST /admin/purchase-orders/:id/receipts/:receiptId/vendor-bill/confirm
 *
 * Confirms a draft vendor bill and calculates per-unit landed costs:
 *   1. Fetches vendor_bill_lines
 *   2. Reads cbm from product_variant.metadata for each variant
 *   3. Distributes commission / freight / tariff to each line
 *   4. Updates vendor_bill_line rows with calculated breakdowns
 *   5. Sets vendor_bill.status = 'confirmed'
 *   6. Updates product_variant.metadata.avg_landed_cost_cents for each variant
 *
 * Freight is distributed proportionally by CBM (volume).
 * Tariff is distributed proportionally by cost (value).
 * Commission (percent) is per-unit cost × rate; (fixed) is split evenly by qty.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getActorUserId, UnauthenticatedError } from "../../../../../_lib/auth";
import { getPurchaseOrdersService } from "../../../../../_lib/service-resolver";

// ── Typed shapes ─────────────────────────────────────────────────────────────

interface VendorBillRow {
  id: string;
  status: string;
  purchase_order_id: string;
  purchase_order_receipt_id: string;
  commission_mode: string;
  commission_rate_bps: number;
  commission_amount_cents: number;
  freight_included: boolean;
  freight_amount_cents: number;
  tariff_included: boolean;
  tariff_amount_cents: number;
}

interface VendorBillLineRow {
  id: string;
  product_variant_id: string;
  qty: number;
  unit_cost_cents: number;
}

interface VariantMetadataRow {
  metadata: Record<string, unknown> | null;
}

// ── Knex type (resolved from container) ──────────────────────────────────────
// We access pg directly because product_variant lives in a different Medusa
// module and there is no cross-module service available here.

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

// ── POST handler ─────────────────────────────────────────────────────────────

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let userId: string;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id: poId, receiptId } = req.params as {
    id: string;
    receiptId: string;
  };

  const service = getPurchaseOrdersService(req);

  // 1. Validate receipt belongs to PO
  const receipt = (await service
    .retrievePurchaseOrderReceipt(receiptId)
    .catch(() => null)) as unknown as { id: string; purchase_order_id: string } | null;

  if (!receipt) {
    return res.status(404).json({ error: "Receipt not found", code: "not_found" });
  }
  if (receipt.purchase_order_id !== poId) {
    return res.status(400).json({
      error: "Receipt does not belong to this purchase order",
      code: "receipt_mismatch",
    });
  }

  // 2. Fetch vendor bill (must exist and be draft)
  const bills = (await service.listVendorBills(
    { purchase_order_receipt_id: receiptId },
    { take: 1 }
  )) as unknown as VendorBillRow[];

  const bill = bills[0];
  if (!bill) {
    return res.status(404).json({
      error: "Vendor bill not found — create it first",
      code: "not_found",
    });
  }
  if (bill.status !== "draft") {
    return res.status(409).json({
      error: `Vendor bill is already in status '${bill.status}'`,
      code: "not_draft",
    });
  }

  // 3. Fetch vendor bill lines
  const lines = (await service.listVendorBillLines(
    { vendor_bill_id: bill.id },
    { take: 1000 }
  )) as unknown as VendorBillLineRow[];

  if (lines.length === 0) {
    return res.status(422).json({
      error: "Vendor bill has no lines",
      code: "no_lines",
    });
  }

  // 4. Fetch CBM from product_variant.metadata for each unique variant
  const knex = resolveKnex(req);
  const uniqueVariantIds = [...new Set(lines.map((l) => l.product_variant_id))];

  const cbmByVariantId = new Map<string, number | null>();
  await Promise.all(
    uniqueVariantIds.map(async (variantId) => {
      const result = await knex.raw(
        `SELECT metadata FROM product_variant WHERE id = $1 AND deleted_at IS NULL`,
        [variantId]
      );
      const row = (result.rows[0] ?? null) as VariantMetadataRow | null;
      const cbm =
        row?.metadata?.cbm !== undefined && row.metadata.cbm !== null
          ? Number(row.metadata.cbm)
          : null;
      cbmByVariantId.set(variantId, isNaN(cbm as number) ? null : cbm);
    })
  );

  // 5. Compute aggregates for distribution
  let totalCbm = 0;
  let totalSubtotalCents = 0;
  let totalQty = 0;

  for (const line of lines) {
    const cbm = cbmByVariantId.get(line.product_variant_id) ?? null;
    if (cbm !== null) {
      totalCbm += cbm * line.qty;
    }
    totalSubtotalCents += line.unit_cost_cents * line.qty;
    totalQty += line.qty;
  }

  // 6. Calculate per-unit cost components for each line
  type LineUpdate = {
    id: string;
    cbm_per_unit: number | null;
    commission_per_unit_cents: number;
    freight_per_unit_cents: number;
    tariff_per_unit_cents: number;
    landed_unit_cost_cents: number;
  };

  const lineUpdates: LineUpdate[] = lines.map((line) => {
    const cbm = cbmByVariantId.get(line.product_variant_id) ?? null;

    // Commission
    let commissionPerUnit: number;
    if (bill.commission_mode === "percent") {
      commissionPerUnit = Math.round(
        (line.unit_cost_cents * bill.commission_rate_bps) / 10_000
      );
    } else {
      // fixed: split evenly by unit count
      commissionPerUnit =
        totalQty > 0
          ? Math.round(bill.commission_amount_cents / totalQty)
          : 0;
    }

    // Freight — CBM-weighted
    let freightPerUnit = 0;
    if (
      bill.freight_included &&
      totalCbm > 0 &&
      cbm !== null
    ) {
      freightPerUnit = Math.round(
        (cbm / totalCbm) * bill.freight_amount_cents
      );
    }

    // Tariff — cost-weighted
    let tariffPerUnit = 0;
    if (bill.tariff_included && totalSubtotalCents > 0) {
      tariffPerUnit = Math.round(
        (line.unit_cost_cents / totalSubtotalCents) *
          bill.tariff_amount_cents
      );
    }

    const landedUnitCost =
      line.unit_cost_cents +
      commissionPerUnit +
      freightPerUnit +
      tariffPerUnit;

    return {
      id: line.id,
      cbm_per_unit: cbm,
      commission_per_unit_cents: commissionPerUnit,
      freight_per_unit_cents: freightPerUnit,
      tariff_per_unit_cents: tariffPerUnit,
      landed_unit_cost_cents: landedUnitCost,
    };
  });

  // 7. Persist line updates
  await Promise.all(
    lineUpdates.map(({ id, ...fields }) =>
      service.updateVendorBillLines({ id }, fields)
    )
  );

  // 8. Mark bill as confirmed
  await service.updateVendorBills(
    { id: bill.id },
    {
      status: "confirmed",
      confirmed_at: new Date(),
      confirmed_by_user_id: userId,
    }
  );

  // 9. Update product_variant.metadata.avg_landed_cost_cents for each variant
  //    Group lines by variant and compute weighted average
  const landedByVariant = new Map<string, { totalLanded: number; totalQty: number }>();
  for (const update of lineUpdates) {
    const line = lines.find((l) => l.id === update.id)!;
    const existing = landedByVariant.get(line.product_variant_id) ?? {
      totalLanded: 0,
      totalQty: 0,
    };
    landedByVariant.set(line.product_variant_id, {
      totalLanded: existing.totalLanded + update.landed_unit_cost_cents * line.qty,
      totalQty: existing.totalQty + line.qty,
    });
  }

  await Promise.all(
    [...landedByVariant.entries()].map(([variantId, { totalLanded, totalQty: vQty }]) => {
      const avgLandedCost = vQty > 0 ? totalLanded / vQty : 0;
      return knex.raw(
        `UPDATE product_variant
         SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('avg_landed_cost_cents', $1::float),
             updated_at = NOW()
         WHERE id = $2`,
        [avgLandedCost, variantId]
      );
    })
  );

  // 10. Return confirmed bill with updated lines
  const confirmedBill = await service.listVendorBills(
    { id: bill.id },
    { take: 1 }
  );
  const confirmedLines = await service.listVendorBillLines(
    { vendor_bill_id: bill.id },
    { take: 1000 }
  );

  return res.json({
    vendor_bill: {
      ...(confirmedBill[0] ?? {}),
      lines: confirmedLines,
    },
  });
}
