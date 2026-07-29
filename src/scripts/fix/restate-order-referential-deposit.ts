/**
 * restate-order-referential-deposit.ts
 *
 * Restates `order.metadata.referential_deposit` to the money actually sitting
 * on each order.
 *
 * WHY THIS EXISTS
 * ---------------
 * The field is a hand-maintained running total: every path that moves money on
 * an order increments or decrements it. A running total maintained by hand,
 * mirroring a number the database can compute exactly, drifts by construction —
 * every path has to remember, and some never did. 42 orders had drifted by
 * 2026-07-29. They are not 42 accidents; they are what that design produces.
 *
 * WHAT THE FIELD MEANS, AS OF 2026-07-29
 * --------------------------------------
 * How much money is sitting on this order — every source, credit-memo
 * redemptions included. This SUPERSEDES the 2026-05-08 rule ("external money
 * only, never credits"). That rule diagnosed a real bug — the same dollar
 * counted twice, once at capture and once at application, which is why #1710
 * and #2400 sit at exactly 2.00x — but prescribed the wrong cure. Credits were
 * never the problem; double-counting was. Deriving the value makes
 * double-counting impossible by construction and makes the credit question
 * moot. Measured: under the strict May reading, 59 settled orders would have
 * started reading as unpaid, because nothing in getPaidAmount() counts credit
 * redemptions.
 *
 * THE TARGET IS NOT THE APPLICATION LEDGER ALONE
 * ----------------------------------------------
 *     target = live applications pointing at the order
 *            + the UNAPPLIED remainder of payments locked to the order
 *
 * An application records what a dollar was imputed AGAINST; it is not evidence
 * that a dollar arrived. A deposit that is received, locked to the order and
 * not yet applied to any invoice is money on that order. The first version of
 * this script summed applications only, and erased exactly that.
 *
 * #2654 is why the second term exists. Its $18,917.94 check is in the bank,
 * unrefunded and unvoided; the invoice it was applied to got voided and the
 * order was re-invoiced at $2,141.71. Summing applications would have restated
 * an $18,917.94 order down to $2,141.71 — telling a cashier to collect
 * $16,776.23 the customer had already paid. The field was RIGHT and the
 * measurement was wrong. #2721 is the same shape: $417.44 of terminal
 * surcharge sitting unapplied above the order total.
 *
 * Payments with status 'voided' or 'refunded' are excluded — that money is not
 * on the order any more. #1707 is the entire refunded population: one $79.72
 * payment, returned to the customer, with the field still claiming it.
 *
 * THE FIELD IS CLAMPED TO THE ORDER TOTAL. NEVER ABOVE IT.
 * --------------------------------------------------------
 * Operator's rule, 2026-07-29. Pay $5,000 against a $4,000 order and only
 * $4,000 is this order's deposit; the other $1,000 is an unlinked payment the
 * customer can put toward a future order, and showing it here would claim for
 * this order money that is deliberately parked. 18 orders were violating this
 * when it was written.
 *
 * The clamp also replaces what used to be a refusal. Rows whose raw target
 * exceeded the total were skipped, to avoid laundering a duplicated ledger
 * (#1433 sits at exactly 2.00x from the apply_payment dual-key bug) into money
 * metadata. The clamp makes that impossible by construction — the written
 * value can never exceed the total — so those rows are now written at the
 * clamped value and still REPORTED, and the duplicated ledger stays visible in
 * verify-orders-deposit-and-closure.ts axis 1 for manual resolution.
 *
 * FAIL-OPEN on an unknown total: if neither `pos_total` nor the current
 * `order_summary` gives a positive total, the value is left unclamped rather
 * than clamped to zero. Clamping to a total you could not read is how a
 * deposit silently becomes $0. This mirrors the reservation clamp's
 * `total_unknown → fail-open` rule.
 *
 * This script does not move a single cent of real money: `customer_payment` and
 * `payment_application` are read-only here. It corrects the mirror only.
 *
 * Usage:
 *   DRY RUN: cd backend && env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *              ./node_modules/.bin/tsx src/scripts/fix/restate-order-referential-deposit.ts
 *   APPLY:   ... APPLY=true ./node_modules/.bin/tsx src/scripts/fix/restate-order-referential-deposit.ts
 */
