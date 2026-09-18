import { classifyPayment } from "../../lib/cash-close/classify";
import type { RawPayment } from "../../lib/cash-close/load-day";

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

describe("classifyPayment", () => {
  it("5072-style: order deposit — invoice issued the NEXT day still buckets as order_deposit", () => {
    const row = payment({
      display_id: 5072,
      amount_cents: 15000,
      applications: [
        {
          invoice_id: "inv_21844",
          invoice_number: "21844",
          invoice_issued_day: "2026-09-18", // day AFTER D
          order_id: "order_4710",
          order_display_id: 4710,
          amount_applied_cents: 15000,
          applied_at: `${DAY}T16:47:57.000Z`,
        },
      ],
    });
    const result = classifyPayment(row, DAY);
    expect(result.applications).toHaveLength(1);
    expect(result.applications[0]!.bucket).toBe("order_deposit");
    expect(result.applications[0]!.note).toContain("2026-09-18");
    expect(result.unapplied_cents).toBe(0);
    expect(result.unexplained_cents).toBe(0);
  });

  it("5077-style: 5 cents over-collected is unexplained; a hold makes it held_credit and balanced", () => {
    const row = payment({
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
        },
      ],
    });
    const unexplained = classifyPayment(row, DAY);
    expect(unexplained.unapplied_cents).toBe(5);
    expect(unexplained.unexplained_cents).toBe(5);
    expect(unexplained.hold).toBeNull();

    const held = classifyPayment(
      {
        ...row,
        metadata: {
          cash_close_hold: {
            kind: "credit",
            note: "rounding",
            by: "user_1",
            by_name: "A. Vargas",
            at: `${DAY}T23:00:00.000Z`,
          },
        },
      },
      DAY
    );
    expect(held.unexplained_cents).toBe(0);
    expect(held.unapplied_cents).toBe(5);
    expect(held.hold?.kind).toBe("credit");
  });

  it("classifies an application on an invoice issued BEFORE D as invoice_earlier", () => {
    const row = payment({
      amount_cents: 10000,
      applications: [
        {
          invoice_id: "inv_old",
          invoice_number: "21000",
          invoice_issued_day: "2026-09-01",
          order_id: null,
          order_display_id: null,
          amount_applied_cents: 10000,
          applied_at: `${DAY}T10:00:00.000Z`,
        },
      ],
    });
    const result = classifyPayment(row, DAY);
    expect(result.applications[0]!.bucket).toBe("invoice_earlier");
  });

  it("a credit_memo-type payment is flagged is_store_credit and excluded from received", () => {
    const row = payment({
      type: "credit_memo",
      method: "credit_memo",
      amount_cents: 5000,
      applications: [
        {
          invoice_id: "inv_sc",
          invoice_number: "21900",
          invoice_issued_day: DAY,
          order_id: null,
          order_display_id: null,
          amount_applied_cents: 5000,
          applied_at: `${DAY}T10:00:00.000Z`,
        },
      ],
    });
    const result = classifyPayment(row, DAY);
    expect(result.is_store_credit).toBe(true);
  });

  it("no active application, linked to a draft order — estimate_deposit", () => {
    const row = payment({
      amount_cents: 80892,
      linked_order_id: "order_4715",
      linked_order_display_id: 4715,
      linked_order_is_draft: true,
    });
    const result = classifyPayment(row, DAY);
    expect(result.applications).toHaveLength(1);
    expect(result.applications[0]!.bucket).toBe("estimate_deposit");
    expect(result.applications[0]!.document_label).toBe("EST-4715");
    expect(result.unapplied_cents).toBe(0);
  });
});
