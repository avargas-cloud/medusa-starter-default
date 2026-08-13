/**
 * The FIFO that decides which delivery still holds the units in the air.
 *
 * WHY THIS FILE EXISTS AT ALL
 * `resolveInboundBySku` is verified end to end against the sandbox — except for
 * one branch, which the sandbox cannot produce: a PO carrying SEVERAL deliveries
 * AND having received part of its goods. The sandbox has PO-1119 (two
 * deliveries, nothing received) and PO-1110 (294 of 344 received, one delivery).
 * Neither exercises the tie-break, and the tie-break is the whole reason the
 * function exists. So it is proven here, on synthetic input, or nowhere.
 *
 * THE RULE THESE TESTS EXIST TO PIN DOWN (owner decision, 2026-08-13)
 * The item receipt is the only authority on HOW MANY units arrived. The
 * carrier's `delivered` flag only breaks the tie about WHICH delivery a receipt
 * is charged to, and can never consume a unit the receipt did not record —
 * receiving lags the truck whenever the crew is busy, and that lag must not
 * erase a shipment from the screen.
 *
 * This file previously asserted the opposite ("carrier state is not a guess",
 * consuming the whole claim on `delivered`). That is why the bug shipped and why
 * the reversed assertion is spelled out below rather than deleted: the next
 * reader has to see that the two readings were weighed.
 */

import { inTransitPerDelivery } from "../../lib/purchase-orders/inbound-by-sku";
import type { PoShipmentView } from "../../lib/purchase-orders/po-tracking-read";

const LINE = "poline_1";

function shipment(
  id: string,
  opts: {
    scope?: "all_order" | "by_line";
    qty?: number;
    carrierStatus?: string;
  } = {}
): PoShipmentView {
  const scope = opts.scope ?? "by_line";
  return {
    id,
    purchase_order_id: "po_1",
    scope,
    created_at: `2026-07-0${id.slice(-1)}T00:00:00.000Z`,
    created_by_user_id: null,
    numbers: [],
    lines:
      scope === "by_line"
        ? [
            {
              purchase_order_line_id: LINE,
              sku_snapshot: "SKU-1",
              description_snapshot: "",
              qty: opts.qty ?? 0,
            },
          ]
        : [],
    carrier_eta: null,
    master: {
      id: `${id}_n`,
      provider: "fedex",
      tracking_number: `TRK-${id}`,
      tracking_url: "",
      is_master: true,
      carrier_eta: null,
      carrier_status: opts.carrierStatus ?? "pending",
      carrier_eta_fetched_at: null,
      carrier_detail: null,
    },
  };
}

describe("inTransitPerDelivery", () => {
  it("leaves every allocation flying when nothing has been received", () => {
    const out = inTransitPerDelivery(
      [shipment("s1", { qty: 20 }), shipment("s2", { qty: 30 })],
      LINE,
      50,
      0
    );

    expect(out.get("s1")).toBe(20);
    expect(out.get("s2")).toBe(30);
  });

  // The branch with no fixture in the sandbox.
  it("consumes received units off the OLDEST delivery first", () => {
    const out = inTransitPerDelivery(
      [shipment("s1", { qty: 20 }), shipment("s2", { qty: 30 })],
      LINE,
      50,
      20
    );

    expect(out.has("s1")).toBe(false); // fully landed
    expect(out.get("s2")).toBe(30); // untouched
  });

  it("spills into the next delivery when the first cannot absorb the receipt", () => {
    const out = inTransitPerDelivery(
      [shipment("s1", { qty: 20 }), shipment("s2", { qty: 30 })],
      LINE,
      50,
      35
    );

    expect(out.has("s1")).toBe(false);
    expect(out.get("s2")).toBe(15); // 30 - the 15 that spilled over
  });

  // THE REGRESSION. This is the exact shape of PO-1129 / ESP-SFA50W0860 in
  // production on 2026-08-13: an `all_order` waybill UPS had marked delivered,
  // 15 units ordered, nothing received yet. Before the fix the delivery was
  // consumed whole and its 15 units fell into the untracked bucket, so the stock
  // modal said "No tracking yet" about waybill 1ZA3Y7090430036127.
  it("keeps a carrier-delivered shipment flying while its receipt is unposted", () => {
    const out = inTransitPerDelivery(
      [
        shipment("s1", { qty: 20 }),
        shipment("s2", { qty: 30, carrierStatus: "delivered" }),
      ],
      LINE,
      50,
      0
    );

    // The receipt recorded nothing, so nothing is consumed — not even the box
    // the carrier swears it dropped off. The screen keeps both tracking numbers.
    expect(out.get("s1")).toBe(20);
    expect(out.get("s2")).toBe(30);
  });

  // The tie-break the `delivered` flag still legitimately decides: WHICH of two
  // deliveries a receipt is charged to. Plain FIFO would have consumed s1, the
  // older one; the carrier's word is better evidence than shipping order about
  // which box is the one that actually landed.
  it("charges a receipt to the delivered shipment before the older one", () => {
    const out = inTransitPerDelivery(
      [
        shipment("s1", { qty: 20 }),
        shipment("s2", { qty: 30, carrierStatus: "delivered" }),
      ],
      LINE,
      50,
      30
    );

    expect(out.get("s1")).toBe(20); // older, still flying
    expect(out.has("s2")).toBe(false); // the 30 received were its own
  });

  // Priority is not licence: once the receipt is exhausted, a delivered shipment
  // keeps whatever it was not paid for. This is the assertion that fails if
  // someone reintroduces the unbounded `delivered ? claimed : …` branch.
  it("never lets a delivered shipment consume more than the receipt recorded", () => {
    const out = inTransitPerDelivery(
      [shipment("s1", { qty: 30, carrierStatus: "delivered" })],
      LINE,
      30,
      10
    );

    expect(out.get("s1")).toBe(20); // 30 claimed - 10 actually received
  });

  it("gives an all_order delivery the whole shippable line, cancellations off", () => {
    const out = inTransitPerDelivery(
      [shipment("s1", { scope: "all_order" })],
      LINE,
      40, // 50 ordered - 10 cancelled
      0
    );

    expect(out.get("s1")).toBe(40);
  });

  it("never emits more than the line can still ship", () => {
    const out = inTransitPerDelivery(
      [shipment("s1", { qty: 20 }), shipment("s2", { qty: 30 })],
      LINE,
      50,
      50 // everything already arrived
    );

    expect(out.size).toBe(0);
  });

  it("ignores allocations belonging to another line of the same PO", () => {
    const other = shipment("s1", { qty: 20 });
    other.lines = [
      {
        purchase_order_line_id: "poline_OTHER",
        sku_snapshot: "SKU-9",
        description_snapshot: "",
        qty: 20,
      },
    ];

    expect(inTransitPerDelivery([other], LINE, 50, 0).size).toBe(0);
  });
});
