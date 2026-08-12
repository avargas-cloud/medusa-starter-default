/**
 * PO → FO mirror core.
 *
 * A factory order can mirror the lines of a purchase order that belong to one
 * manufacturer (preferred vendor on the product: product.metadata.vendor_list_id).
 * The PO is ALWAYS the source of truth — sync only flows PO → FO.
 *
 * Line matching keys on purchase_order_line.id (factory_order_line.purchase_order_line_id):
 * product_variant_id is NOT unique within a PO (placeholder products repeat it),
 * so a variant-keyed mirror silently collapses sibling lines.
 */

import { vendorListIdSql } from "../../../../lib/vendor-metadata/keys";
import type FactoryOrdersModuleService from "../../../../modules/factory-orders/service";

export interface KnexLike {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
}

export interface ManufacturerVendor {
  id: string;
  qb_list_id: string;
  display_name: string;
  short_name: string;
}

export type ManufacturerResolution =
  | { ok: true; vendor: ManufacturerVendor }
  | { ok: false; code: "manufacturer_not_found" | "manufacturer_ambiguous"; matches: string[] };

export interface PoHeader {
  id: string;
  number: string | null;
  status: string;
  vendor_id: string;
  vendor_name_snapshot: string | null;
  vendor_qb_list_id_snapshot: string | null;
  ordered_at: string | null;
  expected_at: string | null;
  shipping_method: string | null;
  payment_terms: string | null;
}

export interface PoMirrorLine {
  po_line_id: string;
  product_variant_id: string;
  inventory_item_id: string;
  sku: string;
  description: string;
  qty: number;
  unit_cost_cents: number;
  line_order: number;
}

export interface FoLineRow {
  id: string;
  purchase_order_line_id: string | null;
  product_variant_id: string;
  qty_ordered: number;
  qty_received: number;
  unit_cost_cents: number;
  sku_snapshot: string;
  description_snapshot: string;
  tax_cents: number;
  line_order: number;
}

export interface MirrorDiff {
  missing: PoMirrorLine[];
  removed: FoLineRow[];
  qty_changed: Array<{ po_line_id: string; sku: string; po_qty: number; fo_qty: number }>;
  cost_changed: Array<{ po_line_id: string; sku: string; po_cost_cents: number; fo_cost_cents: number }>;
  extra: FoLineRow[];
}

/** FO statuses the sync may write to ("pending" in operator language). */
export const SYNCABLE_FO_STATUSES = ["draft", "submitted"] as const;
/** FO statuses where a receipt exists — sync must not touch, operator fixes the receive. */
export const RECEIPT_BLOCKED_FO_STATUSES = ["partially_received", "received"] as const;
/** FO statuses treated as "no live mirror" — a new FO may be created. */
export const INACTIVE_FO_STATUSES = ["closed", "cancelled", "voided"] as const;

export async function resolveManufacturer(
  knex: KnexLike,
  query: string
): Promise<ManufacturerResolution> {
  const pattern = `%${query.trim()}%`;
  const rows = (await knex
    .raw(
      `SELECT id, qb_list_id, full_name, name, company_name
         FROM qb_vendor
        WHERE deleted_at IS NULL
          AND (name ILIKE ? OR full_name ILIKE ? OR company_name ILIKE ?)
        ORDER BY name ASC
        LIMIT 5`,
      [pattern, pattern, pattern]
    )
    .then((r) => r.rows)) as Array<{
    id: string;
    qb_list_id: string | null;
    full_name: string | null;
    name: string;
    company_name: string | null;
  }>;

  const usable = rows.filter((r) => r.qb_list_id);
  if (usable.length === 0) {
    return { ok: false, code: "manufacturer_not_found", matches: rows.map((r) => r.name) };
  }
  if (usable.length > 1) {
    return { ok: false, code: "manufacturer_ambiguous", matches: usable.map((r) => r.name) };
  }
  const v = usable[0];
  if (!v) {
    return { ok: false, code: "manufacturer_not_found", matches: [] };
  }
  return {
    ok: true,
    vendor: {
      id: v.id,
      qb_list_id: v.qb_list_id as string,
      display_name: v.full_name || v.company_name || v.name,
      short_name: v.name,
    },
  };
}

export async function loadPoHeader(knex: KnexLike, poId: string): Promise<PoHeader | null> {
  const rows = (await knex
    .raw(
      `SELECT id, number, status, vendor_id, vendor_name_snapshot,
              vendor_qb_list_id_snapshot, ordered_at, expected_at,
              shipping_method, payment_terms
         FROM purchase_order
        WHERE id = ? AND deleted_at IS NULL
        LIMIT 1`,
      [poId]
    )
    .then((r) => r.rows)) as PoHeader[];
  return rows[0] ?? null;
}

