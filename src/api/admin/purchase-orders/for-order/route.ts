/**
 * GET /admin/purchase-orders/for-order?order_id=order_XXX
 *
 * Reverse lookup of the PO ↔ order link that the PO editor writes into
 * `purchase_order.linked_order_ids` (a JSON-encoded string array, hence the
 * quoted LIKE — legacy rows may hold non-JSON text, so casting to jsonb would
 * throw).
 *
 * Powers the POS "Product Status" modal on an order: a cashier answering a
 * customer asking "where is my order?" needs SKU / qty / tracking / ETA without
 * first discovering the vendor and hunting for the PO in the purchasing section.
 *
 * Read-only. Cancelled and voided POs are excluded — they answer nothing for the
 * customer. Drafts stay in, flagged by their own `status`.
 *
 * Response: { purchase_orders: PoForOrder[] } (newest first)
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../utils/db-pool";
import type { TrackingEntry } from "../../../../lib/carrier-tracking/types";

/** PO lifecycle states that cannot inform a customer about an inbound shipment. */
const EXCLUDED_STATUSES = ["cancelled", "voided"];

const ORDER_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

interface PoTrackingDto {
  id: string;
  provider: string;
  tracking_number: string;
  tracking_url: string;
  carrier_eta: string | null;
  carrier_status: string | null;
  carrier_detail: string | null;
}

interface PoLineDto {
  id: string;
  sku: string;
  description: string;
  qty_ordered: number;
  qty_received: number;
  qty_cancelled: number;
  status: string;
}

interface PoForOrderDto {
  id: string;
  number: string | null;
  status: string;
  po_status: string | null;
  vendor_name: string | null;
  ordered_at: string | null;
  expected_at: string | null;
  tracking: PoTrackingDto[];
  lines: PoLineDto[];
}

interface PoHeaderRow {
  id: string;
  number: string | null;
  status: string;
  po_status: string | null;
  vendor_name_snapshot: string | null;
  ordered_at: Date | null;
  expected_at: Date | null;
  tracking: unknown;
}

interface PoLineRow {
  id: string;
  purchase_order_id: string;
  sku_snapshot: string | null;
  description_snapshot: string | null;
  qty_ordered: unknown;
  qty_received: unknown;
  qty_cancelled: unknown;
  status: string;
}

/** Postgres numerics can arrive as strings over the wire — coerce before math. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function iso(v: Date | null): string | null {
  return v ? new Date(v).toISOString() : null;
}

function normalizeTracking(raw: unknown): PoTrackingDto[] {
  if (!Array.isArray(raw)) return [];
  return (raw as TrackingEntry[])
    .filter((t) => t && typeof t === "object")
    .map((t) => ({
      id: String(t.id ?? ""),
      provider: String(t.provider ?? ""),
      tracking_number: String(t.tracking_number ?? ""),
      tracking_url: String(t.tracking_url ?? ""),
      carrier_eta: t.carrier_eta ?? null,
      carrier_status: t.carrier_status ?? null,
      carrier_detail: t.carrier_detail ?? null,
    }));
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const orderId = (req.query["order_id"] as string | undefined)?.trim() ?? "";

  if (!orderId) {
    res.status(400).json({ error: "order_id query param is required" });
    return;
  }
  if (!ORDER_ID_RE.test(orderId)) {
    res.status(400).json({ error: "order_id is malformed" });
    return;
  }

  const pool = getDbPool();

  const headers = await pool.query<PoHeaderRow>(
    `SELECT id, number, status, po_status, vendor_name_snapshot,
            ordered_at, expected_at, tracking
       FROM purchase_order
      WHERE deleted_at IS NULL
        AND linked_order_ids IS NOT NULL
        AND linked_order_ids LIKE $1
        AND status <> ALL($2::text[])
      ORDER BY created_at DESC`,
    [`%"${orderId}"%`, EXCLUDED_STATUSES]
  );

  if (!headers.rows.length) {
    res.json({ purchase_orders: [] });
    return;
  }

  const poIds = headers.rows.map((r) => r.id);
  const lines = await pool.query<PoLineRow>(
    `SELECT id, purchase_order_id, sku_snapshot, description_snapshot,
            qty_ordered, qty_received, qty_cancelled, status
       FROM purchase_order_line
      WHERE deleted_at IS NULL
        AND purchase_order_id = ANY($1::text[])
      ORDER BY line_order ASC, id ASC`,
    [poIds]
  );

  const linesByPo = new Map<string, PoLineDto[]>();
  for (const row of lines.rows) {
    const bucket = linesByPo.get(row.purchase_order_id) ?? [];
    bucket.push({
      id: row.id,
      sku: row.sku_snapshot ?? "",
      description: row.description_snapshot ?? "",
      qty_ordered: num(row.qty_ordered),
      qty_received: num(row.qty_received),
      qty_cancelled: num(row.qty_cancelled),
      status: row.status,
    });
    linesByPo.set(row.purchase_order_id, bucket);
  }

  const purchase_orders: PoForOrderDto[] = headers.rows.map((po) => ({
    id: po.id,
    number: po.number,
    status: po.status,
    po_status: po.po_status,
    vendor_name: po.vendor_name_snapshot,
    ordered_at: iso(po.ordered_at),
    expected_at: iso(po.expected_at),
    tracking: normalizeTracking(po.tracking),
    lines: linesByPo.get(po.id) ?? [],
  }));

  res.json({ purchase_orders });
}
