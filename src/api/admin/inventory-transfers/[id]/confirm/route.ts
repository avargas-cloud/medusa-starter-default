/**
 * src/api/admin/inventory-transfers/[id]/confirm/route.ts
 *
 * POST /admin/inventory-transfers/:id/confirm
 *
 * Transitions: draft → confirmed
 * Side effect: creates a linked PurchaseOrder in `submitted` status via the
 *              PurchaseOrdersModuleService.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { generateEntityId } from "@medusajs/utils";
import { getActorUserId, UnauthenticatedError } from "../../../purchase-orders/_lib/auth";
import { PURCHASE_ORDERS_MODULE } from "../../../../../modules/purchase-orders";

// ── Knex type ─────────────────────────────────────────────────────────────────

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

// ── Row interfaces ────────────────────────────────────────────────────────────

interface TransferRow {
  id: string;
  number: string | null;
  status: string;
  destination_location_id: string;
  vendor_id: string | null;
  vendor_name_snapshot: string | null;
  linked_purchase_order_id: string | null;
}

interface TransferLineRow {
  id: string;
  transfer_id: string;
  product_variant_id: string;
  sku: string;
  description: string;
  qty: number;
  unit_cost_cents: number;
}

interface PurchaseOrdersService {
  getNextPoSequence: () => Promise<number>;
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let userId: string;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const knex = resolveKnex(req);

  // 1. Load transfer
  const transferResult = await knex.raw(
    `SELECT id, number, status, destination_location_id, vendor_id, vendor_name_snapshot, linked_purchase_order_id
     FROM inventory_transfer WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const transfer = (transferResult.rows[0] ?? null) as TransferRow | null;
  if (!transfer) {
    return res
      .status(404)
      .json({ error: "Inventory transfer not found", code: "not_found" });
  }
  if (transfer.status !== "draft") {
    return res.status(409).json({
      error: `Only draft transfers can be confirmed (current status: ${transfer.status})`,
      code: "not_draft",
    });
  }

  // 2. Load lines
  const linesResult = await knex.raw(
    `SELECT * FROM inventory_transfer_line
     WHERE transfer_id = ? AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    [id]
  );
  const lines = linesResult.rows as TransferLineRow[];

  // 3. Validate at least 1 line with qty > 0
  const activeLines = lines.filter((l) => l.qty > 0);
  if (activeLines.length === 0) {
    return res.status(400).json({
      error: "Transfer must have at least one line with qty > 0 to confirm",
      code: "no_lines",
    });
  }

  // 4. Resolve QB vendor list ID — required by the receive route guard
  // (`Submitted PO is missing vendor snapshot / number — resubmit first.`)
  let vendorQbListId: string | null = null;
  if (transfer.vendor_id) {
    const qbv = await knex.raw(
      `SELECT qb_list_id FROM qb_vendor WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [transfer.vendor_id]
    );
    vendorQbListId =
      (qbv.rows[0] as { qb_list_id: string | null } | undefined)?.qb_list_id ??
      null;
  }

  // 5. Resolve inventory_item_id per variant — IT lines don't capture it
  // and PO line + receive workflow both require it for stock adjust.
  const variantIds = activeLines.map((l) => l.product_variant_id);
  const variantToItem = new Map<string, string>();
  if (variantIds.length > 0) {
    const placeholders = variantIds.map(() => "?").join(",");
    const itemRes = await knex.raw(
      `SELECT variant_id, inventory_item_id
         FROM product_variant_inventory_item
        WHERE variant_id IN (${placeholders})`,
      variantIds
    );
    for (const row of itemRes.rows as Array<{
      variant_id: string;
      inventory_item_id: string;
    }>) {
      variantToItem.set(row.variant_id, row.inventory_item_id);
    }
  }
  const missing = variantIds.filter((v) => !variantToItem.has(v));
  if (missing.length > 0) {
    return res.status(400).json({
      error: `Missing inventory_item link for variants: ${missing.join(", ")}`,
      code: "missing_inventory_item",
    });
  }

  // 6. Allocate PO sequence via service
  const poService = (
    req.scope as unknown as { resolve: (k: string) => unknown }
  ).resolve(PURCHASE_ORDERS_MODULE) as PurchaseOrdersService;

  const poSeq = await poService.getNextPoSequence();
  const poNumber = `PO-${poSeq}`;
  const poId = generateEntityId("", "po");
  const now = new Date().toISOString();

  const poMemo = `Transfer ${transfer.number ?? id} from China`;

  // 7. Insert PurchaseOrder header
  await knex.raw(
    `INSERT INTO purchase_order (
      id, number, seq, status,
      vendor_id, vendor_name_snapshot, vendor_qb_list_id_snapshot,
      stock_location_id,
      memo,
      submitted_at, submitted_by_user_id,
      created_by_user_id,
      subtotal_cents, tax_cents, shipping_cents, other_fees_cents, total_cents,
      total_lines, total_units_ordered, total_units_received,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, 'submitted',
      ?, ?, ?,
      ?,
      ?,
      NOW(), ?,
      ?,
      0, 0, 0, 0, 0,
      0, 0, 0,
      ?, ?
    )`,
    [
      poId, poNumber, poSeq,
      transfer.vendor_id ?? null, transfer.vendor_name_snapshot ?? null,
      vendorQbListId,
      transfer.destination_location_id,
      poMemo,
      userId,
      userId,
      now, now,
    ]
  );

  // 6. Insert PurchaseOrder lines
  let poSubtotalCents = 0;
  let poTotalUnits = 0;

  for (let i = 0; i < activeLines.length; i++) {
    const line = activeLines[i]!;
    const polId = generateEntityId("", "pol");
    const totalCents = line.qty * line.unit_cost_cents;
    poSubtotalCents += totalCents;
    poTotalUnits += line.qty;

    const lineInventoryItemId = variantToItem.get(line.product_variant_id)!;
    await knex.raw(
      `INSERT INTO purchase_order_line (
        id, purchase_order_id, product_variant_id, inventory_item_id,
        sku_snapshot, description_snapshot,
        qty_ordered, qty_received, qty_cancelled,
        unit_cost_cents, tax_cents, total_cents,
        status, line_order,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?,
        ?, 0, 0,
        ?, 0, ?,
        'open', ?,
        ?, ?
      )`,
      [
        polId, poId, line.product_variant_id, lineInventoryItemId,
        line.sku, line.description,
        line.qty,
        line.unit_cost_cents, totalCents,
        i,
        now, now,
      ]
    );
  }

  // 7. Update PO totals
  await knex.raw(
    `UPDATE purchase_order
     SET subtotal_cents = ?, total_cents = ?, total_lines = ?, total_units_ordered = ?, updated_at = ?
     WHERE id = ?`,
    [poSubtotalCents, poSubtotalCents, activeLines.length, poTotalUnits, now, poId]
  );

  // 8. Update transfer to confirmed
  await knex.raw(
    `UPDATE inventory_transfer
     SET status = 'confirmed',
         confirmed_at = NOW(),
         confirmed_by_user_id = ?,
         linked_purchase_order_id = ?,
         updated_at = ?
     WHERE id = ?`,
    [userId, poId, now, id]
  );

  // 9. Return updated transfer
  const updatedResult = await knex.raw(
    `SELECT * FROM inventory_transfer WHERE id = ?`,
    [id]
  );

  return res.json({
    transfer: { ...(updatedResult.rows[0] as object), lines: activeLines },
    purchase_order_id: poId,
  });
}
