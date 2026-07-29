import type { Client } from "pg";

import { enrichOrderTotals } from "../../lib/meilisearch/enrich-order-totals";
import { buildOrderDoc, type OrderForMeili } from "../../lib/meilisearch/build-order-doc";

/**
 * The single missing input behind both payment buckets being wrong: getOrderTotal
 * reads summary.current_order_total, query.graph does not deliver it, and every
 * branch downstream is gated on a positive total. 959 orders indexed as
 * "deposited" because `fully_paid` was unreachable, and the Unpaid tab reported
 * 22 instead of 45 because "owes money" also needs a total to owe against.
 */
function fakeDb(rows: Array<{ order_id: string; total: string | null }>): Client {
  return {
    query: jest.fn().mockResolvedValue({ rows }),
  } as unknown as Client;
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: "order_1",
    display_id: 1,
    status: "pending",
    is_draft_order: false,
    created_at: "2026-07-01T00:00:00.000Z",
    metadata: {},
    payment_collections: [],
    fulfillments: [],
    items: [],
    ...overrides,
  } as OrderForMeili;
}

describe("enrichOrderTotals", () => {
  it("patches a missing total from order_summary", async () => {
    const orders = [order({ summary: null })];

    const result = await enrichOrderTotals(
      fakeDb([{ order_id: "order_1", total: "176.7854" }]),
      orders as never
    );

    expect(result.patched).toBe(1);
    expect(result.unresolved).toEqual([]);
    expect(orders[0].summary?.current_order_total).toBe("176.7854");
  });

  it("reads the summary at the order's CURRENT version", async () => {
    const db = fakeDb([]);
    await enrichOrderTotals(db, [order({ summary: null })] as never);

    const sql = (db.query as jest.Mock).mock.calls[0][0] as string;
    // A stale-version summary carries the total from before an order edit.
    expect(sql).toContain("o.version = s.version");
  });

  it("reports an order with no summary row instead of inventing a total", async () => {
    const orders = [order({ summary: null })];

    const result = await enrichOrderTotals(fakeDb([]), orders as never);

    expect(result.unresolved).toEqual(["order_1"]);
    expect(orders[0].summary?.current_order_total).toBeUndefined();
  });

  it("leaves an order that already has a total alone", async () => {
    const db = fakeDb([]);
    const orders = [order({ summary: { current_order_total: 50 } })];

    const result = await enrichOrderTotals(db, orders as never);

    expect(db.query).not.toHaveBeenCalled();
    expect(result.patched).toBe(0);
    expect(orders[0].summary?.current_order_total).toBe(50);
  });

  it("does nothing for an empty list", async () => {
    const db = fakeDb([]);
    expect(await enrichOrderTotals(db, [])).toEqual({ unresolved: [], patched: 0 });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("buildOrderDoc with an enriched total", () => {
  it("reaches fully_paid once a total exists — unreachable without one", async () => {
    const paid = [{ captured_amount: 100, refunded_amount: 0 }];

    const withoutTotal = buildOrderDoc(
      order({ summary: null, payment_collections: paid })
    );
    expect(withoutTotal.effective_payment).toBe("deposited");
    expect(withoutTotal.is_unpaid).toBe(false);

    const orders = [order({ summary: null, payment_collections: paid })];
    await enrichOrderTotals(
      fakeDb([{ order_id: "order_1", total: "100" }]),
      orders as never
    );

    const withTotal = buildOrderDoc(orders[0]);
    expect(withTotal.effective_payment).toBe("fully_paid");
    expect(withTotal.is_unpaid).toBe(false);
  });

  it("puts a part-paid order in Unpaid once the total is known", async () => {
    const orders = [
      order({
        summary: null,
        payment_collections: [{ captured_amount: 20, refunded_amount: 0 }],
      }),
    ];
    await enrichOrderTotals(
      fakeDb([{ order_id: "order_1", total: "468.44" }]),
      orders as never
    );

    const doc = buildOrderDoc(orders[0]);
    expect(doc.effective_payment).toBe("deposited");
    expect(doc.is_unpaid).toBe(true);
  });

  it("keeps pos_total ahead of the enriched summary", async () => {
    // A POS-authored total is the operator's number and outranks anything
    // derived, so enrichment must not be able to override it.
    const orders = [
      order({
        metadata: { pos_total: 500 },
        summary: null,
        payment_collections: [{ captured_amount: 500, refunded_amount: 0 }],
      }),
    ];
    await enrichOrderTotals(
      fakeDb([{ order_id: "order_1", total: "999" }]),
      orders as never
    );

    const doc = buildOrderDoc(orders[0]);
    expect(doc.effective_payment).toBe("fully_paid");
  });
});
