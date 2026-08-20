/**
 * Loads the per-line facts both separation surfaces need:
 * GET product-status (display) and POST separations (server-side validation).
 *
 * Every quantity is coerced before math — Postgres numerics arrive as strings.
 * order_item is versioned: only rows of the order's CURRENT version count
 * (stale versions block/inflate every derived number).
 *
 * Stock scope is Miami (USA_LOC) only — house rule; China stock never backs a
 * separation.
 *
 * FULFILLED IS DERIVED FROM LIVE FULFILLMENTS, NEVER FROM
 * `order_item.fulfilled_quantity`. That aggregate is written forward and never
 * reverted: voiding an invoice cancels and soft-deletes its fulfillment while
 * the column keeps the units. Measured on production 2026-08-20 it was wrong
 * on 25 lines across 6 orders — S11432 read `fulfilled_quantity = 25` for a
 * line whose only fulfillment (18 units) had been canceled AND deleted six
 * days earlier, so the modal showed 0 pending units on a line where 25 were
 * still sitting on the shelf. `assign-delivery` creates the fulfillment for
 * exactly the covered units in BOTH invoice scopes, which is why the
 * fulfillment tables answer this and `order_delivery_line` does not: that
 * table only has rows for item-scoped assignments.
 */

import type { Pool } from "pg";

import { USA_LOC } from "../../../../../lib/locations";
import { allocateInvoicedToLines } from "../../../../../lib/invoices/per-line-invoiced";
import { liveFulfilledSql, netSeparatedSql } from "../../_lib/separation-sql";
import type {
  InventorySnapshot,
  SeparationLineInput,
} from "../../_lib/separation-caps";

export interface SeparationOrderLine extends SeparationLineInput {
  sku: string;
  description: string;
  /** Alias of `fulfilled` kept for the DTO field of the same name. Both carry
   *  units covered by a LIVE fulfillment — see the note on `fulfilled` below. */
  fulfilledActual: number;
  /** Units covered by a live fulfillment that a carrier or the counter has
   *  already confirmed DELIVERED. Display fact only — a shipped-but-unconfirmed
   *  unit is just as gone from the shelf, so coverage uses `fulfilled`. */
  delivered: number;
}

/** One LIVE separation of another order holding units of an inventory item:
 *  its unfulfilled remainder (qty − delivered, floored at 0). Feeds the
 *  "where is this SKU separated" tooltip and sums into
 *  InventorySnapshot.separatedElsewhere. */
export interface ElsewhereSeparationRow {
  inventoryItemId: string;
  orderId: string;
  displayId: number | null;
  customerName: string;
  sku: string;
  ordered: number;
  /** Live remainder still on the shelf for that order. */
  separated: number;
}

