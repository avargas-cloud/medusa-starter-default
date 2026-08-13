/**
 * Gate for the Billed column's yardstick.
 *
 * The column answers "is this purchase order fully invoiced by the vendor", so
 * it measures against what was ORDERED. It used to measure against what had
 * been RECEIVED, which reads `yes` on a PO whose vendor invoiced every unit
 * that arrived while units nobody has billed are still on order: PO-1119 (ET2)
 * ordered 10, received 7, billed 7, and showed `Yes` with 3 uninvoiced.
 *
 * Three things are checked, and they fail for different reasons:
 *
 *   1. The enrichment query RUNS. It is a template literal handed to knex with
 *      `?` bindings, so `yarn type-check` says nothing about it — a wrong
 *      binding count or a missing column only shows up against a real driver.
 *      It goes through `enrichBilledStatusMap`, the function the route calls,
 *      never a copy of the statement.
 *
 *   2. Its verdict matches an INDEPENDENTLY WRITTEN SQL statement, per PO.
 *      A check that re-runs the same query would compare the function against
 *      itself and prove nothing. The statement below is written from the rule,
 *      not copied from the implementation, so a regression in either one shows
 *      up as a disagreement.
 *
 *   3. Adopted header-only bills stay `yes`. They carry zero lines by design
 *      (the accountant's QB bill imported during reconciliation), so their
 *      billed quantity is always 0 — an ordered-based rule without that branch
 *      would strand every one of them in `partial` forever. Measured on
 *      production: 64 POs are in that shape.
 *
 * Read-only. Nothing here writes, and it holds no transaction open.
 *
 * Usage:
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" \
 *     npx medusa exec ./src/scripts/verify/verify-billed-status.ts
 *
 * NOTE it is a `medusa exec` script: run with `tsx` it executes NOTHING and
 * exits 0, which reads exactly like a pass.
 *
 * Exit codes: 0 all good · 1 an assertion failed · 2 could not run.
 */
import type { ExecArgs } from "@medusajs/framework/types";

import { enrichBilledStatusMap } from "../../api/admin/purchase-orders/_lib/billed-status";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

interface ExpectedRow {
  id: string;
  number: string | null;
  billed_qty: number;
  billable_ordered_qty: number;
  adopted: boolean;
  expected: "no" | "partial" | "yes";
}

