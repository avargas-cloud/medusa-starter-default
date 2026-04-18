/**
 * split-payment-method-and-card-brand.ts
 *
 * Backfills historical customer_payment + pos_invoice rows into the new
 * {payment_method, card_brand} canonical split.
 *
 * Mapping rules (applied in order):
 *   pos_invoice.payment_method:
 *     'visa' | 'mastercard' | 'amex' | 'discover' | 'capital_one'
 *        → method='credit_card', card_brand=<brand>
 *     'debit_card'
 *        → method='debit_card',  card_brand=null
 *     everything else (cash/check/zelle/ach/credit/mixed/credit_memo/card/...)
 *        → unchanged
 *
 *   customer_payment.method:
 *     Same mapping; plus 'card' (generic) tries to read the brand from
 *     metadata.dejavoo_card_brand or metadata.pos_payment_method to split:
 *       'card' + metadata.inferred_debit_from_zero_surcharge=true
 *          → method='debit_card', card_brand=null
 *       'card' + metadata.card_brand=<brand>
 *          → method='credit_card', card_brand=<brand>
 *       'card' + metadata.pos_payment_method='debit_card'
 *          → method='debit_card', card_brand=null
 *       'card' + metadata.pos_payment_method=<brand>
 *          → method='credit_card', card_brand=<brand>
 *       'card' + no usable metadata
 *          → skip (needs manual review — 'card' stays as legacy value)
 *
 * Safety:
 *   Idempotent: skips rows where metadata.payment_method_split_corrected_at is
 *   already set. Dry-run by default; APPLY=1 to execute.
 *
 * Usage:
 *   DRY RUN:  yarn medusa exec ./src/scripts/fix/split-payment-method-and-card-brand.ts
 *   APPLY:    APPLY=1 yarn medusa exec ./src/scripts/fix/split-payment-method-and-card-brand.ts
 */

import { MedusaContainer } from "@medusajs/framework/types";

const CARD_BRANDS = new Set(["visa", "mastercard", "amex", "discover", "capital_one"]);

type InvoiceRow = {
  id: string;
  invoice_number: string;
  payment_method: string;
  card_brand: string | null;
  action: "CORRECT" | "SKIP_ALREADY_CANONICAL" | "SKIP_UNKNOWN";
  new_payment_method: string;
  new_card_brand: string | null;
};

type PaymentRow = {
  id: string;
  display_id: number | null;
  method: string;
  card_brand: string | null;
  metadata: any;
  reference: string | null;
  amount: number;
  applied_sum: number;
  action: "CORRECT" | "SKIP_ALREADY_CANONICAL" | "SKIP_NEEDS_REVIEW";
  new_method: string;
  new_card_brand: string | null;
  reason?: string;
};

/** Extract canonical brand from a reference string like "MASTERCARD ···· 4682 | Auth: ...". */
function parseBrandFromReference(reference: string | null): string | null {
  if (!reference) return null;
  const s = reference.toUpperCase();
  if (/\bMASTERCARD|MASTER\s*CARD\b/.test(s)) return "mastercard";
  if (/\bAMEX|AMERICAN\s*EXPRESS\b/.test(s)) return "amex";
  if (/\bDISCOVER\b/.test(s)) return "discover";
  if (/\bCAPITAL\s*ONE\b/.test(s)) return "capital_one";
  if (/\bVISA\b/.test(s)) return "visa";
  return null;
}

/**
 * Derive the canonical {method, brand} for a pos_invoice row.
 * Inputs include signals from the linked customer_payment so we can distinguish
 * credit cards (had surcharge) from debit cards (no surcharge) — many historical
 * invoices were stored as 'visa'/'mastercard'/etc. even though Dejavoo actually
 * processed them as debit (the auto-detect debit fix wasn't in place yet).
 */