export interface SeparationData {
  orderId: string;
  displayId: number | null;
  /** Legacy boolean from metadata — honored when no rows exist. */
  legacySeparatedFlag: boolean;
  metadata: Record<string, unknown>;
  lines: SeparationOrderLine[];
  inventory: Map<string, InventorySnapshot>;
  /** Live cross-order separations per inventory item of this order's lines. */
  elsewhere: Map<string, ElsewhereSeparationRow[]>;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

interface LineRow {
  line_id: string;
  sku: string | null;
  variant_id: string | null;
  description: string | null;
  quantity: unknown;
  fulfilled_live: unknown;
  delivered_live: unknown;
  invoiced: unknown;
  inventory_item_id: string | null;
  reserved: unknown;
  separated: unknown;
}

export async function loadSeparationData(
  pool: Pool,
  orderId: string
): Promise<SeparationData | null> {
  const orderRes = await pool.query<{
    id: string;
    display_id: number | null;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT id, display_id, metadata
       FROM "order"
      WHERE id = $1 AND deleted_at IS NULL`,
    [orderId]
  );
  const order = orderRes.rows[0];
  if (!order) return null;

  const lineRes = await pool.query<LineRow>(
    `SELECT oli.id                    AS line_id,
            oli.variant_sku           AS sku,
            oli.variant_id            AS variant_id,
            COALESCE(
              NULLIF(oli.metadata->>'sales_description', ''),
              NULLIF(pv.metadata->>'sales_description', ''),
              NULLIF(oli.product_title, ''),
              oli.title
            )                         AS description,
            oi.quantity               AS quantity,
            ful.qty                   AS fulfilled_live,
            ful.delivered_qty         AS delivered_live,
            inv.qty                   AS invoiced,
            pvii.inventory_item_id    AS inventory_item_id,
            resv.qty                  AS reserved,
            ${netSeparatedSql("sep.qty", "oi.order_id", "oli.id")} AS separated
       FROM order_item oi
       JOIN "order" o
         ON o.id = oi.order_id
        AND oi.version = o.version
       JOIN order_line_item oli
         ON oli.id = oi.item_id
        AND oli.deleted_at IS NULL
       LEFT JOIN product_variant pv
         ON pv.id = oli.variant_id
        AND pv.deleted_at IS NULL
       LEFT JOIN product_variant_inventory_item pvii
         ON pvii.variant_id = oli.variant_id
        AND pvii.deleted_at IS NULL
       LEFT JOIN LATERAL (
            SELECT SUM(r.quantity) AS qty
              FROM reservation_item r
             WHERE r.line_item_id = oli.id
               AND r.deleted_at IS NULL
       ) resv ON true
       LEFT JOIN LATERAL (
            SELECT SUM(ffi.quantity) AS qty,
                   SUM(ffi.quantity) FILTER (
                     WHERE f.delivered_at IS NOT NULL
                   )              AS delivered_qty
              FROM order_fulfillment ofl
              JOIN fulfillment f
                ON f.id = ofl.fulfillment_id
               AND f.canceled_at IS NULL
               AND f.deleted_at IS NULL
              JOIN fulfillment_item ffi
                ON ffi.fulfillment_id = f.id
               AND ffi.deleted_at IS NULL
             WHERE ofl.order_id = oi.order_id
               AND ofl.deleted_at IS NULL
               AND ffi.line_item_id = oli.id
       ) ful ON true
       LEFT JOIN LATERAL (
            SELECT SUM(pii.quantity) AS qty
              FROM pos_invoice_item pii
              JOIN pos_invoice pi
                ON pi.id = pii.invoice_id
               AND pi.deleted_at IS NULL
               AND pi.status NOT IN ('voided', 'draft')
             WHERE pii.order_line_item_id = oli.id
               AND pii.deleted_at IS NULL
       ) inv ON true
       LEFT JOIN order_line_separation sep
         ON sep.order_id = oi.order_id
        AND sep.order_line_item_id = oli.id
      WHERE oi.order_id = $1
        AND oi.deleted_at IS NULL
      ORDER BY oli.created_at ASC, oli.id ASC`,
    [orderId]
  );

  const metadata = (order.metadata ?? {}) as Record<string, unknown>;
  // Invoicing no longer covers a line (owner decision 2026-08-20, superseding
  // 2026-08-11). A POS invoice is a billing act, not a shipping one: the goods
  // of a paid invoice awaiting pickup are still on the shelf and still the
  // warehouse's problem. Counting them as done is what made S11432 show 0
  // pending units on a line with 25 units in the building — and the
  // `fully_invoiced` shortcut did it wholesale, for every line at once.
  // Invoiced quantities now only set the FLOOR of the separation
  // (invoicedFloorOf in separation-caps.ts).
  //
  // Per-line attribution prefers order_line_item_id (persisted since Delivery
  // v2, 2026-08-08); items billed before that — or by any path that omits the
  // link — fall back to the variant/SKU FIFO pool below.

  // Invoice items with no line identity, allocated across this order's lines
  // by variant/SKU. Every affected production order (15 as of 2026-08-14) is
  // pre-Delivery-v2, so without this pool their billed units read as
  // un-invoiced in both modals AND the list.
  const unattributedRes = await pool.query<{
    variant_id: string | null;
    sku: string | null;
    qty: unknown;
  }>(
    `SELECT pii.variant_id, pii.sku, SUM(pii.quantity) AS qty
       FROM pos_invoice_item pii
       JOIN pos_invoice pi
         ON pi.id = pii.invoice_id
        AND pi.deleted_at IS NULL
        AND pi.status NOT IN ('voided', 'draft')
      WHERE pi.order_id = $1
        AND pii.order_line_item_id IS NULL
        AND pii.deleted_at IS NULL
      GROUP BY pii.variant_id, pii.sku`,
    [orderId]
  );
  const invoicedByLine = allocateInvoicedToLines(
    lineRes.rows.map((r) => ({
      lineId: r.line_id,
      variantId: r.variant_id,
      sku: r.sku,
      quantity: num(r.quantity),
      directInvoiced: num(r.invoiced),
    })),
    unattributedRes.rows.map((r) => ({
      variantId: r.variant_id,
      sku: r.sku,
      quantity: num(r.qty),
    }))
  );

  const lines: SeparationOrderLine[] = lineRes.rows.map((r) => {
    const quantity = num(r.quantity);
    const invoiced = invoicedByLine.get(r.line_id) ?? num(r.invoiced);
    // Units under a live fulfillment: dispatched, shipped or handed over the
    // counter. Whatever their delivery status, they are out of the warehouse
    // and the shelf no longer holds them.
    const fulfilled = Math.min(quantity, num(r.fulfilled_live));
    return {
      lineId: r.line_id,
      sku: (r.sku ?? "").trim(),
      description: r.description ?? "",
      quantity,
      fulfilled,
      fulfilledActual: fulfilled,
      delivered: Math.min(quantity, num(r.delivered_live)),
      invoiced,
      reserved: num(r.reserved),
      inventoryItemId: r.inventory_item_id,
      // Ya viene NETEADO de lo entregado: la query lo calcula con
      // `netSeparatedSql`, el mismo fragmento que usa la lista. Ese es el punto
      // — cuando el netting vivía suelto en cada archivo entró en uno solo y
      // S11320 mostró ámbar en el modal y ningún `To Separate` en la fila.
      separated: num(r.separated),
    };
  });

  const itemIds = [
    ...new Set(
      lines.map((l) => l.inventoryItemId).filter((v): v is string => !!v)
    ),
  ];
  const inventory = new Map<string, InventorySnapshot>();
  const elsewhere = new Map<string, ElsewhereSeparationRow[]>();
  if (itemIds.length) {
    const invRes = await pool.query<{
      inventory_item_id: string;
      stocked_quantity: unknown;
      reserved_quantity: unknown;
    }>(
      `SELECT inventory_item_id, stocked_quantity, reserved_quantity
         FROM inventory_level
        WHERE deleted_at IS NULL
          AND location_id = $1
          AND inventory_item_id = ANY($2::text[])`,
      [USA_LOC, itemIds]
    );
    for (const row of invRes.rows) {
      inventory.set(row.inventory_item_id, {
        stocked: num(row.stocked_quantity),
        reservedAllOrders: num(row.reserved_quantity),
        separatedElsewhere: 0,
      });
    }

    // Live separations of OTHER orders holding units of these items: their
    // unfulfilled remainder. Delivered units left the building (released);
    // invoiced-but-undelivered ones still hold their claim. Canceled and
    // archived orders never hold stock.
    const elseRes = await pool.query<{
      inventory_item_id: string;
      order_id: string;
      display_id: number | null;
      customer_name: string | null;
      sku: string | null;
      ordered: unknown;
      separated_live: unknown;
    }>(
      `SELECT pvii.inventory_item_id,
              o.id                      AS order_id,
              o.display_id              AS display_id,
              COALESCE(
                NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), ''),
                NULLIF(c.company_name, ''),
                c.email
              )                         AS customer_name,
              oli.variant_sku           AS sku,
              oi.quantity               AS ordered,
              ${netSeparatedSql("sep.qty", "sep.order_id", "oli.id")}
                                        AS separated_live
         FROM order_line_separation sep
         JOIN "order" o
           ON o.id = sep.order_id
          AND o.deleted_at IS NULL
          AND o.status NOT IN ('canceled', 'archived')
         JOIN order_line_item oli
           ON oli.id = sep.order_line_item_id
          AND oli.deleted_at IS NULL
         JOIN order_item oi
           ON oi.order_id = sep.order_id
          AND oi.item_id = oli.id
          AND oi.version = o.version
          AND oi.deleted_at IS NULL
         JOIN product_variant_inventory_item pvii
           ON pvii.variant_id = oli.variant_id
          AND pvii.deleted_at IS NULL
         LEFT JOIN customer c
           ON c.id = o.customer_id
          AND c.deleted_at IS NULL
        WHERE pvii.inventory_item_id = ANY($2::text[])
          AND sep.order_id <> $1
          AND sep.qty > ${liveFulfilledSql("sep.order_id", "oli.id")}
        ORDER BY o.display_id ASC, oli.id ASC`,
      [orderId, itemIds]
    );
    for (const row of elseRes.rows) {
      const live = num(row.separated_live);
      if (live <= 0) continue;
      const entry: ElsewhereSeparationRow = {
        inventoryItemId: row.inventory_item_id,
        orderId: row.order_id,
        displayId: row.display_id,
        customerName: row.customer_name ?? "—",
        sku: (row.sku ?? "").trim(),
        ordered: num(row.ordered),
        separated: live,
      };
      const list = elsewhere.get(row.inventory_item_id) ?? [];
      list.push(entry);
      elsewhere.set(row.inventory_item_id, list);
      const inv = inventory.get(row.inventory_item_id);
      if (inv) {
        inventory.set(row.inventory_item_id, {
          ...inv,
          separatedElsewhere: inv.separatedElsewhere + live,
        });
      }
    }
  }

  return {
    orderId: order.id,
    displayId: order.display_id,
    legacySeparatedFlag: metadata.is_separated === true,
    metadata,
    lines,
    inventory,
    elsewhere,
  };
}
