/**
 * verify-applied-payments-endpoint
 *
 * Static contract test for GET /admin/invoices/:id/applied-payments.
 *
 * Tests the pure mapper `mapAppliedPayment` against synthetic PaymentApplication
 * rows (joined with a CustomerPayment). No DB, no HTTP.
 *
 * Run: yarn tsx src/scripts/verify/verify-applied-payments-endpoint.ts
 */
import { mapAppliedPayment } from "../../api/admin/invoices/[id]/applied-payments/route";

interface Scenario {
  name: string;
  input: Parameters<typeof mapAppliedPayment>[0];
  expect: Partial<ReturnType<typeof mapAppliedPayment>>;
}

const iso = (d: string) => new Date(d);

const scenarios: Scenario[] = [
  {
    name: "cash payment applied fully",
    input: {
      id: "papp_cash_01",
      payment_id: "cpay_cash_01",
      amount_applied: 10000,
      applied_at: iso("2026-04-20T12:00:00Z"),
      voided_at: null,
      void_reason: null,
      payment: {
        id: "cpay_cash_01",
        display_id: 2090,
        method: "cash",
        card_brand: null,
        reference: null,
        status: "applied",
        type: "payment",
        received_at: iso("2026-04-20T12:00:00Z"),
      },
    },
    expect: {
      application_id: "papp_cash_01",
      payment_id: "cpay_cash_01",
      sequence_number: 2090,
      payment_method: "cash",
      card_brand: null,
      amount_applied_cents: 10000,
      voided: false,
      payment_status: "applied",
      payment_type: "payment",
    },
  },
  {
    name: "credit_card payment with Visa brand",
    input: {
      id: "papp_cc_01",
      payment_id: "cpay_cc_01",
      amount_applied: 71616,
      applied_at: iso("2026-04-20T13:00:00Z"),
      voided_at: null,
      void_reason: null,
      payment: {
        id: "cpay_cc_01",
        display_id: 2093,
        method: "credit_card",
        card_brand: "Visa",
        reference: "5972",
        status: "applied",
        type: "payment",
        received_at: iso("2026-04-20T13:00:00Z"),
      },
    },
    expect: {
      payment_method: "credit_card",
      card_brand: "Visa",
      reference: "5972",
      amount_applied_cents: 71616,
    },
  },
  {
    name: "debit_card payment has no brand",
    input: {
      id: "papp_debit_01",
      payment_id: "cpay_debit_01",
      amount_applied: 15000,
      applied_at: iso("2026-04-19T10:00:00Z"),
      voided_at: null,
      void_reason: null,
      payment: {
        id: "cpay_debit_01",
        display_id: 2080,
        method: "debit_card",
        card_brand: null,
        reference: "4321",
        status: "applied",
        type: "payment",
        received_at: iso("2026-04-19T10:00:00Z"),
      },
    },
    expect: {
      payment_method: "debit_card",
      card_brand: null,
      reference: "4321",
    },
  },
  {
    name: "voided application flagged correctly",
    input: {
      id: "papp_void_01",
      payment_id: "cpay_void_01",
      amount_applied: 5000,
      applied_at: iso("2026-04-18T10:00:00Z"),
      voided_at: iso("2026-04-19T10:00:00Z"),
      void_reason: "duplicate entry",
      payment: {
        id: "cpay_void_01",
        display_id: 2070,
        method: "check",
        card_brand: null,
        reference: "1234",
        status: "available",
        type: "payment",
        received_at: iso("2026-04-18T09:00:00Z"),
      },
    },
    expect: {
      voided: true,
      void_reason: "duplicate entry",
      payment_method: "check",
    },
  },
  {
    name: "partial application — amount_applied less than payment total",
    input: {
      id: "papp_partial_01",
      payment_id: "cpay_partial_01",
      amount_applied: 25000,
      applied_at: iso("2026-04-17T10:00:00Z"),
      voided_at: null,
      void_reason: null,
      payment: {
        id: "cpay_partial_01",
        display_id: 2060,
        method: "credit_card",
        card_brand: "MasterCard",
        reference: "0001",
        status: "partially_applied",
        type: "payment",
        received_at: iso("2026-04-17T10:00:00Z"),
      },
    },
    expect: {
      amount_applied_cents: 25000,
      payment_status: "partially_applied",
    },
  },
  {
    name: "BigNumber-like amount_applied object",
    input: {
      id: "papp_bn_01",
      payment_id: "cpay_bn_01",
      amount_applied: { numeric_: 12345, value: "12345" } as unknown as number,
      applied_at: iso("2026-04-16T10:00:00Z"),
      voided_at: null,
      void_reason: null,
      payment: {
        id: "cpay_bn_01",
        display_id: null,
        method: "cash",
        card_brand: null,
        reference: null,
        status: "applied",
        type: "payment",
        received_at: iso("2026-04-16T10:00:00Z"),
      },
    },
    expect: {
      amount_applied_cents: 12345,
      sequence_number: null,
    },
  },
  {
    name: "refund payment",
    input: {
      id: "papp_refund_01",
      payment_id: "cpay_refund_01",
      amount_applied: 5000,
      applied_at: iso("2026-04-15T10:00:00Z"),
      voided_at: null,
      void_reason: null,
      payment: {
        id: "cpay_refund_01",
        display_id: 2050,
        method: "credit_card",
        card_brand: "Visa",
        reference: "9999",
        status: "refunded",
        type: "refund",
        received_at: iso("2026-04-15T10:00:00Z"),
      },
    },
    expect: {
      payment_type: "refund",
      payment_status: "refunded",
    },
  },
  {
    name: "missing payment relation — graceful fallback",
    input: {
      id: "papp_orphan_01",
      payment_id: "cpay_orphan_01",
      amount_applied: 1000,
      applied_at: iso("2026-04-14T10:00:00Z"),
      voided_at: null,
      void_reason: null,
      payment: null,
    },
    expect: {
      payment_id: "cpay_orphan_01",
      sequence_number: null,
      payment_method: "other",
      card_brand: null,
      payment_status: "unknown",
    },
  },
];

let passed = 0;
let failed = 0;
const failures: string[] = [];

for (const scenario of scenarios) {
  const actual = mapAppliedPayment(scenario.input);
  const mismatches: string[] = [];

  for (const [key, expected] of Object.entries(scenario.expect)) {
    const got = actual[key as keyof typeof actual];
    if (got !== expected) {
      mismatches.push(`  ${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    }
  }

  if (mismatches.length > 0) {
    failed++;
    failures.push(`✗ ${scenario.name}\n${mismatches.join("\n")}`);
  } else {
    passed++;
    console.log(`✓ ${scenario.name}`);
  }
}

console.log(`\n${passed}/${scenarios.length} scenarios passed`);
if (failed > 0) {
  console.log(`\n${failed} failures:`);
  failures.forEach((f) => console.log(f));
  process.exit(1);
}
