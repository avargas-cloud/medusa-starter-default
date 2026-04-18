/**
 * verify-qb-payment-method-resolution.ts
 *
 * Verifies that the Phase-5 QB PaymentMethod resolution produces the correct
 * QB PaymentMethod string for every realistic capture scenario. This simulates
 * the FULL handler logic (including the isDebit branch + sanitizer) with
 * synthetic inputs — NO live QB calls, no DB writes, no bridge traffic.
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/verify/verify-qb-payment-method-resolution.ts
 */

import { MedusaContainer } from "@medusajs/framework/types";
import { sanitizeToQbPaymentMethod } from "../../lib/quickbooks/payment-method-sanitizer";

/** Synthetic payment/invoice row — what the handler reads from the DB. */
interface PaymentSnapshot {
  /** customer_payment.method column — credit_card | debit_card | cash | check | ... */
  method: string;
  /** customer_payment.card_brand column — visa | mastercard | amex | discover | capital_one | null */
  card_brand: string | null;
  /** metadata.card_brand (mirror of column for old rows or extra audit). */
  meta_brand?: string | null;
  /** metadata.pos_payment_method (mirror/legacy). */
  pos_method?: string | null;
  /** metadata.bams_card_label ("VISA", "MASTERCARD", etc.). */
  bams_label?: string | null;
  /** metadata.bams_card_type ("CREDIT" | "DEBIT"). */
  bams_card_type?: string | null;
}

/**
 * Mirror of the production handler in handle-pos-payment-created.ts.
 * Keep this in sync with that file — it's the code under test.
 */
function handlerResolveQbMethod(p: PaymentSnapshot): string | undefined {
  const canonicalBrand = p.card_brand ?? undefined;
  const rawLabel = p.bams_label ?? undefined;
  const metaBrand = p.meta_brand ?? undefined;
  const rawCardType = p.bams_card_type ?? undefined;
  const rawPosMethod = p.pos_method ?? undefined;

  const isDebit =
    p.method === "debit_card" ||
    rawPosMethod === "debit_card" ||
    (rawCardType ?? "").toUpperCase() === "DEBIT";

  return isDebit
    ? sanitizeToQbPaymentMethod("debit_card")
    : sanitizeToQbPaymentMethod(
        canonicalBrand,
        rawLabel,
        metaBrand,
        rawPosMethod,
        rawCardType,
        p.method
      );
}

/**
 * Mirror of the Sales Receipt handler logic (handle-sales-receipt-created.ts).
 * It passes `invoicePaymentMethod==='debit_card' ? 'debit_card' : (card_brand || payment_method)`.
 */
function srResolveQbMethod(invoice: {
  payment_method: string;
  card_brand: string | null;
}): string | undefined {
  const paymentMethod =
    invoice.payment_method === "debit_card"
      ? "debit_card"
      : (invoice.card_brand || invoice.payment_method);
  return sanitizeToQbPaymentMethod(paymentMethod);
}

interface TestCase {
  label: string;
  source: "terminal" | "bams_webhook" | "manual" | "legacy" | "edge";
  /** Handler to test — payment-created (ReceivePayment) or SR. */
  handler: "receive_payment" | "sales_receipt";
  payment?: PaymentSnapshot;
  invoice?: { payment_method: string; card_brand: string | null };
  expected: string | undefined;
  rationale: string;
}

