/**
 * verify-delivery-v2.ts — invariants of the Delivery v2 model
 * (docs/DISPATCH_ON_ORDER_HANDOFF.md).
 *
 * Run with tsx against the target DB (sandbox 5499 or prod read-only):
 *   env DATABASE_URL="postgres://…" ./node_modules/.bin/tsx src/scripts/verify/verify-delivery-v2.ts
 *
 * Plain pg script ON PURPOSE — no medusa exec (a medusa-exec script run with
 * tsx silently exits 0 without executing; see medusa-core rules 2026-07-30).
 * Read-only: every statement is a SELECT.
 *
 * Invariants:
 *  I1  derived_v2 invoices: every merchandise line carries order_line_item_id.
 *  I2  Per order line: invoiced (active invoices) ≤ ordered (current version).
 *  I3  Pool rows (invoice_id NULL, live) have no fulfillment and no shipped_at.
 *  I4  Assigned rows carry the full assignment stamp (scope + assigned_at).
 *  I5  At most ONE live entire_invoice delivery per invoice, and it never
 *      coexists with item-scoped ones (PO-pattern exclusivity).
 *  I6  order_delivery_line rows exist ONLY under scope 'items', and per
 *      invoice line their sum never exceeds the invoiced quantity.
 *  I7  A voided/canceled delivery is never still assigned with a live
 *      fulfillment (unlink happened).
 */

import { Pool } from "pg";

