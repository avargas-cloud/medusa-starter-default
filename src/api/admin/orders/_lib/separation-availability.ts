import { USA_LOC } from "../../../../lib/locations";
import { allocateInvoicedToLines } from "../../../../lib/invoices/per-line-invoiced";
import {
  computeSeparationCaps,
  type InventorySnapshot,
  type SeparationLineInput,
} from "./separation-caps";

/**
 * How much of an order is still waiting to be set aside, and how much of THAT
 * the Miami shelf can back right now.
 *
 * Feeds the second slot of the POS Separated column: `To Separate` when the
 * stock is there, `Awaiting Products` when it is not. Two facts about the same
 * order that a single word cannot carry — an order can be partially separated
 * AND still waiting on product, which is the case this exists for.
 *
 * DELIBERATELY NOT INDEXED. Every other field the orders list filters on lives
 * in the MeiliSearch doc, and this one must not: it derives from live inventory,
 * and nothing reindexes an order when stock moves. Indexed, it would be right at
 * reindex time and quietly wrong forever after — a badge that looks reasonable
 * and lies, which is the failure mode this codebase keeps paying for. Computed
 * per request instead, which also means it can never create members of the
 * Separated tab: that tab reads `separation_state` from the index, and these two
 * labels do not exist there.
 *
 * The arithmetic is NOT reimplemented here. `computeSeparationCaps` is the same
 * function the separation modal and the write path use, so the list cannot
 * disagree with the screen the operator opens next about what is separable.
 * This module only feeds it the rows.
 */

export interface SeparationPending {
  /** Open units (ordered minus fulfilled) not yet set aside. */
  pending: number;
  /** Of those, how many the pool can back right now. Never exceeds `pending`. */
  available: number;
}

interface SqlClient {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
}

interface AvailabilityRow {
  order_id: string;
  line_id: string;
  order_fully_invoiced: boolean | null;
  variant_id: string | null;
  sku: string | null;
  quantity: unknown;
  fulfilled: unknown;
  separated: unknown;
  invoiced_direct: unknown;
  inventory_item_id: string | null;
  stocked: unknown;
  separated_elsewhere: unknown;
}

interface UnattributedInvoicedRow {
  order_id: string;
  variant_id: string | null;
  sku: string | null;
  qty: unknown;
}

/**
 * Invoice items with no order_line_item_id, grouped per order — the pool
 * allocateInvoicedToLines spreads across that order's lines by variant/SKU.
 * Same rule as separation-data.ts, because this module's contract is that the
 * list can never disagree with the modal about what still needs separating.
 */
const UNATTRIBUTED_INVOICED_SQL = `
  SELECT pi.order_id,
         pii.variant_id,
         pii.sku,
         SUM(pii.quantity) AS qty
    FROM pos_invoice pi
    JOIN pos_invoice_item pii
      ON pii.invoice_id = pi.id AND pii.deleted_at IS NULL
   WHERE pi.order_id = ANY(?::text[])
     AND pi.deleted_at IS NULL
     AND pi.status NOT IN ('voided', 'draft')
     AND pii.order_line_item_id IS NULL
   GROUP BY pi.order_id, pii.variant_id, pii.sku
`;

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * One line per open (or already separated) order line, with the inventory
 * snapshot its item needs.
 *
 * `claim` is the ONE aggregate here that must never be restricted to the
 * requested orders, and that is the opposite of the rule the sibling CTEs in
 * hydrate-order-rows follow. Theirs are LEFT JOINed on order_id, so a row
 * belonging to an order outside the list could never have matched one inside it.
 * This one exists precisely to count what OTHER orders hold: scope it and a
 * Closed order's shelf claim stops being subtracted, availability inflates, and
 * the list offers `To Separate` over units that are already spoken for.
 *
 * The claim itself is `separated qty − fulfilled`, matching separation-data.ts
 * exactly — the SEPARATED amount minus what already left, not the line's whole
 * unfulfilled remainder. Delivered units released their claim; invoiced but
 * undelivered ones still hold it.
 *
 * No question marks in the comments inside the template literal below: knex
 * treats every one of them as a positional binding.
 */
