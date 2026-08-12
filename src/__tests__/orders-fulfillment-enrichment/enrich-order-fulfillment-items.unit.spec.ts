import { readFileSync } from "fs";
import { join } from "path";

import type { Client } from "pg";

import {
  buildOrderDoc,
  computeFulfillmentStatus,
  type OrderForMeili,
} from "../../lib/meilisearch/build-order-doc";
import { enrichOrderFulfillmentsAndItems } from "../../lib/meilisearch/enrich-order-fulfillment-items";

/**
 * The bug this pins: an order with ONE fulfillment covering 10 of 42 units read
 * as `delivered` — not `partially_delivered` — because the writer never supplied
 * the line quantities computeFulfillmentStatus needs to demote it. `delivered`
 * is a CLOSED fulfillment status, so is_open flipped to false and S11417
 * vanished from Open Orders. Someone re-typed it as a second order and the same
 * 32 units were reserved and shipped twice.
 *
 * Two writers feed this index. The runner asked for the quantities; the event
 * subscriber did not — so an order's tab depended on which one touched it last.
 */

const DELIVERED = new Date("2026-08-11T14:49:51.280Z");

function fakeDb(
  fulfillments: Array<Record<string, unknown>>,
  items: Array<Record<string, unknown>>
): Client {
  return {
    query: jest
      .fn()
      // Promise.all order: fulfillments first, then items.
      .mockResolvedValueOnce({ rows: fulfillments })
      .mockResolvedValueOnce({ rows: items }),
  } as unknown as Client;
}

function order(overrides: Record<string, unknown> = {}): OrderForMeili {
  return {
    id: "order_S11417",
    display_id: 3004,
    status: "pending",
    is_draft_order: false,
    created_at: "2026-08-10T00:00:00.000Z",
    metadata: { document_number: "S11417", pos_created: true, pos_total: 885.87 },
    payment_collections: [],
    fulfillments: [],
    items: [],
    ...overrides,
  } as OrderForMeili;
}

describe("computeFulfillmentStatus — the demotion that decides the Open tab", () => {
  const oneDelivered = [{ delivered_at: DELIVERED }];

  it("is partially_delivered when a line is only part-fulfilled", () => {
    expect(
      computeFulfillmentStatus(oneDelivered, [
        { quantity: 42, detail: { fulfilled_quantity: 10 } },
      ])
    ).toBe("partially_delivered");
  });

  it("is delivered only when every line is fully fulfilled", () => {
    expect(
      computeFulfillmentStatus(oneDelivered, [
        { quantity: 42, detail: { fulfilled_quantity: 42 } },
      ])
    ).toBe("delivered");
  });

  it("REGRESSION: without item quantities it cannot demote — this is the bug", () => {
    // Not an endorsement: this documents why the enrichment below is mandatory
    // rather than an optimization. A caller that omits items gets `delivered`
    // for a 10-of-42 order, and the order leaves Open Orders.
    expect(computeFulfillmentStatus(oneDelivered, undefined)).toBe("delivered");
  });
});

describe("enrichOrderFulfillmentsAndItems", () => {
  it("keeps a part-delivered order OPEN (the S11417 case, end to end)", async () => {
    const orders = [order()];

    await enrichOrderFulfillmentsAndItems(
      fakeDb(
        [{ order_id: "order_S11417", delivered_at: DELIVERED }],
        [
          {
            order_id: "order_S11417",
            quantity: 42,
            fulfilled_quantity: 10,
          },
        ]
      ),
      orders,
      ["order_S11417"]
    );

    const doc = buildOrderDoc(orders[0]);
    expect(doc.fulfillment_status).toBe("partially_delivered");
    expect(doc.is_open).toBe(true);
    expect(doc.is_closed).toBe(false);
  });

  it("closes the order once every unit is delivered", async () => {
    const orders = [order()];

    await enrichOrderFulfillmentsAndItems(
      fakeDb(
        [{ order_id: "order_S11417", delivered_at: DELIVERED }],
        [{ order_id: "order_S11417", quantity: 42, fulfilled_quantity: 42 }]
      ),
      orders,
      ["order_S11417"]
    );

    const doc = buildOrderDoc(orders[0]);
    expect(doc.fulfillment_status).toBe("delivered");
    expect(doc.is_open).toBe(false);
    expect(doc.is_closed).toBe(true);
  });

  it("overwrites stale fulfillments with an empty list", async () => {
    // Authoritative, not a fallback: an order whose fulfillment was cancelled
    // must lose the one query.graph still reports, or it stays closed forever.
    const orders = [order({ fulfillments: [{ delivered_at: DELIVERED }] })];

    await enrichOrderFulfillmentsAndItems(fakeDb([], []), orders, [
      "order_S11417",
    ]);

    expect(orders[0].fulfillments).toEqual([]);
    expect(buildOrderDoc(orders[0]).fulfillment_status).toBe("not_fulfilled");
  });

  it("keeps graph items when SQL returns none, rather than dropping the guard", async () => {
    const orders = [
      order({
        fulfillments: [],
        items: [{ quantity: 42, detail: { fulfilled_quantity: 10 } }],
      }),
    ];

    await enrichOrderFulfillmentsAndItems(
      fakeDb([{ order_id: "order_S11417", delivered_at: DELIVERED }], []),
      orders,
      ["order_S11417"]
    );

    expect(buildOrderDoc(orders[0]).fulfillment_status).toBe(
      "partially_delivered"
    );
  });

  it("scopes its SQL to the ids it was given", async () => {
    const db = fakeDb([], []);
    await enrichOrderFulfillmentsAndItems(db, [order()], ["order_S11417"]);

    for (const call of (db.query as jest.Mock).mock.calls) {
      expect(call[0]).toContain("ANY($1::text[])");
      expect(call[1]).toEqual([["order_S11417"]]);
    }
  });

  it("runs unscoped only when no ids are given (full reindex)", async () => {
    const db = fakeDb([], []);
    await enrichOrderFulfillmentsAndItems(db, [order()]);

    for (const call of (db.query as jest.Mock).mock.calls) {
      expect(call[0]).not.toContain("ANY($1::text[])");
      expect(call[1]).toEqual([]);
    }
  });
});

/**
 * The static half of the gate. The runtime tests above prove the enrichment is
 * correct; they cannot prove the subscriber CALLS it — and "the subscriber asked
 * for less than the runner" is precisely how this shipped. A writer that skips
 * the enrichment silently mislabels tab membership, with nothing in red.
 */
describe("every writer of the orders index enriches before building", () => {
  const WRITERS = [
    "src/subscribers/order-meilisearch-sync.ts",
    "src/lib/meilisearch/sync-orders-runner.ts",
  ];

  it.each(WRITERS)("%s calls enrichOrderFulfillmentsAndItems", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    expect(src).toContain("enrichOrderFulfillmentsAndItems(");
  });

  it.each(WRITERS)("%s asks query.graph for the line quantities too", (rel) => {
    // The SQL enrichment is wrapped in a try/catch that degrades to whatever
    // query.graph returned. If these fields are absent from the field list, that
    // degraded path reintroduces the exact bug.
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    expect(src).toContain('"items.quantity"');
    expect(src).toContain('"items.detail.fulfilled_quantity"');
  });
});
