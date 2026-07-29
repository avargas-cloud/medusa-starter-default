/**
 * Audits the POS orders list on three axes.
 *
 *   1. ORDERS CARRYING MORE MONEY THAN THEY ARE WORTH. A duplicated
 *      application (#1433 sits at exactly 2.00x from the apply_payment dual-key
 *      bug) and a genuine overpayment (#2721 is $417.44 of terminal surcharge)
 *      are indistinguishable from here, so this axis reports and does not
 *      diagnose. A worklist, not an outage — the clamp in axis 2 keeps the
 *      excess out of the field in both cases.
 *
 *   2. The DEPOSIT column, `order.metadata.referential_deposit`, against the
 *      money that defines it:
 *
 *          live applications pointing at the order
 *        + UNAPPLIED remainder of payments locked to the order
 *
 *      The second term is not optional. An application records what a dollar
 *      was imputed AGAINST, not that a dollar arrived: #2654's $18,917.94 check
 *      is in the bank while only $2,141.71 is applied, and an audit that summed
 *      applications alone called that order $16,776.23 short.
 *
 *      As of 2026-07-29 the field means: how much money is sitting on this
 *      order, every source, credits included. It is DERIVED by triggers on
 *      `payment_application` AND `customer_payment`, not accumulated by
 *      callsites.
 *
 *      This SUPERSEDES the 2026-05-08 rule ("external money only, never
 *      credits"). That rule diagnosed a real bug — the same dollar counted
 *      twice, at capture and again at application, which is why #1710 and #2400
 *      sat at exactly 2.00x — but prescribed the wrong cure. Credits were never
 *      the problem; double-counting was, and SET-from-ledger makes it
 *      impossible by construction. Measured before the change: under the strict
 *      May reading 59 settled orders would have started reading as unpaid.
 *
 *      Drift here is now a FAILURE, not a finding. Before the trigger it was
 *      expected (a hand-maintained running total always drifts). After it,
 *      drift means the trigger is not firing.
 *
 *   3. The admin-only "Not Closed in Medusa" tab. Asserts the count is small and
 *      that its members really are POS-closed-but-natively-open — a tab that
 *      quietly grew to include every closed order would be useless.
 *
 * Read-only.
 *
 * Usage:
 *   cd backend && env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-orders-deposit-and-closure.ts
 */
import { Pool } from "pg";

type LedgerRow = {
  display_id: number;
  ledger: string;
  order_total: string;
  mirror: string;
};

type DriftRow = {
  display_id: number;
  mirror: string;
  expected_deposit: string;
  projected: string;
  cause: string;
};

type ClampRow = { display_id: number; mirror: string; order_total: string };

type ClosureRow = { display_id: number; status: string; pos_closed: boolean };

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

