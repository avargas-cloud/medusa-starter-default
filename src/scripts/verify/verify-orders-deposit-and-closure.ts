/**
 * Audits the POS orders list on two axes.
 *
 *   1. The DEPOSIT column, which still reads
 *      `order.metadata.referential_deposit` — a hand-maintained mirror of the
 *      linked-payment total. This lists every order where the mirror and the
 *      payment ledger disagree, classified by cause.
 *
 *      Switching the column to the ledger was built on 2026-07-29 and REVERTED
 *      before shipping: `payment_application` has 33 orders with the same
 *      payment applied twice (the known apply_payment dual-key bug), and 21
 *      orders differ from the mirror for reasons this audit could not explain.
 *      Replacing an unexplained number with another unexplained number is not a
 *      fix for a money column. Resolve the duplicates and the 21 first; this
 *      script is the worklist.
 *
 *   2. The admin-only "Not Closed in Medusa" tab, which DID ship. Asserts the
 *      count is small and that its members really are POS-closed-but-natively
 *      -open — a tab that quietly grew to include every closed order would be
 *      useless.
 *
 * Read-only. Exits non-zero only on a broken invariant, not on drift: the
 * drifted rows are the finding, and correcting them is a separate backfill.
 *
 * Usage:
 *   cd backend && env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-orders-deposit-and-closure.ts
 */
import { Pool } from "pg";

type DriftRow = {
  display_id: number;
  mirror: string;
  ledger_live: string;
  ledger_voided: string;
  cause: string;
};

type ClosureRow = { display_id: number; status: string; pos_closed: boolean };

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const DRIFT_SQL = `
  WITH live AS (
    SELECT order_id, SUM(amount_applied)/100.0 AS usd FROM payment_application
    WHERE deleted_at IS NULL AND voided_at IS NULL AND order_id IS NOT NULL
    GROUP BY order_id
  ), voided AS (
    SELECT order_id, SUM(amount_applied)/100.0 AS usd FROM payment_application
    WHERE deleted_at IS NULL AND voided_at IS NOT NULL AND order_id IS NOT NULL
    GROUP BY order_id
  )
  SELECT o.display_id,
         round(COALESCE(NULLIF(o.metadata->>'referential_deposit','')::numeric,0),2)::text AS mirror,
         round(COALESCE(live.usd,0),2)::text   AS ledger_live,
         round(COALESCE(voided.usd,0),2)::text AS ledger_voided,
         CASE
           WHEN COALESCE(NULLIF(o.metadata->>'referential_deposit','')::numeric,0) = 0
             THEN 'mirror empty, ledger has money'
           WHEN COALESCE(live.usd,0) = 0 AND COALESCE(voided.usd,0) > 0
             THEN 'unlinked (application voided), mirror never reduced'
           WHEN abs(COALESCE(NULLIF(o.metadata->>'referential_deposit','')::numeric,0)
                    - 2*COALESCE(live.usd,0)) < 0.02
             THEN 'mirror is exactly double the ledger'
           WHEN abs(COALESCE(NULLIF(o.metadata->>'referential_deposit','')::numeric,0)
                    - (COALESCE(live.usd,0)+COALESCE(voided.usd,0))) < 0.02
             THEN 'mirror equals live + voided'
           ELSE 'unexplained'
         END AS cause
  FROM "order" o
  LEFT JOIN live   ON live.order_id = o.id
  LEFT JOIN voided ON voided.order_id = o.id
  WHERE o.deleted_at IS NULL AND o.is_draft_order = false AND o.status <> 'canceled'
    AND abs(COALESCE(NULLIF(o.metadata->>'referential_deposit','')::numeric,0)
            - COALESCE(live.usd,0)) > 0.02
  ORDER BY abs(COALESCE(NULLIF(o.metadata->>'referential_deposit','')::numeric,0)
               - COALESCE(live.usd,0)) DESC
`;

const CLOSURE_SQL = `
  SELECT o.display_id, o.status,
         COALESCE((o.metadata->>'pos_closed')::boolean, false) AS pos_closed
  FROM "order" o
  WHERE o.deleted_at IS NULL AND o.is_draft_order = false AND o.status <> 'canceled'
    AND o.status NOT IN ('completed','archived')
    AND EXISTS (
      SELECT 1 FROM order_fulfillment ofl
      JOIN fulfillment fu ON fu.id = ofl.fulfillment_id
        AND fu.deleted_at IS NULL AND fu.canceled_at IS NULL
        AND (fu.delivered_at IS NOT NULL OR fu.shipped_at IS NOT NULL)
      WHERE ofl.order_id = o.id AND ofl.deleted_at IS NULL
    )
  ORDER BY o.display_id DESC
`;

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    console.log("\n1 · DEPOSIT column: the mirror it still shows, vs the ledger\n");
    const drift = (await pool.query<DriftRow>(DRIFT_SQL)).rows;
    if (drift.length === 0) {
      console.log("  (no drift — the mirror agrees with the ledger everywhere)");
    } else {
      const byCause = new Map<string, DriftRow[]>();
      for (const row of drift) {
        byCause.set(row.cause, [...(byCause.get(row.cause) ?? []), row]);
      }
      for (const [cause, rows] of [...byCause].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`  ${rows.length.toString().padStart(3)} × ${cause}`);
        for (const r of rows.slice(0, 6)) {
          console.log(
            `        #${r.display_id}: column shows $${r.mirror}, ledger says $${r.ledger_live}` +
              (Number(r.ledger_voided) > 0 ? `  (voided: $${r.ledger_voided})` : "")
          );
        }
        if (rows.length > 6) console.log(`        … and ${rows.length - 6} more`);
      }
      const unexplained = byCause.get("unexplained") ?? [];
      console.log(
        `\n  ${drift.length} order(s) show a Deposit that disagrees with the ledger. ` +
          `${unexplained.length} unexplained — resolve these before trusting either side.`
      );
    }

    console.log("\n2 · admin-only \"Not Closed in Medusa\" tab\n");
    const closure = (await pool.query<ClosureRow>(CLOSURE_SQL)).rows;
    check(
      `${closure.length} order(s) POS-closed but natively open`,
      closure.length > 0 && closure.length < 200,
      closure.length === 0
        ? "empty — nothing to reconcile (or the predicate stopped matching)"
        : `#${closure.map((r) => r.display_id).slice(0, 20).join(", #")}`
    );
    check(
      "none of them is natively completed or archived",
      closure.every((r) => r.status !== "completed" && r.status !== "archived"),
      "the tab must not overlap the Closed tab's native members"
    );

    console.log(
      failures === 0
        ? "\nOK — invariants hold. The Deposit changes above are the intended correction.\n"
        : `\n${failures} check(s) FAILED.\n`
    );
  } finally {
    await pool.end();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