interface Failure {
  invariant: string;
  detail: string;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: url, max: 2 });
  const failures: Failure[] = [];

  const push = (invariant: string, rows: Array<Record<string, unknown>>) => {
    for (const r of rows.slice(0, 10)) {
      failures.push({ invariant, detail: JSON.stringify(r) });
    }
    if (rows.length > 10) {
      failures.push({ invariant, detail: `…and ${rows.length - 10} more` });
    }
  };

  // I1 — v2 invoice with a merchandise line missing its line identity.
  const i1 = await pool.query(
    `SELECT pi.id, pi.invoice_number, pii.id AS item_id, pii.sku
       FROM pos_invoice pi
       JOIN pos_invoice_item pii ON pii.invoice_id = pi.id AND pii.deleted_at IS NULL
      WHERE pi.deleted_at IS NULL AND pi.shipment_link_mode = 'derived_v2'
        AND pii.variant_id IS NOT NULL
        AND pii.order_line_item_id IS NULL`
  );
  push("I1 v2-line-without-identity", i1.rows);

  // I2 — over-invoiced order lines (only lines that carry identity).
  const i2 = await pool.query(
    `WITH invoiced AS (
       SELECT pii.order_line_item_id, SUM(pii.quantity)::numeric AS invoiced_qty
         FROM pos_invoice_item pii
         JOIN pos_invoice pi ON pi.id = pii.invoice_id
        WHERE pi.deleted_at IS NULL AND pi.status != 'voided'
          AND pii.deleted_at IS NULL AND pii.order_line_item_id IS NOT NULL
        GROUP BY pii.order_line_item_id
     )
     SELECT inv.order_line_item_id, inv.invoiced_qty, oi.quantity::numeric AS ordered_qty
       FROM invoiced inv
       JOIN order_item oi ON oi.item_id = inv.order_line_item_id
       JOIN "order" o ON o.id = oi.order_id AND oi.version = o.version
      WHERE inv.invoiced_qty > oi.quantity::numeric`
  );
  push("I2 over-invoiced-line", i2.rows);

  // I3 — pool label that somehow acquired physical state.
  const i3 = await pool.query(
    `SELECT id, order_id, status, fulfillment_id, shipped_at
       FROM order_delivery
      WHERE deleted_at IS NULL AND voided_at IS NULL AND status <> 'canceled'
        AND invoice_id IS NULL
        AND (fulfillment_id IS NOT NULL OR shipped_at IS NOT NULL)`
  );
  push("I3 pool-with-physical-state", i3.rows);

  // I4 — assigned delivery missing its assignment stamp. Legacy full-flow rows
  // predating v2 are exempt (they have no assigned_at by definition) — scoped
  // to rows created after the v2 migration landed.
  const i4 = await pool.query(
    `SELECT id, order_id, invoice_id, invoice_scope, assigned_at
       FROM order_delivery
      WHERE deleted_at IS NULL AND voided_at IS NULL AND status <> 'canceled'
        AND invoice_id IS NOT NULL
        AND created_at >= '2026-08-08'
        AND (invoice_scope IS NULL OR assigned_at IS NULL)`
  );
  push("I4 assigned-without-stamp", i4.rows);

  // I5 — scope exclusivity per invoice.
  const i5 = await pool.query(
    `SELECT invoice_id,
            COUNT(*) FILTER (WHERE invoice_scope = 'entire_invoice') AS entire_count,
            COUNT(*) FILTER (WHERE invoice_scope = 'items') AS item_count
       FROM order_delivery
      WHERE deleted_at IS NULL AND voided_at IS NULL AND status <> 'canceled'
        AND invoice_id IS NOT NULL AND invoice_scope IS NOT NULL
      GROUP BY invoice_id
     HAVING COUNT(*) FILTER (WHERE invoice_scope = 'entire_invoice') > 1
         OR (COUNT(*) FILTER (WHERE invoice_scope = 'entire_invoice') > 0
             AND COUNT(*) FILTER (WHERE invoice_scope = 'items') > 0)`
  );
  push("I5 scope-exclusivity", i5.rows);

  // I6a — delivery lines under a non-items scope.
  const i6a = await pool.query(
    `SELECT odl.id, odl.delivery_id, od.invoice_scope
       FROM order_delivery_line odl
       JOIN order_delivery od ON od.id = odl.delivery_id
      WHERE odl.deleted_at IS NULL
        AND od.deleted_at IS NULL AND od.voided_at IS NULL
        AND od.status <> 'canceled'
        AND od.invoice_scope IS DISTINCT FROM 'items'`
  );
  push("I6a lines-under-wrong-scope", i6a.rows);

  // I6b — per invoice line, dispatched units exceed invoiced units.
  const i6b = await pool.query(
    `WITH covered AS (
       SELECT od.invoice_id, odl.order_line_item_id, SUM(odl.quantity)::numeric AS covered
         FROM order_delivery_line odl
         JOIN order_delivery od ON od.id = odl.delivery_id
        WHERE odl.deleted_at IS NULL AND od.deleted_at IS NULL
          AND od.voided_at IS NULL AND od.status <> 'canceled'
          AND od.invoice_id IS NOT NULL
        GROUP BY od.invoice_id, odl.order_line_item_id
     ), invoiced AS (
       SELECT invoice_id, order_line_item_id, SUM(quantity)::numeric AS invoiced
         FROM pos_invoice_item
        WHERE deleted_at IS NULL AND order_line_item_id IS NOT NULL
        GROUP BY invoice_id, order_line_item_id
     )
     SELECT c.invoice_id, c.order_line_item_id, c.covered, COALESCE(i.invoiced, 0) AS invoiced
       FROM covered c
       LEFT JOIN invoiced i
         ON i.invoice_id = c.invoice_id AND i.order_line_item_id = c.order_line_item_id
      WHERE c.covered > COALESCE(i.invoiced, 0)`
  );
  push("I6b over-dispatched-line", i6b.rows);

  // I7 — dead delivery still holding an assignment with a live fulfillment.
  const i7 = await pool.query(
    `SELECT od.id, od.status, od.voided_at, od.fulfillment_id
       FROM order_delivery od
       JOIN fulfillment f ON f.id = od.fulfillment_id AND f.deleted_at IS NULL
      WHERE od.deleted_at IS NULL
        AND (od.voided_at IS NOT NULL OR od.status = 'canceled')
        AND od.invoice_id IS NOT NULL
        AND od.created_at >= '2026-08-08'`
  );
  push("I7 dead-delivery-live-fulfillment", i7.rows);

  await pool.end();

  if (failures.length === 0) {
    console.log("verify-delivery-v2: ALL INVARIANTS HOLD (I1-I7)");
    process.exit(0);
  }
  console.error(`verify-delivery-v2: ${failures.length} violation(s):`);
  for (const f of failures) {
    console.error(`  [${f.invariant}] ${f.detail}`);
  }
  process.exit(1);
}

void main();
