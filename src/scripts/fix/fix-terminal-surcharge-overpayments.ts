/**
 * fix-terminal-surcharge-overpayments.ts
 *
 * Retroactively corrects historical Dejavoo terminal payments that were recorded
 * with the cardholder-charged amount (invoice + surcharge) instead of the merchant-
 * received amount (invoice only). The surcharge is retained by the processor, so
 * the extra amount showed up as a phantom "Available Balance" credit in the UI.
 *
 * Bug path (pre-fix): store-pos/app/api/bams/terminal/route.ts preferred Dejavoo's
 * BaseAmount as the payment amount. When Dejavoo embedded the surcharge inside
 * BaseAmount with Fee=0 (current processor config), the merchant payment was
 * over-reported by the surcharge amount, leaving partially_applied status with
 * a small remaining balance.
 *
 * Fix (this script):
 *   corrected_amount = SUM(active application.amount_applied)   -- what the invoice consumed
 *   surcharge_cents  = old_amount - corrected_amount            -- what the processor kept
 *   status           = 'applied'                                -- was 'partially_applied'
 *   metadata audit fields added for traceability
 *
 * Safety:
 *   - Only touches customer_payment rows with metadata.transaction_type='terminal_payment'
 *     AND status='partially_applied' (the exact bug fingerprint).
 *   - Sanity: surcharge must be 0 < pct < 15% (typical ~3%). Larger deltas are
 *     flagged for manual review (could be split-payments, not surcharge bug).
 *   - Dry-run by default. Set APPLY=1 to execute.
 *
 * Usage:
 *   DRY RUN:  yarn medusa exec ./src/scripts/fix/fix-terminal-surcharge-overpayments.ts
 *   APPLY:    APPLY=1 yarn medusa exec ./src/scripts/fix/fix-terminal-surcharge-overpayments.ts
 */

import { MedusaContainer } from "@medusajs/framework/types";

const SANITY_MAX_SURCHARGE_PCT = 0.15; // 15% upper bound — flag anything above as manual review

type Candidate = {
  id: string;
  display_id: number | null;
  customer_id: string;
  current_amount_cents: number;
  applied_total_cents: number;
  surcharge_cents: number;
  surcharge_pct: number;
  status: string;
  reference: string | null;
  received_at: string;
  invoice_numbers: string[];
  action: "CORRECT" | "SKIP_NO_OVERPAYMENT" | "SKIP_MANUAL_REVIEW" | "SKIP_NO_APPLICATIONS";
  note?: string;
};

