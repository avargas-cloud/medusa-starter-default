import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

/**
 * GET /admin/pos/china-product-history
 *
 * China-warehouse movement history for one variant (mirror of the Miami
 * `product-history` endpoint, but scoped to the China stock location). Sources:
 *   - fo_receipts   (+qty)  factory_order_receipt_line @ China, status applied
 *   - transfers_out (−qty)  inventory_transfer_line shipped OUT of China (origin CN)
 *   - adjustments   (±delta) china_adjustment_line (manual recounts), non-voided
 * Plus current China state + a walked-back beginning balance for the period.
 *
 * Query: variant_id (required), inventory_item_id (optional — resolved from the
 * variant if omitted; adjustments key on inventory_item_id), period.
 */

const CHINA_LOCATION_ID = "sloc_01KQ14C1CFX30EDD722BF87HDM";
const STORE_EPOCH = "2026-04-14T00:00:00.000Z";

type HistoryPeriod = "all" | "this_year" | "last_year";
type RawConnection = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

const toInt = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { variant_id, inventory_item_id: iidRaw, period: periodRaw } =
    req.query as Record<string, string>;

  if (!variant_id) {
    return res.status(400).json({ error: "variant_id is required" });
  }

  const period: HistoryPeriod =
    periodRaw === "all" || periodRaw === "last_year" ? periodRaw : "this_year";
  const currentYear = new Date().getUTCFullYear();
  const targetYear = period === "last_year" ? currentYear - 1 : currentYear;
  const periodStart =
    period === "all"
      ? STORE_EPOCH
      : new Date(Date.UTC(targetYear, 0, 1)).toISOString();
  const periodEnd =
    period === "all"
      ? null
      : new Date(Date.UTC(targetYear + 1, 0, 1)).toISOString();

  const upper = (col: string): { clause: string; bind: string[] } =>
    periodEnd
      ? { clause: `AND ${col} >= ? AND ${col} < ?`, bind: [periodStart, periodEnd] }
      : { clause: `AND ${col} >= ?`, bind: [periodStart] };

  const pg = req.scope.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as RawConnection;

  // Resolve inventory_item_id from the variant when not supplied (adjustments key on it).
  let inventoryItemId = typeof iidRaw === "string" && iidRaw ? iidRaw : "";
  if (!inventoryItemId) {
    const r = await pg.raw(
      `SELECT inventory_item_id FROM product_variant_inventory_item
        WHERE variant_id = ? AND deleted_at IS NULL LIMIT 1`,
      [variant_id]
    );
    inventoryItemId = String((r.rows[0] as { inventory_item_id?: string })?.inventory_item_id ?? "");
  }

  const foUp = upper("fore.received_at");
  const trUp = upper("it.shipped_at");
  const adjUp = upper("ca.created_at");

  const [foRes, trRes, adjRes, stateRes, openRes] = await Promise.all([
    // FO receipts INTO China (+qty)
    pg.raw(
      `SELECT fore.id AS receipt_id, fore.number AS receipt_number, fore.received_at,
              fo.id AS fo_id, fo.number AS fo_number, SUM(forl.qty_received_now)::int AS qty
         FROM factory_order_receipt_line forl
         JOIN factory_order_receipt fore ON fore.id = forl.factory_order_receipt_id
         JOIN factory_order fo ON fo.id = forl.factory_order_id
        WHERE forl.deleted_at IS NULL AND fore.deleted_at IS NULL
          AND fore.status = 'applied' AND fore.voided_at IS NULL
          AND fore.stock_location_id = ?
          AND forl.product_variant_id = ?
          AND COALESCE(forl.qty_received_now, 0) <> 0
          ${foUp.clause}
        GROUP BY fore.id, fore.number, fore.received_at, fo.id, fo.number
        ORDER BY fore.received_at ASC`,
      [CHINA_LOCATION_ID, variant_id, ...foUp.bind]
    ),
    // Transfers shipped OUT of China (−qty) — carry the linked PO so the ledger
    // can offer BOTH an IT link and a PO link on each transfer row.
    pg.raw(
      `SELECT it.id AS transfer_id, it.number AS transfer_number, it.shipped_at,
              it.received_at, it.linked_purchase_order_id AS po_id, po.number AS po_number,
              SUM(itl.qty)::int AS qty,
              SUM(COALESCE(itl.qty_received, 0))::int AS qty_received
         FROM inventory_transfer_line itl
         JOIN inventory_transfer it ON it.id = itl.transfer_id
         LEFT JOIN purchase_order po ON po.id = it.linked_purchase_order_id AND po.deleted_at IS NULL
        WHERE itl.deleted_at IS NULL AND it.deleted_at IS NULL
          AND it.origin_country = 'CN' AND it.voided_at IS NULL
          AND it.shipped_at IS NOT NULL
          AND itl.product_variant_id = ?
          ${trUp.clause}
        GROUP BY it.id, it.number, it.shipped_at, it.received_at,
                 it.linked_purchase_order_id, po.number
        ORDER BY it.shipped_at ASC`,
      [variant_id, ...trUp.bind]
    ),
    // Manual China adjustments (±delta)
    inventoryItemId
      ? pg.raw(
          `SELECT ca.id, ca.notes, ca.created_at, ca.void_reason,
                  cl.old_qty, cl.new_qty, cl.delta
             FROM china_adjustment_line cl
             JOIN china_adjustment ca ON ca.id = cl.china_adjustment_id
            WHERE ca.voided_at IS NULL
              AND cl.inventory_item_id = ?
              AND COALESCE(cl.delta, 0) <> 0
              ${adjUp.clause}
            ORDER BY ca.created_at ASC`,
          [inventoryItemId, ...adjUp.bind]
        )
      : Promise.resolve({ rows: [] as unknown[] }),
    // Current China state
    inventoryItemId
      ? pg.raw(
          `SELECT stocked_quantity, reserved_quantity
             FROM inventory_level
            WHERE inventory_item_id = ? AND location_id = ? AND deleted_at IS NULL`,
          [inventoryItemId, CHINA_LOCATION_ID]
        )
      : Promise.resolve({ rows: [] as unknown[] }),
    // OPEN transfers (LIVE, not period-scoped): units still tied up in China —
    // committed (confirmed, not shipped) OR in-transit (shipped, not received).
    // Each carries its IT and linked PO so both can be opened independently.
    pg.raw(
      `SELECT it.id AS transfer_id, it.number AS transfer_number, it.status,
              it.shipped_at, it.linked_purchase_order_id AS po_id, po.number AS po_number,
              SUM(itl.qty - COALESCE(itl.qty_received, 0))::int AS qty_open
         FROM inventory_transfer_line itl
         JOIN inventory_transfer it ON it.id = itl.transfer_id
         LEFT JOIN purchase_order po ON po.id = it.linked_purchase_order_id AND po.deleted_at IS NULL
        WHERE itl.deleted_at IS NULL AND it.deleted_at IS NULL
          AND it.origin_country = 'CN' AND it.voided_at IS NULL
          AND it.received_at IS NULL
          AND itl.product_variant_id = ?
        GROUP BY it.id, it.number, it.status, it.shipped_at,
                 it.linked_purchase_order_id, po.number
       HAVING SUM(itl.qty - COALESCE(itl.qty_received, 0)) > 0
        ORDER BY it.shipped_at ASC NULLS LAST, it.number ASC`,
      [variant_id]
    ),
  ]);

  const fo_receipts = (foRes.rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.receipt_id),
    fo_id: r.fo_id != null ? String(r.fo_id) : null,
    fo_number: r.fo_number != null ? String(r.fo_number) : null,
    receipt_number: r.receipt_number != null ? String(r.receipt_number) : null,
    received_at: r.received_at,
    qty: toInt(r.qty),
  }));
  const transfers_out = (trRes.rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.transfer_id),
    transfer_number: r.transfer_number != null ? String(r.transfer_number) : null,
    po_id: r.po_id != null ? String(r.po_id) : null,
    po_number: r.po_number != null ? String(r.po_number) : null,
    shipped_at: r.shipped_at,
    received_at: r.received_at,
    qty: toInt(r.qty),
    qty_received: toInt(r.qty_received),
  }));
  const open_transfers = (openRes.rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.transfer_id),
    transfer_number: r.transfer_number != null ? String(r.transfer_number) : null,
    po_id: r.po_id != null ? String(r.po_id) : null,
    po_number: r.po_number != null ? String(r.po_number) : null,
    status: r.status != null ? String(r.status) : null,
    // A shipped-but-unreceived transfer is in-transit; otherwise it's committed
    // (confirmed, still physically sitting in the China warehouse).
    state: r.shipped_at ? ("in_transit" as const) : ("committed" as const),
    qty: toInt(r.qty_open),
  }));
  const adjustments = (adjRes.rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    notes: r.notes != null ? String(r.notes) : null,
    created_at: r.created_at,
    old_qty: toInt(r.old_qty),
    new_qty: toInt(r.new_qty),
    delta: toInt(r.delta),
  }));

  const stateRow = (stateRes.rows[0] as Record<string, unknown>) ?? {};
  const stocked = toInt(stateRow.stocked_quantity);
  const reserved = toInt(stateRow.reserved_quantity);
  // Units already SHIPPED out of China but not yet received in Miami — they've
  // physically LEFT the warehouse though `stocked` still carries them until receive.
  const in_transit = transfers_out.reduce(
    (s, t) => s + Math.max(0, t.qty - t.qty_received),
    0
  );
  // Physical-in-China = what's actually sitting in the warehouse (matches the
  // Inventory Timeline "En China": excludes in-transit, INCLUDES committed).
  const physical_china = stocked - in_transit;

  // The running balance tracks PHYSICAL China (not On-Hand `stocked`, which keeps
  // in-transit units until Miami receives). Transfers subtract at ship (units leave
  // the warehouse); the ledger closes at physical_china. beginning walks that back.
  const netSince =
    fo_receipts.reduce((s, r) => s + r.qty, 0) -
    transfers_out.reduce((s, r) => s + r.qty, 0) +
    adjustments.reduce((s, r) => s + r.delta, 0);
  const beginning_balance = physical_china - netSince;

  return res.json({
    fo_receipts,
    transfers_out,
    open_transfers,
    adjustments,
    current_state: {
      stocked,
      reserved,
      in_transit,
      physical_china,
      available: stocked - reserved,
    },
    beginning_balance,
    period,
    year: targetYear,
    year_window: { start: periodStart, end: periodEnd },
  });
}
