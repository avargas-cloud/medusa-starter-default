import { classifyPayment } from "../../lib/cash-close/classify";
import {
  assertValidDay,
  latestClosableDay,
  CashCloseDayNotClosedError,
  CashCloseInvalidDayError,
} from "../../lib/cash-close/service";
import { getBusinessDateString } from "../../lib/date/et";
import {
  buildInvoiceRows,
  buildLadder,
  buildTotals,
  CashCloseLadderMismatchError,
  computeSnapshot,
  type CashCloseDayRows,
} from "../../lib/cash-close/totals";
import type { RawInvoice, RawPayment } from "../../lib/cash-close/load-day";
import type { CashCloseTotals } from "../../lib/cash-close/types";

const DAY = "2026-09-17";

function payment(overrides: Partial<RawPayment>): RawPayment {
  return {
    payment_id: "cpay_x",
    display_id: 9000,
    received_at: `${DAY}T12:00:00.000Z`,
    customer_id: "cus_x",
    customer_name: "Jane Doe",
    customer_contact: null,
    method: "cash",
    card_brand: null,
    type: "payment",
    amount_cents: 0,
    surcharge_cents: 0,
    metadata: null,
    linked_order_id: null,
    linked_order_display_id: null,
    linked_order_is_draft: null,
    applications: [],
    ...overrides,
  };
}

function dayRowsFixture(): CashCloseDayRows {
  const invoiceOnAccount: RawInvoice = {
    invoice_id: "inv_1873",
    invoice_number: "21999",
    customer_name: "On Account Co",
    total_cents: 5000,
    tax_cents: 0,
    applications: [
      {
        payment_id: "cpay_partial",
        payment_display_id: 9100,
        payment_type: "payment",
        payment_day: DAY,
        amount_applied_cents: 3127,
      },
    ],
  };
  return {
    payments: [
      payment({
        display_id: 9100,
        amount_cents: 3127,
        applications: [
          {
            invoice_id: "inv_1873",
            invoice_number: "21999",
            invoice_issued_day: DAY,
            order_id: null,
            order_display_id: null,
            amount_applied_cents: 3127,
            applied_at: `${DAY}T09:00:00.000Z`,
            invoice_total_cents: null,
            invoice_tax_cents: null,
          },
        ],
      }),
    ],
    invoices: [invoiceOnAccount],
    creditMemos: [],
    refunds: [
      {
        payment_id: "cpay_refund",
        display_id: 4994,
        customer_name: "Refund Customer",
        amount_cents: 20706,
        method: "credit_memo",
        card_brand: null,
        credit_memo_number: "CM-1169",
      },
    ],
    orderEstimateAgg: {
      orders_issued_count: 1,
      orders_issued_cents: 15000,
      estimates_issued_count: 0,
      estimates_issued_cents: 0,
    },
  };
}

describe("buildTotals / on_account / refunds", () => {
  it("computes on_account for an invoice left partially unpaid", () => {
    const dayRows = dayRowsFixture();
    const paymentRows = dayRows.payments.map((p) => classifyPayment(p, DAY));
    const totals = buildTotals(
      paymentRows,
      buildInvoiceRows(dayRows.invoices, DAY),
      dayRows.creditMemos,
      dayRows.refunds,
      dayRows.orderEstimateAgg
    );
    expect(totals.on_account_cents).toBe(1873); // 5000 - 3127
    expect(totals.on_account_count).toBe(1);
    expect(totals.invoiced_net_cents + totals.invoiced_tax_cents).toBe(totals.invoiced_cents);
    expect(totals.refunds_paid_out_cents).toBe(20706);
    expect(totals.refunds_count).toBe(1);
  });
});

