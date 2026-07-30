/**
 * verify-po-tracking-allocations — the invariants per-line PO tracking promises.
 *
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     npx medusa exec ./src/scripts/verify/verify-po-tracking-allocations.ts
 *
 * Read-only. Exits 1 if any check fails.
 *
 * WHY THESE SEVEN
 * The cap is a sum across sibling rows, so no database constraint can hold it —
 * it lives in the service, inside a transaction, and that means it can be
 * bypassed by a bug or by anyone writing SQL by hand. Check 1 is the one that
 * matters: it re-derives the cap from the data and does not care who wrote it.
 *
 * Checks 3 and 4 defend the meaning of `scope`. An `all_order` entry claims no
 * quantity ON PURPOSE (otherwise the first one swallows the PO and a second
 * shipment can never be added); if one ever grew allocations, every remainder
 * on that PO would be wrong in a way nothing else would notice.
 *
 * Check 7 is the backfill's invariant, and it is deliberately one-directional:
 * every legacy JSON entry must exist as a row, but rows added after the cutover
 * have no JSON counterpart and that is correct — the column is frozen, not
 * mirrored.
 */

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

interface Check {
  name: string;
  sql: string;
  /** How to describe one offending row. */
  describe: (row: Record<string, unknown>) => string;
}

const CHECKS: Check[] = [
  {
    name: "1. no line is allocated beyond qty_ordered - qty_cancelled",
    sql: `SELECT pol.id                                   AS line_id,
                 pol.sku_snapshot,
                 GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled, 0), 0)::int AS ceiling,
                 SUM(trkl.qty_allocated)::int            AS allocated
            FROM purchase_order_tracking_line trkl
            JOIN purchase_order_tracking trk
              ON trk.id = trkl.purchase_order_tracking_id
             AND trk.deleted_at IS NULL
             AND trk.scope = 'by_line'
            JOIN purchase_order_line pol
              ON pol.id = trkl.purchase_order_line_id
           WHERE trkl.deleted_at IS NULL
           GROUP BY pol.id, pol.sku_snapshot, pol.qty_ordered, pol.qty_cancelled
          HAVING SUM(trkl.qty_allocated)
                 > GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled, 0), 0)`,
    describe: (r) =>
      `line ${r.line_id} (${r.sku_snapshot}): ${r.allocated} allocated vs ceiling ${r.ceiling}`,
  },
  {
    name: "2. no allocation points at a missing or deleted PO line",
    sql: `SELECT trkl.id, trkl.purchase_order_line_id
            FROM purchase_order_tracking_line trkl
            LEFT JOIN purchase_order_line pol
              ON pol.id = trkl.purchase_order_line_id
             AND pol.deleted_at IS NULL
           WHERE trkl.deleted_at IS NULL
             AND pol.id IS NULL`,
    describe: (r) =>
      `allocation ${r.id} references missing line ${r.purchase_order_line_id}`,
  },
  {
    name: "3. an all_order tracking claims no quantity",
    sql: `SELECT trk.id, COALESCE(
              (SELECT n.tracking_number FROM purchase_order_tracking_number n
                WHERE n.purchase_order_tracking_id = trk.id AND n.deleted_at IS NULL
                ORDER BY n.is_master DESC, n.created_at, n.id LIMIT 1), trk.id) AS tracking_number, count(*)::int AS allocations
            FROM purchase_order_tracking trk
            JOIN purchase_order_tracking_line trkl
              ON trkl.purchase_order_tracking_id = trk.id
             AND trkl.deleted_at IS NULL
           WHERE trk.deleted_at IS NULL
             AND trk.scope = 'all_order'
           GROUP BY trk.id`,
    describe: (r) =>
      `all_order tracking ${r.tracking_number} has ${r.allocations} allocation(s)`,
  },
  {
    name: "4. a by_line tracking carries at least one line",
    sql: `SELECT trk.id, COALESCE(
              (SELECT n.tracking_number FROM purchase_order_tracking_number n
                WHERE n.purchase_order_tracking_id = trk.id AND n.deleted_at IS NULL
                ORDER BY n.is_master DESC, n.created_at, n.id LIMIT 1), trk.id) AS tracking_number
            FROM purchase_order_tracking trk
           WHERE trk.deleted_at IS NULL
             AND trk.scope = 'by_line'
             AND NOT EXISTS (
                   SELECT 1 FROM purchase_order_tracking_line trkl
                    WHERE trkl.purchase_order_tracking_id = trk.id
                      AND trkl.deleted_at IS NULL)`,
    describe: (r) => `by_line tracking ${r.tracking_number} carries no lines`,
  },
  {
    name: "5. no duplicate (tracking, line) pair",
    sql: `SELECT purchase_order_tracking_id, purchase_order_line_id, count(*)::int AS n
            FROM purchase_order_tracking_line
           WHERE deleted_at IS NULL
           GROUP BY purchase_order_tracking_id, purchase_order_line_id
          HAVING count(*) > 1`,
    describe: (r) =>
      `tracking ${r.purchase_order_tracking_id} + line ${r.purchase_order_line_id} appears ${r.n} times`,
  },
  {
    name: "6. every allocation carries a positive quantity",
    sql: `SELECT id, qty_allocated
            FROM purchase_order_tracking_line
           WHERE deleted_at IS NULL AND qty_allocated <= 0`,
    describe: (r) => `allocation ${r.id} has qty ${r.qty_allocated}`,
  },
  {
    // A partial unique index stops TWO masters, but nothing stops ZERO — and a
    // delivery with no master has no name to put on a document, so every screen
    // quoting it silently falls back or shows blank. Half of this invariant is
    // in the database and half can only be checked here; this is the half.
    name: "9. every shipment has exactly one master number",
    sql: `SELECT trk.id,
                 count(*) FILTER (WHERE n.is_master)::int AS masters,
                 count(n.id)::int                         AS numbers
            FROM purchase_order_tracking trk
            LEFT JOIN purchase_order_tracking_number n
              ON n.purchase_order_tracking_id = trk.id AND n.deleted_at IS NULL
           WHERE trk.deleted_at IS NULL
           GROUP BY trk.id
          HAVING count(*) FILTER (WHERE n.is_master) <> 1`,
    describe: (r) =>
      `shipment ${r.id}: ${r.masters} master(s) across ${r.numbers} number(s)`,
  },
  {
    // The one invariant with no database backstop at all: mutual exclusion is a
    // property of a SET of rows, so only the service can hold it. If it ever
    // leaks, every remainder on that PO is wrong — an all_order entry claims
    // the whole document, so a by_line sibling is claiming units already spoken
    // for, and nothing else in the system would notice.
    name: "8. no PO mixes whole-PO and per-item tracking",
    sql: `SELECT purchase_order_id,
                 count(*) FILTER (WHERE scope = 'all_order')::int AS all_order,
                 count(*) FILTER (WHERE scope = 'by_line')::int   AS by_line
            FROM purchase_order_tracking
           WHERE deleted_at IS NULL
           GROUP BY purchase_order_id
          HAVING count(*) FILTER (WHERE scope = 'all_order') > 0
             AND count(*) FILTER (WHERE scope = 'by_line') > 0`,
    describe: (r) =>
      `PO ${r.purchase_order_id}: ${r.all_order} whole-PO + ${r.by_line} per-item tracking(s)`,
  },
  {
    // The backfill's invariant, and deliberately one-directional: every legacy
    // JSON entry must survive as a NUMBER, but numbers added after the cutover
    // have no JSON counterpart and that is correct — the column is frozen, not
    // mirrored.
    //
    // It looks in the NUMBER table, not the shipment table, because the merge
    // in Migration20260730230000 collapsed sibling whole-PO shipments into one:
    // the losing shipment rows are gone, while every one of their numbers moved
    // to the keeper. A legacy entry surviving as a number is exactly what
    // "nothing was lost" means under the current model.
    name: "7. every legacy JSON tracking entry survives as a tracking number",
    sql: `SELECT po.id AS po_id, j->>'id' AS legacy_id, j->>'tracking_number' AS number
            FROM purchase_order po
            CROSS JOIN LATERAL jsonb_array_elements(po.tracking::jsonb) AS j
           WHERE po.deleted_at IS NULL
             AND po.tracking IS NOT NULL
             AND jsonb_typeof(po.tracking::jsonb) = 'array'
             AND NOT EXISTS (
                   SELECT 1 FROM purchase_order_tracking_number n
                    WHERE n.id = 'potrkn_' || (j->>'id')
                       OR n.id = j->>'id')`,
    describe: (r) =>
      `PO ${r.po_id}: legacy entry ${r.number} (${r.legacy_id}) was never migrated`,
  },
];