import { Pool, PoolClient } from "pg";

const PLAN_ID = "fix-referential-deposit-v1";
const TOLERANCE = 0.02;
const CHUNK_SIZE = 500;

interface PlanRow {
  id: string;
  displayId: number;
  /** Current value of the field — the CAS expectation. */
  expected: number;
  /** Live applications pointing at this order. */
  applied: number;
  /** Unapplied remainder of payments locked to this order. */
  unapplied: number;
  /** applied + unapplied, BEFORE the clamp. */
  rawTarget: number;
  /** min(rawTarget, orderTotal). What actually gets written. */
  target: number;
  /** The credit-memo half of the applications. Medusa never captures this. */
  appliedCredit: number;
  /** Independent corroboration: Medusa's own captured-minus-refunded. */
  nativeCaptured: number;
  orderTotal: number;
}

interface Plan {
  writes: PlanRow[];
}

const money = (n: number): string => `$${n.toFixed(2)}`;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * `applied_per_payment` must sum a payment's applications to EVERY target, not
 * just this order: the unapplied remainder is what is left of the payment
 * overall. Scoping it to the order would count a dollar already spent on
 * another order's invoice as still available here.
 */
const PLAN_SQL = `
  WITH applied_per_payment AS (
    SELECT payment_id, SUM(amount_applied) AS cents
    FROM payment_application
    WHERE deleted_at IS NULL AND voided_at IS NULL
    GROUP BY payment_id
  ), applied AS (
    SELECT pa.order_id,
           SUM(pa.amount_applied) / 100.0 AS usd,
           SUM(CASE WHEN cp.type = 'credit_memo' OR cp.method = 'credit_memo'
                    THEN pa.amount_applied ELSE 0 END) / 100.0 AS credit_usd
    FROM payment_application pa
    JOIN customer_payment cp ON cp.id = pa.payment_id
    WHERE pa.deleted_at IS NULL AND pa.voided_at IS NULL AND pa.order_id IS NOT NULL
    GROUP BY pa.order_id
  ), unapplied AS (
    SELECT cp.locked_order_id AS order_id,
           SUM(GREATEST(0, cp.amount - COALESCE(ap.cents, 0))) / 100.0 AS usd
    FROM customer_payment cp
    LEFT JOIN applied_per_payment ap ON ap.payment_id = cp.id
    WHERE cp.deleted_at IS NULL
      AND cp.locked_order_id IS NOT NULL
      AND cp.status NOT IN ('voided', 'refunded')
    GROUP BY cp.locked_order_id
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
      o.id,
      o.display_id,
      COALESCE(NULLIF(o.metadata->>'referential_deposit', '')::numeric, 0) AS expected,
      COALESCE(a.usd, 0) AS applied,
      COALESCE(u.usd, 0) AS unapplied,
      COALESCE(a.usd, 0) + COALESCE(u.usd, 0) AS raw_target,
      COALESCE(a.credit_usd, 0) AS applied_credit,
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
    LEFT JOIN applied   a ON a.order_id = o.id
    LEFT JOIN unapplied u ON u.order_id = o.id
    LEFT JOIN native    n ON n.order_id = o.id
    WHERE o.deleted_at IS NULL
      AND o.is_draft_order = false
      AND o.status <> 'canceled'
  ), clamped AS (
    -- The field never exceeds the order total. Fail-open when the total is
    -- unreadable: clamping to a total you could not read turns a real deposit
    -- into $0.
    SELECT b.*,
           CASE WHEN b.order_total > 0 THEN LEAST(b.raw_target, b.order_total)
                ELSE b.raw_target END AS target
    FROM base b
  )
  SELECT
    id,
    display_id,
    round(expected, 2)::text        AS expected,
    round(applied, 2)::text         AS applied,
    round(unapplied, 2)::text       AS unapplied,
    round(raw_target, 2)::text      AS raw_target,
    round(target, 2)::text          AS target,
    round(applied_credit, 2)::text  AS applied_credit,
    round(native_captured, 2)::text AS native_captured,
    round(order_total, 2)::text     AS order_total
  FROM clamped
  WHERE abs(expected - target) > $1
  ORDER BY display_id
`;