describe("computeSnapshot / ladder", () => {
  it("ties the ladder to the cent for the 09/17 fixture and reports balanced", () => {
    const dayRows: CashCloseDayRows = {
      payments: [
        payment({
          display_id: 5072,
          amount_cents: 15000,
          applications: [
            {
              invoice_id: "inv_21844",
              invoice_number: "21844",
              invoice_issued_day: "2026-09-18",
              order_id: "order_4710",
              order_display_id: 4710,
              amount_applied_cents: 15000,
              applied_at: `${DAY}T16:47:57.000Z`,
              invoice_total_cents: null,
              invoice_tax_cents: null,
            },
          ],
        }),
        payment({
          display_id: 5077,
          method: "zelle",
          amount_cents: 58200,
          applications: [
            {
              invoice_id: "inv_21837",
              invoice_number: "21837",
              invoice_issued_day: DAY,
              order_id: "order_4719",
              order_display_id: 4719,
              amount_applied_cents: 58195,
              applied_at: `${DAY}T21:39:56.000Z`,
              invoice_total_cents: null,
              invoice_tax_cents: null,
            },
          ],
        }),
      ],
      invoices: [
        {
          invoice_id: "inv_21837",
          invoice_number: "21837",
          customer_name: "Zelle Customer",
          total_cents: 58195,
          tax_cents: 0,
          applications: [
            {
              payment_id: "cpay_5077",
              payment_display_id: 5077,
              payment_type: "payment",
              payment_day: DAY,
              amount_applied_cents: 58195,
            },
          ],
        },
      ],
      creditMemos: [],
      refunds: [],
      orderEstimateAgg: {
        orders_issued_count: 0,
        orders_issued_cents: 0,
        estimates_issued_count: 0,
        estimates_issued_cents: 0,
      },
    };
    const snapshot = computeSnapshot(dayRows, DAY, new Date("2026-09-18T00:00:00.000Z"));
    const endLine = snapshot.ladder[snapshot.ladder.length - 1]!;
    expect(endLine.kind).toBe("end");
    expect(endLine.cents).toBe(snapshot.totals.received_cents - snapshot.totals.refunds_paid_out_cents);
    expect(snapshot.balanced).toBe(false); // the 5-cent unexplained keeps it unbalanced
    expect(snapshot.totals.unexplained_cents).toBe(5);
  });

  it("throws CASH_CLOSE_LADDER_MISMATCH when a totals bucket is corrupted (mutation-style negative test)", () => {
    const totals: CashCloseTotals = {
      received_cents: 100,
      received_count: 1,
      surcharge_cents: 0,
      store_credit_tender_cents: 0,
      refunds_paid_out_cents: 0,
      refunds_count: 0,
      invoiced_cents: 100,
      invoiced_count: 1,
      credit_memos_today_cents: 0,
      credit_memos_count: 0,
      estimates_issued_count: 0,
      estimates_issued_cents: 0,
      orders_issued_count: 0,
      orders_issued_cents: 0,
      invoice_today_cents: 100,
      invoice_earlier_cents: 0,
      order_deposit_cents: 0,
      estimate_deposit_cents: 0,
      held_deposit_cents: 0,
      held_credit_cents: 0,
      unexplained_cents: 0,
      unexplained_count: 0,
      paid_today_cents: 100,
      paid_earlier_cents: 0,
      paid_store_credit_cents: 0,
      on_account_cents: 0,
      on_account_count: 0,
    };
    // Sane totals tie cleanly first (control):
    expect(() => buildLadder(totals)).not.toThrow();
    // Corrupt one LADDER term without touching `received_cents` — the tie
    // assertion compares the sum of ladder lines against `received_cents`
    // directly, so this is the mutation that actually exercises the guard
    // (`invoice_today_cents` is not itself a ladder line).
    const corrupted: CashCloseTotals = { ...totals, unexplained_cents: 5 };
    expect(() => buildLadder(corrupted)).toThrow(CashCloseLadderMismatchError);

    // 09/18/2026 in prod: a $268.02 credit memo completed today and spent as
    // store credit on an EARLIER invoice. A CM moves no cash and changes
    // nothing of what was invoiced today, so it must NOT be a ladder line —
    // when it was, every open of "today" threw and the modal spun forever.
    const withCreditMemo: CashCloseTotals = {
      ...totals,
      credit_memos_today_cents: 26802,
      credit_memos_count: 1,
      store_credit_tender_cents: 26802,
    };
    expect(() => buildLadder(withCreditMemo)).not.toThrow();
    expect(buildLadder(withCreditMemo).some((l) => l.key === "credit_memos_today")).toBe(false);
  });
});

describe("assertValidDay — only a finished business day can be closed", () => {
  it("accepts yesterday, rejects today and the future", () => {
    const yesterday = latestClosableDay();
    expect(() => assertValidDay(yesterday)).not.toThrow();
    expect(() => assertValidDay("2020-01-01")).not.toThrow();
    const today = getBusinessDateString();
    expect(() => assertValidDay(today)).toThrow(CashCloseDayNotClosedError);
    expect(() => assertValidDay("2999-12-31")).toThrow(CashCloseDayNotClosedError);
    expect(() => assertValidDay("not-a-day")).toThrow(CashCloseInvalidDayError);
  });
});

describe("sales before tax (QB Sales report figure)", () => {
  it("splits invoiced into net + tax and prorates the tax share of the day's payments", () => {
    const dayRows = dayRowsFixture();
    const invoice = dayRows.invoices[0]!;
    invoice.tax_cents = 300; // 5000 total = 4700 net + 300 tax
    const app = dayRows.payments[0]!.applications[0]!;
    app.invoice_total_cents = 5000;
    app.invoice_tax_cents = 300;
    const paymentRows = dayRows.payments.map((p) => classifyPayment(p, DAY));
    const invoiceRows = buildInvoiceRows(dayRows.invoices, DAY);
    expect(invoiceRows[0]!.net_cents).toBe(4700);
    const totals = buildTotals(paymentRows, invoiceRows, dayRows.creditMemos, dayRows.refunds, dayRows.orderEstimateAgg);
    expect(totals.invoiced_cents).toBe(5000);
    expect(totals.invoiced_tax_cents).toBe(300);
    expect(totals.invoiced_net_cents).toBe(4700);
    expect(totals.received_tax_cents).toBe(188); // round(300 × 3127 / 5000)
  });
});