const AVAILABILITY_SQL = `
  WITH ord AS (
    SELECT o.id,
           o.version,
           (o.metadata->>'fully_invoiced' = 'true') AS fully_invoiced
      FROM "order" o
     WHERE o.id = ANY(?::text[]) AND o.deleted_at IS NULL
  ),
  line AS (
    SELECT oi.order_id,
           oi.item_id                         AS line_id,
           o.fully_invoiced                   AS order_fully_invoiced,
           oli.variant_id                     AS variant_id,
           oli.variant_sku                    AS sku,
           oi.quantity                        AS quantity,
           COALESCE(oi.fulfilled_quantity, 0) AS fulfilled,
           COALESCE(sep.qty, 0)               AS separated,
           COALESCE(inv.qty, 0)               AS invoiced_direct,
           pvii.inventory_item_id             AS inventory_item_id
      FROM ord o
      JOIN order_item oi
        ON oi.order_id = o.id AND oi.version = o.version AND oi.deleted_at IS NULL
      JOIN order_line_item oli
        ON oli.id = oi.item_id AND oli.deleted_at IS NULL
      LEFT JOIN order_line_separation sep
        ON sep.order_id = oi.order_id AND sep.order_line_item_id = oi.item_id
      LEFT JOIN LATERAL (
           SELECT SUM(pii.quantity) AS qty
             FROM pos_invoice_item pii
             JOIN pos_invoice pi
               ON pi.id = pii.invoice_id
              AND pi.deleted_at IS NULL
              AND pi.status NOT IN ('voided', 'draft')
            WHERE pii.order_line_item_id = oli.id
              AND pii.deleted_at IS NULL
      ) inv ON TRUE
      LEFT JOIN product_variant_inventory_item pvii
        ON pvii.variant_id = oli.variant_id AND pvii.deleted_at IS NULL
  ),
  claim AS (
    SELECT pvii.inventory_item_id AS inventory_item_id,
           sep.order_id           AS order_id,
           SUM(GREATEST(0, sep.qty - COALESCE(oi.fulfilled_quantity, 0))) AS live
      FROM order_line_separation sep
      JOIN "order" o2
        ON o2.id = sep.order_id AND o2.deleted_at IS NULL
       AND o2.status NOT IN ('canceled', 'archived')
      JOIN order_line_item oli2
        ON oli2.id = sep.order_line_item_id AND oli2.deleted_at IS NULL
      JOIN order_item oi
        ON oi.order_id = sep.order_id AND oi.item_id = oli2.id
       AND oi.version = o2.version AND oi.deleted_at IS NULL
      JOIN product_variant_inventory_item pvii
        ON pvii.variant_id = oli2.variant_id AND pvii.deleted_at IS NULL
     WHERE sep.qty > COALESCE(oi.fulfilled_quantity, 0)
     GROUP BY 1, 2
  )
  SELECT l.order_id,
         l.line_id,
         l.order_fully_invoiced,
         l.variant_id,
         l.sku,
         l.quantity,
         l.fulfilled,
         l.separated,
         l.invoiced_direct,
         l.inventory_item_id,
         COALESCE(il.stocked_quantity, 0)            AS stocked,
         COALESCE(ct.total, 0) - COALESCE(co.own, 0) AS separated_elsewhere
    FROM line l
    LEFT JOIN inventory_level il
      ON il.inventory_item_id = l.inventory_item_id
     AND il.location_id = ? AND il.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT SUM(c.live) AS total FROM claim c
       WHERE c.inventory_item_id = l.inventory_item_id
    ) ct ON TRUE
    LEFT JOIN LATERAL (
      SELECT SUM(c.live) AS own FROM claim c
       WHERE c.inventory_item_id = l.inventory_item_id
         AND c.order_id = l.order_id
    ) co ON TRUE
   WHERE l.quantity > l.fulfilled OR l.separated > 0
`;

/**
 * Measured against production on 2026-08-13 at the worst case the route can
 * reach — 1,396 ids, the entire non-draft population: 26-36 ms and 40 rows,
 * against the 178-222 ms the hydration query already costs there. Almost every
 * order is closed and contributes no open line, so the result set stays tiny
 * however large the id list gets. That is why this carries no equivalent of
 * CTE_SCOPE_MAX_IDS: there is no regime where scoping would pay for itself.
 */