function deriveInvoice(args: {
  pm: string;
  existing_brand: string | null;
  cp_amount: number | null;
  applied_sum: number | null;
  was_corrected: boolean;
  tx_type: string | null;
}): { new_pm: string; new_brand: string | null; action: InvoiceRow["action"] } {
  const { pm, existing_brand, cp_amount, applied_sum, was_corrected, tx_type } = args;

  if (pm === "credit_card" || pm === "debit_card") {
    return { new_pm: pm, new_brand: existing_brand, action: "SKIP_ALREADY_CANONICAL" };
  }

  if (CARD_BRANDS.has(pm)) {
    // Decide credit vs debit based on the linked payment:
    //   - If the earlier surcharge fix already ran on this payment, it WAS credit.
    //   - Else if amount > applied → had surcharge → credit.
    //   - Else if amount == applied AND terminal_payment → zero surcharge = debit.
    //   - Else (manual without signal) → default to credit (can't tell without asking).
    if (was_corrected) {
      return { new_pm: "credit_card", new_brand: pm, action: "CORRECT" };
    }
    if (cp_amount !== null && applied_sum !== null) {
      const delta = cp_amount - applied_sum;
      if (delta > 0) {
        return { new_pm: "credit_card", new_brand: pm, action: "CORRECT" };
      }
      if (delta === 0 && tx_type === "terminal_payment") {
        return { new_pm: "debit_card", new_brand: pm, action: "CORRECT" };
      }
    }
    // Default: treat as credit since we can't prove debit.
    return { new_pm: "credit_card", new_brand: pm, action: "CORRECT" };
  }

  // 'cash', 'check', 'zelle', 'ach', 'credit' (store credit), 'mixed', 'credit_memo',
  // 'card' (generic), etc. — nothing to split.
  return { new_pm: pm, new_brand: existing_brand, action: "SKIP_UNKNOWN" };
}

function derivePayment(args: {
  method: string;
  existing_brand: string | null;
  metadata: any;
  reference: string | null;
  amount: number;
  applied_sum: number;
}): { new_method: string; new_brand: string | null; action: PaymentRow["action"]; reason?: string } {
  const { method, existing_brand, metadata, reference, amount, applied_sum } = args;
  const meta = metadata || {};
  const was_corrected = Boolean(meta.surcharge_correction_applied_at);
  const delta = amount - applied_sum;
  const isTerminal = meta.transaction_type === "terminal_payment";
  const txIsBams = meta.transaction_type === "bams_online_payment";

  if (method === "credit_card" || method === "debit_card") {
    return { new_method: method, new_brand: existing_brand, action: "SKIP_ALREADY_CANONICAL" };
  }

  // Known brand as method → decide credit vs debit using the delta signal.
  if (CARD_BRANDS.has(method)) {
    if (was_corrected || delta > 0) {
      return { new_method: "credit_card", new_brand: method, action: "CORRECT" };
    }
    if (delta === 0 && (isTerminal || txIsBams)) {
      return { new_method: "debit_card", new_brand: method, action: "CORRECT" };
    }
    // Default credit (manual-entered brand — cashier meant credit).
    return { new_method: "credit_card", new_brand: method, action: "CORRECT" };
  }

  // Generic 'card' — terminal-flow before the auto-detect fix. Use the same
  // delta signal plus metadata hints, then parse the brand from reference as
  // a last resort (old terminal route stored "MASTERCARD ···· 4682 | Auth: ...").
  if (method === "card") {
    if (meta.inferred_debit_from_zero_surcharge === true) {
      return { new_method: "debit_card", new_brand: null, action: "CORRECT" };
    }

    let brand: string | null = null;
    if (typeof meta.card_brand === "string" && CARD_BRANDS.has(meta.card_brand.toLowerCase())) {
      brand = meta.card_brand.toLowerCase();
    } else if (typeof meta.pos_payment_method === "string" && CARD_BRANDS.has(meta.pos_payment_method.toLowerCase())) {
      brand = meta.pos_payment_method.toLowerCase();
    } else if (typeof meta.dejavoo_card_brand === "string" && CARD_BRANDS.has(meta.dejavoo_card_brand.toLowerCase())) {
      brand = meta.dejavoo_card_brand.toLowerCase();
    } else {
      brand = parseBrandFromReference(reference);
    }

    // Special: pos_payment_method='debit_card' → override regardless of brand hints.
    if (typeof meta.pos_payment_method === "string" && meta.pos_payment_method.toLowerCase() === "debit_card") {
      return { new_method: "debit_card", new_brand: null, action: "CORRECT" };
    }

    if (brand) {
      if (was_corrected || delta > 0) {
        return { new_method: "credit_card", new_brand: brand, action: "CORRECT" };
      }
      if (delta === 0 && (isTerminal || txIsBams)) {
        return { new_method: "debit_card", new_brand: brand, action: "CORRECT" };
      }
      return { new_method: "credit_card", new_brand: brand, action: "CORRECT" };
    }

    return {
      new_method: method,
      new_brand: existing_brand,
      action: "SKIP_NEEDS_REVIEW",
      reason: "method='card' with no brand signal (metadata/reference)",
    };
  }

  // Everything else (cash/check/ach/zelle/credit_memo/stripe/authorize_net/other)
  // has no card_brand concept.
  return { new_method: method, new_brand: existing_brand, action: "SKIP_ALREADY_CANONICAL" };
}