/** Reads only. Never writes. The same plan the apply consumes. */
async function buildPlan(client: PoolClient): Promise<Plan> {
  const { rows } = await client.query(PLAN_SQL, [TOLERANCE]);

  const writes: PlanRow[] = rows.map((r) => ({
    id: String(r.id),
    displayId: Number(r.display_id),
    expected: Number(r.expected),
    applied: Number(r.applied),
    unapplied: Number(r.unapplied),
    rawTarget: Number(r.raw_target),
    target: Number(r.target),
    appliedCredit: Number(r.applied_credit),
    nativeCaptured: Number(r.native_captured),
    orderTotal: Number(r.order_total),
  }));

  return { writes };
}

function printReport(plan: Plan): void {
  console.log(
    `\n  order  |  field says |    applied  |  unapplied  |     TARGET  |      total  |      delta`
  );
  console.log(
    `  -------+-------------+-------------+-------------+-------------+-------------+------------`
  );
  for (const r of plan.writes) {
    const delta = round2(r.target - r.expected);
    const clamped = r.rawTarget > r.target + TOLERANCE;
    console.log(
      `  #${String(r.displayId).padEnd(5)} | ${money(r.expected).padStart(11)} | ${money(r.applied).padStart(11)} | ` +
        `${money(r.unapplied).padStart(11)} | ${money(r.target).padStart(11)} | ${money(r.orderTotal).padStart(11)} | ` +
        `${(delta >= 0 ? "+" : "") + delta.toFixed(2)}` +
        (clamped ? `   CLAMPED from ${money(r.rawTarget)}` : "")
    );
  }

  const up = plan.writes.filter((r) => r.target > r.expected);
  const down = plan.writes.filter((r) => r.target < r.expected);
  const netDelta = plan.writes.reduce((s, r) => s + (r.target - r.expected), 0);
  const withUnapplied = plan.writes.filter((r) => r.unapplied > TOLERANCE);

  console.log(`\n  ${plan.writes.length} order(s) to restate`);
  console.log(`    raised : ${up.length}  (${money(up.reduce((s, r) => s + (r.target - r.expected), 0))})`);
  console.log(`    lowered: ${down.length}  (${money(down.reduce((s, r) => s + (r.target - r.expected), 0))})`);
  console.log(`    net    : ${money(netDelta)}`);
  console.log(
    `    of which carry an UNAPPLIED deposit: ${withUnapplied.length}` +
      (withUnapplied.length > 0
        ? `  (${withUnapplied.map((r) => `#${r.displayId} ${money(r.unapplied)}`).join(", ")})`
        : "")
  );

  // Independent corroboration. Medusa's payment collections and the finance
  // ledger never talk to each other, so agreement is real evidence — but only
  // once stated correctly. Medusa captures cash, never credit-memo
  // redemptions, so the invariant is `applied - credits + unapplied ==
  // captured`. Comparing raw totals flags every credit-settled order as a
  // disagreement and buries the signal in noise.
  const uncorroborated = plan.writes.filter(
    (r) =>
      Math.abs(r.applied - r.appliedCredit + r.unapplied - r.nativeCaptured) >
      TOLERANCE
  );
  console.log(
    `\n  corroborated (applied - credits + unapplied == Medusa captured): ` +
      `${plan.writes.length - uncorroborated.length}/${plan.writes.length}`
  );
  for (const r of uncorroborated) {
    console.log(
      `      #${r.displayId}: ${money(r.applied)} - ${money(r.appliedCredit)} + ${money(r.unapplied)}` +
        ` = ${money(r.applied - r.appliedCredit + r.unapplied)}, Medusa captured ${money(r.nativeCaptured)}`
    );
  }

  // Clamping bounds the damage but does not explain it. Money applied beyond
  // the order total is either a duplicated application or a real overpayment,
  // and both want a human — so name them here instead of letting a clean table
  // imply the clamp resolved anything.
  const clamped = plan.writes.filter((r) => r.rawTarget > r.target + TOLERANCE);
  if (clamped.length > 0) {
    console.log(
      `\n  ${clamped.length} order(s) CLAMPED — money on the order exceeds the order total.`
    );
    console.log(
      `  The field is written at the total; the excess stays unlinked and can be`
    );
    console.log(`  applied elsewhere. Worth a human look:`);
    for (const r of clamped) {
      console.log(
        `      #${r.displayId}: ${money(r.rawTarget)} on a ${money(r.orderTotal)} order` +
          `  → writing ${money(r.target)} (excess ${money(r.rawTarget - r.target)})`
      );
    }
  }
  console.log();
}

