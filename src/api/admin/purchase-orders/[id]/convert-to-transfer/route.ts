/**
 * src/api/admin/purchase-orders/[id]/convert-to-transfer/route.ts
 *
 * POST /admin/purchase-orders/:id/convert-to-transfer
 *
 * Retroactively creates an InventoryTransfer (status = 'confirmed') linked to
 * an existing PurchaseOrder so China stock accounting stays correct.
 *
 * Background: a regular PO created via /purchase-orders/new (instead of from
 * /inventory-transfers/new) never registers China-side reservations. When the
 * PO is later received in Miami, `onPoReceiveApplied` looks up a linked IT
 * and, finding none, silently skips the China decrement. Result: the same
 * units are counted in both China and Miami (phantom inventory).
 *
 * This route fixes that *before* any reception happens by attaching an IT
 * after the fact. The IT is created in `confirmed` status with full China
 * reservations rebuilt; the operator must still hit the IT's Ship endpoint
 * before any PO receipt is allowed (existing /receive route guard).
 *
 * Guards:
 *   - PO status ∈ {submitted, partially_received}
 *   - PO.total_units_received == 0   ← caller must delete any existing
 *                                      receipts first; that flow already
 *                                      contra-applies Miami stock.
 *   - No active IT already linked to this PO.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { generateEntityId } from "@medusajs/utils";

import { getActorUserId, UnauthenticatedError } from "../../_lib/auth";
import { rebuildTransferChinaReservations } from "../../../../../lib/inventory-transfer-reservations";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../../../../workflows/sync-inventory-item-meilisearch";

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

interface PoRow {
  id: string;
  number: string | null;
  status: string;
  stock_location_id: string;
  vendor_id: string | null;
  vendor_name_snapshot: string | null;
  reference_number: string | null;
  expected_at: string | null;
  total_units_received: number;
}

interface PoLineRow {
  id: string;
  product_variant_id: string;
  sku_snapshot: string;
  description_snapshot: string;
  qty_ordered: number;
  qty_cancelled: number;
  unit_cost_cents: number;
  status: string;
}

interface LinkedItRow {
  id: string;
  number: string | null;
  status: string;
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

  const { id: poId } = req.params as { id: string };
  const knex = resolveKnex(req);

  // 1. Load PO
  const poResult = await knex.raw(
    `SELECT id, number, status, stock_location_id, vendor_id, vendor_name_snapshot,
            reference_number, expected_at, total_units_received
       FROM purchase_order
      WHERE id = ? AND deleted_at IS NULL`,
    [poId]
  );
  const po = (poResult.rows[0] ?? null) as PoRow | null;
  if (!po) {
    return res
      .status(404)
      .json({ error: "Purchase order not found", code: "not_found" });
  }

  // 2. Validate PO status
  if (po.status !== "submitted" && po.status !== "partially_received") {
    return res.status(409).json({
      error: `Cannot convert a PO in status '${po.status}'. Must be 'submitted' or 'partially_received'.`,
      code: "not_convertible",
    });
  }

  // 3. Reject if any receipt already exists. The operator must delete every
  //    receipt first (that flow already contra-applies Miami stock + recomputes
  //    PO counters) so we can rebuild reservations from a clean slate.
  if (po.total_units_received > 0) {
    return res.status(409).json({
      error:
        "PO already has receipts. Delete all item receipts before converting to a transfer.",
      code: "has_receipts",
    });
  }

  // 4. Reject if an active (non-voided) IT is already linked.
  const existingItResult = await knex.raw(
    `SELECT id, number, status
       FROM inventory_transfer
      WHERE linked_purchase_order_id = ?
        AND status <> 'voided'
        AND deleted_at IS NULL
      LIMIT 1`,
    [poId]
  );
  const existingIt = (existingItResult.rows[0] ?? null) as LinkedItRow | null;
  if (existingIt) {
    return res.status(409).json({
      error: `PO is already linked to ${existingIt.number ?? existingIt.id} (status: ${existingIt.status}).`,
      code: "already_linked",
      inventory_transfer_id: existingIt.id,
    });
  }

  // 5. Load PO lines. Skip lines that are cancelled or have zero remaining qty
  //    after cancellation (those don't belong in the IT).
  const linesResult = await knex.raw(
    `SELECT id, product_variant_id, sku_snapshot, description_snapshot,
            qty_ordered, qty_cancelled, unit_cost_cents, status
       FROM purchase_order_line
      WHERE purchase_order_id = ? AND deleted_at IS NULL
      ORDER BY line_order ASC, created_at ASC`,
    [poId]
  );
  const poLines = linesResult.rows as PoLineRow[];

  interface ItLineDraft {
    product_variant_id: string;
    sku: string;
    description: string;
    qty: number;
    unit_cost_cents: number;
  }
  const itLines: ItLineDraft[] = [];
  for (const line of poLines) {
    if (line.status === "cancelled") continue;
    const qty = line.qty_ordered - line.qty_cancelled;
    if (qty <= 0) continue;
    itLines.push({
      product_variant_id: line.product_variant_id,
      sku: line.sku_snapshot,
      description: line.description_snapshot,
      qty,
      unit_cost_cents: line.unit_cost_cents,
    });
  }

  if (itLines.length === 0) {
    return res.status(400).json({
      error: "Purchase order has no active lines with remaining qty to transfer.",
      code: "no_lines",
    });
  }

  // 6. Allocate IT sequence + ids
  const seqResult = await knex.raw(
    `SELECT nextval('custom_inventory_transfer_seq') AS seq`
  );
  const seq = Number((seqResult.rows[0] as { seq: string | number }).seq);
  const itNumber = `IT-${seq}`;
  const transferId = generateEntityId("", "it");
  const now = new Date().toISOString();

  // 7. Aggregates for header
  const totalLines = itLines.length;
  const totalUnits = itLines.reduce((s, l) => s + l.qty, 0);
  const subtotalCents = itLines.reduce(
    (s, l) => s + l.qty * l.unit_cost_cents,
    0
  );

  // 8. Insert IT header (status = 'confirmed' — China reservations are made
  //    immediately; operator hits /ship before /receive on the PO).
  await knex.raw(
    `INSERT INTO inventory_transfer (
      id, number, seq, status, origin_country, destination_location_id,
      vendor_id, vendor_name_snapshot, linked_purchase_order_id,
      reference_number, notes, expected_arrival_at,
      total_lines, total_units, subtotal_cents,
      created_by_user_id, confirmed_at, confirmed_by_user_id,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, 'confirmed', 'CN', ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?
    )`,
    [
      transferId,
      itNumber,
      seq,
      po.stock_location_id,
      po.vendor_id ?? null,
      po.vendor_name_snapshot ?? null,
      po.id,
      po.reference_number ?? null,
      `Converted from ${po.number ?? po.id}`,
      po.expected_at ?? null,
      totalLines,
      totalUnits,
      subtotalCents,
      userId,
      now,
      userId,
      now,
      now,
    ]
  );

  // 9. Insert IT lines
  for (const line of itLines) {
    await knex.raw(
      `INSERT INTO inventory_transfer_line (
        id, transfer_id, product_variant_id, sku, description,
        qty, unit_cost_cents, qty_received,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        generateEntityId("", "itl"),
        transferId,
        line.product_variant_id,
        line.sku,
        line.description,
        line.qty,
        line.unit_cost_cents,
        now,
        now,
      ]
    );
  }

  // 10. Build China reservations now that the IT is live. Idempotent — but we
  //     already guard against double-link above.
  const touchedInventoryItemIds = await rebuildTransferChinaReservations(
    knex,
    transferId,
    po.id
  );

  // 11. Reindex Meili so China availability widgets reflect the new reservation.
  await Promise.allSettled(
    touchedInventoryItemIds.map((inventoryItemId) =>
      syncInventoryItemToMeiliSearchWorkflow(req.scope).run({
        input: { inventoryItemId },
      })
    )
  );

  // 12. Return the freshly created IT + linked PO id
  const transferResult = await knex.raw(
    `SELECT * FROM inventory_transfer WHERE id = ?`,
    [transferId]
  );
  const itLinesResult = await knex.raw(
    `SELECT * FROM inventory_transfer_line
      WHERE transfer_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC`,
    [transferId]
  );

  return res.status(201).json({
    transfer: {
      ...(transferResult.rows[0] as object),
      lines: itLinesResult.rows,
    },
    purchase_order_id: po.id,
  });
}