/**
 * PO lines whose product's preferred vendor matches the manufacturer.
 * Effective qty = qty_ordered − qty_cancelled (floored at 0); zero-qty and
 * cancelled lines are excluded — the factory should not see them.
 */
export async function loadManufacturerPoLines(
  knex: KnexLike,
  poId: string,
  manufacturerListId: string
): Promise<PoMirrorLine[]> {
  const rows = (await knex
    .raw(
      `SELECT pol.id AS po_line_id,
              pol.product_variant_id,
              pol.inventory_item_id,
              pol.sku_snapshot AS sku,
              pol.description_snapshot AS description,
              GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled, 0), 0) AS qty,
              pol.unit_cost_cents,
              COALESCE(pol.line_order, 0) AS line_order
         FROM purchase_order_line pol
         JOIN product_variant pv ON pv.id = pol.product_variant_id
         JOIN product p ON p.id = pv.product_id
        WHERE pol.purchase_order_id = ?
          AND pol.deleted_at IS NULL
          AND COALESCE(pol.status, 'open') <> 'cancelled'
          AND ${vendorListIdSql("p")} = ?
        ORDER BY COALESCE(pol.line_order, 0) ASC, pol.id ASC`,
      [poId, manufacturerListId]
    )
    .then((r) => r.rows)) as Array<PoMirrorLine & { qty: number | string; unit_cost_cents: number | string; line_order: number | string }>;

  return rows
    .map((r) => ({
      ...r,
      qty: Number(r.qty),
      unit_cost_cents: Number(r.unit_cost_cents),
      line_order: Number(r.line_order),
    }))
    .filter((r) => r.qty > 0);
}

/** Most recent non-inactive FO linked to this PO, or null. */
export async function findLinkedFo(
  service: FactoryOrdersModuleService,
  poId: string
): Promise<{ id: string; number: string | null; status: string } | null> {
  const rows = (await service.listFactoryOrders(
    { linked_purchase_order_id: poId },
    { order: { created_at: "DESC" }, take: 20 }
  )) as Array<{ id: string; number: string | null; status: string }>;
  const active = rows.filter(
    (fo) => !(INACTIVE_FO_STATUSES as readonly string[]).includes(fo.status)
  );
  return active[0] ?? null;
}

export async function loadFoLines(
  service: FactoryOrdersModuleService,
  foId: string
): Promise<FoLineRow[]> {
  const rows = (await service.listFactoryOrderLines(
    { factory_order_id: foId },
    { take: 1000 }
  )) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    purchase_order_line_id: (r.purchase_order_line_id as string | null) ?? null,
    product_variant_id: String(r.product_variant_id),
    qty_ordered: Number(r.qty_ordered),
    qty_received: Number(r.qty_received ?? 0),
    unit_cost_cents: Number(r.unit_cost_cents),
    sku_snapshot: String(r.sku_snapshot),
    description_snapshot: String(r.description_snapshot),
    tax_cents: Number(r.tax_cents ?? 0),
    line_order: Number(r.line_order ?? 0),
  }));
}

/** Diff PO mirror lines vs FO lines, keyed by purchase_order_line_id. */
export function computeMirrorDiff(
  poLines: PoMirrorLine[],
  foLines: FoLineRow[]
): MirrorDiff {
  const foByPolId = new Map<string, FoLineRow>();
  const extra: FoLineRow[] = [];
  for (const fl of foLines) {
    if (fl.purchase_order_line_id) foByPolId.set(fl.purchase_order_line_id, fl);
    else extra.push(fl);
  }

  const missing: PoMirrorLine[] = [];
  const qty_changed: MirrorDiff["qty_changed"] = [];
  const cost_changed: MirrorDiff["cost_changed"] = [];
  const seen = new Set<string>();

  for (const pl of poLines) {
    const fl = foByPolId.get(pl.po_line_id);
    if (!fl) {
      missing.push(pl);
      continue;
    }
    seen.add(pl.po_line_id);
    if (fl.qty_ordered !== pl.qty) {
      qty_changed.push({ po_line_id: pl.po_line_id, sku: pl.sku, po_qty: pl.qty, fo_qty: fl.qty_ordered });
    }
    if (fl.unit_cost_cents !== pl.unit_cost_cents) {
      cost_changed.push({
        po_line_id: pl.po_line_id,
        sku: pl.sku,
        po_cost_cents: pl.unit_cost_cents,
        fo_cost_cents: fl.unit_cost_cents,
      });
    }
  }

  const removed = foLines.filter(
    (fl) => fl.purchase_order_line_id !== null && !seen.has(fl.purchase_order_line_id)
  );

  return { missing, removed, qty_changed, cost_changed, extra };
}

export function isDiffEmpty(diff: MirrorDiff): boolean {
  return (
    diff.missing.length === 0 &&
    diff.removed.length === 0 &&
    diff.qty_changed.length === 0 &&
    diff.cost_changed.length === 0 &&
    diff.extra.length === 0
  );
}
