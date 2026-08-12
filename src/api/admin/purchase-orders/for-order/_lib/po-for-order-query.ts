/**
 * Shared reverse lookup: POs linked to an order via
 * `purchase_order.linked_order_ids` (JSON-encoded string array in a TEXT
 * column — legacy rows may hold non-JSON text, so the match is a quoted LIKE;
 * a `::jsonb` cast would throw).
 *
 * Consumed by GET /admin/purchase-orders/for-order (toolbar badge + legacy
 * modal) and GET /admin/orders/:id/product-status. The DTO is the for-order
 * response contract — do not reshape it here.
 */

import type { Pool } from "pg";

import type { TrackingEntry } from "../../../../../lib/carrier-tracking/types";

/** PO lifecycle states that cannot inform a customer about an inbound shipment. */
export const EXCLUDED_PO_STATUSES = ["cancelled", "voided"];

export interface PoTrackingDto {
  id: string;
  provider: string;
  tracking_number: string;
  tracking_url: string;
  carrier_eta: string | null;
  carrier_status: string | null;
  carrier_detail: string | null;
}

export interface PoLineDto {
  id: string;
  sku: string;
  description: string;
  qty_ordered: number;
  qty_received: number;
  qty_cancelled: number;
  status: string;
}

export interface PoForOrderDto {
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

export async function loadPosForOrder(
  pool: Pool,
  orderId: string
): Promise<PoForOrderDto[]> {
  // `tracking` comes from purchase_order_tracking_number, not the PO's legacy
  // JSON column. That column is frozen and no longer written, so reading it
  // here would quote a customer an arrival date from a shipment list that
  // stopped updating.
  //
  // FLAT on purpose: this answers "where is my order?" for a customer, who
  // wants numbers and a date — not the delivery/number hierarchy the buyer
  // works with. Every number of every delivery is listed, master first within
  // each.
  const headers = await pool.query<PoHeaderRow>(
    `SELECT id, number, status, po_status, vendor_name_snapshot,
            ordered_at, expected_at,
            COALESCE(
              (SELECT json_agg(
                        json_build_object(
                          'id',             n.id,
                          'provider',       n.provider,
                          'tracking_number', n.tracking_number,
                          'tracking_url',   n.tracking_url,
                          'carrier_eta',    n.carrier_eta,
                          'carrier_status', n.carrier_status,
                          'carrier_detail', n.carrier_detail
                        )
                        ORDER BY trk.created_at, n.is_master DESC, n.created_at, n.id
                      )
                 FROM purchase_order_tracking trk
                 JOIN purchase_order_tracking_number n
                   ON n.purchase_order_tracking_id = trk.id
                  AND n.deleted_at IS NULL
                WHERE trk.purchase_order_id = purchase_order.id
                  AND trk.deleted_at IS NULL),
              '[]'::json
            ) AS tracking
       FROM purchase_order
      WHERE deleted_at IS NULL
        AND linked_order_ids IS NOT NULL
        AND linked_order_ids LIKE $1
        AND status <> ALL($2::text[])
      ORDER BY created_at DESC`,
    [`%"${orderId}"%`, EXCLUDED_PO_STATUSES]
  );

  if (!headers.rows.length) return [];

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

  return headers.rows.map((po) => ({
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
}
