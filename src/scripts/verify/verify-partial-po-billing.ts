/**
 * Gate for splitting one purchase order across several regular vendor bills.
 *
 * Two things are checked, and they fail for different reasons:
 *
 *   1. The remainder query RUNS. It is a template literal handed to knex with
 *      `?` bindings, so `yarn type-check` says nothing about it — a wrong
 *      binding count or a column that does not exist only shows up against a
 *      real driver. It is called through the exported function the routes call,
 *      never a copy of the statement, or this would prove nothing about them.
 *
 *   2. No PO line is billed beyond what was ordered. This is the invariant the
 *      whole change is balanced on: once a PO can carry two bills, a per-line
 *      cap that ignores the sibling bills lets the same unit be paid for twice,
 *      averaged into cost twice, and posted to QuickBooks twice. Measured on
 *      production before the change: zero over-billed lines. It has to stay
 *      zero, so this reports the count and fails on anything above it.
 *
 * Read-only. Nothing here writes, and it holds no transaction open.
 *
 * Usage:
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" \
 *     npx medusa exec ./src/scripts/verify/verify-partial-po-billing.ts
 *
 * NOTE it is a `medusa exec` script: run with `tsx` it executes NOTHING and
 * exits 0, which reads exactly like a pass.
 *
 * Exit codes: 0 all good · 1 an assertion failed · 2 could not run.
 */
import type { ExecArgs } from "@medusajs/framework/types";

