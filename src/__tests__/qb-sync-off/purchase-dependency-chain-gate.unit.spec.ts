/**
 * enqueuePurchaseQbOperation (src/lib/purchase-orders/qb-purchase-dependency-chain.ts)
 * — the shared chokepoint for PO/item-receipt/vendor-bill/vendor-credit/
 * bill-payment QB ops — must return `null` (never a fabricated id) when
 * QB_SYNC_ENABLED=false, without touching the db at all.
 *
 * Unlike the sales-lane helpers, this one can't fabricate an id: the child
 * tables (qb_item_receipt_pipeline, qb_purchase_order_pipeline,
 * qb_vendor_bill_pipeline, qb_purchase_dependency_chain) carry real FK
 * constraints to qb_order_pipeline(id).
 */
import { enqueuePurchaseQbOperation } from "../../lib/purchase-orders/qb-purchase-dependency-chain";

describe("enqueuePurchaseQbOperation — QB_SYNC_ENABLED=false", () => {
  const ORIGINAL = process.env.QB_SYNC_ENABLED;

  beforeEach(() => {
    process.env.QB_SYNC_ENABLED = "false";
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.QB_SYNC_ENABLED;
    else process.env.QB_SYNC_ENABLED = ORIGINAL;
  });

  it("returns null without calling db.raw or db.transaction", async () => {
    const db = {
      raw: jest.fn(async () => {
        throw new Error("db.raw called — gate did not fire");
      }),
      transaction: jest.fn(async () => {
        throw new Error("db.transaction called — gate did not fire");
      }),
    };

    const result = await enqueuePurchaseQbOperation(db as any, {
      purchaseOrderId: "po_1",
      referenceId: "po_1",
      referenceType: "purchase_order",
      step: "purchase_order_mod",
      payload: {},
      operationKey: "purchase_order_mod:po_1:deadbeef",
    });

    expect(result).toBeNull();
    expect(db.raw).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