/**
 * One transaction, batched, compare-and-swap. The audit key is written in the
 * same statement as the visible value, and `previous` is captured once — a
 * later run moves `target`, never the original the field was reported with.
 */
async function applyPlan(client: PoolClient, plan: Plan): Promise<number> {
  const appliedAt = new Date().toISOString();
  let total = 0;

  await client.query("BEGIN");
  try {
    for (let i = 0; i < plan.writes.length; i += CHUNK_SIZE) {
      const chunk = plan.writes.slice(i, i + CHUNK_SIZE);
      const { rowCount } = await client.query(
        `
        UPDATE "order" o
        SET metadata = jsonb_set(
              jsonb_set(
                COALESCE(o.metadata, '{}'::jsonb),
                '{referential_deposit}',
                to_jsonb(u.target)
              ),
              '{referential_deposit_restatement}',
              COALESCE(o.metadata->'referential_deposit_restatement', '{}'::jsonb)
                || jsonb_build_object(
                     'plan',        $4::text,
                     'applied_at',  $5::text,
                     'source',      'live applications + unapplied remainder of payments locked to the order',
                     'target',      u.target,
                     'previous',    COALESCE(
                                      o.metadata->'referential_deposit_restatement'->'previous',
                                      to_jsonb(u.expected)
                                    )
                   )
            ),
            updated_at = now()
        FROM UNNEST($1::text[], $2::numeric[], $3::numeric[]) AS u(id, expected, target)
        WHERE o.id = u.id
          AND round(COALESCE(NULLIF(o.metadata->>'referential_deposit', '')::numeric, 0), 2)
              IS NOT DISTINCT FROM round(u.expected, 2)
        `,
        [
          chunk.map((r) => r.id),
          chunk.map((r) => r.expected),
          chunk.map((r) => r.target),
          PLAN_ID,
          appliedAt,
        ]
      );

      if (rowCount !== chunk.length) {
        throw new Error(
          `CAS mismatch: expected to update ${chunk.length} row(s), updated ${rowCount}. ` +
            `A row moved underneath this run — aborting the whole transaction.`
        );
      }
      total += rowCount ?? 0;
    }

    await client.query("COMMIT");
    return total;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  const apply = process.env.APPLY === "true";
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log(`\n[${PLAN_ID}] mode: ${apply ? "APPLY" : "DRY-RUN"}`);

    const plan = await buildPlan(client);
    printReport(plan);

    if (plan.writes.length === 0) {
      console.log("Nothing to restate — the field already agrees with the money.\n");
      return;
    }

    if (!apply) {
      console.log("DRY-RUN — nothing written. Re-run with APPLY=true.\n");
      return;
    }

    const updated = await applyPlan(client, plan);
    console.log(`Restated ${updated} order(s) in one transaction.\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