/** Shared by both money axes so they cannot drift apart from each other. */
const LEDGER_CTE = `
  WITH applied_per_payment AS (
    SELECT payment_id, SUM(amount_applied) AS cents
    FROM payment_application
    WHERE deleted_at IS NULL AND voided_at IS NULL
    GROUP BY payment_id
  ), unapplied AS (
    -- Money received and locked to the order but not yet imputed to any
    -- invoice. Leaving this out is what made #2654 look $16,776.23 short.
    SELECT cp.locked_order_id AS order_id,
           SUM(GREATEST(0, cp.amount - COALESCE(ap.cents, 0))) / 100.0 AS usd
    FROM customer_payment cp
    LEFT JOIN applied_per_payment ap ON ap.payment_id = cp.id
    WHERE cp.deleted_at IS NULL
      AND cp.locked_order_id IS NOT NULL
      AND cp.status NOT IN ('voided', 'refunded')
    GROUP BY cp.locked_order_id
  ), live AS (
    SELECT order_id, SUM(amount_applied) / 100.0 AS usd
    FROM payment_application
    WHERE deleted_at IS NULL AND voided_at IS NULL AND order_id IS NOT NULL
    GROUP BY order_id
  ), voided AS (
    SELECT order_id, SUM(amount_applied) / 100.0 AS usd
    FROM payment_application
    WHERE deleted_at IS NULL AND voided_at IS NOT NULL AND order_id IS NOT NULL
    GROUP BY order_id
  ), native AS (
    SELECT opc.order_id,
           SUM(COALESCE(pc.captured_amount, 0) - COALESCE(pc.refunded_amount, 0)) AS usd
    FROM order_payment_collection opc
    JOIN payment_collection pc
      ON pc.id = opc.payment_collection_id AND pc.deleted_at IS NULL
    WHERE opc.deleted_at IS NULL
    GROUP BY opc.order_id
  ), base AS (
    SELECT
      o.display_id,
      COALESCE(NULLIF(o.metadata->>'referential_deposit', '')::numeric, 0) AS mirror,
      COALESCE(l.usd, 0) + COALESCE(un.usd, 0) AS ledger,
      COALESCE(un.usd, 0) AS unapplied,
      COALESCE(v.usd, 0) AS ledger_voided,
      COALESCE(n.usd, 0) AS native_captured,
      CASE
        WHEN COALESCE(NULLIF(o.metadata->>'pos_total', '')::numeric, 0) > 0
          THEN COALESCE(NULLIF(o.metadata->>'pos_total', '')::numeric, 0)
        ELSE COALESCE((
          SELECT (os.totals->>'current_order_total')::numeric
          FROM order_summary os
          WHERE os.order_id = o.id AND os.deleted_at IS NULL AND os.version = o.version
          LIMIT 1
        ), 0)
      END AS order_total
    FROM "order" o
    LEFT JOIN live      l  ON l.order_id  = o.id
    LEFT JOIN unapplied un ON un.order_id = o.id
    LEFT JOIN voided    v  ON v.order_id  = o.id
    LEFT JOIN native    n  ON n.order_id  = o.id
    WHERE o.deleted_at IS NULL AND o.is_draft_order = false AND o.status <> 'canceled'
  )
`;

const LEDGER_SANITY_SQL = `
  ${LEDGER_CTE}
  SELECT display_id,
         round(ledger, 2)::text      AS ledger,
         round(order_total, 2)::text AS order_total,
         round(mirror, 2)::text      AS mirror
  FROM base
  WHERE order_total > 0 AND ledger > order_total + 0.02
  ORDER BY (ledger - order_total) DESC
`;

/**
 * The operator's hard invariant (2026-07-29): the field never exceeds the order
 * total. Pay $5,000 on a $4,000 order and $1,000 stays an unlinked payment for
 * a future order — claiming it here attributes parked money to this order. 18
 * orders were violating this when the rule was written.
 */
const CLAMP_SQL = `
  ${LEDGER_CTE}
  SELECT display_id,
         round(mirror, 2)::text      AS mirror,
         round(order_total, 2)::text AS order_total
  FROM base
  WHERE order_total > 0 AND mirror > order_total + 0.02
  ORDER BY (mirror - order_total) DESC
`;

/**
 * Drift is measured against the AUTHORITY, not against a formula re-typed here.
 *
 * `order_money_projection` is the authority and `order.metadata` is its mirror,
 * so this axis asks two questions and invents no third definition:
 *
 *   1. does the mirror still equal the projection?  (a metadata write clobbered it)
 *   2. does the projection still equal a fresh recomputation?  (a trigger did not fire)
 *
 * The original version of this audit baselined the field against a formula of
 * its own, which is how it came to call 72 inflated rows clean and 19 correct
 * ones drifted. Comparing to the authority is what stops that from recurring.
 */