export default async function run({
  container,
}: {
  container: { resolve: (k: string) => unknown };
}): Promise<void> {
  const db = container.resolve("__pg_connection__") as Knex;

  // Context first: a run against an empty table passes every check and means
  // nothing. Print the population so a vacuous green is visible as vacuous.
  const counts = await db.raw(
    `SELECT (SELECT count(*) FROM purchase_order_tracking WHERE deleted_at IS NULL) AS trackings,
            (SELECT count(*) FROM purchase_order_tracking WHERE deleted_at IS NULL AND scope='by_line') AS by_line,
            (SELECT count(*) FROM purchase_order_tracking_line WHERE deleted_at IS NULL) AS allocations`
  );
  const c = counts.rows[0] as Record<string, unknown>;
  process.stdout.write(
    `\nPopulation: ${c.trackings} tracking(s) · ${c.by_line} by_line · ${c.allocations} allocation(s)\n\n`
  );

  let failed = 0;
  for (const check of CHECKS) {
    const result = await db.raw(check.sql);
    const rows = result.rows as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      process.stdout.write(`  PASS  ${check.name}\n`);
      continue;
    }
    failed++;
    process.stdout.write(`  FAIL  ${check.name}  (${rows.length} offender(s))\n`);
    for (const row of rows.slice(0, 10)) {
      process.stdout.write(`          ${check.describe(row)}\n`);
    }
    if (rows.length > 10) {
      process.stdout.write(`          … and ${rows.length - 10} more\n`);
    }
  }

  process.stdout.write(
    `\n${failed === 0 ? "ALL CHECKS PASS" : `${failed} CHECK(S) FAILED`}\n\n`
  );
  if (failed > 0) process.exitCode = 1;
}