export default async function run({ container }: ExecArgs): Promise<void> {
  const knex = container.resolve("__pg_connection__") as unknown as Knex;
  const failures: string[] = [];

  // ── The independent statement. Written from the rule, not from the code. ──
  const { rows } = (await knex.raw(
    `WITH ordered AS (
       SELECT pol.purchase_order_id AS po_id,
              SUM(GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled, 0), 0)) AS ordered_qty
         FROM purchase_order_line pol
        WHERE pol.deleted_at IS NULL
          AND COALESCE(pol.status, 'open') <> 'cancelled'
        GROUP BY pol.purchase_order_id
     ),
     per_bill AS (
       SELECT vb.id, vb.purchase_order_id AS po_id, vb.qb_source,
              COALESCE(SUM(vbl.qty), 0) AS qty, COUNT(vbl.id) AS n
         FROM vendor_bill vb
         LEFT JOIN vendor_bill_line vbl
                ON vbl.vendor_bill_id = vb.id
               AND vbl.deleted_at IS NULL
               AND COALESCE(vbl.line_type, 'product') = 'product'
        WHERE vb.bill_type = 'regular'
          AND vb.status IN ('confirmed', 'synced')
          AND vb.deleted_at IS NULL
        GROUP BY vb.id, vb.purchase_order_id, vb.qb_source
     ),
     billed AS (
       SELECT po_id, COALESCE(SUM(qty), 0) AS billed_qty,
              BOOL_OR(n = 0 AND qb_source = 'adopted') AS adopted
         FROM per_bill GROUP BY po_id
     )
     SELECT po.id, po.number,
            COALESCE(b.billed_qty, 0)::int   AS billed_qty,
            COALESCE(o.ordered_qty, 0)::int  AS billable_ordered_qty,
            COALESCE(b.adopted, false)       AS adopted,
            CASE
              WHEN COALESCE(b.billed_qty, 0) <= 0 AND NOT COALESCE(b.adopted, false)
                THEN 'no'
              WHEN COALESCE(b.adopted, false)
                THEN 'yes'
              WHEN COALESCE(o.ordered_qty, 0) <= 0
                THEN 'yes'
              WHEN COALESCE(b.billed_qty, 0) >= COALESCE(o.ordered_qty, 0)
                THEN 'yes'
              ELSE 'partial'
            END AS expected
       FROM purchase_order po
       LEFT JOIN billed  b ON b.po_id = po.id
       LEFT JOIN ordered o ON o.po_id = po.id
      WHERE po.deleted_at IS NULL
      ORDER BY po.created_at`
  )) as { rows: ExpectedRow[] };

  if (rows.length === 0) {
    console.error("FAIL — no purchase orders came back; the check proved nothing");
    process.exit(2);
  }

  // ── 1 + 2. The route's function must agree, PO by PO ─────────────────────
  const actual = await enrichBilledStatusMap(
    knex,
    rows.map((r) => ({ id: r.id }))
  );

  const tally: Record<string, number> = { no: 0, partial: 0, yes: 0 };
  const disagreements: string[] = [];

  for (const row of rows) {
    const got = actual.get(row.id);
    if (!got) {
      disagreements.push(`${row.number ?? row.id}: enrichment returned nothing`);
      continue;
    }
    tally[got.billed_status] = (tally[got.billed_status] ?? 0) + 1;
    if (got.billed_status !== row.expected) {
      disagreements.push(
        `${row.number ?? row.id}: expected '${row.expected}', got '${got.billed_status}' ` +
          `(billed ${row.billed_qty} of ${row.billable_ordered_qty} ordered` +
          `${row.adopted ? ", adopted zero-line" : ""})`
      );
    }
    if (got.billed_qty !== row.billed_qty) {
      disagreements.push(
        `${row.number ?? row.id}: billed_qty ${got.billed_qty} != ${row.billed_qty}`
      );
    }
  }

  if (disagreements.length > 0) {
    failures.push(
      `${disagreements.length} PO(s) disagree with the independent statement:\n  ` +
        disagreements.slice(0, 20).join("\n  ")
    );
  }

  // ── 3. Every adopted zero-line bill still reads 'yes' ────────────────────
  const adoptedRows = rows.filter((r) => r.adopted);
  const adoptedNotYes = adoptedRows.filter(
    (r) => actual.get(r.id)?.billed_status !== "yes"
  );
  if (adoptedNotYes.length > 0) {
    failures.push(
      `${adoptedNotYes.length} adopted zero-line PO(s) left 'yes': ` +
        adoptedNotYes.map((r) => r.number ?? r.id).join(", ")
    );
  }

  // ── Report ───────────────────────────────────────────────────────────────
  const partialWithRemainder = rows.filter(
    (r) => r.expected === "partial"
  );
  console.log(
    `POs: ${rows.length} · no ${tally.no} · partial ${tally.partial} · yes ${tally.yes}`
  );
  console.log(`Adopted zero-line POs held at 'yes': ${adoptedRows.length}`);
  if (partialWithRemainder.length > 0) {
    console.log("Partially billed:");
    for (const r of partialWithRemainder) {
      console.log(
        `  ${r.number ?? r.id}: ${r.billed_qty} of ${r.billable_ordered_qty} ordered ` +
          `(${r.billable_ordered_qty - r.billed_qty} uninvoiced)`
      );
    }
  }

  if (failures.length > 0) {
    console.error("\nFAIL");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nPASS");
}
