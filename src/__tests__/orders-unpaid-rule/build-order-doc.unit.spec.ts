import { buildOrderDoc, type OrderForMeili } from "../../lib/meilisearch/build-order-doc";

/**
 * `is_unpaid` decides the POS Unpaid tab's membership server-side. Its meaning
 * changed on 2026-07-29 from "nothing has arrived" to "money is still owed", by
 * the operator's call: an order with a deposit that does not cover the total
 * still needs collecting, so it belongs in the same queue as one with nothing
 * paid. One whose deposit covers it in full does not.
 *
 * The mirror of this rule is isUnpaid() in store-pos orders/utils.ts. If the two
 * drift, the tab and the rows inside it disagree.
 */
function order(overrides: Partial<OrderForMeili> = {}): OrderForMeili {
  return {
    id: "order_1",
    display_id: 1,
    status: "pending",
    is_draft_order: false,
    created_at: "2026-07-01T00:00:00.000Z",
    metadata: {},
    summary: { current_order_total: 100 },
    payment_collections: [],
    fulfillments: [],
    items: [],
    ...overrides,
  } as OrderForMeili;
}

function paid(amount: number) {
  return [{ captured_amount: amount, refunded_amount: 0 }];
}

describe("is_unpaid — owes money, not 'nothing paid'", () => {
  it("is unpaid when nothing has been received", () => {
    expect(buildOrderDoc(order()).is_unpaid).toBe(true);
  });

  it("is unpaid when a deposit does not cover the total", () => {
    // The change: this used to be false, so a half-paid order fell out of the
    // Unpaid tab even though someone still had to collect the rest.
    const doc = buildOrderDoc(order({ payment_collections: paid(40) }));
    expect(doc.is_unpaid).toBe(true);
    // The badge is unaffected — it still reads Deposited, not Not Paid.
    expect(doc.effective_payment).toBe("deposited");
  });

  it("is NOT unpaid once the money covers the total", () => {
    const doc = buildOrderDoc(order({ payment_collections: paid(100) }));
    expect(doc.is_unpaid).toBe(false);
    expect(doc.effective_payment).toBe("fully_paid");
  });

  it("treats a shortfall under a cent as covered", () => {
    // Same epsilon the fully_paid branch uses, so the two can never disagree
    // about the same order.
    expect(buildOrderDoc(order({ payment_collections: paid(99.995) })).is_unpaid).toBe(
      false
    );
  });

  it("is unpaid for a shortfall of more than a cent", () => {
    expect(buildOrderDoc(order({ payment_collections: paid(99.5) })).is_unpaid).toBe(
      true
    );
  });

  it("excludes a voided order — cancelled is not owing", () => {
    const doc = buildOrderDoc(
      order({ metadata: { qb_sync_status: "voided" }, payment_collections: paid(10) })
    );
    expect(doc.is_unpaid).toBe(false);
    expect(doc.effective_payment).toBe("voided");
  });

  it("counts a live deposit toward covering the order", () => {
    // referential_deposit is money sitting on the order and not yet consumed by
    // an invoice. It settles the order even before invoicing.
    const doc = buildOrderDoc(order({ metadata: { referential_deposit: 100 } }));
    expect(doc.is_unpaid).toBe(false);
    expect(doc.effective_payment).toBe("fully_paid");
  });

  /**
   * The three numbers, and the property that makes them trustworthy: Deposit is
   * money NOT yet used, Paid Amt is money already consumed by invoices, and they
   * never overlap. Before 2026-07-29 a single field played both roles, which is
   * why a settled order displayed the same value twice and a consumed deposit
   * still showed as a deposit.
   */
  describe("deposit and applied are disjoint halves of the same money", () => {
    it("reads Paid Amt from applied_total, not from the deposit", () => {
      const doc = buildOrderDoc(
        order({ metadata: { applied_total: 60, referential_deposit: 40 } })
      );
      // 60 consumed + 40 still sitting = the 100 total, so nothing is owed.
      expect(doc.is_unpaid).toBe(false);
      expect(doc.effective_payment).toBe("fully_paid");
    });

    it("still owes when applied plus deposit falls short", () => {
      const doc = buildOrderDoc(
        order({ metadata: { applied_total: 30, referential_deposit: 20 } })
      );
      expect(doc.is_unpaid).toBe(true);
      expect(doc.effective_payment).toBe("deposited");
    });

    it("is fully paid once the deposit has been consumed entirely", () => {
      // The order that started this work: invoiced in full, so the deposit is
      // gone and Paid Amt carries all of it. The old formula reported the
      // consumed money as a deposit forever.
      const doc = buildOrderDoc(
        order({ metadata: { applied_total: 100, referential_deposit: 0 } })
      );
      expect(doc.is_unpaid).toBe(false);
      expect(doc.effective_payment).toBe("fully_paid");
    });

    it("does not let a zero applied_total be mistaken for a missing one", () => {
      // A deposited-but-uninvoiced order has applied_total = 0, which must NOT
      // fall through to the payment-collection fallback and resurrect the old
      // behaviour. 0 is an answer; absent is not.
      const doc = buildOrderDoc(
        order({
          metadata: { applied_total: 0, referential_deposit: 100 },
          payment_collections: paid(999),
        })
      );
      expect(doc.effective_payment).toBe("fully_paid");
      expect(doc.is_unpaid).toBe(false);
    });

    it("does not let a sub-cent total be covered by any deposit", () => {
      // Found in the sandbox, not imagined: order #1487 carried
      // current_order_total = 0.0024. Positive in dollars, zero once rounded to
      // cents, so a $6.39 remainder "covered" it and the order came out
      // fully_paid with total_cents = 0 — a combination that reads as
      // impossible until you find the sub-cent. order_money_projection stores
      // cents, so classifying on unrounded dollars made the authority and this
      // doc disagree on two orders.
      const doc = buildOrderDoc(
        order({
          summary: { current_order_total: 0.0024 },
          metadata: { applied_total: 0, referential_deposit: 6.39 },
        })
      );
      expect(doc.total_cents).toBe(0);
      expect(doc.effective_payment).toBe("deposited");
      expect(doc.is_unpaid).toBe(false);
    });

    it("falls back to Medusa's captured amount when there is no projection yet", () => {
      // An order the finance ledger has never touched has no applied_total at
      // all. Measured 2026-07-29: no production order had captured MORE than
      // the ledger applied, so this covers new rows rather than papering over a
      // disagreement.
      const doc = buildOrderDoc(
        order({ metadata: {}, payment_collections: paid(100) })
      );
      expect(doc.is_unpaid).toBe(false);
      expect(doc.effective_payment).toBe("fully_paid");
    });
  });

  it("is not unpaid when there is no total to owe against", () => {
    // A zero/unknown total cannot support a balance claim; asserting "owes
    // money" there would put every malformed order in the collections queue.
    const doc = buildOrderDoc(
      order({ summary: { current_order_total: 0 }, metadata: {} })
    );
    expect(doc.is_unpaid).toBe(false);
  });

  it("no longer emits captured as an effective payment status", () => {
    const doc = buildOrderDoc(
      order({ payment_status: "captured", payment_collections: paid(100) })
    );
    expect(doc.effective_payment).toBe("fully_paid");
  });
});