const TESTS: TestCase[] = [
  // ── Dejavoo Terminal (ReceivePayment handler) ─────────────────────────
  {
    label: "Terminal credit Visa (2.9% surcharge applied)",
    source: "terminal",
    handler: "receive_payment",
    payment: { method: "credit_card", card_brand: "visa", meta_brand: "visa", pos_method: "credit_card" },
    expected: "Visa",
    rationale: "Canonical brand on credit resolves to 'Visa'.",
  },
  {
    label: "Terminal credit MasterCard",
    source: "terminal",
    handler: "receive_payment",
    payment: { method: "credit_card", card_brand: "mastercard", pos_method: "credit_card" },
    expected: "MasterCard",
    rationale: "Brand-specific QB entry preserves casing.",
  },
  {
    label: "Terminal credit Amex",
    source: "terminal",
    handler: "receive_payment",
    payment: { method: "credit_card", card_brand: "amex", pos_method: "credit_card" },
    expected: "American Express",
    rationale: "amex → 'American Express' QB entry.",
  },
  {
    label: "Terminal credit Discover",
    source: "terminal",
    handler: "receive_payment",
    payment: { method: "credit_card", card_brand: "discover", pos_method: "credit_card" },
    expected: "Discover",
    rationale: "discover → 'Discover' QB entry.",
  },
  {
    label: "Terminal debit Visa (zero-surcharge inferred)",
    source: "terminal",
    handler: "receive_payment",
    payment: { method: "debit_card", card_brand: "visa", pos_method: "debit_card" },
    expected: "Debit Card",
    rationale: "Debit branch bypasses brand → 'Debit Card' bucket.",
  },
  {
    label: "Terminal debit MasterCard",
    source: "terminal",
    handler: "receive_payment",
    payment: { method: "debit_card", card_brand: "mastercard", pos_method: "debit_card" },
    expected: "Debit Card",
    rationale: "Debit branch bypasses brand regardless of value.",
  },

  // ── BAMS Webhook (ReceivePayment handler — BAMS payments go through pos-payment-created) ─
  {
    label: "BAMS webhook credit Visa (cardType=CREDIT, label=VISA)",
    source: "bams_webhook",
    handler: "receive_payment",
    payment: {
      method: "credit_card",
      card_brand: "visa",
      bams_label: "VISA",
      bams_card_type: "CREDIT",
      pos_method: "credit_card",
    },
    expected: "Visa",
    rationale: "Uppercase label normalizes via ALIAS_PATTERNS to 'Visa'.",
  },
  {
    label: "BAMS webhook credit MasterCard",
    source: "bams_webhook",
    handler: "receive_payment",
    payment: {
      method: "credit_card",
      card_brand: "mastercard",
      bams_label: "MASTERCARD",
      bams_card_type: "CREDIT",
      pos_method: "credit_card",
    },
    expected: "MasterCard",
    rationale: "MASTERCARD label normalizes to 'MasterCard' QB casing.",
  },
  {
    label: "BAMS webhook debit Visa (cardType=DEBIT)",
    source: "bams_webhook",
    handler: "receive_payment",
    payment: {
      method: "debit_card",
      card_brand: "visa",
      bams_label: "VISA",
      bams_card_type: "DEBIT",
      pos_method: "debit_card",
    },
    expected: "Debit Card",
    rationale: "Debit branch triggered by method='debit_card' OR bams_card_type='DEBIT'.",
  },

  // ── Manual (cashier selection) ────────────────────────────────────────
  {
    label: "Manual Visa click (normalized at backend)",
    source: "manual",
    handler: "receive_payment",
    payment: { method: "credit_card", card_brand: "visa", pos_method: "credit_card" },
    expected: "Visa",
    rationale: "Post-normalization shape identical to terminal.",
  },
  {
    label: "Manual Debit Card click (no brand asked)",
    source: "manual",
    handler: "receive_payment",
    payment: { method: "debit_card", card_brand: null, pos_method: "debit_card" },
    expected: "Debit Card",
    rationale: "Debit branch fires on method; brand=null is fine.",
  },
  {
    label: "Manual Cash",
    source: "manual",
    handler: "receive_payment",
    payment: { method: "cash", card_brand: null, pos_method: "cash" },
    expected: "Cash",
    rationale: "Non-card method passes through unchanged.",
  },
  {
    label: "Manual Check",
    source: "manual",
    handler: "receive_payment",
    payment: { method: "check", card_brand: null, pos_method: "check" },
    expected: "Check",
    rationale: "Non-card method passes through.",
  },
  {
    label: "Manual Zelle",
    source: "manual",
    handler: "receive_payment",
    payment: { method: "zelle", card_brand: null, pos_method: "zelle" },
    expected: "Zelle",
    rationale: "Non-card method passes through.",
  },

  // ── Sales Receipt handler (terminal + full-paid flow) ──────────────────
  {
    label: "SR terminal credit Visa",
    source: "terminal",
    handler: "sales_receipt",
    invoice: { payment_method: "credit_card", card_brand: "visa" },
    expected: "Visa",
    rationale: "SR uses (debit ? 'debit_card' : card_brand || payment_method) → 'visa' → 'Visa'.",
  },
  {
    label: "SR terminal debit Visa",
    source: "terminal",
    handler: "sales_receipt",
    invoice: { payment_method: "debit_card", card_brand: "visa" },
    expected: "Debit Card",
    rationale: "SR branch: debit_card → 'Debit Card' (brand ignored).",
  },
  {
    label: "SR manual cash",
    source: "manual",
    handler: "sales_receipt",
    invoice: { payment_method: "cash", card_brand: null },
    expected: "Cash",
    rationale: "Non-card invoice method → Cash.",
  },

  // ── Legacy (post-backfill) ────────────────────────────────────────────
  {
    label: "Legacy backfilled credit Visa",
    source: "legacy",
    handler: "receive_payment",
    payment: { method: "credit_card", card_brand: "visa", pos_method: "visa" },
    expected: "Visa",
    rationale: "Backfilled rows match new-shape after migration.",
  },
  {
    label: "Legacy backfilled debit MasterCard",
    source: "legacy",
    handler: "receive_payment",
    payment: { method: "debit_card", card_brand: "mastercard", pos_method: "mastercard" },
    expected: "Debit Card",
    rationale: "Backfilled debit — debit branch overrides stale brand in pos_method.",
  },

  // ── Edge cases ────────────────────────────────────────────────────────
  {
    label: "Generic 'card' (pre-split, no brand)",
    source: "edge",
    handler: "receive_payment",
    payment: { method: "card", card_brand: null },
    expected: undefined,
    rationale: "No brand signal → QB field blank (avoids 3140).",
  },
  {
    label: "credit_card with no brand anywhere",
    source: "edge",
    handler: "receive_payment",
    payment: { method: "credit_card", card_brand: null, pos_method: "credit_card" },
    expected: undefined,
    rationale: "Credit w/ no brand → blank in QB (better than wrong name).",
  },
  {
    label: "debit_card with no brand — resolves to 'Debit Card'",
    source: "edge",
    handler: "receive_payment",
    payment: { method: "debit_card", card_brand: null, pos_method: "debit_card" },
    expected: "Debit Card",
    rationale: "Debit bucket in QB accepts no-brand debit correctly.",
  },
  {
    label: "Unknown brand (e.g. JCB)",
    source: "edge",
    handler: "receive_payment",
    payment: { method: "credit_card", card_brand: "jcb", pos_method: "credit_card" },
    expected: undefined,
    rationale: "Unsupported brand → undefined → QB blank (safe default).",
  },
];