import {
  ACTIVE_BILL_STATUSES,
  resolveRemainingPoQuantities,
  seedableLines,
  totalRemaining,
} from "../../lib/purchase-orders/po-billed-quantities";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export default async function run({ container }: ExecArgs): Promise<void> {
  const knex = container.resolve("__pg_connection__") as unknown as Knex;
  const failures: string[] = [];

  // ── 1. No PO line is billed past what was ordered ─────────────────────────
  const overBilled = await knex.raw(
    `SELECT po.number                                     AS po_number,
            pol.sku_snapshot                              AS sku,
            GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled, 0), 0)::int
                                                          AS ordered,
            SUM(COALESCE(vbl.qty, 0))::int                AS billed,
            STRING_AGG(DISTINCT vb.number, ', ')          AS bills
       FROM purchase_order_line pol
       JOIN purchase_order po ON po.id = pol.purchase_order_id
       JOIN vendor_bill_line vbl
         ON vbl.purchase_order_line_id = pol.id
        AND vbl.deleted_at IS NULL
        AND COALESCE(vbl.line_type, 'product') = 'product'
       JOIN vendor_bill vb
         ON vb.id = vbl.vendor_bill_id
        AND vb.deleted_at IS NULL
        AND vb.bill_type = 'regular'
        AND vb.status = ANY(?)
      WHERE pol.deleted_at IS NULL
      GROUP BY po.number, pol.id, pol.sku_snapshot, pol.qty_ordered, pol.qty_cancelled
     HAVING SUM(COALESCE(vbl.qty, 0))
          > GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled, 0), 0)
      ORDER BY po.number`,
    [[...ACTIVE_BILL_STATUSES]]
  );
  const overBilledRows = overBilled.rows as Array<{
    po_number: string | null;
    sku: string | null;
    ordered: number;
    billed: number;
    bills: string | null;
  }>;

  if (overBilledRows.length === 0) {
    console.log("PASS  no PO line is billed beyond its ordered quantity");
  } else {
    failures.push(
      `${overBilledRows.length} PO line(s) billed beyond the ordered quantity`
    );
    console.log(
      `FAIL  ${overBilledRows.length} PO line(s) billed beyond ordered:`
    );
    for (const row of overBilledRows.slice(0, 20)) {
      console.log(
        `        ${row.po_number ?? "?"} ${row.sku ?? "?"}: ` +
          `${row.billed} billed vs ${row.ordered} ordered (${row.bills ?? "?"})`
      );
    }
  }

  // ── 2. The remainder query runs, on a PO that really carries bills ────────
  const candidate = await knex.raw(
    `SELECT vb.purchase_order_id AS po_id, po.number AS po_number
       FROM vendor_bill vb
       JOIN purchase_order po ON po.id = vb.purchase_order_id
      WHERE vb.bill_type = 'regular'
        AND vb.purchase_order_id IS NOT NULL
        AND vb.deleted_at IS NULL
        AND vb.status = ANY(?)
      GROUP BY vb.purchase_order_id, po.number
      ORDER BY MAX(vb.created_at) DESC
      LIMIT 1`,
    [[...ACTIVE_BILL_STATUSES]]
  );
  const probe = candidate.rows[0] as
    | { po_id: string; po_number: string | null }
    | undefined;

  if (!probe) {
    failures.push("no billed purchase order to probe the remainder query with");
    console.log("FAIL  no billed purchase order found to probe");
  } else {
    const lines = await resolveRemainingPoQuantities(knex, probe.po_id);
    const ordered = lines.reduce((sum, line) => sum + line.qty_ordered, 0);
    const billed = lines.reduce((sum, line) => sum + line.qty_billed, 0);
    console.log(
      `PASS  remainder query ran on ${probe.po_number ?? probe.po_id}: ` +
        `${lines.length} open line(s), ${ordered} ordered, ${billed} billed, ` +
        `${totalRemaining(lines)} remaining, ` +
        `${seedableLines(lines).length} line(s) a new bill would be seeded with`
    );

    // Arithmetic sanity on real rows: remaining is exactly the difference,
    // floored at 0, and never exceeds what was ordered.
    for (const line of lines) {
      const expected = Math.max(line.qty_ordered - line.qty_billed, 0);
      if (line.qty_remaining !== expected) {
        failures.push(
          `remaining mismatch on ${line.sku_snapshot}: ` +
            `${line.qty_remaining} != ${expected}`
        );
      }
      if (
        typeof line.qty_remaining !== "number" ||
        Number.isNaN(line.qty_remaining)
      ) {
        failures.push(`remaining is not a number on ${line.sku_snapshot}`);
      }
    }

    // Self-exclusion: a bill must not count its own lines against itself, or
    // saving the quantity it already holds would be refused.
    const ownBill = await knex.raw(
      `SELECT id, number FROM vendor_bill
        WHERE purchase_order_id = ? AND bill_type = 'regular'
          AND deleted_at IS NULL AND status = ANY(?)
        ORDER BY created_at LIMIT 1`,
      [probe.po_id, [...ACTIVE_BILL_STATUSES]]
    );
    const own = ownBill.rows[0] as
      | { id: string; number: string | null }
      | undefined;
    if (own) {
      // How many units that bill actually holds against this PO. Asserting
      // "the remainder did not go DOWN" would be satisfied by a query that
      // ignores billed quantities entirely — it stays flat either way — so
      // the check demands the exact amount back.
      const ownQtyRow = await knex.raw(
        `SELECT COALESCE(SUM(vbl.qty), 0)::int AS qty
           FROM vendor_bill_line vbl
           JOIN purchase_order_line pol
             ON pol.id = vbl.purchase_order_line_id
            AND pol.deleted_at IS NULL
            AND COALESCE(pol.status, 'open') <> 'cancelled'
          WHERE vbl.vendor_bill_id = ?
            AND vbl.deleted_at IS NULL
            AND COALESCE(vbl.line_type, 'product') = 'product'`,
        [own.id]
      );
      const ownQty = Number(
        (ownQtyRow.rows[0] as { qty: number | string } | undefined)?.qty ?? 0
      );
      const excluded = await resolveRemainingPoQuantities(
        knex,
        probe.po_id,
        own.id
      );
      const withOwn = totalRemaining(lines);
      const withoutOwn = totalRemaining(excluded);
      const expected = withOwn + ownQty;
      if (withoutOwn !== expected) {
        failures.push(
          `excluding ${own.number ?? own.id} should return its ${ownQty} unit(s) ` +
            `(${withOwn} → ${expected}), got ${withoutOwn}`
        );
        console.log(`FAIL  self-exclusion is wrong for ${own.number ?? own.id}`);
      } else {
        console.log(
          `PASS  excluding ${own.number ?? own.id} returns its ${ownQty} unit(s): ` +
            `${withOwn} → ${withoutOwn} remaining`
        );
      }
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}
