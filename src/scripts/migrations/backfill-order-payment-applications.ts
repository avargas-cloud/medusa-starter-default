/**
 * backfill-order-payment-applications.ts
 *
 * Historical CustomerPayments created via "Receive Deposit" on /orders/[id]
 * stamped only metadata.order_id and locked_order_id on the payment — they
 * never created a formal PaymentApplication row. They show up as "Related
 * Credit" in the legacy UI but don't appear as Linked in the new payments
 * refactor.
 *
 * This script finds every payment that:
 *   • Has a non-voided/non-deleted state
 *   • Points at a Medusa order (via locked_order_id OR metadata.order_id)
 *   • Has remaining un-applied balance (amount > Σ active applications)
 *   • Has NO PaymentApplication for that order_id yet
 * …and inserts a PaymentApplication with invoice_id=NULL so the link becomes
 * first-class. Idempotent — re-runnable safely.
 *
 * Usage:
 *   yarn ts-node-script src/scripts/migrations/backfill-order-payment-applications.ts            # dry-run, prints what WOULD be inserted
 *   yarn ts-node-script src/scripts/migrations/backfill-order-payment-applications.ts --apply   # actually insert rows
 *
 * Sandbox-first: refuse to --apply against a DB whose connection string
 * matches the production Railway host unless --i-know-this-is-prod is set.
 */
import { Client } from "pg";
import { ulid } from "ulid";

interface Candidate {
  payment_id: string;
  customer_id: string;
  amount_cents: number;
  active_applied_cents: number;
  available_cents: number;
  order_id: string;
  order_outstanding_cents: number;
  proposed_apply_cents: number;
  received_at: string;
  source_field: "locked_order_id" | "metadata.order_id";
}

function pickArgs(): { apply: boolean; allowProd: boolean } {
  return {
    apply: process.argv.includes("--apply"),
    allowProd: process.argv.includes("--i-know-this-is-prod"),
  };
}

async function findCandidates(client: Client): Promise<Candidate[]> {
  const { rows } = await client.query<Candidate & { _summary_total: string | null }>(
    `
    WITH eligible AS (
      SELECT
        cp.id AS payment_id,
        cp.customer_id,
        cp.amount::bigint AS amount_cents,
        cp.received_at,
        COALESCE(cp.locked_order_id, cp.metadata->>'order_id') AS order_id,
        CASE WHEN cp.locked_order_id IS NOT NULL THEN 'locked_order_id'
             ELSE 'metadata.order_id'
        END::text AS source_field
      FROM customer_payment cp
      WHERE cp.deleted_at IS NULL
        AND cp.type = 'payment'
        AND cp.status NOT IN ('voided', 'refunded')
        AND COALESCE(cp.method, '') <> 'credit_memo'
        AND (cp.locked_order_id IS NOT NULL OR cp.metadata->>'order_id' IS NOT NULL)
    ),
    -- Active applications already on the payment (to ANY invoice/order)
    payment_apps AS (
      SELECT
        pa.payment_id,
        COALESCE(SUM(pa.amount_applied), 0)::bigint AS active_applied_cents
      FROM payment_application pa
      WHERE pa.voided_at IS NULL AND pa.deleted_at IS NULL
      GROUP BY pa.payment_id
    ),
    -- Already-linked? If pa exists for (payment_id, order_id) non-voided, skip.
    already_linked AS (
      SELECT DISTINCT pa.payment_id, pa.order_id
      FROM payment_application pa
      WHERE pa.voided_at IS NULL AND pa.deleted_at IS NULL
    ),
    -- Order totals + outstanding
    order_totals AS (
      SELECT
        o.id AS order_id,
        COALESCE(
          ROUND(((os.totals->>'original_order_total')::numeric) * 100)::bigint,
          (SELECT SUM(ROUND(oli.unit_price * oi.quantity * 100))::bigint
           FROM order_item oi
           JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
           WHERE oi.order_id = o.id),
          0
        ) AS total_cents,
        COALESCE(
          (SELECT SUM(pa.amount_applied)::bigint
           FROM payment_application pa
           WHERE pa.order_id = o.id AND pa.voided_at IS NULL AND pa.deleted_at IS NULL),
          0
        ) AS applied_cents
      FROM "order" o
      LEFT JOIN LATERAL (
        SELECT totals FROM order_summary
        WHERE order_id = o.id AND deleted_at IS NULL
        ORDER BY version DESC LIMIT 1
      ) os ON TRUE
      WHERE o.deleted_at IS NULL
        AND o.status::text NOT IN ('draft','canceled','cancelled','archived')
    )
    SELECT
      e.payment_id,
      e.customer_id,
      e.amount_cents,
      COALESCE(pa.active_applied_cents, 0) AS active_applied_cents,
      (e.amount_cents - COALESCE(pa.active_applied_cents, 0))::bigint AS available_cents,
      e.order_id,
      GREATEST(ot.total_cents - ot.applied_cents, 0)::bigint AS order_outstanding_cents,
      LEAST(
        e.amount_cents - COALESCE(pa.active_applied_cents, 0),
        GREATEST(ot.total_cents - ot.applied_cents, 0)
      )::bigint AS proposed_apply_cents,
      e.received_at::text AS received_at,
      e.source_field,
      ot.total_cents::text AS _summary_total
    FROM eligible e
    LEFT JOIN payment_apps pa ON pa.payment_id = e.payment_id
    JOIN order_totals ot ON ot.order_id = e.order_id
    WHERE NOT EXISTS (
      SELECT 1 FROM already_linked al
      WHERE al.payment_id = e.payment_id AND al.order_id = e.order_id
    )
    ORDER BY e.received_at DESC
    `
  );

  return rows
    .map((r) => ({
      payment_id: r.payment_id,
      customer_id: r.customer_id,
      amount_cents: Number(r.amount_cents),
      active_applied_cents: Number(r.active_applied_cents),
      available_cents: Number(r.available_cents),
      order_id: r.order_id,
      order_outstanding_cents: Number(r.order_outstanding_cents),
      proposed_apply_cents: Number(r.proposed_apply_cents),
      received_at: r.received_at,
      source_field: r.source_field,
    }))
    .filter((c) => c.proposed_apply_cents > 0);
}