export default async function verify({ container: _c }: { container: MedusaContainer }) {
  let pass = 0;
  let fail = 0;

  console.log(`\n┌──────────────────────────────────────────────────────────────────────────────┐`);
  console.log(`│  QB PaymentMethod Resolution — static verification (no QB calls)            │`);
  console.log(`└──────────────────────────────────────────────────────────────────────────────┘\n`);

  const groups: Record<string, TestCase[]> = {};
  for (const t of TESTS) {
    const key = `${t.source} / ${t.handler}`;
    groups[key] = groups[key] ?? [];
    groups[key].push(t);
  }

  for (const [group, cases] of Object.entries(groups)) {
    console.log(`── ${group.toUpperCase()} ──────────────────────────────────────────────\n`);
    for (const t of cases) {
      const actual =
        t.handler === "sales_receipt"
          ? srResolveQbMethod(t.invoice!)
          : handlerResolveQbMethod(t.payment!);
      const ok = actual === t.expected;
      const icon = ok ? "✅" : "❌";
      const got = actual ?? "(omitted)";
      console.log(`  ${icon} ${t.label.padEnd(54)}  →  ${got}`);
      if (!ok) {
        console.log(`         expected: ${t.expected ?? "(omitted)"}`);
        console.log(`         input:    ${JSON.stringify(t.payment ?? t.invoice)}`);
        fail++;
      } else {
        pass++;
      }
    }
    console.log();
  }

  console.log(`──────────────────────────────────────────────────────────────────────────────`);
  console.log(`  Total: ${pass + fail}    Passed: ${pass}    Failed: ${fail}`);
  console.log(`──────────────────────────────────────────────────────────────────────────────\n`);

  if (fail > 0) {
    console.log(
      `❌ ${fail} case(s) failed — review the sanitizer / handler logic or update the expected value if intentional.\n`
    );
    process.exitCode = 1;
  } else {
    console.log(
      `✅ All cases passed — the Phase-5 QB payment-method resolution produces the correct QB\n` +
      `   PaymentMethod for every realistic scenario across all three capture paths. Safe to\n` +
      `   proceed with live captures.\n`
    );
  }
}
