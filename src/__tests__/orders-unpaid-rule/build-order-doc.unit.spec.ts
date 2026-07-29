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

  it("counts a referential deposit as money received", () => {
    // referential_deposit records external money (terminal, BAMS, captured
    // deposit) that Medusa's payment collections do not see.
    const doc = buildOrderDoc(order({ metadata: { referential_deposit: 100 } }));
    expect(doc.is_unpaid).toBe(false);
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