async function insertApplications(
  client: Client,
  candidates: Candidate[]
): Promise<{ inserted: number; errors: number }> {
  let inserted = 0;
  let errors = 0;
  for (const c of candidates) {
    try {
      const id = `papp_${ulid()}`;
      await client.query(
        `INSERT INTO payment_application (
           id, payment_id, invoice_id, invoice_number, order_id,
           amount_applied, raw_amount_applied,
           applied_at, applied_by, metadata, created_at, updated_at
         ) VALUES (
           $1::text, $2::text, NULL, NULL, $3::text,
           $4::bigint,
           jsonb_build_object('value', ($4::bigint)::text, 'precision', 20),
           $5::timestamptz, 'system:backfill-order-payment-applications',
           jsonb_build_object('source', 'backfill', 'source_field', $6::text,
                              'available_at_backfill', $7::bigint,
                              'order_outstanding_at_backfill', $8::bigint),
           NOW(), NOW()
         )`,
        [
          id,
          c.payment_id,
          c.order_id,
          c.proposed_apply_cents,
          c.received_at,
          c.source_field,
          c.available_cents,
          c.order_outstanding_cents,
        ]
      );
      inserted++;
    } catch (err) {
      errors++;
      console.error(
        `[backfill] FAILED payment=${c.payment_id} order=${c.order_id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return { inserted, errors };
}

async function main(): Promise<void> {
  const { apply, allowProd } = pickArgs();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set");
    process.exit(2);
  }

  const looksLikeProd =
    /railway|rlwy\.net|production/i.test(url) && !/sandbox|preview/i.test(url);
  if (apply && looksLikeProd && !allowProd) {
    console.error(
      "Refusing --apply against what looks like a prod DB. Pass --i-know-this-is-prod to override."
    );
    process.exit(3);
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  console.log(`[backfill] connected (apply=${apply})`);

  try {
    const candidates = await findCandidates(client);
    console.log(`[backfill] candidates=${candidates.length}`);

    if (candidates.length === 0) {
      console.log("[backfill] nothing to do — exiting");
      return;
    }

    const sample = candidates.slice(0, 10);
    console.log("[backfill] first 10 proposed inserts:");
    for (const c of sample) {
      console.log(
        `  payment=${c.payment_id} order=${c.order_id} amount=${c.proposed_apply_cents}¢  ` +
          `(avail ${c.available_cents}¢, order_outstanding ${c.order_outstanding_cents}¢, ` +
          `source ${c.source_field})`
      );
    }

    if (!apply) {
      const totalCents = candidates.reduce(
        (s, c) => s + c.proposed_apply_cents,
        0
      );
      console.log(
        `[backfill] DRY-RUN — would insert ${candidates.length} applications, total $${(totalCents / 100).toFixed(2)}`
      );
      console.log("[backfill] re-run with --apply to commit.");
      return;
    }

    const { inserted, errors } = await insertApplications(client, candidates);
    console.log(`[backfill] inserted=${inserted}  errors=${errors}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
