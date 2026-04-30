/**
 * Cleanup duplicate apply_payment pipeline rows.
 *
 * Background: pre-fix, when a credit_memo-sourced cpay went through the apply
 * flow before the CM had a TxnID, the handler INSERTed a new "waiting" row
 * (depends_on=CM) instead of updating the existing upfront row (depends_on=invoice).
 * This produced two qb_order_pipeline rows for the same (order_id, reference_id,
 * step='apply_payment') tuple — both eventually confirmed with the same
 * bridge_op_id, but the duplication corrupted the audit log and confused the UI.
 *
 * This script:
 *   1. Detects duplicates (>1 row per order_id+reference_id+'apply_payment').
 *   2. Picks the SURVIVOR — preferring rows in this order:
 *        a) confirmed with non-null payload (the row that actually drove the bridge call)
 *        b) confirmed
 *        c) most recently updated
 *   3. Marks the others as 'skipped' with an explanatory error.
 *      Rows are never deleted (preserves history).
 *
 * Usage:
 *   DATABASE_URL=...  npx ts-node src/scripts/fix/cleanup-duplicate-apply-payment-rows.ts            # report only
 *   DATABASE_URL=...  npx ts-node src/scripts/fix/cleanup-duplicate-apply-payment-rows.ts --apply    # apply
 *
 * SAFETY:
 *   - Always dry-run first.
 *   - Run against sandbox before prod.
 *   - Reversible: rerunning with no duplicates left is a no-op.
 */
import { Client } from "pg";

const APPLY = process.argv.includes("--apply");
const SKIP_REASON =
  "Superseded by canonical apply_payment row — duplicate created pre-fix when CM TxnID was unresolved at dispatch time";

interface DupRow {
  id: string;
  seq: number;
  status: string;
  depends_on: string | null;
  bridge_op_id: string | null;
  qb_txn_id: string | null;
  payload: any;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
}

interface DupGroup {
  order_id: string;
  reference_id: string;
  rows: DupRow[];
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  const client = new Client({ connectionString: url });
  await client.connect();

  console.log(`[cleanup] mode=${APPLY ? "APPLY" : "DRY-RUN"}  db=${url.replace(/:[^:@]+@/, ":***@")}`);

  const { rows: groups } = await client.query(
    `SELECT order_id, reference_id, COUNT(*) AS dup_count
       FROM qb_order_pipeline
      WHERE step = 'apply_payment'
        AND order_id IS NOT NULL
        AND reference_id IS NOT NULL
      GROUP BY order_id, reference_id
     HAVING COUNT(*) > 1`
  );

  if (groups.length === 0) {
    console.log("[cleanup] No duplicate apply_payment groups found. ✓");
    await client.end();
    return;
  }

  console.log(`[cleanup] Found ${groups.length} duplicate group(s):`);

  const dupGroups: DupGroup[] = [];
  for (const g of groups) {
    const { rows: members } = await client.query<DupRow>(
      `SELECT id, seq, status, depends_on, bridge_op_id, qb_txn_id, payload,
              created_at, updated_at, confirmed_at
         FROM qb_order_pipeline
        WHERE step = 'apply_payment'
          AND order_id = $1
          AND reference_id = $2
        ORDER BY created_at ASC`,
      [g.order_id, g.reference_id]
    );
    dupGroups.push({
      order_id: g.order_id,
      reference_id: g.reference_id,
      rows: members,
    });
  }

  let totalSkipped = 0;
  for (const dg of dupGroups) {
    const survivor = pickSurvivor(dg.rows);
    const losers = dg.rows.filter((r) => r.id !== survivor.id);

    console.log(
      `\n  group order=${dg.order_id} ref=${dg.reference_id}  count=${dg.rows.length}`
    );
    for (const r of dg.rows) {
      const tag = r.id === survivor.id ? "KEEP " : "SKIP ";
      const hasPayload = r.payload && Object.keys(r.payload).length > 0;
      console.log(
        `    ${tag} seq=${r.seq} status=${r.status} confirmed_at=${r.confirmed_at ?? "—"} depends_on=${r.depends_on ?? "—"} payload=${hasPayload ? "yes" : "empty"} bridge_op=${r.bridge_op_id ?? "—"}`
      );
    }

    if (APPLY) {
      const loserIds = losers.map((l) => l.id);
      const { rowCount } = await client.query(
        `UPDATE qb_order_pipeline
            SET status     = 'skipped',
                error      = COALESCE(error, '') || $2,
                updated_at = NOW()
          WHERE id = ANY($1::uuid[])
            AND status <> 'skipped'`,
        [loserIds, ` | ${SKIP_REASON}`]
      );
      totalSkipped += rowCount ?? 0;
    } else {
      totalSkipped += losers.length;
    }
  }

  console.log(
    `\n[cleanup] ${APPLY ? "Skipped" : "Would skip"} ${totalSkipped} row(s) across ${dupGroups.length} group(s).`
  );
  if (!APPLY) {
    console.log("[cleanup] Re-run with --apply to commit changes.");
  }

  await client.end();
}

/**
 * Picks the survivor row from a duplicate group:
 *   1. confirmed + payload non-empty (the row that drove the bridge call)
 *   2. confirmed
 *   3. submitted
 *   4. most recently updated
 */
function pickSurvivor(rows: DupRow[]): DupRow {
  const score = (r: DupRow) => {
    const hasPayload = r.payload && Object.keys(r.payload).length > 0;
    if (r.status === "confirmed" && hasPayload) return 4;
    if (r.status === "confirmed") return 3;
    if (r.status === "submitted") return 2;
    return 1;
  };
  const sorted = [...rows].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    if (sa !== sb) return sb - sa;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });
  return sorted[0];
}

main().catch((err) => {
  console.error("[cleanup] fatal:", err);
  process.exit(1);
});
