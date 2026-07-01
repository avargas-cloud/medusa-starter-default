/**
 * verify-vendor-bill-edit.ts
 *
 * Invariant checks for the Vendor Bill (REGULAR) improvements
 * (docs/VENDOR_BILL_REGULAR_IMPROVEMENTS_PLAN.md). SQL-only — does not import
 * the recompute helper (dynamic relative-TS import is unreliable under
 * `medusa exec`). Run against the sandbox after building the feature:
 *
 *   env DATABASE_URL=... medusa exec ./src/scripts/verify/verify-vendor-bill-edit.ts
 */

type Pg = { raw: (sql: string, b?: unknown[]) => Promise<{ rows: any[] }> };

export default async function verifyVendorBillEdit({ container }: { container: { resolve: (k: string) => unknown } }) {
  const pg = container.resolve("__pg_connection__") as Pg;
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // 1. Phase 0 — column exists.
  const col = await pg.raw(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name='vendor_bill_line' AND column_name='purchase_order_line_id'`
  );
  checks.push({
    name: "Phase 0: purchase_order_line_id column",
    ok: col.rows.length === 1,
    detail: col.rows.length === 1 ? "present" : "MISSING",
  });

  // 2. Phase 0 — no receipt-sourced product line left without a pol_id.
  const unbackfilled = await pg.raw(
    `SELECT count(*)::int AS n FROM vendor_bill_line
      WHERE receipt_line_id IS NOT NULL
        AND purchase_order_line_id IS NULL
        AND coalesce(line_type,'product')='product'
        AND deleted_at IS NULL`
  );
  const nUn = Number(unbackfilled.rows[0]?.n ?? 0);
  checks.push({
    name: "Phase 0: receipt-sourced lines backfilled",
    ok: nUn === 0,
    detail: `${nUn} receipt-sourced product lines still NULL`,
  });

  // 3. Phase 1/2/3 — for draft regular bills NOT on a confirmed wire, the cfb
  //    amount must equal SUM(line unit_cost*qty) (lock relaxed + recompute tracks).
  const drift = await pg.raw(
    `WITH sums AS (
       SELECT vbl.vendor_bill_id, SUM(vbl.unit_cost_cents::bigint * vbl.qty)::bigint AS line_sum
       FROM vendor_bill_line vbl WHERE vbl.deleted_at IS NULL
       GROUP BY vbl.vendor_bill_id
     )
     SELECT cfb.vendor_bill_id, cfb.amount_cents, s.line_sum
     FROM china_finance_bill cfb
     JOIN vendor_bill vb ON vb.id = cfb.vendor_bill_id
     JOIN sums s ON s.vendor_bill_id = cfb.vendor_bill_id
     WHERE vb.bill_type='regular' AND vb.status='draft' AND vb.deleted_at IS NULL
       AND cfb.type='vendor_bill'
       AND NOT EXISTS (
         SELECT 1 FROM china_wire_transfer_application a
         JOIN china_wire_transfer w ON w.id=a.wire_transfer_id
         WHERE a.bill_id=cfb.id AND w.status='confirmed'
       )
       AND cfb.amount_cents <> s.line_sum`
  );
  checks.push({
    name: "Phase 1/2/3: draft cfb amount tracks line sum (no confirmed wire)",
    ok: drift.rows.length === 0,
    detail: drift.rows.length === 0 ? "all in sync" : `${drift.rows.length} bills drifted: ` +
      drift.rows.slice(0, 5).map((r) => `${r.vendor_bill_id}(${r.amount_cents}≠${r.line_sum})`).join(", "),
  });

  // 4. Phase 1/4 — no scheduled wire is under-funded (wire < SUM apps → lost surplus/negative).
  const underfunded = await pg.raw(
    `SELECT w.id, w.wire_amount_cents, COALESCE(SUM(a.applied_cents),0)::bigint AS sum_apps
     FROM china_wire_transfer w
     LEFT JOIN china_wire_transfer_application a ON a.wire_transfer_id=w.id
     WHERE w.status='draft'
     GROUP BY w.id, w.wire_amount_cents
     HAVING w.wire_amount_cents < COALESCE(SUM(a.applied_cents),0)`
  );
  checks.push({
    name: "Phase 1/4: scheduled wires never under-funded (wire >= SUM apps)",
    ok: underfunded.rows.length === 0,
    detail: underfunded.rows.length === 0 ? "all wires >= apps" : `${underfunded.rows.length} under-funded wires`,
  });

  // 5. Phase 3b — at most one regular bill pinned per receipt (UNIQUE intent).
  const dupPin = await pg.raw(
    `SELECT purchase_order_receipt_id, count(*)::int AS n
     FROM vendor_bill
     WHERE bill_type='regular' AND purchase_order_receipt_id IS NOT NULL AND deleted_at IS NULL
     GROUP BY purchase_order_receipt_id HAVING count(*) > 1`
  );
  checks.push({
    name: "Phase 3b: one regular bill per receipt",
    ok: dupPin.rows.length === 0,
    detail: dupPin.rows.length === 0 ? "unique" : `${dupPin.rows.length} receipts with multiple bills`,
  });

  const failed = checks.filter((c) => !c.ok);
  console.log("\n── Vendor Bill Edit — invariant checks ──");
  for (const c of checks) console.log(`  ${c.ok ? "✅" : "❌"} ${c.name}\n       ${c.detail}`);
  console.log(`\n${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`}\n`);
}
