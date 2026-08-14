import { buildOrderDoc, type OrderForMeili } from "../../lib/meilisearch/build-order-doc";

/**
 * `separation_state` decides the Separated tab's membership server-side
 * (SEPARATED_TAB_FILTER) and the POS badge mirrors it client-side.
 *
 * Owner decision 2026-08-14: an OPEN order billed in full reads "full" — its
 * remaining units are spoken for on invoices, so the row wears the Separated
 * badge until delivery/close. This supersedes the 2026-08-11 behavior where
 * fully billed dropped to "none". A CLOSED order is always "none", and
 * `is_separated` stays the strict mirror of metadata.is_separated (never
 * widened — the S11417 lesson).
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

describe("buildOrderDoc separation_state", () => {
  it("open + fully_invoiced → full (enters the Separated tab)", () => {
    const doc = buildOrderDoc(order({ metadata: { fully_invoiced: true } }));
    expect(doc.separation_state).toBe("full");
  });

  it("open + fully_invoiced does NOT widen is_separated", () => {
    const doc = buildOrderDoc(order({ metadata: { fully_invoiced: true } }));
    expect(doc.is_separated).toBe(false);
  });

  it("closed + fully_invoiced → none (closed always wins)", () => {
    const doc = buildOrderDoc(
      order({ status: "completed", metadata: { fully_invoiced: true } })
    );
    expect(doc.separation_state).toBe("none");
  });

  it("open + partial physical separation stays partial", () => {
    const doc = buildOrderDoc(
      order({ metadata: { separation_status: "partial" } })
    );
    expect(doc.separation_state).toBe("partial");
  });

  it("fully_invoiced wins over a stale partial separation_status", () => {
    const doc = buildOrderDoc(
      order({ metadata: { fully_invoiced: true, separation_status: "partial" } })
    );
    expect(doc.separation_state).toBe("full");
  });

  it("open, nothing separated, not billed → none", () => {
    expect(buildOrderDoc(order()).separation_state).toBe("none");
  });

  it("legacy boolean is_separated=true still reads full", () => {
    const doc = buildOrderDoc(order({ metadata: { is_separated: true } }));
    expect(doc.separation_state).toBe("full");
    expect(doc.is_separated).toBe(true);
  });
});