export async function loadSeparationPending(
  pg: SqlClient,
  orderIds: string[]
): Promise<Map<string, SeparationPending>> {
  const out = new Map<string, SeparationPending>();
  if (orderIds.length === 0) return out;

  const [result, unattributedResult] = await Promise.all([
    pg.raw(AVAILABILITY_SQL, [orderIds, USA_LOC]),
    pg.raw(UNATTRIBUTED_INVOICED_SQL, [orderIds]),
  ]);
  const rows = result.rows as AvailabilityRow[];
  const unattributedRows = unattributedResult.rows as UnattributedInvoicedRow[];

  const byOrder = new Map<string, AvailabilityRow[]>();
  for (const row of rows) {
    const list = byOrder.get(row.order_id);
    if (list) list.push(row);
    else byOrder.set(row.order_id, [row]);
  }

  const unattributedByOrder = new Map<string, UnattributedInvoicedRow[]>();
  for (const row of unattributedRows) {
    const list = unattributedByOrder.get(row.order_id);
    if (list) list.push(row);
    else unattributedByOrder.set(row.order_id, [row]);
  }

  for (const [orderId, orderRows] of byOrder) {
    // Invoiced units are done as far as separation goes (owner decision
    // 2026-08-11, same rule separation-data.ts applies to the modals): a line's
    // work-reducing quantity is COVERED = max(fulfilled, invoiced), never raw
    // fulfilled. Without this, an order billed but not yet delivered kept
    // announcing "To Separate" for units already spoken for on an invoice.
    const invoicedByLine = allocateInvoicedToLines(
      orderRows.map((row) => ({
        lineId: row.line_id,
        variantId: row.variant_id,
        sku: row.sku,
        quantity: num(row.quantity),
        directInvoiced: num(row.invoiced_direct),
      })),
      (unattributedByOrder.get(orderId) ?? []).map((row) => ({
        variantId: row.variant_id,
        sku: row.sku,
        quantity: num(row.qty),
      }))
    );

    const lines: SeparationLineInput[] = orderRows.map((row) => {
      const quantity = num(row.quantity);
      const invoiced = invoicedByLine.get(row.line_id) ?? 0;
      // Wholesale fallback mirrors separation-data.ts: a fully_invoiced order
      // covers everything even where legacy items defeat per-line attribution.
      const covered = row.order_fully_invoiced
        ? quantity
        : Math.min(quantity, Math.max(num(row.fulfilled), invoiced));
      return {
        lineId: row.line_id,
        quantity,
        fulfilled: covered,
        // Display-only in the cap math since 2026-08-12; the pool arbiter is the
        // separation, not the reservation. Zero keeps this honest rather than
        // inventing a number the caps never read.
        reserved: 0,
        inventoryItemId: row.inventory_item_id,
        separated: num(row.separated),
      };
    });

    const inventory = new Map<string, InventorySnapshot>();
    for (const row of orderRows) {
      if (!row.inventory_item_id || inventory.has(row.inventory_item_id)) continue;
      inventory.set(row.inventory_item_id, {
        stocked: num(row.stocked),
        reservedAllOrders: 0,
        separatedElsewhere: Math.max(0, num(row.separated_elsewhere)),
      });
    }

    const caps = computeSeparationCaps(lines, inventory);
    const capByLine = new Map(caps.map((cap) => [cap.lineId, cap]));

    let pending = 0;
    let available = 0;
    for (const line of lines) {
      const cap = capByLine.get(line.lineId);
      if (!cap) continue;
      // What is left to set aside on this line, and how much of it the pool
      // covers. `cap` is a TOTAL ceiling, so the additional room is whatever it
      // allows beyond what is already stored.
      pending += Math.max(0, cap.openQty - line.separated);
      available += Math.min(
        Math.max(0, cap.openQty - line.separated),
        Math.max(0, cap.cap - line.separated)
      );
    }

    out.set(orderId, { pending, available });
  }

  return out;
}