const DRIFT_SQL = `
  WITH fresh AS (
    SELECT
      o.id,
      o.display_id,
      COALESCE((
        SELECT SUM(pa.amount_applied) FROM payment_application pa
        WHERE pa.order_id = o.id AND pa.deleted_at IS NULL AND pa.voided_at IS NULL
      ), 0)::bigint AS applied,
      COALESCE((
        SELECT SUM(GREATEST(0, cp.amount - COALESCE(ap.cents, 0)))
        FROM customer_payment cp
        LEFT JOIN (
          SELECT payment_id, SUM(amount_applied) AS cents FROM payment_application
          WHERE deleted_at IS NULL AND voided_at IS NULL GROUP BY payment_id
        ) ap ON ap.payment_id = cp.id
        WHERE COALESCE(cp.locked_order_id, cp.metadata->>'order_id') = o.id
          AND cp.deleted_at IS NULL AND cp.status NOT IN ('voided', 'refunded')
      ), 0)::bigint AS unapplied,
      round(
        CASE
          WHEN COALESCE(NULLIF(o.metadata->>'pos_total', '')::numeric, 0) > 0
            THEN COALESCE(NULLIF(o.metadata->>'pos_total', '')::numeric, 0)
          ELSE COALESCE((
            SELECT (os.totals->>'current_order_total')::numeric FROM order_summary os
            WHERE os.order_id = o.id AND os.deleted_at IS NULL AND os.version = o.version
            LIMIT 1
          ), 0)
        END * 100
      )::bigint AS total,
      round(COALESCE(NULLIF(o.metadata->>'referential_deposit', '')::numeric, 0) * 100)::bigint AS mirror
    FROM "order" o
    WHERE o.deleted_at IS NULL
  ), expected AS (
    SELECT f.*,
           CASE WHEN f.total > 0 THEN LEAST(f.unapplied, GREATEST(0, f.total - f.applied))
                ELSE f.unapplied END AS deposit
    FROM fresh f
  )
  SELECT e.display_id,
         round(e.mirror / 100.0, 2)::text    AS mirror,
         round(e.deposit / 100.0, 2)::text   AS expected_deposit,
         round(COALESCE(p.deposit_cents, -1) / 100.0, 2)::text AS projected,
         CASE
           WHEN p.order_id IS NULL              THEN 'no projection row at all'
           WHEN p.deposit_cents <> e.deposit    THEN 'projection stale — a trigger did not fire'
           ELSE 'mirror clobbered — a metadata write overwrote it'
         END AS cause
  FROM expected e
  LEFT JOIN order_money_projection p ON p.order_id = e.id
  WHERE e.mirror <> e.deposit
     OR p.order_id IS NULL
     OR p.deposit_cents <> e.deposit
  ORDER BY abs(e.mirror - e.deposit) DESC
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
    console.log("\n1 · the LEDGER: orders that applied more than they are worth\n");
    const broken = (await pool.query<LedgerRow>(LEDGER_SANITY_SQL)).rows;
    if (broken.length === 0) {
      console.log("  (none — every order's applied total fits inside the order)");
    } else {
      for (const r of broken) {
        console.log(
          `  #${r.display_id}: ledger $${r.ledger} against a $${r.order_total} order` +
            `  (field says $${r.mirror})`
        );
      }
      console.log(
        `\n  ${broken.length} order(s) carry more money than the order is worth.` +
          ` This axis cannot tell WHY: a duplicated application (#1433 sits at` +
          ` exactly 2.00x from the apply_payment dual-key bug) and a genuine` +
          ` overpayment (#2721 is $417.44 of terminal surcharge) look identical` +
          ` from here. Both want a human. The clamp keeps the excess out of the` +
          ` field either way, so this is a worklist, not an outage.`
      );
    }

    console.log("\n2 · the CLAMP: no order's deposit may exceed the order\n");
    const overTotal = (await pool.query<ClampRow>(CLAMP_SQL)).rows;
    check(
      `${overTotal.length} order(s) with a deposit above their own total`,
      overTotal.length === 0,
      overTotal.length === 0
        ? "the clamp holds everywhere"
        : overTotal
            .slice(0, 12)
            .map((r) => `#${r.display_id} $${r.mirror} on $${r.order_total}`)
            .join(", ")
    );

    console.log("\n3 · DEPOSIT: mirror vs authority vs a fresh recomputation\n");
    const drift = (await pool.query<DriftRow>(DRIFT_SQL)).rows;
    check(
      `${drift.length} order(s) out of step`,
      drift.length === 0,
      drift.length === 0
        ? "mirror = projection = recomputation, everywhere"
        : "each row below names which of the two links broke"
    );
    for (const r of drift.slice(0, 20)) {
      console.log(
        `        #${r.display_id}: mirror $${r.mirror}, projection $${r.projected}, ` +
          `should be $${r.expected_deposit}  — ${r.cause}`
      );
    }
    if (drift.length > 20) console.log(`        … and ${drift.length - 20} more`);

    console.log("\n4 · admin-only \"Not Closed in Medusa\" tab\n");
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
        ? "\nOK — invariants hold.\n"
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