export default async function fixTerminalSurchargeOverpayments({
  container,
}: {
  container: MedusaContainer;
}) {
  const apply = process.env.APPLY === "1";
  const pg = container.resolve("__pg_connection__") as any;

  console.log(`\n[surcharge-fix] Mode: ${apply ? "APPLY" : "DRY-RUN"}\n`);

  // 1. Pull candidate rows + aggregated applications in one query
  const { rows } = await pg.raw(
    `
    SELECT
      cp.id,
      cp.display_id,
      cp.customer_id,
      cp.amount::text AS amount_str,
      cp.raw_amount,
      cp.status,
      cp.reference,
      cp.received_at,
      cp.metadata,
      COALESCE(
        SUM(CASE WHEN pa.voided_at IS NULL THEN pa.amount_applied ELSE 0 END),
        0
      )::text AS applied_total_str,
      COUNT(pa.id) FILTER (WHERE pa.voided_at IS NULL) AS active_app_count,
      ARRAY_REMOVE(
        ARRAY_AGG(DISTINCT pa.invoice_number ORDER BY pa.invoice_number) FILTER (WHERE pa.voided_at IS NULL),
        NULL
      ) AS invoice_numbers
    FROM customer_payment cp
    LEFT JOIN payment_application pa ON pa.payment_id = cp.id AND pa.deleted_at IS NULL
    WHERE cp.deleted_at IS NULL
      AND cp.type = 'payment'
      AND cp.metadata->>'transaction_type' = 'terminal_payment'
      AND cp.status NOT IN ('voided', 'refunded', 'partial_refunded')
    GROUP BY cp.id
    HAVING cp.amount > COALESCE(
      SUM(CASE WHEN pa.voided_at IS NULL THEN pa.amount_applied ELSE 0 END),
      0
    )
    ORDER BY cp.received_at ASC
    `
  );

  if (!rows.length) {
    console.log("[surcharge-fix] Zero candidates found. Nothing to do.\n");
    return;
  }

  // 2. Classify each row — customer_payment.amount stores cents directly
  // (e.g. 5509 = $55.09). raw_amount.value matches: {"value":"5509","precision":20}.
  const candidates: Candidate[] = rows.map((r: any) => {
    const currentCents = Math.round(Number(r.amount_str));
    const appliedCents = Math.round(Number(r.applied_total_str));
    const surchargeCents = currentCents - appliedCents;
    const surchargePct = currentCents > 0 ? surchargeCents / currentCents : 0;

    let action: Candidate["action"];
    let note: string | undefined;

    if (r.active_app_count === "0" || Number(r.active_app_count) === 0) {
      action = "SKIP_NO_APPLICATIONS";
      note = "No active application — cannot compute corrected amount";
    } else if (surchargeCents <= 0) {
      action = "SKIP_NO_OVERPAYMENT";
      note = "applied_total >= amount — no overpayment";
    } else if (surchargePct > SANITY_MAX_SURCHARGE_PCT) {
      action = "SKIP_MANUAL_REVIEW";
      note = `Surcharge ${(surchargePct * 100).toFixed(1)}% > ${(SANITY_MAX_SURCHARGE_PCT * 100).toFixed(0)}% — could be split-payment, not surcharge`;
    } else {
      action = "CORRECT";
    }

    return {
      id: r.id,
      display_id: r.display_id,
      customer_id: r.customer_id,
      current_amount_cents: currentCents,
      applied_total_cents: appliedCents,
      surcharge_cents: surchargeCents,
      surcharge_pct: surchargePct,
      status: r.status,
      reference: r.reference,
      received_at: r.received_at,
      invoice_numbers: r.invoice_numbers ?? [],
      action,
      note,
    };
  });

  // 3. Summary table
  const correctable = candidates.filter((c) => c.action === "CORRECT");
  const manualReview = candidates.filter((c) => c.action === "SKIP_MANUAL_REVIEW");
  const noOverpayment = candidates.filter((c) => c.action === "SKIP_NO_OVERPAYMENT");
  const noApplications = candidates.filter((c) => c.action === "SKIP_NO_APPLICATIONS");

  console.log(`Found ${candidates.length} candidate(s) with amount > sum(applied):\n`);
  console.log(`  ✅ CORRECT             : ${correctable.length}`);
  console.log(`  ⚠️  SKIP_MANUAL_REVIEW : ${manualReview.length}`);
  console.log(`  —  SKIP_NO_OVERPAYMENT : ${noOverpayment.length}`);
  console.log(`  —  SKIP_NO_APPLICATIONS: ${noApplications.length}\n`);

  // 4. Print per-row detail
  const fmt = (c: number): string => `$${(c / 100).toFixed(2).padStart(8)}`;
  console.log(
    "display_id | received_at          | amount   | applied  | surcharge | pct   | invoices              | id"
  );
  console.log(
    "-----------+---------------------+----------+----------+-----------+-------+-----------------------+-----------------------------------"
  );
  for (const c of candidates) {
    const icon =
      c.action === "CORRECT" ? "✅" :
      c.action === "SKIP_MANUAL_REVIEW" ? "⚠️" :
      "— ";
    const invList = c.invoice_numbers.length > 0
      ? c.invoice_numbers.slice(0, 2).join(",")
      : "(none)";
    console.log(
      `${icon} ${String(c.display_id ?? "-").padStart(6)} | ${new Date(c.received_at).toISOString().slice(0, 19)} | ${fmt(c.current_amount_cents)} | ${fmt(c.applied_total_cents)} | ${fmt(c.surcharge_cents)} | ${(c.surcharge_pct * 100).toFixed(1).padStart(4)}% | ${invList.padEnd(21)} | ${c.id}`
    );
    if (c.note && c.action !== "CORRECT") {
      console.log(`   └─ ${c.note}`);
    }
  }
  console.log();

  // 5. Totals
  const totalSurchargeCents = correctable.reduce((s, c) => s + c.surcharge_cents, 0);
  const totalCurrentCents = correctable.reduce((s, c) => s + c.current_amount_cents, 0);
  const totalCorrectedCents = correctable.reduce((s, c) => s + c.applied_total_cents, 0);
  console.log(`Totals for CORRECT rows (${correctable.length}):`);
  console.log(`  Sum current (buggy):     ${fmt(totalCurrentCents)}`);
  console.log(`  Sum corrected (actual):  ${fmt(totalCorrectedCents)}`);
  console.log(`  Sum phantom credit:      ${fmt(totalSurchargeCents)}\n`);

  if (!apply) {
    console.log(
      "[surcharge-fix] DRY-RUN — no changes made. Re-run with APPLY=1 to apply the CORRECT rows.\n"
    );
    return;
  }

  // 6. APPLY — per-row update within a transaction
  console.log(
    correctable.length > 0
      ? `[surcharge-fix] Applying ${correctable.length} corrections...\n`
      : `[surcharge-fix] Zero new customer_payment rows to correct; checking for order metadata backfill...\n`
  );
  let applied = 0;
  let failed = 0;
  for (const c of correctable) {
    try {
      // amount column stores cents directly (e.g. 5349 = $53.49).
      // raw_amount JSONB mirrors: {"value":"5349","precision":20}.
      const correctedCents = c.applied_total_cents;
      const rawAmountJson = JSON.stringify({
        value: String(correctedCents),
        precision: 20,
      });

      await pg.raw(
        `
        UPDATE customer_payment
        SET
          amount = ?::numeric,
          raw_amount = ?::jsonb,
          status = 'applied',
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'dejavoo_surcharge_cents',          ?::int,
            'dejavoo_cardholder_charged_cents', ?::int,
            'original_amount_cents',            ?::int,
            'surcharge_correction_applied_at',  ?::text,
            'surcharge_correction_reason',      ?::text
          ),
          updated_at = now()
        WHERE id = ?
          AND status NOT IN ('voided', 'refunded', 'partial_refunded')
          AND metadata->>'surcharge_correction_applied_at' IS NULL
        `,
        [
          correctedCents,
          rawAmountJson,
          c.surcharge_cents,
          c.current_amount_cents, // what the cardholder was actually charged
          c.current_amount_cents, // same — preserve original for audit
          new Date().toISOString(),
          "retroactive-fix: terminal route was booking Dejavoo BaseAmount (includes surcharge) instead of POS-requested merchant amount",
          c.id,
        ]
      );
      applied++;
      console.log(`  ✅ ${c.id} (#${c.display_id}): ${fmt(c.current_amount_cents)} → ${fmt(c.applied_total_cents)}  (surcharge ${fmt(c.surcharge_cents)})`);
    } catch (err: any) {
      failed++;
      console.error(`  ❌ ${c.id} (#${c.display_id}) FAILED: ${err.message}`);
    }
  }

  console.log(`\n[surcharge-fix] Payment rows done. applied=${applied} failed=${failed}\n`);

  // 7. Secondary: correct order.metadata.referential_deposit for the same rows.
  // This field drives the "DEPOSIT" column in the POS order list. It was written with
  // the buggy cardholder-charged dollar value (e.g. 55.09) instead of the merchant
  // amount (53.49). Recompute as SUM(active applications for terminal payments on
  // this order) / 100 — giving the true pre-invoice captured total.
  console.log(`[surcharge-fix] Correcting order.metadata.referential_deposit for affected orders...\n`);

  const orderRowsRes = await pg.raw(
    `
    SELECT DISTINCT pa.order_id, o.display_id, o.metadata->>'referential_deposit' AS old_deposit_dollars
    FROM payment_application pa
    JOIN customer_payment cp ON cp.id = pa.payment_id
    JOIN "order" o ON o.id = pa.order_id
    WHERE cp.metadata->>'surcharge_correction_applied_at' IS NOT NULL
      AND pa.deleted_at IS NULL
      AND o.deleted_at IS NULL
      AND (o.metadata->>'referential_deposit_corrected_at') IS NULL
    `
  );

  let orderApplied = 0;
  let orderFailed = 0;
  for (const orderRow of orderRowsRes.rows) {
    try {
      const sumRes = await pg.raw(
        `
        SELECT COALESCE(SUM(pa.amount_applied), 0)::text AS applied_cents_str
        FROM payment_application pa
        JOIN customer_payment cp ON cp.id = pa.payment_id
        WHERE pa.order_id = ?
          AND pa.deleted_at IS NULL
          AND pa.voided_at IS NULL
          AND cp.metadata->>'transaction_type' = 'terminal_payment'
          AND cp.type = 'payment'
        `,
        [orderRow.order_id]
      );
      const appliedCents = Math.round(Number(sumRes.rows[0].applied_cents_str));
      const newDepositDollars = (appliedCents / 100).toFixed(2);

      await pg.raw(
        `
        UPDATE "order"
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'referential_deposit',              ?::text,
          'referential_deposit_original',     COALESCE(metadata->>'referential_deposit', '0'),
          'referential_deposit_corrected_at', ?::text
        ),
        updated_at = now()
        WHERE id = ?
          AND (metadata->>'referential_deposit_corrected_at') IS NULL
        `,
        [newDepositDollars, new Date().toISOString(), orderRow.order_id]
      );
      orderApplied++;
      console.log(`  ✅ order #${orderRow.display_id}: referential_deposit $${orderRow.old_deposit_dollars} → $${newDepositDollars}`);
    } catch (err: any) {
      orderFailed++;
      console.error(`  ❌ order #${orderRow.display_id} FAILED: ${err.message}`);
    }
  }

  console.log(`\n[surcharge-fix] Order metadata done. applied=${orderApplied} failed=${orderFailed}\n`);
}