export default async function splitPaymentMethodAndCardBrand({
  container,
}: {
  container: MedusaContainer;
}) {
  const apply = process.env.APPLY === "1";
  const pg = container.resolve("__pg_connection__") as any;

  console.log(`\n[split-payment] Mode: ${apply ? "APPLY" : "DRY-RUN"}\n`);

  // ── 1. pos_invoice ─────────────────────────────────────────────────────
  // Join against the linked customer_payment (via payment_application) so we can
  // distinguish historical credit vs debit cards by the surcharge delta. For
  // invoices with >1 application (split payments) we aggregate — the test is
  // "did the invoice's total payment exceed the applications sum?".
  const invoiceRes = await pg.raw(
    `
    SELECT
      i.id,
      i.invoice_number,
      i.payment_method,
      i.card_brand,
      (
        SELECT cp.amount
        FROM payment_application pa
        JOIN customer_payment cp ON cp.id = pa.payment_id
        WHERE pa.invoice_id = i.id AND pa.voided_at IS NULL AND pa.deleted_at IS NULL
        ORDER BY pa.applied_at ASC LIMIT 1
      ) AS cp_amount,
      (
        SELECT COALESCE(SUM(pa2.amount_applied), 0)
        FROM payment_application pa2
        WHERE pa2.payment_id = (
          SELECT pa.payment_id
          FROM payment_application pa
          WHERE pa.invoice_id = i.id AND pa.voided_at IS NULL AND pa.deleted_at IS NULL
          ORDER BY pa.applied_at ASC LIMIT 1
        )
          AND pa2.voided_at IS NULL
      ) AS applied_sum,
      (
        SELECT (cp.metadata->>'surcharge_correction_applied_at') IS NOT NULL
        FROM payment_application pa
        JOIN customer_payment cp ON cp.id = pa.payment_id
        WHERE pa.invoice_id = i.id AND pa.voided_at IS NULL AND pa.deleted_at IS NULL
        ORDER BY pa.applied_at ASC LIMIT 1
      ) AS was_corrected,
      (
        SELECT cp.metadata->>'transaction_type'
        FROM payment_application pa
        JOIN customer_payment cp ON cp.id = pa.payment_id
        WHERE pa.invoice_id = i.id AND pa.voided_at IS NULL AND pa.deleted_at IS NULL
        ORDER BY pa.applied_at ASC LIMIT 1
      ) AS tx_type
    FROM pos_invoice i
    WHERE i.deleted_at IS NULL
      AND (i.metadata->>'payment_method_split_corrected_at') IS NULL
    ORDER BY i.created_at ASC
    `
  );

  const invoiceRows: InvoiceRow[] = invoiceRes.rows.map((r: any) => {
    const d = deriveInvoice({
      pm: r.payment_method,
      existing_brand: r.card_brand,
      cp_amount: r.cp_amount !== null ? Number(r.cp_amount) : null,
      applied_sum: r.applied_sum !== null ? Number(r.applied_sum) : null,
      was_corrected: r.was_corrected === true,
      tx_type: r.tx_type,
    });
    return {
      id: r.id,
      invoice_number: r.invoice_number,
      payment_method: r.payment_method,
      card_brand: r.card_brand,
      action: d.action,
      new_payment_method: d.new_pm,
      new_card_brand: d.new_brand,
    };
  });

  const invToCorrect = invoiceRows.filter((r) => r.action === "CORRECT");
  console.log(`pos_invoice: ${invoiceRes.rows.length} scanned — CORRECT=${invToCorrect.length}`);
  if (invToCorrect.length > 0) {
    console.log(`\n  invoice_number | old_method   → new_method  (brand)`);
    console.log(`  ---------------+-------------------------------------`);
    for (const r of invToCorrect.slice(0, 20)) {
      console.log(
        `  ${String(r.invoice_number).padEnd(14)} | ${r.payment_method.padEnd(12)} → ${r.new_payment_method.padEnd(12)} (${r.new_card_brand ?? "—"})`
      );
    }
    if (invToCorrect.length > 20) {
      console.log(`  ... + ${invToCorrect.length - 20} more`);
    }
  }
  console.log();

  // ── 2. customer_payment ────────────────────────────────────────────────
  // Join applications to compute amount-vs-applied delta. delta=0 on a terminal
  // payment → no surcharge → was debit. delta>0 → had surcharge → was credit.
  const paymentRes = await pg.raw(
    `
    SELECT
      cp.id,
      cp.display_id,
      cp.method,
      cp.card_brand,
      cp.metadata,
      cp.reference,
      cp.amount,
      COALESCE((
        SELECT SUM(pa.amount_applied)
        FROM payment_application pa
        WHERE pa.payment_id = cp.id AND pa.voided_at IS NULL AND pa.deleted_at IS NULL
      ), 0) AS applied_sum
    FROM customer_payment cp
    WHERE cp.deleted_at IS NULL
      AND (cp.metadata->>'payment_method_split_corrected_at') IS NULL
    ORDER BY cp.created_at ASC
    `
  );

  const paymentRows: PaymentRow[] = paymentRes.rows.map((r: any) => {
    const d = derivePayment({
      method: r.method,
      existing_brand: r.card_brand,
      metadata: r.metadata,
      reference: r.reference,
      amount: Number(r.amount),
      applied_sum: Number(r.applied_sum),
    });
    return {
      id: r.id,
      display_id: r.display_id,
      method: r.method,
      card_brand: r.card_brand,
      metadata: r.metadata,
      reference: r.reference,
      amount: Number(r.amount),
      applied_sum: Number(r.applied_sum),
      action: d.action,
      new_method: d.new_method,
      new_card_brand: d.new_brand,
      reason: d.reason,
    };
  });

  const payToCorrect = paymentRows.filter((r) => r.action === "CORRECT");
  const payNeedsReview = paymentRows.filter((r) => r.action === "SKIP_NEEDS_REVIEW");
  console.log(
    `customer_payment: ${paymentRes.rows.length} scanned — CORRECT=${payToCorrect.length}, NEEDS_REVIEW=${payNeedsReview.length}`
  );
  if (payToCorrect.length > 0) {
    console.log(`\n  display_id | old_method   → new_method  (brand)`);
    console.log(`  -----------+-------------------------------------`);
    for (const r of payToCorrect.slice(0, 20)) {
      console.log(
        `  ${String(r.display_id ?? "-").padStart(10)} | ${r.method.padEnd(12)} → ${r.new_method.padEnd(12)} (${r.new_card_brand ?? "—"})`
      );
    }
    if (payToCorrect.length > 20) {
      console.log(`  ... + ${payToCorrect.length - 20} more`);
    }
  }
  if (payNeedsReview.length > 0) {
    console.log(`\n  NEEDS MANUAL REVIEW (${payNeedsReview.length}):`);
    for (const r of payNeedsReview.slice(0, 10)) {
      console.log(`  ${r.id} (#${r.display_id}): ${r.reason}`);
    }
  }
  console.log();

  if (!apply) {
    console.log(`[split-payment] DRY-RUN — no changes made. Re-run with APPLY=1 to apply.\n`);
    return;
  }

  // ── 3. Apply ───────────────────────────────────────────────────────────
  const nowIso = new Date().toISOString();
  let invApplied = 0;
  let invFailed = 0;
  for (const r of invToCorrect) {
    try {
      await pg.raw(
        `
        UPDATE pos_invoice
        SET
          payment_method = ?::text,
          card_brand     = ?::text,
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'payment_method_split_corrected_at', ?::text,
            'payment_method_original',           ?::text,
            'card_brand_original',               COALESCE(card_brand, '')
          ),
          updated_at = now()
        WHERE id = ?
          AND (metadata->>'payment_method_split_corrected_at') IS NULL
        `,
        [r.new_payment_method, r.new_card_brand, nowIso, r.payment_method, r.id]
      );
      invApplied++;
    } catch (err: any) {
      invFailed++;
      console.error(`  ❌ invoice ${r.invoice_number} FAILED: ${err.message}`);
    }
  }

  let payApplied = 0;
  let payFailed = 0;
  for (const r of payToCorrect) {
    try {
      await pg.raw(
        `
        UPDATE customer_payment
        SET
          method     = ?::text,
          card_brand = ?::text,
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'payment_method_split_corrected_at', ?::text,
            'method_original',                   ?::text,
            'card_brand_original',               COALESCE(card_brand, '')
          ),
          updated_at = now()
        WHERE id = ?
          AND (metadata->>'payment_method_split_corrected_at') IS NULL
        `,
        [r.new_method, r.new_card_brand, nowIso, r.method, r.id]
      );
      payApplied++;
    } catch (err: any) {
      payFailed++;
      console.error(`  ❌ payment ${r.id} (#${r.display_id}) FAILED: ${err.message}`);
    }
  }

  console.log(
    `\n[split-payment] Done.  pos_invoice: applied=${invApplied} failed=${invFailed}  |  ` +
    `customer_payment: applied=${payApplied} failed=${payFailed}\n`
  );
}
